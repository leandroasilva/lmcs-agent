//! One socket: bytes in, bytes out, and the four ways a connection can end.
//!
//! [`crate::session`] reads a *text frame* and answers with *messages*; this module is what turns a
//! socket's bytes into text frames and the messages back into bytes. It is the last layer before a
//! Rust server can speak to an unmodified `apps/web`, and it is where the transport's measured
//! oddities live, because none of them are guessable from RFC 6455:
//!
//! - **Two kinds of ending.** A protocol-level teardown writes a zero-body `8800` and **leaves TCP
//!   open**; a close the client sent, and every framing fault, writes a close and FINs
//!   (`upgrade-golden.ts`, the `tcpAfterClose` table over the `teardown.*` and `client.*` cases).
//!   Both silence the connection, so the state machine distinguishes *dead* from *hung up* — and a dead
//!   connection can still be hung up, because the peer answering a teardown with its own close finishes
//!   the handshake (`teardown.thenClientClose`).
//! - **Binary is text.** A frame with opcode 2 carrying a JSON `Request` was answered normally
//!   (`client.binary`), so the UTF-8 gate only ever applies to opcode 1.
//! - **Control frames interleave with fragments** (`client.fragmentedPing`) and do not disturb the
//!   message being assembled, which is why the half-open message is state on this struct rather than
//!   a position in a buffer.
//! - **A non-minimal head is accepted** on the way in and never produced on the way out; both
//!   directions are the head rules in [`crate::websocket`].
//!
//! `permessage-deflate` is a per-direction stream rather than a per-frame flag, so inbound fragments
//! are inflated as they arrive and outbound answers are deflated through one context unless takeover
//! was refused — see [`crate::deflate`]. Which answers get RSV1 set is the negotiated rule
//! ([`Negotiated::compresses`]), applied per message.
//!
//! Above the socket sits [`authenticated`], the seam: the ticket, the handshake and this module's
//! connection, in the order the shipped route runs them. Everything below that function is what a
//! connection does once it exists.

use crate::deflate::{Inbound, Negotiated, Outbound};
use crate::envelope::Id;
use crate::session::Session;
use crate::websocket::{
    self, BINARY, CLOSE, CONTINUATION, Fault, Head, PING, PONG, Read, TEXT, Violation,
};

/// What one [`Connection::push`] costs the socket.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Output {
    /// The bytes to write, in order — empty when the input was only half a frame.
    pub frames: Vec<Vec<u8>>,
    /// Whether to FIN after `frames`. True for a close the peer asked for and for every fault, false
    /// for the protocol's own teardown, which the capture measured with TCP still open.
    pub hang_up: bool,
}

impl Output {
    /// The bytes to write as one buffer, for a caller with a single write call.
    #[must_use]
    pub fn bytes(&self) -> Vec<u8> {
        self.frames.concat()
    }

    /// A fault's answer: the close carrying its code, then FIN.
    fn fail(mut self, fault: Fault) -> Self {
        self.frames.push(websocket::refuse(fault));
        self.hang_up = true;
        self
    }

    /// The last thing this connection writes. `hang_up` false is the teardown's `8800`, which the
    /// server leaves for the peer to finish.
    fn finish(mut self, frames: Vec<Vec<u8>>, hang_up: bool) -> Self {
        self.frames.extend(frames);
        self.hang_up = hang_up;
        self
    }
}

/// One connection's transport: the protocol loop, the deflate streams, and the socket's leftovers.
pub struct Connection {
    session: Session,
    /// `None` is a connection that never negotiated `permessage-deflate`, which is both a plain write
    /// path and a head rule: RSV1 becomes a 1002.
    streams: Option<Streams>,
    /// The message whose last fragment has not arrived yet.
    open: Option<Open>,
    /// Bytes read from the socket that do not yet make a whole frame.
    buffer: Vec<u8>,
    /// Whether this connection has written its close, whatever TCP did after.
    dead: bool,
}

struct Streams {
    agreed: Negotiated,
    inbound: Inbound,
    outbound: Outbound,
}

struct Open {
    /// `TEXT` or `BINARY`, i.e. whether the finished message has to be UTF-8.
    opcode: u8,
    /// Whether the message's fragments are deflated, taken from the first frame's RSV1.
    compressed: bool,
    bytes: Vec<u8>,
}

/// What one whole frame said the connection should do.
enum Written {
    /// Answer and keep going — every ordinary frame, and a `Pong` in answer to a `Ping`.
    Frames(Vec<Vec<u8>>),
    /// Answer, then FIN: the peer asked to close.
    Ends(Vec<Vec<u8>>),
    /// Answer with the protocol's own `8800` and go silent without touching TCP.
    Detaches(Vec<Vec<u8>>),
    /// Answer with a close carrying this fault's code, then FIN.
    Fault(Fault),
}

impl Connection {
    /// The connection a finished upgrade starts, which is the one place the two facts a handshake
    /// produced meet: what the client was told about `permessage-deflate`, and the headers its request
    /// carried. Building the [`Session`] by hand instead is a different server — `headers.*` measured
    /// the pairs a handler sees coming from the **request**, not from the frame.
    #[must_use]
    pub fn upgraded(
        request: &crate::http::Request<'_>,
        group: crate::session::Group,
        agreed: Option<Negotiated>,
    ) -> Self {
        Self::new(Session::upgraded(group, request.handler_headers()), agreed)
    }

    /// The same connection with the ticket's scopes in front of its dispatch, which is what the shipped
    /// route serves: see [`authenticated`] for why the gate cannot be added later.
    #[must_use]
    pub fn gated(
        request: &crate::http::Request<'_>,
        group: crate::session::Group,
        gate: crate::session::Gate,
        agreed: Option<Negotiated>,
    ) -> Self {
        Self::new(
            Session::gated(group, request.handler_headers(), gate),
            agreed,
        )
    }

