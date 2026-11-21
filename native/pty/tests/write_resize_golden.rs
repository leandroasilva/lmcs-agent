//! The shipped `write` and `resize`, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_WRITE_RESIZE_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-write-resize-trace.ts`. Those two are the last of the nine
//! `TerminalManager` service methods, and neither is observable on the wire by itself: no snapshot and no
//! metadata row carries the viewport, so the capture measured the fake process's counters instead, and it
//! read the error a refusal hands the transport field by field. This replay recomputes the same claims from
//! the seam's own answers, so a match means the port and the shipped call agree on what the client learns
//! and on what the shell was asked to do.
//!
//! The claims are the expectations: every `A` row is recomputed here from the replay's own observation and
//! compared in id, verdict and detail, and a case added to the script has to be scheduled below.
//!
//! Three claims the seam cannot reproduce, each named where the replay skips it rather than quietly:
//!
//! - `starting-resize-waits-for-the-lock` and `write-does-not-take-the-thread-lock` are about the shipped
//!   `withThreadLock` asymmetry (`write` at Manager.ts:2869 takes none, `resize` at :2908 takes one). The
//!   seam has one owner at a time, so no interleaving of its calls can order two sequence numbers.
//! - `write-error-renders-cause` reads the JavaScript rendering of whatever the library threw
//!   (`Error: device full`). The port renders an I/O failure its own way
//!   (`PlatformError/<reason>/write`), which `Failure::cause` documents as a divergence; the tag, the
//!   message and the fields — the three halves the client reads — are compared.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use lmcs_pty::lifecycle::{Exit, LaunchAsk, Reopen, Size, Viewport, Worktree};
use lmcs_pty::manager::{Failure, Manager, Open, Opened};
use lmcs_pty::stream::{Frame, Subscriber};
use lmcs_terminal_history::{DEFAULT_TERMINAL_ID, HistoryPersistence};

type Row = Vec<String>;

/// One child, as the capture's fake saw it: the counters are the measurement, and the two throw flags are
/// how the capture reached the two refusals a real `ioctl` gives.
#[derive(Clone, Debug, Default)]
struct Child {
    writes: usize,
    last_write: String,
    resizes: usize,
    last_cols: i64,
    last_rows: i64,
    kills: usize,
    throw_write: bool,
    throw_resize: bool,
}

impl Child {
    fn new() -> Self {
        Self {
            last_cols: -1,
            last_rows: -1,
            ..Self::default()
        }
    }
}

