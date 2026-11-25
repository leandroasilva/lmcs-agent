//! The declared group's golden: replay `group-golden.ts` against the port's dispatch, and pin that the
//! answer is decided by the **declaration** rather than by the handler.
//!
//! `LMCS_GROUP_GOLDEN=/path/to/group-golden.json cargo test --test group_golden`
//!
//! [`session_golden`](./session_golden.rs) and [`scope_golden`](./scope_golden.rs) served a synthetic
//! group: each could name the one line of `RpcServer.ts` it measured, and nothing about the *real*
//! `WsRpcGroup` was in scope. This file closes the four claims that choice left open, all of them about
//! what `group.requests.get(tag)` and `Rpc.exitSchema(rpc)` decide:
//!
//! - A tag the group registers and nobody implemented is **not** an unknown tag. `RpcGroup.toHandlers`
//!   maps over every registered tag and stores `handlers[tag]`, so the entry exists with nothing behind
//!   it, and `entry.handler is not a function` is a `TypeError` the transport catches as a broadcast
//!   `Defect` — no `requestId`, socket alive, repeating per request (`lookup.unimplemented*`).
//! - `Schema.Void` **overwrites** the handler's value. Spelled or defaulted, with a handler returning an
//!   object or nothing, the wire says `"value":null` (`void.*`).
//! - A stream is the declaration's shape, not the handler's. A `stream: true` tag whose handler returned
//!   an effect throws while reading `._tag` (`stream.effectHandler`), and a unary or `Void` tag whose
//!   handler returned a stream answers the request with an `Interrupt` whose `fiberId` is `null` — the
//!   internal interrupt of a fiber that never was, which crosses differently from a client's
//!   `Interrupt` (`shape.*` against `stream.interrupted`).
//! - A tag with no `tag` key and a tag with `tag: ""` reach the same string by two routes, because the
//!   protocol tests `Object.hasOwn(request, "tag")` (`lookup.missingTag`, `lookup.emptyTag`).
//!
//! The `Decl` each tag is stubbed with is **not asserted here from a reading of the artifact**: the
//! recording carries the row the oracle read off the shipped `Rpc` (`measured`), and
//! [`the_declarations_this_file_stubs_are_the_ones_the_shipped_group_makes`] re-derives the declaration
//! from that row and compares. A tag spelled wrong here matches no recorded frame; a `Decl` spelled
//! wrong answers with the wrong frame *and* fails that test, naming the tag rather than a case.
//!
//! Four cases are declared gaps instead, each with its reason next to its name: two because the shipped
//! server decodes **before** it reaches a missing handler — which this loop cannot, having no decoder to
//! run at that point — one because reusing a request id loses the answer in the server's in-flight map
//! and this loop has none, and one because a stream that fails after a batch needs a failure channel
//! [`Outcome::Stream`] does not carry. Eleven more cases carry a frame whose only unportable part is the
//! `SchemaIssue.defaultFormatter` text of a **real** contract schema; those are compared structurally
//! with that one string exempted, via [`DECODER`], so no exemption can cover a frame the port can word.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;

use lmcs_protocol::envelope::{Id, Message};
use lmcs_protocol::session::{Decl, Group, Outcome, Payload, Session};
use serde_json::{Map, Value, json};

/// What the stub group writes where the shipped rpc's codec writes `SchemaIssue.defaultFormatter` text.
/// Not valid in that language, so no recorded defect can collide with it by accident.
const DECODER: &str = "\u{0}decoder";

/// How every case's recording ends. The port's own close rule is [`Session`]'s and is pinned by
/// `session_golden` and `transport_golden`; here the note only says the socket the server answered on
/// was never torn down by the server, so no case's frames can be an artifact of a teardown.
const CLOSE: &str = "close code=1005 reason=\"\" wasClean=true";

