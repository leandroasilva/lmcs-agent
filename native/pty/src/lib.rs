//! Which shell a terminal runs with what environment, what happens when the shell is not there,
//! and what the server does with the bytes the running shell sends back.
//!
//! Ported from the platform-independent half of `apps/server/src/terminal/Manager.ts`
//! (`resolveShellCandidates` and friends, `createTerminalSpawnEnv`,
//! `isRetryableShellSpawnError`, `trySpawn`, `enqueueProcessEvent`, `drainProcessEvents`) and
//! the `PtySpawnError` message from `apps/server/src/terminal/PtyAdapter.ts`. The native spawner
//! opens real terminals; on Unix, the reader thread delivers decoded output through a bounded channel.
//! Shell, adapter and queue decisions remain pure and replayable.
//!
//! Every rule is measured against the shipped TypeScript, not re-read from it: see
//! `apps/server/scripts/terminal-shell-trace.ts` and `tests/shell_golden.rs` for the write side,
//! and `apps/server/scripts/terminal-pipe-trace.ts` and `tests/pipe_golden.rs` for the read side.

pub mod env;
pub mod exit_drain;
pub mod jsstr;
pub mod lifecycle;
pub mod native_pty;
pub mod node_pty;
pub mod output;
pub mod persisted;
pub mod pipe;
#[cfg(unix)]
pub mod reader;
#[cfg(unix)]
mod readiness;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod session;
pub mod shell;
pub mod spawn;
pub mod stream;
pub mod utf8;

pub use env::{Env, create_terminal_spawn_env, normalized_runtime_env};
pub use pipe::{Delivery, PendingEvent, Pipe, Sanitized};
pub use shell::{ShellCandidate, resolve_shell_candidates};
pub use spawn::{PtySpawnError, Spawned, Spawner, try_spawn};

/// The operating system a terminal's shell is chosen for. Only Windows differs in
/// behavior; the POSIX names are carried so a measurement can say which host it came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Win32,
    Linux,
    Darwin,
    Other,
}

impl Platform {
    /// The `process.platform` spelling the shipped code compares against.
    #[must_use]
    pub fn from_node_str(value: &str) -> Self {
        match value {
            "win32" => Self::Win32,
            "linux" => Self::Linux,
            "darwin" => Self::Darwin,
            _ => Self::Other,
        }
    }

    #[must_use]
    pub fn is_win32(self) -> bool {
        matches!(self, Self::Win32)
    }
}
