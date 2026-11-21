//! The shipped manager's exit state and inactive-session retention, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_EXIT_RETENTION_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-exit-retention-trace.ts`. `native/pty/src/lifecycle.rs`'s own tests
//! pin each rule; this one replays the shipped schedules end to end: which events a schedule
//! publishes and in what order, what each call answers, and what the metadata view the client reads
//! looks like after every step.
//!
//! The trace's rows are the expectations. The schedules below are the same steps the script ran, and
//! the case list is asserted against the `C` rows, so a case added there has to be replayed here.
//!
//! Two measured things this port cannot copy exactly, both recorded here rather than in the module:
//!
//! - `cap-zero-open`: the shipped `open` keeps mutating the session object retention just dropped and
//!   publishes `started` for it, so the client is told a terminal is running when the table has
//!   already forgotten it. The port ends the record instead, which drops the `started` row and the
//!   snapshot row. Everything else the client can still observe is compared.
//! - `localeCompare` versus ordinal ids: the `K` rows are checked here, so the disagreement stays
//!   measured instead of assumed. Thread ids, terminal ids and ISO stamps are in the agreeing set.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lmcs_pty::lifecycle::{Event, Exit, Status, Terminals, Write, WriteError};
use lmcs_pty::node_pty::exit_event;
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::persisted::PersistedOutput;
use lmcs_pty::{Delivery, PendingEvent};
use lmcs_terminal_history::{
    BoundedHistory, DEFAULT_TERMINAL_ID, HistoryPersistence, UNLIMITED_BYTES,
};

type Row = Vec<String>;

struct Expected {
    name: String,
    cap: usize,
    clock: String,
    threads: Vec<String>,
    fail_spawn: bool,
    /// Return boundaries: `(kind, id, status)`. The call-side rows carry no status and are dropped.
    boundaries: Vec<Row>,
    /// `(type, terminalId, sequence, exitCode, exitSignal, message)`.
    events: Vec<Row>,
    /// `(kind, id, status, pid, sequence, history)`.
    snapshots: Vec<Row>,
    /// One entry per `observe` step, in the order the manager sorted them.
    views: Vec<Vec<Row>>,
}