/// The tags the oracle's cases name, read off `WS_METHODS` by hand because this crate does not depend on
/// the contracts one. A tag spelled wrong here matches no recorded frame and fails the replay.
const PROBE: &str = "server.probe";
const GET_CONFIG: &str = "server.getConfig";
const BACKGROUND: &str = "server.getBackgroundPolicy";
const ATTACHMENTS_DELETE: &str = "attachments.delete";
const VCS_INIT: &str = "vcs.init";
const INVALIDATE: &str = "pullRequests.invalidate";
const SUBSCRIBE_REFRESHES: &str = "pullRequests.subscribeRefreshes";
const SUBSCRIBE_TERMINAL: &str = "subscribeTerminalEvents";
const UNIMPLEMENTED: &str = "server.getSettings";
const UNIMPLEMENTED_STREAM: &str = "subscribeDiscoveredLocalServers";
const NESTED_REFUSAL: &str = "device.close";

/// The cases whose refused answer is worded by the rpc's **codec** rather than by the dispatch: a payload
/// the declaration cannot read, a check the trimmed value fails, a success schema the handler's object
/// does not satisfy. Each is exempted for exactly one string, and only in exactly these cases.
const CODEC_TEXT: [&str; 11] = [
    "empty.payloadNull",
    "empty.payloadAbsent",
    "delete.blank",
    "delete.missingKey",
    "optional.kindBogus",
    "deep.missingKeys",
    "deep.secondThought",
    "deep.partial",
    "stream.negativeElement",
    "union.bogusType",
    "union.scalarElement",
];

/// The cases whose answer the **rpc's decoder** produces before the dispatch reaches an entry it cannot
/// run. `ws.ts` and `RpcServer.ts` decode inside the request handling, so a tag with no handler still
/// answers with its own `Exit`; this port keeps the decode inside the handler, so it has nowhere to run
/// it. Wiring the contracts layer's decoder into the dispatch is what closes these two.
const DECODE_BEFORE_HANDLER: [&str; 2] = ["lookup.unimplementedUndecodable", "decode.nestedKey"];

/// `id.reuse`: the shipped server keys its in-flight requests by id, so a second request written while
/// the first is still running loses **both** answers. This loop answers each request as it reads it and
/// has no in-flight map to lose one in, which is a claim about the runtime rather than about the frames.
const IN_FLIGHT_MAP: &str = "id.reuse";

/// `stream.failedStream`: one `Chunk` out, then the producer fails and the failure is refused by the
/// stream's own error schema, so the terminal `Exit` is a `Failure`/`Die`. [`Outcome::Stream`] carries
/// batches and no failure channel, and [`Session::end`] writes only the success exit.
const STREAM_FAILURE_CHANNEL: &str = "stream.failedStream";

const GAPS: [&str; 4] = [
    DECODE_BEFORE_HANDLER[0],
    DECODE_BEFORE_HANDLER[1],
    IN_FLIGHT_MAP,
    STREAM_FAILURE_CHANNEL,
];

/// The stub the oracle put the group in for one case. Every member is one branch of the `mode ===` chain
/// in `group-golden.ts`, so an unused arm here is an unused arm there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Idle,
    Sleep,
    Echo,
    Extra,
    Value,
    Stream,
    EmptyObject,
    Partial,
    Three,
    Empty,
    Negative,
    Effect,
    Fail,
    Later,
    Scrambled,
    BogusType,
    Scalar,
}

impl Mode {
    fn of(text: &str) -> Self {
        match text {
            "idle" => Self::Idle,
            "sleep" => Self::Sleep,
            "echo" => Self::Echo,
            "extra" => Self::Extra,
            "value" => Self::Value,
            "stream" => Self::Stream,
            "emptyObject" => Self::EmptyObject,
            "partial" => Self::Partial,
            "three" => Self::Three,
            "empty" => Self::Empty,
            "negative" => Self::Negative,
            "effect" => Self::Effect,
            "fail" => Self::Fail,
            "later" => Self::Later,
            "scrambled" => Self::Scrambled,
            "bogusType" => Self::BogusType,
            "scalar" => Self::Scalar,
            other => panic!("the oracle used a mode this file does not stub: {other}"),
        }
    }
}

