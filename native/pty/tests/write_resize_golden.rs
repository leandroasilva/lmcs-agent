//! The shipped `write` and `resize`, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_WRITE_RESIZE_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-write-resize-trace.ts`. Those two are the last of the nine
//! `TerminalManager` service methods, and neither is observable on the wire by itself: no snapshot and no
//! metadata row carries the viewport, so the capture measured the fake process's counters instead and read
//! the refusal a call hands the transport field by field. This replay recomputes the capture's `A` claims
//! from the seam's own answers, so a match means the port and the shipped call agree on what the client
//! learns and on what the shell was asked to do. A case added to the script has to be scheduled below,
//! because `run` panics on a name it has no schedule for.
//!
//! Claims are compared by id rather than by list order, and the pids come from the capture's own `M` rows
//! rather than from a constant, so the two refusals that interpolate a pid are compared against the number
//! the shipped run named.
//!
//! Three claims the seam cannot reproduce, named here and counted at the end of the run rather than
//! skipped quietly:
//!
//! - `starting-resize-waits-for-the-lock` and `write-does-not-take-the-thread-lock` measure the shipped
//!   `withThreadLock` asymmetry (`write` at Manager.ts:2869 takes none, `resize` at :2908 takes one). The
//!   seam has one owner at a time, so no schedule of its calls can order two sequence numbers. The replay
//!   asserts what the same window says about the records instead, as `starting-resize-is-silent`.
//! - `write-error-renders-cause` reads the JavaScript rendering of whatever the library threw
//!   (`Error: device full`). The port renders an I/O failure its own way, which `Failure::cause` declares
//!   as a divergence; the tag, the message and the fields — the halves the client reads — are compared.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use lmcs_pty::lifecycle::{Exit, LaunchAsk, Reopen, Size, Viewport, Worktree};
use lmcs_pty::manager::{Failure, LogLine, Manager, Open, Opened};
use lmcs_pty::stream::{Frame, Subscriber};
use lmcs_terminal_history::{DEFAULT_TERMINAL_ID, HistoryPersistence};

type Row = Vec<String>;

/// The claims the seam has no way to make, for the reasons in the header.
const UNREPRODUCIBLE: [&str; 3] = [
    "starting-resize-waits-for-the-lock",
    "write-does-not-take-the-thread-lock",
    "write-error-renders-cause",
];

/// One case as the capture wrote it: the ids its steps used, the pids its children had, and the claims.
struct Expected {
    name: String,
    threads: Vec<String>,
    pid: u32,
    claims: Vec<Row>,
}

fn unhex(value: &str) -> String {
    assert!(
        value.len().is_multiple_of(2) && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{value}"
    );
    let bytes: Vec<u8> = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).unwrap()
}

fn hex(value: &str) -> String {
    value.bytes().map(|byte| format!("{byte:02x}")).collect()
}

/// `-` is the capture's absent value; every other field of its rows is data as UTF-8 hex.
fn text(value: &str) -> String {
    match value {
        "-" => "-".to_owned(),
        value => unhex(value),
    }
}

/// The case being read: `(name, threads, pids seen, claims so far)`, assembled into an
/// [`Expected`] when its `X` row arrives.
type Pending = (String, Vec<String>, Vec<u32>, Vec<Row>);

fn parse(trace: &Path) -> (String, Vec<Expected>) {
    let mut default_terminal = String::new();
    let mut cases: Vec<Expected> = Vec::new();
    let mut building: Option<Pending> = None;
    for line in fs::read_to_string(trace).expect("trace file").lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[0] {
            "H" => default_terminal = unhex(fields[1]),
            "C" => {
                assert!(
                    building.is_none(),
                    "a case opened before the last one closed"
                );
                building = Some((
                    unhex(fields[1]),
                    unhex(fields[2]).split(',').map(str::to_owned).collect(),
                    Vec::new(),
                    Vec::new(),
                ));
            }
            // An `M` row is `(view, seq, thread, terminal, status, pid, stamp)` and a pid of `-` is a
            // record that never had a process.
            "M" => {
                let building = building.as_mut().expect("row outside a case");
                if let Ok(pid) = fields[6].parse::<u32>() {
                    building.2.push(pid);
                }
            }
            "A" => building
                .as_mut()
                .expect("claim outside a case")
                .3
                .push(vec![
                    unhex(fields[1]),
                    fields[2].to_owned(),
                    unhex(fields[3]),
                ]),
            "X" => {
                let (name, threads, pids, claims) =
                    building.take().expect("case end without a case");
                assert_eq!(name, text(fields[1]));
                cases.push(Expected {
                    name,
                    threads,
                    // The capture's pids ascend one per spawn, so the lowest is the first child's.
                    pid: pids.iter().copied().min().unwrap_or(7400),
                    claims,
                });
            }
            "Z" => {
                assert_eq!(fields[3], "end");
                assert_eq!(
                    fields[1].parse::<usize>().expect("case count"),
                    cases.len(),
                    "the trace counted cases it did not write"
                );
            }
            _ => {}
        }
    }
    (default_terminal, cases)
}

