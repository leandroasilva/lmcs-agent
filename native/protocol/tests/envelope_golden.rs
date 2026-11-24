//! The protocol crate's golden: replay the recorded wire against the port, frame by frame.
//!
//! `LMCS_PROTOCOL_GOLDEN=/path/to/protocol-golden.json cargo test --test envelope_golden`
//!
//! The artifact is the output of `apps/server/scripts/protocol-golden.ts`, which drives the shipped
//! Effect RPC stack over a real WebSocket and writes down the frames as **text** — because the claim
//! under test is byte order, and a parsed object does not carry one.
//!
//! Four axes, in descending strength:
//!
//! 1. **Re-encode.** Every frame an *encoder* wrote must come out of [`Message::encode`] identical to
//!    how it went in: the 59 the server sent plus the 20 the client's own encoder sent, which the
//!    capture marks by having no `input` — the fabricated sends carry one, and so do the 40 answers
//!    they provoked. One of the 20 (`{"_tag":"Nonsense"}`) is outside the union and so has no encoder
//!    on either side, which leaves 78 rewritten and the odd one out counted.
//!    Fabricated frames (`b.*`, which the capture wrote as raw text) are *not* re-encoded: the shipped
//!    server never echoes a request it received, it rebuilds one, and pretending otherwise would claim
//!    a byte-exactness for keys like `zzz` that no shipped code produces. They go to axes 2 and 3.
//! 2. **Recompute the refusals.** The port's own `Unknown request tag:` and `Invalid request id:`
//!    renderings are compared with the defect text the server actually wrote, computed from the
//!    recorded **input** rather than read off the answer, so the `String(…)` coercion is measured
//!    rather than asserted in isolation. 16 frames are of that shape.
//! 3. **Classify the frame.** Batches, non-JSON, and the three inputs that ended a connection are
//!    checked against what the artifact recorded as the consequence.
//! 4. **Totals.** The summary's counts, so a shift in the capture is noticed rather than absorbed.
//!
//! Not reproducible in this slice, and counted as such below:
//!
//! - `Expected string\n  at ["name"]`, `Missing key\n  at ["n"]`, `Expected null`. These are Effect's
//!   `SchemaIssue.defaultFormatter` over a payload schema, which is the schema layer's text rather
//!   than the envelope's. Three claims.
//! - A frame carrying a lone surrogate in a string. `JSON.parse` accepts one and Rust's `String`
//!   cannot hold it, so the port cannot round-trip what the shipped client could in principle write.

use std::collections::BTreeMap;
use std::env;
use std::fs;

use lmcs_protocol::envelope::{Exit, Message};
use lmcs_protocol::frame::{Envelope, Frame, invalid_request_id, unknown_request_tag};
use lmcs_protocol::{Cause, Defect, Id, Syntax};
use serde_json::Value;

/// One recorded frame, with the direction the capture named it and the raw text the scenario sent —
/// the latter present exactly for the frames no shipped encoder wrote.
struct Recorded {
    case: String,
    direction: String,
    frame: String,
    input: Option<String>,
}

/// One recorded socket close, since three of the fabricated inputs are answers with no frame.
struct Closed {
    case: String,
    code: u64,
    reason: String,
    was_clean: bool,
}

/// The capture: frames in the order they crossed, and the closes that were not frames.
struct Artifact {
    frames: Vec<Recorded>,
    closes: Vec<Closed>,
    summary: Value,
}