/// One tag of the shipped group as this file needs it: the artifact's `measured` key, the tag, the
/// declaration this file gives it, and whether the oracle gave it a handler. The last column is the one
/// the `lookup.unimplemented*` cases measure, and the count is what `summary.stubbed` pins.
const DECLARED: [(&str, &str, Decl, bool); 11] = [
    ("probe", PROBE, Decl::Value, true),
    ("getConfig", GET_CONFIG, Decl::Value, true),
    ("getBackgroundPolicy", BACKGROUND, Decl::Value, true),
    ("getSettings", UNIMPLEMENTED, Decl::Value, false),
    ("attachmentsDelete", ATTACHMENTS_DELETE, Decl::Void, true),
    ("vcsInit", VCS_INIT, Decl::Void, true),
    ("invalidate", INVALIDATE, Decl::Void, true),
    (
        "subscribeRefreshes",
        SUBSCRIBE_REFRESHES,
        Decl::Stream,
        true,
    ),
    (
        "subscribeTerminalEvents",
        SUBSCRIBE_TERMINAL,
        Decl::Stream,
        true,
    ),
    (
        "subscribeDiscoveredLocalServers",
        UNIMPLEMENTED_STREAM,
        Decl::Stream,
        false,
    ),
    ("deviceClose", NESTED_REFUSAL, Decl::Void, false),
];

struct Case {
    name: String,
    mode: String,
}

struct Step {
    direction: String,
    frame: String,
}

struct Artifact {
    /// The cases in the order the oracle ran them, with the mode each one put the stubs in.
    cases: Vec<Case>,
    steps: BTreeMap<String, Vec<Step>>,
    /// The cases in the order their first frame crossed, which is how a case that reached the wire
    /// without being declared is caught.
    order: Vec<String>,
    summary: Value,
    measured: Value,
}

impl Artifact {
    fn load() -> Option<Self> {
        let path = env::var_os("LMCS_GROUP_GOLDEN")?;
        let document: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("the group golden is readable"))
                .expect("the group golden is JSON");
        let cases = document["cases"]
            .as_array()
            .expect("a cases array")
            .iter()
            .map(|case| Case {
                name: string(case, "name"),
                mode: string(case, "mode"),
            })
            .collect::<Vec<_>>();
        let mut steps: BTreeMap<String, Vec<Step>> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for frame in document["wire"].as_array().expect("a wire array") {
            let case = string(frame, "case");
            if !steps.contains_key(&case) {
                order.push(case.clone());
            }
            let step = Step {
                direction: string(frame, "direction"),
                frame: string(frame, "frame"),
            };
            assert!(
                matches!(step.direction.as_str(), "c2s" | "s2c" | "note"),
                "{case}: a frame in no direction this file reads: {}",
                step.direction
            );
            if step.direction == "note" {
                // The only note the oracle writes is the close, and an `error` note would be a case whose
                // frames the driver never got to see, which no comparison against the loop could explain.
                assert_eq!(
                    step.frame, CLOSE,
                    "{case}: the socket did not end the silent way this loop closes"
                );
            }
            steps.entry(case).or_default().push(step);
        }
        Some(Self {
            cases,
            steps,
            order,
            summary: document["summary"].clone(),
            measured: document["measured"].clone(),
        })
    }

    fn steps(&self, case: &str) -> &[Step] {
        self.steps
            .get(case)
            .unwrap_or_else(|| panic!("the artifact recorded no frames for {case}"))
    }
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// The `EnvironmentAuthorizationError` the oracle's `authEcho` builds, in the key order its schema
/// declares. The whole reason that stub fails rather than succeeds is to put a **decoded** payload on
/// the wire inside an exit the codec accepts, so the trim, the dropped key and the key order are readable
/// off the frame instead of being asserted about a decoder this crate does not have.
fn echo(decoded: &Value) -> Outcome {
    Outcome::Typed(json!({
        "_tag": "EnvironmentAuthorizationError",
        "message": format!("payload:{decoded}"),
        "requiredScope": "orchestration:read",
    }))
}

/// The answer every refused decode has in this file: the sentinel the comparison below swaps for the
/// `SchemaIssue` text the shipped codec wrote.
fn refused() -> Outcome {
    Outcome::Died(DECODER.to_owned())
}

/// `attachments.delete`'s `attachmentId`: a required string whose decoder trims and whose schema then
/// refuses the empty result. The trim is a transform the declaration carries, so it is modelled rather
/// than exempted — `delete.trimmed` is worth pinning as text.
fn decoded_attachment_id(payload: &Payload) -> Result<String, Outcome> {
    let text = payload
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|fields| fields.get("attachmentId"))
        .and_then(Value::as_str)
        .ok_or_else(refused)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(refused());
    }
    Ok(trimmed.to_owned())
}

