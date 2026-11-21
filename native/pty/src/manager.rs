//! The shipped call order, in the one place a terminal call is more than a table lookup.
//!
//! Ported from `openLocked` (Manager.ts:2511), `restartResolved` (:2933), `closeSession` (:2318),
//! `clear` (:2911) and the `subscribe`/`attachStream` pair (:2722, :2730). [`crate::lifecycle`] fixes
//! what a transition does to the session table and [`crate::stream`] fixes what a client hears; this
//! module is where the two get called, so the three rules that only exist as a pair hold: the directory
//! is validated before the table is read, every published event reaches the fan-out, and every warning
//! the table hands back reaches an owner that can write a log line.
//!
//! What stays with the caller is the process. Spawning, killing and the reader thread own descriptors
//! this module has never seen, so `open` answers with what the caller owes the shell ([`Opened`]) and
//! the caller reports the outcome back in ([`Manager::start`], [`Manager::fail_start`]).

use std::io;
use std::path::{Path, PathBuf};

use lmcs_terminal_history::{
    DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, PersistHandle, TerminalHistoryError, load_history,
};

use crate::cwd::{CwdError, assert_valid_cwd_path};
use crate::lifecycle::{
    Event, Exit, Launch, LaunchAsk, Metadata, Reopen, Session, Size, Terminals, Warning, WriteError,
};
use crate::output::TerminalOutput;
use crate::persisted::PersistedOutput;
use crate::stream::{Fanout, Frame, Publication, Snapshot, Subscriber};

/// The shipped text when the legacy file a migration copied survives its removal (Manager.ts:1847).
pub const LEGACY_DELETE_WARNING: &str = "failed to remove legacy terminal history";

/// The `logWarning` annotations, in the order the shipped object literal builds them.
pub type Fields = Vec<(&'static str, String)>;

/// One `Effect.logWarning` call, in the shape its owner takes it: the text, then the annotations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogLine {
    pub message: &'static str,
    pub fields: Fields,
}

impl LogLine {
    /// A removal the table could not make stick, which is what [`crate::lifecycle`] reports.
    #[must_use]
    pub fn warning(warning: &Warning) -> Self {
        Self {
            message: warning.message,
            fields: warning.fields(),
        }
    }

    /// `deleteHistory`'s legacy unlink (Manager.ts:1841-1850), whose fields name no terminal because
    /// the file that survived was the thread's rather than one terminal's.
    #[must_use]
    pub fn legacy(thread_id: &str, cause: &io::Error) -> Self {
        Self {
            message: LEGACY_DELETE_WARNING,
            fields: vec![
                ("threadId", thread_id.to_owned()),
                ("error", crate::lifecycle::render_cause(cause, "remove")),
            ],
        }
    }
}

/// The `open` a caller asked for. The refusal message interpolates the directory as it was named, so the
/// request carries it unresolved; the contract has already trimmed it and rejected an empty one.
pub struct Open<'a> {
    pub thread_id: &'a str,
    pub terminal_id: &'a str,
    pub ask: &'a LaunchAsk,
    pub requested: Option<Size>,
    pub at: &'a str,
}

/// The `restart` a caller asked for, including the pid the new process already has, because the shipped
/// record comes back running.
pub struct Restart<'a> {
    pub thread_id: &'a str,
    pub terminal_id: &'a str,
    pub pid: u32,
    pub ask: &'a LaunchAsk,
    pub requested: Option<Size>,
    pub at: &'a str,
}

/// What a call refused with. The two refusals a client can see carry the contract's own tag, message and
/// cause; the two it cannot are handed over with their cause intact.
#[derive(Debug)]
pub enum Failure {
    /// The directory is not one a terminal may start in (`TerminalCwd*Error`).
    Cwd(CwdError),
    /// No record under this key, which is `TerminalSessionLookupError` on the wire
    /// (`contracts/terminal.ts:294`).
    Lookup {
        thread_id: String,
        terminal_id: String,
    },
    /// The history file refused to be read or migrated.
    History(TerminalHistoryError),
    /// A persist write failed or the worker had stopped, which is what makes a `clear`, a `restart` or a
    /// `close` stop before it publishes.
    Persist(io::Error),
}

