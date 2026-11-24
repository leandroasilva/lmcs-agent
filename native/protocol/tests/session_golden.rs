//! The switch's golden: replay the recorded wire scenario by scenario, through the port's loop.
//!
//! `LMCS_PROTOCOL_GOLDEN=/path/to/protocol-golden.json cargo test --test session_golden`
//!
//! [`envelope_golden`](../tests/envelope_golden.rs) checks one frame at a time — that a frame parses,
//! that it re-encodes, that a refusal reads right. This file checks the thing a server actually is:
//! the sequence. Each recorded case is fed to [`Session`] in the order it crossed, and the frames the
//! loop writes must be the frames the shipped server wrote, **as text**, in order. That is what makes
//! the loop's state part of the measurement rather than part of the prose: `[]`, an `Eof` and an
//! `Ack` for an unknown id all write nothing, `null` and a `Request` without `headers` write nothing
//! *and* end the connection, and the difference between those two silences is only visible if the
//! replay carries the close events along.
//!
//! The capture also fixes two claims that a reading of `RpcServer.ts` can get wrong. Both scenarios
//! where a stream's terminal `Exit` follows the client's `Ack` (`a.streamBatched`, `a.streamSplit`)
//! and the one where it does not (`a.streamInterrupted`, where the same ack is followed by an
//! `Interrupt` and the exit becomes `Failure`/`Interrupt`) are the *same* three-value stream, so the
//! exit cannot belong to the ack — it belongs to the producer, which is why the replay hands those
//! ids to [`Session::end`] and where it gets them from (`Chunk` frames in the recording, not a list
//! written here). And `b.broadcastWithInFlight` shows a broadcast `Defect` leaving two in-flight
//! requests alive.
//!
//! Three scenarios need one exemption each, and they are the same three the envelope golden declares:
//! `b.payloadWrongType`, `b.payloadMissingKey` and `b.omittedPayloadRaw` are answered by the **rpc's
//! own decoder**, whose `SchemaIssue.defaultFormatter` text is the schema layer's, not the switch's.
//! Those frames are compared structurally with their one defect string exempted; the stub group below
//! produces a sentinel there, so the exemption can only ever cover a frame the port *knows* it cannot
//! word. Byte order for those same frames is already pinned by the envelope golden, which re-encodes
//! all 59 answers the server sent.
//!
//! One case is compared out of order: `b.broadcastWithInFlight` ran its two handlers behind a
//! `Effect.sleep("600 millis")`, so the recorded order of *those three answers* is a fact about the
//! clock. This loop has no clock, and no framing claim depends on having one.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;

use lmcs_protocol::envelope::{Id, Message};
use lmcs_protocol::session::{Group, Outcome, Payload, Session};
use serde_json::{Map, Value};

/// What the stub group writes where the shipped server writes `SchemaIssue.defaultFormatter` text.
/// Deliberately not valid in that language, so no recorded defect can collide with it by accident.
const DECODER: &str = "\u{0}decoder";

/// The cases whose answer the rpc's decoder words rather than the switch.
const DECODER_GAPS: [&str; 3] = [
    "b.payloadWrongType",
    "b.payloadMissingKey",
    "b.omittedPayloadRaw",
];

/// The case whose recorded answer order is a timing fact.
const CLOCKED: &str = "b.broadcastWithInFlight";

struct Step {
    direction: String,
    frame: String,
}

/// One recorded socket, as far as this file reads it: the steps of each case in the order they
/// crossed, the cases that ended with a close, and the totals the generator computed for itself.
struct Artifact {
    order: Vec<String>,
    cases: BTreeMap<String, Vec<Step>>,
    closed: BTreeSet<String>,
    summary: Value,
}

