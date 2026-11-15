//! The JavaScript string operations the shell and environment rules are written in.
//!
//! Both are load-bearing: the shell a terminal runs is chosen by trimming, tokenizing
//! and unquoting a command line with ECMAScript's definitions, and each of them differs
//! from the obvious Rust call.

/// ECMAScript's `WhiteSpace ∪ LineTerminator`, which is what `String.prototype.trim` and
/// the `\s` in a regular expression agree on. It differs from Unicode `White_Space` — and
/// therefore from [`char::is_whitespace`] — in exactly two characters:
///
/// - U+FEFF (BOM) is trimmed by JavaScript and is not whitespace to Unicode.
/// - U+0085 (NEL) is whitespace to Unicode and is **not** trimmed by JavaScript.
///
/// The second one decides whether `/bin/zsh\u{85}--login` is one token or two.
pub(crate) fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String.prototype.split(/\s+/g)[0]` applied to already-trimmed text: the leading run
/// of non-whitespace characters.
pub(crate) fn js_first_whitespace_token(text: &str) -> &str {
    match text.find(is_js_whitespace) {
        Some(index) => &text[..index],
        None => text,
    }
}

/// `String.prototype.replace(/^['"]|['"]$/g, "")`. With the global flag the scan consumes
/// the character it matched, so at most one quote is removed from each end and a lone
/// quote is removed only once.
pub(crate) fn js_strip_outer_quotes(text: &str) -> &str {
    let is_quote = |character: char| character == '\'' || character == '"';
    let trimmed_start = if text.chars().next().is_some_and(is_quote) {
        &text[1.min(text.len())..]
    } else {
        text
    };
    match trimmed_start.chars().next_back() {
        Some(character) if is_quote(character) => {
            &trimmed_start[..trimmed_start.len() - character.len_utf8()]
        }
        _ => trimmed_start,
    }
}

/// `String.prototype.toLowerCase`.
pub(crate) fn js_to_lowercase(text: &str) -> String {
    text.to_lowercase()
}

/// `String.prototype.toUpperCase`.
pub(crate) fn js_to_uppercase(text: &str) -> String {
    text.to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_agrees_with_javascript_not_unicode() {
        assert_eq!(js_trim("\u{feff}/bin/zsh\u{feff}"), "/bin/zsh");
        assert_eq!(js_trim("\u{85}/bin/zsh\u{85}"), "\u{85}/bin/zsh\u{85}");
        assert_eq!(js_trim(" \t\n\u{a0}\u{2028}x\u{3000} "), "x");
        assert_eq!(js_trim("   "), "");
    }

    #[test]
    fn tokenizing_splits_on_nbsp_but_not_nel() {
        assert_eq!(js_first_whitespace_token("/bin/zsh\u{a0}--login"), "/bin/zsh");
        assert_eq!(
            js_first_whitespace_token("/bin/zsh\u{85}--login"),
            "/bin/zsh\u{85}--login"
        );
        assert_eq!(js_first_whitespace_token("/bin/zsh"), "/bin/zsh");
    }

    #[test]
    fn unquoting_removes_one_quote_per_end() {
        assert_eq!(js_strip_outer_quotes("'/bin/zsh'"), "/bin/zsh");
        assert_eq!(js_strip_outer_quotes("\"'/bin/bash'\""), "'/bin/bash'");
        assert_eq!(js_strip_outer_quotes("/bin/zsh"), "/bin/zsh");
        assert_eq!(js_strip_outer_quotes("\""), "");
        assert_eq!(js_strip_outer_quotes("\"\""), "");
        assert_eq!(js_strip_outer_quotes("'x\""), "x");
    }
}
