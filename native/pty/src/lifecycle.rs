//! Who publishes, who removes and who logs when a terminal's history changes hands.
//!
//! Ported from `closeSession`, `clear`, `restartResolved` and the `close` entry point of
//! `apps/server/src/terminal/Manager.ts`, together with the two `logWarning` sites that give
//! [`DeleteFailure`] an owner. Spawning, process control, thread locks and the websocket fan-out
//! stay with the caller: this module only fixes the order in which history is written, published
//! and removed, and what a failed removal turns into.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use lmcs_terminal_history::{DeleteFailure, delete_history, delete_thread_history};

use crate::persisted::PersistedOutput;

/// The shipped `Effect.logWarning` text when one terminal's history survives a removal.
pub const TERMINAL_DELETE_WARNING: &str = "failed to delete terminal history";
/// The shipped text when one file of a thread sweep survives.
pub const THREAD_DELETE_WARNING: &str = "failed to delete terminal histories for thread";

/// A lifecycle event the shipped manager hands to `publishEvent`. Output and exit events belong to
/// the session's own drain, so only the three transitions that history is ordered against are here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Cleared { terminal_id: String, sequence: u64 },
    Restarted { terminal_id: String, sequence: u64 },
    Closed { terminal_id: String, sequence: u64 },
}

impl Event {
    #[must_use]
    pub fn terminal_id(&self) -> &str {
        match self {
            Self::Cleared { terminal_id, .. }
            | Self::Restarted { terminal_id, .. }
            | Self::Closed { terminal_id, .. } => terminal_id,
        }
    }

    #[must_use]
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Cleared { sequence, .. }
            | Self::Restarted { sequence, .. }
            | Self::Closed { sequence, .. } => *sequence,
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
#[derive(Default)]
pub struct Terminals {
    logs_dir: PathBuf,
    sessions: HashMap<(String, String), PersistedOutput>,
    order: Vec<(String, String)>,
}

impl Terminals {
    #[must_use]
    pub fn new(logs_dir: &Path) -> Self {
        Self {
            logs_dir: logs_dir.to_path_buf(),
            ..Self::default()
        }
    }

    /// Registers a session, replacing any live one under the same key.
    pub fn insert(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        output: PersistedOutput,
    ) -> Option<PersistedOutput> {
        let key = (thread_id.to_owned(), terminal_id.to_owned());
        if !self.sessions.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.sessions.insert(key, output)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// The live session of one terminal, which is where its owner writes output and reads history.
    pub fn session(&mut self, thread_id: &str, terminal_id: &str) -> Option<&mut PersistedOutput> {
        self.sessions
            .get_mut(&(thread_id.to_owned(), terminal_id.to_owned()))
    }

    /// `clear`: drop history and persist it, then publish. A write that fails is the caller's
    /// error, and the shipped generator stops there, so nothing is published.
    pub fn clear(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<()> {
        let sequence = self.require(thread_id, terminal_id)?.clear()?;
        publish(&Event::Cleared {
            terminal_id: terminal_id.to_owned(),
            sequence,
        });
        Ok(())
    }

    /// `restartResolved`: stop the process, clear and persist history, then publish `restarted` for
    /// the caller to follow with the new spawn.
    pub fn restart(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        pid: u32,
        publish: &mut dyn FnMut(&Event),
    ) -> io::Result<()> {
        let sequence = self.require(thread_id, terminal_id)?.restart(pid)?;
        publish(&Event::Restarted {
            terminal_id: terminal_id.to_owned(),
            sequence,
        });
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
            Some(mut output) => Some(output.close()?),
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

    fn require(&mut self, thread_id: &str, terminal_id: &str) -> io::Result<&mut PersistedOutput> {
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
    use crate::output::TerminalOutput;

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
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"b\n"),
        );
        terminals.insert(
            "thread-2",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-2", DEFAULT_TERMINAL_ID, b"c\n"),
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
    fn a_thread_close_without_the_flag_closes_sessions_and_keeps_files() {
        let logs = Logs::start("thread-no-delete");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        logs.seed(&current, "keep\n");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        assert_eq!(
            terminals.close("thread-1", None, None, &mut watch).unwrap(),
            Vec::new()
        );
        assert_eq!(published.events(), vec![("term-1".to_owned(), 1)]);
        assert!(logs.exists(&current));
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
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![current.clone()]);
        terminals
            .clear("thread-1", DEFAULT_TERMINAL_ID, &mut watch)
            .unwrap();
        assert_eq!(
            fs::read(&current).unwrap(),
            b"",
            "the cleared history reached disk"
        );
        terminals
            .restart("thread-1", DEFAULT_TERMINAL_ID, 42, &mut watch)
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
    fn a_stopped_worker_fails_the_close_before_anything_is_published_or_removed() {
        let mut logs = Logs::start("stopped-worker");
        let current = logs.current("thread-1", DEFAULT_TERMINAL_ID);
        logs.seed(&current, "keep\n");
        let mut terminals = terminals(&logs);
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"keep\n"),
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
        );
        terminals.insert(
            "thread-1",
            DEFAULT_TERMINAL_ID,
            logs.session("thread-1", DEFAULT_TERMINAL_ID, b"second\n"),
        );
        terminals.insert(
            "thread-1",
            "term-2",
            logs.session("thread-1", "term-2", b"reopened\n"),
        );
        let published = Published::new();
        let mut watch = published.watch(&logs, vec![]);
        terminals.close("thread-1", None, None, &mut watch).unwrap();
        assert_eq!(
            published.events(),
            vec![("term-2".to_owned(), 1), ("term-1".to_owned(), 1)]
        );
        assert!(terminals.is_empty());
    }
}