impl Artifact {
    fn load() -> Option<Self> {
        let path = env::var_os("LMCS_PROTOCOL_GOLDEN")?;
        let document: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("the protocol golden is readable"),
        )
        .expect("the protocol golden is JSON");
        let mut order: Vec<String> = Vec::new();
        let mut cases: BTreeMap<String, Vec<Step>> = BTreeMap::new();
        let mut closed = BTreeSet::new();
        for frame in document["frames"]
            .as_array()
            .expect("a frames array")
            .iter()
        {
            let case = string(frame, "case");
            if !cases.contains_key(&case) {
                order.push(case.clone());
            }
            cases.entry(case).or_default().push(Step {
                direction: string(frame, "direction"),
                frame: string(frame, "frame"),
            });
        }
        for event in document["events"]
            .as_array()
            .expect("an events array")
            .iter()
        {
            assert_eq!(
                string(event, "event"),
                "close",
                "the capture records only closes, and this file needs the code to be a frame-free answer"
            );
            assert_eq!(
                (
                    number(event, "code"),
                    bool_of(event, "wasClean"),
                    string(event, "reason").is_empty()
                ),
                (1005, true, true),
                "a close this loop cannot mean: {} is not the silent teardown the port returns",
                string(event, "case")
            );
            closed.insert(string(event, "case"));
        }
        Some(Self {
            order,
            cases,
            closed,
            summary: document["summary"].clone(),
        })
    }

    fn steps(&self, case: &str) -> &[Step] {
        &self.cases[case]
    }
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or_default()
}

fn bool_of(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or_default()
}