    /// `agreed` is what [`crate::deflate::negotiate`] produced for this connection's upgrade, i.e. the
    /// answer written in `Sec-WebSocket-Extensions`.
    #[must_use]
    pub fn new(session: Session, agreed: Option<Negotiated>) -> Self {
        Self {
            session,
            streams: agreed.map(|agreed| Streams {
                inbound: Inbound::new(&agreed),
                outbound: Outbound::new(&agreed),
                agreed,
            }),
            open: None,
            buffer: Vec::new(),
            dead: false,
        }
    }

    /// The socket spoke. `bytes` is whatever one read produced, so a call may carry several frames,
    /// half a frame, or neither.
    pub fn push(&mut self, bytes: &[u8]) -> Output {
        self.buffer.extend_from_slice(bytes);
        let mut out = Output::default();
        loop {
            let (head, consumed, len) =
                match websocket::read_head(&self.buffer, self.streams.is_some()) {
                    Read::Partial => return out,
                    // Already silent: a frame this late is not answered, and not a fault either.
                    Read::Refused(_) if self.dead => return out,
                    Read::Refused(fault) => {
                        self.dead = true;
                        return out.fail(fault);
                    }
                    Read::Complete(head, consumed) => match usize::try_from(head.len) {
                        // 2^53-1 fits any 64-bit `usize`, so this only fires on a host that could not
                        // hold the frame either way.
                        Err(_) => {
                            self.dead = true;
                            return out.fail(Fault::Head(Violation::BeyondSafeInteger));
                        }
                        // Body first: a head whose payload has not fully arrived is not a frame yet.
                        Ok(len) if consumed + len > self.buffer.len() => return out,
                        Ok(len) => (head, consumed, len),
                    },
                };
            let mut payload = self.buffer[consumed..consumed + len].to_vec();
            websocket::unmask(&mut payload, head.mask);
            self.buffer.drain(..consumed + len);
            if self.dead {
                // Nothing is answered after our own close, whatever arrives. What the peer's close *does*
                // do is finish the socket, which is the difference the capture drew between
                // `teardown.thenCanary` (still open after the `8800`) and `teardown.thenClientClose`
                // (FIN) — `ws` completes a closing handshake it started, but a teardown alone is not one.
                if head.opcode == CLOSE {
                    out.hang_up = true;
                    return out;
                }
                continue;
            }
            match self.take(head, payload) {
                Written::Frames(frames) => out.frames.extend(frames),
                Written::Ends(frames) => {
                    self.dead = true;
                    return out.finish(frames, true);
                }
                Written::Detaches(frames) => {
                    self.dead = true;
                    return out.finish(frames, false);
                }
                Written::Fault(fault) => {
                    self.dead = true;
                    return out.fail(fault);
                }
            }
        }
    }

    /// The producer of a stream ran out of values, so its terminal `Exit` goes on the wire.
    ///
    /// A separate call rather than part of [`push`][Self::push] because the transport is what has to
    /// deflate the exit: the loop knows a stream ended, only whoever runs the handler knows *when*.
    /// Framing an exit through a different path than its chunks would put two deflate contexts on one
    /// message, which is the bug `permessage-deflate` goldens exist to catch.
    pub fn end(&mut self, request_id: &Id) -> Output {
        if self.dead {
            return Output::default();
        }
        let frames = self
            .session
            .end(request_id)
            .iter()
            .map(|message| self.write(message.encode()))
            .collect();
        Output {
            frames,
            hang_up: false,
        }
    }

    /// One whole decoded frame, already unmasked.
    fn take(&mut self, head: Head, payload: Vec<u8>) -> Written {
        match head.opcode {
            // A ping is echoed byte for byte and a pong is dropped; both leave the connection open
            // (`client.pingDuringStream`, `client.pong`).
            PING => Written::Frames(vec![websocket::encode(PONG, &payload, false)]),
            PONG => Written::Frames(Vec::new()),
            CLOSE => self.close(&payload),
            CONTINUATION | TEXT | BINARY => self.data(head, payload),
            other => Written::Fault(Fault::Head(Violation::UnknownOpcode(other))),
        }
    }

    /// A close is echoed rather than rewritten — code *and* reason — and either way the socket goes.
    fn close(&mut self, payload: &[u8]) -> Written {
        if payload.len() < 2 {
            // `client.zeroLengthClose`: the echo is the codeless `8800`, and TCP still FINed.
            return Written::Ends(vec![websocket::close(None, &[])]);
        }
        let code = u16::from_be_bytes([payload[0], payload[1]]);
        let reason = &payload[2..];
        if std::str::from_utf8(reason).is_err() {
            return Written::Fault(Fault::NotUtf8);
        }
        Written::Ends(vec![websocket::close(Some(code), reason)])
    }

    /// A data frame: assembled, inflated, decoded, answered, deflated, written.
    fn data(&mut self, head: Head, payload: Vec<u8>) -> Written {
        let mut message = if head.opcode == CONTINUATION {
            // RSV1 marks the *first* frame of a deflated message, so a continuation may not set it.
            if head.rsv1 {
                return Written::Fault(Fault::Head(Violation::Rsv1Unoffered));
            }
            let Some(message) = self.open.take() else {
                return Written::Fault(Fault::Head(Violation::ContinuationWithoutFrame));
            };
            message
        } else {
            if self.open.is_some() {
                return Written::Fault(Fault::Head(Violation::OverlappingData));
            }
            Open {
                opcode: head.opcode,
                compressed: head.rsv1,
                bytes: Vec::new(),
            }
        };
        let body = if message.compressed {
            // `read_head` only lets RSV1 through on a connection that negotiated the extension, so a
            // missing stream here is a bug rather than an input. Refused rather than assumed, because
            // the release profile aborts on a panic.
            let Some(streams) = self.streams.as_mut() else {
                return Written::Fault(Fault::Head(Violation::Rsv1Unoffered));
            };
            match streams.inbound.inflate(&payload, head.fin) {
                Ok(body) => body,
                // The head was legal; the bytes were not a continuation of this stream.
                Err(()) => return Written::Fault(Fault::NotDeflated),
            }
        } else {
            payload
        };
        message.bytes.extend_from_slice(&body);
        if !head.fin {
            self.open = Some(message);
            return Written::Frames(Vec::new());
        }
        // Only text is gated, and only once the message is whole: a fragment boundary can fall inside
        // a multi-byte character, so the check cannot run per frame.
        if message.opcode == TEXT && std::str::from_utf8(&message.bytes).is_err() {
            return Written::Fault(Fault::NotUtf8);
        }
        let text = String::from_utf8_lossy(&message.bytes).into_owned();
        self.answer(&text)
    }

