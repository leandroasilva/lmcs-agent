//! Reading one WebSocket frame, which is `JSON.parse` plus the batch rule and nothing else.
//!
//! `RpcSerialization.layerJson`'s decoder (`RpcSerialization.ts:126-132`) is three lines:
//!
//! ```text
//! const decoded = JSON.parse(text)
//! return Array.isArray(decoded) ? decoded : [decoded]
//! ```
//!
//! There is **no** schema on this path. `RpcMessage.EncodedSchema` is only consulted by serializers
//! whose `codecFor` returns bytes, so a frame is never rejected for having the wrong shape — it is
//! rejected, if at all, at the first field the server's own code touches. That is why the outcomes
//! below are keyed on what the loop *reads* rather than on what a validator would say:
//!
//! - `[]` is a batch of zero messages, so nothing is answered and the connection lives.
//! - `[{}]` is a batch of one non-message, so it is answered exactly like a bare `{}`.
//! - `null` and `[null]` are the two frames that kill the connection, because reading `._tag` off
//!   `null` throws inside the transport handler rather than yielding `undefined`.
//! - a frame that is not JSON at all is answered with a `Defect` carrying a SyntaxError object.
//!
//! The batch answers **in order and independently**: `b.batchOfTwo` recorded two `Exit` frames, one
//! per request, on one connection.

use serde_json::Value;

use crate::envelope::{Id, Message};
use crate::json::{Syntax, parse};

/// A frame as the transport hands it to the protocol loop.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    /// `JSON.parse` threw, so the loop never saw a value. The shipped answer is a `Defect` whose
    /// defect is the error object — `{"name":"SyntaxError","message":…}` — and the connection
    /// carries on.
    Refused(Syntax),
    /// The decoded document, one entry per message. A bare object is a batch of one here, which is
    /// what the decoder's `[decoded]` means.
    Batch(Vec<Envelope>),
}

/// One element of a batch, as far as the envelope layer can tell before the group is consulted.
///
/// The size spread is the point rather than an accident to box away: a frame is classified, matched
/// once by the loop and dropped, so 304 bytes on the stack beats a `Box` per envelope on the two
/// arms that matter (`Message` and the raw holes it carries).
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub enum Envelope {
    Message(Message),
    /// Reading `._tag` off this value throws, which ends the connection without a frame.
    Teardown,
    /// A value whose `._tag` names none of the nine. `tag` is the text the switch will interpolate.
    Other {
        tag: String,
    },
}

impl Frame {
    /// `layerJson`'s `decode`, from the frame's text.
    pub fn decode(text: &str) -> Self {
        match parse(text) {
            Err(syntax) => Self::Refused(syntax),
            Ok(Value::Array(items)) => Self::Batch(items.iter().map(Envelope::read).collect()),
            Ok(document) => Self::Batch(vec![Envelope::read(&document)]),
        }
    }

    /// The messages of a batch that the server's switch routes rather than rejects. A batch of two
    /// routes two, and `[]` routes none, which is the whole of what a batch does.
    #[must_use]
    pub fn routed(&self) -> Vec<&Message> {
        match self {
            Self::Refused(_) => Vec::new(),
            Self::Batch(items) => items
                .iter()
                .filter_map(|item| match item {
                    Envelope::Message(message) if message.is_from_client() => Some(message),
                    _ => None,
                })
                .collect(),
        }
    }
}

impl Envelope {
    pub fn read(value: &Value) -> Self {
        let Some(tag) = crate::coerce::underscore_tag(value) else {
            return Self::Teardown;
        };
        match Message::read(value) {
            Some(message) => Self::Message(message),
            // The default arm of the switch reads `(request as any)._tag`, so a value that is not
            // even an object arrives here as `undefined` spelled out.
            None => Self::Other { tag },
        }
    }

    /// The envelope-level refusal, which needs no group: a `_tag` outside the nine is answered with
    /// a broadcast `Defect` because there is no id to reply to (`RpcServer.ts:818`).
    #[must_use]
    pub fn rejection(&self) -> Option<String> {
        match self {
            Self::Other { tag } => Some(unknown_request_tag(tag)),
            Self::Teardown | Self::Message(_) => None,
        }
    }
}

