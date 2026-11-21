//! Who publishes, who removes and who logs when a terminal's history changes hands.
//!
//! Ported from `closeSession`, `clear`, `restartResolved` and the `close` entry point of
//! `apps/server/src/terminal/Manager.ts`, together with the two `logWarning` sites that give
//! [`DeleteFailure`] an owner, and from the session state the same file keeps beside its output: the
//! four statuses, what an exit leaves behind, and the ceiling on inactive sessions.
//!
//! Spawning, process control and thread locks stay with the caller: this module fixes the order in
//! which history is written, published and removed, what a failed removal turns into, and which
//! sessions a caller can still find after a transition. What a client ends up hearing of those
//! transitions is [`crate::stream`].

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use lmcs_terminal_history::{DeleteFailure, delete_history, delete_thread_history};

use crate::persisted::PersistedOutput;

/// The shipped `Effect.logWarning` text when one terminal's history survives a removal.
pub const TERMINAL_DELETE_WARNING: &str = "failed to delete terminal history";
/// The shipped text when one file of a thread sweep survives.
pub const THREAD_DELETE_WARNING: &str = "failed to delete terminal histories for thread";

/// A lifecycle event the shipped manager hands to `publishEvent`. Output events belong to the
/// session's own drain, so they are not here; everything published around a transition is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Started {
        terminal_id: String,
        sequence: u64,
        pid: u32,
    },
    Exited {
        terminal_id: String,
        sequence: u64,
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
    },
    /// `startSession`'s failure path, whose shipped event carries the spawn message and nothing else.
    Error {
        terminal_id: String,
        sequence: u64,
        message: String,
    },
    Cleared {
        terminal_id: String,
        sequence: u64,
    },
    Restarted {
        terminal_id: String,
        sequence: u64,
    },
    Closed {
        terminal_id: String,
        sequence: u64,
    },
}

impl Event {
    #[must_use]
    pub fn terminal_id(&self) -> &str {
        match self {
            Self::Started { terminal_id, .. }
            | Self::Exited { terminal_id, .. }
            | Self::Error { terminal_id, .. }
            | Self::Cleared { terminal_id, .. }
            | Self::Restarted { terminal_id, .. }
            | Self::Closed { terminal_id, .. } => terminal_id,
        }
    }

    #[must_use]
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Started { sequence, .. }
            | Self::Exited { sequence, .. }
            | Self::Error { sequence, .. }
            | Self::Cleared { sequence, .. }
            | Self::Restarted { sequence, .. }
            | Self::Closed { sequence, .. } => *sequence,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Status {
    /// Registered, no process yet: the shipped `openLocked` writes it before the spawn.
    #[default]
    Starting,
    Running,
    Exited,
    /// The spawn failed, so the record says the terminal exists and nothing is running.
    Error,
}

impl Status {
    /// The wire text the client switches on, from `TerminalSessionStatus`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Error => "error",
        }
    }

    /// `evictInactiveSessionsIfNeeded` (Manager.ts:1949) counts every status but `running`, so a
    /// terminal that never spawned and one whose spawn failed are both collectable.
    #[must_use]
    pub fn is_inactive(self) -> bool {
        self != Self::Running
    }
}

/// What the drain hands the exit handler: the two fields the shipped handler gates on
/// `Number.isInteger` before writing them. A code the child never reported and a signal the platform
/// never raised both stay absent, so a `0` code and a `None` code are different answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Exit {
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
}

/// The viewport a client asks an `open`, `attach`, `restart` or `resize` for. `DEFAULT` is what the
/// shipped defaults (Manager.ts:101-102, `DEFAULT_OPEN_COLS`/`DEFAULT_OPEN_ROWS`) give a call that
/// names no size, and a record keeps its size because one thing reads it back: the equality gate a
/// re-open or an attach runs before it touches the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub cols: u32,
    pub rows: u32,
}

impl Size {
    pub const DEFAULT: Self = Self {
        cols: 120,
        rows: 30,
    };
}

/// The size a record starts with when its `open` named none, so `Session::default()` cannot hold a
/// viewport no shipped path ever produces.
impl Default for Size {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// What a call said about the worktree the terminal runs in. `Unnamed` is not "no worktree": a
/// re-`open` that names none keeps the recorded path (Manager.ts:2580-2581) while a create and a
/// `restart` clear it (Manager.ts:2528, :2981). An `Option<String>` cannot tell those apart, and the
/// difference is a history reset or not.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Worktree {
    /// `input.worktreePath === undefined`.
    #[default]
    Unnamed,
    /// `input.worktreePath === null`, which is an input, not an absent one.
    Cleared,
    At(String),
}

/// The launch a call asked for, before the record's own rules apply to it. The environment is the raw
/// input because `normalizedRuntimeEnv` is this crate's job, not its caller's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchAsk {
    pub cwd: String,
    pub worktree: Worktree,
    pub env: Option<Vec<(String, String)>>,
}

/// The launch a record remembers (Manager.ts:341-347's `cwd`, `worktreePath`, `runtimeEnv`). Two
/// records of the same terminal id are different terminals when these differ, which is what the
/// re-`open` comparison in [`Terminals::reopen`] is about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Launch {
    pub cwd: String,
    pub worktree_path: Option<String>,
    /// Already normalized, so an empty environment and no environment are the one record they are
    /// measured to be.
    pub runtime_env: Option<Vec<(String, String)>>,
}

impl Launch {
    /// The record a create writes (Manager.ts:2527-2547, and identically at :2948-2968): a worktree the
    /// call did not name is no worktree.
    #[must_use]
    pub fn opened(ask: &LaunchAsk) -> Self {
        Self {
            cwd: ask.cwd.clone(),
            worktree_path: match &ask.worktree {
                Worktree::At(path) => Some(path.clone()),
                Worktree::Unnamed | Worktree::Cleared => None,
            },
            runtime_env: crate::normalized_runtime_env(ask.env.clone()),
        }
    }

    /// What a re-`open` would write onto a record that already exists: same two fields, and the
    /// worktree falls back to the recorded one rather than to nothing.
    #[must_use]
    pub fn next_after(&self, ask: &LaunchAsk) -> Self {
        Self {
            cwd: ask.cwd.clone(),
            worktree_path: match &ask.worktree {
                Worktree::Unnamed => self.worktree_path.clone(),
                Worktree::Cleared => None,
                Worktree::At(path) => Some(path.clone()),
            },
            runtime_env: crate::normalized_runtime_env(ask.env.clone()),
        }
    }
}

/// The state the shipped manager keeps beside a session's output that the exit and retention rules
/// read. The display label belongs to spawn and the wire: no exit, retention or fan-out rule reads it.
/// The size is kept because the open and attach gates compare against it, and the launch is kept on
/// [`Entry`] beside it because the re-`open` gate compares against that too.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Session {
    pub status: Status,
    pub pid: Option<u32>,
    /// `Number.isInteger` gates this on the way in (Manager.ts:2043), which `pipe.rs` already
    /// applies, so a non-integer exit code never reaches the field.
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    /// `updatedAt` as the text the shipped sort compares. Text, not a clock, makes the ordering rule
    /// the contract and leaves reading time to the owner.
    pub updated_at: String,
    /// The viewport the process last had, which is what makes a second attach at the same size cost
    /// nothing and a third at the old size cost a resize.
    pub size: Size,
}

/// One table entry: what the session's output is doing, what the manager says about it, and the launch
/// the re-`open` gate compares a new call against. The launch lives here rather than in `Session`
/// because three shipped paths reassign that whole struct and none of them is about the launch.
struct Entry {
    output: PersistedOutput,
    state: Session,
    launch: Launch,
}

/// A metadata view row, in the order the shipped manager hands it to the client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub thread_id: String,
    pub terminal_id: String,
    pub status: Status,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub updated_at: String,
}

/// One `summary` (Manager.ts:373) of a record. The whole-table view and the single-terminal read the
/// metadata stream performs both build their rows here, so a field either one reads cannot be missing
/// from just one of them.
fn row(thread_id: &str, terminal_id: &str, state: &Session) -> Metadata {
    Metadata {
        thread_id: thread_id.to_owned(),
        terminal_id: terminal_id.to_owned(),
        status: state.status,
        pid: state.pid,
        exit_code: state.exit_code,
        exit_signal: state.exit_signal,
        updated_at: state.updated_at.clone(),
    }
}

/// What the table said about a client's write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Write {
    /// A running session with a process, so the caller hands the bytes to the shell. The pid is the
    /// one the failure the caller may come back with has to name.
    Delivered { pid: u32 },
    /// The session already exited: the shipped write returns success and drops the input, which is
    /// what a client typing into a dead terminal gets.
    Swallowed,
}

/// The two failures a write can get, named by the error class the client sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteError {
    /// No record under this key, because it was never opened or retention dropped it.
    Missing,
    /// A record with no live process: `starting` or `error`.
    NotRunning,
}

/// What the table said about a client's resize. Neither silence is an error on the wire, and no
/// outcome publishes an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resize {
    /// No record under this key: the resize raced a close, or names a terminal that never opened.
    Missing,
    /// A record with no live process, so there is nothing to hand the new size to.
    NotRunning,
    /// The size to apply to the process, which is the one step that can fail and reach the client.
    Applied { cols: u32, rows: u32 },
}

/// What the table said about the viewport an `open` or an `attach` asked for. This is the one place
/// the manager compares sizes, and like `resize` no outcome publishes an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Viewport {
    /// No record under this key, so the caller opens one instead of attaching to it.
    Missing,
    /// A record with no live process. `openLocked` (Manager.ts:2611) starts one, which is the branch
    /// this port leaves to its caller; the stream path (Manager.ts:2684) skips the gate and answers
    /// with a snapshot of a dead terminal.
    NotRunning,
    /// The record already has this viewport, so nothing reaches the process and no stamp moves. The
    /// reason a second client watching the same terminal does not reorder the sessions list.
    Unchanged,
    /// The size to hand the process. The record already remembers it and carries the new stamp.
    Applied(Size),
}

/// What the table said about an `open` of a terminal it already has (Manager.ts:2574-2607). The two
/// resetting outcomes differ in what the caller owes the process: a `Stopped` pid has to be killed and
/// unsubscribed, a `Reset` has nothing to kill.
///
/// Both have already dropped the retained screen and written the empty file. Neither publishes an
/// event or takes a sequence, and only `Stopped` stamps the record: measured on
/// `cwd-change-publishes-no-cleared` the sequence goes 1 to 3 across a reset that owns the 2 for
/// nobody, and on `exited-branch-kills-nothing` the same reset leaves the stamp where it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reopen {
    /// No record under this key, so the caller creates one.
    Missing,
    /// Same launch and a live process, so the retained screen survives. The one quiet outcome.
    Kept,
    /// A different launch, and the process that was running under the old one. The record is now
    /// `exited` and stamped, as `stopProcess` leaves it.
    Stopped { pid: u32 },
    /// History was thrown away and nobody was killed: either a different launch with no process, or
    /// the same launch on a record that had already exited or failed to start.
    Reset,
}

