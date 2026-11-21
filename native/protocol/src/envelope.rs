//! The nine transport envelopes, in the byte order the shipped encoders write them.
//!
//! `RpcMessage.EncodedSchema` (`RpcMessage.ts:438-472`) lists the members: `Request`, `Ack`,
//! `Interrupt`, `Ping`, `Eof`, `Chunk`, `Exit`, `Defect`, `Pong`. That union is the *binary*
//! serializer's view, and under `RpcSerialization.layerJson` it never runs — the bytes are
//! `JSON.stringify` of whichever object literal built the message. So the key order each literal
//! uses is the wire order, and every order in this module is copied from a construction site and
//! then checked against the frames the real server and client wrote
//! (`apps/server/scripts/protocol-golden.ts`, replayed by `tests/envelope_golden.rs`):
//!
//! | message | construction site | measured bytes |
//! | --- | --- | --- |
//! | `Request` | `RpcClient.ts:374-386` | `_tag,id,tag,payload` then the trace trio then `headers` |
//! | `Ack`/`Interrupt` | `RpcClient.ts` | `_tag,requestId` |
//! | `Chunk` | `RpcServer.ts:663` | `_tag,requestId,values` |
//! | `Exit` | `RpcMessage.ts:349-366`, `RpcServer.ts:664,699-712` | `_tag,requestId,exit` |
//! | `Defect` | `RpcMessage.ts:375` | `_tag,defect` |
//! | `Ping`/`Pong`/`Eof` | `RpcMessage.ts:169-177,473` | `_tag` alone |
//!
//! Note the `Request` order is **not** the order `RequestEncodedSchema` declares: the schema lists
//! `headers` before the trace fields, the literal writes them the other way, and the wire follows
//! the literal. That is the kind of thing a port that reads the schema instead of the bytes gets
//! wrong without anything failing.

use std::fmt::Write as _;

use serde_json::Value;

use crate::json::{number_text, quote, stringify};

/// The `id` of a request, or the `requestId` of a response.
///
/// `RpcServer.ts:769-779` decides with `typeof`, so the accepted shapes are number and string and
/// everything else is refused with a message that interpolates the value. `Absent` and [`Id::Other`]
/// are therefore part of the model rather than parse errors: they are what a malformed client sends,
/// and the refusal is a byte the port has to get right.
#[derive(Clone, Debug, PartialEq)]
pub enum Id {
    Number(serde_json::Number),
    Text(String),
    /// No key at all, which the server reads as `undefined`.
    Absent,
    /// `null`, a boolean, an array or an object.
    Other(Value),
}

impl Id {
    pub fn read(value: Option<&Value>) -> Self {
        match value {
            None => Self::Absent,
            Some(Value::Number(number)) => Self::Number(number.clone()),
            Some(Value::String(text)) => Self::Text(text.clone()),
            Some(other) => Self::Other(other.clone()),
        }
    }

    /// Whether `typeof` accepts the id as a request's own.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        matches!(self, Self::Number(_) | Self::Text(_))
    }

    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::Number(number) => number_text(number),
            Self::Text(text) => text.clone(),
            Self::Absent => "undefined".to_owned(),
            Self::Other(value) => crate::coerce::to_string(value),
        }
    }

    /// `,"key":value`, or nothing at all.
    ///
    /// The nothing is `JSON.stringify`'s rule rather than a convenience: a member whose value is
    /// `undefined` is dropped, and an absent key reads as `undefined`. A client that omits an id
    /// therefore writes `{"_tag":"Ack"}`, not a `null` id it never had.
    fn write_field(&self, out: &mut String, key: &str) {
        if matches!(self, Self::Absent) {
            return;
        }
        let _ = write!(out, ",\"{key}\":");
        match self {
            Self::Number(number) => out.push_str(&number_text(number)),
            Self::Text(text) => out.push_str(&quote(text)),
            Self::Other(value) => out.push_str(&stringify(value)),
            Self::Absent => unreachable!("handled above"),
        }
    }
}

/// The `headers` field of a `Request`.
pub type Headers = Vec<(String, String)>;

/// The tracing context a client adds when its fiber carries a span (`RpcClient.ts:378-384`).
///
/// The trio is written as one unit or not at all, which is what the `...(span ? {…} : {})` spread
/// means, and `sampled` is a boolean rather than a flag that may be absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trace {
    pub trace_id: String,
    pub span_id: String,
    pub sampled: bool,
}

