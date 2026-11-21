//! The shipped re-`open` history reset, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_REOPEN_RESET_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-reopen-reset-trace.ts`. `native/pty/src/lifecycle.rs`'s own tests pin
//! each reset rule; this one replays them the way one client call sees them: the call boundaries, the
//! events the call publishes, the snapshot the call answers with, what the process the record used to
//! have was asked to do, what the next shell was spawned with, and what the history file holds on the
//! way out.
//!
//! The trace's rows are the expectations. The schedules below are the same steps the script ran, and
//! `schedule` panics on a name it has no schedule for, so a case added there has to be replayed here.
//! The `A` rows are asserted as answered; the `Q` rows are the harness's own note about the rule, which
//! no replay reproduces.
//!
//! Two things the trace measures that a port of the table alone cannot copy:
//!
//! - a `K` row counts one stop as two `kill` calls, because the shipped `stopProcess` kills and then
//!   runs its escalation with a zero grace period. The count is the observation; the escalation timer
//!   belongs to the transport, which this crate has already ported beside it.
//! - the `F` row of a re-`open` that changed nothing is read while the write that the preceding chunk
//!   queued is still inside its debounce, so the file still holds what the terminal was opened with.
//!   That is what the shipped run measured, and it is the one row here whose value depends on the
//!   replay not stalling for longer than the 40 ms debounce.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lmcs_pty::lifecycle::{Event, Exit, LaunchAsk, Reopen, Size, Terminals, Viewport, Worktree};
use lmcs_pty::node_pty::exit_event;
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::persisted::PersistedOutput;
use lmcs_pty::{Delivery, PendingEvent};
use lmcs_terminal_history::{
    BoundedHistory, DEFAULT_TERMINAL_ID, HistoryPersistence, history_path, load_history,
};

type Row = Vec<String>;

struct Case {
    name: String,
    threads: Vec<String>,
    seed: String,
    timeline: Vec<Row>,
    claims: Vec<Row>,
}

struct Parsed {
    default_terminal: String,
    cases: Vec<Case>,
    case_count: usize,
    snapshot_count: usize,
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

/// A row that carries its own place in the trace's one global counter. The replay compares content and
/// order, so the counter is checked here rather than reproduced: a row written out of order, or a
/// source the harness counted twice, fails on its own line.
fn timed(seq: &mut u64, building: &mut Option<Case>, written: &str, row: Row) {
    *seq += 1;
    assert_eq!(
        written,
        &seq.to_string(),
        "trace rows are not one sequence: {row:?}"
    );
    building
        .as_mut()
        .expect("timed row outside a case")
        .timeline
        .push(row);
}

fn parse(trace: &Path) -> Parsed {
    let mut cases: Vec<Case> = Vec::new();
    let mut building: Option<Case> = None;
    let mut default_terminal = String::new();
    let mut case_count = 0;
    let mut snapshot_count = 0;
    let mut seq = 0u64;
    for line in fs::read_to_string(trace).unwrap().lines() {
        let fields: Vec<_> = line.split('\t').collect();
        match fields[0] {
            "H" => default_terminal = unhex(fields[1]),
            "I" | "Q" => {}
            "C" => {
                case_count += 1;
                assert_eq!(
                    fields[2].parse::<usize>().expect("thread count"),
                    unhex(fields[3]).split(',').count(),
                    "the case counted threads it did not name"
                );
                building = Some(Case {
                    name: fields[1].to_owned(),
                    threads: unhex(fields[3]).split(',').map(str::to_owned).collect(),
                    seed: unhex(fields[4]),
                    timeline: Vec::new(),
                    claims: Vec::new(),
                });
            }
            "B" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "B".to_owned(),
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    unhex(fields[4]),
                ],
            ),
            "O" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "O".to_owned(),
                    unhex(fields[2]),
                    unhex(fields[3]),
                    unhex(fields[4]),
                    fields[5].to_owned(),
                    fields[6].to_owned(),
                    fields[7].to_owned(),
                    fields[8].to_owned(),
                ],
            ),
            "S" => {
                snapshot_count += 1;
                timed(
                    &mut seq,
                    &mut building,
                    fields[1],
                    vec![
                        "S".to_owned(),
                        fields[2].to_owned(),
                        unhex(fields[3]),
                        fields[4].to_owned(),
                        fields[5].to_owned(),
                        fields[6].to_owned(),
                        fields[7].to_owned(),
                        unhex(fields[8]),
                        unhex(fields[9]),
                        unhex(fields[10]),
                        fields[11].to_owned(),
                    ],
                );
            }
            "K" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "K".to_owned(),
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    fields[4].to_owned(),
                    fields[5].to_owned(),
                    fields[6].to_owned(),
                ],
            ),
            "T" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "T".to_owned(),
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    fields[4].to_owned(),
                    unhex(fields[5]),
                ],
            ),
            "F" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "F".to_owned(),
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    fields[4].to_owned(),
                    fields[5].to_owned(),
                    fields[6].to_owned(),
                    unhex(fields[7]),
                ],
            ),
            "A" => building
                .as_mut()
                .expect("claim outside a case")
                .claims
                .push(vec![
                    fields[1].to_owned(),
                    fields[2].to_owned(),
                    unhex(fields[3]),
                ]),
            "X" => {
                let case = building.take().expect("case end without a case");
                assert_eq!(case.name, fields[1]);
                cases.push(case);
            }
            "Z" => {
                assert_eq!(fields[3], "end");
                assert_eq!(
                    fields[1].parse::<usize>().expect("case count"),
                    case_count,
                    "the trace counted cases it did not write"
                );
                assert_eq!(
                    fields[2].parse::<usize>().expect("snapshot count"),
                    snapshot_count,
                    "the trace counted snapshots it did not write"
                );
            }
            code => panic!("unknown trace row {code}"),
        }
    }
    assert!(building.is_none(), "trace ended inside a case");
    Parsed {
        default_terminal,
        cases,
        case_count,
        snapshot_count,
    }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/// What one `open` step named. The `cwd` and `worktree` fields index the two directories the trace
