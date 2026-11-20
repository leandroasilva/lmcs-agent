//! Incremental UTF-8 delivery matching Node's StringDecoder.

#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
    expected: usize,
}

impl Utf8Decoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Empty decoded output does not produce a Node stream data event.
    #[must_use]
    pub fn write(&mut self, mut bytes: &[u8]) -> String {
        let mut output = String::new();
        if !self.pending.is_empty() {
            while self.pending.len() < self.expected {
                let Some((&byte, rest)) = bytes.split_first() else {
                    return output;
                };
                if byte & 0xc0 != 0x80 {
                    break;
                }
                self.pending.push(byte);
                bytes = rest;
            }
            output.push_str(&self.finish());
        }

        // Node buffers nominal UTF-8 prefixes, even C0/C1 and out-of-range code points.
        let mut complete = bytes.len();
        for back in 1..=bytes.len().min(3) {
            let byte = bytes[bytes.len() - back];
            if byte & 0xc0 == 0x80 {
                continue;
            }
            let expected = match byte {
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => 0,
            };
            if expected > back {
                complete -= back;
                self.pending.extend_from_slice(&bytes[complete..]);
                self.expected = expected;
            }
            break;
        }
        output.push_str(&String::from_utf8_lossy(&bytes[..complete]));
        output
    }

    #[must_use]
    pub fn finish(&mut self) -> String {
        let output = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        self.expected = 0;
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_a_complete_prefix_without_waiting_for_the_split_character() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(b"prefix\xc3"), "prefix");
        assert_eq!(decoder.write(&[]), "");
        assert_eq!(decoder.write(b"\xa9\r\n"), "é\r\n");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn joins_a_four_byte_character_across_four_reads() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(b"\xf0"), "");
        assert_eq!(decoder.write(b"\x9f"), "");
        assert_eq!(decoder.write(b"\x98"), "");
        assert_eq!(decoder.write(b"\x80!"), "\u{1f600}!");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn invalid_prefixes_wait_for_the_nominal_length_like_node() {
        for (prefix, suffix, expected) in [
            (&b"\xc0"[..], &b"\x80"[..], "\u{fffd}\u{fffd}"),
            (&b"\xed\xa0"[..], &b"\x80"[..], "\u{fffd}\u{fffd}\u{fffd}"),
            (
                &b"\xf5\x80\x80"[..],
                &b"\x80"[..],
                "\u{fffd}\u{fffd}\u{fffd}\u{fffd}",
            ),
        ] {
            let mut decoder = Utf8Decoder::new();
            assert_eq!(decoder.write(prefix), "");
            assert_eq!(decoder.write(suffix), expected);
            assert_eq!(decoder.finish(), "");
        }
    }

    #[test]
    fn a_non_continuation_byte_ends_pending_input_and_can_start_another_character() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(b"\xe2\x82"), "");
        assert_eq!(decoder.write(b"A\xc3"), "\u{fffd}A");
        assert_eq!(decoder.write(b"\xa9"), "é");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn eof_replaces_an_incomplete_character_and_resets_the_decoder() {
        for prefix in [&b"\xc3"[..], &b"\xe2\x82"[..], &b"\xf0\x9f\x98"[..]] {
            let mut decoder = Utf8Decoder::new();
            assert_eq!(decoder.write(prefix), "");
            assert_eq!(decoder.finish(), "\u{fffd}");
            assert_eq!(decoder.finish(), "");
            assert_eq!(decoder.write(b"\xa9ok"), "\u{fffd}ok");
        }
    }

    #[test]
    fn eof_replaces_invalid_bytes_individually() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(b"\xed\xa0"), "");
        assert_eq!(decoder.finish(), "\u{fffd}\u{fffd}");
    }

    #[test]
    fn complete_chunks_keep_controls_nul_and_their_delivery_boundaries() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(b"\x1b[31m\0"), "\x1b[31m\0");
        assert_eq!(decoder.write("olá".as_bytes()), "olá");
        assert_eq!(decoder.write(b"\xffend"), "\u{fffd}end");
        assert_eq!(decoder.finish(), "");
    }
}