impl Message {
    /// Whether the server's `switch` routes this tag instead of rejecting it (`RpcServer.ts:765-819`):
    /// `Request`, `Ping`, `Eof`, `Ack`, `Interrupt`. The other four envelopes a client could write —
    /// `Chunk`, `Exit`, `Defect`, `Pong` — are server-to-client messages, and sending one is a
    /// protocol error the server answers with a `Defect`. Measured for `b.pongFromClient`,
    /// `b.chunkFromClient` and `b.exitFromClient`; `b.eofFromClient` and `b.ackUnknownRequest` are
    /// the routed pair, and both got **no** frame back, which is the difference between forwarding
    /// a message to a handler that ignores it and rejecting one.
    #[must_use]
    pub fn is_from_client(&self) -> bool {
        matches!(
            self,
            Self::Request(_) | Self::Ping | Self::Eof | Self::Ack { .. } | Self::Interrupt { .. }
        )
    }

    /// The refusal a `Request` earns before its tag is looked up: `typeof id` is neither `"number"`
    /// nor `"string"` (`RpcServer.ts:769-776`). The gate runs **before** the group lookup, so
    /// `b.idNull` with a tag the group knows is still answered by id.
    #[must_use]
    pub fn rejection(&self) -> Option<String> {
        match self {
            Self::Request(request) if !request.id.is_valid() => {
                Some(invalid_request_id(&request.id))
            }
            Self::Request(_)
            | Self::Ping
            | Self::Eof
            | Self::Ack { .. }
            | Self::Interrupt { .. } => None,
            other => Some(unknown_request_tag(other.tag())),
        }
    }
}

/// `Unknown request tag: ${…}`, the template at `RpcServer.ts:818` and, with the request's own tag,
/// the one at `:780`.
#[must_use]
pub fn unknown_request_tag(tag: &str) -> String {
    format!("Unknown request tag: {tag}")
}

/// `Invalid request id: ${…}` (`RpcServer.ts:775`).
#[must_use]
pub fn invalid_request_id(id: &Id) -> String {
    format!("Invalid request id: {}", id.text())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Request;

    #[test]
    fn a_bare_object_and_a_batch_of_one_are_the_same_answer() {
        assert_eq!(
            Frame::decode("{}"),
            Frame::Batch(vec![Envelope::Other {
                tag: "undefined".to_owned()
            }])
        );
        assert_eq!(Frame::decode("[{}]"), Frame::decode("{}"));
        assert_eq!(Frame::decode("[]"), Frame::Batch(Vec::new()));
        assert_eq!(Frame::decode("[]").routed().len(), 0);
    }

    #[test]
    fn null_kills_and_everything_else_is_answered() {
        assert_eq!(
            Frame::decode("null"),
            Frame::Batch(vec![Envelope::Teardown])
        );
        assert_eq!(Frame::decode("[null]"), Frame::decode("null"));
        assert_eq!(
            Frame::decode("42"),
            Frame::Batch(vec![Envelope::Other {
                tag: "undefined".to_owned()
            }])
        );
    }

    #[test]
    fn a_batch_routes_each_member_on_its_own() {
        let frame = Frame::decode(
            r#"[{"_tag":"Request","id":9400,"tag":"voidSuccess","payload":{},"headers":[]},{"_tag":"Request","id":9401,"tag":"scalarSuccess","payload":null,"headers":[]}]"#,
        );
        assert_eq!(frame.routed().len(), 2);
        let ids: Vec<String> = frame
            .routed()
            .iter()
            .map(|message| match message {
                Message::Request(Request { id, .. }) => id.text(),
                _ => unreachable!("routed only forwards requests here"),
            })
            .collect();
        assert_eq!(ids, vec!["9400".to_owned(), "9401".to_owned()]);
    }

    #[test]
    fn a_client_cannot_write_a_server_envelope() {
        // The four are members of the union, so they decode; the switch has no arm for them, so
        // they are rejected by name. Measured for Pong, Chunk and Exit.
        for (text, tag) in [
            (r#"{"_tag":"Pong"}"#, "Pong"),
            (r#"{"_tag":"Chunk","requestId":1,"values":[]}"#, "Chunk"),
            (r#"{"_tag":"Exit","requestId":1,"exit":{}}"#, "Exit"),
            (r#"{"_tag":"Defect","defect":"x"}"#, "Defect"),
        ] {
            let Frame::Batch(items) = Frame::decode(text) else {
                panic!("every one of these is a document");
            };
            let Envelope::Message(message) = &items[0] else {
                panic!("{text} names one of the nine");
            };
            assert!(!message.is_from_client());
            assert_eq!(
                message.rejection().as_deref(),
                Some(unknown_request_tag(tag).as_str()),
            );
            assert_eq!(message.encode(), text, "and each re-writes byte for byte");
        }
    }
}
