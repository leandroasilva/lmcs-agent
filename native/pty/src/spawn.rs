//! Spawning, and what the server does when the shell it wanted is not there.
//!
//! Ported from `PtyAdapter.PtySpawnError`, `isRetryableShellSpawnError` and `trySpawn` in
//! `apps/server/src/terminal/Manager.ts`. The retry decision is the whole contract: it is
//! what separates "this machine has no zsh" from "the shell exists but cannot run", and
//! only the first one moves on to the next candidate.

use crate::env::Env;
use crate::jsstr::js_to_lowercase;
use crate::shell::{ShellCandidate, format_shell_candidate};

/// The adapter's own message text, which is the only part of a spawn failure the user
/// ever sees, plus the cause chain the retry predicate has to walk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpawnCause {
    /// A bare string cause. JavaScript pushes it into the message list as-is.
    Text(String),
    /// An `Error` or a `{ message, cause }` object. Both are walked the same way: a
    /// `message` that is a string is collected even when it is empty.
    ///
    /// One JavaScript nuance cannot be expressed here: `if (value.cause)` skips a cause
    /// that is present but falsy, so `cause: ""` ends the walk in TypeScript while this
    /// model would walk it as an empty text. Every real cause is an object or a non-empty
    /// message, so the difference is unreachable from the shipped adapters.
    Nested {
        message: Option<String>,
        cause: Option<Box<SpawnCause>>,
    },
}

impl SpawnCause {
    #[must_use]
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    #[must_use]
    pub fn error(message: impl Into<String>) -> Self {
        Self::Nested {
            message: Some(message.into()),
            cause: None,
        }
    }

    #[must_use]
    pub fn caused(message: impl Into<String>, cause: SpawnCause) -> Self {
        Self::Nested {
            message: Some(message.into()),
            cause: Some(Box::new(cause)),
        }
    }

    fn collect(&self, messages: &mut Vec<String>) {
        match self {
            Self::Text(text) => messages.push(text.clone()),
            Self::Nested { message, cause } => {
                if let Some(message) = message {
                    messages.push(message.clone());
                }
                if let Some(cause) = cause {
                    cause.collect(messages);
                }
            }
        }
    }
}

/// `PtySpawnError`, including the message the shipped getter renders. The cause is
/// deliberately not part of it: a user gets the shell they asked for and the adapter name,
/// not `posix_spawnp` internals.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtySpawnError {
    pub adapter: String,
    pub shell: Option<String>,
    pub attempted_shells: Option<Vec<String>>,
    pub cause: Option<SpawnCause>,
}

impl PtySpawnError {
    #[must_use]
    pub fn message(&self) -> String {
        let shell = self
            .shell
            .as_ref()
            .map_or_else(String::new, |shell| format!(" '{shell}'"));
        let attempted = match &self.attempted_shells {
            Some(shells) if !shells.is_empty() => {
                format!(" Tried shells: {}.", shells.join(", "))
            }
            _ => String::new(),
        };
        format!("Failed to spawn PTY process{shell} with {}.{}", self.adapter, attempted)
    }

    /// Every message in the error and its causes, in the order the shipped walker
    /// collects them: the error's own message first, then the chain.
    #[must_use]
    pub fn messages(&self) -> Vec<String> {
        let mut messages = vec![self.message()];
        if let Some(cause) = &self.cause {
            cause.collect(&mut messages);
        }
        messages
    }
}

impl std::fmt::Display for PtySpawnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for PtySpawnError {}

/// `isRetryableShellSpawnError`.
#[must_use]
pub fn is_retryable_shell_spawn_error(error: &PtySpawnError) -> bool {
    let message = js_to_lowercase(&error.messages().join(" "));
    [
        "posix_spawnp failed",
        "enoent",
        "not found",
        "file not found",
        "no such file",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// What the manager hands an adapter: a shell to run and the session it belongs to.
#[derive(Clone, Debug)]
pub struct PtySpawnInput<'a> {
    pub shell: &'a str,
    pub args: Option<&'a [String]>,
    pub cwd: &'a str,
    pub cols: u32,
    pub rows: u32,
    pub env: &'a Env,
}

/// The per-session half of a spawn, constant across every candidate attempt.
#[derive(Clone, Copy, Debug)]
pub struct SpawnTarget<'a> {
    pub cwd: &'a str,
    pub cols: u32,
    pub rows: u32,
    pub env: &'a Env,
}

