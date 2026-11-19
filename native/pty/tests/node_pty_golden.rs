//! Replays a trace captured from the shipped `NodePtyAdapter` — the arguments it builds for the
//! PTY library, the signal a kill carries, the order a resize names, the exit event it hands
//! back, and how the manager reacts to a failure this adapter produced.
//!
//! Set `LMCS_NODE_PTY_TRACE` to a trace file; the test skips when unset. Regenerate one with:
//! `node apps/server/scripts/node-pty-adapter-trace.ts > /tmp/node-pty-trace.txt`
//!
//! Each record's input carries everything its replay needs, so nothing here is reconstructed
//! from a case name. The compared half is the record's own result, which is what the shipped
//! adapter handed to `node-pty` or back to its caller.
//!
//! Three of the eight tables are not decisions this port can get wrong, and the test says so
//! rather than pretending to check them: `data` and `pid` are passthroughs the shipped code
//! does not touch, and `make` records that a module which will not load is a defect — a
//! linked-in PTY implementation has no such failure. They are counted, so a generator that
//! starts emitting something new still has to be read.

use std::cell::RefCell;

use lmcs_pty::env::Env;
use lmcs_pty::node_pty::{
    PtyLibraryCall, PtySize, exit_event, kill_argument, pty_library_call, pty_size, spawn_error,
};
use lmcs_pty::spawn::{PtySpawnError, PtySpawnInput, SpawnCause, Spawner, try_spawn};
use lmcs_pty::{Platform, ShellCandidate, resolve_shell_candidates};
use serde_json::{Value, json};

/// Every table the generator writes, with how many records it wrote this run. A new table or a
/// new count means the trace changed and this file has not been read since.
const EXPECTED_COUNTS: &[(&str, usize)] = &[
    ("nodePtyAdapter.spawn", 12),
    ("nodePtyAdapter.kill", 24),
    ("nodePtyAdapter.resize", 8),
    ("nodePtyAdapter.exit", 24),
    ("nodePtyAdapter.data", 8),
    ("nodePtyAdapter.pid", 8),
    ("nodePtyAdapter.managerRetry", 4),
    ("nodePtyAdapter.make", 2),
];
const EXPECTED_TOTAL: usize = 90;

fn unhex(value: &str) -> String {
    let bytes: Vec<u8> = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect();
    String::from_utf8(bytes).expect("the trace is utf-8")
}

struct Record {
    table: String,
    name: String,
    input: Value,
    result: Value,
}

fn parse(trace: &str) -> Vec<Record> {
    let lines: Vec<&str> = trace.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(
        lines.len() % 3,
        0,
        "every record is a C, an I and an R line"
    );
    lines
        .chunks(3)
        .map(|chunk| {
            let mut fields = chunk[0].splitn(3, ' ');
            assert_eq!(fields.next(), Some("C"), "a record starts with C");
            assert_eq!(
                fields.next(),
                Some("node-pty-adapter"),
                "one module per trace"
            );
            let input = decode(chunk[1], "I");
            Record {
                table: fields.next().expect("a table name").to_string(),
                name: input["name"].as_str().expect("a case name").to_string(),
                input,
                result: decode(chunk[2], "R"),
            }
        })
        .collect()
}

fn decode(line: &str, op: &str) -> Value {
    let payload = line
        .strip_prefix(&format!("{op} "))
        .unwrap_or_else(|| panic!("a line starting with {op}"))
        .trim();
    serde_json::from_str(&unhex(payload)).expect("a json payload")
}

