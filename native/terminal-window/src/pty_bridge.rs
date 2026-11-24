//! The seam between the window's main thread and the shell.
//!
//! `PtySession` owns the child, its reader thread and its exit observer, and delivers events
//! through one internal channel that cannot be shared, so one thread owns the session outright.
//! That thread is this module's worker: it polls the session with a short timeout, which is what
//! lets it service input and resize commands between chunks of output.
//!
//! Output goes back on a `futures` unbounded channel so the gpui task can `await` it and be
//! resumed on the main thread; the session's own queue is bounded upstream, so a shell that
//! outruns the UI blocks on its PTY the same way it blocks on a slow terminal today.

use std::io;
use std::sync::mpsc::{SyncSender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use lmcs_pty::Env;
use lmcs_pty::native_pty::NativePtySpawner;
use lmcs_pty::node_pty::{PTY_TERMINAL_NAME, PtyExitEvent};
use lmcs_pty::session::{PtySession, SessionEvent};
use lmcs_pty::shell::{default_shell_resolver, resolve_shell_candidates};
use lmcs_pty::spawn::{PtySpawnError, PtySpawnInput, SpawnTarget, Spawned, Spawner, try_spawn};
use lmcs_pty::{Platform, create_terminal_spawn_env};

/// How long the worker waits for output before it looks at the command channel again. Long
/// enough that an idle terminal costs nothing, short enough that a keystroke feels immediate.
const POLL: Duration = Duration::from_millis(4);

/// Depth of the UI-to-shell queue. Keystrokes and resize requests are all this ever carries.
const COMMAND_QUEUE: usize = 64;

/// Commands the UI sends to the shell.
pub enum ToPty {
    /// Bytes to write, already encoded by the input path.
    Input(Vec<u8>),
    /// The grid the engine now has, in cells.
    Resize { cols: u32, rows: u32 },
}

/// What the shell tells the UI.
pub enum FromPty {
    Output(String),
    Exited { code: i32, signal: Option<i32> },
}

/// Adapts the session's one-shot spawn to the ported candidate-retry decision, so the window
/// falls back through the same shell list the server does instead of inventing its own.
struct SessionSpawner {
    platform: Platform,
}

impl Spawner for SessionSpawner {
    type Process = PtySession;

    fn spawn(&self, input: &PtySpawnInput) -> Result<PtySession, PtySpawnError> {
        PtySession::spawn(NativePtySpawner::new(self.platform), input)
    }
}

pub struct PtyBridge {
    commands: Option<SyncSender<ToPty>>,
    output: Option<UnboundedReceiver<FromPty>>,
    worker: Option<JoinHandle<()>>,
    /// The candidate that spawned, for the title: `$SHELL` is not always what ran.
    pub shell_label: String,
}

impl PtyBridge {
    /// Spawns the shell the ported resolver picks, at the given size, on a worker thread.
    pub fn start(cwd: &str, cols: u32, rows: u32) -> Result<Self, PtySpawnError> {
        let platform = Platform::from_node_str(std::env::consts::OS);
        let base = Env::from_pairs(std::env::vars());
        let home = std::env::var("HOME").unwrap_or_default();
        let mut env = create_terminal_spawn_env(&base, None, &home, platform);
        // `node-pty` forces this into the child whatever the caller passed; the portable spawner
        // takes the environment at face value, so the client has to ask for it.
        env.set("TERM", PTY_TERMINAL_NAME);

        let candidates =
            resolve_shell_candidates(&default_shell_resolver(platform, &env), platform, &env);
        let Spawned {
            process: session,
            shell_label,
        } = try_spawn(
            &SessionSpawner { platform },
            &candidates,
            SpawnTarget {
                cwd,
                cols,
                rows,
                env: &env,
            },
        )?;

        let (commands, receiver) = std::sync::mpsc::sync_channel::<ToPty>(COMMAND_QUEUE);
        let (output_sender, output) = unbounded::<FromPty>();
        let worker = thread::Builder::new()
            .name(format!("pty-{}", session.pid()))
            .spawn(move || run(session, receiver, output_sender))
            .expect("spawn the pty worker");
        Ok(Self {
            commands: Some(commands),
            output: Some(output),
            worker: Some(worker),
            shell_label,
        })
    }

    /// Takes the output stream. Calling this twice hands out nothing, so call it once, at startup.
    pub fn take_output(&mut self) -> Option<UnboundedReceiver<FromPty>> {
        self.output.take()
    }

    pub fn send(&mut self, command: ToPty) {
        if let Some(commands) = &self.commands {
            // A full or closed queue means the shell is not reading or already gone; a dropped
            // keystroke is better than blocking the UI thread.
            let _ = commands.try_send(command);
        }
    }
}

impl Drop for PtyBridge {
    fn drop(&mut self) {
        // Closing the queue ends the worker's loop, and the session's own drop terminates and
        // reaps the child. Joining here is what keeps that from racing process exit.
        self.commands.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(
    mut session: PtySession,
    commands: std::sync::mpsc::Receiver<ToPty>,
    output: UnboundedSender<FromPty>,
) {
    // `try_write` accepts a prefix on a busy PTY; the rest waits for the readiness event the
    // session arms for us, which is the shipped scheduler rather than a spin.
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match commands.try_recv() {
            Ok(ToPty::Input(bytes)) => pending.extend(bytes),
            Ok(ToPty::Resize { cols, rows }) => {
                let _ = session.resize(cols, rows);
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => break,
        }

        if !pending.is_empty() {
            match session.try_write(&pending) {
                Ok(written) => {
                    pending.drain(..written);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let _ = session.request_writable();
                }
                Err(_) => break,
            }
        }

        match session.recv_timeout(POLL) {
            Ok(Some(SessionEvent::Data(text))) => {
                if output.unbounded_send(FromPty::Output(text)).is_err() {
                    break;
                }
            }
            Ok(Some(SessionEvent::Writable)) => {}
            Ok(Some(SessionEvent::Exit(PtyExitEvent { exit_code, signal }))) => {
                let _ = output.unbounded_send(FromPty::Exited {
                    code: exit_code,
                    signal,
                });
                break;
            }
            Ok(None) => break,
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    drop(session);
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{StreamExt, executor::block_on};
    use lmcs_ghostty_vt::terminal::Color;
    use lmcs_ghostty_vt::{
        DEFAULT_BACKGROUND, DEFAULT_FOREGROUND, GhosttyTerminal, Theme, load_embedded,
    };

    /// The seam this crate exists for: a real shell's bytes, through the worker loop, into the
    /// engine grid the renderer reads. Everything else here is gpui plumbing around it.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn shell_output_reaches_the_engine_grid_before_the_exit() {
        let platform = Platform::from_node_str(std::env::consts::OS);
        let home = std::env::var("HOME").unwrap_or_default();
        let mut env =
            create_terminal_spawn_env(&Env::from_pairs(std::env::vars()), None, &home, platform);
        env.set("TERM", PTY_TERMINAL_NAME);
        let args = vec![
            "-c".to_string(),
            "printf 'milestone-a\\n'; exit 3".to_string(),
        ];
        let session = PtySession::spawn(
            NativePtySpawner::new(platform),
            &PtySpawnInput {
                shell: "/bin/sh",
                args: Some(&args),
                cwd: "/",
                cols: 80,
                rows: 24,
                env: &env,
            },
        )
        .expect("spawn a shell");

        let (commands, receiver) = std::sync::mpsc::sync_channel::<ToPty>(COMMAND_QUEUE);
        let (sender, mut output) = unbounded::<FromPty>();
        let worker = thread::spawn(move || run(session, receiver, sender));

        let mut text = String::new();
        let mut exit = None;
        while let Some(event) = block_on(output.next()) {
            match event {
                FromPty::Output(chunk) => text.push_str(&chunk),
                FromPty::Exited { code, signal } => {
                    exit = Some((code, signal));
                    break;
                }
            }
        }
        // Closing the queue is what ends the worker, and joining it is what proves the child was
        // reaped rather than left behind.
        drop(commands);
        worker.join().expect("the pty worker panicked");

        assert!(text.contains("milestone-a"), "output: {text:?}");
        // A clean exit is a code *and* signal `0`, the shape the library reports and the renderer
        // has to read as "not signaled".
        assert_eq!(exit, Some((3, Some(0))), "output: {text:?}");

        let mut terminal = GhosttyTerminal::new(
            load_embedded().expect("load the shipped engine"),
            80,
            24,
            8,
            16,
            &Theme {
                foreground: DEFAULT_FOREGROUND,
                background: DEFAULT_BACKGROUND,
                cursor: Color { r: 0, g: 0, b: 0 },
            },
        )
        .expect("create a terminal");
        terminal.write(text.as_bytes()).expect("feed the grid");
        let snapshot = terminal.snapshot().expect("read the grid");
        let rendered = snapshot
            .row_data
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("milestone-a"), "grid: {rendered:?}");
    }
}