/// The process a successful spawn produced, and the label the manager reports for it.
#[derive(Debug)]
pub struct Spawned<Process> {
    pub process: Process,
    pub shell_label: String,
}

/// The adapter seam. `lmcs-pty` owns the decision of *which* shell to run; binding this to
/// an actual PTY is a separate implementation.
pub trait Spawner {
    type Process;

    fn spawn(&self, input: &PtySpawnInput) -> Result<Self::Process, PtySpawnError>;
}

/// `trySpawn`. Walks the candidates in order, retrying only what looks like a missing
/// executable, and reports the whole list once none of them worked.
pub fn try_spawn<S: Spawner + ?Sized>(
    spawner: &S,
    candidates: &[ShellCandidate],
    target: SpawnTarget<'_>,
) -> Result<Spawned<S::Process>, PtySpawnError> {
    let mut last_error: Option<PtySpawnError> = None;

    for candidate in candidates {
        let attempt = spawner.spawn(&PtySpawnInput {
            shell: &candidate.shell,
            args: candidate.args.as_deref(),
            cwd: target.cwd,
            cols: target.cols,
            rows: target.rows,
            env: target.env,
        });

        match attempt {
            Ok(process) => {
                return Ok(Spawned {
                    process,
                    shell_label: format_shell_candidate(candidate),
                });
            }
            Err(error) if !is_retryable_shell_spawn_error(&error) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }

    Err(PtySpawnError {
        adapter: "terminal-manager".to_string(),
        shell: None,
        attempted_shells: Some(candidates.iter().map(format_shell_candidate).collect()),
        cause: last_error.map(SpawnCause::from),
    })
}

impl From<PtySpawnError> for SpawnCause {
    /// The manager wraps the last adapter error as the cause of its own, which is how the
    /// chain the retry predicate walks gets one level deeper on every attempt.
    fn from(error: PtySpawnError) -> Self {
        Self::Nested {
            message: Some(error.message()),
            cause: error.cause.map(Box::new),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter_error(shell: &str, cause: SpawnCause) -> PtySpawnError {
        PtySpawnError {
            adapter: "node-pty".to_string(),
            shell: Some(shell.to_string()),
            attempted_shells: None,
            cause: Some(cause),
        }
    }

    #[test]
    fn a_missing_executable_retries_and_a_broken_one_does_not() {
        assert!(is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::error("posix_spawnp failed.")
        )));
        assert!(is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::error("ENOENT")
        )));
        assert!(!is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::error("EACCES: permission denied")
        )));
    }

    #[test]
    fn the_retry_signal_may_hide_in_a_nested_cause() {
        assert!(is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::caused(
                "spawn failed",
                SpawnCause::Nested {
                    message: None,
                    cause: Some(Box::new(SpawnCause::text("No such file or directory"))),
                }
            )
        )));
        // An object with no message of its own still contributes whatever its cause says.
        assert!(is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::Nested {
                message: None,
                cause: Some(Box::new(SpawnCause::text("no such file"))),
            }
        )));
        assert!(!is_retryable_shell_spawn_error(&adapter_error(
            "/bin/zsh",
            SpawnCause::Nested {
                message: None,
                cause: Some(Box::new(SpawnCause::text("EACCES"))),
            }
        )));
    }

    #[test]
    fn the_rendered_message_keeps_out_the_cause() {
        assert_eq!(
            adapter_error("/bin/zsh", SpawnCause::error("posix_spawnp failed.")).message(),
            "Failed to spawn PTY process '/bin/zsh' with node-pty."
        );
        assert_eq!(
            PtySpawnError {
                adapter: "terminal-manager".to_string(),
                shell: None,
                attempted_shells: Some(vec!["/bin/sh".to_string(), "zsh -l".to_string()]),
                cause: None,
            }
            .message(),
            "Failed to spawn PTY process with terminal-manager. Tried shells: /bin/sh, zsh -l."
        );
        assert_eq!(
            PtySpawnError {
                adapter: "terminal-manager".to_string(),
                shell: None,
                attempted_shells: Some(Vec::new()),
                cause: None,
            }
            .message(),
            "Failed to spawn PTY process with terminal-manager."
        );
    }
}