impl Failure {
    /// The `_tag` the client's error union carries. The two I/O failures have none: the shipped call lets
    /// a `PlatformError` escape as a defect, so naming a tag for one would claim a contract the union at
    /// `contracts/terminal.ts:371-380` does not declare.
    #[must_use]
    pub fn tag(&self) -> Option<&'static str> {
        match self {
            Self::Cwd(error) => Some(error.tag()),
            Self::Lookup { .. } => Some(WriteError::Missing.as_str()),
            Self::History(_) | Self::Persist(_) => None,
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Cwd(error) => error.message(),
            Self::Lookup {
                thread_id,
                terminal_id,
            } => format!("Unknown terminal thread: {thread_id}, terminal: {terminal_id}"),
            Self::History(error) => error.to_string(),
            Self::Persist(cause) => cause.to_string(),
        }
    }

    /// The cause a refusal carries, which only the stat error has: the other two swallow it and keep the
    /// directory.
    #[must_use]
    pub fn cause(&self) -> Option<String> {
        match self {
            Self::Cwd(error) => error.cause(),
            Self::Lookup { .. } | Self::History(_) | Self::Persist(_) => None,
        }
    }
}

/// What an accepted `open` left for its caller to do with a shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opened {
    /// There was no record, so one was created `starting` with the history the disk held. The caller
    /// spawns and reports with [`Manager::start`] or [`Manager::fail_start`].
    Created,
    /// The gate's answer for a terminal that already had a record, which is what says whether the old
    /// process has to be killed and whether the retained screen survived.
    Existing(Reopen),
}

/// The sessions table, its fan-out, and the owner of its warnings.
pub struct Manager {
    logs_dir: PathBuf,
    persist: PersistHandle,
    terminals: Terminals,
    fanout: Fanout,
    on_warning: Box<dyn FnMut(LogLine) + Send>,
}

impl Manager {
    /// `make`. The persistence worker stays the caller's, because it outlives any one terminal and
    /// reports its own failed writes on the handle it was started with; this seam only needs to drain
    /// and enqueue through the handle.
    #[must_use]
    pub fn new(
        logs_dir: &Path,
        persist: PersistHandle,
        on_warning: impl FnMut(LogLine) + Send + 'static,
    ) -> Self {
        Self::build(
            Terminals::new(logs_dir),
            logs_dir,
            persist,
            on_warning,
        )
    }

    /// `makeWithOptions`, with the ceiling on inactive sessions the shipped manager reads from its
    /// options.
    #[must_use]
    pub fn with_retention(
        logs_dir: &Path,
        persist: PersistHandle,
        max_retained_inactive: usize,
        on_warning: impl FnMut(LogLine) + Send + 'static,
    ) -> Self {
        Self::build(
            Terminals::with_retention(logs_dir, max_retained_inactive),
            logs_dir,
            persist,
            on_warning,
        )
    }

    fn build(
        terminals: Terminals,
        logs_dir: &Path,
        persist: PersistHandle,
        on_warning: impl FnMut(LogLine) + Send + 'static,
    ) -> Self {
        Self {
            logs_dir: logs_dir.to_path_buf(),
            persist,
            terminals,
            fanout: Fanout::new(),
            on_warning: Box::new(on_warning),
        }
    }

    #[must_use]
    pub fn retention(&self) -> usize {
        self.terminals.retention()
    }

    /// Keys retention dropped, oldest first, since the last read.
    #[must_use]
    pub fn evictions(&self) -> &[(String, String)] {
        self.terminals.evictions()
    }

    #[must_use]
    pub fn state(&self, thread_id: &str, terminal_id: &str) -> Option<&Session> {
        self.terminals.state(thread_id, terminal_id)
    }

    #[must_use]
    pub fn launch(&self, thread_id: &str, terminal_id: &str) -> Option<&Launch> {
        self.terminals.launch(thread_id, terminal_id)
    }

    /// `readTerminalMetadata`'s rows, in the order the shipped view sorts them.
    #[must_use]
    pub fn view(&self) -> Vec<Metadata> {
        self.terminals.view()
    }

    /// `snapshot(session)`'s fan-out half (Manager.ts:341): the ids, the stamp and the sequence, which
    /// are the fields the attach stream's initial frame and dedup rule read.
    pub fn snapshot(&mut self, thread_id: &str, terminal_id: &str) -> Option<Snapshot> {
        let state = self.terminals.state(thread_id, terminal_id)?.clone();
        let sequence = self
            .terminals
            .session(thread_id, terminal_id)
            .map(|output| output.sequence());
        Some(Snapshot {
            thread_id: thread_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            updated_at: state.updated_at,
            sequence,
        })
    }

