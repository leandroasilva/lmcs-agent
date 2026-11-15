//! Replays a trace captured from the shipped `TerminalManager` — candidate list, child
//! environment, fallback attempts and the error the client is told — so the Rust port is
//! checked against the real pipeline.
//!
//! Set `LMCS_PTY_TRACE` to a trace file; the test skips when unset. Regenerate one with:
//! `node apps/server/scripts/terminal-shell-trace.ts > /tmp/pty-trace.txt`

use std::cell::RefCell;

use lmcs_pty::env::Env;
use lmcs_pty::spawn::{PtySpawnError, PtySpawnInput, SpawnCause, Spawner, try_spawn};
use lmcs_pty::{Platform, create_terminal_spawn_env, normalized_runtime_env, resolve_shell_candidates};
use serde_json::Value;

fn unhex(value: &str) -> String {
    let bytes: Vec<u8> = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect();
    String::from_utf8(bytes).expect("the trace is utf-8")
}

fn fail_cause(fail_mode: &str) -> SpawnCause {
    match fail_mode {
        // The shape `node-pty` produces on a missing executable: a message with a nested
        // message below it, neither of them an `Error` the manager could pattern-match.
        "retryable" => SpawnCause::caused(
            "posix_spawnp failed.",
            SpawnCause::error("Extra detail."),
        ),
        "fatal" => SpawnCause::error("EACCES: permission denied"),
        _ => SpawnCause::text("EACCES: permission denied"),
    }
}

struct Scripted {
    fail_mode: String,
    seen: RefCell<Vec<(String, Option<Vec<String>>)>>,
}

impl Spawner for Scripted {
    type Process = ();

    fn spawn(&self, input: &PtySpawnInput) -> Result<(), PtySpawnError> {
        self.seen.borrow_mut().push((
            input.shell.to_string(),
            input.args.map(<[String]>::to_vec),
        ));
        if self.fail_mode == "none" {
            return Ok(());
        }
        Err(PtySpawnError {
            adapter: "node-pty".to_string(),
            shell: Some(input.shell.to_string()),
            attempted_shells: None,
            cause: Some(fail_cause(&self.fail_mode)),
        })
    }
}

fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .expect("an array of pairs")
        .iter()
        .map(|pair| {
            let pair = pair.as_array().expect("a two-element pair");
            (
                pair[0].as_str().expect("a key").to_string(),
                pair[1].as_str().expect("a value").to_string(),
            )
        })
        .collect()
}

/// One `C`/`N`/`A`/`V`/`S`/`E`/`M` group from the trace.
struct Case {
    name: String,
    declared_attempts: usize,
    input: Value,
    attempts: Vec<Value>,
    environment: Option<Value>,
    snapshot: Option<Value>,
    errors: Vec<String>,
}

fn group(lines: &[&str]) -> Vec<Case> {
    let mut cases: Vec<Case> = Vec::new();
    for line in lines {
        let (op, rest) = line.split_once(' ').unwrap_or((line, ""));
        match op {
            "C" => {
                let fields: Vec<&str> = rest.split(' ').collect();
                cases.push(Case {
                    name: fields[0].to_string(),
                    declared_attempts: fields[2].parse().expect("an attempt count"),
                    input: Value::Null,
                    attempts: Vec::new(),
                    environment: None,
                    snapshot: None,
                    errors: Vec::new(),
                });
            }
            "N" | "A" | "V" | "S" | "E" | "M" => {
                let case = cases.last_mut().expect("a case is open");
                let payload = rest.split(' ').next_back().expect("a payload");
                let text = unhex(payload);
                match op {
                    "N" => case.input = serde_json::from_str(&text).expect("case input"),
                    "A" => case.attempts.push(serde_json::from_str(&text).expect("spawn input")),
                    "V" => case.environment = Some(serde_json::from_str(&text).expect("child env")),
                    "S" => case.snapshot = Some(serde_json::from_str(&text).expect("snapshot")),
                    "E" | "M" => case.errors.push(text),
                    _ => unreachable!(),
                }
            }
            other => panic!("unknown record {other:?}"),
        }
    }
    cases
}

