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
/// this loop only needs the answer it produces, so a handler is a function from the payload hole to
/// an [`Outcome`] and nothing else.
pub type Handler = Box<dyn Fn(&Payload) -> Outcome>;

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
    pub fn on(mut self, tag: &str, handler: impl Fn(&Payload) -> Outcome + 'static) -> Self {
        self.handlers.insert(tag.to_owned(), Box::new(handler));
        self
    }

    #[must_use]
    pub fn returns(self, tag: &str, value: Value) -> Self {
        self.on(tag, move |_| Outcome::Success(value.clone()))
    }

    #[must_use]
    pub fn streams(self, tag: &str, batches: Vec<Vec<Value>>) -> Self {
        self.on(tag, move |_| Outcome::Stream(batches.clone()))
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
    Close {
        written: Vec<Message>,
    },
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
    /// Keyed by the id as the client wrote it, because `requestId` echoes the id's **type** and two
    /// clients can number the same request differently (`7` and `"7"` are not the same key).
    pending: BTreeMap<String, Pending>,
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
            pending: BTreeMap::new(),
        }
    }

    /// One WebSocket text frame in, the server's answer out.
    pub fn receive(&mut self, text: &str) -> Reply {
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
        if request.headers.is_none() {
            return true;
        }
        if !request.id.is_valid() {
            out.push(text_defect(&invalid_request_id(&request.id)));
            return false;
        }
        let key = request.group_key();
        let Some(handler) = self.group.lookup(&key) else {
            out.push(exit(&request.id, Outcome::Died(unknown_request_tag(&key))));
            return false;
        };
        self.answer(&request.id, handler(&request.payload), out);
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
mod tests {
    use super::*;

    fn group() -> Group {
        Group::new()
            .returns("voidSuccess", Value::Null)
            .returns("emptyInEmptyOut", Value::Object(serde_json::Map::new()))
            .returns("scalarSuccess", Value::String("plain string".to_owned()))
            .on("typedFail", |_| {
                Outcome::Typed(
                    serde_json::from_str(r#"{"_tag":"ProtocolGoldenError","why":"no"}"#).unwrap(),
                )
            })
            .on("noError", |_| Outcome::Broadcast("boom".to_owned()))
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
        let mut schema = Session::new(Group::new().on("nested", |_| {
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
            vec![
                r#"{"_tag":"Exit","requestId":9223,"exit":{"_tag":"Success","value":null}}"#
            ]
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
}
