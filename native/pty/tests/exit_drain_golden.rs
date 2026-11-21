use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::time::{Duration, Instant};

use lmcs_pty::exit_drain::{DrainAction, ExitDrain};
use lmcs_pty::node_pty::exit_event;
use serde_json::{Value, json};

#[test]
fn matches_the_packaged_node_pty_exit_callback_at_every_step() {
    let Ok(path) = std::env::var("LMCS_EXIT_TRACE") else {
        eprintln!("skipped exit drain golden: set LMCS_EXIT_TRACE to node-pty-exit-trace output");
        return;
    };
    let file = std::fs::File::open(path).unwrap();
    let mut names = BTreeSet::new();
    for line in BufReader::new(file).lines() {
        let case: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name.to_string()), "duplicate {name}");
        let origin = Instant::now();
        let mut now = origin;
        let mut drain = ExitDrain::new();
        let steps = case["steps"].as_array().unwrap();
        let snapshots = case["snapshots"].as_array().unwrap();
        assert_eq!(steps.len(), snapshots.len(), "{name}");
        for (index, (step, expected)) in steps.iter().zip(snapshots).enumerate() {
            let mut actions = Vec::new();
            let action = match step["op"].as_str().unwrap() {
                "data" => {
                    if drain.accepts_data() {
                        actions.push(json!({ "kind": "data", "text": step["text"] }));
                    }
                    None
                }
                "exit" => drain.child_exited(
                    exit_event(
                        i32::try_from(step["code"].as_i64().unwrap()).unwrap(),
                        Some(i32::try_from(step["signal"].as_i64().unwrap()).unwrap()),
                    ),
                    now,
                ),
                "close" => drain.reader_closed(),
                "advance" => {
                    let next = origin + Duration::from_millis(step["at"].as_u64().unwrap());
                    assert!(next >= now);
                    now = next;
                    drain.expire(now)
                }
                other => panic!("unknown stimulus {other}"),
            };
            if let Some(action) = action {
                actions.push(match action {
                    DrainAction::CloseReader => json!({ "kind": "closeReader" }),
                    DrainAction::PublishExit(exit) => json!({
                        "kind": "exit", "code": exit.exit_code, "signal": exit.signal
                    }),
                });
            }
            let actual = json!({
                "actions": actions,
                "deadline": drain.deadline().map(|deadline| u64::try_from(deadline.duration_since(origin).as_millis()).unwrap()),
                "acceptsData": drain.accepts_data()
            });
            assert_eq!(&actual, expected, "{name} step {index}: {step}");
        }
    }
    let expected = [
        "eofBeforeExit",
        "exitBeforeEof",
        "outputDoesNotResetDeadline",
        "deadlineStartsAtObservation",
        "repeatedClose",
        "duplicateObservationWhileDraining",
        "boundary0",
        "boundary1",
        "boundary199",
        "boundary200",
        "boundary201",
        "boundary1000",
    ];
    assert_eq!(names, expected.into_iter().map(str::to_string).collect());
    eprintln!(
        "exit drain golden: 12 callback scenarios replayed at every step; native exit, stream and clock are scripted, not OS timing"
    );
}
