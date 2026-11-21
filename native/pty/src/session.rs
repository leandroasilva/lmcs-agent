use std::io;
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::Spawner;
use crate::exit_drain::{DrainAction, ExitDrain};
use crate::native_pty::{NativePtyProcess, NativePtySpawner, wait_child};
use crate::node_pty::{PtyExitEvent, spawn_error};
use crate::reader::ReaderWorker;
use crate::readiness::WritableWorker;
use crate::spawn::{PtySpawnError, PtySpawnInput, SpawnCause};

const QUEUED_EVENTS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum SessionEvent {
    Data(String),
    Exit(PtyExitEvent),
    /// A one-shot retry hint, not a guarantee that the next write cannot return WouldBlock.
    Writable,
}

enum Input {
    Data(String),
    ReaderClosed,
    ChildReady(io::Result<()>),
    Writable(io::Result<()>),
}

/// Owns the child and its workers; dropping the session terminates and reaps the child.
pub struct PtySession {
    pid: u32,
    process: Option<NativePtyProcess>,
    reader: Option<ReaderWorker>,
    writable: Option<WritableWorker>,
    observer: Option<JoinHandle<()>>,
    receiver: Option<Receiver<Input>>,
    drain: ExitDrain,
}

impl PtySession {
    pub fn spawn(spawner: NativePtySpawner, input: &PtySpawnInput) -> Result<Self, PtySpawnError> {
        let process = spawner.spawn(input)?;
        Self::start(process)
            .map_err(|error| spawn_error(input.shell, SpawnCause::error(error.to_string())))
    }

    fn start(process: NativePtyProcess) -> io::Result<Self> {
        let pid = process.pid();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        let mut session = Self {
            pid,
            process: Some(process),
            reader: None,
            writable: None,
            observer: None,
            receiver: Some(receiver),
            drain: ExitDrain::new(),
        };
        let data = sender.clone();
        let closed = sender.clone();
        session.reader = Some(session.process_mut()?.start_output(|pid, fd| {
            ReaderWorker::spawn(
                pid,
                fd,
                move |text| data.send(Input::Data(text)).is_ok(),
                move || {
                    let _ = closed.send(Input::ReaderClosed);
                },
            )
        })?);
        let writable = sender.clone();
        session.writable = Some(WritableWorker::spawn(
            pid,
            session.process_mut()?.input_descriptor()?,
            move |result| writable.send(Input::Writable(result)).is_ok(),
        )?);
        session.observer = Some(
            thread::Builder::new()
                .name(format!("pty-exit-{pid}"))
                .spawn(move || {
                    let result = wait_until_waitable(pid);
                    let _ = sender.send(Input::ChildReady(result));
                })?,
        );
        Ok(session)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Returns bytes accepted or WouldBlock; the caller retains the rest while draining output.
    pub fn try_write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.process_mut()?.try_write(data)
    }

    /// After a partial write or WouldBlock, request one Writable event; repeated requests coalesce.
    pub fn request_writable(&mut self) -> io::Result<()> {
        self.writable
            .as_mut()
            .ok_or(io::ErrorKind::NotConnected)?
            .arm()
    }

    pub fn resize(&mut self, cols: u32, rows: u32) -> io::Result<()> {
        self.process_mut()?.resize(cols, rows)
    }

    pub fn kill(&mut self, signal: Option<&str>) -> io::Result<()> {
        if self.observer.is_some() {
            self.process_mut()?.signal_unreaped(signal)
        } else {
            self.process_mut()?.kill(signal)
        }
    }

    pub fn recv(&mut self) -> io::Result<Option<SessionEvent>> {
        self.receive(None)
    }

    pub fn recv_timeout(&mut self, timeout: Duration) -> io::Result<Option<SessionEvent>> {
        self.receive(Some(Instant::now() + timeout))
    }

    /// Discards unread events, terminates the child, closes the PTY and joins its workers.
    pub fn cancel(mut self) -> io::Result<()> {
        self.stop()
    }

    fn process_mut(&mut self) -> io::Result<&mut NativePtyProcess> {
        self.process
            .as_mut()
            .ok_or_else(|| io::ErrorKind::NotConnected.into())
    }