    /// `openLocked`, up to the point where the shipped call hands the spawn to its adapter.
    ///
    /// The order is the measurement rather than a style choice: the guard runs at :2515, one statement
    /// after the terminal id is read and before `getSession` at :2518, so a refusal neither reads the
    /// table nor drains queued work nor opens the history file. Everything past the guard is the create
    /// path (`flushPersist` :2520, `readHistory` :2521, the record and its retention pass) or the launch
    /// gate of a record that already exists (:2575-2607).
    pub fn open(&mut self, request: &Open) -> Result<Opened, Failure> {
        let Open {
            thread_id,
            terminal_id,
            ask,
            requested,
            at,
        } = *request;
        assert_valid_cwd_path(&ask.cwd).map_err(Failure::Cwd)?;
        match self.terminals.reopen(thread_id, terminal_id, ask, at) {
            Ok(Reopen::Missing) => {}
            Ok(outcome) => return Ok(Opened::Existing(outcome)),
            Err(cause) => return Err(Failure::Persist(cause)),
        }
        self.persist
            .drain(thread_id, terminal_id)
            .map_err(Failure::Persist)?;
        let loaded = load_history(
            &self.logs_dir,
            thread_id,
            terminal_id,
            DEFAULT_MAX_BYTES,
            DEFAULT_MAX_LINES,
        )
        .map_err(Failure::History)?;
        if let Some(cause) = &loaded.cleanup_warning {
            self.warn(LogLine::legacy(thread_id, cause));
        }
        let output = PersistedOutput::new(
            TerminalOutput::new(loaded.history),
            self.persist.clone(),
            &self.logs_dir,
            thread_id,
            terminal_id,
        );
        // The record was absent, so nothing here replaces a live session, and `insert` runs the
        // retention pass `openLocked` calls right after the table write (:2557).
        self.terminals
            .insert(thread_id, terminal_id, output, requested, ask, at);
        Ok(Opened::Created)
    }

    /// `openLocked`'s `readHistory` result as the record holds it, which is the `history` half of the
    /// snapshot an attach stream delivers first (Manager.ts:364).
    pub fn history(&mut self, thread_id: &str, terminal_id: &str) -> Option<Vec<u8>> {
        self.terminals
            .session(thread_id, terminal_id)
            .map(|output| output.history_value())
    }

    /// `startSession`'s success path, published to every subscriber. A record the retention ceiling took
    /// on the way is the port's parting of ways with the shipped manager, recorded in
    /// [`Terminals::mark_running`], and it publishes nothing here for the same reason.
    pub fn start(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        requested: Option<Size>,
        at: &str,
    ) -> Vec<(Subscriber, Frame)> {
        let mut events = Vec::new();
        self.terminals.mark_running(
            thread_id,
            terminal_id,
            pid,
            requested,
            at,
            &mut |event| events.push(event.clone()),
        );
        self.deliver(thread_id, &events)
    }

    /// `startSession`'s failure path, whose event carries the spawn message and nothing else.
    pub fn fail_start(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        message: &str,
        requested: Option<Size>,
        at: &str,
    ) -> Vec<(Subscriber, Frame)> {
        let mut events = Vec::new();
        self.terminals.mark_error(
            thread_id,
            terminal_id,
            message,
            requested,
            at,
            &mut |event| events.push(event.clone()),
        );
        self.deliver(thread_id, &events)
    }

    /// The exit handler, with the sequence the reader's drain handed over.
    pub fn exit(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        sequence: u64,
        exit: Exit,
        at: &str,
    ) -> Vec<(Subscriber, Frame)> {
        let mut events = Vec::new();
        self.terminals.exit(
            thread_id,
            terminal_id,
            sequence,
            exit,
            at,
            &mut |event| events.push(event.clone()),
        );
        self.deliver(thread_id, &events)
    }

    /// `clear`: history is written before the event, and a write that fails stops the call there, so
    /// nothing is published and the client hears the failure.
    pub fn clear(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        at: &str,
    ) -> Result<Vec<(Subscriber, Frame)>, Failure> {
        let mut events = Vec::new();
        self.terminals
            .clear(thread_id, terminal_id, at, &mut |event| {
                events.push(event.clone())
            })
            .map_err(Failure::Persist)?;
        Ok(self.deliver(thread_id, &events))
    }