/// A request's own payload hole. `None` is a frame with no `payload` key, which the server hands to
/// the rpc's payload decoder and which the golden measured as `Expected null` for a payload-less
/// rpc (`b.omittedPayloadRaw`).
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: Id,
    /// `Object.hasOwn(request, "tag") ? request.tag : ""` (`RpcServer.ts:768`): a missing key and a
    /// present non-string one are different answers, and both are measured (`""` for
    /// `b.requestWithoutTag`, `"123"` for `b.requestTagNumber`).
    pub tag: Option<Value>,
    pub payload: Option<Value>,
    pub trace: Option<Trace>,
    /// `None` is the field the shipped client always writes and the one whose absence takes the
    /// connection down: `Headers.fromInput(undefined)` throws inside the request handler
    /// (`RpcServer.ts:749`), measured as `b.headersAbsent` closing with code 1005.
    pub headers: Option<Headers>,
    /// Written by the JSON-RPC serializer (`RpcSerialization.ts:322`), never by `layerJson`. The
    /// server reads `isNotification === true` only on the buffered HTTP path, so on a WebSocket the
    /// key is tolerated and answered like any other request (`b.notification*`).
    pub notification: bool,
}

impl Request {
    pub fn read(fields: &serde_json::Map<String, Value>) -> Self {
        Self {
            id: Id::read(fields.get("id")),
            tag: fields.get("tag").cloned(),
            payload: fields.get("payload").cloned(),
            trace: Trace::read(fields),
            headers: fields
                .get("headers")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let pair = item.as_array()?;
                            Some((
                                pair.first()?.as_str()?.to_owned(),
                                pair.get(1)?.as_str()?.to_owned(),
                            ))
                        })
                        .collect()
                }),
            notification: fields.get("isNotification").and_then(Value::as_bool) == Some(true),
        }
    }

    /// The string the group lookup is keyed on, which is `Object.hasOwn(request, "tag")` decided
    /// first (`RpcServer.ts:768`) and `String(…)` applied at the message site. Both halves are
    /// measured: `b.requestWithoutTag` is refused with a trailing space and `b.requestTagNumber`
    /// with `"123"`, so a key that is absent and a key that is merely not a string are different
    /// answers.
    #[must_use]
    pub fn group_key(&self) -> String {
        match &self.tag {
            Some(tag) => crate::coerce::to_string(tag),
            None => String::new(),
        }
    }

    /// The whole `{"_tag":"Request",…}` literal.
    #[must_use]
    pub fn encode(&self) -> String {
        let mut out = String::from("{\"_tag\":\"Request\"");
        self.encode_body(&mut out);
        out.push('}');
        out
    }

    /// Everything after the tag, so [`Message::encode`] can write the prefix it shares with the
    /// other eight.
    ///
    /// `tag` and `payload` follow the same rule as [`Id`]: `JSON.stringify` drops a member whose value
    /// is `undefined`, so an absent field costs its key rather than becoming `null` or `""`. The two
    /// fabricated frames the capture recorded in exactly that shape (`b.requestWithoutTag`,
    /// `b.omittedPayloadRaw`) are the evidence the read/write pair is meant to be the identity on.
    fn encode_body(&self, out: &mut String) {
        self.id.write_field(out, "id");
        if let Some(tag) = &self.tag {
            let _ = write!(out, ",\"tag\":{}", stringify(tag));
        }
        if let Some(payload) = &self.payload {
            let _ = write!(out, ",\"payload\":{}", stringify(payload));
        }
        if let Some(trace) = &self.trace {
            let _ = write!(
                out,
                ",\"traceId\":{},\"spanId\":{},\"sampled\":{}",
                quote(&trace.trace_id),
                quote(&trace.span_id),
                trace.sampled
            );
        }
        if let Some(headers) = &self.headers {
            let _ = write!(out, ",\"headers\":[");
            for (index, (name, value)) in headers.iter().enumerate() {
                let _ = write!(
                    out,
                    "{}[{},{}]",
                    if index == 0 { "" } else { "," },
                    quote(name),
                    quote(value)
                );
            }
            out.push(']');
        }
    }
}

impl Trace {
    fn read(fields: &serde_json::Map<String, Value>) -> Option<Self> {
        let trace = Self {
            trace_id: fields.get("traceId")?.as_str()?.to_owned(),
            span_id: fields.get("spanId")?.as_str()?.to_owned(),
            sampled: fields.get("sampled")?.as_bool()?,
        };
        Some(trace)
    }
}

