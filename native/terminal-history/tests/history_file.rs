use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use lmcs_terminal_history::{BoundedHistory, read_file, write_file};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "lmcs-history-file-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
    }

    fn path(&self) -> PathBuf {
        self.0.join("history.log")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn restoring_is_read_only_until_the_caller_persists_the_capped_snapshot() {
    let directory = TempDir::new();
    let path = directory.path();
    let original = format!("{}\u{1f600}\u{feff}newest\ré", "old".repeat(32_768));
    fs::write(&path, &original).unwrap();
    let restored = read_file(&path, 15, 5).unwrap();
    assert_eq!(restored.history, "\u{feff}newest\ré");
    assert!(restored.needs_rewrite);
    assert_eq!(fs::read(&path).unwrap(), original.as_bytes());

    let history = BoundedHistory::with_limits(5, 15, restored.history.as_bytes());
    write_file(&path, &history).unwrap();
    assert_eq!(fs::read(&path).unwrap(), "\u{feff}newest\ré".as_bytes());
    let reopened = read_file(&path, 15, 5).unwrap();
    assert_eq!(reopened.history, restored.history);
    assert!(!reopened.needs_rewrite);
}

#[test]
fn snapshot_writes_replace_old_bytes_and_clear_to_an_empty_file() {
    let directory = TempDir::new();
    let path = directory.path();
    let mut history = BoundedHistory::new(b"a much longer initial snapshot");
    write_file(&path, &history).unwrap();
    history.clear();
    history.append("é\n".as_bytes());
    write_file(&path, &history).unwrap();
    assert_eq!(fs::read(&path).unwrap(), "é\n".as_bytes());
    history.clear();
    write_file(&path, &history).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
    let empty = read_file(&path, 64, 5).unwrap();
    assert!(empty.history.is_empty());
    assert!(!empty.needs_rewrite);
}

#[test]
fn missing_files_and_failed_writes_remain_io_errors() {
    let directory = TempDir::new();
    let path = directory.path();
    assert_eq!(
        read_file(&path, 64, 5).err().unwrap().kind(),
        io::ErrorKind::NotFound
    );
    assert!(!path.exists());
    let history = BoundedHistory::new(b"retained");
    assert!(write_file(&directory.0, &history).is_err());
    assert_eq!(history.value(), b"retained");
    assert_eq!(
        write_file(&directory.0.join("missing/history.log"), &history)
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    assert!(!directory.0.join("missing").exists());
}

#[test]
fn lossy_decoding_is_capped_again_but_does_not_alone_request_rewrite() {
    let directory = TempDir::new();
    let path = directory.path();
    fs::write(&path, [0xff, b'a', 0x80]).unwrap();
    let restored = read_file(&path, 64, 5).unwrap();
    assert_eq!(restored.history, "\u{fffd}a\u{fffd}");
    assert!(!restored.needs_rewrite);
    let capped = read_file(&path, 3, 5).unwrap();
    assert_eq!(capped.history, "\u{fffd}");
    assert!(capped.needs_rewrite);
    assert_eq!(fs::read(&path).unwrap(), [0xff, b'a', 0x80]);
}

fn unhex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

#[test]
fn replays_file_restoration_and_explicit_rewrites_from_the_shipped_manager() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_HISTORY_FILE_TRACE") else {
        eprintln!(
            "skipped history file golden: LMCS_TERMINAL_HISTORY_FILE_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let text = fs::read_to_string(trace).unwrap();
    let directory = TempDir::new();
    let path = directory.path();
    let mut names = HashSet::new();
    let mut rewrites = 0;
    for line in text.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 11, "{line}");
        assert_eq!(fields[0], "R");
        let name = fields[1];
        assert!(names.insert(name), "duplicate case {name}");
        let lines: usize = fields[2].parse().unwrap();
        let bytes: usize = fields[3].parse().unwrap();
        let input = unhex(fields[4]);
        let expected = unhex(fields[5]);
        let rewrite = match fields[6] {
            "0" => false,
            "1" => true,
            other => panic!("invalid rewrite flag {other}"),
        };
        let disk = unhex(fields[7]);
        fs::write(&path, &input).unwrap();
        let restored = read_file(&path, bytes, lines).unwrap();
        assert_eq!(restored.history.as_bytes(), expected, "{name}: history");
        assert_eq!(restored.needs_rewrite, rewrite, "{name}: rewrite");
        assert_eq!(fs::read(&path).unwrap(), input, "{name}: read-only restore");
        if restored.needs_rewrite {
            let history = BoundedHistory::with_limits(lines, bytes, restored.history.as_bytes());
            write_file(&path, &history).unwrap();
            rewrites += 1;
        }
        assert_eq!(fs::read(&path).unwrap(), disk, "{name}: persisted bytes");
        assert_eq!(
            read_file(&path, bytes, lines).unwrap().history.as_bytes(),
            expected,
            "{name}: reopen"
        );
        let offset: usize = fields[8].parse().unwrap();
        assert_eq!(
            offset,
            input.len().saturating_sub(bytes),
            "{name}: oracle offset"
        );
        let requests: Vec<usize> = if fields[9].is_empty() {
            Vec::new()
        } else {
            fields[9].split(',').map(|n| n.parse().unwrap()).collect()
        };
        let expected_requests: Vec<_> = (0..input.len().min(bytes))
            .step_by(5)
            .map(|read| input.len().min(bytes) - read)
            .collect();
        assert_eq!(requests, expected_requests, "{name}: oracle short reads");
        assert_eq!(fields[10], "1", "{name}: oracle closed source read");
    }
    let expected_names = HashSet::from([
        "empty",
        "bom-only",
        "bom-prefix",
        "valid-small-multiline",
        "line-cap",
        "zero-lines-terminated",
        "zero-lines-unterminated",
        "zero-bytes",
        "utf8-budget-1",
        "utf8-budget-2",
        "utf8-budget-3",
        "utf8-budget-4",
        "utf8-budget-5",
        "utf8-budget-6",
        "utf8-budget-7",
        "utf8-budget-8",
        "utf8-budget-9",
        "utf8-budget-10",
        "oversized-unicode-tail",
        "malformed-budget-64",
        "malformed-budget-3",
        "incomplete-utf8-eof",
        "bom-after-truncated-offset",
        "ordinary-controls-restored",
    ]);
    assert_eq!(names, expected_names);
    assert_eq!(rewrites, 16);
    eprintln!(
        "history file golden: {} cases, {rewrites} explicit rewrites; oracle I/O observations checked, Rust short reads covered separately",
        names.len()
    );
}