    /// Run the protocol loop and write its answer.
    fn answer(&mut self, text: &str) -> Written {
        let reply = self.session.receive(text);
        let mut frames: Vec<Vec<u8>> = reply
            .frames()
            .iter()
            .map(|message| self.write(message.encode()))
            .collect();
        if reply.closes() {
            // Frames a batch produced before the teardown go out ahead of it, which is only visible if
            // both are written (`c.batchTwoThenNull`).
            frames.push(websocket::close(None, &[]));
            return Written::Detaches(frames);
        }
        Written::Frames(frames)
    }

    /// Frame one message the loop produced, deflating it when the negotiation says to.
    fn write(&mut self, text: String) -> Vec<u8> {
        let bytes = text.into_bytes();
        let Some(streams) = self.streams.as_mut() else {
            return websocket::encode(TEXT, &bytes, false);
        };
        if streams.agreed.compresses(bytes.len()) {
            let body = streams.outbound.compress(&bytes, true);
            return websocket::encode(TEXT, &body, true);
        }
        websocket::encode(TEXT, &bytes, false)
    }
}

// ---------------------------------------------------------------------------
// The seam: the ticket, then the handshake, then the gate
// ---------------------------------------------------------------------------

/// What the upgrade route decided about one request, in the order it decides it.
///
/// The name is the point: this is where [`crate::auth`], [`crate::http`] and [`crate::session`] stop
/// being three separately measured pieces and become the one server a client meets. Three of its
/// orderings are measurements rather than choices, all of them from `seam-golden.ts`:
///
/// - **Auth runs before the framing checks.** A bad ticket *and* a bad `Sec-WebSocket-Key` answers 401,
///   not the 400 `ws` would have written (`seam.badTicketBadKey`). Composing
///   [`crate::http::Request::refusal`] in front of [`crate::auth`] — the obvious way to write this —
///   answers the wrong status for the wrong reason.
/// - **A refused ticket writes nothing.** No origin read, no `recordClientConnection`, no mark: the row
///   still has a null `last_connected_at` for all eight refusals, including the one whose payload was
///   unreadable (`seam.badSignature`).
/// - **The route runs before the answer that only *looks* like a routing answer.** A `GET /ws` with a
///   valid ticket and no `Upgrade` header gets the platform's chunked 400 *after* the row was recorded
///   and marked, and — unlike [`Seam::Refused`] — that mark is released (`seam.notUpgradeAuthorized`).
///
/// The caller's side effects are part of the shape, and they go in this order: write the row's
/// attribution from `origin`, mark `session_id` connected, write `head`. On [`Seam::Connected`] only,
/// release the mark when the socket is gone.
pub enum Seam {
    /// The `101` and a connection whose dispatch is already gated by the ticket's row. The gate cannot
    /// be bolted on later: `ws.ts:3811` builds the rpc layer *around* the authenticated session, so a
    /// connection without one answers methods the credential never covered.
    ///
    /// Boxed because the seam is one answer per request and most requests are refused: only this arm
    /// carries the deflate contexts, the half-assembled message and the gated session, and the other four
    /// should not be sized by them.
    Connected {
        session_id: String,
        origin: crate::http::Origin,
        head: Vec<u8>,
        connection: Box<Connection>,
    },
    /// The ticket was refused, or absent, and nothing else in the route ran.
    Denied {
        denied: crate::http::Denied,
        head: Vec<u8>,
    },
    /// `ws` refused the framing after the route had already accepted the credential. `markConnected` ran
    /// and `markDisconnected` never will, because the handler's use is abandoned rather than returned
    /// from, so the shipped server leaves the row counting a connection that was never made
    /// (`seam.badKeyAuthorized`, `seam.badExtensionsAuthorized`). A port that tidied that up would be
    /// writing a different database than the one clients meet today.
    Refused {
        session_id: String,
        origin: crate::http::Origin,
        refusal: crate::http::Refusal,
        head: Vec<u8>,
    },
    /// The credential is good and the request is not a socket, so the route ran and the response pipeline
    /// answered. Not [`crate::http::Refusal`]'s neighbour: those bytes come from `ws`, which never saw
    /// this request.
    NotUpgrade {
        session_id: String,
        origin: crate::http::Origin,
        head: Vec<u8>,
    },
    /// The method is not the route's. Answered before auth, because nothing matched: the row is untouched
    /// (`seam.postWs`), which is the one ordering claim here that a *port over-eagerly authenticating*
    /// would get wrong.
    NoRoute { head: Vec<u8> },
}

/// Prints what the seam decided, which is the head and the row it named. A [`Connection`] is left out
/// because it holds deflate contexts and a half-assembled message, none of which a failing test wants
/// printed; its identity is the head above it.
impl std::fmt::Debug for Seam {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut printed = out.debug_struct("Seam");
        match self {
            Self::Connected {
                session_id,
                origin,
                head,
                ..
            } => printed
                .field("variant", &"Connected")
                .field("session_id", session_id)
                .field("origin", origin)
                .field("head", &String::from_utf8_lossy(head)),
            Self::Denied { denied, head } => printed
                .field("variant", &"Denied")
                .field("denied", denied)
                .field("head", &String::from_utf8_lossy(head)),
            Self::Refused {
                session_id,
                origin,
                refusal,
                head,
            } => printed
                .field("variant", &"Refused")
                .field("session_id", session_id)
                .field("origin", origin)
                .field("refusal", refusal)
                .field("head", &String::from_utf8_lossy(head)),
            Self::NotUpgrade {
                session_id,
                origin,
                head,
            } => printed
                .field("variant", &"NotUpgrade")
                .field("session_id", session_id)
                .field("origin", origin)
                .field("head", &String::from_utf8_lossy(head)),
            Self::NoRoute { head } => printed
                .field("variant", &"NoRoute")
                .field("head", &String::from_utf8_lossy(head)),
        };
        printed.finish()
    }
}