impl WriteError {
    /// The shipped error class name, which the wire protocol and the trace rows both use.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "TerminalSessionLookupError",
            Self::NotRunning => "TerminalNotRunningError",
        }
    }
}

/// One `logWarning` call: the message, the fields in the order the shipped object literal builds
/// them, and the cause rendered the way the platform error prints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    pub message: &'static str,
    pub thread_id: String,
    /// Absent from the sweep warning, present in the single-terminal one.
    pub terminal_id: Option<String>,
    pub error: String,
}

impl Warning {
    /// The log fields, in the order the shipped calls build them.
    #[must_use]
    pub fn fields(&self) -> Vec<(&'static str, String)> {
        let mut fields = vec![("threadId", self.thread_id.clone())];
        if let Some(terminal_id) = &self.terminal_id {
            fields.push(("terminalId", terminal_id.clone()));
        }
        fields.push(("error", self.error.clone()));
        fields
    }
}

/// `PlatformError` as the shipped logs render it: the reason Effect names, then the operation that
/// failed. A removal is the only operation that can fail here, and `NotFound` never reaches a
/// warning because the shipped call is `force: true`.
///
/// One measured divergence: the directory a sweep matched prints `PlatformError/Unknown/remove`
/// through Node, while an unlink of a directory reports `EPERM`, so the port prints
/// `PermissionDenied`. The message and fields are the log contract; the cause string is not.
///
/// Measured on Linux too, and there the two agree for a different reason: `unlink` of a directory
/// reports `EISDIR` rather than `EPERM`, and Rust leaves that as `IsADirectory` instead of folding
/// it into `PermissionDenied`, so the port falls through to `Unknown` the way Node does. The Linux
/// probe of `rm` on a directory reports `ERR_FS_EISDIR` and `EPERM` has no case either, so the
/// shipped string is `Unknown` on both hosts while the syscall underneath differs.
pub(crate) fn render_cause(cause: &io::Error, method: &str) -> String {
    let reason = match cause.kind() {
        io::ErrorKind::NotFound => "NotFound",
        io::ErrorKind::PermissionDenied => "PermissionDenied",
        io::ErrorKind::AlreadyExists => "AlreadyExists",
        _ => "Unknown",
    };
    format!("PlatformError/{reason}/{method}")
}

fn render(cause: &DeleteFailure) -> String {
    render_cause(&cause.cause, "remove")
}

fn terminal_warning(thread_id: &str, terminal_id: &str, cause: &DeleteFailure) -> Warning {
    Warning {
        message: TERMINAL_DELETE_WARNING,
        thread_id: thread_id.to_owned(),
        terminal_id: Some(terminal_id.to_owned()),
        error: render(cause),
    }
}

fn thread_warning(thread_id: &str, cause: &DeleteFailure) -> Warning {
    Warning {
        message: THREAD_DELETE_WARNING,
        thread_id: thread_id.to_owned(),
        terminal_id: None,
        error: render(cause),
    }
}

/// The live sessions of every thread, in registration order.
///
/// The shipped manager keeps a `Map` keyed by `thread\{NUL}terminal`, and a thread close walks that
/// map in insertion order. A `HashMap` has no such order, so the sequence is kept beside it instead
/// of being left to the hasher.
/// `DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS` (Manager.ts:100).
pub const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS: usize = 128;

pub struct Terminals {
    logs_dir: PathBuf,
    sessions: HashMap<(String, String), Entry>,
    order: Vec<(String, String)>,
    max_retained_inactive: usize,
    evicted: Vec<(String, String)>,
}

impl Default for Terminals {
    fn default() -> Self {
        Self {
            logs_dir: PathBuf::new(),
            sessions: HashMap::new(),
            order: Vec::new(),
            max_retained_inactive: DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS,
            evicted: Vec::new(),
        }
    }
}

impl Terminals {
    #[must_use]
    pub fn new(logs_dir: &Path) -> Self {
        Self {
            logs_dir: logs_dir.to_path_buf(),
            ..Self::default()
        }
    }

    /// `makeWithOptions({ maxRetainedInactiveSessions })`, the ceiling the shipped manager reads from
    /// its options. A test lowers it to watch retention act.
    #[must_use]
    pub fn with_retention(logs_dir: &Path, max_retained_inactive: usize) -> Self {
        Self {
            logs_dir: logs_dir.to_path_buf(),
            max_retained_inactive,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn retention(&self) -> usize {
        self.max_retained_inactive
    }

    /// Keys retention dropped, oldest first, since the last [`Self::take_evictions`].
    #[must_use]
    pub fn evictions(&self) -> &[(String, String)] {
        &self.evicted
    }

    pub fn take_evictions(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.evicted)
    }

    /// Registers a session as `starting` stamped `at`, replacing any live one under the same key, and
    /// runs the retention pass `openLocked` calls right after inserting (Manager.ts:2557). `requested`
    /// is the call's own size, which the shipped record falls back to `DEFAULT_OPEN_COLS`/`_ROWS` for.
    /// `ask` is what the call named as its launch, which the new record takes the resolved form of.
    pub fn insert(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        output: PersistedOutput,
        requested: Option<Size>,
        ask: &LaunchAsk,
        at: &str,
    ) -> Option<PersistedOutput> {
        let key = (thread_id.to_owned(), terminal_id.to_owned());
        if !self.sessions.contains_key(&key) {
            self.order.push(key.clone());
        }
        let replaced = self.sessions.insert(
            key,
            Entry {
                output,
                launch: Launch::opened(ask),
                state: Session {
                    status: Status::Starting,
                    updated_at: at.to_owned(),
                    size: requested.unwrap_or_default(),
                    ..Session::default()
                },
            },
        );
        self.evict();
        replaced.map(|entry| entry.output)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// The live session of one terminal, which is where its owner writes output and reads history.
    pub fn session(&mut self, thread_id: &str, terminal_id: &str) -> Option<&mut PersistedOutput> {
        self.sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
            .map(|entry| &mut entry.output)
    }

    /// What the manager says about a live session, which is the `snapshot` payload the shipped
    /// `started`, `exited` and `restarted` events carry.
    #[must_use]
    pub fn state(&self, thread_id: &str, terminal_id: &str) -> Option<&Session> {
        self.sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))
            .map(|entry| &entry.state)
    }

    /// `startSession`'s success path: the process is live, so the session leaves retention's count.
    /// The sequence is the pipe's, which is why the transition owns the `output.start` call.
    ///
    /// `requested` is the size the shipped call writes onto the record before it spawns
    /// (Manager.ts:2196), so a start that never ran keeps the viewport its caller asked for. `None`
    /// means the call named none, which the shipped code reads as the record's own size.
    ///
    /// A record retention already dropped has nothing to mark. That is where this port parts ways with
    /// the shipped manager, which goes on mutating the detached object and publishes `started` for it:
    /// measured on `cap-zero-open`, a ceiling of `0` evicts the session `open` is creating and the
    /// client is still told it is running. That ceiling needs fewer slots than concurrent opens, so
    /// the port lets the caller's record end rather than keep an ownerless process alive.
    pub fn mark_running(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        requested: Option<Size>,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> Option<u64> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        let sequence = entry.output.start(pid);
        let remembered = entry.state.size;
        entry.state = Session {
            status: Status::Running,
            pid: Some(pid),
            // Measured in `restart-after-exit`: a session that ran, exited and started again reports no
            // exit state, because the shipped start writes these fields rather than keeping them.
            exit_code: None,
            exit_signal: None,
            updated_at: at.to_owned(),
            size: requested.unwrap_or(remembered),
        };
        publish(&Event::Started {
            terminal_id: terminal_id.to_owned(),
            sequence,
            pid,
        });
        Some(sequence)
    }

    /// `startSession`'s failure path (Manager.ts:2272): the handles are cleaned and the sequence
    /// advances, and nothing is written, because a spawn that never ran has no history to keep.
    /// Retention runs *before* the publication (Manager.ts:2290), so a record the ceiling takes still
    /// publishes its `error`.
    pub fn mark_error(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        message: &str,
        requested: Option<Size>,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> Option<u64> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        let sequence = entry.output.fail_start();
        let remembered = entry.state.size;
        entry.state = Session {
            status: Status::Error,
            updated_at: at.to_owned(),
            size: requested.unwrap_or(remembered),
            ..Session::default()
        };
        self.evict();
        publish(&Event::Error {
            terminal_id: terminal_id.to_owned(),
            sequence,
            message: message.to_owned(),
        });
        Some(sequence)
    }

    /// The exit handler (Manager.ts:2027). The record stays and keeps the exit it saw, loses its
    /// process, and publishes `exited` with the sequence the drain handed over. Retention runs last, so
    /// what just exited is in the count the ceiling sorts against.
    pub fn exit(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        sequence: u64,
        exit: Exit,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> Option<Session> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        entry.state.status = Status::Exited;
        entry.state.pid = None;
        entry.state.exit_code = exit.exit_code;
        entry.state.exit_signal = exit.exit_signal;
        entry.state.updated_at = at.to_owned();
        let state = entry.state.clone();
        publish(&Event::Exited {
            terminal_id: terminal_id.to_owned(),
            sequence,
            exit_code: state.exit_code,
            exit_signal: state.exit_signal,
        });
        self.evict();
        Some(state)
    }