/// A directory removed on drop, so a failing assertion leaves nothing for the next run to trip over.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("lmcs-write-resize-{name}"));
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

/// The child, as the capture's fake saw it. The counters are the measurement, and the two throw flags are
/// how the capture reached the refusals a real `ioctl` gives.
#[derive(Clone, Debug, Default)]
struct Child {
    writes: usize,
    last_write: String,
    resizes: usize,
    last_cols: i64,
    last_rows: i64,
    throw_write: bool,
    throw_resize: bool,
}

fn fresh() -> Child {
    Child {
        last_cols: -1,
        last_rows: -1,
        ..Child::default()
    }
}

fn throw(reason: &str) -> io::Error {
    io::Error::other(reason.to_owned())
}

/// The library call, held by the closure the seam asks for. The first child is the one every traced case
/// names, because no traced schedule writes to a terminal other than the first.
fn child_write(children: &Rc<RefCell<Vec<Child>>>, data: &str) -> Result<(), io::Error> {
    let mut children = children.borrow_mut();
    let Some(child) = children.first_mut() else {
        return Ok(());
    };
    child.writes += 1;
    if child.throw_write {
        return Err(throw("device full"));
    }
    child.last_write = data.to_owned();
    Ok(())
}

fn child_resize(children: &Rc<RefCell<Vec<Child>>>, size: Size) -> Result<(), io::Error> {
    let mut children = children.borrow_mut();
    let Some(child) = children.first_mut() else {
        return Ok(());
    };
    child.resizes += 1;
    child.last_cols = i64::from(size.cols);
    child.last_rows = i64::from(size.rows);
    if child.throw_resize {
        return Err(throw("ioctl failed"));
    }
    Ok(())
}

/// A view row carries its stamp as the capture's rank, so "the stamp moved" is a rank comparison.
fn rank_of(stamp: &str) -> usize {
    stamp.parse().expect("a stamp rank")
}

fn peek(children: &Rc<RefCell<Vec<Child>>>) -> Child {
    children.borrow().first().cloned().unwrap_or_else(fresh)
}

/// The seam, the children it was told about, and everything the claims read.
struct Replay {
    /// The two owners the replay exists beside: the directory the history files would land in, and the
    /// worker that would take them. Neither is read after construction, and dropping either early would
    /// let the seam write into a directory that no longer exists.
    #[allow(dead_code)]
    logs: TempDir,
    #[allow(dead_code)]
    worker: HistoryPersistence,
    manager: Manager,
    threads: Vec<String>,
    dir: PathBuf,
    children: Rc<RefCell<Vec<Child>>>,
    /// The child counters as each call left them, which is where the capture took its `W` rows.
    samples: Vec<Child>,
    /// Published events, counted the way the capture counted its `subscribe` callbacks: the metadata
    /// subscriber sees exactly one frame per event.
    events: usize,
    views: Vec<Vec<Row>>,
    /// One entry per client call, holding what the capture's return boundary said.
    calls: Vec<(String, String)>,
    /// The last error a call answered with. Sticky, because the capture read its stored error *after*
    /// the next call had already succeeded, and a successful call leaves the one it found alone.
    failure: Option<Failure>,
    spawns: usize,
    clock: usize,
    stamps: Vec<String>,
    fail_spawn: bool,
    pid: u32,
    metadata: Subscriber,
}

