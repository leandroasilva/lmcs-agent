use std::io;
use std::os::fd::RawFd;
#[cfg(target_os = "macos")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct WritableWorker {
    requests: Option<std::sync::mpsc::Sender<()>>,
    wake: Option<std::os::unix::net::UnixStream>,
    worker: Option<std::thread::JoinHandle<()>>,
    armed: bool,
}

/// macOS `UnixStream::pair` has no `SOCK_CLOEXEC`, so a descriptor the manager keeps for itself would
/// survive the PTY spawn and stay open in the user's shell — and hold the other end of the pair away
/// from EOF for as long as that child lives.
pub(crate) fn set_cloexec(fd: RawFd) -> io::Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A socketpair whose ends a spawned child cannot inherit.
pub(crate) fn cloexec_pair() -> io::Result<(std::os::unix::net::UnixStream, std::os::unix::net::UnixStream)>
{
    use std::os::fd::AsRawFd;
    let (left, right) = std::os::unix::net::UnixStream::pair()?;
    set_cloexec(left.as_raw_fd())?;
    set_cloexec(right.as_raw_fd())?;
    Ok((left, right))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl WritableWorker {
    pub(super) fn spawn(
        pid: u32,
        fd: std::os::fd::OwnedFd,
        mut emit: impl FnMut(io::Result<()>) -> bool + Send + 'static,
    ) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        let (wake, cancellation) = cloexec_pair()?;
        let mut readiness = Readiness::new(fd.as_raw_fd(), Some(cancellation.as_raw_fd()), true)?;
        let (requests, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::Builder::new()
            .name(format!("pty-writable-{pid}"))
            .spawn(move || {
                while receiver.recv().is_ok() {
                    match readiness.wait() {
                        Ok(false) => break,
                        Ok(true) => {
                            if !emit(Ok(())) {
                                break;
                            }
                        }
                        Err(error) => {
                            emit(Err(error));
                            break;
                        }
                    }
                }
                drop(cancellation);
                drop(fd);
            })?;
        Ok(Self {
            requests: Some(requests),
            wake: Some(wake),
            worker: Some(worker),
            armed: false,
        })
    }

    pub(super) fn arm(&mut self) -> io::Result<()> {
        // At most one request exists until the owner consumes its notification.
        if !self.armed {
            self.requests
                .as_ref()
                .ok_or(io::ErrorKind::NotConnected)?
                .send(())
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            self.armed = true;
        }
        Ok(())
    }

    pub(super) fn delivered(&mut self) {
        self.armed = false;
    }

    pub(super) fn stop(&mut self) -> io::Result<()> {
        self.wake.take();
        self.requests.take();
        match self.worker.take() {
            Some(worker) => worker
                .join()
                .map_err(|_| io::Error::other("PTY writable observer panicked")),
            None => Ok(()),
        }
    }
}

pub(super) fn status_flags(fd: RawFd) -> io::Result<i32> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(flags)
    }
}

pub(super) fn set_status_flags(fd: RawFd, flags: i32) -> io::Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(super) struct Readiness {
    queue: OwnedFd,
    cancel: Option<RawFd>,
}

