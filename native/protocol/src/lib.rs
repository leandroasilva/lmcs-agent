//! The RPC envelope wire format, byte for byte.
//!
//! This is the first layer of the Rust server's transport: the text a WebSocket frame carries
//! between a shipped client and the server, as `RpcSerialization.layerJson` writes it. Ported from
//! `apps/server/src/ws.ts`'s serialization choice and the Effect RPC framing it delegates to —
//! `RpcSerialization.ts:126-132` (decode), the message literals in `RpcClient.ts:374-386` and
//! `RpcServer.ts:660-726`, and the `RpcMessage` union at `RpcMessage.ts:438-472`.
//!
//! Two halves live here: the **envelope** (`envelope`, `frame`, `json`, `coerce`) and the
//! **connection** (`session`, `websocket`, `deflate`, `http`, `transport`, `auth`, `scopes`). Both are
//! group-independent in the sense that matters: neither knows what an rpc is, what its payload schema
//! expects, or which socket it came from. The schemas belong to `native/contracts` and the socket
//! belongs above this crate, and keeping them out is what makes the byte order and the routing
//! testable without a runtime — `session` takes a `&str` and returns the messages to write, and
//! `transport` takes bytes and returns bytes, which is why the goldens replay whole connections,
//! scenario by scenario, inside a test.
//!
//! Three things the port cannot get from a schema and had to measure, each of them a claim the
//! goldens in `tests/` recompute rather than restate:
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
//! The transport half adds a fourth: **a teardown and a fault are different endings.** The protocol's
//! own `8800` leaves TCP open; a close the client sent, and every framing fault, FINs. No reading of
//! the RFC produces that, so `http`/`websocket`/`deflate`/`transport` are pinned by
//! `apps/server/scripts/upgrade-golden.ts` instead.
//!
//! The credential half adds a fifth, and it is the one an attacker reaches: **there are two base64url
//! decoders in this path and they disagree** (`auth`), and a refusal's text is decided by which of two
//! error unions a branch belongs to (`scopes`). Both are pinned by
//! `apps/server/scripts/auth-golden.ts`. A sixth belongs to the seam and is the one a router-shaped port
//! gets backwards: **a `/ws` request with no ticket is not an unauthenticated request** — the route falls
//! through to the session cookie, `Bearer`, `DPoP` and the dev cookie, in that order
//! ([`auth::authenticate_request`]), and it is the *credential* rather than the framing that decides
//! whether a row records a connection. Pinned by `apps/server/scripts/seam-golden.ts`. A seventh belongs
//! to the same seam: **a bound token's proof is verified rather than skipped** (`dpop`), which is why the
//! crate carries its own ECDSA P-256 verifier — there is no asymmetric verification crate offline.
//!
//! *Evidence:* `apps/server/scripts/protocol-golden.ts`, `apps/server/scripts/upgrade-golden.ts`,
//! `apps/server/scripts/auth-golden.ts` and `apps/server/scripts/seam-golden.ts`, each run twice and
//! compared with `cmp`. The recorded text is the specification; this crate is expected to reproduce it
//! from the bytes alone.

pub mod auth;
pub mod coerce;
pub mod deflate;
pub mod dpop;
pub mod envelope;
pub mod frame;
pub mod headers;
pub mod http;
pub mod json;
pub mod scopes;
pub mod session;
pub mod transport;
pub mod websocket;

pub use auth::{
    Claims, CredentialNames, Denial, PayloadError, RequestDenial, SessionDenial, Stored,
    StoredSession, Verified, VerifiedSession, authenticate_request, authenticate_upgrade, mint,
    select_request_credential, sign_payload, verify, verify_session,
};
pub use deflate::{Negotiated, negotiate};
pub use envelope::{Cause, Defect, Exit, Headers, Id, Message, Request, Trace};
pub use frame::{Envelope, Frame, invalid_request_id, unknown_request_tag};
pub use http::{Cookies, Denied, accept, query_param, refuse, routed, upgrade};
pub use json::{Syntax, parse, stringify};
pub use scopes::{
    RPC_REQUIRED_SCOPES, UndeclaredScope, authorization_error, grants, required_scope,
    required_scope_for_device_list,
};
pub use session::{Group, Handler, Outcome, Payload, Reply, Session};
pub use transport::{Connection, Output};