/// Run the route's order over one request head.
///
/// `lookup` is `authSessions.getById` and `now` is the clock in integer milliseconds, both for the
/// reasons [`crate::auth::verify`] gives. `date` and `trace_id` are the caller's because Node stamps the
/// wall clock and opens no span before the route's auth step (`"unavailable"` is the measured value), and
/// the golden compares every other byte of the head.
///
/// Two boundaries this function does not cross. **Path matching** is the router's, so only the method is
/// examined here — that half is what `seam.postWs` measured. And **header/cookie credentials** belong to
/// the HTTP auth slice: `Upgrade::NoTicket` means the *ticket* said nothing, while the shipped server
/// then tries `Authorization` and the session cookie and answers `missing_credential` only when those are
/// absent too. Every `/ws` client sends a ticket, so the port refuses without them; a caller serving a
/// bearer credential over `/ws` has to grow that step here rather than assume this answered it.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn authenticated(
    request: &crate::http::Request<'_>,
    group: crate::session::Group,
    now: i64,
    secret: &[u8],
    dev_session_id: Option<&str>,
    lookup: impl FnMut(&str) -> crate::auth::Stored,
    date: &str,
    trace_id: &str,
) -> Seam {
    if request.method != "GET" {
        return Seam::NoRoute {
            head: crate::http::routed(date, crate::http::Routed::NoRoute),
        };
    }
    // The refusal's own head is written by the response pipeline, which keeps the connection alive — the
    // `Keep-Alive` the upgrade refusals lack, per `auth-golden.ts`.
    let denied = |denied: crate::http::Denied| Seam::Denied {
        head: denied.write(date, trace_id, !request.is_upgrade()),
        denied,
    };
    let verified = match crate::auth::authenticate_upgrade(
        request.target,
        now,
        secret,
        dev_session_id,
        lookup,
    ) {
        crate::auth::Upgrade::Accepted(verified) => verified,
        crate::auth::Upgrade::Denied(denial) => return denied(denial.denied()),
        crate::auth::Upgrade::NoTicket => {
            return denied(crate::http::Denied::credential("missing_credential", None));
        }
    };
    let session_id = verified.session_id.clone();
    let origin = request.client_origin();
    if !request.is_upgrade() {
        return Seam::NotUpgrade {
            session_id,
            origin,
            head: crate::http::routed(date, crate::http::Routed::NotUpgrade),
        };
    }
    if let Some(refusal) = request.refusal() {
        return Seam::Refused {
            session_id,
            origin,
            refusal,
            head: crate::http::refuse(refusal),
        };
    }
    // The extension offer is the fourth check and the only one with a body: `negotiate` both refuses and
    // produces the answer string the `101` echoes.
    let agreed = match crate::deflate::negotiate(request.extensions.unwrap_or_default()) {
        Err(_) => {
            let refusal = crate::http::Refusal::Extensions;
            return Seam::Refused {
                session_id,
                origin,
                refusal,
                head: crate::http::refuse(refusal),
            };
        }
        Ok(agreed) => agreed,
    };
    let head = crate::http::upgrade(
        request.key.unwrap_or_default(),
        request.protocol,
        agreed.as_ref().map(|agreed| agreed.answer.as_str()),
    );
    let connection = Connection::gated(request, group, verified.gate(), agreed);
    Seam::Connected {
        session_id,
        origin,
        head,
        connection: Box::new(connection),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The mask key the oracle's sockets use, so a test frame and a recorded one look alike.
    const MASK: [u8; 4] = [0x11, 0x22, 0x33, 0x44];

    /// A client frame: masked, minimal length, and `opcode` may carry RSV1 as `TEXT | 0x40` the way
    /// the head spells it.
    fn client(opcode: u8, payload: &[u8], fin: bool) -> Vec<u8> {
        let first = if fin { 0x80 } else { 0x00 } | opcode;
        let mut out = vec![first, 0x80];
        match payload.len() {
            0..=125 => out[1] |= payload.len() as u8,
            126..=65_535 => {
                out[1] |= 126;
                out.extend(
                    u16::try_from(payload.len())
                        .expect("checked by the range")
                        .to_be_bytes(),
                );
            }
            larger => {
                out[1] |= 127;
                out.extend(
                    u64::try_from(larger)
                        .expect("a usize fits in 64 bits")
                        .to_be_bytes(),
                );
            }
        }
        out.extend(MASK);
        let mut masked = payload.to_vec();
        websocket::unmask(&mut masked, MASK);
        out.extend(masked);
        out
    }

    fn request(id: i64, tag: &str) -> String {
        format!(r#"{{"_tag":"Request","id":{id},"tag":"{tag}","payload":{{}},"headers":[]}}"#)
    }

    fn plain_connection() -> Connection {
        Connection::new(
            Session::new(
                crate::session::Group::new()
                    .returns("plain", Value::Null)
                    .on("boom", |_, _| {
                        crate::session::Outcome::Broadcast("boom".to_owned())
                    }),
            ),
            None,
        )
    }

    /// `handshake.noExtensions` + `plain.voidSuccess`: one text frame, one plain answer, socket kept.
    #[test]
    fn a_plain_connection_answers_and_stays_open() {
        let mut socket = plain_connection();
        let out = socket.push(&client(TEXT, request(1, "plain").as_bytes(), true));
        assert!(!out.hang_up);
        assert_eq!(out.frames.len(), 1);
        let frame = &out.frames[0];
        assert_eq!(frame[0], 0x81, "fin, no RSV1, text");
        assert_eq!(
            String::from_utf8(frame[2..].to_vec()).expect("an answer is text"),
            r#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":null}}"#
        );
    }

    /// The wiring the replay only assumes: the upgrade head goes in and the pairs it named come out
    /// through the handler's answer. A `Connection` that dropped them would still replay every byte of
    /// `plain.*`, because those frames carry no header the socket also has.
    #[test]
    fn a_connections_handler_sees_the_upgrades_headers() {
        let request = crate::http::Request::parse(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Probe: upgrade\r\n\r\n",
        );
        let mut socket = Connection::upgraded(
            &request,
            crate::session::Group::new().on("seen", crate::session::tests::echo),
            None,
        );
        let out = socket.push(&client(
            TEXT,
            br#"{"_tag":"Request","id":1,"tag":"seen","payload":{},"headers":[["x-probe","frame"]]}"#,
            true,
        ));
        assert_eq!(out.frames.len(), 1);
        let frame = &out.frames[0];
        assert_eq!(
            String::from_utf8(frame[2..].to_vec()).expect("an answer is text"),
            r#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"pairs":[["host","127.0.0.1"],["x-probe","frame"]]}}}"#
        );
    }

    /// `teardown.nullDocument`: what the batch already produced goes out, then the bare close, and the
    /// capture found TCP still open afterwards.
    #[test]
    fn a_teardown_writes_its_close_and_leaves_tcp_open() {
        let mut socket = plain_connection();
        let batch = format!("[{},null]", request(2, "plain"));
        let out = socket.push(&client(TEXT, batch.as_bytes(), true));
        assert!(!out.hang_up);
        assert_eq!(out.frames.len(), 2, "the answer first, then the close");
        assert_eq!(out.frames[1], vec![0x88, 0x00]);
    }

    #[test]
    fn a_ping_is_echoed_and_a_pong_is_ignored() {
        let mut socket = plain_connection();
        let out = socket.push(&client(PING, b"hi", true));
        assert_eq!(out.frames, vec![vec![0x8a, 0x02, b'h', b'i']]);
        assert!(!out.hang_up);
        let out = socket.push(&client(PONG, b"hi", true));
        assert!(out.frames.is_empty());
    }

    /// The two `teardown.then*` cases differ only in what the client sends after the `8800`, and the
    /// capture's TCP table says they ended differently: a canary left the socket open, a close FINed it.
    #[test]
    fn a_dead_connection_finishes_only_on_the_peers_close() {
        let mut socket = plain_connection();
        let out = socket.push(&client(TEXT, b"null", true));
        assert_eq!(out.frames, vec![vec![0x88, 0x00]]);
        assert!(!out.hang_up, "the teardown itself leaves TCP for the peer");
        let out = socket.push(&client(TEXT, request(6, "plain").as_bytes(), true));
        assert!(
            out.frames.is_empty() && !out.hang_up,
            "`teardown.thenCanary`: answered by nothing, and still open",
        );
        let mut payload = 1000u16.to_be_bytes().to_vec();
        payload.extend_from_slice(b"after");
        let out = socket.push(&client(CLOSE, &payload, true));
        assert!(out.frames.is_empty(), "a close is not echoed twice");
        assert!(
            out.hang_up,
            "but it completes the handshake, which is what the FIN was",
        );
    }

    /// `client.closeNormal` and `client.zeroLengthClose`, both of which FINed.
    #[test]
    fn a_close_is_echoed_and_ends_the_socket() {
        let mut payload = Vec::new();
        payload.extend(1000u16.to_be_bytes());
        payload.extend_from_slice(b"bye");
        let mut socket = plain_connection();
        let out = socket.push(&client(CLOSE, &payload, true));
        assert_eq!(
            out.frames,
            vec![vec![0x88, 0x05, 0x03, 0xe8, b'b', b'y', b'e']]
        );
        assert!(out.hang_up);
        let mut socket = plain_connection();
        let out = socket.push(&client(CLOSE, &[], true));
        assert_eq!(out.frames, vec![vec![0x88, 0x00]]);
        assert!(out.hang_up);
    }

    /// `client.unmasked`, and nothing after it.
    #[test]
    fn a_fault_closes_and_silences_the_connection() {
        let mut socket = plain_connection();
        let mut frame = vec![0x81, 0x00];
        frame.extend(request(3, "plain").into_bytes());
        let out = socket.push(&frame);
        assert_eq!(out.frames, vec![vec![0x88, 0x02, 0x03, 0xea]]);
        assert!(out.hang_up);
        let out = socket.push(&client(TEXT, request(4, "plain").as_bytes(), true));
        assert!(out.frames.is_empty(), "a closed connection answers nothing");
    }

    /// One message across two frames, answered once, with a ping between them.
    #[test]
    fn a_fragmented_message_is_answered_when_its_last_fragment_lands() {
        let mut socket = plain_connection();
        let text = request(5, "plain");
        let mid = text.len() / 2;
        assert!(
            socket
                .push(&client(TEXT, &text.as_bytes()[..mid], false))
                .frames
                .is_empty(),
            "half a message is not an answer"
        );
        assert_eq!(socket.push(&client(PING, b"", true)).frames.len(), 1);
        let out = socket.push(&client(CONTINUATION, &text.as_bytes()[mid..], true));
        assert_eq!(out.frames.len(), 1);
        assert_eq!(out.frames[0][0], 0x81);
    }

    /// A continuation with nothing open, and a second start while one is unfinished.
    #[test]
    fn a_message_may_not_overlap_itself_or_start_from_nothing() {
        let mut socket = plain_connection();
        let out = socket.push(&client(CONTINUATION, b"{}", true));
        assert_eq!(out.frames, vec![vec![0x88, 0x02, 0x03, 0xea]]);

        let mut socket = plain_connection();
        socket.push(&client(TEXT, b"{", false));
        let out = socket.push(&client(TEXT, b"}", true));
        assert_eq!(out.frames, vec![vec![0x88, 0x02, 0x03, 0xea]]);
    }

    /// `client.invalidUtf8Text`, a 1007 rather than a 1002.
    #[test]
    fn text_that_is_not_utf8_is_a_bad_payload() {
        let mut socket = plain_connection();
        let out = socket.push(&client(TEXT, &[0xff, 0xfe], true));
        assert_eq!(out.frames, vec![vec![0x88, 0x02, 0x03, 0xef]]);
        assert!(out.hang_up);
    }

    /// `client.binary`: opcode 2 is read as text and answered, and is not UTF-8-gated either.
    #[test]
    fn a_binary_frame_is_read_as_text() {
        let mut socket = plain_connection();
        let out = socket.push(&client(BINARY, request(6, "plain").as_bytes(), true));
        assert_eq!(out.frames.len(), 1);
        assert!(!out.hang_up);
    }

    /// A frame split across reads, and two frames in one read.
    #[test]
    fn the_buffer_waits_for_a_whole_frame_and_then_drains() {
        let mut socket = plain_connection();
        let wire = client(TEXT, request(7, "plain").as_bytes(), true);
        let (half, rest) = wire.split_at(3);
        assert!(socket.push(half).frames.is_empty());
        assert_eq!(socket.push(rest).frames.len(), 1);

        let both = [
            client(TEXT, request(8, "plain").as_bytes(), true),
            client(TEXT, request(9, "plain").as_bytes(), true),
        ]
        .concat();
        assert_eq!(socket.push(&both).frames.len(), 2);
    }

    /// `handshake.deflate` + `plain.voidSuccess`: with takeover an answer comes back RSV1 at any size,
    /// and inflates to the text the plain connection wrote raw.
    #[test]
    fn a_deflated_connection_deflates_every_answer() {
        let agreed = crate::deflate::negotiate("permessage-deflate; client_max_window_bits")
            .unwrap()
            .expect("the browser's offer is accepted");
        let mut socket = Connection::new(
            Session::new(crate::session::Group::new().returns("plain", Value::Null)),
            Some(agreed.clone()),
        );
        let mut peer = Outbound::new(&agreed);
        let wire = client(
            TEXT | 0x40,
            &peer.compress(request(10, "plain").as_bytes(), true),
            true,
        );
        let out = socket.push(&wire);
        assert_eq!(out.frames.len(), 1);
        assert_eq!(out.frames[0][0], 0xc1, "fin, RSV1, text");
        let mut back = Inbound::new(&agreed);
        assert_eq!(
            String::from_utf8(back.inflate(&out.frames[0][2..], true).unwrap()).unwrap(),
            r#"{"_tag":"Exit","requestId":10,"exit":{"_tag":"Success","value":null}}"#
        );
    }

    /// A deflated message in two fragments: the stream runs across them and only the last one ends it.
    #[test]
    fn a_deflated_message_survives_being_fragmented() {
        let agreed = crate::deflate::negotiate("permessage-deflate")
            .unwrap()
            .unwrap();
        let mut socket = Connection::new(
            Session::new(crate::session::Group::new().returns("plain", Value::Null)),
            Some(agreed.clone()),
        );
        let mut peer = Outbound::new(&agreed);
        let text = request(11, "plain");
        let mid = text.len() / 2;
        let first = peer.compress(&text.as_bytes()[..mid], false);
        assert!(
            socket
                .push(&client(TEXT | 0x40, &first, false))
                .frames
                .is_empty()
        );
        let second = peer.compress(&text.as_bytes()[mid..], true);
        let out = socket.push(&client(CONTINUATION, &second, true));
        assert_eq!(out.frames.len(), 1);
        assert_eq!(out.frames[0][0], 0xc1);
    }

    /// An RSV1 body that is not this connection's stream is a 1007, not a crash.
    #[test]
    fn a_body_that_will_not_inflate_is_refused() {
        let agreed = crate::deflate::negotiate("permessage-deflate")
            .unwrap()
            .unwrap();
        let mut socket = Connection::new(
            Session::new(crate::session::Group::new().returns("plain", Value::Null)),
            Some(agreed),
        );
        let out = socket.push(&client(TEXT | 0x40, b"raw text", true));
        assert_eq!(out.frames, vec![vec![0x88, 0x02, 0x03, 0xef]]);
        assert!(out.hang_up);
    }

    /// A defect outside every request still arrives as a frame and keeps the connection.
    #[test]
    fn a_broadcast_defect_keeps_the_connection() {
        let mut socket = plain_connection();
        let out = socket.push(&client(TEXT, request(12, "boom").as_bytes(), true));
        assert!(!out.hang_up);
        let body = String::from_utf8(out.frames[0][2..].to_vec()).unwrap();
        assert!(body.starts_with(r#"{"_tag":"Defect""#), "got {body}");
    }

    /// `frame.streamStaged`: a stream's chunks and its terminal `Exit` travel through the one outbound
    /// context, so the exit arrives RSV1 and inflates *after* the chunks rather than on its own.
    #[test]
    fn a_streams_exit_is_framed_by_the_same_context() {
        let agreed = crate::deflate::negotiate("permessage-deflate")
            .unwrap()
            .unwrap();
        let mut socket = Connection::new(
            Session::new(crate::session::Group::new().streams(
                "flow",
                vec![
                    vec![serde_json::json!({"i": 1})],
                    vec![serde_json::json!({"i": 2})],
                ],
            )),
            Some(agreed.clone()),
        );
        let started = socket.push(&client(TEXT, request(20, "flow").as_bytes(), true));
        let acked = socket.push(&client(
            TEXT,
            r#"{"_tag":"Ack","requestId":20}"#.as_bytes(),
            true,
        ));
        let ended = socket.end(&Id::read(Some(&Value::from(20))));
        assert_eq!(
            (started.frames.len(), acked.frames.len(), ended.frames.len()),
            (1, 1, 1),
            "one chunk per frame, then the producer's exit"
        );
        for frame in [&started.frames[0], &acked.frames[0], &ended.frames[0]] {
            assert_eq!(frame[0], 0xc1, "fin, RSV1, text");
        }
        let mut back = Inbound::new(&agreed);
        let mut text = Vec::new();
        for frame in [&started.frames[0], &acked.frames[0], &ended.frames[0]] {
            text.extend(back.inflate(&frame[2..], true).unwrap());
        }
        assert_eq!(
            String::from_utf8(text).unwrap(),
            concat!(
                r#"{"_tag":"Chunk","requestId":20,"values":[{"i":1}]}"#,
                r#"{"_tag":"Chunk","requestId":20,"values":[{"i":2}]}"#,
                r#"{"_tag":"Exit","requestId":20,"exit":{"_tag":"Success","value":null}}"#,
            )
        );
    }

    // -----------------------------------------------------------------------
    // The seam
    // -----------------------------------------------------------------------

    /// `seam-golden.ts`'s `SECRET`, generated rather than spelled so the arithmetic is visible: the same
    /// bytes are what the artifact's recorded tickets are signed with.
    const fn secret() -> [u8; 32] {
        let mut out = [0u8; 32];
        let mut index = 0;
        while index < 32 {
            out[index] = ((index * 13 + 7) & 0xff) as u8;
            index += 1;
        }
        out
    }

    /// The clock every case is measured against.
    const NOW: i64 = 1_700_000_000_000;

    const UPGRADE: &str = concat!(
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        "Sec-WebSocket-Version: 13\r\n",
    );

    /// The group the oracle served: three methods, two of them in the shipped scope table.
    fn gated_group() -> crate::session::Group {
        crate::session::Group::new()
            .returns("server.getSettings", serde_json::json!({"ok": "read"}))
            .returns(
                "server.updateSettings",
                serde_json::json!({"ok": "operate"}),
            )
            .returns("server.getConfig", serde_json::json!({"alive": true}))
    }

    /// A row the ticket can name.
    fn stored(scopes: &[&str]) -> crate::auth::Stored {
        crate::auth::Stored::Found(crate::auth::StoredSession {
            session_id: "seam_read".to_owned(),
            expires_at: NOW + 600_000,
            revoked: false,
            scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        })
    }

    /// One request head, run through the seam with the artifact's clock, secret and no dev session.
    fn seam(head: &str, stored: crate::auth::Stored) -> Seam {
        let request = crate::http::Request::parse(head);
        authenticated(
            &request,
            gated_group(),
            NOW,
            &secret(),
            None,
            |_| stored.clone(),
            "Tue, 14 Nov 2023 22:13:20 GMT",
            "unavailable",
        )
    }

    /// A well-formed ticket for `seam_read`, which is the id the recorded heads carry.
    fn ticket() -> String {
        crate::auth::mint("seam_read", NOW as f64, (NOW + 300_000) as f64, &secret())
    }

    fn head(target: &str, lines: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{lines}\r\n")
    }

    /// `seam.badTicketBadKey`: the status the *route* earns, not the one `ws` would have written.
    #[test]
    fn the_ticket_is_refused_before_the_framing_is_checked() {
        // One character of the signature flipped, which is what the oracle did. Appending a third part
        // would **not** refuse the token: `verifyWebSocketToken` splits on `.` and reads only the first
        // two pieces, so `payload.sig.junk` authenticates.
        let broken = {
            let token = ticket();
            let last = token.len() - 1;
            let tail = &token[last..];
            format!("{}{}", &token[..last], if tail == "A" { "B" } else { "A" })
        };
        let seam = seam(
            &head(
                &format!("/ws?wsTicket={broken}"),
                concat!(
                    "Upgrade: websocket\r\n",
                    "Connection: Upgrade\r\n",
                    "Sec-WebSocket-Key: not-a-real-key\r\n",
                    "Sec-WebSocket-Version: 13\r\n",
                ),
            ),
            stored(&["orchestration:read"]),
        );
        let Seam::Denied { head, .. } = seam else {
            panic!("a bad ticket is a refusal, whatever else is wrong: {seam:?}");
        };
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 401 Unauthorized"), "{text}");
        assert!(text.contains("invalid_credential"), "{text}");
        assert!(!text.contains("Sec-WebSocket-Key"), "{text}");
    }

    /// The writer differs with the request: an upgrade's 401 is written over a socket that is already
    /// going away, a plain one keeps the connection alive.
    #[test]
    fn a_refusal_keeps_alive_only_when_no_socket_was_asked_for() {
        let denied = |lines: &str| {
            let seam = seam(
                &head("/ws?wsTicket=not.a.token", lines),
                stored(&["orchestration:read"]),
            );
            let Seam::Denied { head, .. } = seam else {
                panic!("an unreadable token is a refusal");
            };
            String::from_utf8(head).unwrap()
        };
        let upgrade = denied(UPGRADE);
        assert!(upgrade.contains("Connection: keep-alive"), "{upgrade}");
        assert!(
            !upgrade.contains("Keep-Alive"),
            "a websocket refusal does not advertise a connection it is dropping: {upgrade}"
        );
        let plain = denied("Connection: keep-alive\r\n");
        assert!(plain.contains("Keep-Alive: timeout=5"), "{plain}");
    }

    /// `seam.noTicket`: no ticket at all is a different reason, and still the route's own 401.
    #[test]
    fn an_absent_ticket_is_a_different_reason_than_a_bad_one() {
        let Seam::Denied { denied, .. } =
            seam(&head("/ws", UPGRADE), stored(&["orchestration:read"]))
        else {
            panic!("a request with no credential is refused");
        };
        assert!(denied.body("unavailable").contains("missing_credential"));
    }

    /// `seam.postWs`: the method is answered before the ticket is read, so nothing runs at all.
    #[test]
    fn a_post_never_authenticates() {
        let looked = std::cell::Cell::new(0u32);
        let request = crate::http::Request::parse(
            "POST /ws?wsTicket=anything HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        let seam = authenticated(
            &request,
            gated_group(),
            NOW,
            &secret(),
            None,
            |_| {
                looked.set(looked.get() + 1);
                stored(&["orchestration:read"])
            },
            "Tue, 14 Nov 2023 22:13:20 GMT",
            "unavailable",
        );
        let Seam::NoRoute { head } = seam else {
            panic!("the router answers a method it does not have");
        };
        assert_eq!(looked.get(), 0, "a 404 read no row");
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 404 Not Found"), "{text}");
        assert!(text.contains("Transfer-Encoding: chunked"), "{text}");
    }

    /// `seam.notUpgradeAuthorized`: the answer looks like a routing answer and is not one. The row was
    /// already recorded, which is why the variant carries both the id and the origin.
    #[test]
    fn a_valid_ticket_on_a_plain_get_still_runs_the_route() {
        let target = format!("/ws?wsTicket={}&clientSurface=web", ticket());
        let seam = seam(
            &head(&target, "Connection: keep-alive\r\n"),
            stored(&["orchestration:read"]),
        );
        let Seam::NotUpgrade {
            session_id,
            origin,
            head,
        } = seam
        else {
            panic!("a good ticket makes this the route's problem, not the router's: {seam:?}");
        };
        assert_eq!(session_id, "seam_read");
        assert_eq!(origin.surface, Some("web"));
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 400 Bad Request"), "{text}");
        assert!(text.contains("Keep-Alive: timeout=5"), "{text}");
    }

    /// `seam.badKeyAuthorized`: `ws`'s own 400 — no date, closing, and a length that counts its sentence.
    #[test]
    fn ws_answers_for_the_framing_after_the_ticket_passed() {
        let target = format!("/ws?wsTicket={}&clientSurface=desktop", ticket());
        let seam = seam(
            &head(
                &target,
                concat!(
                    "Upgrade: websocket\r\n",
                    "Connection: Upgrade\r\n",
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
                ),
            ),
            stored(&["orchestration:read"]),
        );
        let Seam::Refused {
            refusal,
            origin,
            head,
            ..
        } = seam
        else {
            panic!("a missing version is `ws`'s answer, not the route's: {seam:?}");
        };
        assert_eq!(refusal, crate::http::Refusal::Version);
        assert_eq!(origin.surface, Some("desktop"));
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 400 Bad Request"), "{text}");
        assert!(!text.contains("Date"), "{text}");
        assert!(text.contains("Connection: close"), "{text}");
    }

    /// The negotiated extension is echoed by the `101` and is what makes the answer come back with RSV1,
    /// so a seam that dropped the negotiation would write a plain frame on a deflated connection.
    #[test]
    fn a_connected_seam_deflates_answers() {
        let (head, mut connection) = connected(&["orchestration:read"], true);
        assert!(
            String::from_utf8(head.clone())
                .unwrap()
                .contains("Sec-WebSocket-Extensions: permessage-deflate"),
            "the 101 answers the offer it accepted"
        );
        let written = connection
            .push(&client(
                TEXT,
                request(1, "server.getSettings").as_bytes(),
                true,
            ))
            .bytes();
        assert_eq!(written[0], 0xc1, "fin, RSV1, text");
    }

    /// `seam.readRow` against `seam.operateRow`: two byte-identical requests, and the answer differs
    /// because the **row** differs. This is the seam's whole point — the gate a connection runs is built
    /// from the session the ticket named, and never from the ticket.
    #[test]
    fn the_gate_is_the_rows_scopes_not_the_tickets() {
        let refused = answered(&["orchestration:read"], "server.updateSettings");
        assert!(
            refused.contains("EnvironmentAuthorizationError"),
            "{refused}"
        );
        assert!(refused.contains("orchestration:operate"), "{refused}");
        let granted = answered(
            &["orchestration:read", "orchestration:operate"],
            "server.updateSettings",
        );
        assert!(granted.contains(r#""ok":"operate""#), "{granted}");
    }

    /// The `Sec-WebSocket-Extensions` offer both routes the handshake and names the streams, so the two
    /// places agree by construction.
    const OFFER: &str = concat!(
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        "Sec-WebSocket-Version: 13\r\n",
        "Sec-WebSocket-Extensions: permessage-deflate\r\n",
    );

    /// One upgrade the **seam** accepted, so the gate, the streams and the `101` all come from the route's
    /// order rather than from a test assembling them.
    fn connected(scopes: &[&str], deflate: bool) -> (Vec<u8>, Connection) {
        let target = format!("/ws?wsTicket={}", ticket());
        let lines = if deflate { OFFER } else { UPGRADE };
        let head = head(&target, lines);
        let request = crate::http::Request::parse(&head);
        let seam = authenticated(
            &request,
            gated_group(),
            NOW,
            &secret(),
            None,
            |_| stored(scopes),
            "Tue, 14 Nov 2023 22:13:20 GMT",
            "unavailable",
        );
        let Seam::Connected {
            head, connection, ..
        } = seam
        else {
            panic!("this offer and ticket are acceptable: {seam:?}");
        };
        (head, *connection)
    }

    /// What one gated connection answered to `tag`, inflated back to text.
    fn answered(scopes: &[&str], tag: &str) -> String {
        let (_, mut connection) = connected(scopes, true);
        let written = connection
            .push(&client(TEXT, request(1, tag).as_bytes(), true))
            .bytes();
        // The refusal's 256-byte body puts a 16-bit length in the head, so the body starts where the
        // length field says. `websocket::read_head` cannot be used to look at our own output: it is the
        // reader for a *peer's* frames and insists on the mask bit.
        let agreed = crate::deflate::negotiate("permessage-deflate")
            .unwrap()
            .unwrap();
        let mut back = crate::deflate::Inbound::new(&agreed);
        String::from_utf8(back.inflate(body_of(&written), true).unwrap()).unwrap()
    }

    /// The body of one server frame, by the length field its second byte names.
    fn body_of(frame: &[u8]) -> &[u8] {
        let len = frame[1] & 0x7f;
        &frame[if len == 126 { 4 } else { 2 }..]
    }
}
