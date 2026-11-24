//! `permessage-deflate`: which offer is accepted, and what the two directions of the stream do.
//!
//! The negotiation is the interesting half, because it is not "echo what the client asked for". `ws`
//! answers with the offer's own parameters *minus* one, and refuses three kinds of offer outright — all
//! of it measured over 24 upgrade scenarios in `apps/server/scripts/upgrade-golden.ts` and cross-read
//! against `ws@8.22.0`'s `permessage-deflate.js`:
//!
//! - a **bare** `client_max_window_bits` is deleted from the accepted parameters
//!   (`acceptAsServer`'s last branch: `accepted.client_max_window_bits === true` → `delete`), while
//!   `client_max_window_bits=10` is kept. That single `true` check is the difference between the browser's
//!   offer coming back as `permessage-deflate` and as `permessage-deflate; client_max_window_bits`.
//! - an **unknown parameter** (`foo=bar`), a **repeated** parameter, and a **`server_max_window_bits`
//!   outside 8..=15** all throw inside `normalizeParams`, which the server turns into the same
//!   `Invalid or unacceptable Sec-WebSocket-Extensions header` refusal. A port that quietly dropped the
//!   unknown parameter would upgrade a client `ws` turns away, and would then answer with frames that
//!   client cannot decode.
//! - an **unknown extension name** (`foo; bar=1`) is never consulted, so the upgrade succeeds and nothing
//!   is answered about it.
//! - `server_no_context_takeover`, `client_no_context_takeover` and `server_max_window_bits=10` are echoed
//!   verbatim, in the order they were offered.
//!
//! The rest is the stream. One deflate stream lives per direction for the whole connection unless
//! takeover was refused for that direction, in which case it is reset after each message. The four-byte
//! `\x00\x00\xff\xff` sync marker is **stripped from the last frame the sender writes and added to the last
//! frame the receiver reads**, which is the whole of the permessage-deflate framing rule.
//!
//! Byte-for-byte agreement with Node's zlib is *not* claimed and cannot be: this crate's flate2 uses the
//! `rust_backend`, whose deflate output differs from zlib's at the same level. A client only requires that
//! an RSV1 body inflate to the right text, so the golden compares inflated text and the RSV1 decision, and
//! `tests/transport_golden.rs` says so where it checks those frames.

use flate2::Compression;
use flate2::Decompress;
use flate2::FlushCompress;
use flate2::FlushDecompress;

/// `ws`'s `TRAILER` (`permessage-deflate.js:10`): the sync marker a receiver appends and a sender drops.
pub const TRAILER: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// `ws`'s default `threshold`, applied only when the direction refused context takeover
/// (`sender.js:382`, `permessage-deflate.js:56`).
pub const THRESHOLD: usize = 1024;

/// The one extension this server implements.
pub const EXTENSION: &str = "permessage-deflate";

/// Why an offer cannot be accepted. Every variant produces the same 400 on the wire, so the distinction
/// exists for logs and tests rather than for the client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Refusal {
    /// `Unknown parameter "foo"`.
    UnknownParameter(String),
    /// `Parameter "x" must have only a single value`.
    RepeatedParameter(String),
    /// `Invalid value for parameter "…_max_window_bits"`, for a non-integer or a value outside 8..=15.
    WindowBits(&'static str),
    /// A `*_no_context_takeover` written as `flag=1` rather than bare.
    ParameterizedFlag(&'static str),
    /// `server_max_window_bits` with no value at all: `+true` is 1, which fails the same range check.
    BareServerWindowBits,
}

/// What the two directions agreed to, as a parsed form of the answer string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Negotiated {
    /// The exact `Sec-WebSocket-Extensions` value to write, parameters in the offered order.
    pub answer: String,
    pub server_no_context_takeover: bool,
    pub client_no_context_takeover: bool,
    /// Window bits for each direction, which `ws` passes to zlib as-is. Absent means the default, 15.
    pub server_max_window_bits: u8,
    pub client_max_window_bits: u8,
}

impl Negotiated {
    /// Whether a server answer of `len` bytes is written with RSV1 set.
    ///
    /// With takeover — the browser's default, and therefore the common path — the answer is *always*
    /// compressed, including the 63-byte `plain` reply and the 4053-byte stream chunk the capture recorded.
    /// Only a refusal of `server_no_context_takeover` puts the 1024-byte threshold in play, which is what
    /// `offer.smallNoTakeover` (975 raw) and `offer.bigNoTakeover` (4075 deflated) measure on each side.
    #[must_use]
    pub const fn compresses(&self, len: usize) -> bool {
        !self.server_no_context_takeover || len >= THRESHOLD
    }
}

/// One parameter of an offer: `flag` or `flag=value`.
type Param<'a> = (&'a str, Option<&'a str>);

