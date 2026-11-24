//! One connection's protocol loop: the switch the shipped server runs over every frame.
//!
//! This is `RpcServer.ts:764-820` and the pieces it calls, ported as a **pure transform** — a text
//! frame goes in, the answers come out, no socket, no clock, no schema. Keeping it that way is what
//! lets `tests/session_golden.rs` replay the recorded wire scenario by scenario: the artifact holds
//! both the input a scenario sent and the frames the shipped server wrote, so the loop can be
//! checked against the server itself rather than against a description of it.
//!
//! Three shapes the port has to hold apart, each of them measured rather than inferred:
//!
//! - **Two carriers for one string.** A defect that belongs to a request answers as
//!   `Exit`/`Failure`/`Die` with a `requestId`; a defect that belongs to the *connection* answers as
//!   a broadcast `Defect` with none. `a.typedFail` and `b.payloadWrongType` take the first road,
//!   `a.handlerDieNoErrorSchema` and every refusal the switch makes take the second, and
//!   `b.broadcastWithInFlight` shows the broadcast does **not** interrupt the requests already in
//!   flight — they answer normally afterwards.
//! - **Three inputs end the connection**: a `null` document (the only JSON value whose `._tag` read
//!   throws), and a `Request` whose `headers` the transport cannot read. Both are [`Reply::Close`], and
//!   the wire says what that costs: the server writes a **zero-body close frame** (`8800`), which is why
//!   a browser reports code `1005` and `wasClean: true`, and then leaves TCP open until the peer's own
//!   close arrives (`upgrade-golden.ts`, `teardown.*`). Frames a batch produced before the teardown are
//!   written ahead of it.
//! - **A stream is not one answer.** `stream: true` writes a `Chunk` per batch and waits for the
//!   client's `Ack` before the next, so the ack is part of the loop's state rather than an optional
//!   acknowledgement. The terminal `Void` exit belongs to whoever ran the handler ([`Session::end`]),
//!   not to the ack: `a.streamBatched` and `a.streamSplit` show the exit after the last ack, while
//!   `a.streamInterrupted` shows the same three-value stream answering an `Interrupt` with
//!   `Failure`/`Interrupt` and never writing the exit at all.

use serde_json::{Number, Value};
use std::collections::BTreeMap;

use crate::envelope::{Cause, Defect, Exit, Id, Message};
use crate::frame::{Envelope, Frame, invalid_request_id, unknown_request_tag};
use crate::headers::Pair;
use crate::json::Syntax;

/// The payload hole of a request, as the rpc's own decoder sees it: `None` is a frame with no
/// `payload` key, which is a different input from `payload:null`.
pub type Payload = Option<Value>;

/// What running one rpc produced, already in the shape the wire writes. The schemas are what turn a
/// handler's return value into these holes; that step is the contracts layer's, and this loop only
/// ever moves the hole it was given.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// The success hole of `Exit`/`Success`. `Value::Null` is `Schema.Void` and `{}` is
    /// `Schema.Struct({})`; nothing here can tell them apart, which is the point.
    Success(Value),
    /// A declared error, in its wire shape (`{_tag, …}`), as `Exit`/`Failure`/`Fail`.
    Typed(Value),
    /// A defect inside the request: `Exit`/`Failure`/`Die`.
    Died(String),
    /// A defect outside every request: the broadcast `Defect`, with no `requestId` to answer to.
    Broadcast(String),
    /// `stream: true`: one `Chunk` per batch, the next batch released by the client's `Ack`, then the
    /// `Void` exit. An empty outer list is a stream that ends without ever writing a `Chunk`.
    Stream(Vec<Vec<Value>>),
}

/// The handler registered for one tag. A real server's handler decodes the payload and runs effects;
/// this loop only needs the answer it produces, so a handler is a function from the payload hole and
/// the headers the transport handed it to an [`Outcome`] and nothing else.
///
/// The second argument is the `options.headers` of `RpcServer.ts`'s request, already through both
/// steps [`crate::headers`] describes — the upgrade request's pairs prepended, then folded into a
/// record. A handler that never reads a header ignores it; one that echoes them is answering from the
/// socket rather than from the frame, which is what `headers.*` measured.
pub type Handler = Box<dyn Fn(&Payload, &[Pair]) -> Outcome>;

/// The group lookup, `group.requests.get(request.tag)` (`RpcServer.ts:779`). A tag that is not here
/// is answered per request with `Unknown request tag: <tag>`, which is what makes an unknown tag a
/// *request* failure while an unknown `_tag` is a *connection* one.
#[derive(Default)]
pub struct Group {
    handlers: BTreeMap<String, Handler>,
}

impl Group {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn on(
        mut self,
        tag: &str,
        handler: impl Fn(&Payload, &[Pair]) -> Outcome + 'static,
    ) -> Self {
        self.handlers.insert(tag.to_owned(), Box::new(handler));
        self
    }

    #[must_use]
    pub fn returns(self, tag: &str, value: Value) -> Self {
        self.on(tag, move |_, _| Outcome::Success(value.clone()))
    }

    #[must_use]
    pub fn streams(self, tag: &str, batches: Vec<Vec<Value>>) -> Self {
        self.on(tag, move |_, _| Outcome::Stream(batches.clone()))
    }

    fn lookup(&self, tag: &str) -> Option<&Handler> {
        self.handlers.get(tag)
    }
}

