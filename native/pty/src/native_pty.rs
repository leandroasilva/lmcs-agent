//! The `Spawner` that opens a real pseudo terminal, over `portable-pty`.
//!
//! This is the boundary the pure decisions in [`crate::node_pty`] were written for: nothing here
//! decides anything about shells, `TERM` or signals — it takes those answers and asks an operating
//! system for a terminal. The conversions that are genuinely this layer's own are in
//! [`library_size`] (the width the manager carries is a JavaScript number, the kernel's is an
//! `unsigned short`) and [`exit_event_of`] (a wait status is either a code or a signal, and the
//! shipped adapter is handed both).
//!
//! Two probes ask the same questions of one host:
//! `apps/server/scripts/node-pty-child-probe.ts` drives the packaged `node-pty` the shipped product
//! uses, and `tests/native_pty.rs` drives this binding. The differences are listed at the bottom of
//! this module.

use std::io::{self, Read, Write};

use portable_pty::{
    Child, CommandBuilder, MasterPty, PtySize as LibraryPtySize, native_pty_system,
};

use crate::Platform;
use crate::node_pty::{
    PtyExitEvent, PtySize, child_environment, exit_event, kill_argument, pty_library_call,
    pty_size, spawn_error,
};
use crate::spawn::{PtySpawnError, PtySpawnInput, SpawnCause, Spawner};

/// The library's own size struct, with the pixel fields the shipped adapter never sets.
///
/// `node-pty` takes `cols` and `rows` as JavaScript numbers and hands them to a C `winsize` of
/// `unsigned short`, so a width of 65539 reaches the kernel as 3 — measured through the packaged
/// library (`hugeCols`: `size=3 3`). `as u16` is that same truncation; a clamp would be a behavior
/// the product does not have.
#[must_use]
pub fn library_size(size: PtySize) -> LibraryPtySize {
    LibraryPtySize {
        rows: size.rows as u16,
        cols: size.cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The wait status of a finished child, in the shape the manager is given.
///
/// A process that exits normally has no signal, and a process that is killed has no code, but the
/// shipped adapter is handed both numbers and passes both on: `exit 3` arrives as
/// `{exitCode: 3, signal: 0}` and `kill -9 $$` as `{exitCode: 0, signal: 9}`. Measured through the
/// packaged library (`exit3`, `killSelf9`), and the reason `signal` is never simply absent from a
/// POSIX exit.
#[cfg(unix)]
#[must_use]
pub fn exit_event_of(status: &std::process::ExitStatus) -> PtyExitEvent {
    use std::os::unix::process::ExitStatusExt as _;

    match status.signal() {
        Some(signal) => exit_event(0, Some(signal)),
        None => exit_event(status.code().unwrap_or(0), Some(0)),
    }
}

/// What a failed library call becomes: the same wrapped error the shipped adapter builds from
/// whatever `node-pty` threw, so the manager's retry predicate reads a cause chain of one shape.
fn failed(shell: &str, cause: impl std::fmt::Display) -> PtySpawnError {
    spawn_error(shell, SpawnCause::error(cause.to_string()))
}

/// Opens a terminal through the operating system's own pseudo terminal.
///
/// The handle is made per spawn on purpose: it is a unit struct on every platform, and carrying one
/// would make the spawner `!Sync` for nothing.
#[derive(Clone, Copy, Debug)]
pub struct NativePtySpawner {
    platform: Platform,
}

impl NativePtySpawner {
    /// The spawner for one platform. The platform is an argument rather than a `cfg` because the
    /// `TERM` backfill, the kill signal and the exit mapping all read it.
    #[must_use]
    pub fn new(platform: Platform) -> Self {
        Self { platform }
    }
}

impl Spawner for NativePtySpawner {
    type Process = NativePtyProcess;

    fn spawn(&self, input: &PtySpawnInput) -> Result<NativePtyProcess, PtySpawnError> {
        let call = pty_library_call(input, self.platform);
        let shell = call.file.clone();

        // `CommandBuilder` starts a program whose directory is not there in the *home* directory
        // instead of refusing (`as_command` filters the cwd through `is_dir` and falls back). The
        // shipped manager refuses a bad directory before it asks any adapter (`assertValidCwd`),
        // so this guard is not parity with a shipped check: it is the reason a Rust terminal
        // cannot silently open in the wrong place.
        if !std::path::Path::new(&call.cwd).is_dir() {
            return Err(failed(&shell, format!("{} is not a directory", call.cwd)));
        }

        let pair = native_pty_system()
            .openpty(library_size(pty_size(call.cols, call.rows)))
            .map_err(|cause| failed(&shell, cause))?;

        let mut command = CommandBuilder::new(&call.file);
        command.args(&call.args);
        command.cwd(&call.cwd);
        // `CommandBuilder::new` seeds the child with the *server's* whole environment. Clearing it
        // is what keeps `PORT` and the AppImage runtime out of a user's shell; the scrubbing in
        // `crate::env` is only the other half of that guarantee.
        command.env_clear();
        for (key, value) in child_environment(&call, self.platform).entries() {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|cause| failed(&shell, cause))?;
        // The slave has to be dropped here: as long as another copy of it is open, the master's
        // reader never sees the end of the terminal.
        drop(pair.slave);

        let pid = child
            .process_id()
            .ok_or_else(|| failed(&shell, "the terminal process reported no pid"))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|cause| failed(&shell, cause))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|cause| failed(&shell, cause))?;

        Ok(NativePtyProcess {
            pid,
            platform: self.platform,
            master: pair.master,
            reader: Some(reader),
            writer,
            child,
        })
    }
}