fn text(value: Option<&Value>, key: &str) -> String {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

impl Artifact {
    fn load() -> Option<Self> {
        let path = env::var_os("LMCS_PROTOCOL_GOLDEN")?;
        let document: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("the protocol golden is readable"),
        )
        .expect("the protocol golden is JSON");
        let frames = document["frames"]
            .as_array()
            .expect("a frames array")
            .iter()
            .map(|frame| Recorded {
                case: text(Some(frame), "case"),
                direction: text(Some(frame), "direction"),
                frame: text(Some(frame), "frame"),
                input: frame
                    .get("input")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .collect();
        let closes = document["events"]
            .as_array()
            .expect("an events array")
            .iter()
            .map(|event| Closed {
                case: text(Some(event), "case"),
                code: event
                    .get("code")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                reason: text(Some(event), "reason"),
                was_clean: event
                    .get("wasClean")
                    .and_then(Value::as_bool)
                    .unwrap_or_default(),
            })
            .collect();
        Some(Self {
            frames,
            closes,
            summary: document["summary"].clone(),
        })
    }

    fn count(&self, direction: &str) -> usize {
        self.frames
            .iter()
            .filter(|frame| frame.direction == direction)
            .count()
    }

    /// The frames one of the shipped **encoders** produced. The server writes all of its own, even
    /// when the capture fabricated the request that provoked them; on the client side the capture
    /// marks a raw send with `input`, so the frames without one are the client's encoder's output.
    fn encoder_frames(&self) -> Vec<String> {
        self.frames
            .iter()
            .filter(|frame| frame.direction == "s2c" || frame.input.is_none())
            .map(|frame| frame.frame.clone())
            .collect()
    }

    /// Recorded frames by case, in crossing order.
    fn by_case(&self, direction: &str) -> BTreeMap<String, Vec<String>> {
        let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for frame in self
            .frames
            .iter()
            .filter(|frame| frame.direction == direction)
        {
            grouped
                .entry(frame.case.clone())
                .or_default()
                .push(frame.frame.clone());
        }
        grouped
    }

    /// The raw text a scenario sent, by case. A case can send several frames but never several with
    /// an input, which is why a map is enough here.
    fn inputs(&self) -> BTreeMap<String, String> {
        self.frames
            .iter()
            .filter(|frame| frame.direction == "c2s")
            .filter_map(|frame| Some((frame.case.clone(), frame.input.clone()?)))
            .collect()
    }
}

fn only_envelope(frame: &str) -> Envelope {
    match Frame::decode(frame) {
        Frame::Batch(items) if items.len() == 1 => items[0].clone(),
        other => panic!("{frame} decoded to {other:?}, expected one envelope"),
    }
}

/// The first frame the server wrote for a scenario, which is the one that answers that scenario.
fn answer(responses: &BTreeMap<String, Vec<String>>, case: &str) -> String {
    responses
        .get(case)
        .and_then(|frames| frames.first())
        .unwrap_or_else(|| panic!("{case} got no answer, and the capture said it would"))
        .clone()
}

/// Axis 1.
#[test]
fn recorded_frames_re_encode_byte_for_byte() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    assert_eq!(
        golden
            .frames
            .iter()
            .filter(|frame| frame.direction == "s2c" && frame.input.is_some())
            .count(),
        40,
        "the capture writes the fabricated text onto the answer it provoked, not only the send"
    );
    let written = golden.encoder_frames();
    assert_eq!(
        written.len(),
        79,
        "59 from the server and 20 from the client"
    );

    let mut re_encoded = 0;
    let mut without_an_encoder = Vec::new();
    for frame in written {
        match only_envelope(&frame) {
            Envelope::Message(message) => {
                assert_eq!(message.encode(), frame, "re-encoded {frame}");
                re_encoded += 1;
            }
            // A `_tag` outside the nine is a frame a client can send and neither peer can encode, so
            // there is nothing here to reproduce — axis 2 covers what answers it.
            Envelope::Other { tag } => without_an_encoder.push(tag),
            Envelope::Teardown => panic!("{frame} was recorded as crossing, so it is not null"),
        }
    }
    assert_eq!(re_encoded, 78);
    assert_eq!(without_an_encoder, vec!["Nonsense".to_owned()]);
}

/// The **other** encoder. [`Message::encode`] prints the `exit` hole it was handed, so axis 1 never
/// runs [`Exit::to_value`] — and `to_value` is the path a Rust handler's answer actually takes,
/// because a server builds an `Exit` rather than copying a frame it received. Rebuilding each
/// recorded answer from its structured form and re-encoding it is what pins `Schema.Void`, the
/// cause array and the `_tag`-first order against bytes instead of against a unit test that
/// mirrors them.
#[test]
fn a_built_answer_is_the_answer_the_shipped_server_wrote() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let mut built = 0;
    let mut not_an_exit = 0;
    for frame in golden
        .frames
        .iter()
        .filter(|frame| frame.direction == "s2c")
    {
        let Envelope::Message(message) = only_envelope(&frame.frame) else {
            panic!("{} is one frame", frame.frame);
        };
        let Some(exit) = message.exit() else {
            not_an_exit += 1;
            continue;
        };
        let Message::Exit { request_id, .. } = message.clone() else {
            unreachable!("exit() only answers for an Exit envelope");
        };
        let rebuilt = Message::Exit {
            request_id,
            exit: exit.to_value(),
        };
        assert_eq!(rebuilt.encode(), frame.frame, "rebuilt from {exit:?}");
        built += 1;
    }
    // 59 frames came from the server; 37 of them are an `Exit` and the other 22 are `Chunk`, `Pong`
    // and the broadcast `Defect`s, which the same loop skips and counts.
    assert_eq!(
        built, 37,
        "every recorded answer rebuilt from its structured form"
    );
    assert_eq!(
        not_an_exit, 22,
        "the rest are Chunks, Pongs and broadcast Defects"
    );
    assert_eq!(
        built + not_an_exit,
        golden.count("s2c"),
        "and the loop saw every frame the server sent"
    );
}

