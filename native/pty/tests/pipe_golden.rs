// LMCS_PIPE_TRACE points to the output of apps/server/scripts/terminal-pipe-trace.ts.
use lmcs_pty::node_pty::PtyExitEvent;
use lmcs_pty::{Delivery, PendingEvent, Pipe, Sanitized};
use serde_json::Value;

const CASE_NAMES: &[&str] = &[
    "singleOutput",
    "burstWhileIdle",
    "emptyChunkIsPublished",
    "midDrainEnqueueThenExit",
    "exitThenLateData",
    "stalePidAfterRestart",
    "dataDuringSetup",
    "exitDuringSetup",
    "closeWhilePublishHeld",
    "exitCodeNotAnInteger",
    "signalSurvives",
    "twoOutputsThenExitWithPendingBurst",
];

#[derive(Debug, PartialEq, Eq)]
struct Recorded {
    kind: String,
    sequence: u64,
    payload: String,
}

struct Case {
    name: String,
    input: Value,
    outputs: Vec<Recorded>,
    disposals: usize,
}

fn unhex(value: &str) -> String {
    let bytes = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect();
    String::from_utf8(bytes).expect("UTF-8 trace")
}

fn parse(trace: &str) -> Vec<Case> {
    let mut cases: Vec<Case> = Vec::new();
    for line in trace.lines() {
        if let Some(name) = line.strip_prefix("C ") {
            cases.push(Case {
                name: name.to_string(),
                input: Value::Null,
                outputs: Vec::new(),
                disposals: 0,
            });
            continue;
        }
        let case = cases.last_mut().expect("case header");
        if let Some(input) = line.strip_prefix("I ") {
            assert!(case.input.is_null(), "duplicate input");
            case.input = serde_json::from_str(&unhex(input)).expect("JSON input");
            assert_eq!(case.input["name"].as_str(), Some(case.name.as_str()));
        } else if let Some(output) = line.strip_prefix("O ") {
            let fields: Vec<_> = output.splitn(4, ' ').collect();
            assert_eq!(fields.len(), 4);
            assert_eq!(fields[0].parse::<usize>().unwrap(), case.outputs.len());
            case.outputs.push(Recorded {
                kind: fields[1].to_string(),
                sequence: fields[2].parse().expect("event sequence"),
                payload: unhex(fields[3]),
            });
        } else if let Some(disposal) = line.strip_prefix("X ") {
            let fields: Vec<_> = disposal.splitn(3, ' ').collect();
            assert_eq!(fields.len(), 3);
            assert_eq!(fields[0].parse::<usize>().unwrap(), case.disposals);
            assert_eq!(fields[1].parse::<usize>().unwrap(), 4000 + case.disposals);
            assert!(matches!(unhex(fields[2]).as_str(), "" | "data,exit"));
            case.disposals += 1;
        } else {
            panic!("unknown trace line {line:?}");
        }
    }
    cases
}

fn project(delivery: Delivery) -> Recorded {
    match delivery {
        Delivery::Output { sequence, data, .. } => Recorded {
            kind: "output".to_string(),
            sequence,
            payload: data,
        },
        Delivery::Exit {
            sequence,
            exit_code,
            exit_signal,
        } => Recorded {
            kind: "exited".to_string(),
            sequence,
            payload: format!("{}|{}", nullable(exit_code), nullable(exit_signal)),
        },
    }
}

fn nullable(value: Option<i32>) -> String {
    value.map_or_else(|| "null".to_string(), |number| number.to_string())
}

fn exit(code: &Value, signal: &Value) -> PendingEvent {
    PendingEvent::Exit(PtyExitEvent {
        exit_code: i32::try_from(code.as_i64().expect("integer exit code")).unwrap(),
        signal: Some(i32::try_from(signal.as_i64().expect("integer signal")).unwrap()),
    })
}

#[derive(Default)]
struct Replay {
    pipe: Pipe,
    current_pid: u32,
    outputs: Vec<Recorded>,
    hold: bool,
    suspended: Option<(u32, Delivery)>,
}