#[test]
fn replays_the_shipped_managers_shell_selection_and_child_environment() {
    let Some(path) = std::env::var_os("LMCS_PTY_TRACE") else {
        eprintln!("skipped: LMCS_PTY_TRACE is unset, so no cross-language check ran");
        return;
    };
    let text = std::fs::read_to_string(&path).expect("the trace file is readable");
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    let cases = group(&lines);
    assert_eq!(cases.len(), 19, "the trace has nineteen cases");

    let mut replayed_attempts = 0;
    let mut replayed_environment_entries = 0;

    for case in &cases {
        let label = |what: &str| format!("{}: expected {what}", case.name);
        let platform = Platform::from_node_str(
            case.input["platform"].as_str().expect(&label("a platform")),
        );
        let base = Env::from_pairs(pairs(&case.input["baseEnv"]));
        let requested = match &case.input["shell"] {
            Value::Null => lmcs_pty::shell::default_shell_resolver(platform, &base),
            Value::String(shell) => shell.clone(),
            _ => panic!("{}", label("a requested shell or null")),
        };

        let candidates = resolve_shell_candidates(&requested, platform, &base);
        assert_eq!(
            case.declared_attempts,
            case.attempts.len(),
            "{}",
            label("the trace to be self-consistent")
        );
        assert!(
            candidates.len() >= case.attempts.len(),
            "{}: the manager cannot attempt more candidates than it resolved",
            case.name
        );

        let runtime = match &case.input["runtimeEnv"] {
            Value::Null => Vec::new(),
            Value::Array(_) => pairs(&case.input["runtimeEnv"]),
            _ => panic!("{}", label("a runtime environment")),
        };
        let runtime = normalized_runtime_env((!runtime.is_empty()).then_some(runtime));
        let spawned = create_terminal_spawn_env(&base, runtime.as_deref(), "<M>", platform);
        let expected = pairs(case.environment.as_ref().expect(&label("a child environment")));
        assert_eq!(
            spawned.entries(),
            expected.as_slice(),
            "{}",
            label("the exact child environment, in order")
        );
        replayed_environment_entries += spawned.len();

        // The manager walks the list itself; the port must stop at the same candidate.
        let spawner = Scripted {
            fail_mode: case.input["failMode"]
                .as_str()
                .expect(&label("a fail mode"))
                .to_string(),
            seen: RefCell::new(Vec::new()),
        };
        let result = try_spawn(
            &spawner,
            &candidates,
            lmcs_pty::spawn::SpawnTarget {
                cwd: "/tmp/trace-work",
                cols: 100,
                rows: 24,
                env: &spawned,
            },
        );

        let seen = spawner.seen.borrow();
        assert_eq!(
            seen.len(),
            case.attempts.len(),
            "{}",
            label("the same number of spawn attempts")
        );
        for (index, (shell, args)) in seen.iter().enumerate() {
            let attempt = &case.attempts[index];
            assert_eq!(attempt["shell"], Value::from(shell.as_str()), "{shell}");
            match (attempt.get("args"), args) {
                (None, None) => {}
                (Some(expected), Some(actual)) => {
                    assert_eq!(expected, &Value::from(actual.clone()), "{shell}");
                }
                (expected, actual) => panic!(
                    "{}: expected the same arguments to be passed ({expected:?} vs {actual:?})",
                    case.name
                ),
            }
            assert_eq!(attempt["cols"], Value::from(100), "cols");
            assert_eq!(attempt["rows"], Value::from(24), "rows");
            replayed_attempts += 1;
        }

        match (result, case.snapshot.as_ref()) {
            (Ok(spawned_process), Some(snapshot)) => {
                assert_eq!(
                    snapshot["status"],
                    Value::from("running"),
                    "{}",
                    case.name
                );
                let attempt = &case.attempts[0];
                let expected_label = match attempt.get("args").and_then(Value::as_array) {
                    Some(args) => format!(
                        "{} {}",
                        attempt["shell"].as_str().expect("a shell"),
                        args.iter()
                            .map(Value::as_str)
                            .collect::<Option<Vec<_>>>()
                            .expect("string arguments")
                            .join(" ")
                    ),
                    None => attempt["shell"].as_str().expect("a shell").to_string(),
                };
                assert_eq!(spawned_process.shell_label, expected_label);
            }
            (Err(error), Some(snapshot)) => {
                assert_eq!(snapshot["status"], Value::from("error"), "{}", case.name);
                let message = error.message();
                assert!(
                    case.errors.contains(&message),
                    "{}: expected the published message {message:?} to match the trace {:?}",
                    case.name,
                    case.errors
                );
            }
            (Ok(_), None) | (Err(_), None) => panic!("{}", label("a snapshot record")),
        }
    }

    assert_eq!(replayed_attempts, 102, "every attempt in the trace ran");
    assert_eq!(
        replayed_environment_entries, 56,
        "every child environment entry in the trace was compared"
    );
}
