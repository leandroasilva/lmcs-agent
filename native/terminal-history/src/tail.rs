//! Persisted-history restoration, ported from `readHistoryTail` and `readHistory`
//! in `apps/server/src/terminal/Manager.ts`.

use crate::{BoundedHistory, is_continuation};

pub struct HistoryTail {
    pub history: String,
    pub truncated: bool,
}

/// The bounded tail of persisted history already loaded into memory.
pub fn history_tail(bytes: &[u8], byte_limit: usize) -> HistoryTail {
    let offset = if bytes.len() > byte_limit {
        bytes.len() - byte_limit
    } else {
        0
    };

    decode_tail(&bytes[offset..], offset > 0)
}

pub(crate) fn decode_tail(bytes: &[u8], truncated: bool) -> HistoryTail {
    let mut start = 0;
    if truncated {
        // A tail read can start inside a code point. Skip its remaining bytes.
        while start < bytes.len() && is_continuation(bytes[start]) {
            start += 1;
        }
    }

    HistoryTail {
        history: String::from_utf8_lossy(&bytes[start..]).into_owned(),
        truncated,
    }
}

pub struct Restored {
    pub history: String,
    /// The copy on disk still holds bytes the restored value dropped.
    pub needs_rewrite: bool,
}

pub fn restore(bytes: &[u8], byte_limit: usize, line_limit: usize) -> Restored {
    restore_tail(history_tail(bytes, byte_limit), byte_limit, line_limit)
}

pub(crate) fn restore_tail(tail: HistoryTail, byte_limit: usize, line_limit: usize) -> Restored {
    let raw = tail.history.as_bytes();
    let capped = BoundedHistory::with_limits(line_limit, byte_limit, raw).value();
    Restored {
        needs_rewrite: tail.truncated || capped != raw,
        history: String::from_utf8_lossy(&capped).into_owned(),
    }
}