impl Replay {
    fn new(name: &str, threads: &[String], pid: u32) -> Self {
        let logs = TempDir::new(name);
        let dir = logs.0.join("cwd");
        fs::create_dir_all(&dir).unwrap();
        let worker = HistoryPersistence::start(logs.0.clone(), drop).unwrap();
        let mut manager = Manager::new(&logs.0, worker.handle(), move |_: LogLine| {});
        // The capture subscribed before its first step, so every event of the case was delivered live
        // rather than held for the initial view. The handshake's own frame is not an event.
        let metadata = manager.subscribe_metadata();
        manager
            .opened_metadata(metadata)
            .expect("a metadata stream that can be handed its view");
        Self {
            logs,
            worker,
            manager,
            threads: threads.to_vec(),
            dir,
            children: Rc::new(RefCell::new(Vec::new())),
            samples: Vec::new(),
            events: 0,
            views: Vec::new(),
            calls: Vec::new(),
            failure: None,
            spawns: 0,
            clock: 0,
            stamps: Vec::new(),
            fail_spawn: false,
            pid,
            metadata,
        }
    }

    fn thread(&self, index: usize) -> String {
        self.threads[index].clone()
    }

    /// The capture's hijacked clock: a fresh ISO text per read, ascending as text so the sessions list
    /// sorts the way the shipped one does.
    fn stamp(&mut self) -> String {
        self.clock += 1;
        format!("2026-01-01T00:00:{:02}.000Z", self.clock)
    }

    /// The capture's `stampLabel`: a stamp's rank is the order it was first seen, so a record re-stamped
    /// before anyone looked costs no new rank.
    fn rank(&mut self, stamp: &str) -> usize {
        if let Some(at) = self.stamps.iter().position(|seen| seen == stamp) {
            return at + 1;
        }
        self.stamps.push(stamp.to_owned());
        self.stamps.len()
    }

    fn count(&mut self, frames: &[(Subscriber, Frame)]) {
        self.events += frames
            .iter()
            .filter(|(subscriber, _)| subscriber == &self.metadata)
            .count();
    }

    fn viewport(&self, asked: Option<(u32, u32)>) -> Option<Size> {
        asked.map(|(cols, rows)| Size { cols, rows })
    }

    /// `open` and the shell its caller owes it. A parked open (the capture's `starting` case) starts in
    /// [`Replay::start_child`] instead, which is what leaves the record `starting` across the calls.
    fn open(&mut self, id: &str, thread: usize, terminal: &str, asked: Option<(u32, u32)>) {
        let created = self.open_record(id, thread, terminal, asked);
        if created && self.fail_spawn {
            let thread_id = self.thread(thread);
            self.fail_spawn(&thread_id, terminal, asked);
        } else if created {
            let thread_id = self.thread(thread);
            self.start_child(&thread_id, terminal, asked);
        }
    }

    /// The seam's half of `openLocked`, with the viewport gate of its kept-process branch (:2626-2631)
    /// run beside it, because that is the step the capture's follow-up `open` crossed in `resize-throws`.
    fn open_record(
        &mut self,
        id: &str,
        thread: usize,
        terminal: &str,
        asked: Option<(u32, u32)>,
    ) -> bool {
        let thread_id = self.thread(thread);
        let ask = LaunchAsk {
            cwd: self.dir.to_string_lossy().into_owned(),
            worktree: Worktree::Unnamed,
            env: None,
        };
        let at = self.stamp();
        let opened = self.manager.open(&Open {
            thread_id: &thread_id,
            terminal_id: terminal,
            ask: &ask,
            requested: self.viewport(asked),
            at: &at,
        });
        match opened {
            Ok(Opened::Created) => true,
            Ok(Opened::Existing(Reopen::Kept)) => {
                self.calls.push((format!("open:{id}"), "ok".to_owned()));
                if let Some(asked) = self.viewport(asked) {
                    // The shipped gate compares against the *record*, which is what the capture's
                    // `thrown-size-not-remembered` claim says a failed call leaves untouched.
                    let remembered = self.manager.state_size(&thread_id, terminal);
                    let at = self.stamp();
                    let children = self.children.clone();
                    let outcome = self.manager.viewport(
                        &thread_id,
                        terminal,
                        asked,
                        &at,
                        move |_pid, size| child_resize(&children, size),
                    );
                    let expected = if remembered == Some(asked) {
                        Viewport::Unchanged
                    } else {
                        Viewport::Applied(asked)
                    };
                    assert_eq!(
                        outcome.expect("a gate whose library call succeeds"),
                        expected,
                        "the viewport gate answered something else for {thread}/{terminal}"
                    );
                }
                false
            }
            Ok(Opened::Existing(reopen)) => {
                panic!("the traced schedules never reopen into {reopen:?}")
            }
            Err(failure) => {
                self.calls.push((
                    format!("open:{id}"),
                    format!("err:{}", failure.tag().unwrap_or("defect")),
                ));
                self.failure = Some(failure);
                false
            }
        }
    }