struct Parsed {
    cases: Vec<Expected>,
    comparators: Vec<Row>,
    default_terminal: String,
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

/// `hexOf` writes `-` for an absent value and the empty string for an empty one.
fn hex_field(value: &str) -> String {
    match value {
        "-" => "-".to_owned(),
        "" => String::new(),
        value => unhex(value),
    }
}

#[derive(Default)]
struct Building {
    name: String,
    cap: usize,
    clock: String,
    threads: Vec<String>,
    fail_spawn: bool,
    boundaries: Vec<Row>,
    events: Vec<Row>,
    snapshots: Vec<Row>,
    observes: usize,
    views: BTreeMap<usize, Vec<(usize, Row)>>,
}

impl Building {
    fn finish(self) -> Expected {
        let views = (1..=self.observes)
            .map(|obs| {
                let mut rows = self.views.get(&obs).cloned().unwrap_or_default();
                rows.sort_by_key(|(index, row)| (*index, row.clone()));
                rows.into_iter().map(|(_, row)| row).collect()
            })
            .collect();
        Expected {
            name: self.name,
            cap: self.cap,
            clock: self.clock,
            threads: self.threads,
            fail_spawn: self.fail_spawn,
            boundaries: self.boundaries,
            events: self.events,
            snapshots: self.snapshots,
            views,
        }
    }
}

fn parse(trace: &Path) -> Parsed {
    let mut cases: Vec<Expected> = Vec::new();
    let mut comparators: Vec<Row> = Vec::new();
    let mut default_terminal = String::new();
    let mut building: Option<Building> = None;
    for line in fs::read_to_string(trace).unwrap().lines() {
        let fields: Vec<_> = line.split('\t').collect();
        match fields[0] {
            "H" => default_terminal = hex_field(fields[1]),
            "K" => comparators.push(vec![
                unhex(fields[1]),
                unhex(fields[2]),
                fields[3].to_owned(),
                fields[4].to_owned(),
                fields[5].to_owned(),
            ]),
            "C" => {
                building = Some(Building {
                    name: fields[1].to_owned(),
                    cap: fields[2].parse().expect("retention ceiling"),
                    clock: fields[3].to_owned(),
                    threads: hex_field(fields[4]).split(',').map(str::to_owned).collect(),
                    fail_spawn: fields[5] == "1",
                    ..Building::default()
                })
            }
            "B" => {
                let case = building.as_mut().expect("boundary inside a case");
                case.boundaries.push(vec![
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    hex_field(fields[4]),
                ]);
                if fields[2] == "observe" {
                    case.observes += 1;
                }
            }
            "O" => {
                let case = building.as_mut().expect("event inside a case");
                case.events.push(vec![
                    hex_field(fields[2]),
                    hex_field(fields[3]),
                    fields[4].to_owned(),
                    fields[6].to_owned(),
                    fields[7].to_owned(),
                    if hex_field(fields[8]) == "-" {
                        "-"
                    } else {
                        "text"
                    }
                    .to_owned(),
                ]);
            }
            "S" => {
                let case = building.as_mut().expect("snapshot inside a case");
                case.snapshots.push(vec![
                    fields[2].to_owned(),
                    fields[3].to_owned(),
                    hex_field(fields[4]),
                    fields[5].to_owned(),
                    fields[6].to_owned(),
                    hex_field(fields[9]),
                ]);
            }
            "T" => {
                let case = building.as_mut().expect("metadata row inside a case");
                let (obs, index) = (
                    fields[2].parse::<usize>().expect("observation"),
                    fields[3].parse::<usize>().expect("row index"),
                );
                case.views.entry(obs).or_default().push((
                    index,
                    vec![
                        hex_field(fields[4]),
                        hex_field(fields[5]),
                        hex_field(fields[6]),
                        fields[7].to_owned(),
                        fields[8].to_owned(),
                        fields[9].to_owned(),
                        fields[10].to_owned(),
                    ],
                ));
            }
            "X" => cases.push(building.take().expect("case end without a case").finish()),
            "Q" | "A" | "Z" | "F" => {}
            code => panic!("unknown trace row {code}"),
        }
    }
    assert!(building.is_none(), "trace ended inside a case");
    Parsed {
        cases,
        comparators,
        default_terminal,
    }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Step {
    Observe(&'static str),
    Open(&'static str, usize, &'static str),
    Restart(&'static str, usize, &'static str),
    Emit(usize, &'static str),
    /// The exit the adapter reported. A code the shipped `Number.isInteger` gate rejected is the
    /// port's `None`, so the option is the carrier here rather than a mapping step.
    Exit(usize, Option<i32>, Option<i32>),
    Write(usize, &'static str),
    Clear(&'static str, usize, &'static str),
    Close(&'static str, usize, &'static str),
}

fn schedule(name: &str) -> &'static [Step] {
    use Step::*;
    match name {
        "exit-basic" => &[
            Observe("empty"),
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Emit(0, "hello\n"),
            Observe("running"),
            Exit(0, Some(0), None),
            Observe("after-exit"),
            Clear("clear-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-clear"),
        ],
        "exit-code-nan" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, None, None),
            Observe("after-exit"),
        ],
        "exit-code-fraction" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, None, None),
            Observe("after-exit"),
        ],
        "exit-signal-thirteen" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, Some(0), Some(13)),
            Observe("after-exit"),
        ],
        "write-after-exit" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, Some(3), None),
            Write(0, DEFAULT_TERMINAL_ID),
            Observe("after-write"),
        ],
        "cap-reversed-ids" => &[
            Open("open-3", 0, "term-3"),
            Exit(0, Some(0), None),
            Open("open-2", 0, "term-2"),
            Exit(1, Some(0), None),
            Observe("two-exited"),
            Open("open-1", 0, "term-1"),
            Exit(2, Some(0), None),
            Observe("after-third-exit"),
            Clear("clear-3", 0, "term-3"),
            Clear("clear-2", 0, "term-2"),
            Clear("clear-1", 0, "term-1"),
            Observe("final"),
        ],
        "cap-tie-break" => &[
            Open("open-1", 0, "term-1"),
            Exit(0, Some(0), None),
            Open("open-2", 0, "term-2"),
            Exit(1, Some(0), None),
            Open("open-3", 0, "term-3"),
            Exit(2, Some(0), None),
            Observe("after-third-exit"),
            Clear("clear-1", 0, "term-1"),
            Clear("clear-2", 0, "term-2"),
            Clear("clear-3", 0, "term-3"),
            Observe("final"),
        ],
        "cap-protects-running" => &[
            Open("open-1", 0, "term-1"),
            Open("open-2", 0, "term-2"),
            Exit(0, Some(0), None),
            Open("open-3", 0, "term-3"),
            Exit(2, Some(0), None),
            Observe("final"),
        ],
        "cap-zero-open" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-open"),
            Write(0, DEFAULT_TERMINAL_ID),
            Clear("clear-1", 0, DEFAULT_TERMINAL_ID),
            Observe("final"),
        ],
        "cap-across-threads" => &[
            Open("open-a1", 0, "term-1"),
            Open("open-b1", 1, "term-1"),
            Exit(0, Some(0), None),
            Open("open-a2", 0, "term-2"),
            Exit(1, Some(0), None),
            Exit(2, Some(0), None),
            Observe("final"),
        ],
        "close-after-exit" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, Some(7), None),
            Open("open-2", 0, "term-2"),
            Close("close-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-close"),
        ],
        "close-after-eviction" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Exit(0, Some(0), None),
            Open("open-2", 0, "term-2"),
            Close("close-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-close"),
            Close("close-2", 0, "term-2"),
            Observe("final"),
        ],
        "restart-after-exit" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Emit(0, "keep-me\n"),
            Exit(0, Some(2), None),
            Restart("restart-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-restart"),
        ],
        "spawn-fails" => &[
            Open("open-1", 0, DEFAULT_TERMINAL_ID),
            Observe("after-error"),
            Write(0, DEFAULT_TERMINAL_ID),
            Clear("clear-1", 0, DEFAULT_TERMINAL_ID),
            Observe("final"),
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
            "lmcs-exit-golden-{}-{case}-{}",
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

fn number(value: Option<i32>) -> String {
    value.map_or_else(|| "-".to_owned(), |value| value.to_string())
}

fn pid_text(pid: Option<u32>) -> String {
    pid.map_or_else(|| "-".to_owned(), |pid| pid.to_string())
}

/// One publication, in the shape the `O` rows record it.
fn event_row(event: &Event) -> Row {
    let (kind, message) = match event {
        Event::Started { .. } => ("started", "-"),
        Event::Exited { .. } => ("exited", "-"),
        Event::Error { .. } => ("error", "text"),
        Event::Cleared { .. } => ("cleared", "-"),
        Event::Restarted { .. } => ("restarted", "-"),
        Event::Closed { .. } => ("closed", "-"),
    };
    let (code, signal) = match event {
        Event::Exited {
            exit_code,
            exit_signal,
            ..
        } => (number(*exit_code), number(*exit_signal)),
        _ => ("-".to_owned(), "-".to_owned()),
    };
    vec![
        kind.to_owned(),
        event.terminal_id().to_owned(),
        event.sequence().to_string(),
        code,
        signal,
        message.to_owned(),
    ]
}

struct Replay {
    logs: Logs,
    terminals: Terminals,
    threads: Vec<String>,
    stepping: bool,
    fail_spawn: bool,
    reads: u64,
    /// The processes the adapter handed out, in spawn order, which is how the trace names them.
    processes: Vec<(String, String, u32)>,
    boundaries: Vec<Row>,
    events: Vec<Row>,
    snapshots: Vec<Row>,
    views: Vec<Vec<Row>>,
    /// Stamps the trace's label arithmetic can see: snapshot and metadata values only.
    observed: BTreeSet<String>,
    view_stamps: Vec<Vec<String>>,
}

impl Replay {
    fn new(logs: Logs, case: &Expected) -> Self {
        let terminals = Terminals::with_retention(&logs.dir, case.cap);
        Self {
            logs,
            terminals,
            threads: case.threads.clone(),
            stepping: case.clock == "step",
            fail_spawn: case.fail_spawn,
            reads: 0,
            processes: Vec::new(),
            boundaries: Vec::new(),
            events: Vec::new(),
            snapshots: Vec::new(),
            views: Vec::new(),
            observed: BTreeSet::new(),
            view_stamps: Vec::new(),
        }
    }

    /// One `nowIso` read. Only observed values are ranked, so a read the shipped manager spent on a
    /// record nobody saw cannot move a label either way.
    fn read(&mut self) -> String {
        if !self.stepping {
            return "s000".to_owned();
        }
        self.reads += 1;
        format!("s{:03}", self.reads)
    }

    fn thread(&self, index: usize) -> String {
        self.threads[index].clone()
    }

    /// `enqueueProcessEvent` plus the whole `drainProcessEvents` walk. A walk stays open until it
    /// reports idle, which is why one event needs the loop and not one call: the shipped queue
    /// answers "already walking" to anything enqueued before it ends.
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
        let accepted = output.enqueue(pid, event);
        let mut deliveries = Vec::new();
        while let Some(delivery) = output.drain_next(pid) {
            deliveries.push(delivery);
        }
        if !accepted && deliveries.is_empty() {
            // Either the record was never running or a walk was already open; the trace has no case
            // where the distinction changes a row, so it stays visible as an empty walk.
        }
        deliveries
    }

    fn boundary(&mut self, kind: &str, id: &str, status: &str) {
        self.boundaries
            .push(vec![kind.to_owned(), id.to_owned(), status.to_owned()]);
    }

    fn publish(&mut self, events: Vec<Row>) {
        self.events.extend(events);
    }

    /// The snapshot the shipped call returned, read off the record the transition just wrote.
    fn snapshot(&mut self, kind: &str, id: &str, thread: &str, terminal: &str, sequence: u64) {
        let Some(state) = self.terminals.state(thread, terminal) else {
            return;
        };
        let stamp = state.updated_at.clone();
        let status = status_text(state.status);
        let pid = pid_text(state.pid);
        self.observed.insert(stamp);
        let history = String::from_utf8_lossy(
            &self
                .terminals
                .session(thread, terminal)
                .expect("the record is live")
                .history_value(),
        )
        .into_owned();
        self.snapshots.push(vec![
            kind.to_owned(),
            id.to_owned(),
            status,
            pid,
            sequence.to_string(),
            history,
        ]);
    }

    fn observe(&mut self, note: &str) {
        let rows = self.terminals.view();
        self.boundary("observe", note, &rows.len().to_string());
        let mut stamps = Vec::with_capacity(rows.len());
        let mut view = Vec::with_capacity(rows.len());
        for row in &rows {
            self.observed.insert(row.updated_at.clone());
            stamps.push(row.updated_at.clone());
            view.push(vec![
                row.thread_id.clone(),
                row.terminal_id.clone(),
                status_text(row.status),
                pid_text(row.pid),
                number(row.exit_code),
                number(row.exit_signal),
                String::new(),
            ]);
        }
        self.views.push(view);
        self.view_stamps.push(stamps);
    }

    fn open(&mut self, id: &str, thread: usize, terminal: &str) {
        let thread = self.thread(thread);
        self.boundary("open", id, "-");
        let insert_stamp = self.read();
        self.terminals.insert(
            &thread,
            terminal,
            self.logs.session(&thread, terminal),
            &insert_stamp,
        );
        let mut events = Vec::new();
        let sequence = if self.fail_spawn {
            let stamp = self.read();
            self.terminals.mark_error(
                &thread,
                terminal,
                "Failed to spawn PTY process",
                &stamp,
                &mut |event| events.push(event_row(event)),
            )
        } else {
            let pid = 7400 + self.processes.len() as u32;
            let stamp = self.read();
            let sequence =
                self.terminals
                    .mark_running(&thread, terminal, pid, &stamp, &mut |event| {
                        events.push(event_row(event))
                    });
            self.processes
                .push((thread.clone(), terminal.to_owned(), pid));
            sequence
        };
        self.publish(events);
        match sequence {
            Some(sequence) => {
                self.snapshot("open", id, &thread, terminal, sequence);
                self.boundary("open", id, "ok");
            }
            // The ceiling took the record before the spawn could be reported, so the port has no
            // session to answer with. The shipped manager answers with the detached object.
            None => self.boundary("open", id, &format!("err:{}", WriteError::Missing.as_str())),
        }
    }

    fn emit(&mut self, spawn: usize, data: &str) {
        let (thread, terminal, pid) = self.processes[spawn].clone();
        // `emit` and `exit` are the adapter's own callbacks: the script records the call and never a
        // return, because the walk it triggers publishes asynchronously.
        self.boundary("emit", &format!("spawn-{spawn}"), "-");
        let deliveries = self.drain(&thread, &terminal, pid, PendingEvent::Data(data.to_owned()));
        let sequence = deliveries
            .iter()
            .filter_map(|delivery| match delivery {
                Delivery::Output { sequence, .. } => Some(*sequence),
                _ => None,
            })
            .next();
        assert!(
            deliveries.len() <= 1,
            "one queued chunk walks as one delivery: {deliveries:?}"
        );
        let Some(sequence) = sequence else {
            return;
        };
        self.events.push(vec![
            "output".to_owned(),
            terminal.clone(),
            sequence.to_string(),
            "-".to_owned(),
            "-".to_owned(),
            "-".to_owned(),
        ]);
        let stamp = self.read();
        self.terminals.touch(&thread, &terminal, &stamp);
    }

    fn exit(&mut self, spawn: usize, code: Option<i32>, signal: Option<i32>) {
        let (thread, terminal, pid) = self.processes[spawn].clone();
        self.boundary("exit", &format!("spawn-{spawn}"), "-");
        let deliveries = self.drain(
            &thread,
            &terminal,
            pid,
            PendingEvent::Exit(exit_event(code.unwrap_or(0), signal)),
        );
        let (sequence, drained_code, drained_signal) = deliveries
            .iter()
            .filter_map(|delivery| match delivery {
                Delivery::Exit {
                    sequence,
                    exit_code,
                    exit_signal,
                } => Some((*sequence, *exit_code, *exit_signal)),
                _ => None,
            })
            .next()
            .unwrap_or_else(|| panic!("the exit of {thread}/{terminal} drained as {deliveries:?}"));
        // The drain always has an integer, so the schedule's absentees are the shipped nulls.
        let exit_code = code.map(|_| drained_code).unwrap_or(None);
        let exit_signal = signal.map(|_| drained_signal).unwrap_or(None);
        let stamp = self.read();
        let mut events = Vec::new();
        self.terminals.exit(
            &thread,
            &terminal,
            sequence,
            Exit {
                exit_code,
                exit_signal,
            },
            &stamp,
            &mut |event| events.push(event_row(event)),
        );
        self.publish(events);
    }

    fn write(&mut self, thread: usize, terminal: &str) {
        let thread = self.thread(thread);
        self.boundary("write", &format!("write-{terminal}"), "-");
        let status = match self.terminals.write(&thread, terminal) {
            Ok(Write::Delivered) | Ok(Write::Swallowed) => "ok".to_owned(),
            Err(error) => format!("err:{}", error.as_str()),
        };
        self.boundary("write", &format!("write-{terminal}"), &status);
    }

    fn clear(&mut self, id: &str, thread: usize, terminal: &str) {
        let thread = self.thread(thread);
        self.boundary("clear", id, "-");
        if self.terminals.state(&thread, terminal).is_none() {
            self.boundary(
                "clear",
                id,
                &format!("err:{}", WriteError::Missing.as_str()),
            );
            return;
        }
        let stamp = self.read();
        let mut events = Vec::new();
        match self
            .terminals
            .clear(&thread, terminal, &stamp, &mut |event| {
                events.push(event_row(event))
            }) {
            Ok(()) => {
                self.publish(events);
                self.boundary("clear", id, "ok");
            }
            Err(error) => self.boundary("clear", id, &format!("err:{error}")),
        }
    }

    fn close(&mut self, id: &str, thread: usize, terminal: &str) {
        let thread = self.thread(thread);
        self.boundary("close", id, "-");
        // The publication advances the sequence and stamps, and then the record is gone, so the
        // stamp is only a clock read.
        let stamp = self.read();
        let mut events = Vec::new();
        self.terminals
            .close(&thread, Some(terminal), None, &mut |event| {
                events.push(event_row(event))
            })
            .expect("a close without the delete flag cannot warn");
        self.publish(events);
        self.boundary("close", id, "ok");
        let _ = stamp;
    }

    fn restart(&mut self, id: &str, thread: usize, terminal: &str) {
        let thread = self.thread(thread);
        self.boundary("restart", id, "-");
        let pid = 7400 + self.processes.len() as u32;
        let stamp = self.read();
        let mut events = Vec::new();
        let restarted = self
            .terminals
            .restart(&thread, terminal, pid, &stamp, &mut |event| {
                events.push(event_row(event))
            });
        self.publish(events);
        match restarted {
            Ok(()) => {
                let sequence = self.events.last().expect("the restart publishes one event")[2]
                    .parse::<u64>()
                    .expect("restart sequence");
                self.processes
                    .push((thread.clone(), terminal.to_owned(), pid));
                self.snapshot("restart", id, &thread, terminal, sequence);
                self.boundary("restart", id, "ok");
            }
            Err(error) => self.boundary("restart", id, &format!("err:{error}")),
        }
    }

    fn run(&mut self, steps: &[Step]) {
        for step in steps {
            match *step {
                Step::Observe(note) => self.observe(note),
                Step::Open(id, thread, terminal) => self.open(id, thread, terminal),
                Step::Restart(id, thread, terminal) => self.restart(id, thread, terminal),
                Step::Emit(spawn, data) => self.emit(spawn, data),
                Step::Exit(spawn, code, signal) => self.exit(spawn, code, signal),
                Step::Write(thread, terminal) => self.write(thread, terminal),
                Step::Clear(id, thread, terminal) => self.clear(id, thread, terminal),
                Step::Close(id, thread, terminal) => self.close(id, thread, terminal),
            }
        }
    }

    /// The trace's `t1..tn` labels: the distinct stamps it could see, ascending.
    fn labelled(&mut self) -> Vec<Vec<Row>> {
        let labels: BTreeMap<&str, String> = self
            .observed
            .iter()
            .enumerate()
            .map(|(index, stamp)| (stamp.as_str(), format!("t{}", index + 1)))
            .collect();
        for (view, stamps) in self.view_stamps.iter().enumerate() {
            for (offset, stamp) in stamps.iter().enumerate() {
                self.views[view][offset][6] = labels
                    .get(stamp.as_str())
                    .unwrap_or(&"-".to_owned())
                    .clone();
            }
        }
        self.views.clone()
    }
}

