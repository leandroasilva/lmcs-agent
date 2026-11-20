//! Exclusive Unix PTY reads; cancelling the reader does not kill or reap the child.

use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};

use crate::{PendingEvent, Pipe, readiness::Readiness, utf8::Utf8Decoder};

const QUEUED_CHUNKS: usize = 64;
const READ_BYTES: usize = 4096;

pub struct PtyReader {
    pid: u32,
    receiver: Option<Receiver<String>>,
    wake: Option<UnixStream>,
    worker: Option<JoinHandle<io::Result<()>>>,
}

impl PtyReader {
    pub(super) fn spawn(pid: u32, fd: OwnedFd) -> io::Result<Self> {
        let (wake, cancellation) = UnixStream::pair()?;
        let mut readiness = Readiness::new(fd.as_raw_fd(), Some(cancellation.as_raw_fd()), false)?;
        let (sender, receiver) = mpsc::sync_channel(QUEUED_CHUNKS);
        let worker = thread::Builder::new()
            .name(format!("pty-read-{pid}"))
            .spawn(move || {
                let mut file = File::from(fd);
                let result = pump(
                    &mut file,
                    || readiness.wait(),
                    |data| sender.send(data).is_ok(),
                );
                drop(cancellation);
                result
            })?;
        Ok(Self {
            pid,
            receiver: Some(receiver),
            wake: Some(wake),
            worker: Some(worker),
        })
    }

    /// None means the stream ended and its reader was joined, not that the child exited.
    pub fn recv(&mut self) -> io::Result<Option<String>> {
        let Some(receiver) = &self.receiver else {
            return Ok(None);
        };
        match receiver.recv() {
            Ok(data) => Ok(Some(data)),
            Err(_) => {
                self.receiver.take();
                self.join()?;
                self.wake.take();
                Ok(None)
            }
        }
    }