/// What one input frame cost the connection.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// The frames the server writes, in order. Empty is a real answer: `[]`, an `Eof`, and an `Ack`
    /// or `Interrupt` for an id nothing is waiting on all write nothing and keep the connection.
    Frames(Vec<Message>),
    /// The connection ends, **after** `written` goes out. `ws` writes that as a zero-body close frame
    /// (`8800`), which is why the browser recorded code `1005` and `wasClean: true`.
    Close { written: Vec<Message> },
}

impl Reply {
    /// Every frame this reply has the server write, close or not. A batch that reaches a teardown still
    /// flushes what its earlier elements produced (`c.batchTwoThenNull`).
    #[must_use]
    pub fn frames(&self) -> &[Message] {
        match self {
            Self::Frames(messages) | Self::Close { written: messages } => messages,
        }
    }

    #[must_use]
    pub fn closes(&self) -> bool {
        matches!(self, Self::Close { .. })
    }
}

/// One connection: the group it serves and the streams waiting on an `Ack`.
pub struct Session {
    group: Group,
    /// The upgrade request's headers, which this connection prepends to every `Request` frame before
    /// its handler runs (`RpcServer.ts:1554`). Empty is not a placeholder: it is what a session driven
    /// straight from text frames — `tests/session_golden.rs`, and the HTTP rpc path, where the request
    /// has no socket of its own — hands a handler.
    socket: Vec<Pair>,
    /// Keyed by the id as the client wrote it, because `requestId` echoes the id's **type** and two
    /// clients can number the same request differently (`7` and `"7"` are not the same key).
    pending: BTreeMap<String, Pending>,
    /// The scope gate `ws.ts:605-618` puts in front of every handler. `None` is the loop this crate's
    /// other goldens replayed — a server with no table in front of it, which is not what `ws.ts` is but is
    /// what a measurement of the envelope needs.
    gate: Option<Gate>,
    /// Set by the throw the table cannot answer. `scope-golden.ts` measured the consequence: the broadcast
    /// `Defect` went out, the socket stayed open, and the request that followed it was never answered.
    deaf: bool,
}

/// The gate as a connection holds it: what the credential covers, plus the one method whose scope is a
/// function of its payload rather than of its tag.
pub struct Gate {
    scopes: Vec<String>,
}

impl Gate {
    /// `scopes` is `EnvironmentAuth.AuthenticatedSession.scopes`, i.e. what the ticket's row carried, in
    /// the row's order. The order is irrelevant to the decision ([`crate::scopes::grants`] scans) and is
    /// kept because the credential is what a log line has to name.
    #[must_use]
    pub fn new(scopes: Vec<String>) -> Self {
        Self { scopes }
    }

    /// The decision for one request. `device.list` is spelled here because it is the only tag whose
    /// required scope is read out of the payload (`ws.ts:3513-3529`) — a server that registered that rule
    /// per handler would be able to forget it, and the shipped one cannot.
    #[must_use]
    pub fn decide(&self, tag: &str, payload: &Payload) -> crate::scopes::Decision {
        if tag == DEVICE_LIST {
            return crate::scopes::authorize_device_list(
                &self.scopes,
                inspect_only(payload),
                text(payload, "retryHostId"),
                text(payload, "updateTool"),
            );
        }
        crate::scopes::authorize(&self.scopes, tag)
    }
}

const DEVICE_LIST: &str = "device.list";

/// `input.inspectOnly`, read the way its declaration lets it arrive: `RpcAuthorization.ts:190`'s test is
/// JavaScript truthiness, but the rpc declares `Schema.optional(Schema.Boolean)`, so `null` and a missing
/// member are the only falsy values the shipped gate can see and `true` is the only truthy one. A client
/// that wrote `inspectOnly: 7` fails that schema before `ws.ts:3513` runs, which is why nothing wider is
/// modelled here: the wider the read, the more the port would be deciding what an unreachable input means.
fn inspect_only(payload: &Payload) -> bool {
    matches!(
        payload.as_ref().and_then(|value| value.get("inspectOnly")),
        Some(Value::Bool(true))
    )
}

/// A member read as the string its schema declares, i.e. only a JSON string is one. `retryHostId: ""` **is**
/// a string, and the emptiness rule belongs to [`crate::scopes::required_scope_for_device_list`], which is
/// where the shipped truthiness lives.
fn text<'a>(payload: &'a Payload, key: &str) -> Option<&'a str> {
    payload
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
}

struct Pending {
    request_id: Id,
    batches: Vec<Vec<Value>>,
    /// The next batch to write, or `batches.len()` once every value has gone out and only the
    /// terminal exit is left.
    index: usize,
}

/// `2^53-1`, the fiber id the shipped server writes for an interrupted stream
/// (`a.streamInterrupted`). Effect spells an unknown fiber with its own `FiberId.none`, and the
/// number is the largest safe integer JavaScript can hold.
const FIBER_NONE: i64 = 9_007_199_254_740_991;

impl Session {
    #[must_use]
    pub fn new(group: Group) -> Self {
        Self {
            group,
            socket: Vec::new(),
            pending: BTreeMap::new(),
            gate: None,
            deaf: false,
        }
    }

    /// The same loop over a connection that finished a handshake, which is the only difference a
    /// handler can see: the pairs [`crate::http::Request::handler_headers`] read out of the upgrade.
    #[must_use]
    pub fn upgraded(group: Group, socket: Vec<Pair>) -> Self {
        Self {
            group,
            socket,
            pending: BTreeMap::new(),
            gate: None,
            deaf: false,
        }
    }

