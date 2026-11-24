//! One frame's worth of bytes: what a head means, what a violation costs, and what the server writes.
//!
//! This is the layer under [`crate::frame`], which reads the *text* a frame carries. Nothing here knows
//! JSON: it knows ten bits of flags, an opcode, a length field and a mask, which is exactly what
//! `apps/server/scripts/upgrade-golden.ts` measured — 90 scenarios of hand-written sockets, every answer
//! frame recorded as `headerHex` plus `wireHex`.
//!
//! Four claims came out of that capture and none of them is guessable from RFC 6455 alone:
//!
//! - **The server never masks, and always uses the shortest length field.** 125 bytes fit in the 7-bit
//!   form, 126 does not, 65535 does and 65536 does not — the four `length.exact*` scenarios each asked the
//!   `size` rpc for the string length that lands the answer on one side of a boundary.
//! - **The reader does not require the shortest form.** `ws` reads a 16-bit or 64-bit field whenever the
//!   7-bit value is 126 or 127, so a client may send a 3-byte payload with a 10-byte head and be answered
//!   normally. A port that rejected that would be *stricter than the server it replaces*.
//! - **A violation is answered with a close code, and only two codes ever appear**: 1002 for everything the
//!   head itself is wrong about, 1007 for text whose bytes are not UTF-8 (`receiver.js:624,686`) or whose
//!   compressed body does not inflate (`permessage-deflate.js:528`).
//! - **A close is echoed, not rewritten** — code *and* reason, `03e8 627965` for `1000 "bye"` — except when
//!   the received code is one a receiver may not accept, which is answered `1002`, and except a codeless
//!   close, echoed as a zero-body `88 00`.

/// Opcodes as the wire spells them, so a caller can ask for `TEXT` rather than `1`.
pub const CONTINUATION: u8 = 0x0;
pub const TEXT: u8 = 0x1;
pub const BINARY: u8 = 0x2;
pub const CLOSE: u8 = 0x8;
pub const PING: u8 = 0x9;
pub const PONG: u8 = 0xa;

/// Everything the head can be wrong about. `ws` answers each of these with 1002, and the reason strings
/// are its own (`receiver.js:207-378`) because they are what a client's `'error'` event carries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Violation {
    Rsv2OrRsv3Set,
    /// RSV1 with no `permessage-deflate` negotiated, or on a continuation or control frame.
    Rsv1Unoffered,
    /// Any nibble outside `0..=2` and `8..=a`.
    UnknownOpcode(u8),
    /// A control frame with `FIN` clear (`client.controlFragmented`).
    ControlFragmented,
    /// A control frame whose payload exceeds 125 bytes (`client.controlTooLong`).
    ControlTooLong,
    /// A close whose payload is exactly one byte: half a code (`client.closeOneByte`).
    CloseHalfCode,
    /// A client frame with the mask bit clear (`client.closeNoMask`, `client.unmasked`).
    Unmasked,
    /// A continuation with no message open, or a second data frame while one is incomplete. Both are
    /// `ws`'s "Invalid opcode" and "cannot overlap data frames" respectively, and only a state machine
    /// can see them, so [`crate::transport`] raises them.
    ContinuationWithoutFrame,
    OverlappingData,
    /// A 64-bit length above 2^53-1, which `ws` cannot represent and so refuses rather than allocate.
    BeyondSafeInteger,
}

impl Violation {
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::BeyondSafeInteger => 1009,
            Self::Rsv2OrRsv3Set
            | Self::Rsv1Unoffered
            | Self::UnknownOpcode(_)
            | Self::ControlFragmented
            | Self::ControlTooLong
            | Self::CloseHalfCode
            | Self::Unmasked
            | Self::ContinuationWithoutFrame
            | Self::OverlappingData => 1002,
        }
    }
}