/// A running terminal: the child, and the master side the server drives it through.
pub struct NativePtyProcess {
    pid: u32,
    platform: Platform,
    master: Box<dyn MasterPty + Send>,
    reader: Option<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl std::fmt::Debug for NativePtyProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativePtyProcess")
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

impl NativePtyProcess {
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn write(&mut self, data: &str) -> io::Result<()> {
        let mut bytes = data.as_bytes();
        #[cfg(unix)]
        let mut writable = None;
        while !bytes.is_empty() {
            match self.writer.write(bytes) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => bytes = &bytes[count..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                #[cfg(unix)]
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if writable.is_none() {
                        let fd = self
                            .master
                            .as_raw_fd()
                            .ok_or_else(|| io::Error::from(io::ErrorKind::Unsupported))?;
                        writable = Some(crate::readiness::Readiness::new(fd, None, true)?);
                    }
                    writable.as_mut().unwrap().wait()?;
                }
                Err(error) => return Err(error),
            }
        }
        self.writer.flush()
    }

    /// Takes the two numbers in the order the shipped interface uses them, so the swap stays
    /// inside [`pty_size`].
    pub fn resize(&mut self, cols: u32, rows: u32) -> io::Result<()> {
        self.master
            .resize(library_size(pty_size(cols, rows)))
            .map_err(io::Error::other)
    }

    /// The size the kernel has, which is what a `stty size` in the child reports.
    pub fn size(&self) -> io::Result<PtySize> {
        let size = self.master.get_size().map_err(io::Error::other)?;
        Ok(pty_size(u32::from(size.cols), u32::from(size.rows)))
    }

    /// Sends whatever [`kill_argument`] decided to send.
    ///
    /// `None` is not "no preference": `node-pty`'s one-argument-less kill sends `SIGHUP` (measured:
    /// `killNoSignal` reports `signal: 1`), and the shipped Windows branch reaches that call by
    /// dropping the signal rather than by choosing a gentler one. ConPTY therefore takes the
    /// library's own terminate here, and POSIX keeps the hangup.
    pub fn kill(&mut self, signal: Option<&str>) -> io::Result<()> {
        match kill_argument(self.platform, signal) {
            Some(name) => send_signal(self.pid, name),
            None if self.platform.is_win32() => self.child.kill(),
            None => send_signal(self.pid, "SIGHUP"),
        }
    }

    pub fn reader_mut(&mut self) -> io::Result<&mut (dyn Read + Send + 'static)> {
        self.reader.as_deref_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "PTY output already belongs to a reader thread",
            )
        })
    }

    /// Transfers exclusive output ownership while keeping input, resize and child control here.
    #[cfg(unix)]
    pub fn start_reader(&mut self) -> io::Result<crate::reader::PtyReader> {
        use std::os::fd::BorrowedFd;

        self.reader_mut()?;
        let fd = self.master.as_raw_fd().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "PTY master has no Unix descriptor",
            )
        })?;
        let owned = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
        let flags = crate::readiness::status_flags(fd)?;
        // A child may flush output after readiness; nonblocking read keeps cancellation reachable.
        crate::readiness::set_status_flags(fd, flags | libc::O_NONBLOCK)?;
        let reader = match crate::reader::PtyReader::spawn(self.pid, owned) {
            Ok(reader) => reader,
            Err(error) => {
                crate::readiness::set_status_flags(fd, flags)?;
                return Err(error);
            }
        };
        self.reader.take();
        Ok(reader)
    }

    /// Blocks until the child is done.
    ///
    /// The reader has to be drained to get here on a busy terminal: a pseudo terminal buffer is
    /// finite, so a server that never reads it is a server whose shell stopped mid-`cat`.
    pub fn wait(&mut self) -> io::Result<PtyExitEvent> {
        wait_child(&mut *self.child)
    }

    /// Cancel the detached reader first; unread PTY output can otherwise stall reaping on macOS.
    pub fn close_and_wait(self) -> io::Result<PtyExitEvent> {
        #[cfg(unix)]
        if let Some(fd) = self.master.as_raw_fd() {
            // portable-pty's writer Drop attempts to write VEOF even when input is full.
            let flags = crate::readiness::status_flags(fd)?;
            crate::readiness::set_status_flags(fd, flags | libc::O_NONBLOCK)?;
        }
        let Self {
            master,
            reader,
            writer,
            mut child,
            ..
        } = self;
        drop(reader);
        drop(writer);
        drop(master);
        wait_child(&mut *child)
    }
}

