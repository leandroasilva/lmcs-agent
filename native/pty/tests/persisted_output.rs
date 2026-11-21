//! `PersistedOutput` against a real worker and a real directory, checked at the call sites
//! measured in `apps/server/src/terminal/Manager.ts`.
//!
//! Nothing waits on the clock. Debounced work is observed with `flush`, which blocks until the
//! worker reports the key idle, and immediate work is observed from the returned call itself.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use lmcs_pty::node_pty::exit_event;
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::persisted::PersistedOutput;
use lmcs_pty::{Delivery, PendingEvent};
use lmcs_terminal_history::{
    BoundedHistory, HistoryPersistence, PersistHandle, PersistWarning, UNLIMITED_BYTES,
    history_path, legacy_history_path, load_history,
};

struct LogsDir(PathBuf);

impl LogsDir {
    fn new(case: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "lmcs-persisted-output-{}-{}-{}",
            std::process::id(),
            case,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn absent(case: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "lmcs-persisted-output-{}-{}-absent",
            std::process::id(),
            case
        )))
    }
}

impl Drop for LogsDir {
    fn drop(&mut self) {
        if self.0.exists() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

#[derive(Clone, Default)]
struct Warnings(Arc<Mutex<Vec<PersistWarning>>>);

impl Warnings {
    fn sink(&self) -> impl FnMut(PersistWarning) + Send + 'static {
        let this = self.clone();
        move |warning| this.0.lock().unwrap().push(warning)
    }

    fn keys(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|warning| (warning.thread_id.clone(), warning.terminal_id.clone()))
            .collect()
    }
}

struct Harness {
    directory: LogsDir,
    worker: HistoryPersistence,
    warnings: Warnings,
}

impl Harness {
    fn start(case: &str) -> Self {
        Self::open(LogsDir::new(case))
    }

    fn open(directory: LogsDir) -> Self {
        let warnings = Warnings::default();
        let worker = HistoryPersistence::start(directory.0.clone(), warnings.sink()).unwrap();
        Self {
            directory,
            worker,
            warnings,
        }
    }

    fn handle(&self) -> PersistHandle {
        self.worker.handle()
    }

    fn path(&self, thread_id: &str, terminal_id: &str) -> PathBuf {
        history_path(&self.directory.0, thread_id, terminal_id)
    }

    fn attach(&self, thread_id: &str, terminal_id: &str) -> PersistedOutput {
        attach(
            &self.worker.handle(),
            &self.directory.0,
            thread_id,
            terminal_id,
        )
    }
}

fn attach(
    handle: &PersistHandle,
    logs_dir: &Path,
    thread_id: &str,
    terminal_id: &str,
) -> PersistedOutput {
    PersistedOutput::new(
        TerminalOutput::new(BoundedHistory::with_limits(
            5_000,
            UNLIMITED_BYTES,
            b"restored\n",
        )),
        handle.clone(),
        logs_dir,
        thread_id,
        terminal_id,
    )
}

fn data(text: &str) -> PendingEvent {
    PendingEvent::Data(text.to_string())
}

