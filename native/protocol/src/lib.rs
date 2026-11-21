//! The RPC envelope wire format, byte for byte.
//!
//! This is the first layer of the Rust server's transport: the text a WebSocket frame carries
//! between a shipped client and the server, as `RpcSerialization.layerJson` writes it. Ported from
//! `apps/server/src/ws.ts`'s serialization choice and the Effect RPC framing it delegates to —
//! `RpcSerialization.ts:126-132` (decode), the message literals in `RpcClient.ts:374-386` and
//! `RpcServer.ts:660-726`, and the `RpcMessage` union at `RpcMessage.ts:438-472`.
//!
//! Only the *envelope* lives here. The nine members are group-independent, so nothing in this crate
//! knows what an rpc is, what its payload schema expects, or which connection a message belongs to;
//! those are the layers above, and keeping them out is what makes the byte order testable without a
//! runtime. There is deliberately no socket in this crate either: reading and writing frames is a
//! pure transform over `&str`, which is what lets the golden replay 125 recorded frames in a test.
//!
//! Three things the port cannot get from a schema and had to measure, each of them a claim the
//! golden in `tests/envelope_golden.rs` recomputes rather than restates:
//!
//! - **Key order is the construction site's, not the schema's.** A `Request` writes
//!   `_tag,id,tag,payload,traceId,spanId,sampled,headers`; `RequestEncodedSchema` lists `headers`
//!   third. `JSON.stringify` follows the literal.
//! - **`Schema.Void` crosses as `null`**, which is the only difference on the wire between an rpc
//!   that returns nothing and one that returns `{}`.
//! - **Nothing validates the envelope.** A frame is `JSON.parse`d and the first field the server's
//!   code *touches* is what fails, so the failure strings are `String(value)` renderings of
//!   whatever the client sent — including the empty string a `[]` id becomes.
//!
//! *Evidence:* `apps/server/scripts/protocol-golden.ts`, run twice and compared with `cmp`. The
//! recorded text is the specification; this crate is expected to reproduce it from the bytes alone.

pub mod coerce;
pub mod envelope;
pub mod frame;
pub mod json;

pub use envelope::{Cause, Defect, Exit, Headers, Id, Message, Request, Trace};
pub use frame::{Envelope, Frame, invalid_request_id, unknown_request_tag};
pub use json::{Syntax, parse, stringify};