impl Replay {
    fn start(&mut self, kind: &str, setup: &Value) {
        self.pipe.stop();
        self.current_pid = if self.current_pid == 0 {
            4000
        } else {
            self.current_pid + 1
        };
        if let Some(data) = setup["data"].as_str() {
            self.emit(self.current_pid, PendingEvent::Data(data.to_string()));
        }
        if !setup["exit"].is_null() {
            self.emit(
                self.current_pid,
                exit(&setup["exit"]["exitCode"], &setup["exit"]["signal"]),
            );
        }
        let sequence = self.pipe.start(self.current_pid);
        self.outputs.push(Recorded {
            kind: kind.to_string(),
            sequence,
            payload: format!("running pid={}", self.current_pid),
        });
    }

    fn emit(&mut self, pid: u32, event: PendingEvent) {
        if self.pipe.enqueue(pid, event) {
            self.drain(pid);
        }
    }

    fn drain(&mut self, pid: u32) {
        while let Some(delivery) = self.pipe.drain_next(pid, |_, text| Sanitized {
            visible: text.to_string(),
            pending: String::new(),
        }) {
            if self.hold {
                self.hold = false;
                assert!(self.suspended.replace((pid, delivery)).is_none());
                return;
            }
            let exited = matches!(delivery, Delivery::Exit { .. });
            self.outputs.push(project(delivery));
            if exited {
                return;
            }
        }
    }

    fn run(mut self, input: &Value) -> Vec<Recorded> {
        self.start("started", &input["setup"]);
        for step in input["steps"].as_array().expect("steps") {
            let pid = step["p"].as_u64().map_or(self.current_pid, |index| {
                4000 + u32::try_from(index).unwrap()
            });
            match step["op"].as_str().expect("step operation") {
                "data" => self.emit(
                    pid,
                    PendingEvent::Data(step["s"].as_str().unwrap().to_string()),
                ),
                "exit" => self.emit(pid, exit(&step["c"], &step["s"])),
                "hold" => {
                    assert!(!self.hold && self.suspended.is_none());
                    self.hold = true;
                }
                "suspended" => assert!(self.suspended.is_some(), "publish never suspended"),
                "release" => {
                    let (pid, delivery) = self.suspended.take().expect("suspended publish");
                    let exited = matches!(delivery, Delivery::Exit { .. });
                    self.outputs.push(project(delivery));
                    if !exited {
                        self.drain(pid);
                    }
                }
                "count" => assert_eq!(self.outputs.len() as u64, step["n"].as_u64().unwrap()),
                "restart" => self.start("restarted", &input["setup"]),
                "close" => {
                    let sequence = self.pipe.close();
                    self.outputs.push(Recorded {
                        kind: "closed".to_string(),
                        sequence,
                        payload: String::new(),
                    });
                }
                other => panic!("unknown operation {other:?}"),
            }
        }
        assert!(!self.hold && self.suspended.is_none());
        assert_eq!(self.pipe.queued(), 0);
        self.outputs
    }
}

#[test]
fn replays_the_shipped_terminal_manager() {
    let Ok(path) = std::env::var("LMCS_PIPE_TRACE") else {
        eprintln!("skipped pipe golden: set LMCS_PIPE_TRACE to the generated trace");
        return;
    };
    let cases = parse(&std::fs::read_to_string(path).expect("read pipe trace"));
    assert_eq!(
        cases
            .iter()
            .map(|case| case.name.as_str())
            .collect::<Vec<_>>(),
        CASE_NAMES
    );
    let mut replayed = 0;
    let mut excluded = 0;
    let mut disposals = 0;
    for case in cases {
        disposals += case.disposals;
        // A native wait status cannot carry NaN; do not manufacture parity by rewriting the output.
        if case.name == "exitCodeNotAnInteger" {
            assert_eq!(case.input["steps"][1]["c"], "nan");
            assert_eq!(case.outputs.len(), 2);
            assert_eq!(case.outputs[1].payload, "null|0");
            excluded += 1;
            continue;
        }
        assert_eq!(
            Replay::default().run(&case.input),
            case.outputs,
            "{}",
            case.name
        );
        replayed += 1;
    }
    assert_eq!((replayed, excluded, disposals), (11, 1, 15));
    eprintln!(
        "pipe golden: {replayed} cases replayed; {excluded} NaN case excluded (i32 boundary); {disposals} disposal records counted, not implemented by Pipe"
    );
}
