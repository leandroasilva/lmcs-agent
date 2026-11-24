//! The transport's golden: replay the captured socket, byte for byte.
//!
//! `LMCS_UPGRADE_GOLDEN=/path/to/upgrade-golden.json cargo test --test transport_golden`
//!
//! [`session_golden`](session_golden.rs) compares the *text* a connection writes. This file compares
//! the **bytes**: the handshake, the length field, RSV1, the close frame, and whether the socket then
//! FINed. It is the only place the four layers below are tested together, which is the point — a
//! connection is not a layer at a time.
//!
//! The capture is `apps/server/scripts/upgrade-golden.ts`, run against the shipped stack over a raw
//! `node:net` socket. Every input the port replays is in the artifact as something rebuildable (text,
//! hex, or a deflated blob) rather than as a digest, and every answer is compared as:
//!
//! - **exact bytes** when it was recorded uncompressed, header included, so a length field one byte off
//!   fails the run;
//! - **first byte plus content** when it was recorded with RSV1: the deflate stream is `ws`'s zlib and
//!   not this port's, so the claim is that the frame says *compressed text* and that this connection's
//!   own context inflates it back to the recorded text — which is what a browser needs;
//! - **header plus digest** for the handful of answers too large to inline (2 MiB of `"aaaa…"` in a
//!   golden is a file nobody reads), where the header already pins the payload length.
//!
//! **Nothing is skipped.** The five `headers.*` cases used to be, because their answer is the upgrade
//! request's own header list and this port's handler could not see it; `crate::headers` is that
//! context, and those cases are replayed like any other, with
//! `headers_answer_from_the_upgrade_request` keeping the claim readable on its own.
//!
//! A stream's terminal `Exit` is not something a replay can be told to produce: it belongs to the
//! producer. So the replay ends a stream **when the recording says its exit was written** — the same
//! reading `session_golden` uses, applied to a connection instead of a loop. `frame.streamDeflated`
//! is the case that keeps that honest: it recorded two chunks and no exit at all, so a replay that
//! ended its stream on principle would write a frame the capture never saw.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Read;

use base64::Engine;
use lmcs_protocol::deflate::{self, Inbound, Negotiated};
use lmcs_protocol::envelope::Id;
use lmcs_protocol::headers;
use lmcs_protocol::http::{self, Refusal, Request, Routed};
use lmcs_protocol::session::{Group, Outcome, Payload, Session};
use lmcs_protocol::transport::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The cases whose answer is the header list the transport injects, which is what `crate::headers`
/// exists for and what `headers_answer_from_the_upgrade_request` asserts pair by pair.
const HEADERS_CASES: [&str; 5] = [
    "headers.injected",
    "headers.repeated",
    "headers.ordered",
    "headers.setCookie",
    "headers.twice",
];

/// The route the shipped server mounts the websocket handler on, which decides whether the router or
/// `ws` answers a request.
const ROUTE: &str = "/ws";

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/// The capture, as far as this file reads it: frames grouped by case in the order they crossed, and the
/// handshake each case performed.
struct Artifact {
    cases: Vec<(String, Vec<Value>)>,
    handshakes: Vec<Value>,
    by_case: BTreeMap<String, Value>,
    frames_of_case: BTreeMap<String, Vec<Value>>,
    summary: Value,
    /// `case` → `fin` | `open`, from `summary.tcp`: the capture's own record of what the peer did to the
    /// socket once a close had been written.
    tcp: BTreeMap<String, String>,
}