fn read(path: impl AsRef<Path>) -> Vec<u8> {
    let path = path.as_ref();
    fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Hands a chunk to the walk the way an `onData` callback does, then takes it back out.
/// Only the first delivery of a walk returns `true` from `enqueue`; the ones after it queue
/// behind the running walker, so the delivery is what proves the event was not dropped.
fn grow(output: &mut PersistedOutput, pid: u32, chunk: &str) {
    output.enqueue(pid, data(chunk));
    let Some(Delivery::Output {
        data: delivered,
        history_grew,
        ..
    }) = output.drain_next(pid)
    else {
        panic!("expected an output delivery for {chunk:?}");
    };
    assert_eq!(delivered, chunk, "the walk publishes the raw chunk");
    assert!(history_grew, "expected {chunk:?} to extend the history");
}

#[test]
fn visible_output_waits_for_the_worker_and_start_never_writes() {
    let harness = Harness::start("visible");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    assert_eq!(output.start(7), 1);
    output.flush().unwrap();
    assert!(
        !path.exists(),
        "opening a session must not rewrite the file"
    );

    grow(&mut output, 7, "prompt\x1b[6");
    output.flush().unwrap();
    assert_eq!(read(&path), b"restored\nprompt");

    grow(&mut output, 7, "n\x1b[31mred\x1b[0m");
    output.flush().unwrap();
    assert_eq!(read(&path), b"restored\nprompt\x1b[31mred\x1b[0m");
    assert_eq!(output.history_value(), read(&path));
    assert!(harness.warnings.keys().is_empty());
}

#[test]
fn output_that_adds_nothing_to_history_never_creates_the_file() {
    let harness = Harness::start("invisible");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    assert!(output.enqueue(7, data("\x1b]11;")));
    assert!(
        matches!(
            output.drain_next(7),
            Some(Delivery::Output {
                history_grew: false,
                ..
            })
        ),
        "an incomplete control must stay out of the history"
    );
    assert_eq!(output.history_value(), b"restored\n");
    output.flush().unwrap();
    assert!(
        !path.exists(),
        "nothing became visible, so this call site queued nothing"
    );

    grow(&mut output, 7, "?\x07red");
    output.flush().unwrap();
    assert_eq!(read(&path), b"restored\nred");
}

#[test]
fn clear_restart_and_close_persist_before_the_caller_continues() {
    let harness = Harness::start("immediate");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "before clear");
    output.flush().unwrap();
    assert_eq!(read(&path), b"restored\nbefore clear");

    assert_eq!(output.clear().unwrap(), 3);
    assert_eq!(
        read(&path),
        b"",
        "the cleared history must be durable on return"
    );
    assert!(output.shared_history().try_lock().is_ok());

    grow(&mut output, 7, "after clear");
    output.flush().unwrap();
    assert_eq!(read(&path), b"after clear");

    assert!(output.restart(8).is_ok());
    assert_eq!(read(&path), b"", "restart persists the history it dropped");

    grow(&mut output, 8, "last words");
    assert!(output.close().is_ok());
    assert_eq!(read(&path), b"last words");
    assert_eq!(output.drain_next(8), None);
}

#[test]
fn close_persists_even_when_the_session_never_printed() {
    let harness = Harness::start("silent");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    output.flush().unwrap();
    assert!(!path.exists());
    assert!(output.close().is_ok());
    assert_eq!(
        read(&path),
        b"restored\n",
        "close hands the retained history over, even an untouched one"
    );
}

#[test]
fn an_exit_with_nothing_queued_persists_nothing() {
    let harness = Harness::start("exit-only");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    assert!(output.enqueue(7, PendingEvent::Exit(exit_event(0, None))));
    assert!(matches!(output.drain_next(7), Some(Delivery::Exit { .. })));
    output.flush().unwrap();
    assert!(
        !path.exists(),
        "the exit action schedules no write of its own"
    );
}

#[test]
fn close_persists_the_history_an_exit_retained() {
    let harness = Harness::start("exit");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    assert!(output.enqueue(7, data("kept\x1b]11;")));
    output.enqueue(7, PendingEvent::Exit(exit_event(0, None)));
    assert!(matches!(
        output.drain_next(7),
        Some(Delivery::Output {
            history_grew: true,
            ..
        })
    ));
    assert!(matches!(output.drain_next(7), Some(Delivery::Exit { .. })));
    assert_eq!(output.history_value(), b"restored\nkept");

    assert!(output.close().is_ok());
    assert_eq!(read(&path), b"restored\nkept");
}

#[test]
fn a_waiting_debounce_cannot_undo_an_immediate_clear() {
    let harness = Harness::start("race");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "queued");
    assert!(output.clear().is_ok());
    assert_eq!(
        read(&path),
        b"",
        "the snapshot is taken at write time, after the caller cleared it"
    );
    output.flush().unwrap();
    assert_eq!(read(&path), b"");
    assert!(harness.warnings.keys().is_empty());
}

