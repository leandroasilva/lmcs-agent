//! The layer below the manager: what the adapter hands the PTY library, and what it hands back.
//!
//! Ported from `apps/server/src/terminal/NodePtyAdapter.ts`. [`crate::spawn`] decides *which*
//! shell to run; this decides how that shell is asked of the library that opens the pseudo
//! terminal, and how the library's answers are re-shaped for the manager. The shipped library
//! is `node-pty`; here it is `portable-pty`, so the questions worth pinning down are the ones
//! that survive the swap — the arguments, the child's `TERM`, the signal a kill carries, the
//! order of a resize — and the ones that do not, which are named below.
//!
//! Measured against the shipped adapter by `apps/server/scripts/node-pty-adapter-trace.ts`,
//! which drives it through its own `NodePtyModuleLoaderRef` seam with a module that writes down
//! every call. See `tests/node_pty_golden.rs`.

use crate::Platform;
use crate::env::Env;
use crate::spawn::{PtySpawnError, PtySpawnInput, SpawnCause};

/// The terminal type the adapter names on every spawn. On the Unix path the library writes
/// this into the child's `TERM`, where it beats whatever `TERM` the environment carried, so
/// the value is not decoration and not a default: a child that asked for `dumb` still gets
/// this. Windows is why the environment is patched too — that path leaves `TERM` alone, so a
/// child there would otherwise inherit no `TERM` at all, or a 16-color one.
pub const PTY_TERMINAL_NAME: &str = "xterm-256color";

/// The adapter name every spawn failure carries. The manager's exhausted-candidates error
/// uses `terminal-manager` instead, and which of the two a user sees is what tells them
/// whether their shell was missing or broken.
pub const NODE_PTY_ADAPTER: &str = "node-pty";

/// One call into the PTY library, in the shape the shipped adapter builds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtyLibraryCall {
    pub file: String,
    /// `input.args ?? []`. An absent list and an empty one are the same call, and neither is
    /// joined into a command line: arguments with spaces stay separate strings.
    pub args: Vec<String>,
    pub cwd: String,
    /// Kept as the library sees them. `node-pty` takes `(cols, rows)` and `portable-pty`
    /// names `rows` first in its size struct, which is the classic place for a port to swap
    /// two numbers that are both small integers.
    pub cols: u32,
    pub rows: u32,
    pub name: &'static str,
    pub env: Env,
}

/// `NodePtyAdapter.spawn`'s argument building, including the Windows `TERM` backfill.
#[must_use]
pub fn pty_library_call(input: &PtySpawnInput<'_>, platform: Platform) -> PtyLibraryCall {
    let mut env = input.env.clone();
    // The shipped gate is `input.env["TERM"] === undefined`, not falsiness: an empty `TERM`
    // is a value the user set, and Windows children keep it.
    if platform.is_win32() && env.get("TERM").is_none() {
        env.set("TERM", PTY_TERMINAL_NAME);
    }
    PtyLibraryCall {
        file: input.shell.to_string(),
        args: input.args.map_or_else(Vec::new, <[String]>::to_vec),
        cwd: input.cwd.to_string(),
        cols: input.cols,
        rows: input.rows,
        name: PTY_TERMINAL_NAME,
        env,
    }
}

/// `NodePtyProcess.kill`. Windows has no POSIX signals, and `node-pty` terminates the process
/// tree when it is given none, so the signal is dropped at this boundary rather than translated.
#[must_use]
pub fn kill_argument(platform: Platform, signal: Option<&str>) -> Option<&str> {
    if platform.is_win32() { None } else { signal }
}

/// A window size in the shape `portable-pty` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtySize {
    pub rows: u32,
    pub cols: u32,
}

/// The one place `(cols, rows)` becomes `PtySize { rows, cols }`.
///
/// `node-pty`'s method is `resize(cols, rows)` and `portable-pty`'s struct writes `rows`
/// first, so every other layer keeps the two numbers in the shipped order and only this
/// function knows about the swap. Constructing `PtySize` by hand is how a 80×24 terminal
/// turns into a 24×80 one.
#[must_use]
pub const fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize { rows, cols }
}