/// Read a `Sec-WebSocket-Extensions` header, accepting `permessage-deflate` or refusing.
///
/// `Ok(None)` means "no `permessage-deflate` was offered", which is a successful upgrade with no extension
/// header back — the `handshake.noExtensions` and `offer.otherOnly` cases.
///
/// `header` is the raw joined value of the request line(s). Node collapses a repeated header into a
/// comma-joined string, so this function never sees two values for one name.
pub fn negotiate(header: &str) -> Result<Option<Negotiated>, Refusal> {
    let mut accepted: Option<Vec<Param>> = None;
    for offer in offers(header) {
        let (name, params) = offer;
        if name != EXTENSION {
            // Never consulted, so never a refusal (`offer.otherOnly`).
            continue;
        }
        // `normalizeParams` validates *every* offer for this extension before `acceptAsServer` picks one,
        // so a malformed second offer refuses the handshake even when the first is fine.
        validate(&params)?;
        if accepted.is_none() {
            accepted = Some(params);
        }
    }
    let Some(params) = accepted else {
        return Ok(None);
    };
    let mut answer = String::from(EXTENSION);
    let mut server_no_context_takeover = false;
    let mut client_no_context_takeover = false;
    let mut server_max_window_bits = 15;
    let mut client_max_window_bits = 15;
    for (key, value) in params {
        let Some(value) = value else {
            // The two flags are echoed as they were offered; the bare `client_max_window_bits` is the one
            // parameter `acceptAsServer` deletes.
            match key {
                "server_no_context_takeover" => server_no_context_takeover = true,
                "client_no_context_takeover" => client_no_context_takeover = true,
                _ => continue,
            }
            answer.push_str("; ");
            answer.push_str(key);
            continue;
        };
        answer.push_str("; ");
        answer.push_str(key);
        answer.push('=');
        answer.push_str(value);
        match key {
            "server_max_window_bits" => server_max_window_bits = number(value),
            "client_max_window_bits" => client_max_window_bits = number(value),
            _ => unreachable!("validate accepted only the four known parameters"),
        }
    }
    Ok(Some(Negotiated {
        answer,
        server_no_context_takeover,
        client_no_context_takeover,
        server_max_window_bits,
        client_max_window_bits,
    }))
}

/// Split the header into offers of parameters, in order, keeping duplicates visible so `validate` can see
/// them. Commas separate offers, semicolons separate parameters, and both are allowed to be quoted strings.
fn offers(header: &str) -> Vec<(String, Vec<Param>)> {
    let mut out = Vec::new();
    for offer in split_top(header, ',') {
        let mut pieces = offer.split(';').map(str::trim).filter(|piece| !piece.is_empty());
        let Some(name) = pieces.next() else { continue };
        let mut params: Vec<Param> = Vec::new();
        for piece in pieces {
            let mut bits = piece.splitn(2, '=');
            let key = bits.next().unwrap_or_default().trim();
            if key.is_empty() {
                continue;
            }
            let value = bits.next().map(|value| unquote(value.trim())).unwrap_or(None);
            params.push((key, value));
        }
        out.push((name.to_ascii_lowercase(), params));
    }
    out
}