/// The `exit` hole of a terminal response: `ExitEncoded` (`RpcMessage.ts:262-279`).
#[derive(Clone, Debug, PartialEq)]
pub enum Exit {
    /// `Schema.Void` encodes to JSON `null`, which is the difference between the two
    /// indistinguishable-looking frames the golden names `a.voidSuccess` (`value:null`, an rpc whose
    /// success schema is `Schema.Void`) and `a.voidPayload` (`value:{}`, a `Schema.Struct({})`).
    Success { value: Value },
    /// A cause **array**, because a wire cause has no tree: `Fail` carries the typed error, `Die` a
    /// defect and `Interrupt` the fiber that was stopped.
    Failure { cause: Vec<Cause> },
}

impl Exit {
    /// The `ExitEncoded` object, in the order `RpcMessage.ts:349-366` and `RpcServer.ts:664` write
    /// it: `_tag` then the one hole.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut fields = serde_json::Map::new();
        match self {
            Self::Success { value } => {
                fields.insert("_tag".to_owned(), Value::String("Success".to_owned()));
                fields.insert("value".to_owned(), value.clone());
            }
            Self::Failure { cause } => {
                fields.insert("_tag".to_owned(), Value::String("Failure".to_owned()));
                fields.insert(
                    "cause".to_owned(),
                    Value::Array(cause.iter().map(Cause::to_value).collect()),
                );
            }
        }
        Value::Object(fields)
    }

    pub fn read(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        match fields.get("_tag")?.as_str()? {
            "Success" => Some(Self::Success {
                value: fields.get("value").cloned().unwrap_or(Value::Null),
            }),
            "Failure" => Some(Self::Failure {
                cause: fields
                    .get("cause")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Cause::read).collect())
                    .unwrap_or_default(),
            }),
            _ => None,
        }
    }
}

/// One entry of an [`Exit::Failure`]'s cause array.
#[derive(Clone, Debug, PartialEq)]
pub enum Cause {
    /// The rpc's own declared error, already encoded by its schema.
    Fail { error: Value },
    /// A defect: a thrown value the `Schema.Defect` codec filled.
    Die { defect: Value },
    /// `fiberId` is `number | undefined` (`RpcMessage.ts:276`), and `JSON.stringify` **drops** an
    /// `undefined` member, so an interrupt whose fiber is unknown is written as `{"_tag":"Interrupt"}`.
    Interrupt { fiber_id: Option<Value> },
}

impl Cause {
    #[must_use]
    pub fn to_value(&self) -> Value {
        fn object(entries: [(&'static str, Value); 2]) -> Value {
            let mut fields = serde_json::Map::new();
            for (key, value) in entries {
                fields.insert(key.to_owned(), value);
            }
            Value::Object(fields)
        }
        let tag = |name: &str| Value::String(name.to_owned());
        match self {
            Self::Fail { error } => object([("_tag", tag("Fail")), ("error", error.clone())]),
            Self::Die { defect } => object([("_tag", tag("Die")), ("defect", defect.clone())]),
            // `undefined` is what an unknown fiber is, and `JSON.stringify` drops the member, so an
            // interrupt with no fiber is the one-key object `{"_tag":"Interrupt"}`.
            Self::Interrupt { fiber_id: None } => {
                let mut fields = serde_json::Map::new();
                fields.insert("_tag".to_owned(), tag("Interrupt"));
                Value::Object(fields)
            }
            Self::Interrupt {
                fiber_id: Some(fiber_id),
            } => object([("_tag", tag("Interrupt")), ("fiberId", fiber_id.clone())]),
        }
    }

    fn read(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        match fields.get("_tag")?.as_str()? {
            "Fail" => Some(Self::Fail {
                error: fields.get("error").cloned().unwrap_or(Value::Null),
            }),
            "Die" => Some(Self::Die {
                defect: fields.get("defect").cloned().unwrap_or(Value::Null),
            }),
            "Interrupt" => Some(Self::Interrupt {
                fiber_id: fields.get("fiberId").cloned(),
            }),
            _ => None,
        }
    }
}

/// The value hole of [`Message::Defect`] and [`Cause::Die`]: whatever `Schema.Defect`'s JSON codec
/// left. The codec recognises an object whose `message` is a string and rebuilds it as
/// `{name,message,cause?}`, which is why a `SyntaxError` arrives as an object while a thrown string
/// arrives as one (`a.handlerDieNoErrorSchema` sends `"boom"`).
#[derive(Clone, Debug, PartialEq)]
pub enum Defect {
    Text(String),
    Error {
        name: String,
        message: String,
        cause: Option<Box<Defect>>,
    },
    /// Anything the codec did not recognise, held as it arrived.
    Raw(Value),
}

impl Defect {
    pub fn read(value: &Value) -> Self {
        match value {
            Value::String(text) => Self::Text(text.clone()),
            Value::Object(fields) => {
                let Some(message) = fields.get("message").and_then(Value::as_str) else {
                    return Self::Raw(value.clone());
                };
                // `typeof name === "string" && name !== "Error"`: a missing, non-string or literal
                // "Error" name all end up spelled "Error".
                let name = match fields.get("name").and_then(Value::as_str) {
                    Some(name) if name != "Error" => name.to_owned(),
                    _ => "Error".to_owned(),
                };
                let cause = fields
                    .get("cause")
                    .filter(|_| fields.contains_key("cause"))
                    .map(|cause| Box::new(Self::read(cause)));
                Self::Error {
                    name,
                    message: message.to_owned(),
                    cause,
                }
            }
            other => Self::Raw(other.clone()),
        }
    }

    /// The JSON the `Schema.Defect` codec writes for this defect, which is what a `Defect` frame's
    /// hole and a `Die` cause's hole both carry.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut fields = serde_json::Map::new();
        match self {
            Self::Text(text) => return Value::String(text.clone()),
            Self::Error {
                name,
                message,
                cause,
            } => {
                fields.insert("name".to_owned(), Value::String(name.clone()));
                fields.insert("message".to_owned(), Value::String(message.clone()));
                if let Some(cause) = cause {
                    fields.insert("cause".to_owned(), cause.to_value());
                }
            }
            Self::Raw(value) => return value.clone(),
        }
        Value::Object(fields)
    }

    /// The message the client shows, when the defect is error-shaped.
    #[must_use]
    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Error { message, .. } => Some(message),
            Self::Text(_) | Self::Raw(_) => None,
        }
    }
}