#[cfg(target_os = "macos")]
impl Readiness {
    pub(super) fn new(output: RawFd, cancel: Option<RawFd>, writing: bool) -> io::Result<Self> {
        // macOS poll does not reliably support PTYs; kqueue avoids select's FD_SETSIZE limit.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let queue = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut changes = Vec::with_capacity(2);
        changes.push(libc::kevent {
            ident: output as libc::uintptr_t,
            filter: if writing {
                libc::EVFILT_WRITE
            } else {
                libc::EVFILT_READ
            },
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        });
        if let Some(cancel) = cancel {
            changes.push(libc::kevent {
                ident: cancel as libc::uintptr_t,
                filter: libc::EVFILT_READ,
                flags: libc::EV_ADD | libc::EV_ENABLE,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            });
        }
        if unsafe {
            libc::kevent(
                fd,
                changes.as_ptr(),
                changes.len() as i32,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { queue, cancel })
    }

    pub(super) fn wait(&mut self) -> io::Result<bool> {
        loop {
            let mut events: [libc::kevent; 2] = unsafe { std::mem::zeroed() };
            let count = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    2,
                    std::ptr::null(),
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            let events = &events[..count as usize];
            if self.cancel.is_some_and(|cancel| {
                events
                    .iter()
                    .any(|event| event.ident == cancel as libc::uintptr_t)
            }) {
                return Ok(false);
            }
            if let Some(event) = events
                .iter()
                .find(|event| event.flags & libc::EV_ERROR != 0)
            {
                return Err(io::Error::from_raw_os_error(event.data as i32));
            }
            if !events.is_empty() {
                return Ok(true);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) struct Readiness {
    fds: [libc::pollfd; 2],
}

#[cfg(not(target_os = "macos"))]
impl Readiness {
    pub(super) fn new(output: RawFd, cancel: Option<RawFd>, writing: bool) -> io::Result<Self> {
        Ok(Self {
            fds: [
                libc::pollfd {
                    fd: output,
                    events: if writing { libc::POLLOUT } else { libc::POLLIN },
                    revents: 0,
                },
                libc::pollfd {
                    fd: cancel.unwrap_or(-1),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ],
        })
    }

    pub(super) fn wait(&mut self) -> io::Result<bool> {
        loop {
            let count = unsafe { libc::poll(self.fds.as_mut_ptr(), 2, -1) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if self.fds[1].revents != 0 {
                return Ok(false);
            }
            if self.fds[0].revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from_raw_os_error(libc::EBADF));
            }
            if self.fds[0].revents != 0 {
                return Ok(true);
            }
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    // Deadlock guards only; receipts and joins establish all ordering.
    const GUARD: Duration = Duration::from_secs(5);

    fn nonblocking_pair() -> (UnixStream, UnixStream) {
        let (source, peer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        peer.set_nonblocking(true).unwrap();
        (source, peer)
    }

    fn stop(mut worker: WritableWorker) {
        let (done, completion) = mpsc::channel();
        let stopper = thread::spawn(move || {
            let result = worker.stop();
            let _ = done.send((worker, result));
        });
        let (mut worker, result) = completion
            .recv_timeout(GUARD)
            .expect("writable worker stop stalled");
        stopper.join().unwrap();
        result.unwrap();
        assert!(worker.worker.is_none());
        assert!(worker.requests.is_none());
        assert!(worker.wake.is_none());
        worker.stop().expect("stop must be idempotent");
    }

    fn fill(source: &mut UnixStream) -> usize {
        let bytes = [0; 8192];
        let mut written = 0;
        loop {
            match source.write(&bytes) {
                Ok(0) => panic!("socket write made no progress"),
                Ok(count) => written += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return written,
                Err(error) => panic!("socket fill failed: {error}"),
            }
            assert!(written < 16 * 1024 * 1024, "socket never became full");
        }
    }

    #[test]
    fn writable_notifications_are_one_shot_coalesced_and_rearmed_without_readable_data() {
        let (mut source, mut peer) = nonblocking_pair();
        assert_eq!(
            source.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let (sender, receipts) = mpsc::channel();
        let mut worker = WritableWorker::spawn(7, source.into(), move |result| {
            sender.send((thread::current().id(), result)).is_ok()
        })
        .unwrap();
        assert!(!worker.armed);
        for _ in 0..8 {
            worker.arm().unwrap();
        }
        let (callback_thread, result) = receipts.recv_timeout(GUARD).unwrap();
        result.unwrap();
        assert_ne!(callback_thread, thread::current().id());
        assert!(worker.armed);

        // Consuming the receipt alone must not rearm the worker.
        for _ in 0..8 {
            worker.arm().unwrap();
        }
        worker.delivered();
        assert!(!worker.armed);
        for _ in 0..8 {
            worker.arm().unwrap();
        }
        let (rearmed_thread, result) = receipts.recv_timeout(GUARD).unwrap();
        result.unwrap();
        assert_eq!(rearmed_thread, callback_thread);
        assert!(worker.armed);

        // Draining requests to disconnection proves there is no third notification without a timeout.
        drop(worker.requests.take());
        let end = receipts.recv_timeout(GUARD);
        drop(receipts);
        stop(worker);
        assert!(matches!(end, Err(mpsc::RecvTimeoutError::Disconnected)));
        assert_eq!(peer.read(&mut [0]).unwrap(), 0, "worker retained its fd");
    }

    #[test]
    fn stop_wakes_an_idle_request_wait_and_closes_the_owned_descriptor() {
        let (source, mut peer) = nonblocking_pair();
        let (sender, receiver) = mpsc::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let emitted = Arc::clone(&calls);
        let worker = WritableWorker::spawn(7, source.into(), move |result| {
            emitted.fetch_add(1, Ordering::Relaxed);
            sender.send(result).is_ok()
        })
        .unwrap();

        drop(receiver);
        stop(worker);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        assert_eq!(peer.read(&mut [0]).unwrap(), 0, "worker retained its fd");
    }

    #[test]
    fn stop_wakes_a_full_descriptor_without_the_peer_draining_or_closing() {
        let (mut source, mut peer) = nonblocking_pair();
        let written = fill(&mut source);
        assert!(written > 0);
        assert_eq!(
            source.write(&[0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let (sender, receiver) = mpsc::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let emitted = Arc::clone(&calls);
        let mut worker = WritableWorker::spawn(7, source.into(), move |result| {
            emitted.fetch_add(1, Ordering::Relaxed);
            sender.send(result).is_ok()
        })
        .unwrap();
        worker.arm().unwrap();

        drop(receiver);
        stop(worker);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let mut buffered = Vec::new();
        // EOF, rather than WouldBlock, also proves stop released the owned fd.
        assert_eq!(peer.read_to_end(&mut buffered).unwrap(), written);
    }

    #[test]
    fn disconnecting_a_full_callback_queue_before_stop_unblocks_and_joins_the_callback() {
        let (source, mut peer) = nonblocking_pair();
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(Ok(())).unwrap();
        let (entered, entry) = mpsc::channel();
        let (returned, exit) = mpsc::channel();
        let mut worker = WritableWorker::spawn(7, source.into(), move |result| {
            entered.send(thread::current().id()).unwrap();
            let accepted = sender.send(result).is_ok();
            returned.send(accepted).unwrap();
            accepted
        })
        .unwrap();
        worker.arm().unwrap();
        let callback_thread = entry.recv_timeout(GUARD).unwrap();
        assert_ne!(callback_thread, thread::current().id());

        // Only receiver disconnection can release a send to this unconsumed full queue.
        drop(receiver);
        stop(worker);
        assert!(!exit.try_recv().unwrap());
        assert_eq!(exit.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        assert_eq!(peer.read(&mut [0]).unwrap(), 0, "worker retained its fd");
    }
}