    /// The spawn the record was created for, reported back in as `startSession`'s success path.
    fn start_child(&mut self, thread_id: &str, terminal: &str, asked: Option<(u32, u32)>) {
        self.spawns += 1;
        let pid = self.pid + self.spawns as u32 - 1;
        self.children.borrow_mut().push(fresh());
        let at = self.stamp();
        let frames = self
            .manager
            .start(thread_id, terminal, pid, self.viewport(asked), &at);
        self.count(&frames);
        let stamp = self
            .manager
            .state(thread_id, terminal)
            .expect("a started record")
            .updated_at
            .clone();
        self.rank(&stamp);
    }

    fn fail_spawn(&mut self, thread_id: &str, terminal: &str, asked: Option<(u32, u32)>) {
        let at = self.stamp();
        let frames = self.manager.fail_start(
            thread_id,
            terminal,
            "Failed to spawn PTY: terminal-manager: /bin/sh",
            self.viewport(asked),
            &at,
        );
        self.count(&frames);
    }

    fn write(&mut self, thread: usize, terminal: &str, data: &str) -> bool {
        let thread_id = self.thread(thread);
        let children = self.children.clone();
        let payload = data.to_owned();
        let outcome = self.manager.write(&thread_id, terminal, move |_pid| {
            child_write(&children, &payload)
        });
        let status = match &outcome {
            Ok(_) => "ok".to_owned(),
            Err(failure) => format!("err:{}", failure.tag().unwrap_or("defect")),
        };
        self.calls.push(("write".to_owned(), status));
        match outcome {
            Ok(_) => true,
            Err(failure) => {
                self.failure = Some(failure);
                false
            }
        }
    }

    fn resize(&mut self, thread: usize, terminal: &str, cols: u32, rows: u32) -> bool {
        let thread_id = self.thread(thread);
        let children = self.children.clone();
        let at = self.stamp();
        let outcome =
            self.manager
                .resize(&thread_id, terminal, cols, rows, &at, move |_pid, size| {
                    child_resize(&children, size)
                });
        let status = match &outcome {
            Ok(()) => "ok".to_owned(),
            Err(failure) => format!("err:{}", failure.tag().unwrap_or("defect")),
        };
        self.calls.push(("resize".to_owned(), status));
        match outcome {
            Ok(()) => true,
            Err(failure) => {
                self.failure = Some(failure);
                false
            }
        }
    }

    fn view(&mut self) {
        let mut rows = Vec::new();
        for row in self.manager.view() {
            let stamp = self.rank(&row.updated_at).to_string();
            rows.push(vec![
                row.thread_id.clone(),
                row.terminal_id.clone(),
                row.status.as_str().to_owned(),
                row.pid.map(|pid| pid.to_string()).unwrap_or("-".to_owned()),
                stamp,
            ]);
        }
        self.views.push(rows);
    }

    fn sample(&mut self) {
        self.samples.push(peek(&self.children));
    }

    fn set_throw(&mut self, write: bool, resize: bool) {
        let mut children = self.children.borrow_mut();
        let Some(child) = children.first_mut() else {
            panic!("a case that throws has a child");
        };
        child.throw_write = write;
        child.throw_resize = resize;
    }

    /// The capture's `boundaryOf`: the status the nth call of a kind returned.
    fn status_of(&self, kind: &str, index: usize) -> String {
        self.calls
            .iter()
            .filter(|(named, _)| named == kind)
            .nth(index)
            .map(|(_, status)| status.clone())
            .unwrap_or_else(|| "missing".to_owned())
    }

