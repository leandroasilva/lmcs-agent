//! The shipped socket fan-out and resize, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_STREAM_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-stream-trace.ts`. `native/pty/src/stream.rs`'s own tests pin each
//! fan-out rule; this one replays them the way a client experiences them: one chronological stream of
//! call boundaries, published events, delivered frames and the rows inside a snapshot, so the
//! interleaving between the two streams is compared and not just each one alone.
//!
//! The trace's rows are the expectations. The schedules below are the same steps the script ran, and
//! the case list is asserted against the `C` rows, so a case added there has to be replayed here. The
//! `A` rows are asserted as answered; the `Q` rows are the harness's own notes about what a barrier
//! had to cross, which no replay can reproduce.
//!
//! One measured thing this port cannot copy, recorded here rather than in the module:
//!
//! - `metadata-error-after-eviction`: the shipped `open` keeps mutating the record retention just
//!   dropped and publishes `error` for it, and its attach answers a snapshot for a terminal the
//!   sessions table has already forgotten. The port ends the record instead, so no `error` is
//!   published and the attach answers a lookup failure. Those two rows are dropped from the
//!   expectation and the boundary is rewritten, which leaves every other observation compared.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lmcs_pty::lifecycle::{
    Event, Exit, LaunchAsk, Metadata, Resize, Size, Status, Terminals, Viewport, WriteError,
};
use lmcs_pty::node_pty::exit_event;
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::persisted::PersistedOutput;
use lmcs_pty::stream::{AttachFrame, Fanout, Frame, Kind, MetadataFrame, Publication, Snapshot};
use lmcs_pty::{Delivery, PendingEvent};
use lmcs_terminal_history::{
    BoundedHistory, DEFAULT_TERMINAL_ID, HistoryPersistence, UNLIMITED_BYTES,
};

type Row = Vec<String>;

struct Case {
    name: String,
    cap: usize,
    clock: String,
    threads: Vec<String>,
    fail_spawn: bool,
    /// The `B`/`O`/`R`/`V` rows in the order the shipped run wrote them, without their sequence.
    timeline: Vec<Row>,
    resize_calls: usize,
    claims: Vec<Row>,
}

