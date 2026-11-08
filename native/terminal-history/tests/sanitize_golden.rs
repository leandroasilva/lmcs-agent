//! Replays a trace captured from the shipped `TerminalManager` — spawn, PTY reads,
//! close, and the persisted history log — so the Rust sanitizer and its
//! composition with `BoundedHistory` are checked against the real pipeline.
//!
//! Set `LMCS_TERMINAL_HISTORY_SANITIZE_TRACE` to a trace file; the test skips when
//! unset. Regenerate one with:
//! `node apps/server/scripts/terminal-sanitize-trace.ts > /tmp/sanitize-trace.txt`

use lmcs_terminal_history::{BoundedHistory, UNLIMITED_BYTES, sanitize};

fn unhex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect()
}

#[test]
fn replays_the_shipped_managers_persisted_history() {
    let Some(path) = std::env::var_os("LMCS_TERMINAL_HISTORY_SANITIZE_TRACE") else {
        eprintln!(
            "skipped: LMCS_TERMINAL_HISTORY_SANITIZE_TRACE is unset, so no cross-language check ran"
        );
        return;
    };
    let text = std::fs::read_to_string(&path).expect("the trace file is readable");

    let mut limits: Option<(usize, usize)> = None;
    let mut chunks: Vec<String> = Vec::new();
    let mut configs = 0;
    let mut replays = 0;

    for (line_number, line) in text.lines().enumerate() {
        let (op, rest) = line.split_once(' ').unwrap_or((line, ""));
        let at =
            |what: &str| -> ! { panic!("line {}: expected {what} in {line:?}", line_number + 1) };

        match op {
            "C" => {
                if limits.is_some() {
                    at("a finished config");
                }
                let mut fields = rest.split(' ');
                let max_lines: usize = fields
                    .next()
                    .unwrap_or_default()
                    .parse()
                    .unwrap_or_else(|_| at("a line limit"));
                let max_bytes = match fields.next() {
                    Some("INF") => UNLIMITED_BYTES,
                    Some(value) => value.parse().unwrap_or_else(|_| at("a byte limit")),
                    None => at("a byte limit"),
                };
                if fields.next().is_some() {
                    at("no trailing fields");
                }
                limits = Some((max_lines, max_bytes));
                chunks.clear();
            }
            "I" => {
                if limits.is_none() {
                    at("a config");
                }
                chunks.push(String::from_utf8(unhex(rest)).unwrap_or_else(|_| at("a UTF-8 chunk")));
            }
            "H" => {
                let Some((max_lines, max_bytes)) = limits.take() else {
                    at("a config");
                };
                let expected = unhex(rest);

                // The manager holds a control sequence that a PTY read cut open
                // and feeds it back on the next read.
                let mut pending = String::new();
                let mut history = BoundedHistory::with_limits(max_lines, max_bytes, b"");
                for chunk in &chunks {
                    let sanitized = sanitize(&pending, chunk);
                    pending = sanitized.pending;
                    if !sanitized.visible.is_empty() {
                        history.append(sanitized.visible.as_bytes());
                    }
                }
                assert_eq!(
                    pending, "",
                    "config {max_lines}/{max_bytes} ended holding {pending:?}"
                );
                assert_eq!(
                    history.value(),
                    expected,
                    "config {max_lines}/{max_bytes}: the shipped manager persisted {:?}",
                    String::from_utf8_lossy(&expected)
                );
                configs += 1;
                replays += chunks.len();
            }
            _ => at("a known record"),
        }
    }

    assert!(limits.is_none(), "the trace ends mid-config");
    assert!(configs >= 3, "only {configs} configs replayed");
    assert!(replays >= 150, "only {replays} chunks replayed");
}