/// Why a message was refused, whether the head said so or the body did.
///
/// The body-level faults are separate variants because their code differs: a frame can be perfectly well
/// framed and still carry text that is not UTF-8, which is a 1007 rather than a 1002.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Fault {
    Head(Violation),
    /// Text, or a close reason, whose bytes are not UTF-8 (`client.invalidUtf8Text`,
    /// `client.closeBadReason`).
    NotUtf8,
    /// RSV1 was set and negotiated, but the body is not an inflateable continuation of the connection's
    /// stream (`client.rsv1OfferedButRaw`).
    NotDeflated,
    /// A close carrying a code `ws` will not accept (`close.code999`, `1004`, `1005`, `1006`, `1015`,
    /// `1016`, `5000`).
    UnacceptableClose(u16),
}

impl Fault {
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Head(violation) => violation.code(),
            Self::UnacceptableClose(_) => 1002,
            Self::NotUtf8 | Self::NotDeflated => 1007,
        }
    }
}

/// A decoded head: the flags, the opcode, and how many bytes to read next.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Head {
    pub fin: bool,
    /// RSV1, which after negotiation means "this message is deflated".
    pub rsv1: bool,
    pub opcode: u8,
    pub mask: [u8; 4],
    pub len: u64,
}

/// Whether the head is finished and what it says.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Read {
    /// The head, and the number of bytes it occupied — the payload starts at that offset.
    Complete(Head, usize),
    /// Fewer bytes than the head needs, so read more and try again.
    Partial,
    Refused(Fault),
}

/// Read a head, applying the checks `ws` performs in the order it performs them.
///
/// Sequencing rules that need connection state — a continuation with no message open, a second data frame
/// while one is incomplete — are detected in [`crate::transport`], which raises the last two variants here
/// for the same 1002. The order matters only where two codes could apply to one frame; every head fault
/// shares 1002, so the ordering here is `ws`'s for the reason strings' sake rather than the wire's.
#[must_use]
pub fn read_head(bytes: &[u8], negotiating: bool) -> Read {
    if bytes.len() < 2 {
        return Read::Partial;
    }
    let first = bytes[0];
    let second = bytes[1];
    if first & 0x30 != 0 {
        return Read::Refused(Fault::Head(Violation::Rsv2OrRsv3Set));
    }
    let rsv1 = first & 0x40 != 0;
    let opcode = first & 0x0f;
    if rsv1 && !negotiating {
        return Read::Refused(Fault::Head(Violation::Rsv1Unoffered));
    }
    if !matches!(opcode, CONTINUATION | TEXT | BINARY | CLOSE | PING | PONG) {
        return Read::Refused(Fault::Head(Violation::UnknownOpcode(opcode)));
    }
    let control = opcode > 0x07;
    if control {
        if first & 0x80 == 0 {
            return Read::Refused(Fault::Head(Violation::ControlFragmented));
        }
        if rsv1 {
            return Read::Refused(Fault::Head(Violation::Rsv1Unoffered));
        }
    }
    if second & 0x80 == 0 {
        return Read::Refused(Fault::Head(Violation::Unmasked));
    }
    let short = second & 0x7f;
    let (len, head_len) = match short {
        0..=125 => (u64::from(short), 2),
        126 => {
            if bytes.len() < 4 {
                return Read::Partial;
            }
            (u64::from(u16::from_be_bytes([bytes[2], bytes[3]])), 4)
        }
        _ => {
            if bytes.len() < 10 {
                return Read::Partial;
            }
            let high = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
            // `ws` compares against `2 ** (53 - 32) - 1`, i.e. the top 21 bits must fit.
            if high > (1 << 21) - 1 {
                return Read::Refused(Fault::Head(Violation::BeyondSafeInteger));
            }
            let low = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]);
            (u64::from(high) << 32 | u64::from(low), 10)
        }
    };
    if bytes.len() < head_len + 4 {
        return Read::Partial;
    }
    let mask = [
        bytes[head_len],
        bytes[head_len + 1],
        bytes[head_len + 2],
        bytes[head_len + 3],
    ];
    if control && len > 125 {
        return Read::Refused(Fault::Head(Violation::ControlTooLong));
    }
    if opcode == CLOSE && len == 1 {
        return Read::Refused(Fault::Head(Violation::CloseHalfCode));
    }
    Read::Complete(
        Head {
            fin: first & 0x80 != 0,
            rsv1,
            opcode,
            mask,
            len,
        },
        head_len + 4,
    )
}