struct Parsed {
    default_terminal: String,
    cases: Vec<Case>,
    case_count: usize,
    frame_count: usize,
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
    let mut frame_count = 0;
    let mut seq = 0u64;
    for line in fs::read_to_string(trace).unwrap().lines() {
        let fields: Vec<_> = line.split('\t').collect();
        match fields[0] {
            "H" => default_terminal = unhex(fields[1]),
            "I" | "Q" => {}
            "C" => {
                case_count += 1;
                building = Some(Case {
                    name: fields[1].to_owned(),
                    cap: fields[2].parse().expect("retention ceiling"),
                    clock: fields[3].to_owned(),
                    threads: unhex(fields[4]).split(',').map(str::to_owned).collect(),
                    fail_spawn: fields[5] == "1",
                    timeline: Vec::new(),
                    resize_calls: 0,
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
                    fields[9].to_owned(),
                    fields[10].to_owned(),
                    fields[11].to_owned(),
                ],
            ),
            "R" => {
                frame_count += 1;
                timed(
                    &mut seq,
                    &mut building,
                    fields[1],
                    vec![
                        "R".to_owned(),
                        fields[2].to_owned(),
                        unhex(fields[3]),
                        unhex(fields[4]),
                        unhex(fields[5]),
                        fields[6].to_owned(),
                        fields[7].to_owned(),
                        fields[8].to_owned(),
                    ],
                );
            }
            "V" => timed(
                &mut seq,
                &mut building,
                fields[1],
                vec![
                    "V".to_owned(),
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    unhex(fields[4]),
                    unhex(fields[5]),
                    unhex(fields[6]),
                    fields[7].to_owned(),
                    fields[8].to_owned(),
                    fields[9].to_owned(),
                    fields[10].to_owned(),
                ],
            ),
            "P" => {
                assert_eq!(fields[1], "pty");
                building
                    .as_mut()
                    .expect("pty count outside a case")
                    .resize_calls = fields[2].parse().expect("resize count");
            }
            "A" => building
                .as_mut()
                .expect("claim outside a case")
                .claims
                .push(vec![
                    unhex(fields[1]),
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
                    fields[2].parse::<usize>().expect("frame count"),
                    frame_count,
                    "the trace counted frames it did not write"
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
        frame_count,
    }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Step {
    /// `open` of a terminal, which is the only call that both names a viewport and spawns on it.
    Open(&'static str, usize, &'static str, Size),
    /// `attachStream` of a terminal the table already has: the lookup answers, it does not spawn, and
    /// the viewport it names runs the size gate.
    Attach(&'static str, usize, &'static str, Size),
    /// `attachStream` that starts the terminal it subscribed to, which is the race the duplicate rule
    /// exists for.
    AttachStart(&'static str, usize, &'static str, Size),
    /// `open` of a terminal the table already has, which is the other site with the size gate.
    Reopen(&'static str, usize, &'static str, Size),
    Metadata(&'static str),
    Detach(&'static str),
    Emit(usize, &'static str),
    Exit(usize, i32),
    Resize(usize, &'static str, u32, u32),
    Clear(&'static str, usize, &'static str),
    Close(&'static str, usize, &'static str, bool),
}

/// The trace's harness asks for this viewport whenever a step names none, so most of the replay's
/// opens and attaches are at 100x24 and no gate fires.
const OPEN: Size = Size {
    cols: 100,
    rows: 24,
};
const WIDE: Size = Size {
    cols: 132,
    rows: 43,
};
const NARROW: Size = Size { cols: 90, rows: 20 };

fn schedule(name: &str) -> &'static [Step] {
    use Step::*;
    match name {
        "attach-live-feed" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", OPEN),
            Emit(0, "hello\n"),
            Resize(0, "term-1", 132, 43),
            Clear("clear-1", 0, "term-1"),
            Exit(0, 4),
            Close("close-1", 0, "term-1", false),
        ],
        "attach-starts-its-own-terminal" => {
            &[AttachStart("a1", 0, "term-1", OPEN), Emit(0, "after\n")]
        }
        "attach-reopen-sends-snapshot" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", OPEN),
            Exit(0, 0),
            Open("open-2", 0, "term-1", OPEN),
        ],
        "attach-two-clients-and-a-neighbour" => &[
            Open("open-1", 0, "term-1", OPEN),
            Open("open-2", 0, "term-2", OPEN),
            Attach("a1", 0, "term-1", OPEN),
            Attach("a2", 0, "term-1", OPEN),
            Attach("a3", 0, "term-2", OPEN),
            Emit(0, "shared\n"),
            Exit(1, 9),
        ],
        "metadata-lifecycle" => &[
            Metadata("m1"),
            Open("open-1", 0, "term-1", OPEN),
            Emit(0, "text\n"),
            Clear("clear-1", 0, "term-1"),
            Exit(0, 6),
            Close("close-1", 0, "term-1", true),
        ],
        "metadata-error-after-eviction" => &[Metadata("m1"), AttachStart("a1", 0, "term-1", OPEN)],
        "resize-moves-the-row-silently" => &[
            Open("open-1", 0, "term-1", OPEN),
            Open("open-2", 0, "term-2", OPEN),
            Resize(0, "term-1", 90, 30),
            Metadata("m1"),
            Resize(0, "term-2", 91, 31),
            Metadata("m2"),
        ],
        "resize-of-an-idle-terminal" => &[
            Open("open-1", 0, "term-1", OPEN),
            Exit(0, 0),
            Attach("a1", 0, "term-1", OPEN),
            Resize(0, "term-1", 40, 12),
            Resize(0, "term-9", 41, 13),
            Metadata("m1"),
        ],
        "detach-leaves-the-others-alone" => &[
            Open("open-a1", 0, "term-1", OPEN),
            Open("open-b1", 1, "term-1", OPEN),
            Attach("a1", 0, "term-1", OPEN),
            Metadata("m1"),
            Attach("a2", 1, "term-1", OPEN),
            Detach("a1"),
            Exit(1, 0),
            Exit(0, 0),
        ],
        // The gate's own five, plus the one case that shows a re-open is not a start.
        "attach-of-a-running-terminal-keeps-its-size" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", OPEN),
            Metadata("m1"),
        ],
        "attach-of-a-running-terminal-takes-a-new-size" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", WIDE),
            Metadata("m1"),
        ],
        "attach-of-an-exited-terminal-skips-the-size-gate" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", WIDE),
            Exit(0, 0),
            Attach("a2", 0, "term-1", NARROW),
            Metadata("m1"),
        ],
        "reopen-of-a-running-terminal-with-its-size" => &[
            Open("open-1", 0, "term-1", OPEN),
            Reopen("reopen-1", 0, "term-1", OPEN),
            Metadata("m1"),
        ],
        "reopen-of-a-running-terminal-with-a-new-size" => &[
            Open("open-1", 0, "term-1", OPEN),
            Reopen("reopen-1", 0, "term-1", WIDE),
            Metadata("m1"),
        ],
        "attach-sizes-are-remembered-between-clients" => &[
            Open("open-1", 0, "term-1", OPEN),
            Attach("a1", 0, "term-1", WIDE),
            Attach("a2", 0, "term-1", WIDE),
            Attach("a3", 0, "term-1", OPEN),
        ],
        other => panic!("no replay schedule for {other}"),
    }
}

struct Logs {
    dir: PathBuf,
    worker: Option<HistoryPersistence>,
}

impl Logs {
    fn start(case: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "lmcs-stream-golden-{}-{case}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self {
            worker: Some(HistoryPersistence::start(dir.clone(), drop).unwrap()),
            dir,
        }
    }

    fn session(&self, thread_id: &str, terminal_id: &str) -> PersistedOutput {
        PersistedOutput::new(
            TerminalOutput::new(BoundedHistory::with_limits(5_000, UNLIMITED_BYTES, b"")),
            self.worker.as_ref().unwrap().handle(),
            &self.dir,
            thread_id,
            terminal_id,
        )
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

fn status_text(status: Status) -> String {
    status.as_str().to_owned()
}

fn absent(value: Option<u64>) -> String {
    value.map_or_else(|| "-".to_owned(), |value| value.to_string())
}

fn signed(value: Option<i32>) -> String {
    value.map_or_else(|| "-".to_owned(), |value| value.to_string())
}

fn pid_text(pid: Option<u32>) -> String {
    pid.map_or_else(|| "-".to_owned(), |pid| pid.to_string())
}

/// The pid the trace's fake adapter hands out first, which is why the replay can use the same numbers
/// rather than normalizing them away.
const FIRST_PID: u32 = 7600;

struct Replay {
    logs: Logs,
    terminals: Terminals,
    fanout: Fanout,
    threads: Vec<String>,
    fail_spawn: bool,
    reads: u64,
    /// The processes the adapter handed out, in spawn order.
    processes: Vec<(String, String, u32)>,
    /// Stream name by subscriber position, which is how the trace's `R` rows say who heard what. A
    /// detach leaves its name in place, because the registry leaves the hole too.
    streams: Vec<String>,
    timeline: Vec<Row>,
    /// Every stamp an `O`, `R` or `V` row showed: the set the trace ranks into `t1..tn`.
    stamps: BTreeSet<String>,
    resize_calls: usize,
}

impl Replay {
    fn new(logs: Logs, case: &Case) -> Self {
        assert_eq!(
            case.clock, "step",
            "the replay models a clock that advances one step per read"
        );
        let terminals = Terminals::with_retention(&logs.dir, case.cap);
        Self {
            logs,
            terminals,
            fanout: Fanout::new(),
            threads: case.threads.clone(),
            fail_spawn: case.fail_spawn,
            reads: 0,
            processes: Vec::new(),
            streams: Vec::new(),
            timeline: Vec::new(),
            stamps: BTreeSet::new(),
            resize_calls: 0,
        }
    }

    fn thread(&self, index: usize) -> String {
        self.threads[index].clone()
    }

    /// One `nowIso` read. Only values a row showed are ranked, so a read the shipped manager spent on
    /// a record nobody observed cannot move a label either way.
    fn read(&mut self) -> String {
        self.reads += 1;
        format!("s{:03}", self.reads)
    }

    fn push(&mut self, row: Row) -> usize {
        self.timeline.push(row);
        self.timeline.len() - 1
    }

    /// Fill a stamp column with the value the shipped row carried and make it rankable. A row with no
    /// snapshot leaves the column at `-`, which the trace never labels.
    fn stamp(&mut self, row: usize, column: usize, at: &str) {
        self.timeline[row][column] = at.to_owned();
        self.stamps.insert(at.to_owned());
    }

    fn boundary(&mut self, kind: &str, id: &str, status: &str) {
        self.push(vec![
            "B".to_owned(),
            kind.to_owned(),
            id.to_owned(),
            status.to_owned(),
        ]);
    }

    fn answer(&self, ok: bool) -> String {
        if ok {
            return "ok".to_owned();
        }
        format!("err:{}", WriteError::Missing.as_str())
    }

    /// `enqueueProcessEvent` plus the whole `drainProcessEvents` walk, as the exit golden runs it.
    fn drain(
        &mut self,
        thread: &str,
        terminal: &str,
        pid: u32,
        event: PendingEvent,
    ) -> Vec<Delivery> {
        let output = self
            .terminals
            .session(thread, terminal)
            .expect("a delivery belongs to a live session");
        output.enqueue(pid, event);
        let mut deliveries = Vec::new();
        while let Some(delivery) = output.drain_next(pid) {
            deliveries.push(delivery);
        }
        assert!(
            deliveries.len() <= 1,
            "one queued chunk walks as one delivery: {deliveries:?}"
        );
        deliveries
    }

    /// One publication: the feed row first, because the trace subscribed the feed before any stream,
    /// and then the frames the registry hands out in subscription order.
    fn publish(
        &mut self,
        publication: Publication,
        pid: Option<u32>,
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
        snapshot: Option<Snapshot>,
    ) {
        let carries = snapshot.is_some();
        let publication = match &snapshot {
            Some(snapshot) => publication.with_snapshot(snapshot.clone()),
            None => publication,
        };
        let row = self.push(vec![
            "O".to_owned(),
            publication.kind.as_str().to_owned(),
            publication.thread_id.clone(),
            publication.terminal_id.clone(),
            absent(publication.sequence),
            pid_text(pid.filter(|_| carries)),
            signed(exit_code),
            signed(exit_signal),
            "-".to_owned(),
            if carries { "1" } else { "0" }.to_owned(),
            "1".to_owned(),
        ]);
        if let Some(snapshot) = &snapshot {
            self.stamp(row, 8, &snapshot.updated_at);
        }
        let delivered = self.fanout.publish(&publication, &mut |thread, terminal| {
            self.terminals.metadata(thread, terminal)
        });
        for (subscriber, frame) in delivered {
            let stream = self.streams[subscriber].clone();
            self.frame(&stream, &frame);
        }
    }

    /// A lifecycle transition. The shipped `started` and `restarted` events are built beside the
    /// session they just stamped, so their feed rows carry a snapshot; measured on `attach-live-feed`,
    /// an `exited` event does not, which is why its own stamp never reaches a row.
    fn publish_event(&mut self, thread: &str, event: &Event) {
        let terminal = event.terminal_id().to_owned();
        let state = self.terminals.state(thread, &terminal).cloned();
        let carrying = matches!(event, Event::Started { .. } | Event::Restarted { .. });
        let snapshot = match (carrying, state.clone()) {
            (true, Some(state)) => Some(Snapshot {
                thread_id: thread.to_owned(),
                terminal_id: terminal.clone(),
                updated_at: state.updated_at,
                sequence: Some(event.sequence()),
            }),
            _ => None,
        };
        let (pid, exit_code, exit_signal) = match event {
            Event::Started { pid, .. } => (Some(*pid), None, None),
            Event::Restarted { .. } => (state.and_then(|state| state.pid), None, None),
            Event::Exited {
                exit_code,
                exit_signal,
                ..
            } => (None, *exit_code, *exit_signal),
            _ => (None, None, None),
        };
        self.publish(
            Publication::from_event(thread, event),
            pid,
            exit_code,
            exit_signal,
            snapshot,
        );
    }

    fn publish_events(&mut self, thread: &str, events: &[Event]) {
        for event in events {
            self.publish_event(thread, event);
        }
    }

    /// One delivered frame, with the rows of a metadata snapshot right behind it as the trace writes
    /// them: the frame takes its sequence before its rows do.
    fn frame(&mut self, stream: &str, frame: &Frame) {
        match frame {
            Frame::Attach(AttachFrame::Snapshot { snapshot }) => {
                let row = self.push(vec![
                    "R".to_owned(),
                    stream.to_owned(),
                    "snapshot".to_owned(),
                    snapshot.thread_id.clone(),
                    snapshot.terminal_id.clone(),
                    absent(snapshot.sequence),
                    "-".to_owned(),
                    "1".to_owned(),
                ]);
                self.stamp(row, 6, &snapshot.updated_at);
            }
            Frame::Attach(AttachFrame::Event(publication)) => {
                self.push(vec![
                    "R".to_owned(),
                    stream.to_owned(),
                    publication.kind.as_str().to_owned(),
                    publication.thread_id.clone(),
                    publication.terminal_id.clone(),
                    // An attach event frame carries the event's own sequence and no stamp, which is
                    // what separates it from the metadata stream's row.
                    absent(publication.sequence),
                    "-".to_owned(),
                    "1".to_owned(),
                ]);
            }
            Frame::Metadata(MetadataFrame::Snapshot { terminals }) => {
                self.push(vec![
                    "R".to_owned(),
                    stream.to_owned(),
                    "snapshot".to_owned(),
                    "<nonstring>".to_owned(),
                    "<nonstring>".to_owned(),
                    "-".to_owned(),
                    "-".to_owned(),
                    "1".to_owned(),
                ]);
                for (index, terminal) in terminals.iter().enumerate() {
                    self.metadata_row(stream, index, terminal);
                }
            }
            Frame::Metadata(MetadataFrame::Upsert { terminal }) => {
                let row = self.push(vec![
                    "R".to_owned(),
                    stream.to_owned(),
                    "upsert".to_owned(),
                    terminal.thread_id.clone(),
                    terminal.terminal_id.clone(),
                    // A metadata row has no sequence field, so an upsert never carries one.
                    "-".to_owned(),
                    "-".to_owned(),
                    "1".to_owned(),
                ]);
                self.stamp(row, 6, &terminal.updated_at);
            }
            Frame::Metadata(MetadataFrame::Remove {
                thread_id,
                terminal_id,
            }) => {
                self.push(vec![
                    "R".to_owned(),
                    stream.to_owned(),
                    "remove".to_owned(),
                    thread_id.clone(),
                    terminal_id.clone(),
                    "-".to_owned(),
                    "-".to_owned(),
                    "1".to_owned(),
                ]);
            }
        }
    }

    fn metadata_row(&mut self, stream: &str, index: usize, terminal: &Metadata) {
        let row = self.push(vec![
            "V".to_owned(),
            stream.to_owned(),
            index.to_string(),
            terminal.thread_id.clone(),
            terminal.terminal_id.clone(),
            status_text(terminal.status),
            pid_text(terminal.pid),
            signed(terminal.exit_code),
            signed(terminal.exit_signal),
            "-".to_owned(),
        ]);
        self.stamp(row, 9, &terminal.updated_at);
    }

    /// The initial snapshot `openOrAttachForStream` answers with: the record as it stands, sequence
    /// and all.
    fn initial(&mut self, thread: &str, terminal: &str) -> Option<Snapshot> {
        let state = self.terminals.state(thread, terminal)?.clone();
        let sequence = self
            .terminals
            .session(thread, terminal)
            .expect("a record with state has output")
            .sequence();
        Some(Snapshot {
            thread_id: thread.to_owned(),
            terminal_id: terminal.to_owned(),
            updated_at: state.updated_at,
            sequence: Some(sequence),
        })
    }

    /// `startSession`, reached by `open` and by an attach whose lookup starts the terminal. A record
    /// the table still has is started on top of its own sequence, which is what makes a reopen
    /// continue the numbering instead of restarting it. The shipped call writes the input's viewport
    /// onto the record before it spawns, so both transitions carry it.
    fn start(&mut self, thread_index: usize, terminal: &str, size: Size) -> bool {
        let thread = self.thread(thread_index);
        if self.terminals.state(&thread, terminal).is_none() {
            let insert = self.read();
            self.terminals.insert(
                &thread,
                terminal,
                self.logs.session(&thread, terminal),
                Some(size),
                &LaunchAsk::default(),
                &insert,
            );
        }
        let mut events = Vec::new();
        let started = if self.fail_spawn {
            let at = self.read();
            self.terminals
                .mark_error(
                    &thread,
                    terminal,
                    "Failed to spawn PTY process",
                    Some(size),
                    &at,
                    &mut |event| events.push(event.clone()),
                )
                .is_some()
        } else {
            let pid = FIRST_PID + self.processes.len() as u32;
            let at = self.read();
            let sequence = self.terminals.mark_running(
                &thread,
                terminal,
                pid,
                Some(size),
                &at,
                &mut |event| events.push(event.clone()),
            );
            if sequence.is_some() {
                self.processes
                    .push((thread.clone(), terminal.to_owned(), pid));
            }
            sequence.is_some()
        };
        self.publish_events(&thread, &events);
        started
    }

    fn open(&mut self, id: &str, thread_index: usize, terminal: &str, size: Size) {
        self.boundary("open", id, "-");
        let started = self.start(thread_index, terminal, size);
        self.boundary("open", id, &self.answer(started));
    }

    /// `openLocked` on a key the table already has. Nothing here reaches a stream: the shipped call
    /// answers the caller with a snapshot and publishes no event whatever the gate decides.
    fn reopen(&mut self, id: &str, thread_index: usize, terminal: &str, size: Size) {
        self.boundary("reopen", id, "-");
        let thread = self.thread(thread_index);
        // The shipped site reads the clock only inside the branch that applies a size. Reading here
        // cannot move a label, because labels rank only stamps a row actually carried.
        let at = self.read();
        match self.terminals.viewport(&thread, terminal, size, &at) {
            // A record with no process is the branch that starts one again. The history reset that
            // comes with it is the next slice's, and no measured case reaches it.
            Viewport::Missing | Viewport::NotRunning => {
                self.start(thread_index, terminal, size);
            }
            Viewport::Applied(_) => self.resize_calls += 1,
            Viewport::Unchanged => {}
        }
        self.boundary("reopen", id, "ok");
    }

    fn attach(&mut self, id: &str, thread_index: usize, terminal: &str, size: Size, start: bool) {
        self.boundary("attach", id, "-");
        let thread = self.thread(thread_index);
        let subscriber = self.fanout.attach(&thread, terminal);
        self.streams.push(id.to_owned());
        let existed = self.terminals.state(&thread, terminal).is_some();
        let ready = existed || (start && self.start(thread_index, terminal, size));
        if existed {
            // The lookup that spawns returns before this gate, so an attach that started its own
            // terminal never runs it.
            let at = self.read();
            if matches!(
                self.terminals.viewport(&thread, terminal, size, &at),
                Viewport::Applied(_)
            ) {
                self.resize_calls += 1;
            }
        }
        if ready {
            let initial = self
                .initial(&thread, terminal)
                .expect("a ready record answers a snapshot");
            let frames = self
                .fanout
                .opened_attach(subscriber, &initial)
                .expect("the stream subscribed a moment ago");
            for frame in &frames {
                self.frame(id, frame);
            }
        }
        self.boundary("attach", id, &self.answer(ready));
    }

    fn metadata(&mut self, id: &str) {
        self.boundary("metadata", id, "-");
        let subscriber = self.fanout.metadata();
        self.streams.push(id.to_owned());
        let view = self.terminals.view();
        let frames = self
            .fanout
            .opened_metadata(subscriber, view, &mut |thread, terminal| {
                self.terminals.metadata(thread, terminal)
            })
            .expect("the stream subscribed a moment ago");
        for frame in &frames {
            self.frame(id, frame);
        }
        self.boundary("metadata", id, "ok");
    }

    fn detach(&mut self, id: &str) {
        self.boundary("detach", id, "-");
        let subscriber = self
            .streams
            .iter()
            .position(|stream| stream == id)
            .expect("a detach names a subscribed stream");
        assert!(
            self.fanout.unsubscribe(subscriber),
            "{id} was already detached"
        );
        self.boundary("detach", id, "ok");
    }

    fn emit(&mut self, spawn: usize, data: &str) {
        let (thread, terminal, pid) = self.processes[spawn].clone();
        // `emit` and `exit` are the adapter's own callbacks: the trace records the call and never a
        // return, because the walk it triggers publishes on its way out.
        self.boundary("emit", &format!("spawn-{spawn}"), "-");
        let deliveries = self.drain(&thread, &terminal, pid, PendingEvent::Data(data.to_owned()));
        let Some(sequence) = deliveries.iter().find_map(|delivery| match delivery {
            Delivery::Output { sequence, .. } => Some(*sequence),
            _ => None,
        }) else {
            return;
        };
        // The drain stamps the record for the chunk it dequeued, which is what keeps a terminal that
        // is producing text ahead of retention.
        let at = self.read();
        self.terminals.touch(&thread, &terminal, &at);
        self.publish(
            Publication::new(Kind::Output, &thread, &terminal, Some(sequence)),
            None,
            None,
            None,
            None,
        );
    }

    fn exit(&mut self, spawn: usize, code: i32) {
        let (thread, terminal, pid) = self.processes[spawn].clone();
        self.boundary("exit", &format!("spawn-{spawn}"), "-");
        let deliveries = self.drain(
            &thread,
            &terminal,
            pid,
            PendingEvent::Exit(exit_event(code, None)),
        );
        let sequence = deliveries
            .iter()
            .find_map(|delivery| match delivery {
                Delivery::Exit { sequence, .. } => Some(*sequence),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the exit of {thread}/{terminal} drained as {deliveries:?}"));
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

    fn resize(&mut self, thread_index: usize, terminal: &str, cols: u32, rows: u32) {
        let thread = self.thread(thread_index);
        self.boundary("resize", &format!("resize-{terminal}"), "-");
        let at = self.read();
        if matches!(
            self.terminals.resize(&thread, terminal, cols, rows, &at),
            Resize::Applied { .. }
        ) {
            self.resize_calls += 1;
        }
        // Every outcome of a resize is a success on the wire, which is why a client can watch a row
        // move in the sessions list without ever being told.
        self.boundary("resize", &format!("resize-{terminal}"), "ok");
    }

    fn clear(&mut self, id: &str, thread_index: usize, terminal: &str) {
        let thread = self.thread(thread_index);
        self.boundary("clear", id, "-");
        let at = self.read();
        let mut events = Vec::new();
        let cleared = self.terminals.clear(&thread, terminal, &at, &mut |event| {
            events.push(event.clone())
        });
        self.publish_events(&thread, &events);
        self.boundary("clear", id, &self.answer(cleared.is_ok()));
    }

    fn close(&mut self, id: &str, thread_index: usize, terminal: &str, delete: bool) {
        let thread = self.thread(thread_index);
        self.boundary("close", id, "-");
        let mut events = Vec::new();
        let warnings = self.terminals.close(
            &thread,
            Some(terminal),
            delete.then_some(true),
            &mut |event| events.push(event.clone()),
        );
        self.publish_events(&thread, &events);
        assert!(
            warnings
                .expect("a close of these records cannot fail")
                .is_empty(),
            "a golden close leaves no warning behind"
        );
        self.boundary("close", id, "ok");
    }

    fn run(&mut self, steps: &[Step]) {
        for step in steps {
            match *step {
                Step::Open(id, thread, terminal, size) => self.open(id, thread, terminal, size),
                Step::Attach(id, thread, terminal, size) => {
                    self.attach(id, thread, terminal, size, false)
                }
                Step::AttachStart(id, thread, terminal, size) => {
                    self.attach(id, thread, terminal, size, true)
                }
                Step::Reopen(id, thread, terminal, size) => self.reopen(id, thread, terminal, size),
                Step::Metadata(id) => self.metadata(id),
                Step::Detach(id) => self.detach(id),
                Step::Emit(spawn, data) => self.emit(spawn, data),
                Step::Exit(spawn, code) => self.exit(spawn, code),
                Step::Resize(thread, terminal, cols, rows) => {
                    self.resize(thread, terminal, cols, rows)
                }
                Step::Clear(id, thread, terminal) => self.clear(id, thread, terminal),
                Step::Close(id, thread, terminal, delete) => {
                    self.close(id, thread, terminal, delete)
                }
            }
        }
    }

    /// The trace's `t1..tn` labels: the stamps its rows showed, ascending.
    fn labelled(&mut self) -> Vec<Row> {
        let column = |row: &Row| match row[0].as_str() {
            "O" => Some(8),
            "R" => Some(6),
            "V" => Some(9),
            _ => None,
        };
        let unranked: Vec<&Row> = self
            .timeline
            .iter()
            .filter(|row| {
                column(row)
                    .is_some_and(|index| row[index] != "-" && !self.stamps.contains(&row[index]))
            })
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
            let Some(index) = column(row) else { continue };
            if let Some(label) = labels.get(row[index].as_str()) {
                row[index] = label.clone();
            }
        }
        self.timeline.clone()
    }
}

#[test]
fn replays_shipped_stream_fanout_and_resize() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_STREAM_TRACE") else {
        eprintln!(
            "skipped stream golden: LMCS_TERMINAL_STREAM_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let trace = PathBuf::from(trace);
    let parsed = parse(&trace);
    assert_eq!(parsed.default_terminal, DEFAULT_TERMINAL_ID);

    let mut totals = (0usize, 0usize, 0usize);
    for case in &parsed.cases {
        let mut replay = Replay::new(Logs::start(&case.name), case);
        replay.run(schedule(&case.name));
        let timeline = replay.labelled();

        let mut expected = case.timeline.clone();
        if case.name == "metadata-error-after-eviction" {
            // Declared divergence: no `error` for a record the table dropped, so the attach that
            // caused it has no snapshot to answer with either.
            expected.retain(|row| {
                !(row[0] == "O" && row[1] == "error") && !(row[0] == "R" && row[1] == "a1")
            });
            for row in &mut expected {
                if row[0] == "B" && row[1] == "attach" && row[3] == "ok" {
                    row[3] = replay.answer(false);
                }
            }
        }

        assert_eq!(timeline, expected, "{} fan-out timeline", case.name);
        assert_eq!(
            replay.resize_calls, case.resize_calls,
            "{} resizes that reached the process",
            case.name
        );
        for claim in &case.claims {
            assert_eq!(claim[1], "match", "{} measured a diff", claim[0]);
        }
        totals = (
            totals.0 + 1,
            totals.1 + case.timeline.iter().filter(|row| row[0] == "R").count(),
            totals.2 + timeline.len(),
        );
    }
    assert_eq!(parsed.case_count, totals.0, "every traced case replayed");
    assert_eq!(
        parsed.frame_count, totals.1,
        "every traced frame belongs to a replayed timeline"
    );
    eprintln!(
        "stream golden: {} cases, {} frames, {} timed rows from {}",
        totals.0,
        totals.1,
        totals.2,
        trace.display()
    );
}