/// One of the nine envelopes.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Request(Request),
    Ack {
        request_id: Id,
    },
    Interrupt {
        request_id: Id,
    },
    /// `values` is a non-empty batch of encoded successes (`RpcMessage.ts:232-237`).
    Chunk {
        request_id: Id,
        values: Value,
    },
    Exit {
        request_id: Id,
        /// The `exit` hole, held as the JSON that arrived. The envelope layer is hole-agnostic for
        /// the same reason `layerJson` is: a frame whose exit is `123` is still an `Exit` as far as
        /// the switch is concerned, and rewriting it would be a claim no measurement backs. Read the
        /// typed shape with [`Exit::read`].
        exit: Value,
    },
    /// The broadcast a protocol-level failure takes: no `requestId`, because there is nothing to
    /// answer to. The golden shows a `Defect` reaching requests already in flight **and** the
    /// requests' own `Exit` frames arriving afterwards (`b.broadcastWithInFlight`).
    Defect {
        /// Read the typed shape with [`Defect::read`].
        defect: Value,
    },
    Ping,
    Pong,
    /// Written by the HTTP protocol (`RpcServer.ts:1153`) and never by a WebSocket one, which the
    /// golden asserts rather than assumes.
    Eof,
}

impl Message {
    /// The nine tags, and the order `EncodedSchema` lists them.
    pub const TAGS: [&'static str; 9] = [
        "Request",
        "Ack",
        "Interrupt",
        "Ping",
        "Eof",
        "Chunk",
        "Exit",
        "Defect",
        "Pong",
    ];