/// made, so `None` for a worktree means the input named none rather than named nothing.
#[derive(Clone, Copy)]
struct Ask {
    cwd: usize,
    env: usize,
    worktree: Option<usize>,
    size: Option<Size>,
}

#[derive(Clone, Copy)]
enum Step {
    /// The first `open` of a terminal: the record is created, restored from disk and started.
    Open(&'static str, usize, &'static str, Ask),
    /// `open` again on a record the table already has, which is the reset gate's own path.
    Reopen(&'static str, usize, &'static str, Ask),
    /// One chunk from the running shell.
    Emit(usize, &'static str),
    /// The shell exiting with a code and no signal.
    Exit(usize, i32),
    /// A read of one terminal's history file, which the scope case takes on the terminal it did not
    /// reset. No call boundary and no snapshot, because the shipped harness only looked at the file.
    File(&'static str, usize, &'static str),
    /// `adapter.failSpawn`, which the error case turns off between its two calls.
    FailSpawn(bool),
}

const fn asked(cwd: usize, env: usize, worktree: Option<usize>, size: Option<Size>) -> Ask {
    Ask {
        cwd,
        env,
        worktree,
        size,
    }
}

const SQUARE: Size = Size {
    cols: 100,
    rows: 24,
};
const WIDE: Size = Size {
    cols: 132,
    rows: 43,
};

fn schedule(name: &str) -> Vec<Step> {
    use Step::*;
    match name {
        // The control: nothing changes, so the screen, the numbering and the process all survive.
        "same-context-keeps-history" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Emit(0, "typed\n"),
            Reopen("open-2", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
        ],
        "cwd-change-resets-history" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Emit(0, "typed\n"),
            Reopen("open-2", 0, "term-1", asked(1, 2, None, Some(SQUARE))),
        ],
        // The absent worktree is the middle step: keeping the recorded path is what makes it not a
        // change, and a change on the third call is what proves the recorded path was kept.
        "worktree-change-resets-history" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, Some(0), Some(SQUARE))),
            Reopen("open-2", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Reopen("open-3", 0, "term-1", asked(0, 2, Some(1), Some(SQUARE))),
        ],
        "environment-equality-is-content" => vec![
            Open("open-1", 0, "term-1", asked(0, 4, None, Some(SQUARE))),
            Reopen("open-2", 0, "term-1", asked(0, 5, None, Some(SQUARE))),
            Reopen("open-3", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
        ],
        "absent-env-and-empty-env-are-one-record" => vec![
            Open("open-1", 0, "term-1", asked(0, 0, None, Some(SQUARE))),
            Reopen("open-2", 0, "term-1", asked(0, 1, None, Some(SQUARE))),
            Reopen("open-3", 0, "term-1", asked(0, 0, None, Some(SQUARE))),
        ],
        "exited-terminal-resets-without-a-kill" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Emit(0, "typed\n"),
            Exit(0, 3),
            Reopen("open-2", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
        ],
        "error-terminal-resets-and-remembers-viewport" => vec![
            FailSpawn(true),
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(WIDE))),
            FailSpawn(false),
            Reopen("open-2", 0, "term-1", asked(0, 2, None, None)),
            Reopen("open-3", 0, "term-1", asked(0, 2, None, None)),
        ],
        "two-context-changes-in-a-row" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Reopen("open-2", 0, "term-1", asked(1, 2, None, Some(SQUARE))),
            Emit(1, "second\n"),
            Reopen("open-3", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
        ],
        "reset-is-scoped-to-one-terminal" => vec![
            Open("open-1", 0, "term-1", asked(0, 2, None, Some(SQUARE))),
            Open("open-2", 1, "term-1", asked(0, 2, None, Some(SQUARE))),
            Reopen("open-3", 0, "term-1", asked(1, 2, None, Some(SQUARE))),
            File("final", 1, "term-1"),
        ],
        other => panic!("no replay schedule for {other}"),
    }
}

