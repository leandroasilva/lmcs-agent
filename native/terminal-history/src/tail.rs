//! Persisted-history restoration, ported from `readHistoryTail` and `readHistory`
//! in `apps/server/src/terminal/Manager.ts`.

use crate::{BoundedHistory, is_continuation};

pub struct HistoryTail {
    pub history: String,
    pub truncated: bool,
}

/// The bounded tail of persisted history. `bytes` is exactly what the caller
/// read from the file: opening, seeking and the read loop stay outside.
pub fn history_tail(bytes: &[u8], byte_limit: usize) -> HistoryTail {
    let offset = if bytes.len() > byte_limit {
        bytes.len() - byte_limit
    } else {
        0
    };

    let mut start = offset;
    if offset > 0 {
        // A tail read can start inside a code point. Skip its remaining bytes.
        while start < bytes.len() && is_continuation(bytes[start]) {
            start += 1;
        }
    }

    HistoryTail {
        history: String::from_utf8_lossy(&bytes[start..]).into_owned(),
        truncated: offset > 0,
    }
}

pub struct Restored {
    pub history: String,
    /// The copy on disk still holds bytes the restored value dropped.
    pub needs_rewrite: bool,
}

pub fn restore(bytes: &[u8], byte_limit: usize, line_limit: usize) -> Restored {
    let tail = history_tail(bytes, byte_limit);
    let raw = tail.history.as_bytes();
    let capped = BoundedHistory::with_limits(line_limit, byte_limit, raw).value();
    Restored {
        needs_rewrite: tail.truncated || capped != raw,
        history: String::from_utf8_lossy(&capped).into_owned(),
    }
}