    /// The same connection with the scope gate in front of it, which is what `ws.ts` serves: the ticket
    /// decided the session, the session's scopes decide whether a handler runs at all.
    #[must_use]
    pub fn gated(group: Group, socket: Vec<Pair>, gate: Gate) -> Self {
        Self {
            gate: Some(gate),
            ..Self::upgraded(group, socket)
        }
    }

    /// One WebSocket text frame in, the server's answer out.
    pub fn receive(&mut self, text: &str) -> Reply {
        if self.deaf {
            // Measured, not inferred: `scope-golden.ts` wrote a granted request after a method the table
            // does not cover and got nothing back, on a socket that had not closed. The shipped server is
            // in the same bind — its dispatch loop died with the throw — so the port stays silent too.
            return Reply::Frames(Vec::new());
        }
        let mut out = Vec::new();
        match Frame::decode(text) {
            Frame::Refused(syntax) => {
                out.push(defect(Defect::from(&syntax)));
            }
            Frame::Batch(items) => {
                for item in items {
                    if self.route(&item, &mut out) {
                        return Reply::Close { written: out };
                    }
                }
            }
        }
        Reply::Frames(out)
    }

    /// Has the connection met the throw it cannot answer past? `scope-golden.ts` measured the answer to
    /// that question rather than assuming it: it wrote a granted request after each refusal and counted
    /// the replies, so survival is a column of the artifact (`counts[*].answered`) and a replay can
    /// compare against it instead of restating which branches are fatal.
    #[must_use]
    pub const fn deafened(&self) -> bool {
        self.deaf
    }

    /// Routes one envelope of a batch. The `bool` is [`Reply::Close`]: the batch stops there, because
    /// the throw happens in the transport's own loop and the rest of the batch is never read. What the
    /// earlier elements already produced **does** go out first — `batch.twoThenNull` on the wire wrote
    /// the request's `Exit` and then the `8800`, which is only possible if the frames are flushed.
    fn route(&mut self, envelope: &Envelope, out: &mut Vec<Message>) -> bool {
        let message = match envelope {
            Envelope::Teardown => return true,
            Envelope::Other { tag } => {
                out.push(unknown(tag));
                return false;
            }
            Envelope::Message(message) => message,
        };
        match message {
            Message::Request(request) => return self.request(request, out),
            Message::Ping => out.push(Message::Pong),
            Message::Ack { request_id } => self.ack(request_id, out),
            Message::Interrupt { request_id } => self.interrupt(request_id, out),
            // Routed, forwarded to a handler that has nothing to do with it, and answered with no
            // frame at all — measured as `b.eofFromClient`.
            Message::Eof => {}
            // A client writing a server envelope: `Chunk`, `Exit`, `Defect`, `Pong`.
            other => out.push(unknown(other.tag())),
        }
        false
    }

    /// `RpcServer.ts:766-780`: the transport reads `headers` first, then `typeof id`, then the
    /// group. The order is the order of the answers, so a request with a bad id *and* no headers
    /// closes instead of refusing.
    fn request(&mut self, request: &crate::envelope::Request, out: &mut Vec<Message>) -> bool {
        let Some(frame_headers) = request.headers.as_ref() else {
            return true;
        };
        if !request.id.is_valid() {
            out.push(text_defect(&invalid_request_id(&request.id)));
            return false;
        }
        let key = request.group_key();
        let Some(handler) = self.group.lookup(&key) else {
            out.push(exit(&request.id, Outcome::Died(unknown_request_tag(&key))));
            return false;
        };
        let seen = crate::headers::seen_by_handler(&self.socket, frame_headers);
        // The gate runs *after* the lookup, because it runs inside the handler: `ws.ts` wraps the effect
        // the handler builds, so an unregistered tag is answered with `Unknown request tag` whatever the
        // scopes are, and a registered one whose scope is missing never reaches the handler at all.
        let decision = self
            .gate
            .as_ref()
            .map(|gate| gate.decide(&key, &request.payload));
        match decision {
            Some(crate::scopes::Decision::Refused { required }) => {
                self.answer(
                    &request.id,
                    Outcome::Typed(crate::scopes::authorization_error_value(required)),
                    out,
                );
                return false;
            }
            Some(crate::scopes::Decision::Undeclared(undeclared)) => {
                // Measured as `deleteBranch.undeclaredInTable`: the frame is the connection-level
                // `Defect`, with no `requestId` — the throw happened while the handler was still being
                // built, so there was no effect left to fail — and the socket stays open. The defect is
                // **error-shaped** (`{"name":"Error","message":…}`) rather than the bare string an
                // unknown `_tag` writes, because `RpcAuthorization.ts:180` threw an `Error` object.
                self.deaf = true;
                out.push(defect(Defect::Error {
                    name: "Error".to_owned(),
                    message: undeclared.message(),
                    cause: None,
                }));
                return false;
            }
            Some(crate::scopes::Decision::Granted) | None => {}
        }
        self.answer(&request.id, handler(&request.payload, &seen), out);
        false
    }

    /// Write one handler's outcome, or start the stream it produced.
    fn answer(&mut self, request_id: &Id, outcome: Outcome, out: &mut Vec<Message>) {
        match outcome {
            Outcome::Success(value) => out.push(exit(request_id, Outcome::Success(value))),
            Outcome::Typed(error) => out.push(exit(request_id, Outcome::Typed(error))),
            Outcome::Died(defect) => out.push(exit(request_id, Outcome::Died(defect))),
            Outcome::Broadcast(defect) => out.push(text_defect(&defect)),
            Outcome::Stream(batches) => {
                if batches.is_empty() {
                    out.push(exit(request_id, Outcome::Success(Value::Null)));
                    return;
                }
                let pending = Pending {
                    request_id: request_id.clone(),
                    batches,
                    index: 1,
                };
                out.push(chunk(&pending.request_id, &pending.batches[0]));
                self.pending.insert(key(request_id), pending);
            }
        }
    }