/// What a finished child reports back. `signal` is `None` only when the library had nothing to
/// say: a clean POSIX exit reports signal `0`, and turning that into "no signal" would hide the
/// difference between `exit 0` and `killed by nothing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtyExitEvent {
    pub exit_code: i32,
    pub signal: Option<i32>,
}

/// The environment the child process actually ends up with, which is **not** the one in
/// [`PtyLibraryCall::env`].
///
/// On the POSIX path the library writes `name` into the child's `TERM` over whatever the caller
/// passed, so a `TERM` of `dumb` or `""` is gone before a prompt is ever drawn; the shipped
/// adapter's "leave `TERM` alone" is true of the call and false of the child. Measured against
/// the packaged library by `apps/server/scripts/node-pty-child-probe.ts` (scenarios `probe`,
/// `termDumb`, `termEmpty`): the child reports `term=xterm-256color` and exactly one `TERM` entry
/// in all three. The ConPTY path leaves the environment alone, which is why [`pty_library_call`]
/// patches it there instead.
pub fn child_environment(call: &PtyLibraryCall, platform: Platform) -> Env {
    if platform.is_win32() {
        return call.env.clone();
    }
    let mut env = call.env.clone();
    env.set("TERM", PTY_TERMINAL_NAME);
    env
}

/// The shipped mapping is `event.signal ?? null`, so the only translation is `undefined` to
/// `null`. It is spelled as a function because this is where a port is tempted to treat `0`
/// as absent.
#[must_use]
pub fn exit_event(exit_code: i32, signal: Option<i32>) -> PtyExitEvent {
    PtyExitEvent { exit_code, signal }
}

/// What the shipped adapter does with anything the library throws while spawning: one
/// `PtySpawnError` naming the adapter and the shell, with the thrown value kept as the cause
/// for the retry predicate to walk. A string, an `Error`, and a bare object all arrive here
/// the same way, and only the first two carry a message the predicate can read.
#[must_use]
pub fn spawn_error(shell: &str, cause: SpawnCause) -> PtySpawnError {
    PtySpawnError {
        adapter: NODE_PTY_ADAPTER.to_string(),
        shell: Some(shell.to_string()),
        attempted_shells: None,
        cause: Some(cause),
    }
}

