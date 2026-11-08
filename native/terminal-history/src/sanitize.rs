//! Control-sequence stripping for retained terminal output, ported from
//! `sanitizeTerminalHistoryChunk` in `apps/server/src/terminal/Manager.ts`.
//!
//! Callers decode PTY bytes to text first, exactly as the TypeScript pipeline
//! does, so the C1 controls arrive here as single characters.

const ESC: char = '\u{1b}';

pub struct Sanitized {
    pub visible: String,
    /// A control sequence that was still open when the chunk ended. Feed it back
    /// as `pending` on the next chunk or it is lost.
    pub pending: String,
}

fn is_csi_final(code_point: char) -> bool {
    ('\u{40}'..='\u{7e}').contains(&code_point)
}

fn is_escape_intermediate(code_point: char) -> bool {
    ('\u{20}'..='\u{2f}').contains(&code_point)
}

fn is_escape_final(code_point: char) -> bool {
    ('\u{30}'..='\u{7e}').contains(&code_point)
}

fn is_csi_body_byte(code_point: char, allow_gt: bool) -> bool {
    code_point.is_ascii_digit()
        || code_point == ';'
        || code_point == '?'
        || (allow_gt && code_point == '>')
}

fn should_strip_csi(body: &str, final_byte: char) -> bool {
    match final_byte {
        // Device status report: the query and its reply are both traffic.
        'n' => true,
        // Cursor position report.
        'R' => body
            .chars()
            .all(|code_point| is_csi_body_byte(code_point, false)),
        // Device attributes.
        'c' => body
            .chars()
            .all(|code_point| is_csi_body_byte(code_point, true)),
        // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
        // query makes the terminal answer again, and the shell echoes the answer
        // as junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
        // DECSCL ("p) intact.
        'p' | 'y' => {
            body.ends_with('$')
                && body[..body.len() - 1]
                    .chars()
                    .all(|code_point| is_csi_body_byte(code_point, false))
        }
        // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
        'q' => {
            body.starts_with('>')
                && body[1..]
                    .chars()
                    .all(|code_point| code_point.is_ascii_digit() || code_point == ';')
        }
        // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
        'u' => body.starts_with('?'),
        _ => false,
    }
}

/// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r).
fn should_strip_dcs(content: &str) -> bool {
    let head: Vec<char> = content.chars().take(3).collect();
    let offset = usize::from(matches!(head.first(), Some('0') | Some('1')));
    matches!(head.get(offset), Some('$') | Some('+'))
        && matches!(head.get(offset + 1), Some('q') | Some('r'))
}

fn should_strip_osc(content: &str) -> bool {
    let rest = content
        .strip_prefix("10;")
        .or_else(|| content.strip_prefix("11;"))
        .or_else(|| content.strip_prefix("12;"));
    matches!(rest, Some(value) if value.starts_with('?') || value.starts_with("rgb:"))
}

fn strip_string_terminator(value: &[char]) -> String {
    if value.ends_with(&[ESC, '\\']) {
        return value[..value.len() - 2].iter().collect();
    }
    match value.last() {
        Some('\u{7}') | Some('\u{9c}') => value[..value.len() - 1].iter().collect(),
        _ => value.iter().collect(),
    }
}

/// Index just past the BEL, C1 ST or `ESC \` that closes a string sequence.
fn string_terminator_end(input: &[char], from: usize) -> Option<usize> {
    let mut cursor = from;
    while cursor < input.len() {
        if input[cursor] == '\u{7}' || input[cursor] == '\u{9c}' {
            return Some(cursor + 1);
        }
        if input[cursor] == ESC && input.get(cursor + 1) == Some(&'\\') {
            return Some(cursor + 2);
        }
        cursor += 1;
    }
    None
}

/// Index just past an escape sequence's final byte, or `start + 1` when the byte
/// after the intermediates cannot end one.
fn escape_sequence_end(input: &[char], start: usize) -> Option<usize> {
    let mut cursor = start;
    while cursor < input.len() && is_escape_intermediate(input[cursor]) {
        cursor += 1;
    }
    if cursor >= input.len() {
        return None;
    }
    Some(if is_escape_final(input[cursor]) {
        cursor + 1
    } else {
        start + 1
    })
}

/// Index just past a CSI final byte, counting `body_start` as the first byte of
/// the parameter body.
fn csi_end(input: &[char], body_start: usize) -> Option<usize> {
    (body_start..input.len())
        .find(|index| is_csi_final(input[*index]))
        .map(|index| index + 1)
}

pub fn sanitize(pending: &str, data: &str) -> Sanitized {
    let input: Vec<char> = pending.chars().chain(data.chars()).collect();
    let mut visible = String::new();
    let mut index = 0;

    let unfinished = |visible: String, index: usize| Sanitized {
        visible,
        pending: input[index..].iter().collect(),
    };

    while index < input.len() {
        let code_point = input[index];

        if code_point == ESC {
            let Some(next) = input.get(index + 1) else {
                return unfinished(visible, index);
            };

            if *next == '[' {
                let Some(end) = csi_end(&input, index + 2) else {
                    return unfinished(visible, index);
                };
                let body: String = input[index + 2..end - 1].iter().collect();
                if !should_strip_csi(&body, input[end - 1]) {
                    visible.extend(&input[index..end]);
                }
                index = end;
                continue;
            }

            if matches!(*next, ']' | 'P' | '^' | '_') {
                let Some(end) = string_terminator_end(&input, index + 2) else {
                    return unfinished(visible, index);
                };
                let content = strip_string_terminator(&input[index + 2..end]);
                let strip = (*next == ']' && should_strip_osc(&content))
                    || (*next == 'P' && should_strip_dcs(&content));
                if !strip {
                    visible.extend(&input[index..end]);
                }
                index = end;
                continue;
            }

            let Some(end) = escape_sequence_end(&input, index + 1) else {
                return unfinished(visible, index);
            };
            visible.extend(&input[index..end]);
            index = end;
            continue;
        }

        if code_point == '\u{9b}' {
            let Some(end) = csi_end(&input, index + 1) else {
                return unfinished(visible, index);
            };
            let body: String = input[index + 1..end - 1].iter().collect();
            if !should_strip_csi(&body, input[end - 1]) {
                visible.extend(&input[index..end]);
            }
            index = end;
            continue;
        }

        if matches!(code_point, '\u{9d}' | '\u{90}' | '\u{9e}' | '\u{9f}') {
            let Some(end) = string_terminator_end(&input, index + 1) else {
                return unfinished(visible, index);
            };
            let content = strip_string_terminator(&input[index + 1..end]);
            let strip = (code_point == '\u{9d}' && should_strip_osc(&content))
                || (code_point == '\u{90}' && should_strip_dcs(&content));
            if !strip {
                visible.extend(&input[index..end]);
            }
            index = end;
            continue;
        }

        visible.push(code_point);
        index += 1;
    }

    Sanitized {
        visible,
        pending: String::new(),
    }
}
