//! The header list a handler is handed, which is **not** the list the frame carried.
//!
//! Two steps happen between the socket and an rpc, and each one is measured rather than inferred:
//!
//! 1. the transport prepends the upgrade request's own headers to every decoded `Request`
//!    (`RpcServer.ts:1554`: `headers.concat(message.headers)`), and to nothing else — an `Ack`, an
//!    `Interrupt` and a `Ping` travel without them;
//! 2. the request decoder folds that pair list into a record (`Headers.ts:145-151`, the
//!    `Symbol.iterator` branch of `fromInput`), which is where a repeated name disappears: an object
//!    key keeps the position of its **first** write and the **last** value written to it.
//!
//! The pair branch does *not* join an array value, which is the difference between the two header
//! shapes Node produces for a repeated line: everything but `set-cookie` arrives already comma-joined
//! by the HTTP parser (`headers.repeated`: one `x-probe` pair reading `one, two`), while
//! `set-cookie` arrives as a list (`headers.setCookie`: the rpc's success schema answered
//! `Expected string` at `["value"]["pairs"][5][1]` and the connection stayed open, because the
//! defect belongs to one request and not to the socket).
//!
//! A Rust server that skips either step answers a different list: appending instead of prepending
//! shows in the order, deduplicating at the socket instead of at the record shows in which value
//! survives, and joining `set-cookie` turns a measured `Die` into a pair that never existed.

use crate::envelope::Headers;

/// One header value, in the two shapes the transport can hand over.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Value {
    /// The ordinary case, including what Node's parser already collapsed out of two lines.
    Text(String),
    /// `set-cookie`, which the parser keeps as a list and `fromInput`'s pair branch passes through
    /// untouched.
    Many(Vec<String>),
}

impl Value {
    /// The value as a handler reading a header would see it, which is nothing at all for a list:
    /// `String(value)` of an array is the joined form, but no schema in the shipped group asks for
    /// that, and the measurement says the rpc *fails* instead (`headers.setCookie`).
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Many(_) => None,
        }
    }
}

/// One pair of the list a handler is handed.
pub type Pair = (String, Value);

/// `headers.concat(message.headers)` followed by the fold into a record. The socket's pairs come
/// first, so a name both lists carry keeps the socket's **position** and the frame's **value** —
/// `headers.ordered` measured exactly that, with `x-probe` sitting in the upgrade's slot and reading
/// `frame`.
#[must_use]
pub fn seen_by_handler(socket: &[Pair], frame: &Headers) -> Vec<Pair> {
    let mut out: Vec<Pair> = Vec::with_capacity(socket.len() + frame.len());
    let mut positions: Vec<(&str, usize)> = Vec::with_capacity(out.len());
    for (name, value) in socket
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .chain(
            frame
                .iter()
                .map(|(name, value)| (name.as_str(), Value::Text(value.clone()))),
        )
    {
        // The record's own rule, written without a hash map so the order stays the order an
        // `Object.entries` of that record would produce.
        match positions.iter().position(|(seen, _)| *seen == name) {
            Some(index) => out[positions[index].1].1 = value,
            None => {
                positions.push((name, out.len()));
                out.push((name.to_owned(), value));
            }
        }
    }
    out
}