    /// The backpressure latch: nothing further goes out for a stream until the client has acked what
    /// it has. An `Ack` for an id nothing is waiting on is silently ignored (`b.ackUnknownRequest`).
    ///
    /// The last `Ack` does **not** write the terminal exit. `a.streamBatched` and
    /// `a.streamInterrupted` together show why: the same three-value stream ends with a `Void` exit
    /// after its ack in one scenario and with an `Interrupt` exit in the other, because resuming the
    /// producer is a separate fiber from handling the next frame (`concurrency: "unbounded"`,
    /// `RpcServer.ts:157`). The exit therefore belongs to [`Session::end`], and which of the two
    /// frames a client sees is the race it is in the shipped server too.
    fn ack(&mut self, request_id: &Id, out: &mut Vec<Message>) {
        let key = key(request_id);
        let Some(pending) = self.pending.get_mut(&key) else {
            return;
        };
        if pending.index < pending.batches.len() {
            out.push(chunk(&pending.request_id, &pending.batches[pending.index]));
            pending.index += 1;
        }
    }

    /// The producer of a stream ran out of values: the terminal `Schema.Void` exit, and nothing if
    /// the stream was already ended or interrupted. The caller is whoever runs the handler, which is
    /// the only place that knows the producer is done.
    pub fn end(&mut self, request_id: &Id) -> Vec<Message> {
        match self.pending.remove(&key(request_id)) {
            Some(pending) => vec![exit(&pending.request_id, Outcome::Success(Value::Null))],
            None => Vec::new(),
        }
    }

    /// `Interrupt` ends a stream with `Failure`/`Interrupt` and no further `Chunk`s. An id nothing is
    /// waiting on is ignored, the same silence as an unknown `Ack` (`b.interruptUnknownRequest`).
    fn interrupt(&mut self, request_id: &Id, out: &mut Vec<Message>) {
        let Some(pending) = self.pending.remove(&key(request_id)) else {
            return;
        };
        out.push(Message::Exit {
            request_id: pending.request_id,
            exit: Exit::Failure {
                cause: vec![Cause::Interrupt {
                    fiber_id: Some(Value::Number(Number::from(FIBER_NONE))),
                }],
            }
            .to_value(),
        });
    }
}

/// The id as a map key, spelling the type into it so `7` and `"7"` stay the two ids they are.
fn key(id: &Id) -> String {
    match id {
        Id::Number(number) => format!("n{number}"),
        Id::Text(text) => format!("s{text}"),
        Id::Absent => "a".to_owned(),
        Id::Other(value) => format!("o{value}"),
    }
}

fn exit(request_id: &Id, outcome: Outcome) -> Message {
    let exit = match outcome {
        Outcome::Success(value) => Exit::Success { value },
        Outcome::Typed(error) => Exit::Failure {
            cause: vec![Cause::Fail { error }],
        },
        Outcome::Died(defect) => Exit::Failure {
            cause: vec![Cause::Die {
                defect: Value::String(defect),
            }],
        },
        Outcome::Broadcast(_) | Outcome::Stream(_) => {
            unreachable!("only the three exit shapes reach this helper")
        }
    };
    Message::Exit {
        request_id: request_id.clone(),
        exit: exit.to_value(),
    }
}

fn chunk(request_id: &Id, values: &[Value]) -> Message {
    Message::Chunk {
        request_id: request_id.clone(),
        values: Value::Array(values.to_vec()),
    }
}

fn defect(defect: Defect) -> Message {
    Message::Defect {
        defect: defect.to_value(),
    }
}

fn text_defect(text: &str) -> Message {
    defect(Defect::Text(text.to_owned()))
}

fn unknown(tag: &str) -> Message {
    text_defect(&unknown_request_tag(tag))
}