/// XOR a payload in place, the way `ws`'s `unmask` does — four bytes of key against the whole body.
pub fn unmask(payload: &mut [u8], mask: [u8; 4]) {
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index & 3];
    }
}

/// The shortest length field for `len`, which is what the server writes and what the golden compares
/// `headerHex` against.
fn length_bytes(len: u64) -> Vec<u8> {
    match len {
        0..=125 => vec![u8::try_from(len).expect("a 7-bit length fits")],
        126..=65_535 => {
            let mut out = vec![126];
            out.extend(u16::try_from(len).expect("16 bits").to_be_bytes());
            out
        }
        larger => {
            let mut out = vec![127];
            out.extend(larger.to_be_bytes());
            out
        }
    }
}

/// Write one server frame: `opcode`, optionally RSV1, unmasked, minimal length, then `payload`.
#[must_use]
pub fn encode(opcode: u8, payload: &[u8], compressed: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(if compressed { 0xc0 } else { 0x80 } | opcode);
    out.extend(length_bytes(
        u64::try_from(payload.len()).expect("a Rust usize fits"),
    ));
    out.extend_from_slice(payload);
    out
}

/// Whether a received close code may be echoed, which is `ws`'s `isValidStatusCode`
/// (`validation.js:37`): 1000..=1014 except the three reserved ones, plus anything private.
///
/// The measured half is the 14-case `close.code*` battery: 1000, 1001, 1007, 1011, 1012, 1013, 3000 and
/// 4999 came back unchanged; 999, 1004, 1005, 1006, 1015, 1016 and 5000 were answered `1002`. 1014 is in
/// the range by the source and was not probed.
#[must_use]
pub const fn is_acceptable_close(code: u16) -> bool {
    (code >= 1000 && code <= 1014 && code != 1004 && code != 1005 && code != 1006)
        || (code >= 3000 && code <= 4999)
}

/// The close frame written in answer to a close the server received.
///
/// `code` is what the received payload carried: a 2-byte code, or nothing at all. `reason` is the rest of
/// those bytes, validated as UTF-8 by the caller — it stays bytes because an invalid sequence has to be
/// *distinguishable* from a valid one, and a `String` cannot hold the difference.
///
/// Three outcomes, all measured:
///   no code → `88 00` (`client.zeroLengthClose`, and every `teardown.*` case, where the protocol layer
///   ends the connection the same way);
///   unacceptable code → `88 02 03 ea` (`close.code1004`);
///   otherwise → the code and the reason, byte for byte (`client.closeNormal`).
#[must_use]
pub fn close(code: Option<u16>, reason: &[u8]) -> Vec<u8> {
    let Some(code) = code else {
        return encode(CLOSE, &[], false);
    };
    if !is_acceptable_close(code) {
        return encode(CLOSE, &1002u16.to_be_bytes(), false);
    }
    let mut payload = Vec::with_capacity(2 + reason.len());
    payload.extend(code.to_be_bytes());
    payload.extend_from_slice(reason);
    encode(CLOSE, &payload, false)
}