/// `vcs.init`: `cwd` required, `kind` an optional `Literal` union. A key the declaration never had is
/// dropped and the survivors come out in the declaration's order, which is why the echo below rebuilds the
/// object instead of passing the payload through.
fn decoded_vcs_init(payload: &Payload) -> Result<Value, Outcome> {
    let fields = payload
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(refused)?;
    let cwd = fields
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(refused)?;
    let mut out = Map::new();
    out.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    match fields.get("kind") {
        None => {}
        Some(value @ Value::String(_))
            if matches!(value.as_str(), Some("git") | Some("unknown")) =>
        {
            out.insert("kind".to_owned(), value.clone());
        }
        Some(_) => return Err(refused()),
    }
    Ok(Value::Object(out))
}

/// The `TerminalEvent` member as its **own declaration** orders it. `union.element` built it in that
/// order and `union.scrambled` built it scrambled with a key the union has never had, and the recording
/// wrote the two frames identically — the encoder's output is the declaration either way, so one stub
/// answers both modes and the equality of the two cases' frames is the claim.
fn terminal_output() -> Value {
    json!({"threadId": "t", "terminalId": "x", "type": "output", "data": "hi"})
}

/// The stub group for one mode: the eight tags `WsRpcGroup.toLayer` was given a handler for, the three it
/// was not, and each handler answering the way the oracle's answered.
fn group(mode: Mode) -> Group {
    Group::new()
        // Registered, never implemented: the state a migrating server is in for most of its life.
        .declared(UNIMPLEMENTED, Decl::Value)
        .declared(UNIMPLEMENTED_STREAM, Decl::Stream)
        // `device.close` is the rpc whose payload is a `threadId`, so the decode refuses it before the
        // dispatch can notice it has no handler — the first of the two declared gaps.
        .declared(NESTED_REFUSAL, Decl::Void)
        .with(PROBE, Decl::Value, move |payload, _| match mode {
            // `payload: Schema.Struct({})` is a **passthrough**, measured as such: an object of any keys
            // arrives as it was written, and anything that is not one is refused (`empty.payloadNull`,
            // `empty.payloadAbsent`).
            Mode::Echo => match payload.as_ref() {
                Some(object @ Value::Object(_)) => echo(object),
                _ => refused(),
            },
            Mode::Extra => {
                // `success: Schema.Struct({})` is the same passthrough on the way out, so the handler's
                // own construction order survives: the one case in the group where an unknown key does.
                let mut out = Map::new();
                out.insert("extra".to_owned(), json!(1));
                if let Some(Value::Object(fields)) = payload.as_ref() {
                    for (key, value) in fields {
                        out.insert(key.clone(), value.clone());
                    }
                }
                Outcome::Success(Value::Object(out))
            }
            Mode::Stream => Outcome::Stream(vec![vec![json!(1), json!(2)]]),
            // `id.reuse`: the value the server did produce, 200ms late, and never got to write.
            Mode::Sleep => Outcome::Success(json!({"late": 1})),
            _ => Outcome::Success(Value::Null),
        })
        // Both of these return an object the deep success schema refuses, in every mode the oracle ran
        // them in, so the refusal is the whole answer and its text is the codec's (`deep.*`).
        .with(GET_CONFIG, Decl::Value, |_, _| {
            Outcome::Died(DECODER.to_owned())
        })
        .with(BACKGROUND, Decl::Value, |_, _| {
            Outcome::Died(DECODER.to_owned())
        })
        .with(
            ATTACHMENTS_DELETE,
            Decl::Void,
            move |payload, _| match mode {
                Mode::Echo => match decoded_attachment_id(payload) {
                    Ok(id) => echo(&json!({"attachmentId": id})),
                    Err(outcome) => outcome,
                },
                Mode::Stream => Outcome::Stream(vec![vec![json!(1)]]),
                // `void.defaultReturnsValue`: the defaulted `Schema.Void` given a real object to discard.
                Mode::Value => Outcome::Success(json!({"deleted": true})),
                _ => Outcome::Success(Value::Null),
            },
        )
        .with(VCS_INIT, Decl::Void, move |payload, _| match mode {
            Mode::Echo => match decoded_vcs_init(payload) {
                Ok(decoded) => echo(&decoded),
                Err(outcome) => outcome,
            },
            _ => Outcome::Success(Value::Null),
        })
        .with(INVALIDATE, Decl::Void, move |_, _| {
            // `void.explicitReturnsValue`: the spelled `Schema.Void`, given `{ok: 1}` to discard.
            Outcome::Success(json!({"ok": 1}))
        })
        .with(SUBSCRIBE_REFRESHES, Decl::Stream, move |_, _| match mode {
            Mode::Three => Outcome::Stream(vec![vec![json!(1), json!(2), json!(3)]]),
            Mode::Empty => Outcome::Stream(Vec::new()),
            Mode::Later => Outcome::Stream(vec![vec![json!(1)], vec![json!(2)]]),
            // The element fails the schema's own check, and no `Chunk` goes out to be refused.
            Mode::Negative => Outcome::Died(DECODER.to_owned()),
            // A handler returning an Effect where the declaration says stream: the encoder's `._tag`
            // read is of `undefined`, and the `TypeError` is the transport's (`stream.effectHandler`).
            Mode::Effect => Outcome::Success(json!(1)),
            // `mode === "fail"` is the fourth declared gap, and one batch is as far as it gets here.
            _ => Outcome::Stream(vec![vec![json!(1)]]),
        })
        .with(SUBSCRIBE_TERMINAL, Decl::Stream, move |_, _| match mode {
            Mode::BogusType | Mode::Scalar => Outcome::Died(DECODER.to_owned()),
            _ => Outcome::Stream(vec![vec![terminal_output()]]),
        })
}

