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

use lmcs_pty::lifecycle::{Exit, LaunchAsk, Size, Status, Worktree};
use lmcs_pty::manager::{Failure, LogLine, Manager, Open, Opened, Restart};
use lmcs_terminal_history::{DEFAULT_TERMINAL_ID, HistoryPersistence, history_path, legacy_history_path};

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
        let path = std::env::temp_dir().join(format!(
            "lmcs-manager-{}-{name}",
            std::process::id()
        ));
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

fn open(manager: &mut Manager, fixture: &Fixture, terminal: &str, cwd: &Path) -> Result<Opened, Failure> {
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
        format!("Terminal cwd is not a directory: {}", fixture.file.display()),
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
    assert_eq!(
        open(&mut manager, &fixture, "term-1", &fixture.dir),
        Ok(Opened::Created)
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
    fs::write(history_path(&fixture.logs.0, "thread-1", "term-1"), &history).unwrap();
    let frames = manager.attach("thread-1", "term-1");

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
    assert!(
        manager.close("thread-1", Some("term-1"), None).unwrap().is_empty(),
        "the refusal published nothing to a live subscriber",
    );
    assert!(lines.lock().unwrap().is_empty());
    let _ = frames;
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

    assert_eq!(
        open(&mut manager, &fixture, DEFAULT_TERMINAL_ID, &fixture.dir),
        Ok(Opened::Created)
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
        frames.iter().all(|(id, _)| *id == subscriber || *id == metadata),
        "a transition reaches only the subscribers that registered",
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

    let frames = manager.clear("thread-1", "term-1", "2026-11-21T00:00:02.000Z").unwrap();
    let kinds: Vec<&str> = frames.iter().map(|(_, frame)| frame.kind()).collect();
    assert_eq!(kinds, ["cleared"], "one frame, for the stream that keeps cleared");

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
    let lines = recorder();
    let mut manager = fixture.manager(lines.clone());
    open(&mut manager, &fixture, "term-1", &fixture.dir).unwrap();
    manager.start("thread-1", "term-1", 4242, None, "2026-11-21T00:00:01.000Z");
    // The legacy name is the one file of this terminal the sweep and the single close both try to
    // remove and cannot: an unlink of a directory refuses on either host.
    fs::create_dir(legacy_history_path(&fixture.logs.0, "thread-1")).unwrap();
    let subscriber = manager.attach("thread-1", "term-1");

    let frames = manager
        .close("thread-1", Some("term-1"), Some(true))
        .unwrap();
    assert_eq!(
        frames.iter().map(|(_, frame)| frame.kind()).collect::<Vec<_>>(),
        ["closed"],
        "the close still publishes, exactly once, to the live subscriber",
    );
    assert_eq!(
        frames.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        [subscriber],
    );

    let logged = lines.lock().unwrap().clone();
    assert_eq!(logged.len(), 1, "one surviving file is one warning: {logged:?}");
    assert_eq!(logged[0].message, "failed to delete terminal history");
    assert_eq!(
        logged[0]
            .fields
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>(),
        ["threadId", "terminalId", "error"],
        "the shipped object literal's own key order",
    );
    assert_eq!(logged[0].fields[0].1, "thread-1");
    assert_eq!(logged[0].fields[1].1, "term-1");
    // The cause's spelling is the operating system's, and the two hosts refuse an unlink of a directory
    // with different errnos (see `lifecycle::render_cause`); only its shape is the port's.
    assert!(
        logged[0].fields[2].1.starts_with("PlatformError/")
            && logged[0].fields[2].1.ends_with("/remove"),
        "the cause renders as a failed remove: {}",
        logged[0].fields[2].1,
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

    let frames = manager.close("thread-1", None, Some(true)).unwrap();
    assert_eq!(
        frames.iter().map(|(_, frame)| frame.kind()).collect::<Vec<_>>(),
        ["closed"],
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

    let frames = manager.close("thread-1", Some("term-1"), Some(false)).unwrap();
    assert_eq!(frames.iter().map(|(_, frame)| frame.kind()).collect::<Vec<_>>(), ["closed"]);
    assert_eq!(fs::read(&path).unwrap(), b"kept\n");
    assert!(lines.lock().unwrap().is_empty());

    // The absent flag is a different input from `false`, and neither removes.
    let frames = manager.close("thread-1", Some("term-1"), None).unwrap();
    assert!(
        frames.is_empty(),
        "a second close of an absent record publishes nothing",
    );
    assert!(lines.lock().unwrap().is_empty());
    assert!(path.exists());
}

#[test]
fn a_legacy_cleanup_line_names_the_thread_and_the_remove() {
    // The renderer rather than a fabricated filesystem state: whether the shipped unlink fails is the
    // loader's test to make, and this is about the line the owner is handed. A synthetic cause keeps it
    // identical on both hosts.
    let line = LogLine::legacy(
        "thread-9",
        &std::io::Error::from_raw_os_error(if cfg!(target_os = "macos") { 13 } else { 13 }),
    );
    assert_eq!(line.message, "failed to remove legacy terminal history");
    assert_eq!(
        line.fields,
        vec![
            ("threadId", "thread-9".to_owned()),
            ("error", "PlatformError/PermissionDenied/remove".to_owned()),
        ],
    );
}
