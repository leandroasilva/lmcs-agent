use lmcs_terminal_history::{history_tail, restore};

/// The oversized file from the shipped end-to-end case in
/// `apps/server/src/terminal/Manager.test.ts`: `"old".repeat(32_768)` followed
/// by a split code point, a BOM, a carriage return and an accented tail.
fn oversized_history() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice("old".repeat(32_768).as_bytes());
    bytes.extend_from_slice("😀\u{feff}newest\ré".as_bytes());
    bytes
}

#[test]
fn restores_the_unicode_safe_tail_of_oversized_history() {
    let bytes = oversized_history();

    let tail = history_tail(&bytes, 15);
    assert_eq!(tail.history, "\u{feff}newest\ré");
    assert!(tail.truncated);

    let restored = restore(&bytes, 15, 5);
    assert_eq!(restored.history, "\u{feff}newest\ré");
    assert!(restored.needs_rewrite);
}

#[test]
fn a_file_within_the_limit_is_read_whole_and_left_alone() {
    let bytes = b"one\ntwo\n";
    let tail = history_tail(bytes, 64);
    assert_eq!(tail.history, "one\ntwo\n");
    assert!(!tail.truncated);

    let restored = restore(bytes, 64, 5);
    assert_eq!(restored.history, "one\ntwo\n");
    assert!(!restored.needs_rewrite);
}

#[test]
fn a_zero_byte_limit_restores_nothing_but_still_reports_truncation() {
    let tail = history_tail(b"anything", 0);
    assert_eq!(tail.history, "");
    assert!(tail.truncated);
}

#[test]
fn an_empty_file_is_neither_truncated_nor_rewritten() {
    let tail = history_tail(b"", 16);
    assert_eq!(tail.history, "");
    assert!(!tail.truncated);
    assert!(!restore(b"", 16, 5).needs_rewrite);
}

#[test]
fn a_tail_offset_landing_inside_a_code_point_skips_its_remaining_bytes() {
    let bytes = "aaa😀bbb".as_bytes();

    assert_eq!(history_tail(bytes, 10).history, "aaa😀bbb");
    assert_eq!(history_tail(bytes, 9).history, "aa😀bbb");
    assert_eq!(history_tail(bytes, 7).history, "😀bbb");
    assert_eq!(history_tail(bytes, 6).history, "bbb");
    assert_eq!(history_tail(bytes, 5).history, "bbb");
    assert!(!history_tail(bytes, 10).truncated);
    assert!(history_tail(bytes, 7).truncated);
}

#[test]
fn invalid_bytes_become_replacement_characters_like_the_web_decoder() {
    assert_eq!(
        history_tail(&[0xff, b'a', 0x80], 64).history,
        "\u{fffd}a\u{fffd}"
    );
}

#[test]
fn a_bom_at_the_head_of_a_whole_file_is_preserved() {
    let bytes = "\u{feff}x".as_bytes();
    assert_eq!(history_tail(bytes, 64).history, "\u{feff}x");
    assert!(!restore(bytes, 64, 5).needs_rewrite);
}

#[test]
fn line_pressure_trims_the_restored_tail_and_marks_the_file_stale() {
    let restored = restore("one\ntwo\nthree\nfour\n".as_bytes(), 1_024, 2);
    assert_eq!(restored.history, "three\nfour\n");
    assert!(restored.needs_rewrite);
}
