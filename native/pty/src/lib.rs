//! Which shell a terminal runs, with what environment, and what happens when the shell is
//! not there.
//!
//! Ported from the platform-independent half of `apps/server/src/terminal/Manager.ts`
//! (`resolveShellCandidates` and friends, `createTerminalSpawnEnv`,
//! `isRetryableShellSpawnError`, `trySpawn`) and the `PtySpawnError` message from
//! `apps/server/src/terminal/PtyAdapter.ts`. Binding these decisions to a real PTY is a
//! separate implementation of [`spawn::Spawner`]; everything here is pure and replayable.
//!
//! Every rule is measured against the shipped TypeScript, not re-read from it: see
//! `apps/server/scripts/terminal-shell-trace.ts` and `tests/shell_golden.rs`.

pub mod env;
pub mod jsstr;
pub mod node_pty;
pub mod shell;
pub mod spawn;

pub use env::{Env, create_terminal_spawn_env, normalized_runtime_env};
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
