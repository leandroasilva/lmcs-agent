//! Keyboard to bytes.
//!
//! Declared deviation from the shipped client: `apps/web/src/terminal/ghostty/core.ts` encodes
//! through its keymap layer, which honours kitty keyboard protocol flags the terminal has
//! requested, plus selection and mouse semantics. None of that is ported yet, so this writes the
//! legacy answers a VT100 terminal expects. A shell, `vim`, `htop` and `ssh` all work on this; a
//! program that asked for `kitty-keyboard` gets the legacy form instead of the enhanced one.

use gpui::Keystroke;

/// The bytes a keystroke sends, or `None` when the keystroke belongs to the operating system
/// rather than to the shell.
#[must_use]
pub fn encode(keystroke: &Keystroke) -> Option<Vec<u8>> {
    // Cmd/Super is the window system's: it quits, copies and moves windows, and types nothing.
    if keystroke.modifiers.platform {
        return None;
    }
    let alt = keystroke.modifiers.alt;
    if keystroke.modifiers.control
        && let Some(byte) = control_byte(&keystroke.key)
    {
        return Some(prefixed(&[byte], alt));
    }
    if let Some(sequence) = special_key(&keystroke.key, keystroke.modifiers.shift) {
        return Some(prefixed(sequence, alt));
    }
    let text = keystroke
        .key_char
        .as_deref()
        .filter(|typed| !typed.is_empty())
        .or_else(|| (keystroke.key == "space").then_some(" "))?;
    Some(prefixed(text.as_bytes(), alt))
}

/// Alt is historically an `ESC` prefix, which is what shells and `readline` still answer to.
fn prefixed(bytes: &[u8], alt: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + usize::from(alt));
    if alt {
        out.push(0x1b);
    }
    out.extend_from_slice(bytes);
    out
}

/// `^A`..`^Z` and the four punctuation control codes, which are arithmetic on the letter.
fn control_byte(key: &str) -> Option<u8> {
    let named = match key {
        "space" => 0x00,
        "enter" | "return" => 0x0a,
        "tab" => 0x09,
        "backspace" | "delete" => 0x08,
        "escape" => 0x1b,
        _ => return letter_or_punctuation(key),
    };
    Some(named)
}

fn letter_or_punctuation(key: &str) -> Option<u8> {
    let mut characters = key.chars();
    let character = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    let byte = match character {
        'a'..='z' => character as u8 - b'a' + 1,
        'A'..='Z' => character as u8 - b'A' + 1,
        '@' | ' ' => 0x00,
        '[' => 0x1b,
        '\\' => 0x1c,
        ']' => 0x1d,
        '^' => 0x1e,
        '_' => 0x1f,
        _ => return None,
    };
    Some(byte)
}

/// The `xterm` legacy answers, in the spelling a terminfo `smkx`-less terminal sends.
fn special_key(key: &str, shift: bool) -> Option<&'static [u8]> {
    Some(match key {
        "escape" => b"\x1b".as_slice(),
        "enter" | "return" => b"\r",
        "tab" => {
            if shift {
                b"\x1b[Z"
            } else {
                b"\t"
            }
        }
        "backspace" => b"\x7f",
        "delete" => b"\x1b[3~",
        "insert" => b"\x1b[2~",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" => b"\x1b[5~",
        "pagedown" => b"\x1b[6~",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "f1" => b"\x1bOP",
        "f2" => b"\x1bOQ",
        "f3" => b"\x1bOR",
        "f4" => b"\x1bOS",
        "f5" => b"\x1b[15~",
        "f6" => b"\x1b[17~",
        "f7" => b"\x1b[18~",
        "f8" => b"\x1b[19~",
        "f9" => b"\x1b[20~",
        "f10" => b"\x1b[21~",
        "f11" => b"\x1b[23~",
        "f12" => b"\x1b[24~",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    fn keystroke(key: &str, key_char: Option<&str>, modifiers: Modifiers) -> Keystroke {
        Keystroke {
            modifiers,
            key: key.to_string(),
            key_char: key_char.map(str::to_string),
        }
    }

    fn typed(key: &str, key_char: &str) -> Keystroke {
        keystroke(key, Some(key_char), Modifiers::default())
    }

    #[test]
    fn text_and_editing_keys_are_plain_bytes() {
        assert_eq!(encode(&typed("a", "a")).unwrap(), b"a");
        assert_eq!(encode(&typed("space", " ")).unwrap(), b" ");
        assert_eq!(encode(&typed("enter", "\n")).unwrap(), b"\r");
        assert_eq!(encode(&typed("backspace", "\u{8}")).unwrap(), [0x7f]);
        assert_eq!(encode(&typed("up", "")).unwrap(), b"\x1b[A");
    }

    #[test]
    fn control_and_alt_modify_the_same_key() {
        let control = Modifiers {
            control: true,
            ..Default::default()
        };
        assert_eq!(
            encode(&keystroke("c", None, control)).unwrap(),
            [b'c' - b'a' + 1]
        );

        let alt = Modifiers {
            alt: true,
            ..Default::default()
        };
        assert_eq!(
            encode(&keystroke("a", Some("a"), alt)).unwrap(),
            [0x1b, b'a']
        );
    }

    #[test]
    fn the_platform_modifier_types_nothing() {
        let platform = Modifiers {
            platform: true,
            ..Default::default()
        };
        assert_eq!(encode(&keystroke("q", Some("q"), platform)), None);
    }
}