#[test]
fn a_failing_write_is_a_warning_and_never_fails_the_caller() {
    let mut harness = Harness::open(LogsDir::absent("write"));
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "text");
    output.flush().unwrap();
    assert_eq!(
        harness.warnings.keys(),
        [("thread-1".to_owned(), "term-1".to_owned())],
        "the failed debounced write is reported once"
    );
    assert_eq!(
        output.clear().unwrap(),
        3,
        "the manager logs write failures and keeps going"
    );
    assert_eq!(harness.warnings.keys().len(), 2);
    harness.worker.stop().unwrap();
}

#[test]
fn a_flushed_history_reopens_exactly_as_the_live_one() {
    let harness = Harness::start("reopen");
    let mut output = harness.attach("thread-1", "term-2");
    output.start(7);
    for chunk in ["prompt\x1b[6", "n\x1b[31mred\x1b[0m\r\n", "done\x1b]11;"] {
        grow(&mut output, 7, chunk);
    }
    output.flush().unwrap();
    let reopened = load_history(
        &harness.directory.0,
        "thread-1",
        "term-2",
        UNLIMITED_BYTES,
        5_000,
    )
    .unwrap();
    assert_eq!(reopened.history.value(), output.history_value());
    assert!(reopened.cleanup_warning.is_none());

    let mut next = harness.attach("thread-1", "term-2");
    next.start(8);
    grow(&mut next, 8, "fresh");
    assert!(next.close().is_ok());
    assert_eq!(
        read(harness.path("thread-1", "term-2")),
        next.history_value()
    );
}

#[test]
fn each_key_keeps_its_own_file_and_drains_alone() {
    let harness = Harness::start("keys");
    let mut first = harness.attach("thread-1", "term-1");
    let mut second = harness.attach("thread/2", "term-1");
    first.start(7);
    second.start(8);
    grow(&mut first, 7, "one");
    grow(&mut second, 8, "two");
    first.flush().unwrap();
    second.flush().unwrap();
    assert_eq!(read(harness.path("thread-1", "term-1")), b"restored\none");
    assert_eq!(read(harness.path("thread/2", "term-1")), b"restored\ntwo");

    assert!(first.clear().is_ok());
    assert_eq!(read(harness.path("thread-1", "term-1")), b"");
    assert_eq!(
        read(harness.path("thread/2", "term-1")),
        b"restored\ntwo",
        "one key's immediate persist must not rewrite another's file"
    );
}

#[test]
fn a_stopped_worker_reports_itself_to_the_immediate_paths_only() {
    let mut harness = Harness::start("stopped");
    let path = harness.path("thread-1", "term-1");
    let handle = harness.handle();
    let directory = harness.directory.0.clone();
    let mut output = attach(&handle, &directory, "thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "live");
    output.flush().unwrap();
    assert_eq!(read(&path), b"restored\nlive");

    harness.worker.stop().unwrap();
    grow(&mut output, 7, " after stop");
    assert_eq!(output.history_value(), b"restored\nlive after stop");
    assert_eq!(
        output.flush().err().map(|error| error.kind()),
        Some(ErrorKind::BrokenPipe)
    );
    assert_eq!(
        output.clear().err().map(|error| error.kind()),
        Some(ErrorKind::BrokenPipe)
    );
    assert!(output.restart(8).is_err());
    assert!(output.close().is_err());
    assert_eq!(
        read(&path),
        b"restored\nlive",
        "a stopped worker writes nothing"
    );
}

#[test]
fn deleting_after_close_removes_the_file_the_close_wrote() {
    let harness = Harness::start("close-then-delete");
    let path = harness.path("thread-1", "term-1");
    let legacy = legacy_history_path(&harness.directory.0, "thread-1");
    fs::write(&legacy, b"pre-existing legacy").unwrap();
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "last");
    assert!(output.close().is_ok());
    assert_eq!(read(&path), b"restored\nlast");

    assert!(output.delete_history().is_empty());
    assert!(!path.exists());
    assert!(
        !legacy.exists(),
        "the default terminal owns the legacy file, so its deletion goes too"
    );

    output.flush().unwrap();
    assert!(
        !path.exists(),
        "an idle key writes nothing, so the deleted file stays deleted"
    );
}