/// A fault's answer on the wire: two bytes of code and no reason.
///
/// The reason strings live in the local `'error'` event only — `ws` never writes one into a close frame it
/// produces from a fault, which is why the 1002 and 1007 cases in the capture all recorded a 2-byte
/// payload.
#[must_use]
pub fn refuse(fault: Fault) -> Vec<u8> {
    encode(CLOSE, &fault.code().to_be_bytes(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four `length.exact*` heads, byte for byte.
    #[test]
    fn the_length_field_is_the_shortest_one() {
        assert_eq!(&encode(TEXT, &[b'a'; 125], false)[..2], &[0x81, 125]);
        assert_eq!(&encode(TEXT, &[b'a'; 126], false)[..3], &[0x81, 126, 0x00]);
        assert_eq!(
            &encode(TEXT, &[b'a'; 65_535], false)[..4],
            &[0x81, 126, 0xff, 0xff]
        );
        assert_eq!(
            &encode(TEXT, &[b'a'; 65_536], false)[..10],
            &[0x81, 127, 0, 0, 0, 0, 0, 1, 0, 0]
        );
    }

    /// RSV1 is the only bit a compressed answer sets.
    #[test]
    fn a_compressed_answer_keeps_fin_and_length_and_adds_rsv1() {
        assert_eq!(&encode(TEXT, &[b'a'; 63], true)[..2], &[0xc1, 63]);
    }

    #[test]
    fn a_close_is_echoed_or_answered_with_1002() {
        assert_eq!(close(None, &[]), [0x88, 0x00]);
        assert_eq!(
            close(Some(1000), b"bye"),
            [0x88, 0x05, 0x03, 0xe8, b'b', b'y', b'e']
        );
        assert_eq!(close(Some(1001), &[]), [0x88, 0x02, 0x03, 0xe9]);
        assert_eq!(close(Some(1004), &[]), [0x88, 0x02, 0x03, 0xea]);
        assert_eq!(close(Some(5000), &[]), [0x88, 0x02, 0x03, 0xea]);
    }

    /// A 3-byte payload with a 64-bit length is legal to read, even though the server would never write it.
    #[test]
    fn the_reader_accepts_a_non_minimal_length() {
        let frame = [0x81u8, 255, 0, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 0, 0, 0, 0];
        let Read::Complete(head, consumed) = read_head(&frame, false) else {
            panic!("a masked 3-byte text frame is a valid head");
        };
        assert_eq!(head.len, 3);
        assert_eq!(consumed, 14);
        let mut payload = frame[consumed..consumed + 3].to_vec();
        unmask(&mut payload, head.mask);
        assert_eq!(payload, [1, 2, 3]);
    }

    #[test]
    fn rsv_bits_and_mask_are_the_first_things_checked() {
        // RSV2 with everything else correct.
        assert_eq!(
            read_head(&[0xa1, 0x80, 0, 0, 0, 0], false),
            Read::Refused(Fault::Head(Violation::Rsv2OrRsv3Set))
        );
        // RSV1 while nothing is negotiated, before the opcode is even consulted.
        assert_eq!(
            read_head(&[0xc1, 0x80, 0, 0, 0, 0], false),
            Read::Refused(Fault::Head(Violation::Rsv1Unoffered))
        );
        // Negotiated, so the head is fine and the body is the problem — which is a 1007.
        assert!(matches!(
            read_head(&[0xc1, 0x80, 0, 0, 0, 0], true),
            Read::Complete(..)
        ));
        // An unmasked close: `client.closeNoMask` measured 1002.
        assert_eq!(
            read_head(&[0x88, 0x00], true),
            Read::Refused(Fault::Head(Violation::Unmasked))
        );
    }

    #[test]
    fn a_half_byte_close_is_1002_and_a_long_control_is_1002() {
        assert_eq!(
            read_head(&[0x88, 0x81, 1, 2, 3, 4], true),
            Read::Refused(Fault::Head(Violation::CloseHalfCode))
        );
        assert_eq!(
            read_head(&[0x89, 0xfe, 0x01, 0x00, 1, 2, 3, 4], true),
            Read::Refused(Fault::Head(Violation::ControlTooLong))
        );
        assert_eq!(
            read_head(&[0x83, 0x80, 0, 0, 0, 0], true),
            Read::Refused(Fault::Head(Violation::UnknownOpcode(3)))
        );
        assert_eq!(
            read_head(&[0x09, 0x80, 0, 0, 0, 0], true),
            Read::Refused(Fault::Head(Violation::ControlFragmented))
        );
    }
}
