//! Retained terminal output, ported from `BoundedTerminalHistory` in
//! `apps/server/src/terminal/Manager.ts`.

use std::collections::VecDeque;

mod sanitize;
mod tail;

pub use sanitize::{Sanitized, sanitize};
pub use tail::{HistoryTail, Restored, history_tail, restore};

pub const DEFAULT_MAX_LINES: usize = 5_000;
pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// A byte budget that never binds.
pub const UNLIMITED_BYTES: usize = usize::MAX;

/// Keeps one eviction from moving more than this much of the buffer.
const MAX_CHUNK_BYTES: usize = 16 * 1024;

const NEWLINE: u8 = b'\n';

#[derive(Default)]
struct Chunk {
    data: Vec<u8>,
    line_breaks: usize,
}

fn count_newlines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == NEWLINE).count()
}

/// Backs up to the start of the code point containing or following `pos`, so a
/// chunk boundary never cuts a multi-byte sequence. Walks at most three bytes:
/// a longer run of continuation bytes is damaged input, not a prefix.
fn floor_char_boundary(bytes: &[u8], pos: usize) -> usize {
    if pos >= bytes.len() {
        return pos;
    }
    let mut cursor = pos;
    while cursor > 0 && pos - cursor < 3 && is_continuation(bytes[cursor]) {
        cursor -= 1;
    }
    cursor
}

pub(crate) fn is_continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}
fn code_point_len(lead: u8) -> usize {
    if lead < 0x80 || is_continuation(lead) {
        1
    } else if lead < 0xe0 {
        2
    } else if lead < 0xf0 {
        3
    } else {
        4
    }
}

pub struct BoundedHistory {
    max_lines: usize,
    max_bytes: usize,
    chunks: VecDeque<Chunk>,
    bytes: usize,
    line_breaks: usize,
    ends_with_newline: bool,
}

impl BoundedHistory {
    pub fn new(initial: &[u8]) -> Self {
        Self::with_limits(DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, initial)
    }

    pub fn with_limits(max_lines: usize, max_bytes: usize, initial: &[u8]) -> Self {
        let mut history = Self {
            max_lines,
            max_bytes,
            chunks: VecDeque::new(),
            bytes: 0,
            line_breaks: 0,
            ends_with_newline: false,
        };
        history.append(initial);
        history
    }

    pub fn append(&mut self, text: &[u8]) {
        if text.is_empty() {
            return;
        }
        if self.max_bytes == 0 || self.max_lines == 0 {
            self.clear();
            // A zero-line budget still keeps the terminator of the write.
            if self.max_bytes > 0 && text.last() == Some(&NEWLINE) {
                self.push_chunk(b"\n");
            }
            return;
        }

        let mut offset = 0;
        while offset < text.len() {
            let hard_end = (offset + MAX_CHUNK_BYTES).min(text.len());
            let end = floor_char_boundary(text, hard_end).max(offset + 1);
            self.push_chunk(&text[offset..end]);
            self.trim();
            offset = end;
        }
    }

    pub fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
        self.line_breaks = 0;
        self.ends_with_newline = false;
    }

    pub fn value(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes);
        for chunk in &self.chunks {
            out.extend_from_slice(&chunk.data);
        }
        out
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn line_breaks(&self) -> usize {
        self.line_breaks
    }

    fn push_chunk(&mut self, data: &[u8]) {
        let line_breaks = count_newlines(data);
        let last_is_newline = data.last() == Some(&NEWLINE);
        self.bytes += data.len();
        self.line_breaks += line_breaks;
        self.ends_with_newline = last_is_newline;

        if let Some(chunk) = self.chunks.back_mut()
            && chunk.data.len() + data.len() <= MAX_CHUNK_BYTES
        {
            chunk.data.extend_from_slice(data);
            chunk.line_breaks += line_breaks;
            return;
        }
        self.chunks.push_back(Chunk {
            data: data.to_vec(),
            line_breaks,
        });
    }

    fn trim(&mut self) {
        let counted = self.line_breaks + usize::from(!self.ends_with_newline);
        let mut drop_lines = counted.saturating_sub(self.max_lines);

        while drop_lines > 0 {
            let Some(front_breaks) = self.front_line_breaks() else {
                break;
            };
            if front_breaks < drop_lines {
                drop_lines -= front_breaks;
                self.discard_front();
                continue;
            }
            let cut = self.front_newline_offset(drop_lines);
            self.trim_front_chunk(cut, drop_lines);
            drop_lines = 0;
        }

        while self.bytes > self.max_bytes {
            let Some(front_len) = self.front_len() else {
                break;
            };
            let excess = self.bytes - self.max_bytes;
            if front_len <= excess {
                self.discard_front();
                continue;
            }
            let cut = self.front_byte_cutoff(excess);
            let breaks = self.front_newline_count_in(cut);
            self.trim_front_chunk(cut, breaks);
        }
    }

    fn front_line_breaks(&self) -> Option<usize> {
        self.chunks.front().map(|chunk| chunk.line_breaks)
    }

    fn front_len(&self) -> Option<usize> {
        self.chunks.front().map(|chunk| chunk.data.len())
    }

    /// Byte index just past the `count`-th newline of the front chunk.
    fn front_newline_offset(&self, count: usize) -> usize {
        let chunk = self.expect_front();
        let mut pos = 0;
        for _ in 0..count {
            let found = chunk.data[pos..]
                .iter()
                .position(|byte| *byte == NEWLINE)
                .expect("the front chunk holds the line breaks asked for");
            pos += found + 1;
        }
        pos
    }

    /// Smallest code-point-aligned byte count that sheds at least `excess` bytes.
    fn front_byte_cutoff(&self, excess: usize) -> usize {
        let chunk = self.expect_front();
        let mut pos = 0;
        let mut dropped = 0;
        while dropped < excess && pos < chunk.data.len() {
            let len = code_point_len(chunk.data[pos]);
            dropped += len;
            pos += len;
        }
        pos
    }

    fn front_newline_count_in(&self, len: usize) -> usize {
        count_newlines(&self.expect_front().data[..len])
    }

    fn expect_front(&self) -> &Chunk {
        self.chunks
            .front()
            .expect("the caller checked for a front chunk")
    }

    fn discard_front(&mut self) {
        let Some(chunk) = self.chunks.pop_front() else {
            return;
        };
        self.bytes -= chunk.data.len();
        self.line_breaks -= chunk.line_breaks;
        if self.chunks.is_empty() {
            self.ends_with_newline = false;
        }
    }

    fn trim_front_chunk(&mut self, len: usize, line_breaks: usize) {
        let whole = self.front_len().is_some_and(|front_len| len >= front_len);
        if whole {
            self.discard_front();
            return;
        }
        let chunk = self.expect_front_mut();
        chunk.data.drain(..len);
        chunk.line_breaks -= line_breaks;
        self.bytes -= len;
        self.line_breaks -= line_breaks;
    }

    fn expect_front_mut(&mut self) -> &mut Chunk {
        self.chunks
            .front_mut()
            .expect("the caller checked for a front chunk")
    }
}
