//! Cases derived from `sanitizeTerminalHistoryChunk` and its predicates in
//! `apps/server/src/terminal/Manager.ts`. The shipped TypeScript keeps these
//! module-private, so the table below is the specification of what the retained
//! history may contain.

use lmcs_terminal_history::sanitize;

fn one_shot(input: &str) -> (String, String) {
    let result = sanitize("", input);
    (result.visible, result.pending)
}

/// A kept sequence comes back byte for byte; a stripped one leaves nothing.
#[test]
fn keeps_rendering_state_and_drops_request_response_traffic() {
    for kept in [
        // SGR colour, cursor save/restore, erase.
        "\u{1b}[31m",
        "\u{1b}[0;1;38;5;12m",
        "\u{1b}[m",
        "\u{1b}7",
        "\u{1b}8",
        "\u{1b}[2J",
        "\u{1b}[H",
        "\u{1b}[?25l",
        "\u{1b}[38;2;1;2;3m",
        // DECSTR (!p) and DECSCL ("p) are setters, not the DECRQM/DECRPM pair.
        "\u{1b}[!p",
        "\u{1b}[61;1\"p",
        "\u{1b}[61;1\"y",
        // DECSCUSR has a space intermediate, so it is not XTVERSION.
        "\u{1b}[1 q",
        "\u{1b}[q",
        // Restore-cursor is not the Kitty query.
        "\u{1b}[u",
        "\u{1b}[1u",
        // A CPR-shaped reply only counts when the body is pure parameters.
        "\u{1b}[1$xR",
        // Device attributes must not carry an out-of-set byte either.
        "\u{1b}[!c",
    ] {
        assert_eq!(one_shot(kept), (kept.to_owned(), String::new()), "{kept:?}");
    }

    for stripped in [
        // Device status report and cursor position report.
        "\u{1b}[6n",
        "\u{1b}[5n",
        "\u{1b}[12;34R",
        "\u{1b}[?1R",
        "\u{1b}[R",
        // Device attributes, including the secondary and tertiary forms.
        "\u{1b}[c",
        "\u{1b}[?1;2c",
        "\u{1b}[>c",
        "\u{1b}[>0c",
        "\u{1b}[>1;c",
        // DECRQM queries and DECRPM replies.
        "\u{1b}[?62$p",
        "\u{1b}[2004$p",
        "\u{1b}[?1$y",
        "\u{1b}[1;1$y",
        // XTVERSION.
        "\u{1b}[>0q",
        "\u{1b}[>q",
        // Kitty keyboard protocol.
        "\u{1b}[?u",
        "\u{1b}[?1u",
    ] {
        assert_eq!(
            one_shot(stripped),
            (String::new(), String::new()),
            "{stripped:?}"
        );
    }
}

#[test]
fn strips_only_the_colour_and_version_string_sequences() {
    for kept in [
        "\u{1b}]0;cargo test\u{7}",
        "\u{1b}]2;title\u{1b}\\",
        "\u{1b}]130;xterm\u{7}",
        "\u{1b}]10;#ff0000\u{7}",
        "\u{1b}]104;0\u{7}",
        "\u{1b}]7;file://host/path\u{7}",
    ] {
        assert_eq!(one_shot(kept), (kept.to_owned(), String::new()), "{kept:?}");
    }

    for stripped in [
        "\u{1b}]10;?\u{7}",
        "\u{1b}]11;?\u{7}",
        "\u{1b}]12;?\u{7}",
        "\u{1b}]11;rgb:0000/0000/0000\u{1b}\\",
        "\u{1b}]10;rgb:ffff/0000/0000\u{7}",
    ] {
        assert_eq!(
            one_shot(stripped),
            (String::new(), String::new()),
            "{stripped:?}"
        );
    }
}

/// DECRQSS (`$q`) and XTGETTCAP (`+q`), each with its optional validity digit
/// and each in both the query and the reply form.
#[test]
fn strips_the_decrqss_and_xtgettcap_pairs() {
    for kept in [
        "\u{1b}Pq#0;2;0;0;0#1;2;255;0;0!10~\u{1b}\\", // sixel
        "\u{1b}P0;1;2y\u{1b}\\",
        "\u{1b}Pq\u{1b}\\",
        // The validity digit may only sit immediately before the `$` or `+`.
        "\u{1b}P1;2$r\u{1b}\\",
    ] {
        assert_eq!(one_shot(kept), (kept.to_owned(), String::new()), "{kept:?}");
    }

    for stripped in [
        "\u{1b}P$q\"p\u{1b}\\",
        "\u{1b}P$r\u{1b}\\",
        "\u{1b}P0$q#0;2;0;0;0\u{1b}\\",
        "\u{1b}P1$r\u{1b}\\",
        "\u{1b}P+r6b69747479\u{1b}\\",
        "\u{1b}P1+r636f6c6f7273\u{1b}\\",
    ] {
        assert_eq!(
            one_shot(stripped),
            (String::new(), String::new()),
            "{stripped:?}"
        );
    }
}

#[test]
fn holds_an_unterminated_sequence_until_the_rest_arrives() {
    for input in [
        "\u{1b}",
        "\u{1b}[",
        "\u{1b}[31",
        "\u{1b}]0;ti",
        "\u{1b}P$q",
        "\u{1b}(",
    ] {
        assert_eq!(
            one_shot(input),
            (String::new(), input.to_owned()),
            "{input:?}"
        );
    }
    assert_eq!(
        one_shot("prompt$ \u{1b}[31"),
        ("prompt$ ".to_owned(), "\u{1b}[31".to_owned())
    );
    assert_eq!(
        one_shot("a\u{1b}[6"),
        ("a".to_owned(), "\u{1b}[6".to_owned())
    );
}