fn wait_child(child: &mut dyn Child) -> io::Result<PtyExitEvent> {
    // portable-pty's mapped status loses the numeric Unix signal.
    #[cfg(unix)]
    if let Some(child) = child.downcast_mut::<std::process::Child>() {
        return Ok(exit_event_of(&child.wait()?));
    }
    let status = child.wait()?;
    Ok(exit_event(
        i32::try_from(status.exit_code()).unwrap_or(1),
        status.signal().map(|_| 0),
    ))
}

#[cfg(unix)]
fn send_signal(pid: u32, name: &str) -> io::Result<()> {
    let signum = match name {
        "SIGHUP" => libc::SIGHUP,
        "SIGTERM" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        // The manager only ever asks for `SIGTERM` and then `SIGKILL`; anything else is a caller
        // bug, and saying so beats picking a signal.
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unsupported terminal signal {other}"),
            ));
        }
    };
    let pid = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
    // The pid is ours: it came from the child this process spawned and has not waited on yet.
    if unsafe { libc::kill(pid, signum) } == 0 {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

#[cfg(not(unix))]
fn send_signal(_pid: u32, name: &str) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("this platform has no signals to send, asked for {name}"),
    ))
}

/// **Measured deviations** between the packaged `node-pty` and this binding, on one host. The
/// shipped retry loop was written for a library that throws, and neither library is that one:
///
/// * A shell that is not there does **not** throw in `node-pty`. The helper exits and the terminal
///   closes with `{exitCode: 1, signal: 0}` (`missingExecutable`), so no candidate after the first
///   is ever tried and the user sees a terminal that blinked. Here `portable-pty` resolves the
///   program before spawning and reports `Unable to spawn … because it doesn't exist on the
///   filesystem (ENOENT)`, which the shipped retry predicate reads as a missing executable, so the
///   walk runs the way `Manager.ts` intends. That is a behavioral improvement, not parity, and it
///   is asserted by `tests/native_pty.rs`.
/// * A `cwd` that is not a directory exits `1` there (`missingCwd`) and would make `portable-pty`
///   start the shell in the **home** directory. That one is refused before the spawn, above.
/// * `kill()` with no signal is `SIGHUP` there and is not reachable here: [`NativePtyProcess::kill`]
///   spells it, because the shipped Windows branch arrives at the same call by dropping the signal.
/// * A `SHELL` the spawn environment never named appears in the child on both paths, by different
///   routes — the shell fills it in from the password database, and `CommandBuilder` injects its own
///   guess after `env_clear`. Both probes report the login shell (`probe`: `shell=/bin/zsh` for
///   an environment with no `SHELL`), so it is not a deviation, but it is not nothing either.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;

    #[test]
    fn the_size_narrows_the_way_the_kernel_would() {
        let size = library_size(pty_size(132, 43));
        assert_eq!((size.cols, size.rows), (132, 43));
        // `unsigned short` truncation, not saturation: measured `size=3 3` for cols 65539.
        assert_eq!(library_size(pty_size(65539, 3)).cols, 3);
    }

    #[cfg(unix)]
    #[test]
    fn one_exit_is_a_code_and_the_other_is_a_signal() {
        use std::os::unix::process::ExitStatusExt as _;

        let exited = std::process::ExitStatus::from_raw(3 << 8);
        assert_eq!(exit_event_of(&exited), exit_event(3, Some(0)));
        let killed = std::process::ExitStatus::from_raw(9);
        assert_eq!(exit_event_of(&killed), exit_event(0, Some(9)));
    }

    #[test]
    fn a_directory_that_is_not_there_is_refused_rather_than_answered_with_home() {
        let spawner = NativePtySpawner::new(Platform::Linux);
        let env = Env::new();
        let error = spawner
            .spawn(&PtySpawnInput {
                shell: "/bin/sh",
                args: None,
                cwd: "/definitely/not/a/directory",
                cols: 80,
                rows: 24,
                env: &env,
            })
            .expect_err("a terminal has no business starting in $HOME");

        // Not a walkable one: every candidate would fall over on the same directory, and the
        // manager's exhausted-candidates message names shells, not the folder that is gone.
        assert!(
            !crate::spawn::is_retryable_shell_spawn_error(&error),
            "{}",
            error.message()
        );
        assert_eq!(error.shell.as_deref(), Some("/bin/sh"));
        assert!(
            error.messages().iter().any(|message| {
                message.contains("/definitely/not/a/directory") && message.contains("directory")
            }),
            "{:?}",
            error.messages()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_the_manager_never_asks_for_is_refused_before_anything_is_signalled() {
        // A pid no host can have, so a mutation that sends first and checks later still hits
        // nothing: this asserts the error is about the name, not about the process.
        let error = send_signal(u32::MAX, "SIGUSR1")
            .expect_err("the terminal kill has no fallthrough signal");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("SIGUSR1"), "{error}");
    }
}