    pub fn recv_timeout(&mut self, timeout: std::time::Duration) -> io::Result<Option<String>> {
        let Some(receiver) = &self.receiver else {
            return Ok(None);
        };
        match receiver.recv_timeout(timeout) {
            Ok(data) => Ok(Some(data)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(io::ErrorKind::TimedOut.into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => self.recv(),
        }
    }

    /// Some(true) grants the caller the Pipe walker; None is stream EOF, not a process exit.
    pub fn enqueue_next(&mut self, pipe: &mut Pipe) -> io::Result<Option<bool>> {
        Ok(self
            .recv()?
            .map(|data| pipe.enqueue(self.pid, PendingEvent::Data(data))))
    }

    /// Discards unread output and joins, even when the child or consumer is idle.
    pub fn cancel(mut self) -> io::Result<()> {
        self.stop()
    }

    fn join(&mut self) -> io::Result<()> {
        match self.worker.take() {
            Some(worker) => worker
                .join()
                .map_err(|_| io::Error::other("PTY reader panicked"))?,
            None => Ok(()),
        }
    }

    fn stop(&mut self) -> io::Result<()> {
        // Disconnect send before waking read: either operation can be where the worker is blocked.
        self.receiver.take();
        self.wake.take();
        self.join()
    }
}

impl Drop for PtyReader {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn pump(
    reader: &mut dyn Read,
    mut ready: impl FnMut() -> io::Result<bool>,
    mut emit: impl FnMut(String) -> bool,
) -> io::Result<()> {
    let mut decoder = Utf8Decoder::new();
    let mut buffer = [0_u8; READ_BYTES];
    while ready()? {
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            // Linux reports slave closure as EIO, just as portable-pty's own reader handles it.
            Err(error) if error.raw_os_error() == Some(libc::EIO) => 0,
            Err(error) => return Err(error),
        };
        let data = if count == 0 {
            decoder.finish()
        } else {
            decoder.write(&buffer[..count])
        };
        if !data.is_empty() && !emit(data) {
            return Ok(());
        }
        if count == 0 {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::Write;
    use std::time::Duration;

    struct ScriptedRead(VecDeque<io::Result<&'static [u8]>>);

    impl Read for ScriptedRead {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let bytes = self.0.pop_front().expect("unexpected extra read")?;
            buffer[..bytes.len()].copy_from_slice(bytes);
            Ok(bytes.len())
        }
    }

    #[test]
    fn decoded_output_keeps_boundaries_suppresses_empty_and_flushes_eof() {
        for eof in [Ok(&b""[..]), Err(io::Error::from_raw_os_error(libc::EIO))] {
            let mut reader = ScriptedRead(VecDeque::from([
                Ok(&b"prefix\xc3"[..]),
                Err(io::ErrorKind::Interrupted.into()),
                Err(io::ErrorKind::WouldBlock.into()),
                Ok(&b"\xa9"[..]),
                Ok(&b"\xe2"[..]),
                Ok(&b"\x82"[..]),
                eof,
            ]));
            let mut output = Vec::new();
            pump(
                &mut reader,
                || Ok(true),
                |data| {
                    output.push(data);
                    true
                },
            )
            .unwrap();
            assert_eq!(output, ["prefix", "é", "\u{fffd}"]);
            assert!(reader.0.is_empty());
        }
    }

    #[test]
    fn cancellation_does_not_flush_a_partial_character() {
        let mut reader = ScriptedRead(VecDeque::from([Ok(&b"prefix\xc3"[..])]));
        let mut checks = 0;
        let mut output = Vec::new();
        pump(
            &mut reader,
            || {
                checks += 1;
                Ok(checks == 1)
            },
            |data| {
                output.push(data);
                true
            },
        )
        .unwrap();
        assert_eq!(output, ["prefix"]);
        assert!(reader.0.is_empty());
    }

    #[test]
    fn a_disconnected_consumer_stops_further_reads() {
        let mut reader = ScriptedRead(VecDeque::from([Ok(&b"first"[..]), Ok(&b"second"[..])]));
        pump(&mut reader, || Ok(true), |_| false).unwrap();
        assert_eq!(reader.0.len(), 1);
    }

    #[test]
    fn read_and_readiness_errors_are_not_eof() {
        let mut reader = ScriptedRead(VecDeque::from([
            Err(io::ErrorKind::PermissionDenied.into()),
        ]));
        assert_eq!(
            pump(&mut reader, || Ok(true), |_| panic!("unexpected data"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            pump(
                &mut reader,
                || Err(io::ErrorKind::BrokenPipe.into()),
                |_| true
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn timeout_does_not_close_the_reader_and_eof_joins_it() {
        let (source, mut writer) = UnixStream::pair().unwrap();
        let mut reader = PtyReader::spawn(7, source.into()).unwrap();
        assert_eq!(
            reader.recv_timeout(Duration::ZERO).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        writer.write_all(b"ok").unwrap();
        drop(writer);
        assert_eq!(
            reader.recv_timeout(Duration::from_secs(5)).unwrap(),
            Some("ok".to_string())
        );
        assert_eq!(reader.recv_timeout(Duration::from_secs(5)).unwrap(), None);
        assert!(reader.worker.is_none());
        assert_eq!(reader.recv().unwrap(), None);
    }

    #[test]
    fn cancellation_wakes_an_idle_descriptor_without_closing_its_writer_first() {
        let (source, _writer) = UnixStream::pair().unwrap();
        let reader = PtyReader::spawn(7, source.into()).unwrap();
        let (done, completion) = mpsc::channel();
        let stopper = thread::spawn(move || {
            done.send(reader.cancel()).unwrap();
        });
        completion
            .recv_timeout(Duration::from_secs(5))
            .expect("reader cancellation stalled")
            .unwrap();
        stopper.join().unwrap();
    }

    #[test]
    fn cancellation_disconnects_a_full_channel_before_joining() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let (entered, ready) = mpsc::channel();
        let (wake, _cancellation) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            sender.send("first".to_string()).unwrap();
            entered.send(()).unwrap();
            assert!(sender.send("blocked".to_string()).is_err());
            Ok(())
        });
        let reader = PtyReader {
            pid: 7,
            receiver: Some(receiver),
            wake: Some(wake),
            worker: Some(worker),
        };
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done, completion) = mpsc::channel();
        let stopper = thread::spawn(move || {
            done.send(reader.cancel()).unwrap();
        });
        completion
            .recv_timeout(Duration::from_secs(5))
            .expect("full-channel cancellation stalled")
            .unwrap();
        stopper.join().unwrap();
    }

    #[test]
    fn worker_failures_are_joined_and_reported_after_prior_data() {
        for cancel in [true, false] {
            let (sender, receiver) = mpsc::sync_channel(1);
            let (wake, _cancellation) = UnixStream::pair().unwrap();
            let worker = thread::spawn(move || {
                let _ = sender.send("prior".to_string());
                Err(io::ErrorKind::PermissionDenied.into())
            });
            let mut reader = PtyReader {
                pid: 7,
                receiver: Some(receiver),
                wake: Some(wake),
                worker: Some(worker),
            };
            let error = if cancel {
                reader.cancel().err()
            } else {
                assert_eq!(reader.recv().unwrap().as_deref(), Some("prior"));
                reader.recv().err()
            };
            assert_eq!(
                error.map(|error| error.kind()),
                Some(io::ErrorKind::PermissionDenied)
            );
        }
    }

    #[test]
    fn stale_readiness_returns_to_cancellation_instead_of_blocking() {
        let (mut source, mut writer) = UnixStream::pair().unwrap();
        source.set_nonblocking(true).unwrap();
        let (wake, cancellation) = UnixStream::pair().unwrap();
        let mut readiness =
            Readiness::new(source.as_raw_fd(), Some(cancellation.as_raw_fd()), false).unwrap();
        writer.write_all(b"x").unwrap();
        assert!(readiness.wait().unwrap());
        let mut byte = [0];
        source.read_exact(&mut byte).unwrap();
        drop(wake);
        let mut first = true;
        pump(
            &mut source,
            || {
                if first {
                    first = false;
                    Ok(true)
                } else {
                    readiness.wait()
                }
            },
            |_| panic!("flushed bytes must not be delivered"),
        )
        .unwrap();
    }

    #[test]
    fn queue_bridge_respects_walker_ownership_and_stale_pid() {
        let (source, mut writer) = UnixStream::pair().unwrap();
        let mut reader = PtyReader::spawn(7, source.into()).unwrap();
        let mut pipe = Pipe::new();
        assert_eq!(pipe.start(7), 1);
        writer.write_all(b"first").unwrap();
        assert_eq!(reader.enqueue_next(&mut pipe).unwrap(), Some(true));
        writer.write_all(b"second").unwrap();
        assert_eq!(reader.enqueue_next(&mut pipe).unwrap(), Some(false));
        assert_eq!(pipe.queued(), 2);
        assert_eq!(pipe.start(8), 2);
        writer.write_all(b"stale").unwrap();
        assert_eq!(reader.enqueue_next(&mut pipe).unwrap(), Some(false));
        assert_eq!(pipe.queued(), 0);
        drop(writer);
        assert_eq!(reader.enqueue_next(&mut pipe).unwrap(), None);
        assert_eq!(pipe.sequence(), 2);
    }
}