#[test]
fn resumes_a_held_sequence_on_the_next_chunk() {
    let first = sanitize("", "red \u{1b}[3");
    assert_eq!(first.visible, "red ");
    assert_eq!(first.pending, "\u{1b}[3");
    let second = sanitize(&first.pending, "1mlight");
    assert_eq!(second.visible, "\u{1b}[31mlight");
    assert_eq!(second.pending, "");

    let query = sanitize("", "\u{1b}[6");
    assert_eq!(query.pending, "\u{1b}[6");
    let replied = sanitize(&query.pending, "n");
    assert_eq!(
        (replied.visible.as_str(), replied.pending.as_str()),
        ("", "")
    );

    let osc = sanitize("", "\u{1b}]10;");
    let osc_replied = sanitize(&osc.pending, "?\u{7}");
    assert_eq!(
        (osc_replied.visible.as_str(), osc_replied.pending.as_str()),
        ("", "")
    );
}

/// Splitting a stream anywhere must not change what survives, because the real
/// caller feeds it one PTY read at a time.
#[test]
fn splitting_a_stream_at_any_char_boundary_yields_the_same_visible_text() {
    let stream = concat!(
        "login: ",
        "\u{1b}[?2004h\u{1b}[6n\u{1b}[31m",
        "root",
        "\u{1b}[0m\r\n",
        "\u{1b}]0;shell\u{1b}\\\u{1b}]11;?\u{7}\u{1b}[c\u{1b}[12;1R\u{1b}[?u\u{1b}[1 q",
        "\u{1b}P$q\"p\u{1b}\\\u{1b}(B\u{1b}7",
        "tail",
        "\u{1b}8",
    );
    let expected = sanitize("", stream).visible;
    assert!(expected.contains("login: "));
    assert!(expected.contains("root"));
    assert!(expected.contains("tail"));

    let boundaries: Vec<usize> = stream
        .char_indices()
        .map(|(index, _)| index)
        .chain([stream.len()])
        .collect();
    for split in boundaries {
        let head = sanitize("", &stream[..split]);
        let tail = sanitize(&head.pending, &stream[split..]);
        assert_eq!(
            format!("{}{}", head.visible, tail.visible),
            expected,
            "split at {split}"
        );
        assert_eq!(tail.pending, "");
    }
}

#[test]
fn the_c1_single_byte_forms_match_their_escape_introduced_twins() {
    // Each pair is the same sequence in both spellings, so the strip verdict
    // must agree; the surviving bytes keep their own spelling.
    for (c1, escaped) in [
        ("\u{9b}6n", "\u{1b}[6n"),
        ("\u{9b}31m", "\u{1b}[31m"),
        ("\u{9d}10;?\u{7}", "\u{1b}]10;?\u{7}"),
        ("\u{9d}0;t\u{7}", "\u{1b}]0;t\u{7}"),
        ("\u{90}$q\"p\u{9c}", "\u{1b}P$q\"p\u{1b}\\"),
        ("\u{90}q#0~\u{9c}", "\u{1b}Pq#0~\u{1b}\\"),
        ("\u{9e}apc\u{7}", "\u{1b}^apc\u{7}"),
        ("\u{9f}pm\u{7}", "\u{1b}_pm\u{7}"),
    ] {
        let (c1_visible, c1_pending) = one_shot(c1);
        let (escaped_visible, escaped_pending) = one_shot(escaped);
        assert_eq!(c1_visible.is_empty(), escaped_visible.is_empty(), "{c1:?}");
        assert_eq!(c1_pending.is_empty(), escaped_pending.is_empty(), "{c1:?}");
        assert_eq!(
            c1_visible,
            if c1_visible.is_empty() {
                String::new()
            } else {
                c1.to_owned()
            }
        );
    }
    assert_eq!(one_shot("\u{9b}31m").0, "\u{9b}31m");
    assert_eq!(one_shot("\u{9b}31"), (String::new(), "\u{9b}31".to_owned()));
    assert_eq!(one_shot("\u{9d}10;?").1, "\u{9d}10;?");
    assert_eq!(one_shot("\u{90}$q\"p").1, "\u{90}$q\"p");
}

#[test]
fn ordinary_text_and_non_control_escapes_pass_through() {
    for input in [
        "plain ascii",
        "café 名 🚀\r\n\t",
        "\u{1b}[31m\u{1f680}\u{1b}[0m",
        "\r\n\u{1b}[1;1H",
    ] {
        assert_eq!(
            one_shot(input),
            (input.to_owned(), String::new()),
            "{input:?}"
        );
    }

    // A byte after ESC that can neither continue nor end a sequence is kept
    // verbatim, so the two characters are not swallowed.
    assert_eq!(one_shot("\u{1b}\u{1}x").0, "\u{1b}\u{1}x");
    assert_eq!(one_shot("\u{1b}M").0, "\u{1b}M");
    assert_eq!(one_shot("\u{1b}(B").0, "\u{1b}(B");
    assert_eq!(one_shot("\u{1b}7\u{1b}8").0, "\u{1b}7\u{1b}8");
}

#[test]
fn strips_the_queries_a_shell_emits_around_a_prompt() {
    let chunk = "\u{1b}[?2004h\u{1b}[6n\u{1b}[?uuser@host:~$ ";
    assert_eq!(one_shot(chunk).0, "\u{1b}[?2004huser@host:~$ ".to_owned());

    let with_reply = "\u{1b}[?2004h\u{1b}[6nuser@host:~$ \u{1b}[42;7R";
    assert_eq!(
        one_shot(with_reply).0,
        "\u{1b}[?2004huser@host:~$ ".to_owned()
    );
}
