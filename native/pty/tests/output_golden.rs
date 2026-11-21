// H records contain the shipped manager's persisted log; TerminalOutput remains memory-only.
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::{Delivery, PendingEvent};
use lmcs_terminal_history::{
    BoundedHistory, UNLIMITED_BYTES, history_path, legacy_history_path, load_history, read_file,
    write_file,
};

struct HistoryDirectory(std::path::PathBuf);

impl Drop for HistoryDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn output_snapshots_reopen_and_clear_without_persisting_raw_queries() {
    let path = std::env::temp_dir().join(format!(
        "lmcs-output-history-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&path).unwrap();
    let directory = HistoryDirectory(path);
    let path = history_path(&directory.0, "thread/one", "term-1");
    let legacy = legacy_history_path(&directory.0, "thread/one");
    let history = BoundedHistory::with_limits(3, 128, b"restored\n");
    write_file(&legacy, &history).unwrap();
    let loaded = load_history(&directory.0, "thread/one", "term-1", 128, 3).unwrap();
    assert!(loaded.cleanup_warning.is_none());
    assert!(!legacy.exists());
    assert_eq!(std::fs::read(&path).unwrap(), b"restored\n");
    let mut output = TerminalOutput::new(loaded.history);
    output.start(7);
    for chunk in ["prompt\x1b[6", "n\x1b[31mred\x1b[0m\r\n", "done\x1b]11;"] {
        assert!(output.enqueue(7, PendingEvent::Data(chunk.to_string())));
        let Delivery::Output { data, .. } = output.drain_next(7).unwrap() else {
            panic!("expected output");
        };
        assert_eq!(data, chunk);
        assert_eq!(output.drain_next(7), None);
    }
    assert_eq!(std::fs::read(&path).unwrap(), b"restored\n");
    output.close();
    write_file(&path, output.history()).unwrap();
    let reopened = read_file(&path, 128, 3).unwrap();
    assert_eq!(
        reopened.history,
        "restored\nprompt\x1b[31mred\x1b[0m\r\ndone"
    );
    assert!(!reopened.needs_rewrite);
    assert_eq!(std::fs::read(&path).unwrap(), output.history().value());

    output.start(8);
    output.clear();
    write_file(&path, output.history()).unwrap();
    assert!(read_file(&path, 128, 3).unwrap().history.is_empty());
    assert!(output.enqueue(8, PendingEvent::Data("new".to_string())));
    assert!(output.drain_next(8).is_some());
    write_file(&path, output.history()).unwrap();
    assert_eq!(read_file(&path, 128, 3).unwrap().history, "new");
}

fn unhex(value: &str, line_number: usize) -> String {
    assert!(
        value.len().is_multiple_of(2) && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "line {line_number}: expected complete hex bytes"
    );
    let bytes = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("validated hex byte"))
        .collect();
    String::from_utf8(bytes)
        .unwrap_or_else(|_| panic!("line {line_number}: expected UTF-8 terminal text"))
}

fn replay(limits: (usize, usize), chunks: &[String], expected: &[u8]) {
    let pid = 9000;
    let mut burst = TerminalOutput::new(BoundedHistory::with_limits(limits.0, limits.1, b""));
    let mut streamed = TerminalOutput::new(BoundedHistory::with_limits(limits.0, limits.1, b""));
    let started = burst.start(pid);
    assert_eq!(started, 1);
    assert_eq!(streamed.start(pid), started);
    let mut streamed_deliveries = Vec::new();

    for (index, chunk) in chunks.iter().enumerate() {
        assert_eq!(
            burst.enqueue(pid, PendingEvent::Data(chunk.clone())),
            index == 0
        );
        assert!(streamed.enqueue(pid, PendingEvent::Data(chunk.clone())));
        streamed_deliveries.push(streamed.drain_next(pid).expect("one delivery per chunk"));
        assert_eq!(streamed.drain_next(pid), None);
        assert_eq!(streamed.queued(), 0);
    }

    assert_eq!(burst.queued(), chunks.len());
    assert_eq!(burst.sequence(), started);
    assert!(
        burst.history().value().is_empty(),
        "history changed before dequeue"
    );
    let mut burst_deliveries = Vec::new();
    while let Some(delivery) = burst.drain_next(pid) {
        burst_deliveries.push(delivery);
    }

    for (schedule, output, deliveries) in [
        ("burst", &burst, &burst_deliveries),
        ("streamed", &streamed, &streamed_deliveries),
    ] {
        assert_eq!(deliveries.len(), chunks.len(), "{schedule} {limits:?}");
        for (index, (delivery, chunk)) in deliveries.iter().zip(chunks).enumerate() {
            let Delivery::Output { sequence, data, .. } = delivery else {
                panic!("{schedule} {limits:?} chunk {index}: unexpected exit");
            };
            assert_eq!(data, chunk, "{schedule} {limits:?} raw chunk {index}");
            assert_eq!(
                *sequence,
                started + index as u64 + 1,
                "{schedule} {limits:?} chunk {index} sequence"
            );
        }
        assert_eq!(output.queued(), 0, "{schedule} {limits:?}");
        assert_eq!(output.sequence(), started + chunks.len() as u64);
        assert_eq!(
            output.history().value(),
            expected,
            "{schedule} {limits:?}: history differs from the shipped persisted log"
        );
    }
    assert_eq!(
        burst_deliveries, streamed_deliveries,
        "schedule changed deliveries for {limits:?}"
    );
}

#[test]
fn burst_and_streamed_output_preserve_raw_chunks_and_match_shipped_persisted_history() {
    let Some(path) = std::env::var_os("LMCS_TERMINAL_HISTORY_SANITIZE_TRACE") else {
        eprintln!(
            "skipped output golden: LMCS_TERMINAL_HISTORY_SANITIZE_TRACE is unset; no cross-language check ran"
        );
        return;
    };
    let text = std::fs::read_to_string(path).expect("the sanitizer trace file is readable");
    let mut limits = None;
    let mut chunks = Vec::new();
    let mut configs = Vec::new();
    let mut replayed_chunks = 0;

    for (index, line) in text.lines().enumerate() {
        let line_number = index + 1;
        let (op, rest) = line
            .split_once(' ')
            .unwrap_or_else(|| panic!("line {line_number}: expected a record and its payload"));
        match op {
            "C" => {
                assert!(limits.is_none(), "line {line_number}: unfinished config");
                let config = match rest {
                    "5000 INF" => (5000, UNLIMITED_BYTES),
                    "3 INF" => (3, UNLIMITED_BYTES),
                    "5000 24" => (5000, 24),
                    _ => panic!("line {line_number}: unexpected or malformed config {rest:?}"),
                };
                assert!(
                    !configs.contains(&config),
                    "line {line_number}: duplicate config"
                );
                limits = Some(config);
                chunks.clear();
            }
            "I" => {
                assert!(
                    limits.is_some(),
                    "line {line_number}: chunk without a config"
                );
                chunks.push(unhex(rest, line_number));
            }
            "H" => {
                let config = limits
                    .take()
                    .unwrap_or_else(|| panic!("line {line_number}: history without a config"));
                assert!(
                    !chunks.is_empty(),
                    "line {line_number}: config has no chunks"
                );
                let expected = unhex(rest, line_number);
                replay(config, &chunks, expected.as_bytes());
                replayed_chunks += chunks.len();
                configs.push(config);
            }
            _ => panic!("line {line_number}: unknown record {op:?}"),
        }
    }

    assert!(limits.is_none(), "the trace ends mid-config");
    configs.sort_unstable();
    assert_eq!(
        configs,
        [(3, UNLIMITED_BYTES), (5000, 24), (5000, UNLIMITED_BYTES)]
    );
    assert!(
        replayed_chunks >= 150,
        "only {replayed_chunks} trace chunks replayed"
    );
    eprintln!("output golden: 3 configs, {replayed_chunks} chunks replayed under both schedules");
}