/// The synthetic group the capture was made against, with each rpc's *answer* written by hand from
/// what the recorded frames show. The payloads are checked only as far as the switch would be: the
/// stub cannot word a `SchemaIssue`, so where the shipped decoder refuses, this returns [`DECODER`].
fn group() -> Group {
    Group::new()
        .returns("emptyInEmptyOut", Value::Object(Map::new()))
        .returns("voidSuccess", Value::Null)
        // `Rpc.make` without a `payload` is `Schema.Void`, which is what makes `payload:null` the
        // correct wire value and an absent key a decoder failure.
        .on("scalarSuccess", |payload| match payload {
            Some(Value::Null) => Outcome::Success(Value::String("plain string".to_owned())),
            _ => Outcome::Died(DECODER.to_owned()),
        })
        .on("nested", nested)
        .on("typedFail", |_| {
            Outcome::Typed(
                serde_json::from_str(r#"{"_tag":"ProtocolGoldenError","why":"no"}"#)
                    .expect("the recorded error hole"),
            )
        })
        // `Effect.die` on an rpc with no declared error never reaches the request: the connection
        // hears it, which is why this is a `Broadcast` and not a `Died`.
        .on("noError", |_| Outcome::Broadcast("boom".to_owned()))
        .streams("batchedStream", vec![vec![row(1), row(2), row(3)]])
        .streams("splitStream", vec![vec![row(1)], vec![row(2)]])
        .returns("idle", Value::Object(Map::new()))
}

fn nested(payload: &Payload) -> Outcome {
    let Some(fields) = payload.as_ref().and_then(Value::as_object) else {
        return Outcome::Died(DECODER.to_owned());
    };
    let (Some(name), Some(n)) = (
        fields.get("name").and_then(Value::as_str),
        fields.get("n").and_then(Value::as_f64),
    ) else {
        return Outcome::Died(DECODER.to_owned());
    };
    Outcome::Success(serde_json::json!({"ok": n > 1.0, "items": [name, "x"]}))
}

fn row(n: i64) -> Value {
    serde_json::from_str(&format!(r#"{{"i":{n}}}"#)).expect("a row is one number")
}

/// What one replay of the whole capture produced: the frames per case in artifact order, which cases
/// the loop ended, and how many frames went through the decoder exemption.
struct Run {
    answers: Vec<(String, Vec<String>)>,
    closed: BTreeSet<String>,
    exempted: usize,
}

impl Run {
    fn frames(&self) -> usize {
        self.answers.iter().map(|(_, frames)| frames.len()).sum()
    }
}

/// Feed every recorded input to a fresh connection, keeping the connection alive across a `.canary`
/// case, which is the only way the capture's canaries mean what they meant on the wire.
fn replay(golden: &Artifact) -> Run {
    let mut answers = Vec::new();
    let mut closed = BTreeSet::new();
    let mut exempted = 0;
    let mut live: Option<(String, Session)> = None;
    for case in &golden.order {
        let base = case.strip_suffix(".canary");
        if let Some(base) = base {
            assert!(
                !golden.closed.contains(base),
                "{case} follows {base}, which the capture says closed the connection"
            );
        }
        let resumes =
            base.is_some_and(|base| live.as_ref().is_some_and(|(previous, _)| previous == base));
        let mut session = match (resumes, live.take()) {
            (true, Some((_, session))) => session,
            _ => Session::new(group()),
        };
        let mut written = Vec::new();
        // A stream's terminal exit is the producer's frame, and the only thing that names a stream in
        // the recording is a `Chunk`, so the ids to close come from there rather than from a list.
        let mut streams = Vec::new();
        for step in golden.steps(case) {
            match step.direction.as_str() {
                "c2s" => {
                    assert!(
                        !closed.contains(case),
                        "{case}: the capture sent a frame after the connection ended"
                    );
                    let reply = session.receive(&step.frame);
                    // A close carries the frames the batch produced before it, so both arms write.
                    written.extend(reply.frames().iter().map(Message::encode));
                    if reply.closes() {
                        closed.insert(case.clone());
                    }
                }
                "s2c" => {
                    if let Some(id) = chunk_id(&step.frame) {
                        streams.push(id);
                    }
                    if DECODER_GAPS.contains(&case.as_str()) {
                        exempted += 1;
                    }
                }
                other => panic!("{case}: a frame in neither direction: {other}"),
            }
        }
        for id in &streams {
            written.extend(session.end(id).iter().map(Message::encode));
        }
        answers.push((case.clone(), written));
        live = if closed.contains(case) {
            None
        } else {
            Some((case.clone(), session))
        };
    }
    Run {
        answers,
        closed,
        exempted,
    }
}

fn chunk_id(frame: &str) -> Option<Id> {
    let value: Value = serde_json::from_str(frame).ok()?;
    match Message::read(&value)? {
        Message::Chunk { request_id, .. } => Some(request_id),
        _ => None,
    }
}

/// The recorded answer for a case, as text.
fn expected(golden: &Artifact, case: &str) -> Vec<String> {
    golden
        .steps(case)
        .iter()
        .filter(|step| step.direction == "s2c")
        .map(|step| step.frame.clone())
        .collect()
}

/// Compare one case. Every frame is compared as text, except the decoder's own answers, which are
/// compared after parsing with the single defect string exempted.
fn check(case: &str, want: &[String], got: &[String]) {
    assert_eq!(
        want.len(),
        got.len(),
        "{case}: wrote {} frames where the capture recorded {}\n recorded: {want:#?}\n      port: {got:#?}",
        got.len(),
        want.len()
    );
    for (index, (want, got)) in want.iter().zip(got).enumerate() {
        if DECODER_GAPS.contains(&case) {
            let (want, got) = (parse(want), parse(got));
            // The exemption covers one string and nothing else: same request, same exit tag, same
            // cause tag, same cause length.
            assert_eq!(
                want.pointer("/requestId"),
                got.pointer("/requestId"),
                "{case} frame {index}: the port answered a different request"
            );
            assert_eq!(
                want.pointer("/exit/_tag"),
                got.pointer("/exit/_tag"),
                "{case} frame {index}"
            );
            assert_eq!(
                (
                    want.pointer("/exit/cause/0/_tag").cloned(),
                    got.pointer("/exit/cause/0/_tag").cloned(),
                ),
                (Some(Value::from("Die")), Some(Value::from("Die"))),
                "{case} frame {index}: the decoder answers as a Die inside the request"
            );
            assert_eq!(
                got.pointer("/exit/cause/0/defect").and_then(Value::as_str),
                Some(DECODER),
                "{case} frame {index}: only the decoder's own text may be exempted"
            );
            let mut want = want;
            want["exit"]["cause"][0]["defect"] = Value::from(DECODER);
            assert_eq!(want, got, "{case} frame {index}");
            continue;
        }
        assert_eq!(want, got, "{case} frame {index}");
    }
}

fn parse(frame: &str) -> Value {
    serde_json::from_str(frame).expect("a recorded frame is JSON")
}

/// The headline claim: the port's connection loop and the shipped server write the same bytes for the
/// same inputs, over every one of the recorded scenarios.
#[test]
fn every_recorded_scenario_replays_through_the_switch() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let run = replay(&golden);
    for case in &golden.order {
        let got = &run
            .answers
            .iter()
            .find(|(name, _)| name == case)
            .expect("every case is replayed")
            .1;
        let want = expected(&golden, case);
        if case == CLOCKED {
            // Only the order of these answers is the clock's; the frames themselves are compared.
            let (mut want, mut got) = (want.clone(), got.clone());
            want.sort();
            got.sort();
            check(case, &want, &got);
            continue;
        }
        check(case, &want, got);
    }

    // 59 answers across 59 cases, of which 3 are the decoder's own and 5 belong to the clocked case.
    assert_eq!(
        run.frames(),
        59,
        "the loop wrote one frame per recorded frame"
    );
    assert_eq!(
        run.frames(),
        usize::try_from(number(&golden.summary, "serverToClient")).unwrap(),
        "and the capture still says the same"
    );
    assert_eq!(run.exempted, 3, "and only three needed the exemption");
}

/// The two silences in the capture are different: `[]` and an `Ack` for an unknown id leave the
/// connection running (their canaries prove it, and the canary replay above only continues a session
/// that survived), while three inputs end it with nothing written.
#[test]
fn the_loop_ends_exactly_the_connections_the_capture_saw_ended() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let run = replay(&golden);
    assert_eq!(
        run.closed, golden.closed,
        "the closes are the three inputs whose `._tag` read or `headers` read throws"
    );
    let closed: Vec<&str> = run.closed.iter().map(String::as_str).collect();
    assert_eq!(
        closed,
        vec!["b.batchWithNull", "b.headersAbsent", "b.notAnObject"],
        "and each of them wrote no frame, which is what 1005 with an empty reason looks like from here"
    );
    assert_eq!(
        run.closed.len(),
        usize::try_from(number(&golden.summary, "closes")).unwrap(),
        "the capture counted three"
    );
}

/// A canary is the capture's way of saying "the connection was still open". Replaying one on a fresh
/// session would pass every scenario in this file while proving nothing, so the replay refuses to.
#[test]
fn a_canary_runs_on_the_connection_it_was_sent_on() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let canaries: Vec<&String> = golden
        .order
        .iter()
        .filter(|case| case.ends_with(".canary"))
        .collect();
    assert_eq!(
        canaries.len(),
        12,
        "one per probe in the malformed-input battery, which is how the capture tells a refusal from a swallow"
    );
    // Every canary was sent on a live connection: the replay only continues a session that did not
    // close, so a canary whose probe closed would have been caught by `replay` itself. The claim left
    // here is the other half — each canary answered, which no fresh session could tell from a frame.
    let run = replay(&golden);
    for canary in &canaries {
        let answers = &run
            .answers
            .iter()
            .find(|(name, _)| name == *canary)
            .expect("a canary is a case")
            .1;
        assert_eq!(
            answers,
            &expected(&golden, canary),
            "{canary} answers on the connection its probe survived"
        );
    }
    assert!(!run.closed.iter().any(|case| case.ends_with(".canary")));
}
