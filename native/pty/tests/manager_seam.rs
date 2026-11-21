//! The Manager seam: where the cwd guard, the session table and the fan-out get called together.
//!
//! `native/pty/src/cwd.rs` pins the rule, `native/pty/src/lifecycle.rs` pins the transitions and
//! `native/pty/src/stream.rs` pins what a subscriber hears. This file holds what only exists as a pair:
//! the guard running *before* the table, and every warning a transition returns having an owner. The
//! case names mirror the ones `apps/server/scripts/terminal-cwd-trace.ts` recorded, because that capture
//! is what says a refusal is silent on every other channel.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lmcs_pty::lifecycle::{Exit, LaunchAsk, Size, Status, Viewport, Worktree, Write};
use lmcs_pty::manager::{Failure, LogLine, Manager, Open, Opened, Restart};
use lmcs_pty::stream::{Frame, Subscriber};
use lmcs_terminal_history::{
    DEFAULT_TERMINAL_ID, HistoryPersistence, history_path, legacy_history_path,
};

/// A warning plus whether the file it names had already left the disk when the owner was handed it.
type Samples = Arc<Mutex<Vec<(LogLine, bool)>>>;

/// The directory a test opens in, and the one it refuses in.
struct Fixture {
    root: TempDir,
    logs: TempDir,
    dir: PathBuf,
    file: PathBuf,
    worker: HistoryPersistence,
}

/// A directory removed on drop, so a failing assertion leaves nothing for the next run to trip over.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("lmcs-manager-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = TempDir::new(name);
        let logs = TempDir::new(&format!("{name}-logs"));
        let dir = root.0.join("cwd");
        let file = root.0.join("plain.txt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&file, "not a directory\n").unwrap();
        let worker = HistoryPersistence::start(logs.0.clone(), drop).unwrap();
        Self {
            root,
            logs,
            dir,
            file,
            worker,
        }
    }

    fn manager(&self, lines: Arc<Mutex<Vec<LogLine>>>) -> Manager {
        Manager::new(&self.logs.0, self.worker.handle(), move |line| {
            lines.lock().unwrap().push(line);
        })
    }

    /// A recorder that samples the disk at the moment the owner is called, which is the only way to see
    /// that the seam hands a warning over *after* the removals rather than before them.
    fn manager_sampling(&self, gone: PathBuf) -> (Manager, Samples) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let manager = Manager::new(&self.logs.0, self.worker.handle(), move |line| {
            recorded.lock().unwrap().push((line, gone.exists()));
        });
        (manager, seen)
    }

    fn ask(&self, cwd: &Path) -> LaunchAsk {
        LaunchAsk {
            cwd: cwd.to_string_lossy().into_owned(),
            worktree: Worktree::Unnamed,
            env: None,
        }
    }
}

fn recorder() -> Arc<Mutex<Vec<LogLine>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn open(
    manager: &mut Manager,
    fixture: &Fixture,
    terminal: &str,
    cwd: &Path,
) -> Result<Opened, Failure> {
    let ask = fixture.ask(cwd);
    manager.open(&Open {
        thread_id: "thread-1",
        terminal_id: terminal,
        ask: &ask,
        requested: Some(Size {
            cols: 120,
            rows: 30,
        }),
        at: "2026-11-21T00:00:00.000Z",
    })
}

#[test]
fn an_open_refused_for_its_directory_creates_no_record() {
    // The capture's `refused-first-open-leaves-no-record`.
    let fixture = Fixture::new("refused-first-open");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());

    let failure = open(&mut manager, &fixture, "term-1", &fixture.file)
        .expect_err("a file is not a directory a shell may start in");
    assert_eq!(failure.tag(), Some("TerminalCwdNotDirectoryError"));
    assert_eq!(
        failure.message(),
        format!(
            "Terminal cwd is not a directory: {}",
            fixture.file.display()
        ),
    );
    assert_eq!(failure.cause(), None, "only a stat refusal carries a cause");
    assert!(manager.state("thread-1", "term-1").is_none());
    assert!(manager.view().is_empty(), "a refusal left no row behind");
    assert!(
        !history_path(&fixture.logs.0, "thread-1", "term-1").exists(),
        "the refusal read no history file, so it created none either",
    );
    assert!(lines.lock().unwrap().is_empty());

    // The same call with a real directory still works: a refusal did not spend the registration slot.
    assert!(
        matches!(
            open(&mut manager, &fixture, "term-1", &fixture.dir),
            Ok(Opened::Created)
        ),
        "a refusal left nothing that could block the retry",
    );
    assert_eq!(
        manager.state("thread-1", "term-1").unwrap().status,
        Status::Starting
    );
}