    /// `write`'s decision (Manager.ts:2869), which is the only thing the session table has to say
    /// about a client's bytes. Notably it does not stamp `updatedAt`, so typing in a terminal does not
    /// protect it from retention; the trace's `write-after-exit` row is the measurement.
    pub fn write(&self, thread_id: &str, terminal_id: &str) -> Result<Write, WriteError> {
        let state = &self
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))
            .ok_or(WriteError::Missing)?
            .state;
        if state.status == Status::Exited {
            return Ok(Write::Swallowed);
        }
        if let (Status::Running, Some(pid)) = (state.status, state.pid) {
            return Ok(Write::Delivered { pid });
        }
        Err(WriteError::NotRunning)
    }

    /// The `updatedAt` half of `advanceEventSequence` (Manager.ts:434) for the one event whose
    /// sequence the drain owns instead of this module: `output`. The stamp is what makes a terminal
    /// that is producing text survive retention, and measured on `exit-basic` the output stamp is the
    /// value the next metadata view reports.
    ///
    /// A record retention already dropped has nothing to refresh, which is the same answer the
    /// shipped module gives once its detached object stops being in the map.
    pub fn touch(&mut self, thread_id: &str, terminal_id: &str, at: &str) -> Option<&Session> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        entry.state.updated_at = at.to_owned();
        Some(&entry.state)
    }

    /// `resizeLocked` (Manager.ts:2892): the other mutation that stamps a session without publishing,
    /// and the reason a metadata view can go stale on screen — a client that only resizes is not
    /// announced, so its row moves in the list without any subscriber being told.
    ///
    /// Both early returns are silent in the shipped call, because `ResizeObserver` traffic is already
    /// in flight when a terminal closes or has yet to spawn. The size is handed back for the caller to
    /// apply to the process, which is where `TerminalResizeError` comes from, and the record keeps it,
    /// which is what the next attach's gate compares against.
    ///
    /// This call has no equality gate of its own: the shipped one resizes and stamps even when the
    /// viewport is the one the terminal already had, unlike `viewport` below.
    pub fn resize(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        cols: u32,
        rows: u32,
        at: &str,
    ) -> Resize {
        let asked = match self
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))
        {
            None => Resize::Missing,
            Some(entry)
                if entry.state.status != Status::Running || entry.state.pid.is_none() =>
            {
                Resize::NotRunning
            }
            Some(_) => Resize::Applied { cols, rows },
        };
        if let Resize::Applied { cols, rows } = asked {
            self.resize_apply(thread_id, terminal_id, cols, rows, at);
        }
        asked
    }

    /// `resizeLocked`'s read half (Manager.ts:2892-2899): the pid whose process the new size belongs
    /// to, or `None` for either of the two silent answers. The seam needs the split because the shipped
    /// call runs the library **before** it writes the size, so a library call that throws leaves both
    /// the viewport and the stamp where they were — measured on `resize-throws`, where the follow-up
    /// open at the thrown size still crosses its gate and resizes.
    #[must_use]
    pub fn resize_ask(&self, thread_id: &str, terminal_id: &str) -> Option<u32> {
        let state = &self
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))?
            .state;
        match (state.status, state.pid) {
            (Status::Running, Some(pid)) => Some(pid),
            _ => None,
        }
    }

    /// The two writes `resizeLocked` makes once the process has accepted the new size.
    pub fn resize_apply(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        cols: u32,
        rows: u32,
        at: &str,
    ) {
        if let Some(entry) =
            self.sessions.get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
        {
            entry.state.size = Size { cols, rows };
            entry.state.updated_at = at.to_owned();
        }
    }

    /// The size check an `open` of a live terminal (Manager.ts:2626) and an `attach`
    /// (Manager.ts:2684) run before either touches the process. Measured on
    /// `attach-of-a-running-terminal-keeps-its-size` a matching viewport costs no pty call and leaves
    /// the stamp the sessions list sorts on exactly where it was, and on
    /// `attach-sizes-are-remembered-between-clients` the size a *previous client* asked for is the one
    /// compared, so a third client asking for the original viewport resizes again.
    ///
    /// The two shipped sites key on slightly different things — `openLocked` on `process` alone, after
    /// its own branch that starts a session when there is none, and the stream path on
    /// `process && status === "running"` — which agree here because a record only carries a pid while
    /// it runs.
    pub fn viewport(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        requested: Size,
        at: &str,
    ) -> Viewport {
        let Some(entry) = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
        else {
            return Viewport::Missing;
        };
        if entry.state.status != Status::Running || entry.state.pid.is_none() {
            return Viewport::NotRunning;
        }
        if entry.state.size == requested {
            return Viewport::Unchanged;
        }
        entry.state.size = requested;
        entry.state.updated_at = at.to_owned();
        Viewport::Applied(requested)
    }

    /// The other half of re-`open`ing a terminal that already has a record: the launch comparison
    /// (Manager.ts:2575-2607) that runs before either the size gate or the spawn. A launch change stops
    /// the process and throws the retained screen away; an unchanged launch on a record that had
    /// already exited or failed throws the screen away without a process to stop.
    ///
    /// Three of the four outcomes clear history and write the empty file, and none of them takes a
    /// sequence or publishes, which is why the caller's `started` is the next number the record owns.
    /// The write is what a later reader sees: without it, reopening a terminal at a new directory
    /// shows the screen the killed shell left on disk.
    ///
    /// A stopped process is the caller's to kill, unsubscribe and hand to the escalation timer, and
    /// retention runs the way `stopProcess` runs it — after the record has gone inactive.
    pub fn reopen(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        ask: &LaunchAsk,
        at: &str,
    ) -> io::Result<Reopen> {
        let key = (thread_id.to_owned(), terminal_id.to_owned());
        let Some(entry) = self.sessions.get_mut(&key) else {
            return Ok(Reopen::Missing);
        };
        let next = entry.launch.next_after(ask);
        let changed = next != entry.launch;
        entry.launch = next;

        let mut stopped = None;
        let outcome = if changed {
            match entry.state.pid.take() {
                Some(pid) => {
                    // `stopProcess`: the record goes inactive with no event of its own, and this is the
                    // one reset that stamps it. `exitCode`/`exitSignal` are left alone because the
                    // shipped call does not touch them, and a running record has none.
                    entry.state.status = Status::Exited;
                    entry.state.updated_at = at.to_owned();
                    entry.output.stop();
                    stopped = Some(pid);
                    Reopen::Stopped { pid }
                }
                None => Reopen::Reset,
            }
        } else if matches!(entry.state.status, Status::Exited | Status::Error) {
            Reopen::Reset
        } else {
            Reopen::Kept
        };

        if outcome != Reopen::Kept {
            entry.output.reset_history()?;
        }
        if let Some(pid) = stopped {
            self.evict();
            return Ok(Reopen::Stopped { pid });
        }
        Ok(outcome)
    }

    /// The launch the record remembers, which is the row the re-`open` gate compares against and the
    /// only way to see the absent-worktree rule from outside the table.
    #[must_use]
    pub fn launch(&self, thread_id: &str, terminal_id: &str) -> Option<&Launch> {
        self.sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))
            .map(|entry| &entry.launch)
    }

    /// `readTerminalMetadata` (Manager.ts:2714): one row of the sessions view, which is what the
    /// metadata stream turns into an `upsert` when it handles an event. A terminal retention dropped,
    /// or one that never existed, answers `None` and the client gets no frame.
    #[must_use]
    pub fn metadata(&self, thread_id: &str, terminal_id: &str) -> Option<Metadata> {
        let state = &self
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))?
            .state;
        Some(row(thread_id, terminal_id, state))
    }

    /// `evictInactiveSessionsIfNeeded` (Manager.ts:1949). Inactive records are sorted oldest stamp
    /// first, then by thread id and terminal id, and everything past the ceiling is dropped. Table
    /// entries only: no history file is touched and no event is published, which is why a client still
    /// holding a dropped terminal gets lookup failures.
    ///
    /// The shipped sort calls `localeCompare`. Measured against Node's default locale it agrees with
    /// the ordinal order used here for every id this table can hold and for ISO stamps; the trace's `K`
    /// rows record where the two disagree in general.
    fn evict(&mut self) {
        let mut inactive: Vec<((String, String), String)> = self
            .order
            .iter()
            .filter_map(|key| {
                let state = &self.sessions.get(key)?.state;
                if state.status.is_inactive() {
                    Some((key.clone(), state.updated_at.clone()))
                } else {
                    None
                }
            })
            .collect();
        if inactive.len() <= self.max_retained_inactive {
            return;
        }
        let drop = inactive.len() - self.max_retained_inactive;
        inactive.sort_by(|(left_key, left_stamp), (right_key, right_stamp)| {
            left_stamp
                .cmp(right_stamp)
                .then_with(|| left_key.cmp(right_key))
        });
        for key in inactive.into_iter().take(drop).map(|(key, _)| key) {
            self.sessions.remove(&key);
            self.order.retain(|existing| existing != &key);
            self.evicted.push(key);
        }
    }

    /// `readAllTerminalMetadata` (Manager.ts:2700): every live session, newest stamp first, ids
    /// ascending to break a tie. This is the `snapshot` frame of the metadata stream and the only
    /// outside view of retention.
    #[must_use]
    pub fn view(&self) -> Vec<Metadata> {
        let mut rows: Vec<(&(String, String), &Entry)> = self
            .order
            .iter()
            .filter_map(|key| self.sessions.get(key).map(|entry| (key, entry)))
            .collect();
        rows.sort_by(|(left_key, left), (right_key, right)| {
            right
                .state
                .updated_at
                .cmp(&left.state.updated_at)
                .then_with(|| left_key.cmp(right_key))
        });
        rows.into_iter()
            .map(|((thread_id, terminal_id), entry)| row(thread_id, terminal_id, &entry.state))
            .collect()
    }

    /// `clear`: drop history and persist it, stamp the session, then publish. A write that fails is
    /// the caller's error, and the shipped generator stops there, so nothing is published. The stamp
    /// (Manager.ts:2693) is what makes a cleared session the newest inactive one, so retention sees it.
    pub fn clear(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<()> {
        let entry = self.require_mut(thread_id, terminal_id)?;
        let sequence = entry.output.clear()?;
        entry.state.updated_at = at.to_owned();
        publish(&Event::Cleared {
            terminal_id: terminal_id.to_owned(),
            sequence,
        });
        Ok(())
    }

    /// The shipped restart, which is `startSession` with the event type set to `restarted`: the old
    /// process is stopped, history is cleared and persisted, and the record comes back running on the
    /// new pid — one event, not a `restarted` followed by a `started` (measured on
    /// `restart-after-exit`). Retention runs on the same site as Manager.ts:2976, after the record is
    /// live again, so a restarted terminal is never the one the ceiling takes.
    ///
    /// The launch is rewritten even though a restart always resets (Manager.ts:2980-2982), and it takes
    /// the create path's resolution: a restart that names no worktree clears the recorded one, which is
    /// the opposite of what a re-`open` does.
    ///
    /// The one transition that names both a new process and a new launch, so it carries the whole
    /// shipped input: the viewport for the shell, the launch to rewrite, and the stamp. Grouping any of
    /// them into a struct would serve the lint rather than the call.
    #[allow(clippy::too_many_arguments)]
    pub fn restart(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        requested: Option<Size>,
        ask: &LaunchAsk,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<()> {
        let entry = self.require_mut(thread_id, terminal_id)?;
        let sequence = entry.output.restart(pid)?;
        entry.launch = Launch::opened(ask);
        let remembered = entry.state.size;
        entry.state = Session {
            status: Status::Running,
            pid: Some(pid),
            exit_code: None,
            exit_signal: None,
            updated_at: at.to_owned(),
            // The shipped call is `input.cols ?? session.cols` (Manager.ts:2985), so a restart that
            // names no viewport keeps the one the terminal already had.
            size: requested.unwrap_or(remembered),
        };
        publish(&Event::Restarted {
            terminal_id: terminal_id.to_owned(),
            sequence,
        });
        self.evict();
        Ok(())
    }

    /// `close`.
    ///
    /// With a terminal id, one session closes and history is removed only when the flag is exactly
    /// `true`, because the shipped call is `input.deleteHistory === true`. Without one, every
    /// session of the thread closes with removal forced off, and the sweep runs on truthiness
    /// (`if (input.deleteHistory)`). `packages/core/src/contracts/terminal.ts:93` types the field
    /// as `optional(Boolean)`, so on every value that can reach the shipped call the two readings
    /// agree and `Option<bool>` carries both.
    ///
    /// Removal runs after `closed` is published, and after the persist drain that precedes it: work
    /// still queued for the key would land behind the unlink and put the file back.
    pub fn close(
        &mut self,
        thread_id: &str,
        terminal_id: Option<&str>,
        delete_history: Option<bool>,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<Vec<Warning>> {
        let Some(terminal_id) = terminal_id else {
            for terminal in self.sessions_of(thread_id) {
                // The shipped thread close never removes per session, so it collects no warnings.
                self.close_session(thread_id, &terminal, false, publish)?;
            }
            return Ok(if delete_history.is_some_and(|flag| flag) {
                self.sweep(thread_id)
            } else {
                Vec::new()
            });
        };
        self.close_session(
            thread_id,
            terminal_id,
            delete_history == Some(true),
            publish,
        )
    }

    /// `closeSession`: persist and drain when a session exists, publish only for a session that was
    /// in the table, and remove history last. A close that finds no session still removes.
    fn close_session(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        delete: bool,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<Vec<Warning>> {
        let key = (thread_id.to_owned(), terminal_id.to_owned());
        let sequence = match self.sessions.remove(&key) {
            Some(mut entry) => Some(entry.output.close()?),
            None => None,
        };
        if let Some(sequence) = sequence {
            self.order.retain(|existing| existing != &key);
            publish(&Event::Closed {
                terminal_id: terminal_id.to_owned(),
                sequence,
            });
        }
        if !delete {
            return Ok(Vec::new());
        }
        Ok(delete_history(&self.logs_dir, thread_id, terminal_id)
            .iter()
            .map(|failure| terminal_warning(thread_id, terminal_id, failure))
            .collect())
    }

    /// `deleteAllHistoryForThread`, whose failures carry no terminal id because the sweep matched
    /// file names, not sessions.
    fn sweep(&mut self, thread_id: &str) -> Vec<Warning> {
        delete_thread_history(&self.logs_dir, thread_id)
            .iter()
            .map(|failure| thread_warning(thread_id, failure))
            .collect()
    }

    fn sessions_of(&self, thread_id: &str) -> Vec<String> {
        self.order
            .iter()
            .filter(|(thread, _)| thread == thread_id)
            .map(|(_, terminal)| terminal.clone())
            .collect()
    }

    fn require_mut(&mut self, thread_id: &str, terminal_id: &str) -> io::Result<&mut Entry> {
        self.sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no such terminal session"))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Mutex};

    use lmcs_terminal_history::{
        BoundedHistory, DEFAULT_TERMINAL_ID, HistoryPersistence, PersistHandle, UNLIMITED_BYTES,
        history_path, legacy_history_path,
    };

    use super::*;
    use crate::node_pty::exit_event;
    use crate::output::TerminalOutput;
    use crate::{Delivery, PendingEvent};

    struct Logs {
        dir: PathBuf,
        worker: Option<HistoryPersistence>,
    }

    impl Logs {
        fn start(case: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lmcs-lifecycle-{}-{case}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self::open(dir)
        }

        /// A directory path that does not exist, which is what the shipped sweep sees when the
        /// logs directory was never created.
        fn absent(case: &str) -> Self {
            Self {
                dir: std::env::temp_dir().join(format!(
                    "lmcs-lifecycle-{}-{case}-absent",
                    std::process::id()
                )),
                worker: None,
            }
        }

        fn open(dir: PathBuf) -> Self {
            let worker = HistoryPersistence::start(dir.clone(), drop).unwrap();
            Self {
                dir,
                worker: Some(worker),
            }
        }

        fn handle(&self) -> PersistHandle {
            self.worker.as_ref().unwrap().handle()
        }

        fn session(&self, thread_id: &str, terminal_id: &str, restored: &[u8]) -> PersistedOutput {
            PersistedOutput::new(
                TerminalOutput::new(BoundedHistory::with_limits(
                    5_000,
                    UNLIMITED_BYTES,
                    restored,
                )),
                self.handle(),
                &self.dir,
                thread_id,
                terminal_id,
            )
        }

        fn current(&self, thread_id: &str, terminal_id: &str) -> PathBuf {
            history_path(&self.dir, thread_id, terminal_id)
        }

        fn legacy(&self, thread_id: &str) -> PathBuf {
            legacy_history_path(&self.dir, thread_id)
        }

        fn seed(&self, path: &Path, content: &str) {
            if path.is_dir() {
                return;
            }
            fs::write(path, content).unwrap();
        }

        /// An unlink cannot win against this host, so the removal really fails.
        fn seed_undeletable(&self, path: &Path) {
            fs::create_dir(path).unwrap();
        }

        fn exists(&self, path: &Path) -> bool {
            path.symlink_metadata().is_ok()
        }
    }

    impl Drop for Logs {
        fn drop(&mut self) {
            if let Some(mut worker) = self.worker.take() {
                let _ = worker.stop();
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// What the publisher saw: the event, and which history files were still on disk at that
    /// moment. Reading the disk inside the callback is what makes a removal that jumped the
    /// publication observable.
    type Seen = Vec<(String, u64, Vec<bool>)>;

    #[derive(Clone)]
    struct Published(Arc<Mutex<Seen>>);

    impl Published {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(Vec::new())))
        }

        fn watch(&self, logs: &Logs, paths: Vec<PathBuf>) -> impl FnMut(&Event) + use<> {
            let this = self.clone();
            let dir = logs.dir.clone();
            move |event: &Event| {
                let present = paths
                    .iter()
                    .map(|path| dir.join(path).symlink_metadata().is_ok())
                    .collect();
                this.0.lock().unwrap().push((
                    event.terminal_id().to_owned(),
                    event.sequence(),
                    present,
                ));
            }
        }

        fn events(&self) -> Vec<(String, u64)> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(terminal, sequence, _)| (terminal.clone(), *sequence))
                .collect()
        }

        fn sightings(&self) -> Vec<Vec<bool>> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(_, _, present)| present.clone())
                .collect()
        }
    }

    fn terminals(logs: &Logs) -> Terminals {
        Terminals::new(&logs.dir)
    }

    #[test]
    fn closed_is_published_while_the_history_files_are_still_on_disk() {
        let logs = Logs::start("publish-before-remove");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let legacy = logs.legacy("thread-1");
        logs.seed(&current, "stale-current\n");
        logs.seed(&legacy, "legacy\n");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"live\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone(), legacy.clone()]);
        assert_eq!(
            terminals
                .close(
                    "thread-1",
                    Some(DEFAULT_TERMINAL_ID),
                    Some(true),
                    &mut watch
                )
                .unwrap(),
            Vec::new()
        );
        assert_eq!(published.events(), vec![("term-1".to_owned(), 1)]);
        assert_eq!(
            published.sightings(),
            vec![vec![true, true]],
            "the shipped close removes after it publishes"
        );
        assert!(!logs.exists(&current) && !logs.exists(&legacy));
    }

    #[test]
    fn a_close_without_a_session_publishes_nothing_and_still_removes() {
        let logs = Logs::start("never-opened");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let legacy = logs.legacy("thread-1");
        logs.seed(&current, "from-a-previous-run\n");
        logs.seed(&legacy, "legacy\n");
        let mut terminals = terminals(&logs);
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone(), legacy.clone()]);
        assert_eq!(
            terminals
                .close(
                    "thread-1",
                    Some(DEFAULT_TERMINAL_ID),
                    Some(true),
                    &mut watch
                )
                .unwrap(),
            Vec::new()
        );
        assert_eq!(published.events(), Vec::<(String, u64)>::new());
        assert!(!logs.exists(&current) && !logs.exists(&legacy));
    }

    #[test]
    fn only_true_removes_on_the_terminal_path() {
        for flag in [None, Some(false)] {
            let logs = Logs::start(&format!("flag-{flag:?}"));
            let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
            let legacy = logs.legacy("thread-1");
            logs.seed(&current, "keep\n");
            logs.seed(&legacy, "keep\n");
            let mut terminals = terminals(&logs);
            terminals.insert(
                "thread-1",
                DEFAULT_TERMINAL_ID,
                logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
                None,
                &LaunchAsk::default(),
                "t0",
            );
            let published = Published::new();
            let mut watch = published.watch(&logs, vec![current.clone(), legacy.clone()]);
            terminals
                .close("thread-1", Some(DEFAULT_TERMINAL_ID), flag, &mut watch)
                .unwrap();
            assert_eq!(published.events(), vec![("term-1".to_owned(), 1)]);
            assert!(
                logs.exists(&current) && logs.exists(&legacy),
                "{flag:?} never removes history"
            );
            assert_eq!(fs::read(&current).unwrap(), b"keep\n");
        }
    }

    #[test]
    fn a_secondary_close_leaves_the_default_and_the_legacy_file() {
        let logs = Logs::start("secondary");
        let secondary = logs.current("thread-1", "term-2");
        let default = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let legacy = logs.legacy("thread-1");
        for path in [&secondary, &default, &legacy] {
            logs.seed(path, "keep\n");
        }
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"mine\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![secondary.clone()]);
        assert_eq!(
            terminals
                .close("thread-1", Some("term-2"), Some(true), &mut watch)
                .unwrap(),
            Vec::new()
        );
        assert!(!logs.exists(&secondary));
        assert!(
            logs.exists(&default) && logs.exists(&legacy),
            "a secondary terminal never touches the default or legacy name"
        );
    }

    #[test]
    fn a_thread_close_publishes_each_session_before_the_sweep() {
        let logs = Logs::start("thread-sweep");
        let host_a = logs.current("thread-1", "term-2");
        let host_b = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let other = logs.current("thread-2", DEFAULT_TERMINAL_ID);
        for path in [&host_a, &host_b, &other] {
            logs.seed(path, "keep\n");
        }
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"a\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"b\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        terminals.insert(
            "thread-2",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-2", DEFAULT_TERMINAL_ID, b"c\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![host_a.clone(), host_b.clone()]);
        assert_eq!(
            terminals
                .close("thread-1", None, Some(true), &mut watch)
                .unwrap(),
            Vec::new()
        );
        assert_eq!(
            published.events(),
            vec![("term-2".to_owned(), 1), ("term-1".to_owned(), 1)],
            "registration order, not sorted order"
        );
        assert_eq!(
            published.sightings(),
            vec![vec![true, true], vec![true, true]],
            "every publication sees both files: the sweep removes after the last one"
        );
        assert!(!logs.exists(&host_a) && !logs.exists(&host_b));
        assert!(logs.exists(&other), "another thread's history survives");
    }

    #[test]
    fn a_thread_close_with_the_flag_off_closes_sessions_and_keeps_files() {
        for flag in [None, Some(false)] {
            let logs = Logs::start(&format!("thread-no-delete-{flag:?}"));
            let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
            let legacy = logs.legacy("thread-1");
            for path in [&current, &legacy] {
                logs.seed(path, "keep\n");
            }
            let mut terminals = terminals(&logs);
            terminals.insert(
                "thread-1",
                DEFAULT_TERMINAL_ID,
                logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
                None,
                &LaunchAsk::default(),
                "t0",
            );
            let published = Published::new();
            let mut watch = published.watch(&logs, vec![current.clone()]);
            assert_eq!(
                terminals.close("thread-1", None, flag, &mut watch).unwrap(),
                Vec::new()
            );
            assert_eq!(published.events(), vec![("term-1".to_owned(), 1)]);
            assert!(
                logs.exists(&current) && logs.exists(&legacy),
                "{flag:?} never sweeps, so even the legacy name survives"
            );
        }
    }

    #[test]
    fn a_removal_that_cannot_win_becomes_one_warning_with_the_shipped_fields() {
        let logs = Logs::start("legacy-undeletable");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let legacy = logs.legacy("thread-1");
        logs.seed(&current, "written\n");
        logs.seed_undeletable(&legacy);
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"written\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        let warnings = terminals
            .close(
                "thread-1",
                Some(DEFAULT_TERMINAL_ID),
                Some(true),
                &mut watch,
            )
            .unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].message, TERMINAL_DELETE_WARNING);
        assert_eq!(
            warnings[0].fields(),
            vec![
                ("threadId", "thread-1".to_owned()),
                ("terminalId", DEFAULT_TERMINAL_ID.to_owned()),
                ("error", warnings[0].error.clone()),
            ]
        );
        assert_eq!(
            warnings[0].terminal_id.as_deref(),
            Some(DEFAULT_TERMINAL_ID)
        );
        // The undeletable legacy entry is a directory, and an unlink of a directory refuses with a
        // different errno per host: EPERM here, which `ErrorKind` spells PermissionDenied, and EISDIR
        // on Linux, which it leaves as IsADirectory and `render` reports as Unknown. See `render`.
        #[cfg(target_os = "macos")]
        assert_eq!(warnings[0].error, "PlatformError/PermissionDenied/remove");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(warnings[0].error, "PlatformError/Unknown/remove");
        assert!(!logs.exists(&current), "the file that could go, went");
    }

    #[test]
    fn a_sweep_warning_carries_no_terminal_id_and_the_other_files_still_go() {
        let logs = Logs::start("sweep-undeletable");
        let blocked = logs.current("thread-1", "term-9");
        let removable = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        logs.seed(&removable, "gone\n");
        logs.seed_undeletable(&blocked);
        let mut terminals = terminals(&logs);
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![]);
        let warnings = terminals
            .close("thread-1", None, Some(true), &mut watch)
            .unwrap();
        assert_eq!(published.events(), Vec::<(String, u64)>::new());
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].message, THREAD_DELETE_WARNING);
        assert_eq!(warnings[0].terminal_id, None);
        assert_eq!(
            warnings[0].fields(),
            vec![
                ("threadId", "thread-1".to_owned()),
                ("error", warnings[0].error.clone())
            ]
        );
        assert!(!logs.exists(&removable));
        assert!(logs.exists(&blocked));
    }

    #[test]
    fn an_unreadable_directory_sweeps_to_nothing_and_warns_of_nothing() {
        let logs = Logs::absent("missing-logs-dir");
        let mut terminals = Terminals::new(&logs.dir);
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![]);
        assert_eq!(
            terminals
                .close("thread-1", None, Some(true), &mut watch)
                .unwrap(),
            Vec::new()
        );
        assert!(!logs.dir.exists(), "a sweep creates no directory");
    }

    #[test]
    fn clear_and_restart_write_before_they_publish() {
        let logs = Logs::start("clear-restart");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"restored\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        terminals
            .clear("thread-1", DEFAULT_TERMINAL_ID, "t0", &mut watch)
            .unwrap();
        assert_eq!(
            fs::read(&current).unwrap(),
            b"",
            "the cleared history reached disk"
        );
        terminals
            .restart(
                "thread-1",
                DEFAULT_TERMINAL_ID,
                42,
                None,
                &LaunchAsk::default(),
                "t0",
                &mut watch,
            )
            .unwrap();
        assert_eq!(
            published.events(),
            vec![("term-1".to_owned(), 1), ("term-1".to_owned(), 2)]
        );
        assert_eq!(fs::read(&current).unwrap(), b"");
        assert_eq!(
            terminals
                .session("thread-1", DEFAULT_TERMINAL_ID)
                .unwrap()
                .queued(),
            0
        );
    }

    #[test]
    fn a_stopped_worker_fails_clear_and_restart_before_either_publishes() {
        let mut logs = Logs::start("stopped-worker-clear");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        logs.seed(&current, "keep\n");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        drop(logs.worker.take());
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        for outcome in [
            terminals.clear("thread-1", DEFAULT_TERMINAL_ID, "t0", &mut watch),
            terminals.restart(
                "thread-1",
                DEFAULT_TERMINAL_ID,
                42,
                None,
                &LaunchAsk::default(),
                "t0",
                &mut watch,
            ),
        ] {
            assert_eq!(
                outcome
                    .expect_err("the shipped generator stops on a failed persist")
                    .kind(),
                io::ErrorKind::BrokenPipe
            );
        }
        assert_eq!(published.events(), Vec::<(String, u64)>::new());
        assert_eq!(
            fs::read(&current).unwrap(),
            b"keep\n",
            "nothing was written"
        );
    }

    #[test]
    fn a_stopped_worker_fails_the_close_before_anything_is_published_or_removed() {
        let mut logs = Logs::start("stopped-worker");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        logs.seed(&current, "keep\n");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        // Stopping the worker is what the immediate paths report as an error.
        drop(logs.worker.take());
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        let failure = terminals
            .close(
                "thread-1",
                Some(DEFAULT_TERMINAL_ID),
                Some(true),
                &mut watch,
            )
            .expect_err("a stopped worker fails the immediate persist");
        assert_eq!(failure.kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(published.events(), Vec::<(String, u64)>::new());
        assert!(logs.exists(&current));
    }

    #[test]
    fn a_replacement_keeps_the_first_registration_slot() {
        let logs = Logs::start("replacement");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"first\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"second\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"reopened\n"),
            None,
            &LaunchAsk::default(),
            "t0",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![]);
        assert_eq!(
            terminals.sessions_of("thread-1"),
            vec!["term-2".to_owned(), "term-1".to_owned()],
            "a replacement reuses the slot its key first took"
        );
        terminals.close("thread-1", None, None, &mut watch).unwrap();
        assert_eq!(
            published.events(),
            vec![("term-2".to_owned(), 1), ("term-1".to_owned(), 1)]
        );
        assert!(terminals.is_empty());
        assert!(
            terminals.sessions_of("thread-1").is_empty(),
            "a close frees the registration slot, not only the session"
        );
    }

    /// Every event a call published, rendered so one assert reads a whole transition.
    fn describe(event: &Event) -> String {
        let number =
            |value: Option<i32>| value.map_or_else(|| "-".to_owned(), |value| value.to_string());
        match event {
            Event::Started {
                terminal_id,
                sequence,
                pid,
            } => format!("started {terminal_id} {sequence} pid {pid}"),
            Event::Exited {
                terminal_id,
                sequence,
                exit_code,
                exit_signal,
            } => format!(
                "exited {terminal_id} {sequence} code {} signal {}",
                number(*exit_code),
                number(*exit_signal)
            ),
            Event::Error {
                terminal_id,
                sequence,
                message,
            } => format!("error {terminal_id} {sequence} {message}"),
            Event::Cleared {
                terminal_id,
                sequence,
            } => format!("cleared {terminal_id} {sequence}"),
            Event::Restarted {
                terminal_id,
                sequence,
            } => format!("restarted {terminal_id} {sequence}"),
            Event::Closed {
                terminal_id,
                sequence,
            } => format!("closed {terminal_id} {sequence}"),
        }
    }

    fn recorder(events: &mut Vec<String>) -> impl FnMut(&Event) {
        move |event: &Event| events.push(describe(event))
    }

    /// The metadata view as `thread/terminal:status`, which is what the retention cases turn on.
    fn rows(terminals: &Terminals) -> Vec<String> {
        terminals
            .view()
            .iter()
            .map(|row| {
                format!(
                    "{}/{}:{}",
                    row.thread_id,
                    row.terminal_id,
                    row.status.as_str()
                )
            })
            .collect()
    }

    /// The sequence a real exit carries: the reader queues the event, the drain numbers it, and the
    /// handler records what that numbering said. Inventing the number here is what makes the *next*
    /// event land one below the shipped one.
    fn drain_exit(
        terminals: &mut Terminals,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        exit_code: i32,
        signal: Option<i32>,
    ) -> (u64, Exit) {
        let output = terminals
            .session(thread_id, terminal_id)
            .expect("a running session is live to drain");
        assert!(output.enqueue(pid, PendingEvent::Exit(exit_event(exit_code, signal))));
        let Delivery::Exit {
            sequence,
            exit_code,
            exit_signal,
        } = output
            .drain_next(pid)
            .expect("the queued exit is the next delivery")
        else {
            panic!("an enqueued exit drains as an exit");
        };
        (
            sequence,
            Exit {
                exit_code,
                exit_signal,
            },
        )
    }

    #[test]
    fn an_exit_keeps_the_record_and_the_exit_it_saw() {
        let logs = Logs::start("exit-state");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals.mark_running(
                "thread-a",
                "term-1",
                7400,
                None,
                "t2",
                &mut recorder(&mut events)
            ),
            Some(1)
        );
        // The drain owns the sequence the exit event reports, so the transition takes it as given.
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-1", 7400, 0, None);
        let state = terminals
            .exit(
                "thread-a",
                "term-1",
                sequence,
                exit,
                "t3",
                &mut recorder(&mut events),
            )
            .unwrap();
        assert_eq!(
            events,
            vec![
                "started term-1 1 pid 7400".to_owned(),
                "exited term-1 2 code 0 signal -".to_owned(),
            ]
        );
        assert_eq!(state.status, Status::Exited);
        assert_eq!(
            state.pid, None,
            "the handler clears the pid the client renders"
        );
        assert_eq!(state.exit_code, Some(0));
        assert_eq!(state.exit_signal, None);
        assert_eq!(
            state.updated_at, "t3",
            "the record the handler hands back is the snapshot the client reads, stamp included"
        );
        assert_eq!(rows(&terminals), vec!["thread-a/term-1:exited".to_owned()]);
        assert_eq!(terminals.view()[0].updated_at, "t3");
    }

    #[test]
    fn a_write_is_answered_by_state_and_only_an_exit_swallows_it() {
        let logs = Logs::start("write-gate");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals.write("thread-a", "term-1"),
            Err(WriteError::NotRunning),
            "a terminal that has not spawned yet is not running"
        );
        terminals.mark_error(
            "thread-a",
            "term-2",
            "failed to spawn",
            None,
            "t2",
            &mut |event| {
                events.push(describe(event));
            },
        );
        assert_eq!(
            terminals.write("thread-a", "term-2"),
            Err(WriteError::NotRunning),
            "a spawn that failed keeps its record, and the record still refuses input"
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t3", &mut |event| {
            events.push(describe(event));
        });
        assert_eq!(
            terminals.write("thread-a", "term-1"),
            Ok(Write::Delivered { pid: 7400 }),
            "the decision carries the pid the write error would name"
        );
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-1", 7400, 3, None);
        terminals.exit("thread-a", "term-1", sequence, exit, "t4", &mut |event| {
            events.push(describe(event))
        });
        assert_eq!(
            terminals.write("thread-a", "term-1"),
            Ok(Write::Swallowed),
            "measured on `write-after-exit`: the write succeeds, the shell sees nothing"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t4",
            "the write does not stamp, so it does not buy the record a place in retention"
        );
        assert_eq!(
            terminals.write("thread-a", "term-9"),
            Err(WriteError::Missing),
            "an unknown key is the lookup failure the client gets"
        );
    }

    #[test]
    fn published_output_refreshes_the_record_a_view_reports() {
        let logs = Logs::start("output-stamp");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        let output = terminals
            .session("thread-a", "term-1")
            .expect("the session is live");
        assert!(output.enqueue(7400, PendingEvent::Data("hello\n".to_owned())));
        let Delivery::Output { sequence, .. } = output
            .drain_next(7400)
            .expect("the queued text is the next delivery")
        else {
            panic!("queued text drains as output");
        };
        assert_eq!(sequence, 2, "started took 1");
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t2"
        );
        terminals.touch("thread-a", "term-1", "t3");
        assert_eq!(
            terminals.view()[0].updated_at,
            "t3",
            "measured on `exit-basic`: the metadata view reports the output stamp, not the start's"
        );
        assert!(
            terminals.touch("thread-a", "term-9", "t4").is_none(),
            "a key the table does not have is not refreshed"
        );
    }

    #[test]
    fn a_restart_reports_one_event_and_forgets_the_exit() {
        let logs = Logs::start("restart-state");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        terminals.mark_running(
            "thread-a",
            "term-1",
            7400,
            None,
            "t2",
            &mut recorder(&mut events),
        );
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-1", 7400, 2, None);
        terminals.exit(
            "thread-a",
            "term-1",
            sequence,
            exit,
            "t3",
            &mut recorder(&mut events),
        );
        terminals
            .restart(
                "thread-a",
                "term-1",
                7401,
                None,
                &LaunchAsk::default(),
                "t4",
                &mut recorder(&mut events),
            )
            .unwrap();
        assert_eq!(
            events,
            vec![
                "started term-1 1 pid 7400".to_owned(),
                "exited term-1 2 code 2 signal -".to_owned(),
                "restarted term-1 3".to_owned(),
            ],
            "the shipped restart is one start with a different event type, not a stop and a start"
        );
        let state = terminals.state("thread-a", "term-1").unwrap();
        assert_eq!(state.status, Status::Running);
        assert_eq!(state.pid, Some(7401));
        assert_eq!(
            (state.exit_code, state.exit_signal),
            (None, None),
            "measured on `restart-after-exit`: the running record reports no exit"
        );
    }

    #[test]
    fn a_failed_spawn_leaves_an_error_record_that_still_publishes_and_clears() {
        let logs = Logs::start("spawn-fails");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals.mark_error(
                "thread-a",
                "term-1",
                "failed to spawn",
                None,
                "t2",
                &mut recorder(&mut events)
            ),
            Some(1)
        );
        let state = terminals.state("thread-a", "term-1").unwrap();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.pid, None);
        assert_eq!(
            events,
            vec!["error term-1 1 failed to spawn".to_owned()],
            "the error event is published after retention, and carries the message alone"
        );
        assert!(
            !logs.exists(&logs.current("thread-a", "term-1")),
            "a spawn that never ran has no history to keep, so the failure writes nothing"
        );
        terminals
            .clear("thread-a", "term-1", "t3", &mut recorder(&mut events))
            .unwrap();
        assert_eq!(
            events[1],
            "cleared term-1 2".to_owned(),
            "an errored record stays clearable, and its sequence follows the error"
        );
        assert_eq!(terminals.view()[0].status, Status::Error);
    }

    #[test]
    fn retention_keeps_the_newest_inactive_sessions() {
        let logs = Logs::start("retention-newest");
        let mut terminals = Terminals::with_retention(&logs.dir, 1);
        let mut events: Vec<String> = Vec::new();
        // The shipped `cap-reversed-ids` schedule: ids open in the opposite order to time.
        for (terminal, pid, stamps) in [
            ("term-3", 7400, ["t1", "t2", "t3"]),
            ("term-2", 7401, ["t4", "t5", "t6"]),
            ("term-1", 7402, ["t7", "t8", "t9"]),
        ] {
            terminals.insert(
                "thread-a",
                terminal,
                logs.session("thread-a", terminal, b""),
                None,
                &LaunchAsk::default(),
                stamps[0],
            );
            terminals.mark_running(
                "thread-a",
                terminal,
                pid,
                None,
                stamps[1],
                &mut recorder(&mut events),
            );
            let (sequence, exit) = drain_exit(&mut terminals, "thread-a", terminal, pid, 0, None);
            terminals.exit(
                "thread-a",
                terminal,
                sequence,
                exit,
                stamps[2],
                &mut recorder(&mut events),
            );
        }
        assert_eq!(
            rows(&terminals),
            vec!["thread-a/term-1:exited".to_owned()],
            "term-1 exited last, so it is the one record left"
        );
        assert_eq!(
            terminals.evictions(),
            &[
                ("thread-a".to_owned(), "term-3".to_owned()),
                ("thread-a".to_owned(), "term-2".to_owned()),
            ]
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals
                .clear("thread-a", "term-3", "t10", &mut recorder(&mut events))
                .err()
                .map(|error| error.kind()),
            Some(io::ErrorKind::NotFound),
            "a dropped terminal is a lookup failure, exactly as the client sees it"
        );
        assert!(
            events.is_empty(),
            "retention publishes nothing, so a clear of a dropped record cannot either"
        );
        terminals
            .clear("thread-a", "term-1", "t11", &mut recorder(&mut events))
            .unwrap();
        assert_eq!(events, vec!["cleared term-1 3".to_owned()]);
    }

    #[test]
    fn an_equal_stamp_leaves_the_choice_to_the_ids() {
        let logs = Logs::start("retention-ties");
        let mut terminals = Terminals::with_retention(&logs.dir, 1);
        let mut events: Vec<String> = Vec::new();
        for (terminal, pid) in [("term-1", 7400), ("term-2", 7401), ("term-3", 7402)] {
            terminals.insert(
                "thread-a",
                terminal,
                logs.session("thread-a", terminal, b""),
                None,
                &LaunchAsk::default(),
                "t",
            );
            terminals.mark_running(
                "thread-a",
                terminal,
                pid,
                None,
                "t",
                &mut recorder(&mut events),
            );
            let (sequence, exit) = drain_exit(&mut terminals, "thread-a", terminal, pid, 0, None);
            terminals.exit(
                "thread-a",
                terminal,
                sequence,
                exit,
                "t",
                &mut recorder(&mut events),
            );
        }
        assert_eq!(
            rows(&terminals),
            vec!["thread-a/term-3:exited".to_owned()],
            "with every stamp tied the shipped sort keeps the greatest id"
        );
        assert_eq!(terminals.evictions().len(), 2);
    }

    #[test]
    fn retention_never_counts_a_running_session() {
        let logs = Logs::start("retention-running");
        let mut terminals = Terminals::with_retention(&logs.dir, 1);
        let mut events: Vec<String> = Vec::new();
        for (terminal, pid, stamps) in [
            ("term-1", 7400, ["t1", "t2"]),
            ("term-2", 7401, ["t3", "t4"]),
        ] {
            terminals.insert(
                "thread-a",
                terminal,
                logs.session("thread-a", terminal, b""),
                None,
                &LaunchAsk::default(),
                stamps[0],
            );
            terminals.mark_running(
                "thread-a",
                terminal,
                pid,
                None,
                stamps[1],
                &mut recorder(&mut events),
            );
        }
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-1", 7400, 0, None);
        terminals.exit(
            "thread-a",
            "term-1",
            sequence,
            exit,
            "t5",
            &mut recorder(&mut events),
        );
        terminals.insert(
            "thread-a",
            "term-3",
            logs.session("thread-a", "term-3", b""),
            None,
            &LaunchAsk::default(),
            "t6",
        );
        terminals.mark_running(
            "thread-a",
            "term-3",
            7402,
            None,
            "t7",
            &mut recorder(&mut events),
        );
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-3", 7402, 0, None);
        terminals.exit(
            "thread-a",
            "term-3",
            sequence,
            exit,
            "t8",
            &mut recorder(&mut events),
        );
        assert_eq!(
            rows(&terminals),
            vec![
                "thread-a/term-3:exited".to_owned(),
                "thread-a/term-2:running".to_owned(),
            ],
            "the running terminal is kept beside the ceiling, newest stamp first"
        );
        assert_eq!(
            terminals.evictions(),
            &[("thread-a".to_owned(), "term-1".to_owned())]
        );
    }

    #[test]
    fn a_session_that_never_spawned_counts_as_inactive() {
        let logs = Logs::start("retention-starting");
        let mut terminals = Terminals::with_retention(&logs.dir, 1);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
            None,
            &LaunchAsk::default(),
            "t2",
        );
        assert_eq!(
            rows(&terminals),
            vec!["thread-a/term-2:starting".to_owned()],
            "an unspawned record is inactive, so the older one goes first"
        );
        assert_eq!(
            terminals.evictions(),
            &[("thread-a".to_owned(), "term-1".to_owned())],
            "the ceiling only reports the key it dropped, because it publishes nothing"
        );
    }

    #[test]
    fn the_ceiling_drops_the_table_entry_and_leaves_the_history_file() {
        let logs = Logs::start("retention-keeps-file");
        let file = logs.current("thread-a", "term-1");
        logs.seed(&file, "kept\n");
        let mut terminals = Terminals::with_retention(&logs.dir, 0);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        assert_eq!(
            terminals.evictions(),
            &[("thread-a".to_owned(), "term-1".to_owned())],
            "a ceiling of zero evicts the session `open` is creating"
        );
        assert!(logs.exists(&file), "retention removes no history");
        assert_eq!(
            terminals.state("thread-a", "term-1"),
            None,
            "and the port does not keep the evicted record alive the way the shipped detached object
            does, which is the declared divergence for a ceiling below the concurrent opens"
        );
    }

    #[test]
    fn the_view_is_newest_stamp_first_then_ids() {
        let logs = Logs::start("view-order");
        let mut terminals = terminals(&logs);
        for (terminal, stamp) in [("term-2", "t1"), ("term-1", "t2"), ("term-3", "t2")] {
            terminals.insert(
                "thread-a",
                terminal,
                logs.session("thread-a", terminal, b""),
                None,
                &LaunchAsk::default(),
                stamp,
            );
        }
        assert_eq!(
            rows(&terminals),
            vec![
                "thread-a/term-1:starting".to_owned(),
                "thread-a/term-3:starting".to_owned(),
                "thread-a/term-2:starting".to_owned(),
            ],
            "the tied pair sorts by id, and registration order does not rank above it"
        );
    }

    #[test]
    fn the_default_ceiling_is_the_shipped_one() {
        let logs = Logs::start("default-ceiling");
        assert_eq!(Terminals::new(&logs.dir).retention(), 128);
    }

    #[test]
    fn a_resize_stamps_the_record_and_publishes_nothing() {
        let logs = Logs::start("resize-stamp");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<(String, u64)> = Vec::new();
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |event| {
            events.push((event.terminal_id().to_owned(), event.sequence()));
        });
        assert_eq!(
            terminals.resize("thread-a", "term-1", 132, 43, "t3"),
            Resize::Applied {
                cols: 132,
                rows: 43
            },
            "a running terminal hands the caller the size to apply to the process"
        );
        assert_eq!(events.len(), 1, "a resize announces nothing");
        let state = terminals.state("thread-a", "term-1").unwrap();
        assert_eq!(
            state.updated_at, "t3",
            "the resize is a stamping site, so the record the view sorts on moves"
        );
        assert_eq!(
            state.status,
            Status::Running,
            "nothing else about the record changes"
        );
        // The sequence the next event gets is the only way to see whether an intervening mutation
        // consumed one, and a resize does not.
        terminals
            .clear("thread-a", "term-1", "t5", &mut |event| {
                events.push((event.terminal_id().to_owned(), event.sequence()));
            })
            .expect("the terminal is still in the table");
        assert_eq!(
            events,
            vec![("term-1".to_owned(), 1), ("term-1".to_owned(), 2)],
            "the cleared event follows the start with nothing in between: a resize consumes no sequence"
        );
    }

    #[test]
    fn a_resize_of_a_terminal_that_is_not_running_is_silent() {
        let logs = Logs::start("resize-idle");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        assert_eq!(
            terminals.resize("thread-a", "term-1", 100, 30, "t2"),
            Resize::NotRunning,
            "a terminal that has not spawned has no process to size"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t1",
            "the shipped call returns before it touches the record, so a starting terminal keeps its open stamp"
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t3", &mut |_| {});
        terminals.exit("thread-a", "term-1", 2, Exit::default(), "t4", &mut |_| {});
        assert_eq!(
            terminals.resize("thread-a", "term-1", 10, 10, "t5"),
            Resize::NotRunning,
            "the exited record keeps its exit stamp: ResizeObserver traffic racing an exit is dropped"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t4"
        );
        assert_eq!(
            terminals.resize("thread-a", "term-9", 10, 10, "t6"),
            Resize::Missing,
            "a resize of a terminal the table never had is not an error either"
        );
        assert_eq!(
            terminals.metadata("thread-a", "term-9"),
            None,
            "and it has no row for the metadata stream to upsert"
        );
    }

    #[test]
    fn a_record_that_named_no_viewport_starts_with_the_shipped_one() {
        let logs = Logs::start("open-default-viewport");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            Size {
                cols: 120,
                rows: 30
            },
            "DEFAULT_OPEN_COLS and DEFAULT_OPEN_ROWS (Manager.ts:101) are the record's first viewport"
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &LaunchAsk::default(),
            "t2",
        );
        assert_eq!(
            terminals.state("thread-a", "term-2").unwrap().size,
            Size {
                cols: 100,
                rows: 24
            },
            "a call that names a viewport wins over the default"
        );
    }

    #[test]
    fn an_attach_at_the_viewport_the_terminal_already_has_costs_the_process_nothing() {
        let logs = Logs::start("attach-same-viewport");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        terminals.mark_running(
            "thread-a",
            "term-1",
            7400,
            None,
            "t1",
            &mut recorder(&mut events),
        );
        assert_eq!(events, vec!["started term-1 1 pid 7400".to_owned()]);
        assert_eq!(
            terminals.viewport(
                "thread-a",
                "term-1",
                Size {
                    cols: 100,
                    rows: 24
                },
                "t2",
            ),
            Viewport::Unchanged,
            "the second client gets a snapshot and the pty is never touched"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t1",
            "a matching viewport leaves the stamp the sessions list sorts on alone, so the row does not move"
        );
        assert_eq!(
            events,
            vec!["started term-1 1 pid 7400".to_owned()],
            "and nothing is published"
        );
    }

    #[test]
    fn an_attach_at_a_new_viewport_is_remembered_and_restamps_without_publishing() {
        let logs = Logs::start("attach-new-viewport");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        terminals.mark_running(
            "thread-a",
            "term-1",
            7400,
            None,
            "t1",
            &mut recorder(&mut events),
        );
        let asked = Size {
            cols: 132,
            rows: 43,
        };
        assert_eq!(
            terminals.viewport("thread-a", "term-1", asked, "t2"),
            Viewport::Applied(asked),
            "the caller hands this size to the process"
        );
        assert_eq!(terminals.state("thread-a", "term-1").unwrap().size, asked);
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t2"
        );
        assert_eq!(
            terminals.viewport("thread-a", "term-1", asked, "t3"),
            Viewport::Unchanged,
            "the record kept the size, so asking for it again is free"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t2",
            "and the second answer did not stamp"
        );
        assert_eq!(
            events,
            vec!["started term-1 1 pid 7400".to_owned()],
            "neither answer publishes an event",
        );
    }

    #[test]
    fn the_size_an_earlier_client_asked_for_is_the_one_a_later_client_is_compared_against() {
        let logs = Logs::start("attach-remembered-viewport");
        let mut terminals = terminals(&logs);
        let open = Size {
            cols: 100,
            rows: 24,
        };
        let wide = Size {
            cols: 132,
            rows: 43,
        };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(open),
            &LaunchAsk::default(),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t1", &mut |_| {});
        assert_eq!(
            terminals.viewport("thread-a", "term-1", wide, "t2"),
            Viewport::Applied(wide)
        );
        assert_eq!(
            terminals.viewport(
                "thread-a",
                "term-1",
                Size {
                    cols: 132,
                    rows: 20
                },
                "t3",
            ),
            Viewport::Applied(Size {
                cols: 132,
                rows: 20
            }),
            "the same width with a shorter height is still a different viewport"
        );
        assert_eq!(
            terminals.viewport("thread-a", "term-1", open, "t4"),
            Viewport::Applied(open),
            "a third client asking for the viewport the terminal opened with resizes again: the gate compares the current size, not the first one"
        );
        assert_eq!(terminals.state("thread-a", "term-1").unwrap().size, open);
    }

    #[test]
    fn the_viewport_gate_skips_a_terminal_that_has_no_process() {
        let logs = Logs::start("attach-idle-viewport");
        let mut terminals = terminals(&logs);
        let asked = Size { cols: 90, rows: 20 };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        assert_eq!(
            terminals.viewport("thread-a", "term-1", asked, "t2"),
            Viewport::NotRunning,
            "an unspawned record is `openLocked`'s branch that starts a session, and the stream gate skips it"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t1"
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        terminals.exit("thread-a", "term-1", 2, Exit::default(), "t3", &mut |_| {});
        assert_eq!(
            terminals.viewport("thread-a", "term-1", asked, "t4"),
            Viewport::NotRunning,
            "measured on attach-of-an-exited-terminal-skips-the-size-gate: the snapshot a client gets names the exit's stamp, not a newer one"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t3",
            "so an attach after an exit cannot reorder the sessions list"
        );
        assert_eq!(
            terminals.viewport("thread-a", "term-9", asked, "t5"),
            Viewport::Missing,
            "a terminal the table never had is what tells the caller to open one"
        );
    }

    #[test]
    fn a_resize_has_no_gate_of_its_own() {
        let logs = Logs::start("resize-is-not-the-gate");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &LaunchAsk::default(),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t1", &mut |_| {});
        assert_eq!(
            terminals.resize("thread-a", "term-1", 100, 24, "t2"),
            Resize::Applied {
                cols: 100,
                rows: 24
            },
            "resizeLocked never compares: the same viewport twice is two pty calls"
        );
        assert_eq!(
            terminals.resize("thread-a", "term-1", 100, 24, "t3"),
            Resize::Applied {
                cols: 100,
                rows: 24
            },
            "and each one stamps"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t3",
            "the record carries the last resize's stamp"
        );
        assert_eq!(
            terminals.resize("thread-a", "term-1", 132, 43, "t4"),
            Resize::Applied {
                cols: 132,
                rows: 43
            },
            "and a resize that changes the viewport is still just a resize"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            Size {
                cols: 132,
                rows: 43
            },
            "the record keeps the size the resize applied, not the one the terminal opened with"
        );
        assert_eq!(
            terminals.viewport(
                "thread-a",
                "term-1",
                Size {
                    cols: 132,
                    rows: 43
                },
                "t5",
            ),
            Viewport::Unchanged,
            "which is the size the next attach is compared against"
        );
        assert_eq!(
            terminals.viewport(
                "thread-a",
                "term-1",
                Size {
                    cols: 100,
                    rows: 24
                },
                "t6",
            ),
            Viewport::Applied(Size {
                cols: 100,
                rows: 24
            }),
            "and asking for the open viewport again costs a resize"
        );
    }

    #[test]
    fn a_restart_that_names_no_viewport_keeps_the_size_the_terminal_had() {
        let logs = Logs::start("restart-keeps-viewport");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &LaunchAsk::default(),
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        terminals.mark_running(
            "thread-a",
            "term-1",
            7400,
            None,
            "t1",
            &mut recorder(&mut events),
        );
        terminals.exit("thread-a", "term-1", 2, Exit::default(), "t2", &mut |_| {});
        terminals
            .restart(
                "thread-a",
                "term-1",
                7401,
                None,
                &LaunchAsk::default(),
                "t3",
                &mut recorder(&mut events),
            )
            .unwrap();
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            Size {
                cols: 100,
                rows: 24
            },
            "input.cols ?? session.cols (Manager.ts:2985): a restart with no viewport restarts the same window"
        );
        terminals
            .restart(
                "thread-a",
                "term-1",
                7402,
                Some(Size { cols: 80, rows: 20 }),
                &LaunchAsk::default(),
                "t4",
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            Size { cols: 80, rows: 20 },
            "and one that names a viewport moves it, because the shipped start writes the size before spawning"
        );
        assert_eq!(
            events.len(),
            2,
            "a restart publishes once, as it did before the size existed"
        );
    }

    #[test]
    fn a_failed_start_leaves_the_viewport_it_asked_for() {
        let logs = Logs::start("failed-start-viewport");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        let asked = Size { cols: 90, rows: 20 };
        let mut events: Vec<String> = Vec::new();
        terminals.mark_error(
            "thread-a",
            "term-1",
            "Failed to spawn PTY process",
            Some(asked),
            "t2",
            &mut recorder(&mut events),
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            asked,
            "Manager.ts:2196 writes the size before the spawn, so the error record is already sized"
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t3", &mut |_| {});
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().size,
            asked,
            "and a start that names no viewport comes back on it rather than on the open default"
        );
    }

    #[test]
    fn one_row_of_the_view_is_the_row_the_upsert_would_carry() {
        let logs = Logs::start("single-row");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &LaunchAsk::default(),
            "t1",
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
            None,
            &LaunchAsk::default(),
            "t2",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t3", &mut |_| {});
        let single = terminals
            .metadata("thread-a", "term-1")
            .expect("a running terminal has a row");
        assert_eq!(
            (
                single.status,
                single.pid,
                single.updated_at.as_str(),
                terminals.metadata("thread-a", "term-2").unwrap().status
            ),
            (Status::Running, Some(7400), "t3", Status::Starting),
            "the read reports the record as it stands, whichever terminal it is"
        );
        assert_eq!(
            terminals.view()[0],
            single,
            "the whole-table view and the read the metadata stream performs are the same row, in the same shape"
        );
        let warnings = terminals
            .close("thread-a", Some("term-1"), None, &mut |_| {})
            .expect("a close of a live session succeeds");
        assert!(
            warnings.is_empty(),
            "no history was removed, so there is nothing for the caller to log"
        );
        assert_eq!(
            terminals.metadata("thread-a", "term-1"),
            None,
            "a terminal that left the table reads as no row, which is why its event produces no frame"
        );
    }
    /// An `open` of a terminal the table already has, naming only a directory.
    fn relaunch(cwd: &str) -> LaunchAsk {
        LaunchAsk {
            cwd: cwd.to_owned(),
            ..LaunchAsk::default()
        }
    }

    fn runtime(pairs: &[(&str, &str)]) -> Option<Vec<(String, String)>> {
        Some(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    /// One delivered chunk plus the write it queued: what a terminal that printed leaves on disk,
    /// which is the thing a reset has to make disappear.
    fn print(terminals: &mut Terminals, thread: &str, terminal: &str, pid: u32, text: &str) {
        let session = terminals
            .session(thread, terminal)
            .expect("the terminal is in the table");
        session.enqueue(pid, PendingEvent::Data(text.to_owned()));
        assert!(
            matches!(session.drain_next(pid), Some(Delivery::Output { .. })),
            "the chunk walks"
        );
        assert!(
            session.drain_next(pid).is_none(),
            "and the walk runs to idle, which is what frees the next event to start one"
        );
        session.flush().unwrap();
    }

    fn on_disk(logs: &Logs, thread: &str, terminal: &str) -> Vec<u8> {
        fs::read(logs.current(thread, terminal)).unwrap_or_default()
    }

    #[test]
    fn reopening_on_the_same_launch_keeps_the_screen_and_touches_nothing() {
        let logs = Logs::start("reopen-same-launch");
        let mut terminals = terminals(&logs);
        let ask = LaunchAsk {
            cwd: "/a".to_owned(),
            worktree: Worktree::At("/w/a".to_owned()),
            env: runtime(&[("LMCS_A", "1")]),
        };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            Some(Size {
                cols: 100,
                rows: 24,
            }),
            &ask,
            "t1",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, Vec::new());
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut watch);
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");
        let before = terminals.state("thread-a", "term-1").unwrap().clone();

        assert_eq!(
            terminals.reopen("thread-a", "term-1", &ask, "t3").unwrap(),
            Reopen::Kept
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap(),
            &before,
            "an unchanged launch touches nothing: not the process, not the stamp, not the screen"
        );
        assert_eq!(
            on_disk(&logs, "thread-a", "term-1"),
            b"typed\n",
            "and the file keeps what the session printed"
        );
        assert_eq!(
            published.events(),
            vec![("term-1".to_owned(), 1)],
            "the start is the only event, because a quiet re-open takes no sequence"
        );
    }

    #[test]
    fn another_directory_stops_the_process_and_empties_the_screen() {
        let logs = Logs::start("reopen-cwd");
        let mut terminals = terminals(&logs);
        let before = relaunch("/a");
        let after = relaunch("/b");
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &before,
            "t1",
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, Vec::new());
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut watch);
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");

        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &after, "t3")
                .unwrap(),
            Reopen::Stopped { pid: 7400 },
            "the caller is handed the process it has to kill"
        );
        let state = terminals.state("thread-a", "term-1").unwrap();
        assert_eq!(
            (state.status.as_str(), state.pid, state.updated_at.as_str()),
            ("exited", None, "t3"),
            "`stopProcess` leaves the record inactive and stamped, with no event of its own"
        );
        assert_eq!(
            terminals.launch("thread-a", "term-1").unwrap().cwd,
            "/b",
            "the record now belongs to the launch that replaces the shell"
        );
        assert_eq!(
            on_disk(&logs, "thread-a", "term-1"),
            b"",
            "the screen the killed shell left is not what a later reader gets"
        );
        assert_eq!(
            terminals.session("thread-a", "term-1").unwrap().sequence(),
            2,
            "the reset spends no sequence, so the `started` that follows takes 3"
        );
        assert_eq!(
            published.events(),
            vec![("term-1".to_owned(), 1)],
            "no `cleared` and no `exited` reach a client"
        );
    }

    #[test]
    fn an_unnamed_worktree_keeps_the_recorded_one_and_a_null_clears_it() {
        let logs = Logs::start("reopen-worktree");
        let mut terminals = terminals(&logs);
        let recorded = LaunchAsk {
            cwd: "/a".to_owned(),
            worktree: Worktree::At("/w/a".to_owned()),
            env: None,
        };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &recorded,
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");
        let unnamed = LaunchAsk {
            cwd: "/a".to_owned(),
            ..LaunchAsk::default()
        };
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &unnamed, "t3")
                .unwrap(),
            Reopen::Kept,
            "a client that only knows the terminal id does not move the terminal"
        );
        assert_eq!(
            on_disk(&logs, "thread-a", "term-1"),
            b"typed\n",
            "and it does not throw away what is on screen either"
        );
        assert_eq!(
            terminals
                .reopen(
                    "thread-a",
                    "term-1",
                    &LaunchAsk {
                        cwd: "/a".to_owned(),
                        worktree: Worktree::Cleared,
                        env: None,
                    },
                    "t4",
                )
                .unwrap(),
            Reopen::Stopped { pid: 7400 },
            "naming no worktree is an input, not a question"
        );
        assert_eq!(
            terminals
                .launch("thread-a", "term-1")
                .unwrap()
                .worktree_path,
            None
        );
    }

    #[test]
    fn environment_equality_is_content_and_not_order() {
        let logs = Logs::start("reopen-env");
        let mut terminals = terminals(&logs);
        let ask = |env| LaunchAsk {
            cwd: "/a".to_owned(),
            worktree: Worktree::Unnamed,
            env,
        };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &ask(runtime(&[("LMCS_A", "1"), ("LMCS_B", "2")])),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");
        assert_eq!(
            terminals
                .reopen(
                    "thread-a",
                    "term-1",
                    &ask(runtime(&[("LMCS_B", "2"), ("LMCS_A", "1")])),
                    "t3"
                )
                .unwrap(),
            Reopen::Kept,
            "the normalization sorts, so insertion order is not a change"
        );
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &ask(runtime(&[])), "t4")
                .unwrap(),
            Reopen::Stopped { pid: 7400 },
            "an empty map is no map, which drops both entries"
        );
        assert_eq!(
            terminals.launch("thread-a", "term-1").unwrap().runtime_env,
            None,
            "and the record keeps the normalized form, not the empty input"
        );
    }

    #[test]
    fn an_absent_environment_and_an_empty_one_are_the_same_record() {
        let logs = Logs::start("reopen-absent-env");
        let mut terminals = terminals(&logs);
        let empty = LaunchAsk {
            cwd: "/a".to_owned(),
            worktree: Worktree::Unnamed,
            env: runtime(&[]),
        };
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &empty,
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");
        let absent = LaunchAsk {
            env: None,
            ..empty.clone()
        };
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &absent, "t3")
                .unwrap(),
            Reopen::Kept,
            "switching between the two cannot read as a context change"
        );
        assert_eq!(on_disk(&logs, "thread-a", "term-1"), b"typed\n");
    }

    #[test]
    fn a_terminal_that_already_exited_resets_without_a_kill_or_a_stamp() {
        let logs = Logs::start("reopen-exited");
        let mut terminals = terminals(&logs);
        let ask = relaunch("/a");
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &ask,
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        print(&mut terminals, "thread-a", "term-1", 7400, "typed\n");
        let (sequence, exit) = drain_exit(&mut terminals, "thread-a", "term-1", 7400, 3, None);
        terminals.exit("thread-a", "term-1", sequence, exit, "t4", &mut |_| {});
        assert_eq!(
            terminals.reopen("thread-a", "term-1", &ask, "t5").unwrap(),
            Reopen::Reset,
            "the same launch on a dead shell is still a new session, but there is nobody to kill"
        );
        let state = terminals.state("thread-a", "term-1").unwrap();
        assert_eq!(
            (state.status.as_str(), state.updated_at.as_str()),
            ("exited", "t4"),
            "the reset runs outside `stopProcess`, so the exit keeps its stamp"
        );
        assert_eq!(
            on_disk(&logs, "thread-a", "term-1"),
            b"",
            "and the dead shell's screen is still thrown away"
        );
        assert_eq!(
            terminals.session("thread-a", "term-1").unwrap().sequence(),
            3,
            "the exit took 3 and the reset adds nothing to it"
        );
    }

    #[test]
    fn a_starting_terminal_of_another_directory_resets_without_a_pid() {
        let logs = Logs::start("reopen-starting");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b"restored\n"),
            None,
            &relaunch("/a"),
            "t1",
        );
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &relaunch("/b"), "t2")
                .unwrap(),
            Reopen::Reset,
            "a spawn that has not landed cannot be stopped, so the reset reports no kill"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().updated_at,
            "t1",
            "and nothing stamps it either: the record was already inactive"
        );
        assert_eq!(
            on_disk(&logs, "thread-a", "term-1"),
            b"",
            "the history a previous run restored is emptied before the new shell starts"
        );
    }

    #[test]
    fn a_stopped_reopen_puts_the_record_back_in_retention_s_count() {
        let logs = Logs::start("reopen-retention");
        let mut terminals = Terminals::with_retention(&logs.dir, 1);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b""),
            None,
            &relaunch("/a"),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
            None,
            &relaunch("/a"),
            "t3",
        );
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &relaunch("/b"), "t4")
                .unwrap(),
            Reopen::Stopped { pid: 7400 }
        );
        assert_eq!(
            terminals.take_evictions(),
            vec![("thread-a".to_owned(), "term-2".to_owned())],
            "`stopProcess` runs the eviction pass, so the terminal that just went inactive joins the count"
        );
    }

    #[test]
    fn a_reopen_that_cannot_write_reports_it_and_publishes_nothing() {
        let mut logs = Logs::start("reopen-write-fails");
        let current = logs.current("thread-a", "term-1");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-a",
            "term-1",
            logs.session("thread-a", "term-1", b"keep\n"),
            None,
            &relaunch("/a"),
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, None, "t2", &mut |_| {});
        drop(logs.worker.take());
        assert_eq!(
            terminals
                .reopen("thread-a", "term-1", &relaunch("/b"), "t3")
                .expect_err("the shipped `yield*` on persistHistory stops the open")
                .kind(),
            io::ErrorKind::BrokenPipe
        );
        assert!(
            !logs.exists(&current),
            "a reset that cannot write leaves the file it was given"
        );
        assert_eq!(
            terminals.state("thread-a", "term-1").unwrap().status,
            Status::Exited,
            "but the process was already stopped, which is the order the shipped call runs in"
        );
    }
}