/// The trace's environments, by index. Index 0 is the input naming none and index 1 the input naming
/// an empty record, which the reset gate has to read as one thing.
fn env(index: usize) -> Option<Vec<(String, String)>> {
    let entry = |name: &str, value: &str| (name.to_owned(), value.to_owned());
    match index {
        0 => None,
        1 => Some(Vec::new()),
        2 => Some(vec![entry("LMCS_A", "1")]),
        3 => Some(vec![entry("LMCS_B", "2")]),
        4 => Some(vec![entry("LMCS_A", "1"), entry("LMCS_B", "2")]),
        5 => Some(vec![entry("LMCS_B", "2"), entry("LMCS_A", "1")]),
        other => panic!("no environment at index {other}"),
    }
}

struct Logs {
    base: PathBuf,
    dir: PathBuf,
    worker: Option<HistoryPersistence>,
}

impl Logs {
    /// The layout the trace ran on: two directories a terminal can be asked to move between, and one
    /// seeded history per thread, so the first `open` has a screen to restore.
    fn start(case: &Case) -> Self {
        let base = std::env::temp_dir().join(format!(
            "lmcs-reopen-golden-{}-{}-{}",
            std::process::id(),
            case.name,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = base.join("userdata/logs/terminals");
        fs::create_dir_all(&dir).unwrap();
        for label in ["a", "b"] {
            fs::create_dir_all(base.join(format!("cwd-{label}"))).unwrap();
        }
        for (index, thread) in case.threads.iter().enumerate() {
            if case.seed.is_empty() {
                continue;
            }
            let mut seeded = case.seed.clone().into_bytes();
            if index > 0 {
                seeded.extend_from_slice(b"neighbour\n");
            }
            fs::write(history_path(&dir, thread, "term-1"), seeded).unwrap();
        }
        Self {
            dir: dir.clone(),
            worker: Some(HistoryPersistence::start(dir, drop).unwrap()),
            base,
        }
    }

    fn cwd(&self, index: usize) -> String {
        let label = match index {
            0 => "a",
            1 => "b",
            other => panic!("no directory at index {other}"),
        };
        self.base.join(format!("cwd-{label}")).display().to_string()
    }

    /// `readHistory`, with the limits the trace's manager was built with.
    fn restore(&self, thread: &str, terminal: &str) -> BoundedHistory {
        load_history(&self.dir, thread, terminal, 1_024, 8)
            .map(|loaded| loaded.history)
            .unwrap_or_else(|_| BoundedHistory::with_limits(8, 1_024, b""))
    }

    fn session(&self, thread: &str, terminal: &str, history: BoundedHistory) -> PersistedOutput {
        PersistedOutput::new(
            TerminalOutput::new(history),
            self.worker.as_ref().unwrap().handle(),
            &self.dir,
            thread,
            terminal,
        )
    }

    /// The history file as it stands, which the trace reads without waiting for the worker, so an
    /// unwritten queue is part of what a row shows.
    fn disk(&self, thread: &str, terminal: &str) -> (bool, usize, String) {
        match fs::read(history_path(&self.dir, thread, terminal)) {
            Ok(bytes) => (
                true,
                bytes.len(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ),
            Err(_) => (false, 0, String::new()),
        }
    }
}

impl Drop for Logs {
    fn drop(&mut self) {
        if let Some(mut worker) = self.worker.take() {
            let _ = worker.stop();
        }
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn signed(value: Option<i32>) -> String {
    value.map_or_else(|| "-".to_owned(), |value| value.to_string())
}

fn pid_text(pid: Option<u32>) -> String {
    pid.map_or_else(|| "-".to_owned(), |pid| pid.to_string())
}

/// `dirTail`: the trace records where a spawn ran by its last segment, so no temp path enters it.
fn dir_tail(path: Option<&String>) -> String {
    let Some(path) = path else {
        return "-".to_owned();
    };
    if path.is_empty() {
        return "-".to_owned();
    }
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// The pid the trace's fake adapter hands out first, which is why the replay can use the same numbers
/// rather than normalizing them away.
const FIRST_PID: u32 = 7900;

/// One process the fake adapter handed out. `subscribed` is the data handler's state, which the
/// shipped code drops when it cleans the handles; nothing in this trace types into a terminal, so the
/// write count the trace reports is always zero.
#[derive(Clone, Debug)]
struct Pty {
    thread: String,
    terminal: String,
    pid: u32,
    kills: usize,
    resizes: usize,
    subscribed: bool,
}

struct Replay {
    logs: Logs,
    terminals: Terminals,
    threads: Vec<String>,
    fail_spawn: bool,
    reads: u64,
    ptys: Vec<Pty>,
    /// Every spawn attempt, successful or not, which is the order the trace's `T` rows number.
    spawns: Vec<(u32, u32, String)>,
    /// How many of those a `T` row has already reported, since a call lists only its own.
    spawns_reported: usize,
    timeline: Vec<Row>,
    /// Every stamp a row showed: the set the trace ranks into `t1..tn`.
    stamps: BTreeSet<String>,
}

impl Replay {
    fn new(logs: Logs, case: &Case) -> Self {
        let terminals = Terminals::new(&logs.dir);
        Self {
            logs,
            terminals,
            threads: case.threads.clone(),
            fail_spawn: false,
            reads: 0,
            ptys: Vec::new(),
            spawns: Vec::new(),
            spawns_reported: 0,
            timeline: Vec::new(),
            stamps: BTreeSet::new(),
        }
    }

    fn thread(&self, index: usize) -> String {
        self.threads[index].clone()
    }

    /// One `nowIso` read. Only values a row showed are ranked, so a read the shipped manager spent on
    /// a step nobody observed cannot move a label either way.
    fn read(&mut self) -> String {
        self.reads += 1;
        format!("s{:03}", self.reads)
    }

    fn push(&mut self, row: Row) -> usize {
        self.timeline.push(row);
        self.timeline.len() - 1
    }

    fn boundary(&mut self, kind: &str, id: &str, status: &str) {
        self.push(vec![
            "B".to_owned(),
            kind.to_owned(),
            id.to_owned(),
            status.to_owned(),
        ]);
    }

    /// `started` is the only one of this trace's events that carries a
    /// snapshot, so it is the only one whose stamp the shipped harness ranked; the `pid` column is read
    /// out of that snapshot, which is why an `exited` row shows no process even beside its exit code and
    /// an `output` row shows neither, because the drain publishes that one without a snapshot.
    fn publish_event(&mut self, thread: &str, event: &Event) {
        let (kind, pid, exit_code, exit_signal) = match event {
            Event::Started { pid, .. } => ("started", Some(*pid), None, None),
            Event::Error { .. } => ("error", None, None, None),
            Event::Exited {
                exit_code,
                exit_signal,
                ..
            } => ("exited", None, *exit_code, *exit_signal),
            other => panic!("the reopen trace publishes no {other:?}"),
        };
        if matches!(event, Event::Started { .. }) {
            let state = self
                .terminals
                .state(thread, event.terminal_id())
                .expect("a started event is published beside the record it stamped");
            self.stamps.insert(state.updated_at.clone());
        }
        self.push(vec![
            "O".to_owned(),
            kind.to_owned(),
            thread.to_owned(),
            event.terminal_id().to_owned(),
            event.sequence().to_string(),
            pid_text(pid),
            signed(exit_code),
            signed(exit_signal),
        ]);
    }

    fn publish_events(&mut self, thread: &str, events: &[Event]) {
        for event in events {
            self.publish_event(thread, event);
        }
    }

    /// The event a `drainProcessEvents` walk publishes for a chunk. It carries no snapshot, which is why
    /// its pid column stays empty even beside the sequence the same walk took.
    fn publish_output(&mut self, thread: &str, terminal: &str, sequence: u64) {
        self.push(vec![
            "O".to_owned(),
            "output".to_owned(),
            thread.to_owned(),
            terminal.to_owned(),
            sequence.to_string(),
            "-".to_owned(),
            "-".to_owned(),
            "-".to_owned(),
        ]);
    }

    /// `startSession`, reached by both `open` branches. The viewport the shell is asked for is the
    /// call's own or the record's remembered one, which is what makes a failed start hand its size to
    /// the next spawn.
    fn start(&mut self, thread: &str, terminal: &str, requested: Option<Size>) {
        let remembered = self
            .terminals
            .state(thread, terminal)
            .expect("a start runs on a record the table has")
            .size;
        let size = requested.unwrap_or(remembered);
        let cwd = self
            .terminals
            .launch(thread, terminal)
            .expect("a record always remembers the directory it starts in")
            .cwd
            .clone();
        self.spawns
            .push((size.cols, size.rows, dir_tail(Some(&cwd))));
        let mut events = Vec::new();
        if self.fail_spawn {
            let at = self.read();
            self.terminals.mark_error(
                thread,
                terminal,
                "Failed to spawn PTY process",
                requested,
                &at,
                &mut |event| events.push(event.clone()),
            );
        } else {
            let pid = FIRST_PID + self.ptys.len() as u32;
            self.ptys.push(Pty {
                thread: thread.to_owned(),
                terminal: terminal.to_owned(),
                pid,
                kills: 0,
                resizes: 0,
                subscribed: true,
            });
            let at = self.read();
            self.terminals
                .mark_running(thread, terminal, pid, requested, &at, &mut |event| {
                    events.push(event.clone())
                });
        }
        self.publish_events(thread, &events);
    }

    /// `stopProcess`, as the reset gate reaches it: the escalation kills twice and the data handler is
    /// unsubscribed, and the record has already gone inactive in the table.
    fn stop(&mut self, pid: u32) {
        let pty = self
            .ptys
            .iter_mut()
            .find(|pty| pty.pid == pid)
            .expect("the stopped process came from this adapter");
        pty.kills += 2;
        pty.subscribed = false;
    }

    fn open(&mut self, kind: &str, id: &str, thread_index: usize, terminal: &str, ask: Ask) {
        self.boundary(kind, id, "-");
        let thread = self.thread(thread_index);
        let launch = LaunchAsk {
            cwd: self.logs.cwd(ask.cwd),
            worktree: match ask.worktree {
                Some(index) => Worktree::At(self.logs.cwd(index)),
                None => Worktree::Unnamed,
            },
            env: env(ask.env),
        };
        let started = if self.terminals.state(&thread, terminal).is_none() {
            // `flushPersist` and `readHistory` before the record exists. A created terminal has no
            // queued write to wait on, so only the read shows here.
            let history = self.logs.restore(&thread, terminal);
            let session = self.logs.session(&thread, terminal, history);
            let at = self.read();
            self.terminals
                .insert(&thread, terminal, session, ask.size, &launch, &at);
            true
        } else {
            false
        };
        if started {
            self.start(&thread, terminal, ask.size.or(Some(Size::DEFAULT)));
        } else {
            let at = self.read();
            match self
                .terminals
                .reopen(&thread, terminal, &launch, &at)
                .expect("a reset writes its own file")
            {
                Reopen::Stopped { pid } => self.stop(pid),
                Reopen::Kept | Reopen::Reset => {}
                Reopen::Missing => panic!("a re-open of a record the table has is never missing"),
            }
            let running = self
                .terminals
                .state(&thread, terminal)
                .expect("the reopen left its record in the table")
                .pid;
            if let Some(pid) = running {
                if let Some(requested) = ask.size {
                    let at = self.read();
                    if matches!(
                        self.terminals.viewport(&thread, terminal, requested, &at),
                        Viewport::Applied(_)
                    ) && let Some(pty) = self.ptys.iter_mut().find(|pty| pty.pid == pid)
                    {
                        pty.resizes += 1;
                    }
                }
            } else {
                self.start(&thread, terminal, ask.size);
            }
        }
        self.boundary(kind, id, "ok");
        self.snapshot_row(id, &thread, terminal);
        self.record_ptys();
        self.file_row(id, &thread, terminal);
    }

    /// The history file as the trace read it: existence, length and content, with no drain of the
    /// worker first, so a write still inside its debounce shows as unwritten.
    fn file_row(&mut self, id: &str, thread: &str, terminal: &str) {
        let (exists, size, content) = self.logs.disk(thread, terminal);
        self.push(vec![
            "F".to_owned(),
            id.to_owned(),
            thread.to_owned(),
            terminal.to_owned(),
            if exists { "1" } else { "0" }.to_owned(),
            size.to_string(),
            content,
        ]);
    }

    /// The snapshot `openLocked` answers with, which is the only place this trace shows the retained
    /// screen and the record's numbering.
    fn snapshot_row(&mut self, id: &str, thread: &str, terminal: &str) {
        let state = self
            .terminals
            .state(thread, terminal)
            .expect("an open answers with the record it wrote")
            .clone();
        let launch = self
            .terminals
            .launch(thread, terminal)
            .expect("the record the open returned has a launch")
            .clone();
        let sequence = self
            .terminals
            .session(thread, terminal)
            .expect("a record always has its output")
            .sequence();
        let history = self
            .terminals
            .session(thread, terminal)
            .expect("a record always has its output")
            .history_value();
        self.stamps.insert(state.updated_at.clone());
        self.push(vec![
            "S".to_owned(),
            id.to_owned(),
            state.status.as_str().to_owned(),
            pid_text(state.pid),
            signed(state.exit_code),
            signed(state.exit_signal),
            sequence.to_string(),
            String::from_utf8(history).expect("retained history is text"),
            dir_tail(Some(&launch.cwd)),
            dir_tail(launch.worktree_path.as_ref()),
            state.updated_at,
        ]);
    }

    /// A `K` row per process the adapter handed out, then a `T` row per spawn attempt this call made.
    fn record_ptys(&mut self) {
        let reported: Vec<Row> = self
            .ptys
            .iter()
            .enumerate()
            .map(|(index, pty)| {
                vec![
                    "K".to_owned(),
                    index.to_string(),
                    pty.kills.to_string(),
                    pty.resizes.to_string(),
                    "0".to_owned(),
                    if pty.subscribed { "1" } else { "0" }.to_owned(),
                ]
            })
            .chain((self.spawns_reported..self.spawns.len()).map(|index| {
                let (cols, rows, cwd) = &self.spawns[index];
                vec![
                    "T".to_owned(),
                    index.to_string(),
                    cols.to_string(),
                    rows.to_string(),
                    cwd.clone(),
                ]
            }))
            .collect();
        self.timeline.extend(reported);
        self.spawns_reported = self.spawns.len();
    }

    fn emit(&mut self, spawn: usize, data: &str) {
        let (thread, terminal, pid) = {
            let pty = self.ptys.get(spawn).expect("no pty at that spawn index");
            (pty.thread.clone(), pty.terminal.clone(), pty.pid)
        };
        // `emit` is the adapter's own callback: the trace records the call and never a return, because
        // the walk it triggers publishes on its way out.
        self.boundary("emit", &format!("spawn-{spawn}"), "-");
        let sequence = self.drain(&thread, &terminal, pid, PendingEvent::Data(data.to_owned()));
        // The drain stamps the record for the chunk it dequeued, which is what keeps a terminal that is
        // producing text ahead of retention.
        let at = self.read();
        self.terminals.touch(&thread, &terminal, &at);
        let sequence = sequence.expect("the chunk of a running terminal walks");
        self.publish_output(&thread, &terminal, sequence);
    }

    fn exit(&mut self, spawn: usize, code: i32) {
        let (thread, terminal, pid) = {
            let pty = self.ptys.get(spawn).expect("no pty at that spawn index");
            (pty.thread.clone(), pty.terminal.clone(), pty.pid)
        };
        self.boundary("exit", &format!("spawn-{spawn}"), "-");
        let sequence = self
            .drain(
                &thread,
                &terminal,
                pid,
                PendingEvent::Exit(exit_event(code, None)),
            )
            .expect("the exit of a running terminal walks");
        // `cleanupProcessHandles` disconnects both handlers, which is what leaves a process the reset
        // gate cannot kill.
        self.ptys[spawn].subscribed = false;
        let at = self.read();
        let mut events = Vec::new();
        self.terminals.exit(
            &thread,
            &terminal,
            sequence,
            Exit {
                exit_code: Some(code),
                exit_signal: None,
            },
            &at,
            &mut |event| events.push(event.clone()),
        );
        self.publish_events(&thread, &events);
    }

    /// `enqueueProcessEvent` plus the whole `drainProcessEvents` walk. The pipe is single-flight, so a
    /// step that wants its next event has to run the walk to idle.
    fn drain(
        &mut self,
        thread: &str,
        terminal: &str,
        pid: u32,
        event: PendingEvent,
    ) -> Option<u64> {
        let output = self
            .terminals
            .session(thread, terminal)
            .expect("a delivery belongs to a live session");
        output.enqueue(pid, event);
        let mut sequence = None;
        while let Some(delivery) = output.drain_next(pid) {
            match delivery {
                Delivery::Output { sequence: next, .. } => sequence = Some(next),
                Delivery::Exit { sequence: next, .. } => sequence = Some(next),
            }
        }
        sequence
    }

    fn run(&mut self, steps: &[Step]) {
        for step in steps {
            match *step {
                Step::Open(id, thread, terminal, ask) => {
                    self.open("open", id, thread, terminal, ask)
                }
                Step::Reopen(id, thread, terminal, ask) => {
                    self.open("reopen", id, thread, terminal, ask)
                }
                Step::Emit(spawn, data) => self.emit(spawn, data),
                Step::Exit(spawn, code) => self.exit(spawn, code),
                Step::File(id, thread, terminal) => {
                    let thread = self.thread(thread);
                    self.file_row(id, &thread, terminal)
                }
                Step::FailSpawn(on) => self.fail_spawn = on,
            }
        }
    }

    /// The trace's `t1..tn` labels: the stamps its rows showed, ascending.
    fn labelled(&mut self) -> Vec<Row> {
        let unranked: Vec<&Row> = self
            .timeline
            .iter()
            .filter(|row| row[0] == "S" && row[10] != "-" && !self.stamps.contains(&row[10]))
            .collect();
        assert!(
            unranked.is_empty(),
            "the replay showed a stamp it did not offer for ranking: {unranked:?}"
        );
        let labels: BTreeMap<&str, String> = self
            .stamps
            .iter()
            .enumerate()
            .map(|(index, stamp)| (stamp.as_str(), format!("t{}", index + 1)))
            .collect();
        for row in &mut self.timeline {
            if row[0] != "S" {
                continue;
            }
            if let Some(label) = labels.get(row[10].as_str()) {
                row[10] = label.clone();
            }
        }
        self.timeline.clone()
    }
}

#[test]
fn replays_shipped_reopen_history_reset() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_REOPEN_RESET_TRACE") else {
        eprintln!(
            "skipped reopen reset golden: LMCS_TERMINAL_REOPEN_RESET_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let trace = PathBuf::from(trace);
    let parsed = parse(&trace);
    assert_eq!(parsed.default_terminal, DEFAULT_TERMINAL_ID);

    let mut totals = (0usize, 0usize);
    for case in &parsed.cases {
        let mut replay = Replay::new(Logs::start(case), case);
        replay.run(&schedule(&case.name));
        let timeline = replay.labelled();

        assert_eq!(
            timeline, case.timeline,
            "{} reopen reset timeline",
            case.name
        );
        for claim in &case.claims {
            assert_eq!(claim[1], "match", "{} measured a diff", claim[0]);
        }
        totals = (totals.0 + 1, totals.1 + case.timeline.len());
    }
    assert_eq!(parsed.case_count, totals.0, "every traced case replayed");
    assert_eq!(
        parsed.snapshot_count,
        parsed
            .cases
            .iter()
            .flat_map(|case| case.timeline.iter())
            .filter(|row| row[0] == "S")
            .count(),
        "the trace counted a snapshot row it did not write"
    );
    eprintln!(
        "reopen reset golden: {} cases, {} snapshots, {} timed rows from {}",
        totals.0,
        parsed.snapshot_count,
        totals.1,
        trace.display()
    );
}