    #[must_use]
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Request(_) => "Request",
            Self::Ack { .. } => "Ack",
            Self::Interrupt { .. } => "Interrupt",
            Self::Ping => "Ping",
            Self::Eof => "Eof",
            Self::Chunk { .. } => "Chunk",
            Self::Exit { .. } => "Exit",
            Self::Defect { .. } => "Defect",
            Self::Pong => "Pong",
        }
    }

    /// `JSON.stringify` of the message, which is exactly what `layerJson`'s `encode` sends.
    #[must_use]
    pub fn encode(&self) -> String {
        let mut out = String::from("{\"_tag\":");
        out.push_str(&quote(self.tag()));
        match self {
            Self::Request(request) => return request.encode(),
            Self::Ack { request_id } | Self::Interrupt { request_id } => {
                request_id.write_field(&mut out, "requestId");
            }
            Self::Chunk { request_id, values } => {
                request_id.write_field(&mut out, "requestId");
                let _ = write!(out, ",\"values\":{}", stringify(values));
            }
            Self::Exit { request_id, exit } => {
                request_id.write_field(&mut out, "requestId");
                let _ = write!(out, ",\"exit\":{}", stringify(exit));
            }
            Self::Defect { defect } => {
                let _ = write!(out, ",\"defect\":{}", stringify(defect));
            }
            Self::Ping | Self::Pong | Self::Eof => {}
        }
        out.push('}');
        out
    }

    /// Read one decoded JSON value as an envelope, which is the switch the server runs
    /// (`RpcServer.ts:764-820`) before it knows anything about the group.
    pub fn read(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        match fields.get("_tag")?.as_str()? {
            "Request" => Some(Self::Request(Request::read(fields))),
            "Ack" => Some(Self::Ack {
                request_id: Id::read(fields.get("requestId")),
            }),
            "Interrupt" => Some(Self::Interrupt {
                request_id: Id::read(fields.get("requestId")),
            }),
            "Chunk" => Some(Self::Chunk {
                request_id: Id::read(fields.get("requestId")),
                values: fields.get("values").cloned().unwrap_or(Value::Null),
            }),
            "Exit" => Some(Self::Exit {
                request_id: Id::read(fields.get("requestId")),
                exit: fields.get("exit").cloned().unwrap_or(Value::Null),
            }),
            "Defect" => Some(Self::Defect {
                defect: fields.get("defect").cloned().unwrap_or(Value::Null),
            }),
            "Ping" => Some(Self::Ping),
            "Pong" => Some(Self::Pong),
            "Eof" => Some(Self::Eof),
            _ => None,
        }
    }
}

/// The typed views over the two holes, and the constructors that fill them.
///
/// The envelope keeps its hole as JSON so a frame survives a read/write pair untouched; these are
/// for the code that has to know what the hole *means*.
impl Message {
    /// The `exit` half of a terminal response, when it is shaped like an `ExitEncoded`.
    #[must_use]
    pub fn exit(&self) -> Option<Exit> {
        match self {
            Self::Exit { exit, .. } => Exit::read(exit),
            _ => None,
        }
    }

    /// The `defect` half of a broadcast, which is total: any JSON value is a possible defect.
    #[must_use]
    pub fn defect(&self) -> Option<Defect> {
        match self {
            Self::Defect { defect, .. } => Some(Defect::read(defect)),
            _ => None,
        }
    }

    /// `ResponseDefectEncoded` (`RpcMessage.ts:375`).
    #[must_use]
    pub fn defect_frame(defect: &Defect) -> Self {
        Self::Defect {
            defect: defect.to_value(),
        }
    }