    fn fields(&self) -> String {
        self.failure
            .as_ref()
            .and_then(Failure::fields)
            .map(|fields| {
                fields
                    .iter()
                    .map(|(name, value)| format!("{name}={value}"))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_else(|| "missing".to_owned())
    }

    fn message(&self) -> String {
        self.failure
            .as_ref()
            .map(Failure::message)
            .unwrap_or_else(|| "missing".to_owned())
    }

    fn last(&self) -> Child {
        self.samples
            .last()
            .cloned()
            .unwrap_or_else(|| peek(&self.children))
    }

    fn claim(&mut self, claims: &mut Vec<Row>, id: &str, held: bool, detail: String) {
        claims.push(vec![
            id.to_owned(),
            if held { "match" } else { "diff" }.to_owned(),
            detail,
        ]);
    }

    fn run(&mut self, name: &str) -> Vec<Row> {
        let mut claims = Vec::new();
        match name {
            "running" => self.running(&mut claims),
            "write-passthrough" => self.write_passthrough(&mut claims),
            "resize-reorders-quietly" => self.resize_reorders(&mut claims),
            "resize-same-size" => self.resize_same_size(&mut claims),
            "exited" => self.exited(&mut claims),
            "failed-start" => self.failed_start(&mut claims),
            "starting" => self.starting(&mut claims),
            "absent" => self.absent(&mut claims),
            "after-close" => self.after_close(&mut claims),
            "write-throws" => self.write_throws(&mut claims),
            "resize-throws" => self.resize_throws(&mut claims),
            "other-thread" => self.other_thread(&mut claims),
            other => panic!("no schedule for the traced case {other}"),
        }
        claims
    }
}

impl Replay {
    fn running(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", Some((100, 24)));
        self.view();
        self.write(0, "term-1", "ls\n");
        self.sample();
        self.view();
        self.resize(0, "term-1", 80, 20);
        self.sample();
        self.view();
        let after = self.last();
        self.claim(
            claims,
            "write-succeeds",
            self.status_of("write", 0) == "ok",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "resize-succeeds",
            self.status_of("resize", 0) == "ok",
            self.status_of("resize", 0),
        );
        self.claim(
            claims,
            "write-reaches-pty",
            after.writes == 1,
            format!("writes={}", after.writes),
        );
        self.claim(
            claims,
            "write-payload-verbatim",
            after.last_write == "ls\n",
            hex(&after.last_write),
        );
        self.claim(
            claims,
            "resize-reaches-pty",
            after.resizes == 1,
            format!("resizes={}", after.resizes),
        );
        self.claim(
            claims,
            "resize-args",
            after.last_cols == 80 && after.last_rows == 20,
            format!("{}x{}", after.last_cols, after.last_rows),
        );
        self.claim(
            claims,
            "neither-publishes",
            self.events == 1,
            format!("{} events", self.events),
        );
        let before = self.views[0][0][4].clone();
        let after_write = self.views[1][0][4].clone();
        let after_resize = self.views[2][0][4].clone();
        self.claim(
            claims,
            "write-leaves-stamp-alone",
            before == after_write,
            format!("{before}->{after_write}"),
        );
        self.claim(
            claims,
            "resize-moves-stamp",
            rank_of(&after_resize) > rank_of(&after_write),
            format!("{after_write}->{after_resize}"),
        );
    }

    fn write_passthrough(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        for data in ["", "\r", "á\n\t"] {
            self.write(0, "term-1", data);
            self.sample();
        }
        for (id, writes, expected) in [
            ("empty-write-reaches-pty", 1, ""),
            ("carriage-untouched", 2, "\r"),
            ("tab-and-multibyte-untouched", 3, "á\n\t"),
        ] {
            let rows: Vec<&Child> = self
                .samples
                .iter()
                .filter(|sample| sample.writes == writes)
                .collect();
            let held = rows.iter().any(|sample| sample.last_write == expected);
            self.claim(claims, id, held, format!("rows={}", rows.len()));
        }
        self.claim(
            claims,
            "writes-publish-nothing",
            self.events == 1,
            self.events.to_string(),
        );
    }

    fn resize_reorders(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        self.open("open-2", 0, "term-2", None);
        self.view();
        self.resize(0, "term-1", 90, 30);
        self.view();
        let before: Vec<&str> = self.views[0].iter().map(|row| row[1].as_str()).collect();
        let after: Vec<&str> = self.views[1].iter().map(|row| row[1].as_str()).collect();
        self.claim(
            claims,
            "resized-row-moves-first",
            before.first() == Some(&"term-2") && after.first() == Some(&"term-1"),
            format!("{}|{}", before.join(","), after.join(",")),
        );
        self.claim(
            claims,
            "reorder-publishes-nothing",
            self.events == 2,
            self.events.to_string(),
        );
        let child = peek(&self.children);
        self.claim(
            claims,
            "only-one-pty-resized",
            child.resizes == 1,
            format!("resizes={}", child.resizes),
        );
    }

    fn resize_same_size(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", Some((100, 24)));
        self.resize(0, "term-1", 100, 24);
        self.resize(0, "term-1", 100, 24);
        self.sample();
        let child = self.last();
        self.claim(
            claims,
            "no-size-gate-on-resize",
            child.resizes == 2,
            format!("resizes={}", child.resizes),
        );
        self.claim(
            claims,
            "repeat-resize-quiet",
            self.events == 1,
            self.events.to_string(),
        );
        let moves = self
            .calls
            .iter()
            .filter(|(kind, status)| kind == "resize" && status == "ok")
            .count();
        self.claim(
            claims,
            "both-resizes-succeed",
            moves == 2,
            format!("ok={moves}"),
        );
    }

    fn exited(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        let sequence = self
            .manager
            .snapshot(&self.thread(0), "term-1")
            .expect("the opened record")
            .sequence
            .expect("a started record has a sequence");
        let at = self.stamp();
        let frames = self.manager.exit(
            &self.thread(0),
            "term-1",
            sequence,
            Exit {
                exit_code: Some(0),
                exit_signal: None,
            },
            &at,
        );
        self.count(&frames);
        self.view();
        self.write(0, "term-1", "echo\n");
        self.sample();
        self.resize(0, "term-1", 60, 10);
        self.sample();
        self.view();
        let after = self.last();
        self.claim(
            claims,
            "exited-write-is-ok",
            self.status_of("write", 0) == "ok",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "exited-write-drops-input",
            after.writes == 0,
            format!("writes={}", after.writes),
        );
        self.claim(
            claims,
            "exited-resize-is-ok",
            self.status_of("resize", 0) == "ok",
            self.status_of("resize", 0),
        );
        self.claim(
            claims,
            "exited-resize-skips-library",
            after.resizes == 0,
            format!("resizes={}", after.resizes),
        );
        let before = self.views[0][0][4].clone();
        let later = self.views[1][0][4].clone();
        self.claim(
            claims,
            "exited-resize-leaves-stamp",
            before == later,
            format!("{before}->{later}"),
        );
        self.claim(
            claims,
            "exited-status-after-calls",
            self.views[1][0][2] == "exited",
            self.views[1][0][2].clone(),
        );
    }

    fn failed_start(&mut self, claims: &mut Vec<Row>) {
        self.fail_spawn = true;
        let thread_id = self.thread(0);
        assert!(
            self.open_record("open-1", 0, "term-1", None),
            "a failed start still creates its record"
        );
        self.fail_spawn(&thread_id, "term-1", None);
        self.view();
        self.write(0, "term-1", "x");
        self.sample();
        self.claim(
            claims,
            "error-write-names-status",
            self.status_of("write", 0) == "err:TerminalNotRunningError",
            self.status_of("write", 0),
        );
        let resize = self.resize(0, "term-1", 40, 8);
        self.sample();
        self.claim(
            claims,
            "error-resize-is-ok",
            resize,
            self.status_of("resize", 0),
        );
        self.claim(
            claims,
            "not-running-fields",
            self.fields() == "threadId=thread-a,terminalId=term-1",
            self.fields(),
        );
        let message = self.message();
        self.claim(
            claims,
            "not-running-message",
            message == "Terminal is not running for thread: thread-a, terminal: term-1",
            hex(&message),
        );
        self.claim(
            claims,
            "error-resize-publishes-nothing",
            self.events == 1,
            self.events.to_string(),
        );
    }

    fn starting(&mut self, claims: &mut Vec<Row>) {
        // The capture parked the spawn, so the open had returned a `starting` record before anything
        // became `running`. The seam's same window is the gap between `open_record` and `start_child`.
        let thread_id = self.thread(0);
        assert!(
            self.open_record("open-1", 0, "term-1", None),
            "the parked open is a create"
        );
        self.view();
        self.write(0, "term-1", "x");
        self.sample();
        self.claim(
            claims,
            "starting-write-refuses",
            self.status_of("write", 0) == "err:TerminalNotRunningError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "starting-write-reaches-no-process",
            self.last().writes == 0,
            format!("writes={}", self.last().writes),
        );
        let held = self.resize(0, "term-1", 120, 40);
        self.sample();
        self.claim(
            claims,
            "starting-resize-is-silent",
            held && self.last().resizes == 0
                && self.views[0][0][4] == self.views.last().unwrap()[0][4],
            format!("resizes={}", self.last().resizes),
        );
        self.start_child(&thread_id, "term-1", None);
        self.resize(0, "term-1", 120, 40);
        self.sample();
        self.view();
        let after = self.last();
        self.claim(
            claims,
            "held-resize-applies-after-the-open",
            after.resizes == 1 && after.last_cols == 120 && after.last_rows == 40,
            format!(
                "resizes={} {}x{}",
                after.resizes, after.last_cols, after.last_rows
            ),
        );
        self.claim(
            claims,
            "held-open-eventually-runs",
            self.views[1][0][2] == "running",
            self.views[1][0][2].clone(),
        );
    }

    fn absent(&mut self, claims: &mut Vec<Row>) {
        self.write(0, "term-1", "x");
        self.claim(
            claims,
            "absent-write-is-a-lookup",
            self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        let resize = self.resize(0, "term-1", 80, 20);
        self.claim(
            claims,
            "absent-resize-is-ok",
            resize,
            self.status_of("resize", 0),
        );
        let message = self.message();
        self.claim(
            claims,
            "lookup-message",
            message == "Unknown terminal thread: thread-a, terminal: term-1",
            hex(&message),
        );
        self.claim(
            claims,
            "absent-publishes-nothing",
            self.events == 0,
            self.events.to_string(),
        );
        self.claim(
            claims,
            "absent-spawns-nothing",
            self.spawns == 0,
            format!("spawns={}", self.spawns),
        );
    }

    fn after_close(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        let thread_id = self.thread(0);
        let frames = self
            .manager
            .close(&thread_id, Some("term-1"), None)
            .expect("a close of a record the replay owns");
        self.count(&frames);
        self.write(0, "term-1", "x");
        self.claim(
            claims,
            "closed-write-is-a-lookup",
            self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        let resize = self.resize(0, "term-1", 80, 20);
        self.claim(
            claims,
            "closed-resize-is-ok",
            resize,
            self.status_of("resize", 0),
        );
        let last = peek(&self.children);
        self.claim(
            claims,
            "closed-process-untouched",
            last.writes == 0 && last.resizes == 0,
            format!("writes={} resizes={}", last.writes, last.resizes),
        );
    }

    fn write_throws(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        self.set_throw(true, false);
        let write = self.write(0, "term-1", "x");
        self.sample();
        self.claim(
            claims,
            "throwing-write-is-named",
            !write && self.status_of("write", 0) == "err:TerminalWriteError",
            self.status_of("write", 0),
        );
        let fields = self.fields();
        self.claim(
            claims,
            "write-error-names-the-pid",
            fields.starts_with("threadId=thread-a,terminalId=term-1,terminalPid="),
            hex(&fields),
        );
        let message = self.message();
        self.claim(
            claims,
            "write-error-message",
            message.starts_with("Failed to write to terminal for thread: thread-a"),
            hex(&message),
        );
        self.view();
        self.claim(
            claims,
            "throwing-write-leaves-session-running",
            self.views[0][0][2] == "running",
            self.views[0][0][2].clone(),
        );
        self.claim(
            claims,
            "throwing-write-publishes-nothing",
            self.events == 1,
            self.events.to_string(),
        );
        self.set_throw(false, false);
        let later = self.write(0, "term-1", "y");
        self.sample();
        self.claim(
            claims,
            "later-write-still-works",
            later,
            self.status_of("write", 1),
        );
    }

    fn resize_throws(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", Some((100, 24)));
        self.view();
        self.set_throw(false, true);
        let resize = self.resize(0, "term-1", 80, 20);
        self.sample();
        self.claim(
            claims,
            "throwing-resize-is-named",
            !resize && self.status_of("resize", 0) == "err:TerminalResizeError",
            self.status_of("resize", 0),
        );
        let fields = self.fields();
        self.claim(
            claims,
            "resize-error-carries-size",
            fields
                == format!(
                    "threadId=thread-a,terminalId=term-1,terminalPid={},cols=80,rows=20",
                    self.pid
                ),
            hex(&fields),
        );
        let message = self.message();
        self.claim(
            claims,
            "resize-error-message",
            message
                == format!(
                    "Failed to resize terminal for thread: thread-a, terminal: term-1, PID: {} to 80x20",
                    self.pid
                ),
            hex(&message),
        );
        self.set_throw(false, false);
        assert!(
            !self.open_record("open-2", 0, "term-1", Some((80, 20))),
            "the follow-up open found the record it was tracing"
        );
        self.resize(0, "term-1", 90, 21);
        assert!(
            !self.open_record("open-3", 0, "term-1", Some((90, 21))),
            "the third open found it too"
        );
        self.sample();
        let processes = self.children.borrow().len();
        self.claim(
            claims,
            "no-extra-spawn",
            processes == 1,
            format!("processes={processes}"),
        );
        let child = self.last();
        self.claim(
            claims,
            "thrown-size-not-remembered",
            child.resizes == 3,
            format!("resizes={}", child.resizes),
        );
        self.claim(
            claims,
            "kept-size-gates-the-next-open",
            child.last_cols == 90 && child.last_rows == 21,
            format!("{}x{}", child.last_cols, child.last_rows),
        );
        self.claim(
            claims,
            "resize-failure-publishes-nothing",
            self.events == 1,
            self.events.to_string(),
        );
    }

    fn other_thread(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        self.write(1, "term-1", "x");
        self.claim(
            claims,
            "other-thread-write-is-a-lookup",
            self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        let resize = self.resize(1, "term-1", 80, 20);
        self.claim(
            claims,
            "other-thread-resize-is-ok",
            resize,
            self.status_of("resize", 0),
        );
        let last = peek(&self.children);
        self.claim(
            claims,
            "other-thread-calls-touch-nothing",
            last.writes == 0 && last.resizes == 0,
            format!("writes={} resizes={}", last.writes, last.resizes),
        );
        self.view();
        let rows = self.views[0].clone();
        self.claim(
            claims,
            "other-thread-creates-no-session",
            rows.len() == 1 && rows.iter().all(|row| row[0] == "thread-a"),
            rows.iter()
                .map(|row| row[0].clone())
                .collect::<Vec<_>>()
                .join(","),
        );
        let stamp = rows[0][4].clone();
        self.claim(
            claims,
            "other-thread-resize-stamps-nothing",
            stamp == "1",
            format!("stamp={stamp}"),
        );
    }
}

#[test]
fn replays_shipped_write_and_resize() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_WRITE_RESIZE_TRACE") else {
        eprintln!(
            "skipped write/resize golden: LMCS_TERMINAL_WRITE_RESIZE_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let trace = PathBuf::from(trace);
    let (default_terminal, cases) = parse(&trace);
    assert_eq!(default_terminal, DEFAULT_TERMINAL_ID);

    let mut compared = 0usize;
    let mut skipped = 0usize;
    let mut extra: Vec<String> = Vec::new();
    for case in &cases {
        let mut replay = Replay::new(&case.name, &case.threads, case.pid);
        let claims = replay.run(&case.name);
        let mine: BTreeMap<&str, (&str, &str)> = claims
            .iter()
            .map(|claim| (claim[0].as_str(), (claim[1].as_str(), claim[2].as_str())))
            .collect();
        let theirs: BTreeSet<&str> = UNREPRODUCIBLE.into_iter().collect();
        for claim in &case.claims {
            if theirs.contains(claim[0].as_str()) {
                skipped += 1;
                continue;
            }
            let found = mine
                .get(claim[0].as_str())
                .unwrap_or_else(|| panic!("{} never recomputed {}", case.name, claim[0]));
            assert_eq!(
                *found,
                (claim[1].as_str(), claim[2].as_str()),
                "{} recomputed {} differently from the capture",
                case.name,
                claim[0]
            );
            compared += 1;
        }
        extra.extend(
            claims
                .iter()
                .map(|claim| claim[0].clone())
                .filter(|id| case.claims.iter().all(|claim| &claim[0] != id)),
        );
    }
    assert_eq!(
        extra,
        vec!["starting-resize-is-silent".to_owned()],
        "the replay made a claim the capture did not, or lost the one it declares"
    );
    eprintln!(
        "write/resize golden: {} cases, {} claims recomputed, {} skipped as unportable, from {}",
        cases.len(),
        compared,
        skipped,
        trace.display()
    );
}