struct Expected {
    name: String,
    /// `(id, verdict, detail)`, in the order the script wrote them.
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
    value
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/// `-` is the capture's absent value; every other field is its data as UTF-8 hex.
fn text(value: &str) -> String {
    match value {
        "-" => "-".to_owned(),
        value => unhex(value),
    }
}

fn parse(trace: &Path) -> (String, Vec<Expected>) {
    let mut default_terminal = String::new();
    let mut cases: Vec<Expected> = Vec::new();
    let mut building: Option<Expected> = None;
    for line in fs::read_to_string(trace).expect("trace file").lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[0] {
            "H" => default_terminal = unhex(fields[1]),
            "C" => {
                assert!(
                    building.is_none(),
                    "a case opened before the last one closed"
                );
                building = Some(Expected {
                    name: unhex(fields[1]),
                    claims: Vec::new(),
                });
            }
            "A" => building
                .as_mut()
                .expect("claim outside a case")
                .claims
                .push(vec![unhex(fields[1]), fields[2].to_owned(), unhex(fields[3])]),
            "X" => {
                let case = building.take().expect("case end without a case");
                assert_eq!(case.name, text(fields[1]));
                cases.push(case);
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

/// The view row the capture's `stampLabel` produced: a stamp's rank is the order it was first seen, so a
/// record re-stamped before anyone looked costs no new rank.
struct Stamps {
    seen: Vec<String>,
}

impl Stamps {
    fn rank(&mut self, stamp: &str) -> usize {
        if let Some(at) = self.seen.iter().position(|seen| seen == stamp) {
            return at + 1;
        }
        self.seen.push(stamp.to_owned());
        self.seen.len()
    }
}

/// The seam, its one child per terminal, and everything the claims read.
struct Replay {
    manager: Manager,
    logs: TempDir,
    worker: HistoryPersistence,
    threads: Vec<String>,
    dir: PathBuf,
    clock: RefCell<usize>,
    stamps: RefCell<Stamps>,
    /// One entry per child the replay started, in pid order.
    children: Vec<Child>,
    /// Snapshots of the child under test, taken where the capture took a `W` row.
    samples: Vec<Child>,
    /// The published events, counted the way the capture counted its `subscribe` callbacks.
    events: Vec<String>,
    /// The `view` steps, each the rows the manager sorted.
    views: Vec<Vec<Row>>,
    /// `(kind, status)` for every call, in the order the capture wrote its `B` rows.
    boundaries: Vec<(String, String)>,
    /// The refusal the last call handed the transport.
    failure: Option<Failure>,
    spawns: usize,
    metadata: Subscriber,
}

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

impl Replay {
    fn new(name: &str, threads: &[&str]) -> Self {
        let logs = TempDir::new(name);
        let dir = logs.0.join("cwd");
        fs::create_dir_all(&dir).unwrap();
        let worker = HistoryPersistence::start(logs.0.clone(), drop).unwrap();
        let mut manager = Manager::new(&logs.0, worker.handle(), drop);
        let metadata = manager.subscribe_metadata();
        Self {
            manager,
            logs,
            worker,
            threads: threads.iter().map(|thread| (*thread).to_owned()).collect(),
            dir,
            clock: RefCell::new(0),
            stamps: RefCell::new(Stamps { seen: Vec::new() }),
            children: Vec::new(),
            samples: Vec::new(),
            events: Vec::new(),
            views: Vec::new(),
            boundaries: Vec::new(),
            failure: None,
            spawns: 0,
            metadata,
        }
    }

    fn thread(&self, index: usize) -> String {
        self.threads[index].clone()
    }

    /// The capture's `Date.now` hijack: a fresh ISO text per read.
    fn stamp(&self) -> String {
        let mut clock = self.clock.borrow_mut();
        *clock += 1;
        format!("2026-01-01T00:00:00.00{clock}Z")
    }

    fn ask(&self, thread: usize) -> LaunchAsk {
        LaunchAsk {
            cwd: self.dir.to_string_lossy().into_owned(),
            worktree: Worktree::Unnamed,
            env: None,
        }
    }

    fn note(&mut self, event: &lmcs_pty::stream::Publication) {
        let _ = event;
    }

    /// The frames a call handed back are the capture's `O` rows: one per published event. The metadata
    /// subscriber sees exactly one frame per event, which is what makes the count comparable.
    fn count(&mut self, frames: &[(Subscriber, Frame)]) {
        for (subscriber, frame) in frames {
            if subscriber != &self.metadata {
                continue;
            }
            match frame {
                Frame::Metadata(_) => self
                    .events
                    .push(frame.kind().strip_prefix("terminal").unwrap_or("event").to_owned()),
                Frame::Attach(_) => {}
            }
        }
    }

    fn ask_size(&self, asked: Option<(u32, u32)>) -> Option<Size> {
        asked.map(|(cols, rows)| Size { cols, rows })
    }

    /// `open`, then the shell the caller owes it. The capture's fake answered every spawn with a new pid
    /// and never failed unless `failSpawn` was on, so the pid the record carries is the one the next
    /// child index names.
    fn open(&mut self, id: &str, thread: usize, terminal: &str, asked: Option<(u32, u32)>) {
        self.boundaries.push((format!("open:{id}"), "-".to_owned()));
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
            requested: self.ask_size(asked),
            at: &at,
        });
        let created = match &opened {
            Ok(Opened::Created) => true,
            Ok(Opened::Existing(Reopen::Kept)) | Ok(Opened::Existing(Reopen::Stopped { .. }))
            | Ok(Opened::Existing(Reopen::Reset)) => {
                self.boundaries.push((format!("open:{id}"), "ok".to_owned()));
                self.reopen_gate(&thread_id, terminal, asked);
                return;
            }
            Ok(Opened::Existing(Reopen::Missing)) => unreachable!("the table had the record"),
            Err(failure) => {
                self.failure = Some(Failure::Persist(io_error(failure)));
                self.boundaries
                    .push((format!("open:{id}"), format!("err:{}", failure.message())));
                return;
            }
        };
        if !created {
            unreachable!("the match above covers every answer");
        }
        if self.fail_spawn {
            let at = self.stamp();
            let frames = self.manager.fail_start(
                &thread_id,
                terminal,
                "Failed to spawn PTY: terminal-manager",
                self.ask_size(asked),
                &at,
            );
            self.count(&frames);
            self.boundaries.push((format!("open:{id}"), "ok".to_owned()));
            return;
        }
        self.spawns += 1;
        self.children.push(Child::new());
        let pid = self.pid();
        let at = self.stamp();
        let frames = self
            .manager
            .start(&thread_id, terminal, pid, self.ask_size(asked), &at);
        self.count(&frames);
        let stamp = self
            .manager
            .state(&thread_id, terminal)
            .expect("a started record")
            .updated_at
            .clone();
        self.rank(&stamp);
        self.boundaries.push((format!("open:{id}"), "ok".to_owned()));
    }

    /// The viewport half of `openLocked` for a record that kept its process (:2626-2631), which is the
    /// step the capture's follow-up `open` crossed in `resize-throws`.
    fn reopen_gate(&mut self, thread_id: &str, terminal: &str, asked: Option<(u32, u32)>) {
        let Some((cols, rows)) = asked else { return };
        let at = self.stamp();
        let outcome = self.manager.viewport(
            thread_id,
            terminal,
            Size { cols, rows },
            &at,
            |pid, size| self.call_resize(pid, size),
        );
        if let Err(failure) = outcome {
            self.failure = Some(failure);
        }
    }

    fn rank(&self, stamp: &str) -> usize {
        self.stamps.borrow_mut().rank(stamp)
    }

    fn pid(&self) -> u32 {
        self.pid_base + self.spawns as u32 - 1
    }

    /// The child the record names, or nothing when the key belongs to no child. The capture's fake threw
    /// an `Error`, so the port's `io::Error` stands for it.
    fn call_write(&mut self, _pid: u32, data: &str) -> Result<(), ()> {
        let Some(child) = self.children.first_mut() else {
            return Ok(());
        };
        if child.throw_write {
            child.writes += 1;
            return Err(());
        }
        child.writes += 1;
        child.last_write = data.to_owned();
        Ok(())
    }

    fn call_resize(&mut self, _pid: u32, size: Size) -> Result<(), ()> {
        let Some(child) = self.children.first_mut() else {
            return Ok(());
        };
        if child.throw_resize {
            child.resizes += 1;
            child.last_cols = i64::from(size.cols);
            child.last_rows = i64::from(size.rows);
            return Err(());
        }
        child.resizes += 1;
        child.last_cols = i64::from(size.cols);
        child.last_rows = i64::from(size.rows);
        Ok(())
    }

    fn sample(&mut self) {
        self.samples.push(self.children.first().cloned().unwrap_or_default());
    }

    fn write(&mut self, thread: usize, terminal: &str, data: &str) {
        let thread_id = self.thread(thread);
        let outcome = self.manager.write(&thread_id, terminal, |pid| {
            self
                .call_write(pid, data)
                .map_err(|| io_error_text("device full"))
        });
        match &outcome {
            Ok(_) => self
                .boundaries
                .push(("write".to_owned(), "ok".to_owned())),
            Err(failure) => {
                self.boundaries.push((
                    "write".to_owned(),
                    format!("err:{}", failure.tag().unwrap_or("defect")),
                ));
                self.failure = Some(failure);
            }
        }
        self.sample();
        outcome
    }

    fn resize(&mut self, thread: usize, terminal: &str, cols: u32, rows: u32) {
        let thread_id = self.thread(thread);
        let at = self.stamp();
        let outcome = self.manager.resize(&thread_id, terminal, cols, rows, &at, |pid, size| {
            self
                .call_resize(pid, size)
                .map_err(|| io_error_text("ioctl failed"))
        });
        match &outcome {
            Ok(()) => self
                .boundaries
                .push(("resize".to_owned(), "ok".to_owned())),
            Err(failure) => {
                self.boundaries.push((
                    "resize".to_owned(),
                    format!("err:{}", failure.tag().unwrap_or("defect")),
                ));
                self.failure = Some(failure);
            }
        }
        self.sample();
    }

    fn view(&mut self) {
        let rows = self
            .manager
            .view()
            .iter()
            .map(|row| {
                vec![
                    row.thread_id.clone(),
                    row.terminal_id.clone(),
                    row.status.as_str().to_owned(),
                    row.pid.map(|pid| pid.to_string()).unwrap_or("-".to_owned()),
                    self.rank(&row.updated_at).to_string(),
                ]
            })
            .collect();
        self.views.push(rows);
    }

    fn fail_spawn(&mut self, on: bool) {
        self.fail_spawn = on;
    }

    fn unthrow(&mut self) {
        if let Some(child) = self.children.first_mut() {
            child.throw_write = false;
            child.throw_resize = false;
        }
    }

    fn throw_write(&mut self) {
        self.children
            .first_mut()
            .expect("a case that throws has a child")
            .throw_write = true;
    }

    fn throw_resize(&mut self) {
        self.children
            .first_mut()
            .expect("a case that throws has a child")
            .throw_resize = true;
    }

    /// The capture's `boundaryOf` answer for the first call of a kind whose status is not `-`.
    fn first_status(&self, kind: &str) -> Option<&str> {
        self.boundaries
            .iter()
            .filter(|(named, status)| named == kind && status != "-")
            .nth(0)
            .map(|(_, status)| status.as_str())
    }

    fn status_of(&self, kind: &str, index: usize) -> String {
        self.boundaries
            .iter()
            .filter(|(named, _)| named == kind)
            .nth(index)
            .map(|(_, status)| status.clone())
            .unwrap_or_else(|| "missing".to_owned())
    }

    fn fields(&self) -> String {
        self.failure
            .as_ref()
            .and_then(|failure| failure.fields())
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
        self.samples.last().cloned().unwrap_or_default()
    }

    fn claim(&self, claims: &mut Vec<Row>, id: &str, held: bool, detail: String) {
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

    fn finish(&mut self) {
        let _ = self.worker.shutdown();
    }
}

impl Replay {
    fn running(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", Some((100, 24)));
        self.view();
        self.write(0, "term-1", "ls\n");
        self.view();
        self.resize(0, "term-1", 80, 20);
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
            self.events.len() == 1,
            format!("{} events", self.events.len()),
        );
        let stamp = |view: usize| self.views[view][0][4].clone();
        self.claim(
            claims,
            "write-leaves-stamp-alone",
            stamp(0) == stamp(1),
            format!("{}->{}", stamp(0), stamp(1)),
        );
        self.claim(
            claims,
            "resize-moves-stamp",
            stamp(2).parse::<usize>() > stamp(1).parse::<usize>(),
            format!("{}->{}", stamp(1), stamp(2)),
        );
    }

    fn write_passthrough(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        for data in ["", "\r", "á\n\t"] {
            self.write(0, "term-1", data);
        }
        let empties: Vec<&Child> = self
            .samples
            .iter()
            .filter(|sample| sample.writes == 1)
            .collect();
        let carriage: Vec<&Child> = self
            .samples
            .iter()
            .filter(|sample| sample.writes == 2)
            .collect();
        let multi: Vec<&Child> = self
            .samples
            .iter()
            .filter(|sample| sample.writes == 3)
            .collect();
        self.claim(
            claims,
            "empty-write-reaches-pty",
            empties.iter().any(|sample| sample.last_write.is_empty()),
            format!("rows={}", empties.len()),
        );
        self.claim(
            claims,
            "carriage-untouched",
            carriage.iter().any(|sample| sample.last_write == "\r"),
            format!("rows={}", carriage.len()),
        );
        self.claim(
            claims,
            "tab-and-multibyte-untouched",
            multi.iter().any(|sample| sample.last_write == "á\n\t"),
            format!("rows={}", multi.len()),
        );
        self.claim(
            claims,
            "writes-publish-nothing",
            self.events.len() == 1,
            self.events.len().to_string(),
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
            self.events.len() == 2,
            self.events.len().to_string(),
        );
        let child = self.children.first().cloned().unwrap_or_default();
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
            self.events.len() == 1,
            self.events.len().to_string(),
        );
        let moves = self
            .boundaries
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
            .snapshot("thread-a", "term-1")
            .expect("the opened record")
            .sequence
            .expect("a started record has a sequence");
        let at = self.stamp();
        let frames = self.manager.exit(
            "thread-a",
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
        self.resize(0, "term-1", 60, 10);
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
        let stamp = |view: usize| self.views[view][0][4].clone();
        self.claim(
            claims,
            "exited-resize-leaves-stamp",
            stamp(0) == stamp(1),
            format!("{}->{}", stamp(0), stamp(1)),
        );
        self.claim(
            claims,
            "exited-status-after-calls",
            self.views[1][0][2] == "exited",
            self.views[1][0][2].clone(),
        );
    }

    fn failed_start(&mut self, claims: &mut Vec<Row>) {
        self.fail_spawn(true);
        self.open("open-1", 0, "term-1", None);
        self.view();
        self.failure = None;
        let write = self.write(0, "term-1", "x");
        self.claim(
            claims,
            "error-write-names-status",
            write.is_err() && self.status_of("write", 0) == "err:TerminalNotRunningError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "error-resize-is-ok",
            self.resize(0, "term-1", 40, 8).is_ok(),
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
            self.events.len() == 1,
            self.events.len().to_string(),
        );
        self.fail_spawn(false);
    }

    fn starting(&mut self, claims: &mut Vec<Row>) {
        // The capture parked the spawn, so the record was `starting` when the calls ran and only became
        // `running` once the open returned. The seam's part of that is the same two records: an `open`
        // that created one, and the `start` the caller owes it afterwards.
        self.park = true;
        self.open("open-1", 0, "term-1", None);
        self.view();
        self.failure = None;
        let write = self.write(0, "term-1", "x");
        self.claim(
            claims,
            "starting-write-refuses",
            write.is_err() && self.status_of("write", 0) == "err:TerminalNotRunningError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "starting-write-reaches-no-process",
            self.last().writes == 0,
            format!("writes={}", self.last().writes),
        );
        let asked = Size {
            cols: 120,
            rows: 40,
        };
        let at = self.stamp();
        let held = self
            .manager
            .state("thread-a", "term-1")
            .expect("the parked record")
            .clone();
        let _ = held;
        let resize = self
            .manager
            .resize("thread-a", "term-1", asked.cols, asked.rows, &at, |pid, size| {
                self.call_resize(pid, size)
                    .map_err(|| io_error_text("ioctl failed"))
            });
        self.claim(
            claims,
            "starting-resize-is-silent-while-starting",
            resize.is_ok() && self.last().resizes == 0,
            format!("resizes={}", self.last().resizes),
        );
        self.start_parked();
        self.resize(0, "term-1", 120, 40);
        self.view();
        let after = self.last();
        self.claim(
            claims,
            "held-resize-applies-after-the-open",
            after.resizes == 1 && after.last_cols == 120 && after.last_rows == 40,
            format!("resizes={} {}x{}", after.resizes, after.last_cols, after.last_rows),
        );
        self.claim(
            claims,
            "held-open-eventually-runs",
            self.views[1][0][2] == "running",
            self.views[1][0][2].clone(),
        );
    }

    fn absent(&mut self, claims: &mut Vec<Row>) {
        self.failure = None;
        let write = self.write(0, "term-1", "x");
        self.claim(
            claims,
            "absent-write-is-a-lookup",
            write.is_err() && self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "absent-resize-is-ok",
            self.resize(0, "term-1", 80, 20).is_ok(),
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
            self.events.is_empty(),
            self.events.len().to_string(),
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
        let frames = self
            .manager
            .close("thread-a", Some("term-1"), None)
            .expect("a close of a record the replay owns");
        self.count(&frames);
        self.failure = None;
        let write = self.write(0, "term-1", "x");
        self.claim(
            claims,
            "closed-write-is-a-lookup",
            write.is_err() && self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "closed-resize-is-ok",
            self.resize(0, "term-1", 80, 20).is_ok(),
            self.status_of("resize", 0),
        );
        let last = self.children.first().cloned().unwrap_or_default();
        self.claim(
            claims,
            "closed-process-untouched",
            last.writes == 0 && last.resizes == 0,
            format!("writes={} resizes={}", last.writes, last.resizes),
        );
    }

    fn write_throws(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        self.throw_write();
        self.failure = None;
        let write = self.write(0, "term-1", "x");
        self.claim(
            claims,
            "throwing-write-is-named",
            write.is_err() && self.status_of("write", 0) == "err:TerminalWriteError",
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
            self.events.len() == 1,
            self.events.len().to_string(),
        );
        self.unthrow();
        self.claim(
            claims,
            "later-write-still-works",
            self.write(0, "term-1", "y").is_ok(),
            self.status_of("write", 1),
        );
    }

    fn resize_throws(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", Some((100, 24)));
        self.view();
        self.throw_resize();
        self.failure = None;
        let resize = self.resize(0, "term-1", 80, 20);
        self.claim(
            claims,
            "throwing-resize-is-named",
            resize.is_err() && self.status_of("resize", 0) == "err:TerminalResizeError",
            self.status_of("resize", 0),
        );
        let fields = self.fields();
        self.claim(
            claims,
            "resize-error-carries-size",
            fields
                == "threadId=thread-a,terminalId=term-1,terminalPid=7900,cols=80,rows=20",
            hex(&fields),
        );
        let message = self.message();
        self.claim(
            claims,
            "resize-error-message",
            message
                == "Failed to resize terminal for thread: thread-a, terminal: term-1, PID: 7900 to 80x20",
            hex(&message),
        );
        self.unthrow();
        self.open("open-2", 0, "term-1", Some((80, 20)));
        self.resize(0, "term-1", 90, 21);
        self.open("open-3", 0, "term-1", Some((90, 21)));
        let processes = self.children.len();
        self.claim(claims, "no-extra-spawn", processes == 1, format!("processes={processes}"));
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
            self.events.len() == 1,
            self.events.len().to_string(),
        );
    }

    fn other_thread(&mut self, claims: &mut Vec<Row>) {
        self.open("open-1", 0, "term-1", None);
        self.failure = None;
        let write = self.write(1, "term-1", "x");
        self.claim(
            claims,
            "other-thread-write-is-a-lookup",
            write.is_err() && self.status_of("write", 0) == "err:TerminalSessionLookupError",
            self.status_of("write", 0),
        );
        self.claim(
            claims,
            "other-thread-resize-is-ok",
            self.resize(1, "term-1", 80, 20).is_ok(),
            self.status_of("resize", 0),
        );
        let last = self.children.first().cloned().unwrap_or_default();
        self.claim(
            claims,
            "other-thread-calls-touch-nothing",
            last.writes == 0 && last.resizes == 0,
            format!("writes={} resizes={}", last.writes, last.resizes),
        );
        let rows = &self.views[0];
        self.claim(
            claims,
            "other-thread-creates-no-session",
            rows.len() == 1 && rows.iter().all(|row| row[0] == "thread-a"),
            rows.iter()
                .map(|row| row[0].clone())
                .collect::<Vec<_>>()
                .join(","),
        );
        let stamp = self.views[0][0][4].clone();
        self.claim(
            claims,
            "other-thread-resize-stamps-nothing",
            stamp == "1",
            format!("stamp={stamp}"),
        );
    }
}

fn io_error(_: &Failure) -> std::io::Error {
    std::io::Error::other("the replay never fails a persist")
}

fn io_error_text(reason: &str) -> std::io::Error {
    std::io::Error::other(reason.to_owned())
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

    let mut totals = (0usize, 0usize);
    for case in &cases {
        let threads: Vec<&str> = case.threads.iter().map(String::as_str).collect();
        let mut replay = Replay::new(&case.name, &threads);
        replay.pid_base = case.pid;
        let claims = replay.run(&case.name);
        replay.finish();
        assert_eq!(
            claims, case.claims,
            "{} write/resize claims differ from the capture",
            case.name
        );
        totals = (totals.0 + 1, totals.1 + claims.len());
    }
    eprintln!(
        "write/resize golden: {} cases, {} claims recomputed from {}",
        totals.0,
        totals.1,
        trace.display()
    );
}