/// Two blocks of the shipped adapter have no counterpart here, and the reason is worth one
/// comment each rather than a silent gap:
///
/// * `ensureNodePtySpawnHelperExecutable` exists because `node-pty` ships a prebuilt
///   `spawn-helper` binary that npm unpacks without the executable bit, and a packaged CLI
///   cannot rely on the installer having fixed it. Opening a PTY here does not go through a
///   helper executable, so there is nothing to find, and nothing to `chmod`.
/// * `NodePtyModuleLoadError` never escapes as a value anyway: the shipped `make` catches the
///   loader rejection and pipes `orDie`, so a missing addon is a defect in the Effect sense.
///   A linked-in PTY implementation cannot fail to load at run time.
#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(shell: &'a str, args: Option<&'a [String]>, env: &'a Env) -> PtySpawnInput<'a> {
        PtySpawnInput {
            shell,
            args,
            cwd: "/work",
            cols: 80,
            rows: 24,
            env,
        }
    }

    #[test]
    fn windows_backfills_term_and_posix_does_not() {
        let env = Env::from_pairs([
            ("PATH".to_string(), "/bin".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
        ]);

        let win32 = pty_library_call(&input("/bin/zsh", None, &env), Platform::Win32);
        assert_eq!(
            win32
                .env
                .entries()
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            ["PATH", "HOME", "TERM"],
            "the appended key is last, because the spread adds what the object lacks"
        );
        assert_eq!(win32.env.get("TERM"), Some(PTY_TERMINAL_NAME));

        let posix = pty_library_call(&input("/bin/zsh", None, &env), Platform::Linux);
        assert_eq!(posix.env, env);
    }

    #[test]
    fn an_empty_term_is_a_value_so_nothing_is_backfilled() {
        let env = Env::from_pairs([("TERM".to_string(), String::new())]);
        let call = pty_library_call(&input("cmd.exe", None, &env), Platform::Win32);
        assert_eq!(call.env.get("TERM"), Some(""));

        // A `TERM` the caller already set keeps its own value and its own position.
        let set = Env::from_pairs([
            ("TERM".to_string(), "xterm".to_string()),
            ("PATH".to_string(), "C:\\Windows".to_string()),
        ]);
        let call = pty_library_call(&input("pwsh.exe", None, &set), Platform::Win32);
        assert_eq!(call.env, set);
    }

    #[test]
    fn the_call_names_the_terminal_type_and_defaults_the_arguments() {
        let env = Env::new();
        let missing = pty_library_call(&input("/bin/sh", None, &env), Platform::Linux);
        assert!(missing.args.is_empty());
        assert_eq!(missing.name, "xterm-256color");
        assert_eq!((missing.cols, missing.rows), (80, 24));

        let args = vec![
            "-o".to_string(),
            "nopromptsp".to_string(),
            "echo 'a b'".to_string(),
        ];
        let with_args = pty_library_call(&input("/bin/zsh", Some(&args), &env), Platform::Linux);
        assert_eq!(
            with_args.args, args,
            "nothing is joined into a command line"
        );
    }

    #[test]
    fn windows_drops_the_signal_and_posix_keeps_it() {
        assert_eq!(kill_argument(Platform::Win32, Some("SIGTERM")), None);
        assert_eq!(
            kill_argument(Platform::Linux, Some("SIGTERM")),
            Some("SIGTERM")
        );
        assert_eq!(kill_argument(Platform::Darwin, None), None);
    }

    #[test]
    fn the_child_forgets_the_term_the_call_kept() {
        let env = Env::from_pairs([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("TERM".to_string(), "dumb".to_string()),
        ]);
        let call = pty_library_call(&input("/bin/sh", None, &env), Platform::Linux);
        assert_eq!(
            call.env.get("TERM"),
            Some("dumb"),
            "the call is what the adapter sends"
        );

        let child = child_environment(&call, Platform::Linux);
        assert_eq!(
            child.get("TERM"),
            Some(PTY_TERMINAL_NAME),
            "and the library overwrites it on the POSIX path"
        );
        assert_eq!(
            child.len(),
            call.env.len(),
            "replaced in place, not appended"
        );

        // The empty `TERM` survives the call and still does not survive the library.
        let empty = Env::from_pairs([("TERM".to_string(), String::new())]);
        let call = pty_library_call(&input("/bin/sh", None, &empty), Platform::Linux);
        assert_eq!(call.env.get("TERM"), Some(""));
        assert_eq!(
            child_environment(&call, Platform::Linux).get("TERM"),
            Some(PTY_TERMINAL_NAME)
        );

        // ConPTY is the one that leaves the environment alone, so the child sees the call.
        let windows = pty_library_call(&input("cmd.exe", None, &empty), Platform::Win32);
        assert_eq!(child_environment(&windows, Platform::Win32), windows.env);
    }

    #[test]
    fn the_resize_order_survives_the_library_swap() {
        let size = pty_size(132, 43);
        assert_eq!(
            (size.cols, size.rows),
            (132, 43),
            "portable-pty names rows first; the port must not lose the columns"
        );
    }

    #[test]
    fn a_zero_signal_is_a_signal_and_not_the_absence_of_one() {
        assert_eq!(exit_event(0, Some(0)).signal, Some(0));
        assert_eq!(exit_event(1, None).signal, None);
        assert_eq!(exit_event(2, Some(9)).signal, Some(9));
    }

    #[test]
    fn the_spawn_error_names_the_adapter_and_hides_the_cause_from_the_message() {
        let error = spawn_error("/bin/nope", SpawnCause::error("posix_spawnp failed."));
        assert_eq!(
            error.message(),
            "Failed to spawn PTY process '/bin/nope' with node-pty."
        );
        assert!(crate::spawn::is_retryable_shell_spawn_error(&error));
        // A bare object arrives, is wrapped, and says nothing the predicate can use.
        let opaque = spawn_error(
            "/bin/nope",
            SpawnCause::Nested {
                message: None,
                cause: None,
            },
        );
        assert!(!crate::spawn::is_retryable_shell_spawn_error(&opaque));
    }
}