    fn receive(&mut self, deadline: Option<Instant>) -> io::Result<Option<SessionEvent>> {
        let result = self.receive_inner(deadline);
        if result
            .as_ref()
            .is_err_and(|error| error.kind() != io::ErrorKind::TimedOut)
        {
            let _ = self.stop();
        }
        result
    }

    fn receive_inner(&mut self, deadline: Option<Instant>) -> io::Result<Option<SessionEvent>> {
        loop {
            if self.receiver.is_none() {
                return Ok(None);
            }
            if let Some(DrainAction::CloseReader) = self.drain.expire(Instant::now()) {
                // Stop new reads, but deliver accepted data through ReaderClosed before publishing exit.
                if let Some(reader) = &mut self.reader {
                    reader.request_stop();
                }
            }
            let wake_at = match (deadline, self.drain.deadline()) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let receiver = self.receiver.as_ref().unwrap();
            let event = match wake_at {
                Some(at) => {
                    match receiver.recv_timeout(at.saturating_duration_since(Instant::now())) {
                        Ok(event) => event,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if self.drain.deadline().is_some_and(|at| Instant::now() >= at) {
                                continue;
                            }
                            return Err(io::ErrorKind::TimedOut.into());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return Err(io::ErrorKind::UnexpectedEof.into());
                        }
                    }
                }
                None => receiver
                    .recv()
                    .map_err(|_| io::Error::from(io::ErrorKind::UnexpectedEof))?,
            };
            let action = match event {
                Input::Data(data) => return Ok(Some(SessionEvent::Data(data))),
                Input::Writable(result) => {
                    self.writable.as_mut().unwrap().delivered();
                    result?;
                    return Ok(Some(SessionEvent::Writable));
                }
                Input::ReaderClosed => {
                    if let Some(mut reader) = self.reader.take() {
                        reader.join()?;
                    }
                    self.drain.reader_closed()
                }
                Input::ChildReady(result) => {
                    self.join_observer()?;
                    result?;
                    let exit = self.process_mut()?.wait()?;
                    self.drain.child_exited(exit, Instant::now())
                }
            };
            if let Some(DrainAction::PublishExit(exit)) = action {
                return self.finish(exit);
            }
        }
    }

    fn finish(&mut self, exit: PtyExitEvent) -> io::Result<Option<SessionEvent>> {
        self.stop()?;
        Ok(Some(SessionEvent::Exit(exit)))
    }

    fn join_observer(&mut self) -> io::Result<()> {
        match self.observer.take() {
            Some(observer) => observer
                .join()
                .map_err(|_| io::Error::other("PTY exit observer panicked")),
            None => Ok(()),
        }
    }

    fn stop(&mut self) -> io::Result<()> {
        self.receiver.take();
        let signaled = if self.process.is_some() {
            self.kill(Some("SIGKILL"))
        } else {
            Ok(())
        };
        let reader = self
            .reader
            .take()
            .map(|mut reader| reader.stop())
            .transpose();
        let writable = self
            .writable
            .take()
            .map(|mut writable| writable.stop())
            .transpose();
        // macOS can hold wait4 while unread PTY output remains; close before waiting or joining.
        let child = self
            .process
            .take()
            .map(NativePtyProcess::close_io)
            .transpose();
        let observer = self.join_observer();
        // Keep the PID reserved until even a delayed observer has finished using it.
        let reaped =
            child.and_then(|child| child.map(|mut child| wait_child(&mut *child)).transpose());
        signaled?;
        reader?;
        writable?;
        observer?;
        reaped.map(|_| ())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn wait_until_waitable(pid: u32) -> io::Result<()> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
    loop {
        // Only the session may reap or signal; retaining the zombie prevents PID reuse.
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        } == 0
        {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_pty::exit_event;
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn empty_session(receiver: Receiver<Input>) -> PtySession {
        PtySession {
            pid: 7,
            process: None,
            reader: None,
            writable: None,
            observer: None,
            receiver: Some(receiver),
            drain: ExitDrain::new(),
        }
    }

    #[test]
    fn deadline_cancels_an_open_descriptor_without_flushing_decoder_carry() {
        let (source, mut writer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        let closed = sender.clone();
        let mut session = empty_session(receiver);
        session.reader = Some(
            ReaderWorker::spawn(
                7,
                source.into(),
                move |data| sender.send(Input::Data(data)).is_ok(),
                move || {
                    let _ = closed.send(Input::ReaderClosed);
                },
            )
            .unwrap(),
        );
        writer.write_all(b"prefix\xc3").unwrap();
        assert_eq!(
            session.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some(SessionEvent::Data("prefix".to_string()))
        );
        let start = Instant::now();
        let exit = exit_event(7, Some(0));
        session.drain.child_exited(exit, start);
        assert_eq!(
            session.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some(SessionEvent::Exit(exit))
        );
        assert!(start.elapsed() >= Duration::from_millis(200));
        assert!(session.reader.is_none());
        assert_eq!(session.recv().unwrap(), None);
        drop(writer);
    }

    #[test]
    fn an_expired_deadline_preserves_accepted_output_before_exit() {
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        for index in 0..QUEUED_EVENTS - 1 {
            sender.send(Input::Data(index.to_string())).unwrap();
        }
        sender.send(Input::ReaderClosed).unwrap();
        let mut session = empty_session(receiver);
        let exit = exit_event(0, Some(9));
        session
            .drain
            .child_exited(exit, Instant::now() - Duration::from_millis(200));
        for index in 0..QUEUED_EVENTS - 1 {
            assert_eq!(
                session.recv().unwrap(),
                Some(SessionEvent::Data(index.to_string()))
            );
        }
        assert_eq!(session.recv().unwrap(), Some(SessionEvent::Exit(exit)));
        assert_eq!(session.recv().unwrap(), None);
        assert!(sender.send(Input::Data("after".to_string())).is_err());
    }

    #[test]
    fn deadline_drains_a_full_queue_and_joins_its_blocked_reader() {
        let (source, mut writer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        writer
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        let closed = sender.clone();
        let (entered, receipt) = mpsc::channel();
        let mut session = empty_session(receiver);
        session.reader = Some(
            ReaderWorker::spawn(
                7,
                source.into(),
                move |data| {
                    entered.send(()).unwrap();
                    sender.send(Input::Data(data)).is_ok()
                },
                move || {
                    let _ = closed.send(Input::ReaderClosed);
                },
            )
            .unwrap(),
        );
        for _ in 0..=QUEUED_EVENTS {
            writer.write_all(b"x").unwrap();
            receipt.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let exit = exit_event(7, Some(0));
        session
            .drain
            .child_exited(exit, Instant::now() - Duration::from_millis(200));
        for _ in 0..=QUEUED_EVENTS {
            assert_eq!(
                session.recv_timeout(Duration::from_secs(5)).unwrap(),
                Some(SessionEvent::Data("x".to_string()))
            );
        }
        assert_eq!(
            session.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some(SessionEvent::Exit(exit))
        );
        assert!(session.reader.is_none());
        assert_eq!(session.recv().unwrap(), None);
    }

    #[test]
    fn signaling_preserves_the_pid_for_an_observer_that_has_not_started_waiting() {
        let args = vec!["-c".to_string(), "exit 7".to_string()];
        let process = NativePtySpawner::new(crate::Platform::from_node_str(std::env::consts::OS))
            .spawn(&PtySpawnInput {
                shell: "/bin/sh",
                args: Some(&args),
                cwd: "/",
                cols: 80,
                rows: 24,
                env: &crate::Env::new(),
            })
            .unwrap();
        let pid = process.pid();
        wait_until_waitable(pid).unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        let mut session = empty_session(receiver);
        session.pid = pid;
        session.process = Some(process);
        let (release, gate) = mpsc::channel();
        session.observer = Some(thread::spawn(move || {
            gate.recv_timeout(Duration::from_secs(5)).unwrap();
            let result = wait_until_waitable(pid);
            assert!(result.is_ok(), "observer lost its reserved PID: {result:?}");
            let _ = sender.send(Input::ChildReady(result));
        }));
        let signaled = session.kill(Some("SIGKILL"));
        let reserved = wait_until_waitable(pid);
        release.send(()).unwrap();
        signaled.unwrap();
        reserved.expect("signaling must not reap before the observer finishes");
        session.join_observer().unwrap();
        assert_eq!(
            session.process_mut().unwrap().wait().unwrap(),
            exit_event(7, Some(0))
        );
        session.cancel().unwrap();
    }

    #[test]
    fn observer_errors_follow_prior_output_and_join_before_returning() {
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        sender.send(Input::Data("before".to_string())).unwrap();
        let mut session = empty_session(receiver);
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        session.observer = Some(thread::spawn(move || {
            sender
                .send(Input::ChildReady(Err(
                    io::ErrorKind::PermissionDenied.into()
                )))
                .unwrap();
            done.store(true, Ordering::SeqCst);
        }));
        assert_eq!(
            session.recv().unwrap(),
            Some(SessionEvent::Data("before".to_string()))
        );
        assert_eq!(
            session.recv().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(finished.load(Ordering::SeqCst));
        assert!(session.observer.is_none());
        assert_eq!(session.recv().unwrap(), None);
    }

    #[test]
    fn writable_observer_errors_follow_prior_output_and_join_before_returning() {
        let (source, _peer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        sender.send(Input::Data("before".to_string())).unwrap();
        let mut session = empty_session(receiver);
        session.writable = Some(
            WritableWorker::spawn(7, source.into(), move |_| {
                sender
                    .send(Input::Writable(Err(io::ErrorKind::PermissionDenied.into())))
                    .is_ok()
            })
            .unwrap(),
        );
        session.request_writable().unwrap();
        assert_eq!(
            session.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some(SessionEvent::Data("before".to_string()))
        );
        assert_eq!(
            session
                .recv_timeout(Duration::from_secs(5))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(session.writable.is_none());
        assert_eq!(session.recv().unwrap(), None);
    }

    #[test]
    fn cancellation_disconnects_a_full_shared_queue_before_joining_writable_observation() {
        let (source, _peer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        for _ in 0..QUEUED_EVENTS {
            sender.send(Input::Data("queued".to_string())).unwrap();
        }
        let (entered, receipt) = mpsc::channel();
        let mut session = empty_session(receiver);
        session.writable = Some(
            WritableWorker::spawn(7, source.into(), move |result| {
                entered.send(()).unwrap();
                assert!(sender.send(Input::Writable(result)).is_err());
                false
            })
            .unwrap(),
        );
        session.request_writable().unwrap();
        receipt.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done, completion) = mpsc::channel();
        let stopper = thread::spawn(move || {
            done.send(session.cancel()).unwrap();
        });
        completion
            .recv_timeout(Duration::from_secs(5))
            .expect("full queue stalled writable cancellation")
            .unwrap();
        stopper.join().unwrap();
    }

    #[test]
    fn a_disconnected_event_source_is_an_error_not_an_exit() {
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        let mut session = empty_session(receiver);
        drop(sender);
        assert_eq!(
            session.recv().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(session.recv().unwrap(), None);
    }

    #[test]
    fn cancellation_disconnects_a_full_shared_queue_before_joining_the_observer() {
        let (sender, receiver) = mpsc::sync_channel(QUEUED_EVENTS);
        for _ in 0..QUEUED_EVENTS {
            sender.send(Input::Data("queued".to_string())).unwrap();
        }
        let mut session = empty_session(receiver);
        let (entered, receipt) = mpsc::channel();
        session.observer = Some(thread::spawn(move || {
            entered.send(()).unwrap();
            assert!(sender.send(Input::ChildReady(Ok(()))).is_err());
        }));
        receipt.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done, completion) = mpsc::channel();
        let stopper = thread::spawn(move || {
            done.send(session.cancel()).unwrap();
        });
        completion
            .recv_timeout(Duration::from_secs(5))
            .expect("full queue stalled cancellation")
            .unwrap();
        stopper.join().unwrap();
    }
}
