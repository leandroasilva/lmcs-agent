use lmcs_terminal_history::{BoundedHistory, UNLIMITED_BYTES};

/// Port of `retainedHistory` in `apps/server/src/terminal/Manager.test.ts`:
/// apply the line policy, then keep the longest code-point-aligned byte tail.
fn retained(text: &[u8], max_lines: usize, max_bytes: usize) -> Vec<u8> {
    let terminated = text.last() == Some(&b'\n');
    let mut lines: Vec<&[u8]> = text.split(|byte| *byte == b'\n').collect();
    if terminated {
        lines.pop();
    }
    let mut out = lines[lines.len().saturating_sub(max_lines)..].join(&b'\n');
    if terminated {
        out.push(b'\n');
    }
    if out.len() <= max_bytes {
        return out;
    }

    let mut start = out.len();
    let mut used = 0;
    while start > 0 {
        let lead = out[..start]
            .iter()
            .rposition(|byte| byte & 0xc0 != 0x80)
            .expect("the fixture is valid UTF-8");
        let len = match out[lead] {
            byte if byte < 0x80 => 1,
            byte if byte < 0xe0 => 2,
            byte if byte < 0xf0 => 3,
            _ => 4,
        };
        if used + len > max_bytes {
            break;
        }
        used += len;
        start = lead;
    }
    out[start..].to_vec()
}

const FRAGMENTS: [&str; 12] = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u{1b}[31m",
    "\u{1b}[0m",
    "\u{1b}]8;;url\u{7}",
];

fn next_fragment(seed: &mut u32) -> &'static str {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    FRAGMENTS[*seed as usize % FRAGMENTS.len()]
}

#[test]
fn agrees_with_the_oracle_across_limits_unicode_and_clear() {
    for max_bytes in [0, 3, 8, 64, UNLIMITED_BYTES] {
        for max_lines in [0, 1, 3, 5, 5_000] {
            let mut seed = 0x2026_0904u32;
            let mut expected = retained(b"before\ninitial\n", max_lines, max_bytes);
            let mut history =
                BoundedHistory::with_limits(max_lines, max_bytes, b"before\ninitial\n");
            assert_eq!(history.value(), expected, "initial {max_lines}/{max_bytes}");

            for step in 0..300 {
                if step % 73 == 0 {
                    history.clear();
                    expected.clear();
                    assert_eq!(history.value(), expected, "clear {max_lines}/{max_bytes}");
                }
                let chunk = format!("{}{}", next_fragment(&mut seed), next_fragment(&mut seed));
                history.append(chunk.as_bytes());
                let mut joined = expected.clone();
                joined.extend_from_slice(chunk.as_bytes());
                expected = retained(&joined, max_lines, max_bytes);
                assert_eq!(
                    history.value(),
                    expected,
                    "maxLines={max_lines} maxBytes={max_bytes} step={step}"
                );
            }
        }
    }
}

#[test]
fn byte_pressure_never_splits_a_code_point() {
    let text = "a名🚀";
    for max_bytes in 0..12 {
        let mut history = BoundedHistory::with_limits(5_000, max_bytes, text.as_bytes());
        assert_eq!(
            history.value(),
            retained(text.as_bytes(), 5_000, max_bytes),
            "{max_bytes} bytes retained a split code point"
        );

        history.clear();
        history.append(text.as_bytes());
        assert_eq!(history.value(), retained(text.as_bytes(), 5_000, max_bytes));
    }
}

#[test]
fn chunking_at_the_internal_cap_never_splits_a_code_point() {
    let text = format!("{}{}{}", "a".repeat(16_383), "🚀", "b".repeat(70_000));
    let mut history =
        BoundedHistory::with_limits(UNLIMITED_BYTES, UNLIMITED_BYTES, text.as_bytes());
    assert_eq!(history.value(), text.as_bytes());

    history.clear();
    history.append(text.as_bytes());
    assert_eq!(history.value(), text.as_bytes());
    assert_eq!(history.bytes(), text.len());
}

#[test]
fn a_truncated_tail_waits_for_its_partner_without_miscounting() {
    let mut history = BoundedHistory::new(b"");
    history.append(&"\u{1f680}".as_bytes()[..3]);
    assert_eq!(history.bytes(), 3);
    history.append(&"\u{1f680}".as_bytes()[3..]);
    assert_eq!(history.value(), "\u{1f680}".as_bytes());
    assert_eq!(history.bytes(), 4);
    history.append(" done".as_bytes());
    assert_eq!(history.value(), "\u{1f680} done".as_bytes());
}

#[test]
fn a_zero_line_budget_still_keeps_the_terminator_of_a_write() {
    let mut history = BoundedHistory::with_limits(0, 64, b"");
    history.append(b"line\n");
    assert_eq!(history.value(), b"\n");
    history.append(b"line");
    assert_eq!(history.value(), b"");
}

#[test]
fn an_empty_append_changes_nothing() {
    let mut history = BoundedHistory::with_limits(2, 64, b"one\ntwo\n");
    history.append(b"");
    assert_eq!(history.value(), b"one\ntwo\n");
    assert_eq!(history.line_breaks(), 2);
}

#[test]
fn the_last_line_counts_even_without_a_terminator() {
    let mut history = BoundedHistory::with_limits(2, UNLIMITED_BYTES, b"");
    history.append(b"one\ntwo\nthree");
    assert_eq!(history.value(), b"two\nthree");
    history.append(b"four\n");
    assert_eq!(history.value(), b"two\nthreefour\n");
}