/// The headline measurement: an rpc that returns nothing and an rpc that returns the empty object
/// differ by one word on the wire, and a port that renders `Schema.Void` as `{}` breaks the client's
/// `decodeSuccess` without anything else noticing.
#[test]
fn void_crosses_as_null_and_the_empty_struct_as_an_object() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let by_case = golden.by_case("s2c");
    for (case, expected) in [
        ("a.voidSuccess", Exit::Success { value: Value::Null }),
        (
            "a.voidPayload",
            Exit::Success {
                value: Value::Object(serde_json::Map::new()),
            },
        ),
        (
            "a.omittedPayload",
            Exit::Success {
                value: Value::String("plain string".to_owned()),
            },
        ),
    ] {
        let frame = &by_case[case][0];
        let Envelope::Message(message) = only_envelope(frame) else {
            panic!("{case}: {frame} is an envelope");
        };
        assert_eq!(message.exit(), Some(expected), "{case} answers {frame}");
    }
    // A stream's terminal frame carries the same `null`, because `stream: true` replaces the success
    // schema with `Schema.Void` — the frame is the whole of that implementation detail.
    let batched = &by_case["a.streamBatched"];
    assert_eq!(
        batched[0], r#"{"_tag":"Chunk","requestId":7,"values":[{"i":1},{"i":2},{"i":3}]}"#,
        "one Chunk holds every synchronously available value"
    );
    let exit = batched.last().unwrap();
    assert!(
        exit.contains(r#""_tag":"Success","value":null"#),
        "and the stream still ends with an Exit: {exit}"
    );
    assert_eq!(
        batched.len(),
        2,
        "a Chunk then the terminal Exit, with no frame per value"
    );
    // The split stream is the same rpc at a slower pace, and the client's ack is what separates them:
    // two Chunks, two Acks, one Exit.
    let split = &by_case["a.streamSplit"];
    assert_eq!(
        split.len(),
        3,
        "the capture interleaved the acks between them"
    );
    let acked = golden
        .frames
        .iter()
        .filter(|frame| frame.case == "a.streamSplit" && frame.frame.contains(r#""_tag":"Ack""#))
        .count();
    assert_eq!(acked, 2, "one Ack per Chunk, and none for the Exit");
}

/// The two refusal templates, recomputed from the input the capture sent and compared with the bytes
/// the server wrote. This is where `String([]) == ""` earns its keep.
#[test]
fn refusals_are_rendered_from_the_value_the_client_sent() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let responses = golden.by_case("s2c");
    let inputs = golden.inputs();
    let mut recomputed = 0;
    for (case, input) in &inputs {
        // The first answer the scenario got, if it got one: the ack, the Eof, the empty batch and the
        // three closes are silent, and axis 3 reads them. For the broadcast case the first answer is
        // the `Defect` rather than the in-flight `Exit`s, which is the point of that scenario.
        let Some(frame) = responses
            .get(case)
            .and_then(|frames| frames.first())
            .cloned()
        else {
            continue;
        };
        let Some(hole) = written_defect(&frame) else {
            continue;
        };
        let Defect::Text(defect) = Defect::read(&hole) else {
            // `b.malformedJson` writes an error object rather than a string, and axis 3 reads it.
            continue;
        };
        // A defect that is neither template is the rpc layer's own text — a payload schema's
        // `defaultFormatter` output, or a handler's thrown string — which this crate does not own and
        // does not claim.
        if !is_refusal(&defect) {
            continue;
        }
        let expected = envelope_refusal(input).unwrap_or_else(|| {
            panic!("{case}: {defect} was refused at a gate this port cannot see from {input}")
        });
        assert_eq!(
            defect, expected,
            "{case}: input {input} was answered by {expected}"
        );
        recomputed += 1;
    }
    // Measured by case, so a missing branch shows up as a count rather than a passing loop: the eight
    // `Unknown request tag:` (one bad literal, one absent `_tag` twice over — bare and batched — one
    // absent `tag`, one numeric `tag`, one unknown `tag`, one scalar frame) and the eight
    // `Invalid request id:` (absent twice over, `null`, `true`, `[]`, `{}`, and the two unroutable
    // server envelopes counted against their own tag).
    assert_eq!(
        recomputed, 16,
        "recomputed refusals, not the three the schema layer renders"
    );

    // The gate order, named rather than implied: `b.idNull` sends a tag the group knows with an id it
    // does not, and the id wins — so `typeof id` runs before the lookup.
    assert_eq!(
        answer(&responses, "b.idNull"),
        r#"{"_tag":"Defect","defect":"Invalid request id: null"}"#
    );
    assert_eq!(
        envelope_refusal(&inputs["b.idNull"]),
        Some(invalid_request_id(&Id::Other(Value::Null)))
    );
    // And a `Die` inside an `Exit` is the same template as the broadcast `Defect`: what separates them
    // is whether the server had an id to answer to, which is why `b.badTagLiteral` (no readable id)
    // is a broadcast and `b.unknownTag` (id 9001) is a response.
    assert_eq!(
        envelope_refusal(&inputs["b.unknownTag"]),
        Some(unknown_request_tag("nope"))
    );
    assert!(
        answer(&responses, "b.unknownTag").starts_with(r#"{"_tag":"Exit","requestId":9001,"#),
        "the group miss on a known id is answered to that id"
    );
    // The empty-string case, which is the one a Rust `Display` port gets wrong: an array id becomes
    // nothing at all, so the message ends in a space.
    assert_eq!(
        answer(&responses, "b.idArray"),
        r#"{"_tag":"Defect","defect":"Invalid request id: "}"#
    );
    assert_eq!(
        envelope_refusal(&inputs["b.idArray"]),
        Some(invalid_request_id(&Id::Other(Value::Array(Vec::new()))))
    );
}

/// Whether a defect text came from one of the two envelope-level templates.
fn is_refusal(defect: &str) -> bool {
    defect.starts_with("Unknown request tag: ") || defect.starts_with("Invalid request id: ")
}

/// The defect the server wrote for one input, wherever it sits: the hole of a `Defect` broadcast, or
/// the `Die` of an `Exit`'s failure cause. Both are `Schema.Defect`'s output, and the golden has to
/// read either to recompute it.
fn written_defect(frame: &str) -> Option<Value> {
    let Envelope::Message(message) = only_envelope(frame) else {
        return None;
    };
    match message {
        Message::Defect { defect } => Some(defect),
        Message::Exit { exit, .. } => match Exit::read(&exit)? {
            Exit::Failure { cause } => cause.into_iter().find_map(|cause| match cause {
                Cause::Die { defect } => Some(defect),
                Cause::Fail { .. } | Cause::Interrupt { .. } => None,
            }),
            Exit::Success { .. } => None,
        },
        _ => None,
    }
}

/// The port's own answer for a frame, in the shipped gate order: the `_tag` read first, because a tag
/// outside the nine never reaches an id; then `typeof id`; then the group key, which is the only one
/// of the three the port cannot decide alone — the caller has to know the group missed.
///
/// That is why this returns the text it *would* refuse with, and axis 2 only compares it for the
/// frames the server really did refuse with one of the two templates.
fn envelope_refusal(input: &str) -> Option<String> {
    match Frame::decode(input) {
        Frame::Batch(items) if items.len() == 1 => match &items[0] {
            Envelope::Teardown => None,
            Envelope::Other { tag } => Some(unknown_request_tag(tag)),
            Envelope::Message(Message::Request(request)) if !request.id.is_valid() => {
                Some(invalid_request_id(&request.id))
            }
            Envelope::Message(Message::Request(request)) => {
                Some(unknown_request_tag(&request.group_key()))
            }
            // `Ping`, `Eof`, `Ack` and `Interrupt` are routed and have no tag to refuse; the other
            // five of the nine are server-to-client envelopes, refused by name.
            Envelope::Message(message) if message.is_from_client() => None,
            Envelope::Message(message) => Some(unknown_request_tag(message.tag())),
        },
        _ => None,
    }
}

/// What the frame-level decoder makes of the inputs that are not envelopes at all.
#[test]
fn batches_non_json_and_the_inputs_that_kill_the_connection() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let responses = golden.by_case("s2c");
    let inputs = golden.inputs();

    // Two of the three closes are this layer's: reading `._tag` off `null` throws rather than yielding
    // `undefined`, so the handler dies before it can answer.
    for case in ["b.notAnObject", "b.batchWithNull"] {
        assert_eq!(
            Frame::decode(&inputs[case]),
            Frame::Batch(vec![Envelope::Teardown]),
            "{case} was the connection ending, not a frame being refused"
        );
        assert!(
            !responses.contains_key(case),
            "{case} answered a frame the server did not write"
        );
    }

    // The third close is a frame this layer reads perfectly well, which is the more interesting claim:
    // the request is complete bar the one key the shipped handler dereferences before it can answer
    // (`Headers.fromInput(undefined)`, inside the handler rather than at the switch), so nothing at
    // this altitude could have warned about it.
    let Envelope::Message(message) = only_envelope(&inputs["b.headersAbsent"]) else {
        panic!("a request without headers is still a request");
    };
    let Message::Request(request) = &message else {
        panic!("the capture recorded a Request");
    };
    assert!(request.id.is_valid() && request.tag.is_some());
    assert_eq!(request.headers, None);
    assert_eq!(
        message.rejection(),
        None,
        "no gate above the group refuses it"
    );
    assert!(!responses.contains_key("b.headersAbsent"));

    // All three ended the socket the same way, with no close code of its own.
    let closed: Vec<&str> = golden
        .closes
        .iter()
        .map(|close| close.case.as_str())
        .collect();
    assert_eq!(
        closed,
        vec!["b.headersAbsent", "b.notAnObject", "b.batchWithNull"]
    );
    for close in &golden.closes {
        assert_eq!(
            (close.code, close.reason.as_str(), close.was_clean),
            (1005, "", true)
        );
    }

    // The two inputs that are not JSON: both V8 messages are the same two words, and the answer is an
    // error object rather than a string.
    for case in ["b.malformedJson", "b.emptyFrame"] {
        let Frame::Refused(syntax) = Frame::decode(&inputs[case]) else {
            panic!("{case} is not JSON");
        };
        assert_eq!(Syntax::UnexpectedEnd, syntax);
        let Envelope::Message(answer) = only_envelope(&answer(&responses, case)) else {
            panic!("{case} answers a defect");
        };
        assert_eq!(
            answer.defect(),
            Some(Defect::Error {
                name: "SyntaxError".to_owned(),
                message: "Unexpected end of JSON input".to_owned(),
                cause: None,
            }),
            "{case}: the error object is what the client shows"
        );
    }

    // `[]` is a batch of nothing. It is not an error, and the socket outlives it.
    assert_eq!(
        Frame::decode(&inputs["b.arrayFrame"]),
        Frame::Batch(Vec::new())
    );
    assert_eq!(
        Frame::decode(&inputs["b.arrayFrame"]).routed().len(),
        0,
        "and nothing is routed"
    );
    assert!(
        responses.contains_key("b.arrayFrame.canary"),
        "an empty batch leaves the connection answering"
    );

    // A batch of two routes two, in the order sent, and each is answered on its own.
    let Frame::Batch(items) = Frame::decode(&inputs["b.batchOfTwo"]) else {
        panic!("a batch is a batch");
    };
    let ids: Vec<String> = items
        .iter()
        .map(|item| match item {
            Envelope::Message(Message::Request(request)) => request.id.text(),
            other => panic!("{other:?} is not a request"),
        })
        .collect();
    assert_eq!(ids, vec!["9400".to_owned(), "9401".to_owned()]);
    let answered = &responses["b.batchOfTwo"];
    assert_eq!(
        answered.len(),
        2,
        "two requests, two frames, one connection"
    );
    for (id, frame) in ids.iter().zip(answered) {
        assert!(
            frame.contains(&format!(r#""requestId":{id},"#)),
            "{frame} should answer request {id}"
        );
    }

    // A batch of one non-message is answered like a bare one, which is what the `[decoded]` rule and
    // the switch's default arm together mean.
    assert_eq!(
        answer(&responses, "b.batchOfNonMessage"),
        answer(&responses, "b.scalarFrame"),
        "both read `_tag` as `undefined`"
    );

    // The server never writes `Eof` on a WebSocket, and a client that does is forwarded rather than
    // refused — which is the difference between routing a message to a handler that ignores it and
    // rejecting one.
    assert!(
        !responses.contains_key("b.eofFromClient"),
        "an Eof frame reached the client, contradicting the capture"
    );
    for frame in responses.values().flatten() {
        assert!(
            !frame.contains(r#""_tag":"Eof""#),
            "{frame} is an Eof from the server"
        );
    }

    let Envelope::Message(message) = only_envelope(&inputs["b.notificationWithId"]) else {
        panic!("the fabricated frame is a request");
    };
    let Message::Request(request) = &message else {
        panic!("the capture recorded a Request");
    };
    assert!(
        request.notification,
        "the key is read, and `b.notificationWithId` shows it changes nothing"
    );
    assert!(
        answer(&responses, "b.notificationWithId").starts_with(r#"{"_tag":"Exit","#),
        "a notification with an id is answered like any other request"
    );
}

/// The ids a real client writes are one counter for the process, not one per socket: the capture
/// opened two sockets and the sequence did not restart.
#[test]
fn client_request_ids_are_one_module_global_counter() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    let ids: Vec<String> = golden
        .frames
        .iter()
        .filter(|frame| frame.direction == "c2s" && frame.case.starts_with("a."))
        .filter_map(|frame| {
            let Envelope::Message(Message::Request(request)) = only_envelope(&frame.frame) else {
                return None;
            };
            Some(request.id.text())
        })
        .collect();
    let expected: Vec<String> = (0..ids.len()).map(|index| index.to_string()).collect();
    assert_eq!(ids, expected, "path A wrote its requests from one counter");
    assert_eq!(
        ids.len(),
        11,
        "ten rpcs, the tenth of them on the capture's second socket"
    );
    assert_eq!(
        golden
            .frames
            .iter()
            .filter(|frame| frame.case == "a.secondSocket")
            .count(),
        2,
        "and that socket still answered, at id 10"
    );

    // The trace trio travels with every one of them, and the `sampled` boolean is a boolean.
    let traced: Vec<&String> = golden
        .frames
        .iter()
        .filter(|frame| frame.direction == "c2s" && frame.frame.contains(r#""traceId":"#))
        .map(|frame| &frame.frame)
        .collect();
    assert_eq!(
        traced.len(),
        ids.len(),
        "the client span was live for all of them"
    );
    for frame in traced {
        assert!(
            frame.contains(r#""sampled":true,"headers":"#),
            "{frame}: the literal writes the trio before headers"
        );
    }
}

/// The counts, so a capture that quietly grew or shrank is a failing test rather than a smaller
/// number of assertions.
#[test]
fn the_capture_says_what_it_recorded() {
    let Some(golden) = Artifact::load() else {
        eprintln!("skipping protocol golden: set LMCS_PROTOCOL_GOLDEN");
        return;
    };
    assert_eq!(golden.frames.len(), 125);
    assert_eq!(golden.count("c2s"), 66);
    assert_eq!(golden.count("s2c"), 59);
    assert_eq!(golden.summary["clientToServer"].as_u64(), Some(66));
    assert_eq!(golden.summary["serverToClient"].as_u64(), Some(59));
    assert_eq!(golden.summary["frames"].as_u64(), Some(125));
    assert_eq!(golden.summary["scenarios"].as_u64(), Some(61));
    assert_eq!(golden.summary["closes"].as_u64(), Some(3));
    assert_eq!(
        golden.summary["serialization"].as_str(),
        Some("RpcSerialization.layerJson")
    );
    assert_eq!(golden.summary["opcode"].as_str(), Some("text"));

    // Every one of the nine tags the union declares was seen on the wire, which is what makes "nine
    // envelopes" a measured phrase rather than a reading of the union.
    for tag in Message::TAGS {
        let crossed = format!(r#""_tag":"{tag}""#);
        assert!(
            golden
                .frames
                .iter()
                .any(|frame| frame.frame.contains(&crossed)),
            "{tag} never crossed"
        );
    }
    // `Eof` is the one the server never wrote, in either direction, and the only tag whose whole
    // recorded presence belongs to the client.
    let eof = golden
        .frames
        .iter()
        .filter(|frame| frame.frame.contains(r#""_tag":"Eof""#))
        .collect::<Vec<_>>();
    assert_eq!(
        eof.iter()
            .map(|frame| frame.direction.as_str())
            .collect::<Vec<_>>(),
        vec!["c2s"],
        "the capture's own claim: `layerJson` never sends Eof over a WebSocket"
    );

    // The numbers the port has to spell the JavaScript way.
    let fiber = golden
        .frames
        .iter()
        .find(|frame| frame.frame.contains("fiberId"))
        .expect("the interrupted stream recorded its fiber");
    let Envelope::Message(message) = only_envelope(&fiber.frame) else {
        panic!("the interrupt is a response envelope");
    };
    assert_eq!(
        message.exit(),
        Some(Exit::Failure {
            cause: vec![Cause::Interrupt {
                // Masked by the capture to `Number.MAX_SAFE_INTEGER`, the worst case for a
                // reformatting writer: sixteen digits that must stay sixteen digits.
                fiber_id: Some(Value::from(9_007_199_254_740_991_u64)),
            }],
        }),
        "{}",
        fiber.frame
    );
    // A float that a reformatting writer would otherwise turn into `1.5`→`1.5` only by luck of Rust's
    // default `Display`; the capture pins the digit text on both sides of the payload.
    assert!(
        golden
            .frames
            .iter()
            .any(|frame| frame.frame.contains(r#""n":1.5"#)),
        "the nested rpc recorded a float that has to stay 1.5"
    );
    // And the typed error is a tagged union of its own, with `_tag` first inside the cause.
    assert!(
        golden.frames.iter().any(|frame| frame
            .frame
            .contains(r#"{"_tag":"Fail","error":{"_tag":"ProtocolGoldenError","why":"no"}}"#)),
        "a declared error crosses as the schema wrote it"
    );
}