fn status_text(status: Status) -> String {
    status.as_str().to_owned()
}

#[test]
fn replays_shipped_exit_state_and_inactive_retention() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_EXIT_RETENTION_TRACE") else {
        eprintln!(
            "skipped exit/retention golden: LMCS_TERMINAL_EXIT_RETENTION_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let trace = PathBuf::from(trace);
    let parsed = parse(&trace);
    assert_eq!(parsed.default_terminal, DEFAULT_TERMINAL_ID);
    assert_eq!(
        parsed
            .comparators
            .iter()
            .filter(|row| row[4] == "0")
            .map(|row| format!("{}|{}", row[0], row[1]))
            .collect::<Vec<_>>(),
        vec![
            "a|B".to_owned(),
            "A|a".to_owned(),
            "-|_".to_owned(),
            "x/y|x:y".to_owned(),
        ],
        "the locale-versus-ordinal disagreement the port accepts, measured rather than assumed"
    );
    for row in &parsed.comparators {
        if row[4] != "1" {
            continue;
        }
        let locale = row[2].parse::<i32>().unwrap();
        let ordinal = match row[0].cmp(&row[1]) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        assert_eq!(locale, ordinal, "{} versus {}", row[0], row[1]);
    }

    let mut totals = (0usize, 0usize, 0usize, 0usize);
    for case in &parsed.cases {
        let mut replay = Replay::new(Logs::start(&case.name), case);
        replay.run(schedule(&case.name));
        let views = replay.labelled();

        let mut expected_events = case.events.clone();
        let mut expected_snapshots = case.snapshots.clone();
        let mut expected_boundaries = case.boundaries.clone();
        if case.name == "cap-zero-open" {
            // Declared divergence: no `started`, and no open snapshot for a record the table dropped.
            expected_events.retain(|row| row[0] != "started");
            expected_snapshots.clear();
            for row in &mut expected_boundaries {
                if row[0] == "open" && row[2] == "ok" {
                    row[2] = format!("err:{}", WriteError::Missing.as_str());
                }
            }
        }

        assert_eq!(
            replay.boundaries, expected_boundaries,
            "{} call outcomes",
            case.name
        );
        assert_eq!(replay.events, expected_events, "{} publications", case.name);
        assert_eq!(
            replay.snapshots, expected_snapshots,
            "{} returned snapshots",
            case.name
        );
        assert_eq!(views, case.views, "{} metadata views", case.name);
        totals = (
            totals.0 + 1,
            totals.1 + replay.events.len(),
            totals.2 + case.views.iter().map(Vec::len).sum::<usize>(),
            totals.3 + replay.boundaries.len(),
        );
    }
    eprintln!(
        "exit/retention golden: {} cases, {} publications, {} metadata rows, {} call outcomes from {}",
        totals.0,
        totals.1,
        totals.2,
        totals.3,
        trace.display()
    );
}