impl Artifact {
    fn load() -> Option<Self> {
        let path = env::var_os("LMCS_UPGRADE_GOLDEN")?;
        let document: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("the upgrade golden is readable"),
        )
        .expect("the upgrade golden is JSON");
        let mut order: Vec<String> = Vec::new();
        let mut frames_of_case: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for frame in document["frames"]
            .as_array()
            .expect("a frames array")
            .iter()
        {
            let case = text(frame, "case");
            if !frames_of_case.contains_key(&case) {
                order.push(case.clone());
            }
            frames_of_case.entry(case).or_default().push(frame.clone());
        }
        let mut handshakes = Vec::new();
        let mut by_case = BTreeMap::new();
        for event in document["events"]
            .as_array()
            .expect("an events array")
            .iter()
        {
            // Only the two handshake events carry a request; `peer`, `probe` and `observe` are about TCP
            // and are read through `summary.tcp` instead.
            if !matches!(text(event, "event").as_str(), "upgrade" | "response") {
                continue;
            }
            assert!(
                event.get("request").is_some(),
                "{}: a handshake with no recorded request is an input this file cannot replay",
                text(event, "case"),
            );
            by_case.insert(text(event, "case"), event.clone());
            handshakes.push(event.clone());
        }
        let tcp = document["summary"]["tcp"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .filter_map(|row| row.split_once('='))
                    .map(|(case, end)| (case.to_owned(), end.to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let cases = order
            .into_iter()
            .map(|case| {
                let frames = frames_of_case[&case].clone();
                (case, frames)
            })
            .collect();
        Some(Self {
            cases,
            handshakes,
            by_case,
            frames_of_case,
            summary: document["summary"].clone(),
            tcp,
        })
    }

    fn frames(&self, case: &str) -> &[Value] {
        self.frames_of_case
            .get(case)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// The upgrade request's header list, read out of **this case's own** recorded request head — the
    /// same bytes the handshake claim compares, from the other side.
    fn socket_headers(&self, case: &str) -> Vec<headers::Pair> {
        let head = text(
            self.by_case
                .get(case)
                .unwrap_or_else(|| panic!("{case}: no recorded handshake")),
            "request",
        );
        Request::parse(&head).handler_headers()
    }

    /// What this case's socket negotiated, read from the offer in **its own** recorded request.
    fn negotiated(&self, case: &str) -> Option<Negotiated> {
        let head = text(self.by_case.get(case)?, "request");
        let offer = Request::parse(&head).extensions.unwrap_or_default();
        match deflate::negotiate(offer) {
            Ok(agreed) => agreed,
            Err(refusal) => panic!("{case}: a case with frames refused its own offer: {refusal:?}"),
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn count(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "hex of odd length: {text:?}");
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex characters"))
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The deflated form of a large input, which the capture stores base64'd so the artifact stays a file
/// one can read.
fn unshrink(recorded: &str) -> Vec<u8> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(recorded)
        .expect("a zlib blob is base64");
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(&bytes[..])
        .read_to_end(&mut out)
        .expect("the capture's own blob inflates");
    out
}

/// The body the capture saw for a frame **the client wrote**, unmasked, in whichever of five forms the
/// record kept it.
fn sent_body(record: &Value) -> Vec<u8> {
    if let Some(payload) = record.get("payload").and_then(Value::as_str) {
        return payload.as_bytes().to_vec();
    }
    for key in ["payloadHex", "wireHex", "closeHex"] {
        if let Some(hexed) = optional(record, key) {
            return hex(&hexed);
        }
    }
    if let Some(blob) = optional(record, "payloadZlib") {
        return unshrink(&blob);
    }
    assert_eq!(
        count(record, "payloadBytes"),
        0,
        "a frame with no recorded body carried something: {record:?}",
    );
    Vec::new()
}

/// The frame as it went on the socket, mask and all.
fn wire(record: &Value) -> Vec<u8> {
    let header = hex(&text(record, "headerHex"));
    let mut body = sent_body(record);
    if flag(record, "masked") {
        // The mask key is the tail of `headerHex`, which is how the capture says which key it sent.
        let (_, key) = header.split_at(header.len() - 4);
        for (index, byte) in body.iter_mut().enumerate() {
            *byte ^= key[index % 4];
        }
    }
    let mut out = header;
    out.extend(body);
    out
}

/// The header length of a frame **the server wrote**, which is never masked.
fn head_len(frame: &[u8]) -> usize {
    match frame.get(1).map(|byte| byte & 0x7f) {
        Some(126) => 4,
        Some(127) => 10,
        _ => 2,
    }
}

/// The recorded handshake answer as bytes: the status line, the headers in the order they were written,
/// and the body. `Date` arrives as the capture's own placeholder, which is also what this port is handed
/// to write, so the comparison stays byte-exact.
fn recorded_head(event: &Value) -> Vec<u8> {
    assert!(
        event.get("detail").and_then(Value::as_str).is_none(),
        "{}: the capture never finished reading this head",
        text(event, "case"),
    );
    let mut out = format!("{}\r\n", text(event, "statusLine")).into_bytes();
    for header in event["headers"].as_array().expect("a headers array") {
        let pair = header.as_array().expect("a header pair");
        out.extend(
            format!(
                "{}: {}\r\n",
                pair[0].as_str().expect("a header name"),
                pair[1].as_str().expect("a header value"),
            )
            .into_bytes(),
        );
    }
    out.extend(b"\r\n");
    if let Some(body) = optional(event, "body") {
        out.extend(body.into_bytes());
    }
    out
}

/// The port's own answer to a handshake request, from its bytes alone — the router, `ws`, or the
/// extension offer, in that order of precedence.
fn answered(request: &str) -> Vec<u8> {
    let parsed = Request::parse(request);
    let target = request.split(' ').nth(1).unwrap_or_default();
    if parsed.method != "GET" || target.split('?').next().unwrap_or_default() != ROUTE {
        return http::routed("__DATE__", Routed::NoRoute);
    }
    if !parsed.is_upgrade() {
        return http::routed("__DATE__", Routed::NotUpgrade);
    }
    if let Some(refusal) = parsed.refusal() {
        return http::refuse(refusal);
    }
    let protocol = parsed.protocol;
    let key = parsed.key.unwrap_or_default();
    match deflate::negotiate(parsed.extensions.unwrap_or_default()) {
        Err(_) => http::refuse(Refusal::Extensions),
        Ok(None) => http::upgrade(key, protocol, None),
        Ok(Some(agreed)) => http::upgrade(key, protocol, Some(&agreed.answer)),
    }
}

// ---------------------------------------------------------------------------
// The group the capture was made against
// ---------------------------------------------------------------------------

/// The synthetic group `upgrade-golden.ts` registers: `plain` answers `{}`, `size` echoes its payload,
/// `stream` writes the two chunks the recording shows, and `seenHeaders` echoes the header list the
/// transport handed it. The answer *shapes* come from the recorded frames; the loop semantics they
/// travel through are already pinned by `session_golden`.
fn group() -> Group {
    Group::new()
        .returns("plain", Value::Object(serde_json::Map::new()))
        .on("size", |payload, _| Outcome::Success(payload_of(payload)))
        .on("stream", |payload, _| {
            Outcome::Stream(vec![
                vec![serde_json::json!({"s": "first"})],
                vec![payload_of(payload)],
            ])
        })
        .on("seenHeaders", |_, seen| echo(seen))
}

/// Both of the capture's echoing rpcs answer with the payload they were given.
fn payload_of(payload: &Payload) -> Value {
    payload.clone().unwrap_or(Value::Null)
}

/// The `seenHeaders` rpc of `upgrade-golden.ts`: `Object.entries(options.headers)`, which is this
/// port's [`headers::seen_by_handler`] read in order.
///
/// One part of the answer is **not** this port's claim. `set-cookie` reaches a handler as a list and
/// the rpc's success schema (`Schema.Tuple([Schema.String, Schema.String])`) refuses it — the shipped
/// server answered that as a request `Die` and kept the socket (`headers.setCookie`). The sentence is
/// the contracts layer's `SchemaIssue` formatting, so this file writes it from the **index the port
/// handed over**: what is under test is that a non-string arrives at `pairs[5][1]`, not what the
/// message reads.
fn echo(seen: &[headers::Pair]) -> Outcome {
    let mut pairs = Vec::with_capacity(seen.len());
    for (index, (name, value)) in seen.iter().enumerate() {
        let Some(text) = value.as_text() else {
            return Outcome::Died(format!(
                "Expected string\n  at [\"value\"][\"pairs\"][{index}][1]",
            ));
        };
        pairs.push(Value::from(vec![
            Value::from(name.clone()),
            Value::from(text.to_owned()),
        ]));
    }
    Outcome::Success(serde_json::json!({ "pairs": pairs }))
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/// What replaying one case produced.
#[derive(Default)]
struct Replay {
    /// Answers compared, in the order they were recorded.
    compared: usize,
    /// Of those, how many the capture wrote with RSV1.
    deflated: usize,
    /// Whether the port FINed, which is the second half of the two-endings claim.
    hang_up: bool,
}

/// Feed one case's recorded inputs to a fresh connection and compare every frame it answers with.
fn replay(artifact: &Artifact, case: &str) -> Replay {
    let agreed = artifact.negotiated(case);
    let mut socket = Connection::new(
        Session::upgraded(group(), artifact.socket_headers(case)),
        agreed.clone(),
    );
    // Reading our own answers back is the only way to compare a compressed frame's content, and it is
    // the context the client would have: one stream, in answer order.
    let mut reader = agreed.as_ref().map(Inbound::new);
    let mut queued: Vec<Vec<u8>> = Vec::new();
    // Streams this connection has started and not yet seen end, by the id the client wrote.
    let mut streams: Vec<Value> = Vec::new();
    let mut out = Replay::default();

    for record in artifact.frames(case) {
        if text(record, "direction") == "c2s" {
            let written = socket.push(&wire(record));
            out.hang_up |= written.hang_up;
            queued.extend(written.frames);
            continue;
        }
        // The recording says the producer ended here, so this replay ends it here.
        if let Some(request_id) = ended_stream(&streams, record) {
            let written = socket.end(&Id::read(Some(&request_id)));
            out.hang_up |= written.hang_up;
            queued.extend(written.frames);
            streams.retain(|live| *live != request_id);
        }
        let got = queued
            .first()
            .cloned()
            .unwrap_or_else(|| panic!("{case}: wrote nothing where the capture had a frame"));
        queued.remove(0);
        compare(case, out.compared, record, &got, reader.as_mut());
        if let Some(request_id) = chunk_id(record) {
            streams.push(request_id);
        }
        out.compared += 1;
        if flag(record, "rsv1") {
            out.deflated += 1;
        }
    }
    assert!(
        queued.is_empty(),
        "{case}: the port wrote {} frame(s) the capture never saw: {queued:?}",
        queued.len(),
    );
    out
}

/// The recorded answer's text, where the capture kept it as text.
fn recorded_text(record: &Value) -> Option<String> {
    optional(record, "payload").or_else(|| optional(record, "inflated"))
}

/// The recorded frame parsed as an envelope, for the two questions a replay has to ask it: is this a
/// `Chunk`, so a stream is running, and is this an `Exit` for one that still is. A frame recorded only
/// as a digest cannot answer either, and never is a stream's exit — those are all small.
fn recorded_envelope(record: &Value) -> Option<Value> {
    recorded_text(record).and_then(|text| serde_json::from_str(&text).ok())
}

fn chunk_id(record: &Value) -> Option<Value> {
    let envelope = recorded_envelope(record)?;
    (envelope["_tag"].as_str() == Some("Chunk")).then(|| envelope["requestId"].clone())
}

fn ended_stream(streams: &[Value], record: &Value) -> Option<Value> {
    let envelope = recorded_envelope(record)?;
    if envelope["_tag"].as_str() != Some("Exit") {
        return None;
    }
    let request_id = envelope["requestId"].clone();
    streams.contains(&request_id).then_some(request_id)
}

/// One answer, compared against the frame the port wrote for it.
fn compare(case: &str, index: usize, record: &Value, got: &[u8], reader: Option<&mut Inbound>) {
    let header = hex(&text(record, "headerHex"));
    if flag(record, "rsv1") {
        // The deflate stream is `ws`'s zlib and not this port's, so the frame is compared on what it
        // *says* — fin, RSV1, opcode — and on what the body inflates to through this connection's own
        // context, which is the claim a browser actually depends on.
        assert_eq!(got[0], header[0], "{case} #{index}: wrong head flags");
        let Some(reader) = reader else {
            panic!("{case} #{index}: an RSV1 answer on a connection that never negotiated deflate");
        };
        let plain = reader
            .inflate(&got[head_len(got)..], flag(record, "fin"))
            .expect("the port's own answer inflates");
        match recorded_text(record) {
            Some(text) => assert_eq!(
                String::from_utf8_lossy(&plain),
                text,
                "{case} #{index}: a deflated answer that does not inflate to the recorded text",
            ),
            None => assert_eq!(
                sha256(&plain),
                text(record, "inflatedSha"),
                "{case} #{index}: a deflated answer that does not inflate to the recorded digest",
            ),
        }
        return;
    }
    assert!(
        flag(record, "fin") && !flag(record, "masked"),
        "{case} #{index}: a server answer this file has no rule for",
    );
    // Uncompressed: the whole frame is the claim, head first because `817d` and `817e007e` are different
    // answers to the same request.
    assert_eq!(
        &got[..header.len()],
        &header[..],
        "{case} #{index}: wrote {} where the capture recorded {show}",
        show(&got[..header.len()]),
        show = text(record, "headerHex"),
    );
    let body = &got[header.len()..];
    match recorded_answer_body(record) {
        Some(want) => assert_eq!(
            body,
            &want[..],
            "{case} #{index}: {}",
            String::from_utf8_lossy(body),
        ),
        None => {
            assert_eq!(
                body.len(),
                count(record, "payloadBytes") as usize,
                "{case} #{index}: wrote a body of a different size than the digest was taken over",
            );
            assert_eq!(
                sha256(body),
                text(record, "payloadSha"),
                "{case} #{index}: {}",
                String::from_utf8_lossy(&body[..body.len().min(160)]),
            );
        }
    }
}

/// The recorded answer's bytes, where the capture kept them.
fn recorded_answer_body(record: &Value) -> Option<Vec<u8>> {
    if let Some(payload) = record.get("payload").and_then(Value::as_str) {
        return Some(payload.as_bytes().to_vec());
    }
    optional(record, "closeHex").map(|hexed| hex(&hexed))
}

fn show(frame: &[u8]) -> String {
    frame
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

/// Ninety-three handshakes, byte for byte: the `101` and its header order, the four sentences `ws`
/// writes itself, and the three the router writes.
#[test]
fn every_recorded_handshake_is_the_ports_own_bytes() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("skipping transport golden: set LMCS_UPGRADE_GOLDEN");
        return;
    };
    assert_eq!(
        artifact.handshakes.len(),
        usize::try_from(
            count(&artifact.summary, "upgrades") + count(&artifact.summary, "responses")
        )
        .unwrap(),
        "every handshake the capture performed, and the summary still counts the same",
    );
    let mut upgraded = 0;
    let mut refused = 0;
    for event in &artifact.handshakes {
        let case = text(event, "case");
        assert_eq!(
            answered(&text(event, "request")),
            recorded_head(event),
            "{case}: the handshake this port writes is not the one on the wire",
        );
        if text(event, "event") == "upgrade" {
            upgraded += 1;
        } else {
            refused += 1;
        }
    }
    assert_eq!(
        (upgraded, refused),
        (85, 8),
        "and the split the capture recorded"
    );
}

/// The headline claim: every frame the shipped server wrote, this connection writes too.
#[test]
fn every_recorded_answer_is_the_ports_own_bytes() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("skipping transport golden: set LMCS_UPGRADE_GOLDEN");
        return;
    };
    let mut compared = 0;
    let mut deflated = 0;
    for (case, _) in &artifact.cases {
        let run = replay(&artifact, case);
        compared += run.compared;
        deflated += run.deflated;
    }
    assert_eq!(
        compared,
        usize::try_from(count(&artifact.summary, "serverToClient")).unwrap(),
        "one frame compared per recorded answer, with nothing skipped",
    );
    assert_eq!(
        deflated,
        usize::try_from(count(&artifact.summary, "rsv1Used")).unwrap(),
        "and every compressed answer came from a connection that agreed to compress",
    );
}

/// The two endings are different, and only the capture can say which is which: a protocol teardown
/// leaves the socket open, a close and every fault FINs it.
#[test]
fn a_teardown_leaves_the_socket_open_and_every_other_ending_finishes_it() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("skipping transport golden: set LMCS_UPGRADE_GOLDEN");
        return;
    };
    let mut fins = 0;
    let mut opens = 0;
    for (case, _) in &artifact.cases {
        let hung_up = replay(&artifact, case).hang_up;
        match artifact.tcp.get(case).map(String::as_str) {
            Some("fin") => {
                assert!(
                    hung_up,
                    "{case}: the capture was FINed by a connection this port kept open"
                );
                fins += 1;
            }
            Some("open") => {
                assert!(
                    !hung_up,
                    "{case}: the capture stayed open and this port hung up"
                );
                opens += 1;
            }
            Some(other) => panic!("{case}: a tcp ending this file does not know: {other:?}"),
            // The table is exhaustive on purpose: nothing else in the exchange ends a connection.
            None => assert!(!hung_up, "{case}: hung up on a connection the capture kept"),
        }
    }
    assert_eq!(
        (fins, opens),
        (
            artifact.tcp.values().filter(|end| **end == "fin").count(),
            artifact.tcp.values().filter(|end| **end == "open").count(),
        ),
        "and the capture's table still splits that way",
    );
    assert_eq!(artifact.tcp.len(), 38, "with all of its rows");
}

/// The injected list, pair by pair, for the five cases whose answer is nothing else.
///
/// The replay already compares these as bytes; this says *which* pair moved when it fails, and it
/// checks the port's own two steps (`from_lines` then `seen_by_handler`) against the recording rather
/// than against a description — including the two shapes Node gives a repeated line: `", "` for
/// everything but `set-cookie`, which stays a list and then a request defect.
#[test]
fn headers_answer_from_the_upgrade_request() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("skipping transport golden: set LMCS_UPGRADE_GOLDEN");
        return;
    };
    for case in HEADERS_CASES {
        let socket = artifact.socket_headers(case);
        let frame = artifact
            .frames(case)
            .iter()
            .filter(|record| text(record, "direction") == "c2s")
            .map(|record| {
                let envelope: Value =
                    serde_json::from_slice(&sent_body(record)).expect("a recorded request");
                envelope["headers"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| {
                                (
                                    item[0].as_str().expect("a header name").to_owned(),
                                    item[1].as_str().expect("a header value").to_owned(),
                                )
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        let answers = artifact
            .frames(case)
            .iter()
            .filter(|record| text(record, "direction") == "s2c")
            .map(|record| {
                let envelope: Value =
                    serde_json::from_str(&recorded_text(record).expect("a text answer"))
                        .expect("an Exit");
                envelope["exit"].clone()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            frame.len(),
            answers.len(),
            "{case}: one answer per request the case wrote",
        );
        for (index, own) in frame.iter().enumerate() {
            let seen = headers::seen_by_handler(&socket, own);
            let exit = &answers[index];
            match exit["_tag"].as_str() {
                // The list this port hands over, read as the handler's `Object.entries` would.
                Some("Success") => assert_eq!(
                    echoed(&seen),
                    exit["value"]["pairs"],
                    "{case} #{index}: the list this port hands a handler is not the one the capture answered",
                ),
                // A `Die` is the rpc's schema refusing a **list** value. The claim that belongs to
                // this port is where that value sits: the index the shipped server named in its
                // defect is the position of the only non-string in the list it was handed.
                Some("Failure") => {
                    let defect = exit["cause"][0]["defect"].as_str().expect("a defect");
                    let named = defect
                        .rsplit("pairs\"][")
                        .next()
                        .and_then(|tail| {
                            let digits: String =
                                tail.chars().take_while(char::is_ascii_digit).collect();
                            digits.parse::<usize>().ok()
                        })
                        .unwrap_or_else(|| {
                            panic!("{case}: a defect this file cannot read: {defect:?}")
                        });
                    let untexted = seen
                        .iter()
                        .enumerate()
                        .filter(|(_, (_, value))| value.as_text().is_none())
                        .map(|(position, _)| position)
                        .collect::<Vec<_>>();
                    assert_eq!(
                        untexted,
                        vec![named],
                        "{case}: the non-string header this port produced is not at the index the capture failed on",
                    );
                }
                other => panic!(
                    "{case} #{index}: an answer that is neither Success nor Failure: {other:?}"
                ),
            }
        }
    }
}

/// The `pairs` value `echo` builds, without running it through the `Die` branch.
fn echoed(seen: &[headers::Pair]) -> Value {
    Value::Array(
        seen.iter()
            .filter_map(|(name, value)| {
                value.as_text().map(|text| {
                    Value::from(vec![
                        Value::from(name.clone()),
                        Value::from(text.to_owned()),
                    ])
                })
            })
            .collect(),
    )
}

/// The capture still has the shapes this file's comparisons assume, so a shrinking artifact fails here
/// rather than by the replay quietly having less to say.
#[test]
fn the_capture_still_carries_every_shape_this_file_replays() {
    let Some(artifact) = Artifact::load() else {
        eprintln!("skipping transport golden: set LMCS_UPGRADE_GOLDEN");
        return;
    };
    let sent: Vec<&Value> = artifact
        .frames_of_case
        .values()
        .flatten()
        .filter(|record| text(record, "direction") == "c2s")
        .collect();
    assert_eq!(
        sent.len(),
        usize::try_from(count(&artifact.summary, "clientToServer")).unwrap(),
    );
    // Every sent frame is rebuildable, which is what `wire` needs and what the oracle now asserts too.
    for record in &sent {
        assert!(
            !sent_body(record).is_empty() || count(record, "payloadBytes") == 0,
            "{}: a sent frame whose recorded body is smaller than its {} payload bytes",
            text(record, "case"),
            count(record, "payloadBytes"),
        );
    }
    let fields = &artifact.summary["lengthFields"];
    assert_eq!(
        (
            count(fields, "bit7"),
            count(fields, "bit16"),
            count(fields, "bit64")
        ),
        (73, 10, 2),
        "all three length encodings are still on the wire, so the byte comparison above still covers them",
    );
    assert_eq!(artifact.cases.len(), 78, "and every case still has frames");
}