#[test]
fn a_refused_open_leaves_a_live_terminal_alone() {
    // The capture's `refused-open-leaves-a-live-terminal-alone`: the second call names a directory the
    // record does not have, and everything about the live one has to stay where it was.
    let fixture = Fixture::new("refused-open-live");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    let before = manager.state("thread-1", "term-1").unwrap().clone();
    let launch = manager.launch("thread-1", "term-1").unwrap().clone();
    let sequence = manager.snapshot("thread-1", "term-1").unwrap().sequence;

    let failure = open(&mut manager, &fixture, "term-1", &fixture.file)
        .expect_err("a file is not a directory");
    assert_eq!(failure.tag(), Some("TerminalCwdNotDirectoryError"));
    assert_eq!(manager.state("thread-1", "term-1"), Some(&before));
    assert_eq!(
        manager.launch("thread-1", "term-1"),
        Some(&launch),
        "the launch gate runs after the guard, so a refusal rewrote nothing",
    );
    assert_eq!(
        manager.snapshot("thread-1", "term-1").unwrap().sequence,
        sequence,
        "a refusal took no sequence",
    );
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn a_refused_restart_leaves_the_record_and_its_history_alone() {
    // The capture's `refused-restart-leaves-a-live-terminal-alone`, and the reason the guard is the
    // first statement of `restartResolved` rather than a step after the lookup.
    let fixture = Fixture::new("refused-restart");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    let before = manager.state("thread-1", "term-1").unwrap().clone();
    let history = b"screen the shell left\n".to_vec();
    fs::write(
        history_path(&fixture.logs.0, "thread-1", "term-1"),
        &history,
    )
    .unwrap();
    // A stream that has not delivered its initial snapshot yet holds every event rather than receiving
    // it, which makes it the probe for "published nothing": the refusal's frames would still be there to
    // read out when it opens.
    let subscriber = manager.attach("thread-1", "term-1");

    let ask = fixture.ask(&fixture.file);
    let failure = manager
        .restart(&Restart {
            thread_id: "thread-1",
            terminal_id: "term-1",
            pid: 9999,
            ask: &ask,
            requested: Some(Size { cols: 80, rows: 24 }),
            at: "2026-11-21T00:00:02.000Z",
        })
        .expect_err("a restart into a file is not a restart");
    assert_eq!(failure.tag(), Some("TerminalCwdNotDirectoryError"));
    assert_eq!(
        manager.state("thread-1", "term-1"),
        Some(&before),
        "the record kept its pid, status and stamp",
    );
    assert_eq!(
        fs::read(history_path(&fixture.logs.0, "thread-1", "term-1")).unwrap(),
        history,
        "a refused restart neither cleared nor rewrote the history file",
    );
    assert_eq!(
        manager
            .opened_attach(subscriber, "thread-1", "term-1")
            .expect("the record exists")
            .iter()
            .map(|frame| frame.kind())
            .collect::<Vec<_>>(),
        ["snapshot"],
        "the only frame the stream is handed is the record it was shown, so the refusal published nothing",
    );
    assert!(
        manager
            .close("thread-1", Some("term-1"), None)
            .unwrap()
            .iter()
            .map(|(_, frame)| frame.kind())
            .eq(["closed"]),
        "and the record is still live enough to close normally",
    );
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn a_restart_of_an_absent_terminal_refuses_with_the_lookup_error() {
    // The guard passes and the record is not there, which is `getSession` at Manager.ts:2940.
    let fixture = Fixture::new("restart-missing");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    let ask = fixture.ask(&fixture.dir);
    let failure = manager
        .restart(&Restart {
            thread_id: "thread-1",
            terminal_id: "gone",
            pid: 1,
            ask: &ask,
            requested: None,
            at: "2026-11-21T00:00:01.000Z",
        })
        .expect_err("nothing is running to restart");
    assert_eq!(failure.tag(), Some("TerminalSessionLookupError"));
    assert_eq!(
        failure.message(),
        "Unknown terminal thread: thread-1, terminal: gone",
    );
    assert_eq!(
        failure.cause(),
        None,
        "the lookup swallows its cause the way the shipped defect does",
    );
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn an_open_reads_the_history_the_disk_held() {
    // `flushPersist` then `readHistory` (:2520-:2521): the seam, not the caller, is what puts the file's
    // text into the new record.
    let fixture = Fixture::new("open-restores");
    let lines = recorder();
    fs::write(
        history_path(&fixture.logs.0, "thread-1", DEFAULT_TERMINAL_ID),
        b"first line\nsecond line\n",
    )
    .unwrap();
    let mut manager = fixture.manager(lines.clone());

    assert!(
        matches!(
            open(&mut manager, &fixture, DEFAULT_TERMINAL_ID, &fixture.dir),
            Ok(Opened::Created)
        ),
        "the record the disk already had for this key is still openable",
    );
    assert_eq!(
        manager
            .history("thread-1", DEFAULT_TERMINAL_ID)
            .expect("the record exists"),
        b"first line\nsecond line\n",
    );
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn a_reopened_terminal_answers_with_the_gate_rather_than_a_new_record() {
    // The launch comparison of :2575-2607 is what an accepted second `open` reports, and the record is
    // the same one: no replacement, no new registration slot.
    let fixture = Fixture::new("reopen-gate");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    let view = manager.view();

    let other = fixture.root.0.join("elsewhere");
    fs::create_dir_all(&other).unwrap();
    let outcome = open(&mut manager, &fixture, "term-1", &other).unwrap();
    assert_eq!(
        outcome,
        Opened::Existing(lmcs_pty::lifecycle::Reopen::Stopped { pid: 4242 }),
        "a different launch stops the process the record had",
    );
    assert_eq!(manager.view().len(), view.len(), "one record, not two");
    assert_eq!(
        manager.state("thread-1", "term-1").unwrap().status,
        Status::Exited,
    );
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn a_subscriber_registered_before_the_open_hears_the_snapshot_first() {
    // `subscribe` runs before the lookup, so the transition the lookup publishes is buffered; the initial
    // frame then covers it, and the dedup rule is what keeps a client from seeing the start twice.
    let fixture = Fixture::new("attach-buffers");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    let subscriber = manager.attach("thread-1", "term-1");
    let metadata = manager.subscribe_metadata();

    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    let frames = manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    assert!(
        frames.is_empty(),
        "a stream that has not delivered its initial snapshot yet holds the start rather than hearing it",
    );

    let attach = manager
        .opened_attach(subscriber, "thread-1", "term-1")
        .expect("the record exists by now");
    assert_eq!(
        attach.iter().map(|frame| frame.kind()).collect::<Vec<_>>(),
        ["snapshot"],
        "the started event the stream held is the snapshot it is about to receive",
    );
    let list = manager.opened_metadata(metadata).expect("registered");
    assert_eq!(
        list.iter().map(|frame| frame.kind()).collect::<Vec<_>>(),
        ["snapshot", "upsert"],
        "the whole view first, then the row the held event read back from the table",
    );
    assert!(
        manager
            .detach(metadata)
            .then_some(true)
            .filter(|_| !manager.detach(metadata))
            .is_some(),
        "detaching reports the first removal and nothing after it",
    );
}

#[test]
fn each_transition_the_seam_publishes_reaches_both_live_streams() {
    // The three deliveries no other case watches: every other test either runs while a stream is still
    // setting up, so the event is held rather than heard, or after the record has left the table.
    let fixture = Fixture::new("deliver-live");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    let attach = manager.attach("thread-1", "term-1");
    let sessions = manager.subscribe_metadata();
    manager.opened_attach(attach, "thread-1", "term-1").unwrap();
    manager.opened_metadata(sessions).unwrap();
    let kinds = |frames: &[(Subscriber, Frame)]| {
        frames
            .iter()
            .map(|(_, frame)| frame.kind())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        manager
            .start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z")
            .iter()
            .map(|(id, frame)| (*id, frame.kind()))
            .collect::<Vec<_>>(),
        [(attach, "snapshot"), (sessions, "upsert")],
        "a started reaches the text stream as the snapshot the dedup rule reads, and the list as a row",
    );
    let ask = fixture.ask(&fixture.dir);
    assert_eq!(
        kinds(
            &manager
                .restart(&Restart {
                    thread_id: "thread-1",
                    terminal_id: "term-1",
                    pid: 7777,
                    ask: &ask,
                    requested: None,
                    at: "2026-11-21T00:00:02.000Z",
                })
                .unwrap()
        ),
        ["restarted", "upsert"],
        "a restart is the one transition whose own name survives to the text stream",
    );
    assert_eq!(
        kinds(&manager.fail_start(
            "thread-1",
            "term-1",
            "posix_spawnp failed.",
            None,
            "2026-11-21T00:00:03.000Z",
        )),
        ["error", "upsert"],
        "and a spawn that never started is an error on both",
    );
    assert!(
        lines.lock().unwrap().is_empty(),
        "a delivery is not a warning: {lines:?}",
    );
}

#[test]
fn a_cleared_terminal_reaches_the_text_stream_and_not_the_sessions_list() {
    // `shouldPublishTerminalMetadataEvent` (Manager.ts:389) only means something once the transition and
    // the registry are wired together.
    let fixture = Fixture::new("clear-routing");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    let attach = manager.attach("thread-1", "term-1");
    let metadata = manager.subscribe_metadata();
    manager.opened_attach(attach, "thread-1", "term-1").unwrap();
    manager.opened_metadata(metadata).unwrap();

    let frames = manager
        .clear("thread-1", "term-1", "2026-11-21T00:00:02.000Z")
        .unwrap();
    let kinds: Vec<&str> = frames.iter().map(|(_, frame)| frame.kind()).collect();
    assert_eq!(
        kinds,
        ["cleared"],
        "one frame, for the stream that keeps cleared"
    );

    let frames = manager.exit(
        "thread-1",
        "term-1",
        3,
        Exit {
            exit_code: Some(0),
            exit_signal: None,
        },
        "2026-11-21T00:00:03.000Z",
    );
    let kinds: Vec<&str> = frames.iter().map(|(_, frame)| frame.kind()).collect();
    assert_eq!(
        kinds,
        ["exited", "upsert"],
        "an exit moves the row, and the row it carries is the table's own",
    );
    let upsert = frames
        .iter()
        .find(|(_, frame)| frame.kind() == "upsert")
        .map(|(_, frame)| frame)
        .cloned()
        .unwrap();
    let lmcs_pty::stream::Frame::Metadata(lmcs_pty::stream::MetadataFrame::Upsert { terminal }) =
        upsert
    else {
        panic!("the exit's metadata frame was not an upsert: {upsert:?}");
    };
    assert_eq!(terminal.status, Status::Exited);
    assert_eq!(terminal.pid, None);
    assert_eq!(terminal.updated_at, "2026-11-21T00:00:03.000Z");
}

#[test]
fn a_closed_terminal_reports_each_file_that_survived_and_nothing_else() {
    // #85: the table hands back `Vec<Warning>`, and the seam is what gives them an owner. The capture's
    // policy is one line per surviving file and no escalation.
    let fixture = Fixture::new("close-warns");
    let current = history_path(&fixture.logs.0, "thread-1", "term-1");
    // Written by hand rather than left to the record: the point is to be able to tell, from inside the
    // owner's call, whether the removal had already happened.
    fs::write(&current, b"screen\n").unwrap();
    let (mut manager, logged) = fixture.manager_sampling(current);
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    // The legacy name is the one file of this terminal the sweep and the single close both try to
    // remove and cannot: an unlink of a directory refuses on either host.
    fs::create_dir(legacy_history_path(&fixture.logs.0, "thread-1")).unwrap();
    // Both streams have to be past their initial snapshot to hear anything: a stream still setting up
    // holds the event instead of receiving it.
    let attach = manager.attach("thread-1", "term-1");
    manager.opened_attach(attach, "thread-1", "term-1").unwrap();
    let sessions = manager.subscribe_metadata();
    manager.opened_metadata(sessions).unwrap();

    let frames = manager
        .close("thread-1", Some("term-1"), Some(true))
        .unwrap();
    assert_eq!(
        frames
            .iter()
            .map(|(_, frame)| frame.kind())
            .collect::<Vec<_>>(),
        ["closed", "remove"],
        "the close publishes once to the text stream and once to the sessions list",
    );
    assert_eq!(
        frames.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        [attach, sessions],
    );

    let logged = logged.lock().unwrap().clone();
    assert_eq!(
        logged.len(),
        1,
        "one surviving file is one warning: {logged:?}"
    );
    assert!(
        !logged[0].1,
        "the owner is called after the removals, so the file that did go is already gone",
    );
    let line = logged[0].0.clone();
    assert_eq!(line.message, "failed to delete terminal history");
    assert_eq!(
        line.fields
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>(),
        ["threadId", "terminalId", "error"],
        "the shipped object literal's own key order",
    );
    assert_eq!(line.fields[0].1, "thread-1");
    assert_eq!(line.fields[1].1, "term-1");
    // The cause's spelling is the operating system's, and the two hosts refuse an unlink of a directory
    // with different errnos (see `lifecycle::render_cause`); only its shape is the port's.
    assert!(
        line.fields[2].1.starts_with("PlatformError/") && line.fields[2].1.ends_with("/remove"),
        "the cause renders as a failed remove: {}",
        line.fields[2].1,
    );
}

#[test]
fn a_thread_sweep_warns_once_per_file_without_a_terminal_id() {
    // `deleteAllHistoryForThread`'s warning names the thread and the cause and no terminal, because the
    // sweep matched file names rather than sessions.
    let fixture = Fixture::new("sweep-warns");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    fs::create_dir(legacy_history_path(&fixture.logs.0, "thread-1")).unwrap();
    let attach = manager.attach("thread-1", "term-1");
    manager.opened_attach(attach, "thread-1", "term-1").unwrap();
    let sessions = manager.subscribe_metadata();
    manager.opened_metadata(sessions).unwrap();

    let frames = manager.close("thread-1", None, Some(true)).unwrap();
    assert_eq!(
        frames
            .iter()
            .map(|(_, frame)| frame.kind())
            .collect::<Vec<_>>(),
        ["closed", "remove"],
        "the thread close closes each session it finds",
    );
    let logged = lines.lock().unwrap().clone();
    let sweep: Vec<_> = logged
        .iter()
        .filter(|line| line.message == "failed to delete terminal histories for thread")
        .collect();
    assert_eq!(sweep.len(), 1, "one surviving entry, one line: {logged:?}");
    assert_eq!(
        sweep[0]
            .fields
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>(),
        ["threadId", "error"],
        "the sweep's warning carries no terminal id",
    );
    assert_eq!(sweep[0].fields[0].1, "thread-1");
}

#[test]
fn a_close_without_the_flag_leaves_the_owner_quiet() {
    let fixture = Fixture::new("close-keeps");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    let path = history_path(&fixture.logs.0, "thread-1", "term-1");
    fs::write(&path, b"kept\n").unwrap();
    let attach = manager.attach("thread-1", "term-1");
    manager.opened_attach(attach, "thread-1", "term-1").unwrap();

    let frames = manager
        .close("thread-1", Some("term-1"), Some(false))
        .unwrap();
    assert_eq!(
        frames
            .iter()
            .map(|(_, frame)| frame.kind())
            .collect::<Vec<_>>(),
        ["closed"],
    );
    assert!(
        path.exists(),
        "the flag is the only thing that removes, and it said not to",
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        b"",
        "the close wrote the record's own screen, which is what overwrote the file the test placed",
    );
    assert!(lines.lock().unwrap().is_empty());

    // The absent flag is a different input from `false`, and neither removes. With no record left there is
    // no session to persist either, so the file keeps exactly what it held.
    fs::write(&path, b"kept\n").unwrap();
    let frames = manager.close("thread-1", Some("term-1"), None).unwrap();
    assert!(
        frames.is_empty(),
        "a second close of an absent record publishes nothing",
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        b"kept\n",
        "and an absent record persists nothing over it",
    );
    assert!(lines.lock().unwrap().is_empty());
    assert!(path.exists());
}

#[test]
fn a_legacy_cleanup_line_names_the_thread_and_the_remove() {
    // The renderer rather than a fabricated filesystem state: whether the shipped unlink fails is the
    // loader's test to make, and this is about the line the owner is handed. EACCES is 13 on both hosts,
    // so the synthetic cause needs no cfg.
    let line = LogLine::legacy("thread-9", &std::io::Error::from_raw_os_error(13));
    assert_eq!(line.message, "failed to remove legacy terminal history");
    assert_eq!(
        line.fields,
        vec![
            ("threadId", "thread-9".to_owned()),
            ("error", "PlatformError/PermissionDenied/remove".to_owned()),
        ],
    );
}

/// The child calls a step made, in the order it made them.
type Calls = Arc<Mutex<Vec<String>>>;

fn calls() -> Calls {
    Arc::new(Mutex::new(Vec::new()))
}

/// Record one write against the pid the seam chose, and answer with `Err` when the test wants the
/// process to have refused.
fn note_write(notes: &Calls, fail: bool) -> impl FnOnce(u32) -> Result<(), std::io::Error> {
    let notes = notes.clone();
    move |pid| {
        notes.lock().unwrap().push(format!("write:{pid}"));
        if fail {
            Err(std::io::Error::from_raw_os_error(13))
        } else {
            Ok(())
        }
    }
}

fn note_resize(notes: &Calls, fail: bool) -> impl FnOnce(u32, Size) -> Result<(), std::io::Error> {
    let notes = notes.clone();
    move |pid, size| {
        notes
            .lock()
            .unwrap()
            .push(format!("resize:{pid}:{}x{}", size.cols, size.rows));
        if fail {
            Err(std::io::Error::from_raw_os_error(25))
        } else {
            Ok(())
        }
    }
}

/// A terminal the shell has actually been started for, which is the only state a `write` reaches.
fn running(manager: &mut Manager, fixture: &Fixture, size: Size) {
    open(manager, fixture, "term-1", &fixture.dir).unwrap();
    manager.start(
        "thread-1",
        "term-1",
        4242,
        Some(size),
        "2026-11-21T00:00:01.000Z",
    );
}

#[test]
fn a_write_hands_the_child_the_pid_the_record_holds_and_stamps_nothing() {
    // The measured half of `write` (Manager.ts:2869) that the goldens cannot show on their own: the pid
    // the seam chose is the one the child saw, and the call left both the sequence and the stamp alone.
    let fixture = Fixture::new("write-delivered");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    running(
        &mut manager,
        &fixture,
        Size {
            cols: 120,
            rows: 30,
        },
    );
    let before = manager.state("thread-1", "term-1").unwrap().clone();
    let sequence = manager.snapshot("thread-1", "term-1").unwrap().sequence;

    let notes = calls();
    let outcome = manager.write("thread-1", "term-1", note_write(&notes, false));
    assert!(
        matches!(outcome, Ok(Write::Delivered { pid: 4242 })),
        "the record's own pid is the one the child was called with: {outcome:?}",
    );
    assert_eq!(*notes.lock().unwrap(), vec!["write:4242".to_owned()]);
    assert_eq!(
        manager.state("thread-1", "term-1"),
        Some(&before),
        "input the shell accepted is not a state change the sessions list has to re-sort",
    );
    assert_eq!(
        manager.snapshot("thread-1", "term-1").unwrap().sequence,
        sequence
    );
    assert_eq!(manager.view().len(), 1);
    assert!(lines.lock().unwrap().is_empty());
}

#[test]
fn a_refused_write_names_the_pid_and_leaves_the_terminal_running() {
    // The capture's `write-throws`: the child said no, the client gets a `TerminalWriteError` carrying
    // the pid, and the record is still running for the next call.
    let fixture = Fixture::new("write-refused");
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    running(
        &mut manager,
        &fixture,
        Size {
            cols: 120,
            rows: 30,
        },
    );
    let before = manager.state("thread-1", "term-1").unwrap().clone();
    let notes = calls();

    let failure = manager
        .write("thread-1", "term-1", note_write(&notes, true))
        .expect_err("the child refused");
    assert_eq!(failure.tag(), Some("TerminalWriteError"));
    assert_eq!(
        failure.message(),
        "Failed to write to terminal for thread: thread-1, terminal: term-1, PID: 4242",
    );
    assert_eq!(
        failure.fields().unwrap(),
        vec![
            ("threadId", "thread-1".to_owned()),
            ("terminalId", "term-1".to_owned()),
            ("terminalPid", "4242".to_owned()),
        ],
        "the pid is the third field, which is the order the contracts declare and the wire carries",
    );
    assert_eq!(
        failure.cause().unwrap(),
        "PlatformError/PermissionDenied/write",
        "the port renders the errno it was given rather than a library's own text",
    );
    assert_eq!(manager.state("thread-1", "term-1"), Some(&before));

    // The refusal cost the record nothing: the next write still reaches the shell.
    assert!(matches!(
        manager.write("thread-1", "term-1", note_write(&notes, false)),
        Ok(Write::Delivered { pid: 4242 }),
    ));
    assert_eq!(*notes.lock().unwrap(), vec!["write:4242".to_owned(); 2]);
}

#[test]
fn a_write_distinguishes_the_shell_that_has_not_arrived_from_the_one_that_left() {
    // The capture's three silences in one place, because only the seam puts them beside each other:
    // a starting record refuses (nothing to write to yet), an exited one answers `ok` and drops the
    // bytes, and an absent key is the lookup error. None of them reaches a child.
    let fixture = Fixture::new("write-without-child");
    let lines = recorder();
    let mut manager = fixture.manager(lines);
    running(
        &mut manager,
        &fixture,
        Size {
            cols: 120,
            rows: 30,
        },
    );
    let notes = calls();
    manager.exit(
        "thread-1",
        "term-1",
        9,
        Exit {
            exit_code: Some(0),
            exit_signal: None,
        },
        "2026-11-21T00:00:05.000Z",
    );

    let outcome = manager.write("thread-1", "term-1", note_write(&notes, false));
    assert!(
        matches!(outcome, Ok(Write::Swallowed)),
        "typing at a dead shell is dropped with a success, not refused: {outcome:?}",
    );
    assert!(notes.lock().unwrap().is_empty());

    // A second terminal the caller opened but has not started yet is a different answer.
    open(&mut manager, &fixture, "term-2", &fixture.dir).unwrap();
    let starting = manager.state("thread-1", "term-2").unwrap().clone();
    assert_eq!(starting.status, Status::Starting);
    let failure = manager
        .write("thread-1", "term-2", note_write(&notes, false))
        .expect_err("no process yet");
    assert_eq!(failure.tag(), Some("TerminalNotRunningError"));
    assert_eq!(
        failure.message(),
        "Terminal is not running for thread: thread-1, terminal: term-2",
    );
    assert_eq!(manager.state("thread-1", "term-2"), Some(&starting));

    let failure = manager
        .write("thread-1", "term-9", note_write(&notes, false))
        .expect_err("no record, no write");
    assert_eq!(failure.tag(), Some("TerminalSessionLookupError"));
    assert_eq!(
        failure.message(),
        "Unknown terminal thread: thread-1, terminal: term-9",
    );
    assert!(notes.lock().unwrap().is_empty());
}

#[test]
fn resize_asks_the_child_before_it_believes_the_size() {
    // `resizeLocked` (Manager.ts:2892) runs the process call first and only then writes `cols`, `rows`
    // and the stamp, so a refusal leaves the record exactly as the shell still is.
    let fixture = Fixture::new("resize-order");
    let lines = recorder();
    let mut manager = fixture.manager(lines);
    running(
        &mut manager,
        &fixture,
        Size {
            cols: 120,
            rows: 30,
        },
    );
    let notes = calls();

    manager
        .resize(
            "thread-1",
            "term-1",
            80,
            20,
            "2026-11-21T00:00:02.000Z",
            note_resize(&notes, false),
        )
        .unwrap();
    assert_eq!(*notes.lock().unwrap(), vec!["resize:4242:80x20".to_owned()]);
    let after = manager.state("thread-1", "term-1").unwrap().clone();
    assert_eq!(after.size, Size { cols: 80, rows: 20 });
    assert_eq!(after.updated_at, "2026-11-21T00:00:02.000Z");
    assert_eq!(
        manager.view().len(),
        1,
        "a viewport the client asked for is not a session the list gained",
    );

    let sequence = manager.snapshot("thread-1", "term-1").unwrap().sequence;
    let failure = manager
        .resize(
            "thread-1",
            "term-1",
            40,
            10,
            "2026-11-21T00:00:03.000Z",
            note_resize(&notes, true),
        )
        .expect_err("the child refused the size");
    assert_eq!(failure.tag(), Some("TerminalResizeError"));
    assert_eq!(
        failure.fields().unwrap(),
        vec![
            ("threadId", "thread-1".to_owned()),
            ("terminalId", "term-1".to_owned()),
            ("terminalPid", "4242".to_owned()),
            ("cols", "40".to_owned()),
            ("rows", "10".to_owned()),
        ],
    );
    let refused = manager.state("thread-1", "term-1").unwrap().clone();
    assert_eq!(
        refused.size,
        Size { cols: 80, rows: 20 },
        "the size the shell never took is not remembered"
    );
    assert_eq!(
        refused.updated_at, after.updated_at,
        "and neither is the stamp the sessions list sorts on",
    );
    assert_eq!(
        manager.snapshot("thread-1", "term-1").unwrap().sequence,
        sequence
    );
    assert_eq!(
        *notes.lock().unwrap(),
        vec![
            "resize:4242:80x20".to_owned(),
            "resize:4242:40x10".to_owned()
        ],
        "the refused call still reached the child, which is what makes the order observable",
    );
}

#[test]
fn resize_of_a_starting_or_absent_terminal_is_silent() {
    // The two silences the capture recorded as `ok` boundaries with no pty call at all: the gate asks
    // for a pid, finds none, and returns without a stamp.
    let fixture = Fixture::new("resize-quiet");
    let lines = recorder();
    let mut manager = fixture.manager(lines);
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    let starting = manager.state("thread-1", "term-1").unwrap().clone();

    let notes = calls();
    for terminal in ["term-1", "term-9"] {
        manager
            .resize(
                "thread-1",
                terminal,
                120,
                40,
                "2026-11-21T00:00:02.000Z",
                note_resize(&notes, false),
            )
            .unwrap();
    }
    assert!(notes.lock().unwrap().is_empty());
    assert_eq!(manager.state("thread-1", "term-1"), Some(&starting));
    assert!(manager.state("thread-1", "term-9").is_none());
}

#[test]
fn the_viewport_gate_only_asks_for_a_size_the_record_lacks() {
    // `openLocked`'s kept-process branch (Manager.ts:2626) and the stream's (Manager.ts:2684) share this
    // gate, so the four answers are the whole rule: nothing to attach to, nothing live, already right,
    // and the size to hand the process.
    let fixture = Fixture::new("viewport-gate");
    let lines = recorder();
    let mut manager = fixture.manager(lines);
    let notes = calls();
    let at = |manager: &mut Manager, asked: Size, fail: bool| {
        manager
            .viewport(
                "thread-1",
                "term-1",
                asked,
                "2026-11-21T00:00:09.000Z",
                note_resize(&notes, fail),
            )
            .unwrap()
    };

    assert_eq!(
        at(&mut manager, Size { cols: 80, rows: 20 }, false),
        Viewport::Missing,
        "an unopened key is the caller's to open, not to size",
    );
    assert!(manager.state("thread-1", "term-1").is_none());

    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    assert_eq!(
        at(&mut manager, Size { cols: 80, rows: 20 }, false),
        Viewport::NotRunning,
    );
    assert!(notes.lock().unwrap().is_empty());

    manager.start(
        "thread-1",
        "term-1",
        4242,
        Some(Size {
            cols: 120,
            rows: 30,
        }),
        "2026-11-21T00:00:01.000Z",
    );
    let stamp = manager
        .state("thread-1", "term-1")
        .unwrap()
        .updated_at
        .clone();
    assert_eq!(
        at(
            &mut manager,
            Size {
                cols: 120,
                rows: 30,
            },
            false
        ),
        Viewport::Unchanged,
    );
    assert!(notes.lock().unwrap().is_empty());
    assert_eq!(
        manager.state("thread-1", "term-1").unwrap().updated_at,
        stamp,
        "a matching viewport costs the sessions list a re-sort it does not need",
    );

    assert_eq!(
        at(&mut manager, Size { cols: 90, rows: 21 }, false),
        Viewport::Applied(Size { cols: 90, rows: 21 }),
    );
    assert_eq!(*notes.lock().unwrap(), vec!["resize:4242:90x21".to_owned()]);
    assert_eq!(
        manager.state("thread-1", "term-1").unwrap().size,
        Size { cols: 90, rows: 21 },
    );

    // The refused gate is the refused resize: the error the client reads, and a record that stayed.
    let failure = manager
        .viewport(
            "thread-1",
            "term-1",
            Size { cols: 10, rows: 8 },
            "2026-11-21T00:00:10.000Z",
            note_resize(&notes, true),
        )
        .expect_err("the child refused");
    assert_eq!(failure.tag(), Some("TerminalResizeError"));
    assert_eq!(
        manager.state("thread-1", "term-1").unwrap().size,
        Size { cols: 90, rows: 21 },
    );
}
