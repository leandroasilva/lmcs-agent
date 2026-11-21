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

/// The state the shipped manager keeps beside a session's output that the exit and retention rules
/// read. Cwd, the worktree path, cols, rows and the display label belong to spawn and the wire: no
/// exit, retention or fan-out rule reads them.
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
}

/// One table entry: what the session's output is doing, and what the manager says about it.
struct Entry {
    output: PersistedOutput,
    state: Session,
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
    /// A running session with a process, so the caller hands the bytes to the shell.
    Delivered,
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
fn render(cause: &DeleteFailure) -> String {
    let reason = match cause.cause.kind() {
        io::ErrorKind::NotFound => "NotFound",
        io::ErrorKind::PermissionDenied => "PermissionDenied",
        io::ErrorKind::AlreadyExists => "AlreadyExists",
        _ => "Unknown",
    };
    format!("PlatformError/{reason}/remove")
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
    /// runs the retention pass `openLocked` calls right after inserting (Manager.ts:2557).
    pub fn insert(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        output: PersistedOutput,
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
                state: Session {
                    status: Status::Starting,
                    updated_at: at.to_owned(),
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
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> Option<u64> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        let sequence = entry.output.start(pid);
        entry.state = Session {
            status: Status::Running,
            pid: Some(pid),
            // Measured in `restart-after-exit`: a session that ran, exited and started again reports no
            // exit state, because the shipped start writes these fields rather than keeping them.
            exit_code: None,
            exit_signal: None,
            updated_at: at.to_owned(),
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
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> Option<u64> {
        let entry = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        let sequence = entry.output.fail_start();
        entry.state = Session {
            status: Status::Error,
            updated_at: at.to_owned(),
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
        if state.status == Status::Running && state.pid.is_some() {
            return Ok(Write::Delivered);
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
    /// apply to the process, which is where `TerminalResizeError` comes from. The shipped record also
    /// keeps the size, but only `open`'s equality gate reads it again (Manager.ts:2626, :2684) and that
    /// path is not ported yet, so the port leaves it with the caller's process rather than inventing a
    /// field nothing here consumes.
    pub fn resize(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        cols: u32,
        rows: u32,
        at: &str,
    ) -> Resize {
        let Some(entry) = self
            .sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
        else {
            return Resize::Missing;
        };
        if entry.state.status != Status::Running || entry.state.pid.is_none() {
            return Resize::NotRunning;
        }
        entry.state.updated_at = at.to_owned();
        Resize::Applied { cols, rows }
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
            .map(|((thread_id, terminal_id), entry)| {
                row(thread_id, terminal_id, &entry.state)
            })
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
    pub fn restart(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        at: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<()> {
        let entry = self.require_mut(thread_id, terminal_id)?;
        let sequence = entry.output.restart(pid)?;
        entry.state = Session {
            status: Status::Running,
            pid: Some(pid),
            exit_code: None,
            exit_signal: None,
            updated_at: at.to_owned(),
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
            "t0",
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"b\n"),
            "t0",
        );
        terminals.insert(
            "thread-2",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-2", DEFAULT_TERMINAL_ID, b"c\n"),
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
        assert_eq!(warnings[0].error, "PlatformError/PermissionDenied/remove");
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
            .restart("thread-1", DEFAULT_TERMINAL_ID, 42, "t0", &mut watch)
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
            "t0",
        );
        drop(logs.worker.take());
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        for outcome in [
            terminals.clear("thread-1", DEFAULT_TERMINAL_ID, "t0", &mut watch),
            terminals.restart("thread-1", DEFAULT_TERMINAL_ID, 42, "t0", &mut watch),
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
            "t0",
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"second\n"),
            "t0",
        );
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"reopened\n"),
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
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals.mark_running("thread-a", "term-1", 7400, "t2", &mut recorder(&mut events)),
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
            "t1",
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
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
        terminals.mark_running("thread-a", "term-1", 7400, "t3", &mut |event| {
            events.push(describe(event));
        });
        assert_eq!(terminals.write("thread-a", "term-1"), Ok(Write::Delivered));
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
            "t1",
        );
        terminals.mark_running("thread-a", "term-1", 7400, "t2", &mut |_| {});
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
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        terminals.mark_running("thread-a", "term-1", 7400, "t2", &mut recorder(&mut events));
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
            .restart("thread-a", "term-1", 7401, "t4", &mut recorder(&mut events))
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
            "t1",
        );
        let mut events: Vec<String> = Vec::new();
        assert_eq!(
            terminals.mark_error(
                "thread-a",
                "term-1",
                "failed to spawn",
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
                stamps[0],
            );
            terminals.mark_running(
                "thread-a",
                terminal,
                pid,
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
                "t",
            );
            terminals.mark_running("thread-a", terminal, pid, "t", &mut recorder(&mut events));
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
                stamps[0],
            );
            terminals.mark_running(
                "thread-a",
                terminal,
                pid,
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
            "t6",
        );
        terminals.mark_running("thread-a", "term-3", 7402, "t7", &mut recorder(&mut events));
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
            "t1",
        );
        terminals.insert(
            "thread-a",
            "term-2",
            logs.session("thread-a", "term-2", b""),
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
}