    /// `ResponseExitDieEncoded` (`RpcMessage.ts:349`), the frame a payload that will not decode or
    /// an unknown tag on a *known* id is answered with.
    #[must_use]
    pub fn die_frame(request_id: Id, defect: &Defect) -> Self {
        Self::Exit {
            request_id,
            exit: Exit::Failure {
                cause: vec![Cause::Die {
                    defect: defect.to_value(),
                }],
            }
            .to_value(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u64) -> Id {
        Id::Number(serde_json::Number::from(value))
    }

    /// The four recorded bytes that the env-gated golden cannot guard on its own, kept here so a
    /// plain `cargo test` still fails when the construction order moves.
    #[test]
    fn the_client_literal_writes_the_order_the_construction_site_uses() {
        let request = Request {
            id: id(0),
            tag: Some(Value::String("emptyInEmptyOut".to_owned())),
            payload: Some(Value::Object(serde_json::Map::new())),
            trace: Some(Trace {
                trace_id: "__TRACE_ID__".to_owned(),
                span_id: "__SPAN_ID__".to_owned(),
                sampled: true,
            }),
            headers: Some(vec![]),
            notification: false,
        };
        assert_eq!(
            request.encode(),
            r#"{"_tag":"Request","id":0,"tag":"emptyInEmptyOut","payload":{},"traceId":"__TRACE_ID__","spanId":"__SPAN_ID__","sampled":true,"headers":[]}"#
        );
        assert_eq!(
            Message::Request(request.clone()).encode(),
            request.encode(),
            "and the envelope writes it rather than its own prefix"
        );
        // The same rpc with two headers, which is where the pair-array shape shows.
        let mut with_headers = request;
        with_headers.id = id(3);
        with_headers.headers = Some(vec![
            ("x-first".to_owned(), "1".to_owned()),
            ("x-second".to_owned(), "2".to_owned()),
        ]);
        assert_eq!(
            Message::Request(with_headers).encode(),
            r#"{"_tag":"Request","id":3,"tag":"emptyInEmptyOut","payload":{},"traceId":"__TRACE_ID__","spanId":"__SPAN_ID__","sampled":true,"headers":[["x-first","1"],["x-second","2"]]}"#
        );
    }

    #[test]
    fn an_absent_member_is_dropped_rather_than_written_as_null() {
        // The broadcast scenario's client frames carry no span, so the trio is absent as a unit.
        let request = Request {
            id: id(9101),
            tag: Some(Value::String("idle".to_owned())),
            payload: Some(Value::Object(serde_json::Map::new())),
            trace: None,
            headers: Some(vec![]),
            notification: false,
        };
        assert_eq!(
            request.encode(),
            r#"{"_tag":"Request","id":9101,"tag":"idle","payload":{},"headers":[]}"#
        );
        // An ack with no id is `JSON.stringify` dropping an `undefined` member, not a null it never
        // had — the one shape where a read and a write disagree on the key.
        let ack = Message::Ack {
            request_id: Id::Absent,
        };
        assert_eq!(ack.encode(), r#"{"_tag":"Ack"}"#);
        assert_eq!(
            interrupt_without_a_fiber(),
            r#"{"_tag":"Interrupt"}"#,
            "and a cause whose fiber is unknown loses the key the same way"
        );
    }

    fn interrupt_without_a_fiber() -> String {
        Cause::Interrupt { fiber_id: None }.to_value().to_string()
    }

    /// The two shapes the capture sent as raw text and the server accepted, which are the only
    /// evidence for what an absent `tag` and an absent `payload` cost. Both read back to the same
    /// bytes, so the pair is the identity on them.
    #[test]
    fn the_two_frames_that_ask_for_their_missing_keys() {
        for recorded in [
            r#"{"_tag":"Request","id":9010,"payload":{},"headers":[]}"#,
            r#"{"_tag":"Request","id":9007,"tag":"scalarSuccess","headers":[]}"#,
            r#"{"_tag":"Request","id":9002,"tag":"emptyInEmptyOut","payload":{},"headers":[]}"#,
        ] {
            let document = serde_json::from_str::<Value>(recorded).expect("a recorded frame");
            let message = Message::read(&document).expect("a request");
            assert_eq!(message.encode(), recorded);
        }
        // The empty `tag` is the `Object.hasOwn` answer, not the word `undefined`, which is what
        // separates `b.requestWithoutTag` from `b.missingTag`.
        let untagged = Message::read(
            &serde_json::from_str::<Value>(r#"{"_tag":"Request","id":9010,"headers":[]}"#).unwrap(),
        )
        .expect("a request");
        let Message::Request(request) = &untagged else {
            panic!("the recorded frame is a request")
        };
        assert_eq!(request.group_key(), "");
        assert_eq!(request.tag, None);
    }

    #[test]
    fn void_and_the_empty_struct_are_one_word_apart() {
        for (exit, expected) in [
            (
                Exit::Success { value: Value::Null },
                r#"{"_tag":"Exit","requestId":4,"exit":{"_tag":"Success","value":null}}"#,
            ),
            (
                Exit::Success {
                    value: Value::Object(serde_json::Map::new()),
                },
                r#"{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":{}}}"#,
            ),
        ] {
            let request_id = if expected.contains("\"requestId\":4") {
                id(4)
            } else {
                id(0)
            };
            let frame = Message::Exit {
                request_id,
                exit: exit.to_value(),
            };
            assert_eq!(frame.encode(), expected);
            // Read back through the typed view, because the hole is the only place the difference
            // lives and a client that cannot tell them apart decodes `null` as a value.
            assert_eq!(
                Message::read(&serde_json::from_str::<Value>(expected).unwrap()),
                Some(frame)
            );
        }
    }

    #[test]
    fn the_refusal_text_is_written_from_the_value_the_client_sent() {
        let die = Message::die_frame(
            id(9001),
            &Defect::Text("Unknown request tag: nope".to_owned()),
        );
        assert_eq!(
            die.encode(),
            r#"{"_tag":"Exit","requestId":9001,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: nope"}]}}"#
        );
        assert_eq!(
            Message::defect_frame(&Defect::Error {
                name: "SyntaxError".to_owned(),
                message: "Unexpected end of JSON input".to_owned(),
                cause: None,
            })
            .encode(),
            r#"{"_tag":"Defect","defect":{"name":"SyntaxError","message":"Unexpected end of JSON input"}}"#,
            "a thrown error crosses as the object the codec rebuilt, in `name,message` order"
        );
    }
}