#[test]
fn a_deletion_without_a_session_still_removes_the_file() {
    let harness = Harness::start("delete-without-session");
    let path = harness.path("thread-1", "term-1");
    fs::write(&path, b"from the previous process").unwrap();
    let output = harness.attach("thread-1", "term-1");
    assert!(output.delete_history().is_empty());
    assert!(
        !path.exists(),
        "the reference manager deletes after closing even when no session was registered"
    );
}

#[test]
fn the_next_session_writes_again_after_a_deletion() {
    let harness = Harness::start("delete-then-reopen");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "kept");
    assert!(output.close().is_ok());
    assert!(output.delete_history().is_empty());

    output.start(8);
    grow(&mut output, 8, "more");
    output.flush().unwrap();
    assert_eq!(
        read(&path),
        b"restored\nkeptmore",
        "deletion is not a tombstone: the retained history still persists"
    );
}

#[test]
fn deleting_a_secondary_keeps_the_default_and_the_legacy_file() {
    let harness = Harness::start("delete-secondary");
    let default = harness.path("thread-1", "term-1");
    let secondary = harness.path("thread-1", "term-2");
    let legacy = legacy_history_path(&harness.directory.0, "thread-1");
    for path in [&default, &secondary, &legacy] {
        fs::write(path, b"content").unwrap();
    }
    let output = harness.attach("thread-1", "term-2");

    assert!(output.delete_history().is_empty());
    assert!(!secondary.exists());
    assert_eq!(fs::read(&default).unwrap(), b"content");
    assert_eq!(fs::read(&legacy).unwrap(), b"content");
}

#[test]
fn the_thread_sweep_removes_every_file_of_the_thread_and_no_other() {
    let harness = Harness::start("delete-thread");
    let first = harness.path("thread-1", "term-1");
    let second = harness.path("thread-1", "term-2");
    let legacy = legacy_history_path(&harness.directory.0, "thread-1");
    let other = harness.path("thread-2", "term-1");
    let other_legacy = legacy_history_path(&harness.directory.0, "thread-2");
    for path in [&second, &legacy, &other, &other_legacy] {
        fs::write(path, b"content").unwrap();
    }
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "visible");
    output.flush().unwrap();
    assert_eq!(read(&first), b"restored\nvisible");

    assert!(output.delete_thread_history().is_empty());
    assert!(
        !first.exists(),
        "the sweep also removes what this session's debounce had just written"
    );
    assert!(!second.exists());
    assert!(!legacy.exists());
    assert_eq!(fs::read(&other).unwrap(), b"content");
    assert_eq!(fs::read(&other_legacy).unwrap(), b"content");
}

#[test]
fn a_deletion_does_not_cancel_work_the_worker_still_holds() {
    let harness = Harness::start("delete-before-debounce-lands");
    let path = harness.path("thread-1", "term-1");
    let mut output = harness.attach("thread-1", "term-1");
    output.start(7);
    grow(&mut output, 7, "queued");

    assert!(output.delete_history().is_empty());
    // The reference manager persists and flushes before it deletes, which is what keeps this from
    // happening: work the worker still holds is not cancelled by a deletion, so the file comes
    // back. Here the flush is the receipt that it landed.
    assert!(output.close().is_ok());
    assert_eq!(
        read(&path),
        b"restored\nqueued",
        "deleting before the drain writes the file again"
    );
}

#[test]
fn an_unremovable_history_file_is_reported_and_not_fatal() {
    let harness = Harness::start("delete-fails");
    let path = harness.path("thread-1", "term-1");
    let legacy = legacy_history_path(&harness.directory.0, "thread-1");
    fs::create_dir(&path).unwrap();
    fs::write(&legacy, b"legacy").unwrap();
    let output = harness.attach("thread-1", "term-1");

    let failures = output.delete_history();
    assert_eq!(failures.len(), 1, "the directory cannot be unlinked");
    assert_eq!(failures[0].path, path);
    assert_eq!(
        failures[0].cause.kind(),
        std::io::ErrorKind::PermissionDenied,
        "the operating system's own refusal is what the caller logs"
    );
    assert!(
        !legacy.exists(),
        "the second removal runs even though the first one failed"
    );
}