    /// `restartResolved`, guard included: the directory is validated at :2937, before `getSession` at
    /// :2940, so a refused restart leaves the record, its history file and its process alone.
    pub fn restart(&mut self, request: &Restart) -> Result<Vec<(Subscriber, Frame)>, Failure> {
        let Restart {
            thread_id,
            terminal_id,
            pid,
            ask,
            requested,
            at,
        } = *request;
        assert_valid_cwd_path(&ask.cwd).map_err(Failure::Cwd)?;
        if self.terminals.state(thread_id, terminal_id).is_none() {
            return Err(Failure::Lookup {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
            });
        }
        let mut events = Vec::new();
        self.terminals
            .restart(
                thread_id,
                terminal_id,
                pid,
                requested,
                ask,
                at,
                &mut |event| events.push(event.clone()),
            )
            .map_err(Failure::Persist)?;
        Ok(self.deliver(thread_id, &events))
    }

    /// `close`. The warnings the removals could not avoid are this call's to hand to the owner, and the
    /// shipped order puts each one after the event that precedes it: persist and drain, then `closed`,
    /// then the unlink.
    pub fn close(
        &mut self,
        thread_id: &str,
        terminal_id: Option<&str>,
        delete_history: Option<bool>,
    ) -> Result<Vec<(Subscriber, Frame)>, Failure> {
        let mut events = Vec::new();
        let warnings = self
            .terminals
            .close(thread_id, terminal_id, delete_history, &mut |event| {
                events.push(event.clone())
            })
            .map_err(Failure::Persist)?;
        let frames = self.deliver(thread_id, &events);
        for warning in &warnings {
            self.warn(LogLine::warning(warning));
        }
        Ok(frames)
    }

    /// `subscribe` for one terminal. The id is registered before the record is looked up, which is what
    /// lets the events the lookup itself publishes be buffered instead of lost or delivered twice.
    pub fn attach(&mut self, thread_id: &str, terminal_id: &str) -> Subscriber {
        self.fanout.attach(thread_id, terminal_id)
    }

    /// `subscribe` for the sessions list.
    pub fn subscribe_metadata(&mut self) -> Subscriber {
        self.fanout.metadata()
    }

    /// The remove function `subscribe` returns (Manager.ts:2725): a late websocket close cannot disturb
    /// another subscriber, and one that is already gone answers `false`.
    pub fn detach(&mut self, subscriber: Subscriber) -> bool {
        self.fanout.unsubscribe(subscriber)
    }

    /// The attach stream's initial frame, then what it held while it was setting up.
    pub fn opened_attach(
        &mut self,
        subscriber: Subscriber,
        thread_id: &str,
        terminal_id: &str,
    ) -> Option<Vec<Frame>> {
        let initial = self.snapshot(thread_id, terminal_id)?;
        self.fanout.opened_attach(subscriber, &initial)
    }

    /// The metadata stream's initial frame: the whole view, then the held events read back against the
    /// table as it now stands.
    pub fn opened_metadata(&mut self, subscriber: Subscriber) -> Option<Vec<Frame>> {
        let terminals = self.terminals.view();
        let Manager {
            terminals: table,
            fanout,
            ..
        } = self;
        fanout.opened_metadata(subscriber, terminals, &mut |thread, terminal| {
            table.metadata(thread, terminal)
        })
    }

    /// `publishEvent`: the registry in subscription order, with the metadata stream reading its row back
    /// from the table the way the shipped listener does.
    ///
    /// Every transition publishes after it has mutated its own record and before it touches another
    /// one's, which is what lets the events a call staged be delivered once that call is over rather
    /// than inside it: the frames a subscriber sees are the same, and the table is not borrowed twice.
    fn deliver(&mut self, thread_id: &str, events: &[Event]) -> Vec<(Subscriber, Frame)> {
        let Manager {
            terminals, fanout, ..
        } = self;
        let mut frames = Vec::new();
        for event in events {
            frames.extend(fanout.publish(
                &Publication::from_event(thread_id, event),
                &mut |thread, terminal| terminals.metadata(thread, terminal),
            ));
        }
        frames
    }

    fn warn(&mut self, line: LogLine) {
        (self.on_warning)(line);
    }
}