impl From<&Syntax> for Defect {
    fn from(syntax: &Syntax) -> Self {
        Self::Error {
            name: "SyntaxError".to_owned(),
            message: syntax.message().to_owned(),
            cause: None,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn group() -> Group {
        Group::new()
            .returns("voidSuccess", Value::Null)
            .returns("emptyInEmptyOut", Value::Object(serde_json::Map::new()))
            .returns("scalarSuccess", Value::String("plain string".to_owned()))
            .on("typedFail", |_, _| {
                Outcome::Typed(
                    serde_json::from_str(r#"{"_tag":"ProtocolGoldenError","why":"no"}"#).unwrap(),
                )
            })
            .on("noError", |_, _| Outcome::Broadcast("boom".to_owned()))
            .streams("batchedStream", vec![vec![row(1), row(2), row(3)]])
            .streams("splitStream", vec![vec![row(1)], vec![row(2)]])
    }

    fn row(n: i64) -> Value {
        serde_json::from_str(&format!(r#"{{"i":{n}}}"#)).unwrap()
    }

    /// The id a client writes as a JSON number, which is not the same pending stream as the same
    /// digits quoted as a string (`a.stream` and `b.stringRequestId` are two different keys).
    fn number(n: i64) -> Id {
        Id::Number(Number::from(n))
    }

    /// A `Request` written out by hand, because which keys are present is the subject of these
    /// tests: the shipped client always writes `payload` and `headers`, and the absence of either is
    /// a different answer.
    fn request(fields: &str) -> String {
        format!(r#"{{"_tag":"Request",{fields}}}"#)
    }

    fn call(id: &str, tag: &str) -> String {
        request(&format!(
            r#""id":{id},"tag":"{tag}","payload":{{}},"headers":[]"#
        ))
    }

    fn frames(reply: Reply) -> Vec<String> {
        frames_of(reply.frames().to_vec())
    }

    /// The headers a handler was handed, echoed back as the success value. The loop itself never reads
    /// a name, so the echo is the only way to see the list it built — and it passes a list value
    /// through rather than joining it, which is the `Symbol.iterator` branch of `fromInput`.
    pub(crate) fn echo(_: &Payload, seen: &[Pair]) -> Outcome {
        let pairs: Vec<Value> = seen
            .iter()
            .map(|(name, value)| {
                Value::Array(vec![
                    Value::String(name.clone()),
                    match value {
                        crate::headers::Value::Text(text) => Value::String(text.clone()),
                        crate::headers::Value::Many(values) => Value::Array(
                            values
                                .iter()
                                .map(|text| Value::String(text.clone()))
                                .collect(),
                        ),
                    },
                ])
            })
            .collect();
        let mut out = serde_json::Map::new();
        out.insert("pairs".to_owned(), Value::Array(pairs));
        Outcome::Success(Value::Object(out))
    }

    fn socket_pair(name: &str, value: &str) -> Pair {
        (
            name.to_owned(),
            crate::headers::Value::Text(value.to_owned()),
        )
    }

    fn frames_of(messages: Vec<Message>) -> Vec<String> {
        messages.iter().map(Message::encode).collect()
    }

    fn silence(session: &mut Session, text: &str) {
        assert_eq!(frames(session.receive(text)), Vec::<String>::new());
    }

    #[test]
    fn a_request_is_answered_with_one_exit_and_the_ids_type_is_echoed() {
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(&call("4", "voidSuccess"))),
            vec![r#"{"_tag":"Exit","requestId":4,"exit":{"_tag":"Success","value":null}}"#]
        );
        // A string id is echoed as a string, which is the client's own correlation key.
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(&call(r#""abc""#, "typedFail"))),
            vec![
                r#"{"_tag":"Exit","requestId":"abc","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"ProtocolGoldenError","why":"no"}}]}}"#
            ]
        );
    }

    #[test]
    fn a_defect_inside_a_request_and_a_defect_of_the_connection_take_different_frames() {
        // The rpc declares no error schema, so the handler's die never becomes the request's exit.
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(&call("6", "noError"))),
            vec![r#"{"_tag":"Defect","defect":"boom"}"#]
        );
        // A die the schema layer produced does answer the request, and carries no requestId.
        let mut schema = Session::new(Group::new().on("nested", |_, _| {
            Outcome::Died("Expected string\n  at [\"name\"]".to_owned())
        }));
        assert_eq!(
            frames(schema.receive(&call("9005", "nested"))),
            vec![
                r#"{"_tag":"Exit","requestId":9005,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Expected string\n  at [\"name\"]"}]}}"#
            ]
        );
    }

    #[test]
    fn a_stream_waits_for_the_ack_it_was_owed_and_an_interrupt_ends_it() {
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(&call("8", "splitStream"))),
            vec![r#"{"_tag":"Chunk","requestId":8,"values":[{"i":1}]}"#]
        );
        assert_eq!(
            frames(session.receive(r#"{"_tag":"Ack","requestId":8}"#)),
            vec![r#"{"_tag":"Chunk","requestId":8,"values":[{"i":2}]}"#]
        );
        // Every value is out and the ack wrote nothing: the terminal exit belongs to the producer.
        silence(&mut session, r#"{"_tag":"Ack","requestId":8}"#);
        assert_eq!(
            frames_of(session.end(&number(8))),
            vec![r#"{"_tag":"Exit","requestId":8,"exit":{"_tag":"Success","value":null}}"#]
        );

        let mut session = Session::new(group());
        let _ = session.receive(&call("9", "batchedStream"));
        let _ = session.receive(r#"{"_tag":"Ack","requestId":9}"#);
        assert_eq!(
            frames(session.receive(r#"{"_tag":"Interrupt","requestId":9}"#)),
            vec![
                r#"{"_tag":"Exit","requestId":9,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":9007199254740991}]}}"#
            ]
        );
        // Nothing waits any more, so the second interrupt is the same silence as an unknown one.
        silence(&mut session, r#"{"_tag":"Interrupt","requestId":9}"#);
        // ...and so is the producer's end, which is the other half of the race the ack could win.
        assert_eq!(session.end(&number(9)), Vec::new());
    }

    #[test]
    fn three_inputs_close_the_connection_with_nothing_written() {
        let closed = || Reply::Close {
            written: Vec::new(),
        };
        let mut session = Session::new(group());
        assert_eq!(session.receive("null"), closed());
        assert_eq!(session.receive("[null]"), closed());
        assert_eq!(
            session.receive(&request(
                r#""id":9012,"tag":"voidSuccess","payload":{},"zzz":0"#
            )),
            closed()
        );
    }

    #[test]
    fn a_teardown_in_the_middle_of_a_batch_flushes_what_came_before_it() {
        // `batch.twoThenNull` on the wire: the request's `Exit`, then the zero-body close. Dropping the
        // frames the batch already produced was the loop's own bug, not the server's behavior.
        let mut session = Session::new(group());
        let reply = session.receive(&format!("[{},null]", call("9223", "voidSuccess")));
        assert!(reply.closes());
        assert_eq!(
            frames(reply),
            vec![r#"{"_tag":"Exit","requestId":9223,"exit":{"_tag":"Success","value":null}}"#]
        );
        // The same `null` first is the same close with nothing to flush.
        let mut session = Session::new(group());
        assert_eq!(
            session.receive(&format!("[null,{}]", call("9224", "voidSuccess"))),
            Reply::Close {
                written: Vec::new(),
            }
        );
    }

    #[test]
    fn the_switch_refuses_before_the_group_is_consulted() {
        let mut session = Session::new(group());
        // An id the transport rejects is a broadcast, even though the tag is one the group knows.
        assert_eq!(
            frames(session.receive(&request(
                r#""id":[],"tag":"voidSuccess","payload":{},"headers":[]"#
            ))),
            vec![r#"{"_tag":"Defect","defect":"Invalid request id: "}"#]
        );
        // A tag the group does not know answers the request instead.
        assert_eq!(
            frames(session.receive(&call("9010", "noSuchTag"))),
            vec![
                r#"{"_tag":"Exit","requestId":9010,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: noSuchTag"}]}}"#
            ]
        );
        // A tag that is absent is the same answer with nothing interpolated.
        assert_eq!(
            frames(session.receive(&request(r#""id":9009,"payload":{},"headers":[]"#))),
            vec![
                r#"{"_tag":"Exit","requestId":9009,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: "}]}}"#
            ]
        );
        // And a `_tag` outside the nine is the connection's problem, not the request's.
        assert_eq!(
            frames(session.receive(r#"{"_tag":"Nonsense"}"#)),
            vec![r#"{"_tag":"Defect","defect":"Unknown request tag: Nonsense"}"#]
        );
    }

    #[test]
    fn a_ping_is_a_pong_and_a_batch_is_answered_in_order() {
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(r#"{"_tag":"Ping"}"#)),
            vec!["{\"_tag\":\"Pong\"}"]
        );
        let batch = format!(
            "[{},{}]",
            call("9400", "voidSuccess"),
            request(r#""id":9401,"tag":"scalarSuccess","payload":null,"headers":[]"#)
        );
        assert_eq!(
            frames(session.receive(&batch)),
            vec![
                r#"{"_tag":"Exit","requestId":9400,"exit":{"_tag":"Success","value":null}}"#,
                r#"{"_tag":"Exit","requestId":9401,"exit":{"_tag":"Success","value":"plain string"}}"#
            ]
        );
        // A batch of nothing is a real nothing, and `Eof` is routed to a handler that ignores it.
        silence(&mut session, "[]");
        silence(&mut session, r#"{"_tag":"Eof"}"#);
        silence(&mut session, r#"{"_tag":"Ack","requestId":9999}"#);
    }

    #[test]
    fn a_frame_that_is_not_json_is_a_defect_and_the_connection_lives() {
        let mut session = Session::new(group());
        assert_eq!(
            frames(session.receive(r#"{"_tag":"#)),
            vec![
                r#"{"_tag":"Defect","defect":{"name":"SyntaxError","message":"Unexpected end of JSON input"}}"#
            ]
        );
        assert_eq!(
            frames(session.receive(r#"{"_tag":"Pong"}"#)),
            vec![r#"{"_tag":"Defect","defect":"Unknown request tag: Pong"}"#]
        );
        // And the next request is answered, which is the whole of "lives".
        assert_eq!(
            frames(session.receive(&call("9013", "emptyInEmptyOut"))),
            vec![r#"{"_tag":"Exit","requestId":9013,"exit":{"_tag":"Success","value":{}}}"#]
        );
    }

    #[test]
    fn a_broadcast_does_not_interrupt_what_is_already_in_flight() {
        let mut session = Session::new(group());
        let _ = session.receive(&call("9101", "batchedStream"));
        let _ = session.receive(&call("9102", "batchedStream"));
        let junk = frames(session.receive(r#"{"_tag":"Nonsense"}"#));
        assert_eq!(
            junk,
            vec![r#"{"_tag":"Defect","defect":"Unknown request tag: Nonsense"}"#]
        );
        // Both streams still wait, and their acks write nothing — the broadcast took no request down
        // with it, so the producer of each is still running and each still ends on its own.
        silence(&mut session, r#"{"_tag":"Ack","requestId":9101}"#);
        silence(&mut session, r#"{"_tag":"Ack","requestId":9102}"#);
        for id in [9101, 9102] {
            assert_eq!(
                frames_of(session.end(&number(id))),
                vec![
                    r#"{"_tag":"Exit","requestId":"#.to_owned()
                        + &id.to_string()
                        + r#","exit":{"_tag":"Success","value":null}}"#
                ],
                "the {id} stream survived the broadcast"
            );
        }
    }

    #[test]
    fn a_number_and_a_string_never_share_a_stream() {
        let mut session = Session::new(group());
        let _ = session.receive(&call("7", "batchedStream"));
        let _ = session.receive(&call(r#""7""#, "batchedStream"));
        assert_eq!(
            frames_of(session.end(&Id::Text("7".to_owned()))),
            vec![r#"{"_tag":"Exit","requestId":"7","exit":{"_tag":"Success","value":null}}"#]
        );
        assert_eq!(
            frames_of(session.end(&number(7))),
            vec![r#"{"_tag":"Exit","requestId":7,"exit":{"_tag":"Success","value":null}}"#]
        );
    }

    /// `headers.*` on the wire, claimed about the loop alone so it runs without the recorded artifact:
    /// the upgrade request's pairs are **prepended**, a name both lists carry keeps the socket's slot
    /// and the frame's value, and a second request reads the same socket list rather than an
    /// accumulated one.
    #[test]
    fn a_handler_is_handed_the_upgrade_headers_with_the_frames_own_after_them() {
        let mut session = Session::upgraded(
            Group::new().on("seenHeaders", echo),
            vec![
                socket_pair("host", "127.0.0.1"),
                socket_pair("x-probe", "upgrade"),
                (
                    "set-cookie".to_owned(),
                    crate::headers::Value::Many(vec!["a=1".to_owned(), "b=2".to_owned()]),
                ),
            ],
        );
        assert_eq!(
            frames(session.receive(&request(
                r#""id":9500,"tag":"seenHeaders","payload":{},"headers":[["x-probe","frame"],["tail","2"]]"#
            ))),
            vec![
                r#"{"_tag":"Exit","requestId":9500,"exit":{"_tag":"Success","value":{"pairs":[["host","127.0.0.1"],["x-probe","frame"],["set-cookie",["a=1","b=2"]],["tail","2"]]}}}"#
            ]
        );
        // The same socket, read again with nothing on the frame: the pair the frame overwrote is back
        // to the upgrade's own value, which is what `headers.twice` measured.
        assert_eq!(
            frames(session.receive(&request(
                r#""id":9501,"tag":"seenHeaders","payload":{},"headers":[]"#
            ))),
            vec![
                r#"{"_tag":"Exit","requestId":9501,"exit":{"_tag":"Success","value":{"pairs":[["host","127.0.0.1"],["x-probe","upgrade"],["set-cookie",["a=1","b=2"]]]}}}"#
            ]
        );
        // A connection that never handshook has nothing to prepend.
        let mut plain = Session::new(Group::new().on("seenHeaders", echo));
        assert_eq!(
            frames(plain.receive(&call("9502", "seenHeaders"))),
            vec![
                r#"{"_tag":"Exit","requestId":9502,"exit":{"_tag":"Success","value":{"pairs":[]}}}"#
            ]
        );
    }

    // -----------------------------------------------------------------------
    // The scope gate
    // -----------------------------------------------------------------------

    /// Tag names are the real methods, so every assertion below goes through the real table row.
    fn gated_group() -> Group {
        Group::new()
            .returns("device.detail", Value::String("detail".to_owned()))
            .returns("device.open", Value::String("opened".to_owned()))
            .returns("device.list", Value::String("listed".to_owned()))
            // The one handler the shipped `WsRpcGroup` registers and `RPC_REQUIRED_SCOPES` omits.
            .returns("vcs.deleteBranch", Value::Null)
            .streams("subscribeDeviceState", vec![vec![row(1)]])
    }

    fn gate(scopes: &[&str]) -> Gate {
        Gate::new(scopes.iter().map(|scope| (*scope).to_owned()).collect())
    }

    fn served(scopes: &[&str]) -> Session {
        Session::gated(gated_group(), Vec::new(), gate(scopes))
    }

    fn ask(id: &str, tag: &str, payload: &str) -> String {
        request(&format!(
            r#""id":{id},"tag":"{tag}","payload":{payload},"headers":[]"#
        ))
    }

    /// The refusal, as the wire writes it: the request's own `Exit`, and the error with its three keys.
    /// Written as bytes with the two variables held apart rather than as a `format!`, because the claim
    /// of this file is the exact text and Rust's brace doubling is not worth reading around.
    fn refused(id: &str, required: &str) -> String {
        r#"{"_tag":"Exit","requestId":@ID@,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: @REQ@.","requiredScope":"@REQ@"}}]}}"#
            .replace("@ID@", id)
            .replace("@REQ@", required)
    }

    #[test]
    fn a_refusal_answers_the_request_and_leaves_the_connection_able() {
        let mut session = served(&["orchestration:read"]);
        assert_eq!(
            frames(session.receive(&call("71", "device.open"))),
            vec![refused("71", "orchestration:operate")],
            "read does not imply operate",
        );
        // `probe.deniedThenCanary` measured exactly this: the refusal is an answer, so the next request
        // is served. The connection only stops answering after the *throw*.
        assert_eq!(
            frames(session.receive(&call("72", "device.detail"))),
            vec![r#"{"_tag":"Exit","requestId":72,"exit":{"_tag":"Success","value":"detail"}}"#]
        );
    }

    #[test]
    fn an_empty_credential_refuses_without_running_the_handler() {
        let mut session = served(&[]);
        assert_eq!(
            frames(session.receive(&call("73", "device.list"))),
            vec![refused("73", "orchestration:read")],
        );
    }

    /// `deleteBranch.undeclaredInTable` and `deleteBranch.thenCanary`, which together are the reason this
    /// branch is a broadcast rather than a refusal: a scope list that covers everything still throws,
    /// because there is nothing to compare against, and the throw leaves the connection open and deaf.
    #[test]
    fn a_method_the_table_omits_is_answered_outside_the_request_and_then_silence() {
        let mut session = served(&["orchestration:read", "orchestration:operate", "access:read"]);
        assert_eq!(
            frames(session.receive(&call("74", "vcs.deleteBranch"))),
            vec![
                r#"{"_tag":"Defect","defect":{"name":"Error","message":"RPC method vcs.deleteBranch has no declared authorization scope."}}"#
            ],
            "no requestId: the throw happened while the handler was being built",
        );
        assert!(
            !session.receive(&call("75", "device.detail")).closes(),
            "the socket is not closed, which is what made the client report it open",
        );
        silence(&mut session, &call("76", "device.detail"));
        silence(&mut session, r#"{"_tag":"Ping"}"#);
    }

    /// The order the shipped dispatch puts them in: the group lookup first, since a tag with no handler
    /// never reaches `requiredScopeForRpcMethod`, and the gate before the handler.
    #[test]
    fn the_group_answers_before_the_gate_is_consulted() {
        let mut session = served(&[]);
        assert_eq!(
            frames(session.receive(&call("77", "no.such.tag"))),
            vec![
                r#"{"_tag":"Exit","requestId":77,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: no.such.tag"}]}}"#
            ],
        );
        // Asking twice is what separates this from the throw: an unregistered tag answers every time,
        // because the request still has an id to answer to.
        assert_eq!(
            frames(session.receive(&call("78", "no.such.tag"))),
            vec![
                r#"{"_tag":"Exit","requestId":78,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: no.such.tag"}]}}"#
            ],
        );
        // …and the connection is not deaf, which is the difference between this and the throw above.
        assert_eq!(
            frames(session.receive(&call("79", "device.detail"))),
            vec![refused("79", "orchestration:read")],
        );
    }

    /// `list.inspectOnly`: the one branch that reaches a handler without passing the gate. The empty
    /// credential is the point — a session with no scopes at all runs it.
    #[test]
    fn device_list_inspects_with_no_credential_and_operates_with_one() {
        let mut session = served(&[]);
        assert_eq!(
            frames(session.receive(&ask("80", "device.list", r#"{"inspectOnly":true}"#))),
            vec![r#"{"_tag":"Exit","requestId":80,"exit":{"_tag":"Success","value":"listed"}}"#],
        );
        // `list.inspectOnlyWithUpdateTool`: the same inspection, asked to update a tool, is an operation.
        let mut session = served(&["orchestration:read"]);
        assert_eq!(
            frames(session.receive(&ask(
                "81",
                "device.list",
                r#"{"inspectOnly":true,"updateTool":"codex"}"#
            ))),
            vec![refused("81", "orchestration:operate")],
        );
        // `list.emptyStringsAreAbsent`: `input.retryHostId || input.updateTool` is truthiness, so an
        // empty string is the field being absent and the read scope is enough.
        assert_eq!(
            frames(session.receive(&ask(
                "82",
                "device.list",
                r#"{"retryHostId":"","updateTool":""}"#
            ))),
            vec![r#"{"_tag":"Exit","requestId":82,"exit":{"_tag":"Success","value":"listed"}}"#],
        );
        // `updateTool: ""` does not take the `inspectOnly` shortcut away, either.
        assert_eq!(
            frames(session.receive(&ask(
                "83",
                "device.list",
                r#"{"inspectOnly":true,"updateTool":""}"#
            ))),
            vec![r#"{"_tag":"Exit","requestId":83,"exit":{"_tag":"Success","value":"listed"}}"#],
        );
        // `list.inspectOnlyOutranksRetry`: the short-circuit reads the two flags, so an inspection that also
        // names a host is still an inspection and never reaches the scope the retry alone would need.
        let mut inspecting = served(&[]);
        assert_eq!(
            frames(inspecting.receive(&ask(
                "91",
                "device.list",
                r#"{"inspectOnly":true,"retryHostId":"host-1"}"#
            ))),
            vec![r#"{"_tag":"Exit","requestId":91,"exit":{"_tag":"Success","value":"listed"}}"#],
        );
        // …and `inspectOnly: false` is the branch not being taken, so the empty credential that let the
        // first request through refuses this one.
        let mut empty = served(&[]);
        assert_eq!(
            frames(empty.receive(&ask("90", "device.list", r#"{"inspectOnly":false}"#))),
            vec![refused("90", "orchestration:read")],
        );
    }

    /// The gate reads the request's **tag**, which is what `ws.ts:3542`'s `device.detail` does with its
    /// own name. The golden reached the lookup through this rpc's `method` payload instead, so a probe
    /// case whose payload names an operate method is granted here and refused there — the port follows
    /// the server, and this test is the difference written down rather than discovered later.
    #[test]
    fn the_gate_reads_the_tag_rather_than_the_payload() {
        let mut session = served(&["orchestration:read"]);
        assert_eq!(
            frames(session.receive(&ask("84", "device.detail", r#"{"method":"device.open"}"#))),
            vec![r#"{"_tag":"Exit","requestId":84,"exit":{"_tag":"Success","value":"detail"}}"#],
        );
    }

    /// A refusal of a subscription is the same `Fail` the effect path writes (`streamAuthError.denied`),
    /// because the exit schema is what carries the error and it carries it for every method the table
    /// covers. So the gate's answer does not depend on the channel, and no stream is started.
    #[test]
    fn a_refused_subscription_is_refused_like_an_effect() {
        let mut session = served(&[]);
        assert_eq!(
            frames(session.receive(&call("85", "subscribeDeviceState"))),
            vec![refused("85", "orchestration:read")],
        );
        // Nothing is pending, so the ack a client might still send is silence rather than a chunk.
        silence(&mut session, r#"{"_tag":"Ack","requestId":85}"#);
    }
}