/// The socket's list, from the raw lines of the upgrade request.
///
/// Names are lowercased and values trimmed, because that is what `IncomingMessage.headers` is; a
/// repeated line is joined with `", "` for the same reason, **except** `set-cookie`, which the parser
/// keeps as one entry per line. Order is arrival order, which `headers.injected` measured against the
/// order the client wrote.
#[must_use]
pub fn from_lines<'a>(lines: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<Pair> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for (name, value) in lines {
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "set-cookie" {
            match out.iter_mut().find(|(seen, _)| *seen == name) {
                Some((_, values)) => values.push(value.to_owned()),
                None => out.push((name, vec![value.to_owned()])),
            }
            continue;
        }
        match out.iter_mut().find(|(seen, _)| *seen == name) {
            Some((_, values)) => {
                let joined = values
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                *values = vec![format!("{joined}, {value}")];
            }
            None => out.push((name, vec![value.to_owned()])),
        }
    }
    out.into_iter()
        .map(|(name, mut values)| {
            (
                name,
                match values.len() {
                    // A header the parser collapsed has one entry whose own text carries the commas,
                    // so it stays a `Text`. Only `set-cookie` can reach here with more than one.
                    1 => Value::Text(values.pop().unwrap_or_default()),
                    _ => Value::Many(values),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[(&str, &str)]) -> Vec<Pair> {
        from_lines(items.iter().copied())
    }

    fn text(name: &str, value: &str) -> Pair {
        (name.to_owned(), Value::Text(value.to_owned()))
    }

    /// `headers.injected`: lowercased names, arrival order, values untouched in case.
    #[test]
    fn the_socket_list_is_the_upgrade_headers_lowercased_in_arrival_order() {
        let got = lines(&[
            ("Host", "127.0.0.1"),
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
            ("X-Probe", "one"),
            ("Cookie", "lmcs_probe=value"),
        ]);
        assert_eq!(
            got.iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            vec!["host", "upgrade", "connection", "x-probe", "cookie"],
        );
        assert_eq!(got[1], text("upgrade", "websocket"));
        assert_eq!(
            got[4],
            text("cookie", "lmcs_probe=value"),
            "the value keeps its own text",
        );
        // Both trims, not just the parser's: `Request::parse` already strips the optional whitespace
        // around a value, and this is the half that stands on its own for a caller handing over raw
        // lines. Node strips both sides (`IncomingMessage.headers`), so a port that keeps them answers
        // `" one"` where the capture read `one`.
        assert_eq!(lines(&[("X-Pad", "  both  ")]), vec![text("x-pad", "both")]);
    }

    /// `headers.repeated`: two lines become one pair whose value is the joined text.
    #[test]
    fn a_repeated_line_is_comma_joined_into_one_pair() {
        let got = lines(&[("X-Probe", "one"), ("X-Probe", "two")]);
        assert_eq!(got, vec![text("x-probe", "one, two")]);
    }

    /// `headers.setCookie`: the one name the parser keeps as a list.
    #[test]
    fn set_cookie_stays_a_list() {
        let got = lines(&[("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")]);
        assert_eq!(
            got,
            vec![(
                "set-cookie".to_owned(),
                Value::Many(vec!["a=1".to_owned(), "b=2".to_owned()]),
            )],
        );
        assert_eq!(got[0].1.as_text(), None, "no handler sees a string here");
    }

    /// `headers.ordered`: the socket's pair keeps the slot, the frame's keeps the value.
    #[test]
    fn the_frame_headers_come_after_and_win_the_value() {
        let socket = lines(&[("Host", "127.0.0.1"), ("X-Probe", "upgrade")]);
        let frame = vec![
            ("x-probe".to_owned(), "frame".to_owned()),
            ("tail".to_owned(), "2".to_owned()),
        ];
        let got = seen_by_handler(&socket, &frame);
        assert_eq!(
            got,
            vec![
                text("host", "127.0.0.1"),
                text("x-probe", "frame"),
                text("tail", "2"),
            ],
        );
    }

    /// `headers.twice`: folding a second request's pairs cannot accumulate anything, because the
    /// socket list is never written back into.
    #[test]
    fn the_socket_list_survives_being_read_twice() {
        let socket = lines(&[("X-Probe", "one")]);
        let empty: crate::envelope::Headers = Vec::new();
        let once = seen_by_handler(&socket, &empty);
        let twice = seen_by_handler(&socket, &empty);
        assert_eq!(once, twice);
        assert_eq!(twice, socket, "an empty frame list adds nothing");
    }
}
