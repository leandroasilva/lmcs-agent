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
}