/// The recorded answer for one case, as text.
fn expected(artifact: &Artifact, case: &str) -> Vec<String> {
    artifact
        .steps(case)
        .iter()
        .filter(|step| step.direction == "s2c")
        .map(|step| step.frame.clone())
        .collect()
}

#[test]
fn the_declarations_this_file_stubs_are_the_ones_the_shipped_group_makes() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("LMCS_GROUP_GOLDEN unset, skipping the group golden");
        return;
    };
    let mut stubbed = 0;
    for (key, tag, decl, has_handler) in DECLARED {
        let row = artifact
            .measured
            .get(key)
            .unwrap_or_else(|| panic!("the oracle measured no {key}"));
        assert_eq!(
            string(row, "tag"),
            tag,
            "{key}: this file spells the tag {tag:?}, the shipped rpc says {:?}",
            string(row, "tag")
        );
        let stream = row["stream"].as_bool().expect("stream is a bool");
        let void_success = row["voidSuccess"].as_bool().expect("voidSuccess is a bool");
        let want = if stream {
            Decl::Stream
        } else if void_success {
            Decl::Void
        } else {
            Decl::Value
        };
        assert_eq!(
            decl, want,
            "{key}: the stub declares {decl:?} for a rpc the artifact measured as {want:?}"
        );
        assert!(
            !row["voidPayload"].as_bool().expect("voidPayload is a bool"),
            "{key}: takes no payload, which no case in this artifact is built to answer"
        );
        stubbed += usize::from(has_handler);
    }
    assert_eq!(
        stubbed,
        artifact.summary["stubbed"]
            .as_i64()
            .expect("stubbed is a number") as usize,
        "the oracle gave handlers to a different number of tags than this group stubs"
    );
}