/// Split on `at`, ignoring the separator inside quoted strings.
fn split_top(value: &str, at: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (index, ch) in value.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            c if c == at && !quoted => {
                out.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    out.push(&value[start..]);
    out
}

fn unquote(value: &str) -> Option<&str> {
    let trimmed = value.trim_matches('"');
    (!trimmed.is_empty()).then_some(trimmed)
}

/// The 8..=15 check zlib's window bits argument gets, spelled as a number. Out-of-range values never reach
/// here: `validate` refuses them.
fn number(value: &str) -> u8 {
    value.parse::<u8>().unwrap_or(15)
}

/// `normalizeParams` for a server with default options (`permessage-deflate.js:246-300`).
fn validate(params: &[Param]) -> Result<(), Refusal> {
    let mut seen: Vec<&str> = Vec::new();
    for (key, value) in params {
        if seen.contains(key) {
            return Err(Refusal::RepeatedParameter((*key).to_owned()));
        }
        seen.push(key);
        match *key {
            "client_max_window_bits" | "server_max_window_bits" => {
                let bits = *key;
                let Some(value) = value else {
                    // `client_max_window_bits` alone is the browser's offer and is legal; a bare
                    // `server_max_window_bits` is `+true`, i.e. 1, which fails the range.
                    if bits == "client_max_window_bits" {
                        continue;
                    }
                    return Err(Refusal::BareServerWindowBits);
                };
                if !is_window_bits(value) {
                    return Err(Refusal::WindowBits(bits));
                }
            }
            "client_no_context_takeover" | "server_no_context_takeover" => {
                if value.is_some() {
                    return Err(Refusal::ParameterizedFlag(*key));
                }
            }
            other => return Err(Refusal::UnknownParameter(other.to_owned())),
        }
    }
    Ok(())
}

/// `Number.isInteger(+value) && num >= 8 && num <= 15`, on the text the offer carried.
fn is_window_bits(value: &str) -> bool {
    value
        .parse::<f64>()
        .is_ok_and(|number| number.fract() == 0.0 && (8.0..=15.0).contains(&number))
}

/// The server's outbound stream: one deflate object for the connection, reset per message when the client
/// refused server-side takeover.
pub struct Outbound {
    deflate: flate2::Compress,
    reset_each: bool,
}

impl Outbound {
    #[must_use]
    pub fn new(agreed: &Negotiated) -> Self {
        Self {
            deflate: flate2::Compress::new_with_window_bits(
                Compression::default(),
                false,
                u8::from(agreed.server_max_window_bits),
            ),
            reset_each: agreed.server_no_context_takeover,
        }
    }

    /// Deflate one message and return the bytes to put in an RSV1 frame: the stream up to and including the
    /// sync flush, minus its trailing marker (`_compress`'s `data.length - 4` when `fin`).
    pub fn compress(&mut self, text: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(text.len() / 2 + 32);
        // `Sync` flush pushes the whole input through and leaves the stream open for the next message.
        let mut consumed = 0;
        loop {
            let before_out = self.deflate.total_out();
            let before_in = self.deflate.total_in();
            let start = out.len();
            out.resize(start + (text.len() - consumed) + 32, 0);
            let writable = out.len() - start;
            let _ = self.deflate.compress(
                &text[consumed..],
                &mut out[start..],
                FlushCompress::Sync,
            );
            let made = usize::try_from(self.deflate.total_out() - before_out).unwrap_or(usize::MAX);
            let read = usize::try_from(self.deflate.total_in() - before_in).unwrap_or(usize::MAX);
            out.truncate(start + made.min(writable));
            consumed += read;
            if consumed >= text.len() {
                break;
            }
        }
        if out.ends_with(&TRAILER) {
            out.truncate(out.len() - TRAILER.len());
        }
        if self.reset_each {
            self.deflate.reset();
        }
        out
    }
}

/// The server's inbound stream, i.e. the client's deflate context.
pub struct Inbound {
    inflate: Decompress,
    reset_each: bool,
}

impl Inbound {
    #[must_use]
    pub fn new(agreed: &Negotiated) -> Self {
        Self {
            inflate: Decompress::new_with_window_bits(false, u8::from(agreed.client_max_window_bits)),
            reset_each: agreed.client_no_context_takeover,
        }
    }

    /// Inflate a compressed frame body. `fin` says whether this was the message's last fragment, which is
    /// when the sync marker is appended (`_decompress`: `if (fin) this._inflate.write(TRAILER)`).
    ///
    /// `Err(())` is `Fault::NotDeflated`'s material: an RSV1 body that will not inflate is a 1007.
    pub fn inflate(&mut self, body: &[u8], fin: bool) -> Result<Vec<u8>, ()> {
        let mut out = Vec::with_capacity(body.len() * 2 + 32);
        let mut input = body.to_vec();
        if fin {
            input.extend_from_slice(&TRAILER);
        }
        let mut consumed = 0;
        loop {
            let before_out = self.inflate.total_out();
            let before_in = self.inflate.total_in();
            let start = out.len();
            out.resize(start + (input.len() - consumed) * 4 + 256, 0);
            let room = &mut out[start..];
            let writable = room.len();
            self.inflate
                .decompress(&input[consumed..], room, FlushDecompress::Sync)
                .map_err(|_| {})?;
            let made = usize::try_from(self.inflate.total_out() - before_out).unwrap_or(usize::MAX);
            let read = usize::try_from(self.inflate.total_in() - before_in).unwrap_or(usize::MAX);
            out.truncate(start + made.min(writable));
            consumed += read;
            if consumed >= input.len() {
                break;
            }
        }
        if self.reset_each && fin {
            self.inflate.reset(false);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table `answersForOffer` measures, as text rather than as a record.
    #[test]
    fn the_answer_is_the_offer_minus_one_parameter() {
        let cases = [
            ("", None),
            (EXTENSION, Some(EXTENSION)),
            ("permessage-deflate; client_max_window_bits", Some(EXTENSION)),
            (
                "permessage-deflate; client_max_window_bits=10",
                Some("permessage-deflate; client_max_window_bits=10"),
            ),
            (
                "permessage-deflate; server_max_window_bits=10",
                Some("permessage-deflate; server_max_window_bits=10"),
            ),
            (
                "permessage-deflate; server_no_context_takeover",
                Some("permessage-deflate; server_no_context_takeover"),
            ),
            (
                "permessage-deflate; client_no_context_takeover",
                Some("permessage-deflate; client_no_context_takeover"),
            ),
            (
                "permessage-deflate; server_no_context_takeover, foo",
                Some("permessage-deflate; server_no_context_takeover"),
            ),
            ("permessage-deflate; client_max_window_bits, foo", Some(EXTENSION)),
            ("foo; bar=1", None),
        ];
        for (offer, answer) in cases {
            let got = negotiate(offer).expect("these offers are all acceptable");
            assert_eq!(
                got.as_ref().map(|agreed| agreed.answer.as_str()),
                answer,
                "offer {offer:?}"
            );
        }
    }

    /// The three offers that are not an answer but a refusal, which the capture records as 400s.
    #[test]
    fn an_unacceptable_offer_refuses_the_handshake() {
        assert_eq!(
            negotiate("permessage-deflate; foo=bar"),
            Err(Refusal::UnknownParameter("foo".to_owned()))
        );
        assert_eq!(
            negotiate(
                "permessage-deflate; client_no_context_takeover; client_no_context_takeover"
            ),
            Err(Refusal::RepeatedParameter(
                "client_no_context_takeover".to_owned()
            ))
        );
        assert_eq!(
            negotiate("permessage-deflate; server_max_window_bits=16"),
            Err(Refusal::WindowBits("server_max_window_bits"))
        );
    }

    /// `handshake.deflate` proves the browser's `client_max_window_bits` never sets the window: the default
    /// is zlib's, i.e. 15, and the answer is bare.
    #[test]
    fn the_browser_offer_keeps_both_defaults_and_both_contexts() {
        let agreed = negotiate("permessage-deflate; client_max_window_bits")
            .unwrap()
            .expect("the browser's offer is accepted");
        assert!(!agreed.server_no_context_takeover);
        assert!(!agreed.client_no_context_takeover);
        assert_eq!(
            (agreed.server_max_window_bits, agreed.client_max_window_bits),
            (15, 15)
        );
        // Which is the rule that makes every answer compressed, at any size.
        assert!(agreed.compresses(63));
        assert!(!Negotiated {
            answer: String::new(),
            server_no_context_takeover: true,
            client_no_context_takeover: false,
            server_max_window_bits: 15,
            client_max_window_bits: 15,
        }
        .compresses(975));
    }

    /// Round-tripping is the claim the golden's `inflated` field makes in the other direction: a body this
    /// module writes is a body this module reads back, and one a client writes is one it can read.
    #[test]
    fn a_compressed_message_inflates_to_itself_across_two_messages() {
        let agreed = negotiate(EXTENSION).unwrap().unwrap();
        let mut out = Outbound::new(&agreed);
        let mut back = Inbound::new(&Negotiated {
            // The client's direction is the server's outbound and vice versa.
            answer: String::new(),
            server_no_context_takeover: false,
            client_no_context_takeover: false,
            server_max_window_bits: 15,
            client_max_window_bits: 15,
        });
        let first = out.compress(b"{\"_tag\":\"Exit\"}");
        let second = out.compress(b"{\"_tag\":\"Chunk\",\"values\":[1,2,3]}");
        assert!(!first.ends_with(&TRAILER) && !second.ends_with(&TRAILER));
        assert_eq!(back.inflate(&first, true).unwrap(), b"{\"_tag\":\"Exit\"}");
        assert_eq!(
            back.inflate(&second, true).unwrap(),
            b"{\"_tag\":\"Chunk\",\"values\":[1,2,3]}"
        );
    }

    /// With server-side takeover refused, each answer must stand on its own, which is what makes the
    /// recorded `inflated` text the whole claim for those frames.
    #[test]
    fn a_refused_takeover_resets_after_every_message() {
        let agreed = Negotiated {
            answer: "permessage-deflate; server_no_context_takeover".to_owned(),
            server_no_context_takeover: true,
            client_no_context_takeover: false,
            server_max_window_bits: 15,
            client_max_window_bits: 15,
        };
        let mut out = Outbound::new(&agreed);
        let mut back = Inbound::new(&Negotiated {
            answer: String::new(),
            server_no_context_takeover: false,
            client_no_context_takeover: false,
            server_max_window_bits: 15,
            client_max_window_bits: 15,
        });
        let first = out.compress(b"aaaa");
        let second = out.compress(b"aaaa");
        assert_eq!(back.inflate(&first, true).unwrap(), b"aaaa");
        assert_eq!(back.inflate(&second, true).unwrap(), b"aaaa");
    }
}