fn string(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn number(value: &Value) -> u32 {
    value.as_u64().expect("a number") as u32
}

/// The environment as the shipped case spelled it. `null` is a key whose value was `undefined`,
/// which the Rust `Env` cannot hold because the shipped producers never put one in it.
fn env(pairs: &Value) -> Env {
    Env::from_pairs(
        pairs
            .as_array()
            .expect("an array of pairs")
            .iter()
            .filter_map(|pair| {
                let pair = pair.as_array().expect("a two-element pair");
                match (pair[0].as_str(), pair[1].as_str()) {
                    (Some(key), Some(value)) => Some((key.to_string(), value.to_string())),
                    _ => None,
                }
            }),
    )
}

fn env_pairs(env: &Env) -> Value {
    Value::from(
        env.entries()
            .iter()
            .map(|(key, value)| json!([key, value]))
            .collect::<Vec<_>>(),
    )
}

/// The cause the fake module threw, by the name the generator gave that shape. These are the
/// real `node-pty` failures, written down by the fake that reproduced them.
fn thrown(failure: &str) -> Option<SpawnCause> {
    match failure {
        "missingExecutable" => Some(SpawnCause::error("posix_spawnp failed.")),
        "permissionDenied" => Some(SpawnCause::error("EACCES: permission denied")),
        "nested" => Some(SpawnCause::caused(
            "spawn failed",
            SpawnCause::error("No such file or directory"),
        )),
        "bareString" => Some(SpawnCause::text("posix_spawnp failed.")),
        // `{}`: an object the adapter could wrap but not read.
        "noMessage" => Some(SpawnCause::Nested {
            message: None,
            cause: None,
        }),
        _ => None,
    }
}

/// The trace's rendering of a cause chain: one level per `cause`, `{text}` for a string, and
/// `{tag}` for an object with nothing readable in it. Test-local, because it describes how the
/// generator wrote the chain down, not how the port stores it.
fn chain_of(cause: &SpawnCause) -> Value {
    match cause {
        SpawnCause::Text(text) => json!({ "text": text }),
        SpawnCause::Nested { message, cause } => match message {
            Some(message) => json!({ "message": message, "cause": cause.as_deref().map(chain_of) }),
            None => match cause {
                Some(cause) => json!({ "message": Value::Null, "cause": chain_of(cause) }),
                None => json!({ "tag": "[object Object]" }),
            },
        },
    }
}

fn render_call(call: &PtyLibraryCall) -> Value {
    json!({
        "file": call.file,
        "args": call.args,
        "options": {
            "cwd": call.cwd,
            "cols": call.cols,
            "rows": call.rows,
            "name": call.name,
            "env": env_pairs(&call.env),
        },
    })
}

/// What the adapter would have handed `node-pty`, and the error it would have handed back.
fn replay_spawn(record: &Record) -> Value {
    let args: Vec<String> = record.input["args"]
        .as_array()
        .map(|items| items.iter().map(string).map(str::to_string).collect())
        .unwrap_or_default();
    let case_env = env(&record.input["env"]);
    let shell = string(&record.input["shell"]);
    let input = PtySpawnInput {
        shell,
        args: if record.input["args"].is_null() {
            None
        } else {
            Some(&args)
        },
        cwd: string(&record.input["cwd"]),
        cols: number(&record.input["cols"]),
        rows: number(&record.input["rows"]),
        env: &case_env,
    };

    let platform = Platform::from_node_str(string(&record.input["platform"]));
    let failure = record.input["failure"].as_str().unwrap_or("none");
    let error = thrown(failure).map(|cause| spawn_error(shell, cause));

    json!({
        "call": render_call(&pty_library_call(&input, platform)),
        "error": error.map(|error| json!({
            "_tag": "PtySpawnError",
            "message": error.message(),
            "shell": error.shell,
            "chain": error.cause.as_ref().map(chain_of),
        })),
    })
}

/// The one argument `node-pty`'s `kill` received.
fn replay_kill(record: &Record) -> Value {
    let platform = Platform::from_node_str(string(&record.input["platform"]));
    let signal = record.input["signal"].as_str();
    json!({ "received": kill_argument(platform, signal) })
}

/// The event the adapter's `onExit` callback was handed. `afterUnsubscribe` is left out: it
/// measures the fake's listener list, and the port has no listener list to compare with.
fn replay_exit(record: &Record) -> Value {
    let signal = match &record.input["signal"] {
        Value::Null => None,
        signal => Some(i32::try_from(signal.as_i64().expect("a signal number")).expect("a signal")),
    };
    let event = exit_event(number(&record.input["exitCode"]) as i32, signal);
    json!({
        "mapped": { "exitCode": event.exit_code, "signal": event.signal },
    })
}

/// The `resize(cols, rows)` call, seen by the port as a size struct. The projection reads the
/// fields back by name, so a swap inside `pty_size` lands here as a mismatch.
fn replay_resize(record: &Record) -> Value {
    let size: PtySize = pty_size(number(&record.input["cols"]), number(&record.input["rows"]));
    json!({ "calls": [[size.cols, size.rows]] })
}

/// A spawner that fails the way the fake module failed for the shipped adapter, so the retry
/// loop walks the same causes the manager walked.
struct Failing {
    failure: String,
    seen: RefCell<Vec<(String, Vec<String>)>>,
}

impl Spawner for Failing {
    type Process = ();

    fn spawn(&self, input: &PtySpawnInput) -> Result<(), PtySpawnError> {
        self.seen.borrow_mut().push((
            input.shell.to_string(),
            input.args.map_or_else(Vec::new, <[String]>::to_vec),
        ));
        match thrown(&self.failure) {
            None => Ok(()),
            Some(cause) => Err(spawn_error(input.shell, cause)),
        }
    }
}

/// The manager's reaction to a failure this adapter produced. The candidate list is not read
/// off the trace: the port resolves it from the same shell, platform and environment the
/// generator gave the shipped manager, so a divergence in either half shows up here.
///
/// `openTag` is the other layer's question — whether `open` survives a failed spawn — and
/// `terminal-shell-trace.ts` already answers it. What is compared is the walk itself and the one
/// message the manager publishes for it.
fn replay_manager_retry(record: &Record) -> Value {
    let host_env = Env::from_pairs([
        ("SHELL".to_string(), "/bin/zsh".to_string()),
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
    ]);
    let candidates: Vec<ShellCandidate> =
        resolve_shell_candidates("/bin/zsh", Platform::Linux, &host_env);
    let spawner = Failing {
        failure: record.input["failure"]
            .as_str()
            .expect("a failure")
            .to_string(),
        seen: RefCell::new(Vec::new()),
    };

    let outcome = try_spawn(
        &spawner,
        &candidates,
        lmcs_pty::spawn::SpawnTarget {
            cwd: "/work",
            cols: 80,
            rows: 24,
            env: &host_env,
        },
    );

    let shell_calls: Vec<Value> = spawner
        .seen
        .borrow()
        .iter()
        .map(|(file, args)| json!({ "file": file, "args": args }))
        .collect();
    json!({
        "spawns": shell_calls.len(),
        "shellCalls": shell_calls,
        "messages": match &outcome {
            Ok(_) => Vec::<String>::new(),
            Err(error) => vec![error.message()],
        },
    })
}

/// The half of each record the replay is supposed to reproduce.
fn expected_against(table: &str, record: &Record) -> Value {
    match table {
        "nodePtyAdapter.managerRetry" => json!({
            "spawns": record.result["spawns"],
            "shellCalls": record.result["shellCalls"],
            "messages": record.result["messages"],
        }),
        "nodePtyAdapter.exit" => json!({ "mapped": record.result["mapped"] }),
        other => {
            let _ = other;
            record.result.clone()
        }
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).expect("value json")
}

#[test]
fn the_adapter_hands_the_pty_library_what_the_shipped_one_hands_node_pty() {
    let Ok(path) = std::env::var("LMCS_NODE_PTY_TRACE") else {
        eprintln!(
            "skipping the node-pty golden: set LMCS_NODE_PTY_TRACE to a trace from \
             apps/server/scripts/node-pty-adapter-trace.ts"
        );
        return;
    };
    let trace = std::fs::read_to_string(&path).expect("the trace is readable");
    let records = parse(&trace);

    let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for record in &records {
        *counts.entry(&record.table).or_default() += 1;
    }
    assert_eq!(records.len(), EXPECTED_TOTAL, "the trace's record count");
    let mut tables: Vec<&str> = counts.keys().copied().collect();
    tables.sort_unstable();
    let mut declared: Vec<&str> = EXPECTED_COUNTS.iter().map(|(table, _)| *table).collect();
    declared.sort_unstable();
    assert_eq!(tables, declared, "the trace has a table nobody declared");
    for (table, expected) in EXPECTED_COUNTS {
        assert_eq!(
            counts.get(*table).copied(),
            Some(*expected),
            "the {table} table changed"
        );
    }

    let mut replayed = 0;
    for record in &records {
        let produced = match record.table.as_str() {
            "nodePtyAdapter.spawn" => replay_spawn(record),
            "nodePtyAdapter.kill" => replay_kill(record),
            "nodePtyAdapter.resize" => replay_resize(record),
            "nodePtyAdapter.exit" => replay_exit(record),
            "nodePtyAdapter.managerRetry" => replay_manager_retry(record),
            // Passthroughs and a failure mode the port cannot have: nothing to compare.
            "nodePtyAdapter.data" | "nodePtyAdapter.pid" | "nodePtyAdapter.make" => continue,
            other => panic!("the trace has a table nobody read: {other}"),
        };
        assert_eq!(
            compact(&produced),
            compact(&expected_against(&record.table, record)),
            "{} {}",
            record.table,
            record.name
        );
        replayed += 1;
    }
    assert_eq!(
        replayed, 72,
        "every decision table in the trace was replayed"
    );
}