#[test]
fn the_declared_group_answers_as_the_declaration_says() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("LMCS_GROUP_GOLDEN unset, skipping the group golden");
        return;
    };
    // The census the oracle computed from the shipped group, which is what `native/contracts` claims and
    // what the `Decl`s above are keyed to.
    for (key, want) in [
        ("groupRequests", 148),
        ("streamed", 24),
        ("voidSuccess", 30),
        ("neverError", 24),
        ("voidPayload", 0),
    ] {
        assert_eq!(
            artifact.summary.get(key).and_then(Value::as_i64),
            Some(want),
            "the artifact's own {key} count moved, so the tables this replay leans on need re-measuring"
        );
    }
    assert_eq!(
        artifact.cases.len(),
        artifact.order.len(),
        "a case reached the wire without being declared, or one was declared and never ran"
    );

    let mut replayed = 0;
    let mut exempted = 0;
    let mut gaps = BTreeSet::new();
    for case in &artifact.cases {
        let steps = artifact.steps(&case.name);
        assert_eq!(
            steps.iter().filter(|step| step.direction == "note").count(),
            1,
            "{}: the recording closes once, and this loop's frames say nothing about the socket",
            case.name
        );
        let mode = Mode::of(&case.mode);
        if GAPS.contains(&case.name.as_str()) {
            gaps.insert(case.name.clone());
            // The one claim even a gap can carry: the input that the recording answered is an input this
            // loop keeps the connection for.
            let mut session = Session::new(group(mode));
            for step in steps.iter().filter(|step| step.direction == "c2s") {
                assert!(
                    !session.receive(&step.frame).closes(),
                    "{}: the port ended a connection the recording kept",
                    case.name
                );
            }
            continue;
        }
        let mut written = Vec::new();
        let mut streams = Vec::new();
        let mut session = Session::new(group(mode));
        for step in steps {
            match step.direction.as_str() {
                "c2s" => {
                    let reply = session.receive(&step.frame);
                    assert!(
                        !reply.closes(),
                        "{}: the port closed on {}, which the recording survived",
                        case.name,
                        step.frame
                    );
                    written.extend(reply.frames().iter().map(Message::encode));
                }
                "s2c" => {
                    if let Some(id) = chunk_id(&step.frame) {
                        streams.push(id);
                    }
                }
                _ => {}
            }
        }
        // A stream's terminal exit is the producer's frame, and a `Chunk` is the only thing in the
        // recording that names a producer, so the ids to close come from there.
        for id in &streams {
            written.extend(session.end(id).iter().map(Message::encode));
        }
        let want = expected(&artifact, &case.name);
        assert_eq!(
            want.len(),
            written.len(),
            "{}: wrote {} frames where the recording has {}\n recorded: {want:#?}\n      port: {written:#?}",
            case.name,
            written.len(),
            want.len()
        );
        for (index, (want, got)) in want.iter().zip(written.iter()).enumerate() {
            if exempt(&case.name, want, got) {
                exempted += 1;
                continue;
            }
            assert_eq!(want, got, "{} frame {index}", case.name);
            replayed += 1;
        }
    }
    assert_eq!(
        gaps.len(),
        GAPS.len(),
        "a declared gap is no longer in the artifact: {gaps:?}"
    );
    assert_eq!(
        exempted,
        // `deep.secondThought` is refused twice on one connection, so the frame count is not the case
        // count and both are worth pinning.
        CODEC_TEXT.len() + 1,
        "the codec exemption covered {exempted} frames, where the cases listed above need {}",
        CODEC_TEXT.len() + 1
    );
    eprintln!(
        "group_golden: {replayed} frames replayed byte-exact, {exempted} exempted for codec text, {} declared gaps",
        GAPS.len()
    );
}

/// The exemption, which is narrow on purpose: one frame, whose only difference is the string the
/// `SchemaIssue` default formatter wrote, and only for a case [`CODEC_TEXT`] names.
fn exempt(case: &str, want: &str, got: &str) -> bool {
    if !CODEC_TEXT.contains(&case) {
        return false;
    }
    let (Ok(want), Ok(got)) = (
        serde_json::from_str::<Value>(want),
        serde_json::from_str::<Value>(got),
    ) else {
        return false;
    };
    if got.pointer("/exit/cause/0/defect").and_then(Value::as_str) != Some(DECODER) {
        return false;
    }
    let Some(text) = want
        .pointer("/exit/cause/0/defect")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    assert!(
        !text.is_empty(),
        "{case}: the recording wrote an empty defect, which the port cannot be exempted for"
    );
    let mut want = want;
    want["exit"]["cause"][0]["defect"] = Value::from(DECODER);
    want == got
}

fn chunk_id(frame: &str) -> Option<Id> {
    let value: Value = serde_json::from_str(frame).ok()?;
    match Message::read(&value)? {
        Message::Chunk { request_id, .. } => Some(request_id),
        _ => None,
    }
}
