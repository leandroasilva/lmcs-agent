use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::{BoundedHistory, Restored, read_file, write_file};

pub const DEFAULT_TERMINAL_ID: &str = "term-1";

pub fn history_path(logs_dir: &Path, thread_id: &str, terminal_id: &str) -> PathBuf {
    logs_dir.join(history_file_name(thread_id, terminal_id))
}

fn history_file_name(thread_id: &str, terminal_id: &str) -> String {
    let thread = base64_url(thread_id);
    if terminal_id == DEFAULT_TERMINAL_ID {
        format!("terminal_{thread}.log")
    } else {
        format!("terminal_{thread}_{}.log", base64_url(terminal_id))
    }
}

pub fn legacy_history_path(logs_dir: &Path, thread_id: &str) -> PathBuf {
    logs_dir.join(legacy_file_name(thread_id))
}

fn legacy_file_name(thread_id: &str) -> String {
    // The legacy JavaScript regex replaces UTF-16 units, not Unicode scalar values.
    let name: String = thread_id
        .encode_utf16()
        .map(|unit| match unit {
            45 | 46 | 48..=57 | 65..=90 | 95 | 97..=122 => char::from(unit as u8),
            _ => '_',
        })
        .collect();
    format!("{name}.log")
}

fn base64_url(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::with_capacity(text.len().div_ceil(3) * 4);
    for chunk in text.as_bytes().chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..chunk.len() + 1 {
            encoded.push(char::from(
                ALPHABET[((bits >> (18 - index * 6)) & 63) as usize],
            ));
        }
    }
    encoded
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryOperation {
    Read,
    Truncate,
    Migrate,
}

impl fmt::Display for HistoryOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Read => "read",
            Self::Truncate => "truncate",
            Self::Migrate => "migrate",
        })
    }
}

#[derive(Debug)]
pub struct TerminalHistoryError {
    pub operation: HistoryOperation,
    pub thread_id: String,
    pub terminal_id: String,
    pub cause: io::Error,
}

impl fmt::Display for TerminalHistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Failed to {} terminal history for thread: {}, terminal: {}",
            self.operation, self.thread_id, self.terminal_id
        )
    }
}

impl std::error::Error for TerminalHistoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

pub struct LoadedHistory {
    pub history: BoundedHistory,
    /// The caller should log this nonfatal failure to remove the migrated legacy file.
    pub cleanup_warning: Option<io::Error>,
}

/// Blocking restoration and migration; the caller owns scheduling and warning publication.
pub fn load_history(
    logs_dir: &Path,
    thread_id: &str,
    terminal_id: &str,
    byte_limit: usize,
    line_limit: usize,
) -> Result<LoadedHistory, TerminalHistoryError> {
    load_with(
        &mut Disk,
        logs_dir,
        thread_id,
        terminal_id,
        byte_limit,
        line_limit,
    )
}

trait HistoryIo {
    fn exists(&mut self, path: &Path) -> io::Result<bool>;
    fn read(&mut self, path: &Path, byte_limit: usize, line_limit: usize) -> io::Result<Restored>;
    fn write(&mut self, path: &Path, history: &BoundedHistory) -> io::Result<()>;
    fn remove(&mut self, path: &Path) -> io::Result<()>;
    fn read_dir(&mut self, dir: &Path) -> io::Result<Vec<OsString>>;
}

struct Disk;

impl HistoryIo for Disk {
    fn exists(&mut self, path: &Path) -> io::Result<bool> {
        path.try_exists()
    }

    fn read(&mut self, path: &Path, byte_limit: usize, line_limit: usize) -> io::Result<Restored> {
        read_file(path, byte_limit, line_limit)
    }

    fn write(&mut self, path: &Path, history: &BoundedHistory) -> io::Result<()> {
        write_file(path, history)
    }

    fn remove(&mut self, path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn read_dir(&mut self, dir: &Path) -> io::Result<Vec<OsString>> {
        // `readdir` with `recursive: false`: entry names, in whatever order the directory gives
        // them. Node does not sort and neither do we, so the sweep order is filesystem order on
        // both sides.
        fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    }
}

fn load_with(
    disk: &mut impl HistoryIo,
    logs_dir: &Path,
    thread_id: &str,
    terminal_id: &str,
    byte_limit: usize,
    line_limit: usize,
) -> Result<LoadedHistory, TerminalHistoryError> {
    let error = |operation, cause| TerminalHistoryError {
        operation,
        thread_id: thread_id.to_owned(),
        terminal_id: terminal_id.to_owned(),
        cause,
    };
    let current = history_path(logs_dir, thread_id, terminal_id);
    if disk
        .exists(&current)
        .map_err(|cause| error(HistoryOperation::Read, cause))?
    {
        let restored = disk
            .read(&current, byte_limit, line_limit)
            .map_err(|cause| error(HistoryOperation::Read, cause))?;
        let history =
            BoundedHistory::with_limits(line_limit, byte_limit, restored.history.as_bytes());
        if restored.needs_rewrite {
            disk.write(&current, &history)
                .map_err(|cause| error(HistoryOperation::Truncate, cause))?;
        }
        return Ok(LoadedHistory {
            history,
            cleanup_warning: None,
        });
    }
    if terminal_id == DEFAULT_TERMINAL_ID {
        let legacy = legacy_history_path(logs_dir, thread_id);
        if disk
            .exists(&legacy)
            .map_err(|cause| error(HistoryOperation::Migrate, cause))?
        {
            let restored = disk
                .read(&legacy, byte_limit, line_limit)
                .map_err(|cause| error(HistoryOperation::Migrate, cause))?;
            let history =
                BoundedHistory::with_limits(line_limit, byte_limit, restored.history.as_bytes());
            disk.write(&current, &history)
                .map_err(|cause| error(HistoryOperation::Migrate, cause))?;
            let cleanup_warning = disk.remove(&legacy).err();
            return Ok(LoadedHistory {
                history,
                cleanup_warning,
            });
        }
    }
    Ok(LoadedHistory {
        history: BoundedHistory::with_limits(line_limit, byte_limit, b""),
        cleanup_warning: None,
    })
}

/// A history file the disk refused to remove. Both shipped deletion paths log a warning and
/// return success, so a failure here never reaches the caller's result — only its logs.
#[derive(Debug)]
pub struct DeleteFailure {
    pub path: PathBuf,
    pub cause: io::Error,
}

/// `deleteHistory`: the terminal's own file, plus the legacy file for the default terminal only.
/// The legacy removal is attempted even if the first one failed, and a missing file is not a
/// failure — the shipped call passes `force: true`, which only swallows `ENOENT`.
pub fn delete_history(logs_dir: &Path, thread_id: &str, terminal_id: &str) -> Vec<DeleteFailure> {
    delete_history_with(&mut Disk, logs_dir, thread_id, terminal_id)
}

/// `deleteAllHistoryForThread`: sweep the directory for everything that belongs to this thread —
/// its default file, its legacy file, and every secondary file named under its encoded prefix. An
/// unreadable directory is silently empty, as the shipped `orElseSucceed` is, and one file that
/// cannot be removed never stops the ones after it.
pub fn delete_thread_history(logs_dir: &Path, thread_id: &str) -> Vec<DeleteFailure> {
    delete_thread_history_with(&mut Disk, logs_dir, thread_id)
}

fn delete_history_with(
    disk: &mut impl HistoryIo,
    logs_dir: &Path,
    thread_id: &str,
    terminal_id: &str,
) -> Vec<DeleteFailure> {
    let mut failures = Vec::new();
    let current = history_path(logs_dir, thread_id, terminal_id);
    if let Err(cause) = disk.remove(&current) {
        failures.push(DeleteFailure {
            path: current,
            cause,
        });
    }
    if terminal_id == DEFAULT_TERMINAL_ID {
        let legacy = legacy_history_path(logs_dir, thread_id);
        if let Err(cause) = disk.remove(&legacy) {
            failures.push(DeleteFailure {
                path: legacy,
                cause,
            });
        }
    }
    failures
}

fn delete_thread_history_with(
    disk: &mut impl HistoryIo,
    logs_dir: &Path,
    thread_id: &str,
) -> Vec<DeleteFailure> {
    let Ok(entries) = disk.read_dir(logs_dir) else {
        return Vec::new();
    };
    let thread = base64_url(thread_id);
    let default_name = OsString::from(history_file_name(thread_id, DEFAULT_TERMINAL_ID));
    let legacy_name = OsString::from(legacy_file_name(thread_id));
    let prefix = format!("terminal_{thread}_");
    let mut failures = Vec::new();
    for entry in entries {
        let matches = entry == default_name
            || entry == legacy_name
            || entry.to_string_lossy().starts_with(&prefix);
        if !matches {
            continue;
        }
        let path = logs_dir.join(&entry);
        if let Err(cause) = disk.remove(&path) {
            failures.push(DeleteFailure { path, cause });
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "lmcs-history-store-{}-{}",
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
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[derive(Default)]
    struct TrackedDisk {
        calls: Vec<String>,
        failure: Option<(String, PathBuf)>,
    }

    impl TrackedDisk {
        fn record(&mut self, operation: &str, path: &Path) -> io::Result<()> {
            self.calls.push(format!(
                "{operation}:{}",
                path.file_name().unwrap().to_str().unwrap()
            ));
            if self
                .failure
                .as_ref()
                .is_some_and(|(op, target)| op == operation && target == path)
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected history failure",
                ));
            }
            Ok(())
        }
    }

    impl HistoryIo for TrackedDisk {
        fn exists(&mut self, path: &Path) -> io::Result<bool> {
            self.record("exists", path)?;
            Disk.exists(path)
        }
        fn read(&mut self, path: &Path, bytes: usize, lines: usize) -> io::Result<Restored> {
            self.record("read", path)?;
            Disk.read(path, bytes, lines)
        }
        fn write(&mut self, path: &Path, history: &BoundedHistory) -> io::Result<()> {
            self.record("write", path)?;
            Disk.write(path, history)
        }
        fn remove(&mut self, path: &Path) -> io::Result<()> {
            self.record("remove", path)?;
            Disk.remove(path)
        }
        fn read_dir(&mut self, dir: &Path) -> io::Result<Vec<OsString>> {
            self.record("read_dir", dir)?;
            Disk.read_dir(dir)
        }
    }

    #[test]
    fn filenames_are_unpadded_utf8_base64url_and_legacy_uses_utf16_units() {
        let root = Path::new("logs");
        for (id, encoded) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("hello?", "aGVsbG8_"),
            ("\u{1f600}", "8J-YgA"),
            ("é", "w6k"),
        ] {
            assert_eq!(
                history_path(root, id, DEFAULT_TERMINAL_ID),
                root.join(format!("terminal_{encoded}.log"))
            );
            assert_eq!(
                history_path(root, "foo", id),
                root.join(format!("terminal_Zm9v_{encoded}.log"))
            );
        }
        assert_eq!(
            legacy_history_path(root, "AZaz09._-/é\u{1f600}"),
            root.join("AZaz09._-____.log")
        );
        for id in ["../../escape", "x\\y", "\0\r\n", "\u{1f600}"] {
            assert_eq!(history_path(root, id, id).parent(), Some(root));
            assert_eq!(legacy_history_path(root, id).parent(), Some(root));
        }
        assert_ne!(
            history_path(root, "a/b", "term-1"),
            history_path(root, "a?b", "term-1")
        );
        assert_eq!(
            legacy_history_path(root, "a/b"),
            legacy_history_path(root, "a?b")
        );
    }

    #[test]
    fn current_even_empty_wins_and_secondary_never_touches_legacy() {
        let dir = TempDir::new();
        let legacy = legacy_history_path(&dir.0, "thread");
        let current = history_path(&dir.0, "thread", "term-1");
        fs::write(&legacy, b"old").unwrap();
        fs::write(&current, b"").unwrap();
        let mut disk = TrackedDisk::default();
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-1", 64, 5).unwrap();
        assert!(loaded.history.value().is_empty());
        assert!(loaded.cleanup_warning.is_none());
        assert_eq!(
            disk.calls,
            ["exists:terminal_dGhyZWFk.log", "read:terminal_dGhyZWFk.log"]
        );
        disk.calls.clear();
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-2", 64, 5).unwrap();
        assert!(loaded.history.value().is_empty());
        assert_eq!(disk.calls, ["exists:terminal_dGhyZWFk_dGVybS0y.log"]);
        assert_eq!(fs::read(&legacy).unwrap(), b"old");
        assert!(!history_path(&dir.0, "thread", "term-2").exists());
    }

    #[test]
    fn migration_caps_replaces_then_removes_and_reopen_reads_current() {
        let dir = TempDir::new();
        let legacy = legacy_history_path(&dir.0, "thread");
        let current = history_path(&dir.0, "thread", "term-1");
        fs::write(&legacy, "discard\n\u{1f600}\u{feff}newest\ré").unwrap();
        let mut disk = TrackedDisk::default();
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-1", 15, 5).unwrap();
        assert_eq!(loaded.history.value(), "\u{feff}newest\ré".as_bytes());
        assert!(loaded.cleanup_warning.is_none());
        assert_eq!(fs::read(&current).unwrap(), loaded.history.value());
        assert!(!legacy.exists());
        assert_eq!(
            disk.calls,
            [
                "exists:terminal_dGhyZWFk.log",
                "exists:thread.log",
                "read:thread.log",
                "write:terminal_dGhyZWFk.log",
                "remove:thread.log"
            ]
        );
        let reopened = load_history(&dir.0, "thread", "term-1", 15, 5).unwrap();
        assert_eq!(reopened.history.value(), loaded.history.value());
    }

    #[test]
    fn migration_writes_empty_and_lossy_snapshots_even_without_truncation() {
        let dir = TempDir::new();
        for (index, input) in [b"".as_slice(), &[0xff, b'a', 0x80]]
            .into_iter()
            .enumerate()
        {
            let id = format!("thread-{index}");
            let legacy = legacy_history_path(&dir.0, &id);
            let current = history_path(&dir.0, &id, "term-1");
            fs::write(&legacy, input).unwrap();
            let loaded = load_history(&dir.0, &id, "term-1", 64, 5).unwrap();
            assert_eq!(
                fs::read(current).unwrap(),
                String::from_utf8_lossy(input).as_bytes()
            );
            assert_eq!(
                loaded.history.value(),
                String::from_utf8_lossy(input).as_bytes()
            );
            assert!(!legacy.exists());
        }
    }

    #[test]
    fn current_rewrites_only_when_capped_and_keeps_configured_limits() {
        let dir = TempDir::new();
        let current = history_path(&dir.0, "thread", "term-1");
        fs::write(&current, [0xff, b'a', 0x80]).unwrap();
        let mut disk = TrackedDisk::default();
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-1", 64, 5).unwrap();
        assert_eq!(loaded.history.value(), "\u{fffd}a\u{fffd}".as_bytes());
        assert_eq!(disk.calls.len(), 2);
        assert_eq!(fs::read(&current).unwrap(), [0xff, b'a', 0x80]);
        let mut loaded = load_history(&dir.0, "thread", "term-1", 3, 5).unwrap();
        assert_eq!(fs::read(&current).unwrap(), "\u{fffd}".as_bytes());
        loaded.history.append(b"longer");
        assert_eq!(loaded.history.value(), b"ger");
        fs::write(&current, b"first\nlast\n").unwrap();
        assert_eq!(
            load_history(&dir.0, "thread", "term-1", 64, 1)
                .unwrap()
                .history
                .value(),
            b"last\n"
        );
        assert_eq!(fs::read(&current).unwrap(), b"last\n");
    }

    #[test]
    fn missing_history_does_not_create_files_or_parent_directories() {
        let dir = TempDir::new();
        let root = dir.0.join("missing");
        for terminal in ["term-1", "term-2"] {
            let mut loaded = load_history(&root, "thread", terminal, 3, 5).unwrap();
            assert!(loaded.history.value().is_empty());
            assert!(loaded.cleanup_warning.is_none());
            loaded.history.append(b"longer");
            assert_eq!(loaded.history.value(), b"ger");
        }
        assert!(!root.exists());
    }

    #[test]
    fn failures_keep_context_and_never_remove_legacy_before_successful_write() {
        let dir = TempDir::new();
        let current = history_path(&dir.0, "thread", "term-1");
        let legacy = legacy_history_path(&dir.0, "thread");
        fs::write(&legacy, b"legacy").unwrap();
        for (seed_current, operation, target, expected) in [
            (true, "exists", &current, HistoryOperation::Read),
            (true, "read", &current, HistoryOperation::Read),
            (true, "write", &current, HistoryOperation::Truncate),
            (false, "exists", &legacy, HistoryOperation::Migrate),
            (false, "read", &legacy, HistoryOperation::Migrate),
            (false, "write", &current, HistoryOperation::Migrate),
        ] {
            Disk.remove(&current).unwrap();
            if seed_current {
                fs::write(&current, b"current").unwrap();
            }
            let mut disk = TrackedDisk {
                failure: Some((operation.to_owned(), target.clone())),
                ..Default::default()
            };
            let error = load_with(&mut disk, &dir.0, "thread", "term-1", 3, 5)
                .err()
                .unwrap();
            assert_eq!(error.operation, expected);
            assert_eq!(error.thread_id, "thread");
            assert_eq!(error.terminal_id, "term-1");
            assert_eq!(error.cause.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(
                error.to_string(),
                format!(
                    "Failed to {expected} terminal history for thread: thread, terminal: term-1"
                )
            );
            assert!(std::error::Error::source(&error).is_some());
            assert_eq!(
                disk.calls.last().unwrap(),
                &format!(
                    "{operation}:{}",
                    target.file_name().unwrap().to_str().unwrap()
                )
            );
            assert!(!disk.calls.iter().any(|call| call.starts_with("remove:")));
            assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
            if seed_current {
                assert_eq!(fs::read(&current).unwrap(), b"current");
            } else {
                assert!(!current.exists());
            }
        }
    }

    #[test]
    fn failed_legacy_cleanup_returns_warning_and_current_wins_on_retry() {
        let dir = TempDir::new();
        let legacy = legacy_history_path(&dir.0, "thread");
        let current = history_path(&dir.0, "thread", "term-1");
        fs::write(&legacy, b"legacy").unwrap();
        let mut disk = TrackedDisk {
            failure: Some(("remove".to_owned(), legacy.clone())),
            ..Default::default()
        };
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-1", 3, 5).unwrap();
        assert_eq!(
            loaded.cleanup_warning.unwrap().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(loaded.history.value(), b"acy");
        assert_eq!(fs::read(&current).unwrap(), b"acy");
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
        disk.calls.clear();
        let loaded = load_with(&mut disk, &dir.0, "thread", "term-1", 3, 5).unwrap();
        assert!(loaded.cleanup_warning.is_none());
        assert_eq!(loaded.history.value(), b"acy");
        assert_eq!(
            disk.calls,
            ["exists:terminal_dGhyZWFk.log", "read:terminal_dGhyZWFk.log"]
        );
    }

    #[test]
    fn real_read_errors_do_not_fall_back_to_legacy() {
        let dir = TempDir::new();
        let current = history_path(&dir.0, "thread", "term-1");
        let legacy = legacy_history_path(&dir.0, "thread");
        fs::create_dir(&current).unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        let error = load_history(&dir.0, "thread", "term-1", 64, 5)
            .err()
            .unwrap();
        assert_eq!(error.operation, HistoryOperation::Read);
        assert!(current.is_dir());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
        fs::remove_dir(&current).unwrap();
        fs::remove_file(&legacy).unwrap();
        fs::create_dir(&legacy).unwrap();
        let error = load_history(&dir.0, "thread", "term-1", 64, 5)
            .err()
            .unwrap();
        assert_eq!(error.operation, HistoryOperation::Migrate);
        assert!(!current.exists());
    }

    fn names(disk: &TrackedDisk) -> String {
        disk.calls.join(",")
    }

    #[test]
    fn deleting_the_default_terminal_removes_current_then_legacy() {
        let dir = TempDir::new();
        let current = history_path(&dir.0, "thread", "term-1");
        let legacy = legacy_history_path(&dir.0, "thread");
        fs::write(&current, b"current").unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        let mut disk = TrackedDisk::default();
        assert!(delete_history_with(&mut disk, &dir.0, "thread", "term-1").is_empty());
        assert_eq!(
            names(&disk),
            "remove:terminal_dGhyZWFk.log,remove:thread.log"
        );
        assert!(!current.exists() && !legacy.exists());
    }

    #[test]
    fn a_missing_history_is_not_a_delete_failure() {
        let dir = TempDir::new();
        fs::write(dir.0.join("unrelated.txt"), b"keep").unwrap();
        let mut disk = TrackedDisk::default();
        assert!(delete_history_with(&mut disk, &dir.0, "thread", "term-1").is_empty());
        assert_eq!(fs::read(dir.0.join("unrelated.txt")).unwrap(), b"keep");
        // The parent directory does not have to exist either: the shipped call is `force: true`.
        let missing = dir.0.join("absent");
        assert!(delete_history(&missing, "thread", "term-1").is_empty());
        assert!(!missing.exists());
    }

    #[test]
    fn deleting_a_secondary_never_touches_the_legacy_file() {
        let dir = TempDir::new();
        let secondary = history_path(&dir.0, "thread", "term-2");
        let legacy = legacy_history_path(&dir.0, "thread");
        fs::write(&secondary, b"secondary").unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        let mut disk = TrackedDisk::default();
        assert!(delete_history_with(&mut disk, &dir.0, "thread", "term-2").is_empty());
        assert_eq!(names(&disk), "remove:terminal_dGhyZWFk_dGVybS0y.log");
        assert!(!secondary.exists());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
    }

    #[test]
    fn a_failed_removal_is_a_warning_and_the_other_removal_still_runs() {
        let dir = TempDir::new();
        let current = history_path(&dir.0, "thread", "term-1");
        let legacy = legacy_history_path(&dir.0, "thread");
        fs::write(&current, b"current").unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        let mut disk = TrackedDisk {
            failure: Some(("remove".to_owned(), current.clone())),
            ..Default::default()
        };
        let failures = delete_history_with(&mut disk, &dir.0, "thread", "term-1");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].path, current);
        assert_eq!(failures[0].cause.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            names(&disk),
            "remove:terminal_dGhyZWFk.log,remove:thread.log",
            "the legacy removal is not gated on the first one succeeding"
        );
        assert_eq!(fs::read(&current).unwrap(), b"current");
        assert!(!legacy.exists());
    }

    #[test]
    fn the_thread_sweep_matches_exactly_three_name_rules() {
        let dir = TempDir::new();
        let thread = "thread";
        let mine = [
            history_path(&dir.0, thread, "term-1"),
            history_path(&dir.0, thread, "term-2"),
            history_path(&dir.0, thread, "term-99"),
            legacy_history_path(&dir.0, thread),
        ];
        let others = [
            history_path(&dir.0, "other", "term-1"),
            history_path(&dir.0, "other", "term-2"),
            legacy_history_path(&dir.0, "other"),
            dir.0.join("unrelated.log"),
            dir.0.join("terminal_dGhyZWFk.txt"),
            dir.0.join("terminal_dGhyZWFkx.log"),
        ];
        for path in mine.iter().chain(others.iter()) {
            fs::write(path, b"content").unwrap();
        }
        // A name that matches the rules but is not a file: attempted, and its failure is a warning.
        fs::create_dir(dir.0.join("terminal_dGhyZWFk_dir.log")).unwrap();

        let mut disk = TrackedDisk::default();
        let failures = delete_thread_history_with(&mut disk, &dir.0, thread);
        let removed: std::collections::HashSet<_> = disk
            .calls
            .iter()
            .filter_map(|call| call.strip_prefix("remove:"))
            .map(str::to_owned)
            .collect();
        assert_eq!(
            removed,
            [
                "terminal_dGhyZWFk.log",
                "terminal_dGhyZWFk_dGVybS0y.log",
                "terminal_dGhyZWFk_dGVybS05OQ.log",
                "thread.log",
                "terminal_dGhyZWFk_dir.log",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            "default, every secondary and the legacy name — nothing else"
        );
        for path in &mine {
            assert!(!path.exists(), "{} survived", path.display());
        }
        for path in &others {
            assert!(path.exists(), "{} was swept", path.display());
        }
        assert_eq!(
            failures.len(),
            1,
            "the matching directory could not be unlinked"
        );
        assert_eq!(failures[0].path, dir.0.join("terminal_dGhyZWFk_dir.log"));
    }

    #[test]
    fn two_ids_that_sanitize_to_one_legacy_name_share_its_deletion() {
        let dir = TempDir::new();
        let legacy = legacy_history_path(&dir.0, "t1read?");
        assert_eq!(legacy, legacy_history_path(&dir.0, "t1read!"));
        fs::write(&legacy, b"shared").unwrap();
        let current = history_path(&dir.0, "t1read?", "term-1");
        fs::write(&current, b"mine").unwrap();
        assert!(delete_history(&dir.0, "t1read?", "term-1").is_empty());
        assert!(
            !legacy.exists(),
            "deleting one id's history removes the file the other id would restore"
        );
    }

    #[test]
    fn a_sweep_takes_the_file_of_the_thread_whose_encoding_starts_with_the_prefix() {
        // Measured: id `a` encodes to `YQ`, and a different id whose encoding begins with `YQ_`
        // has its files caught by the prefix rule. The shipped sweep deletes them, so this one does
        // too — a single close does not, because it only ever names its own thread.
        let dir = TempDir::new();
        let host = "a";
        let victim = "a\u{f}\u{c3}";
        let victim_current = history_path(&dir.0, victim, "term-1");
        let victim_secondary = history_path(&dir.0, victim, "term-2");
        assert_eq!(
            victim_current.file_name().unwrap().to_str().unwrap(),
            "terminal_YQ_Dgw.log",
        );
        fs::write(&victim_current, b"other-thread").unwrap();
        fs::write(&victim_secondary, b"other-thread").unwrap();
        assert!(delete_history(&dir.0, host, "term-1").is_empty());
        assert!(
            victim_current.exists() && victim_secondary.exists(),
            "the victim's files are neither this thread's current nor its legacy name"
        );
        assert!(delete_thread_history(&dir.0, host).is_empty());
        assert!(
            !victim_current.exists() && !victim_secondary.exists(),
            "both encoded names start with the swept thread's prefix"
        );
    }

    #[test]
    fn a_sweep_takes_a_legacy_name_that_another_thread_also_owns() {
        let dir = TempDir::new();
        let victim = "x:y";
        let victim_current = history_path(&dir.0, victim, "term-1");
        let shared = legacy_history_path(&dir.0, victim);
        assert_eq!(shared, legacy_history_path(&dir.0, "x/y"));
        assert_eq!(shared.file_name().unwrap().to_str().unwrap(), "x_y.log");
        fs::write(&victim_current, b"mine").unwrap();
        fs::write(&shared, b"shared").unwrap();
        assert!(delete_thread_history(&dir.0, "x/y").is_empty());
        assert!(
            !shared.exists(),
            "the legacy name is matched exactly, whoever wrote it"
        );
        assert!(
            victim_current.exists(),
            "terminal_eDp5.log is not under terminal_eC95_, so the sweep leaves it"
        );
    }

    #[test]
    fn an_unreadable_directory_sweeps_nothing_and_warns_nothing() {
        let dir = TempDir::new();
        let mut disk = TrackedDisk {
            failure: Some(("read_dir".to_owned(), dir.0.clone())),
            ..Default::default()
        };
        assert!(delete_thread_history_with(&mut disk, &dir.0, "thread").is_empty());
        assert_eq!(disk.calls.len(), 1);
        assert!(disk.calls[0].starts_with("read_dir:"));
        // A directory that does not exist is the same silent case, with the real disk.
        assert!(delete_thread_history(&dir.0.join("absent"), "thread").is_empty());
    }

    #[test]
    fn one_unremovable_file_never_stops_the_sweep() {
        let dir = TempDir::new();
        let blocked = history_path(&dir.0, "thread", "term-1");
        let secondary = history_path(&dir.0, "thread", "term-2");
        let legacy = legacy_history_path(&dir.0, "thread");
        for path in [&blocked, &secondary, &legacy] {
            fs::write(path, b"content").unwrap();
        }
        let mut disk = TrackedDisk {
            failure: Some(("remove".to_owned(), blocked.clone())),
            ..Default::default()
        };
        let failures = delete_thread_history_with(&mut disk, &dir.0, "thread");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].path, blocked);
        assert_eq!(
            disk.calls
                .iter()
                .filter(|call| call.starts_with("remove:"))
                .count(),
            3,
            "every matched name is attempted"
        );
        assert!(!secondary.exists() && !legacy.exists());
    }

    #[test]
    fn the_real_disk_deletes_without_seeding_anything() {
        let dir = TempDir::new();
        let thread = "thread";
        for terminal in ["term-1", "term-2"] {
            fs::write(history_path(&dir.0, thread, terminal), b"x").unwrap();
        }
        fs::write(legacy_history_path(&dir.0, thread), b"x").unwrap();
        assert!(delete_thread_history(&dir.0, thread).is_empty());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        assert!(delete_history(&dir.0, thread, "term-1").is_empty());
    }

    fn unhex(value: &str) -> Vec<u8> {
        assert!(value.len().is_multiple_of(2));
        assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
        (0..value.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
            .collect()
    }

    fn optional_bytes(value: &str) -> Option<Vec<u8>> {
        (value != "-").then(|| unhex(value))
    }

    fn disk_bytes(path: &Path) -> Option<Vec<u8>> {
        match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => panic!("read fixture: {error}"),
        }
    }

    #[test]
    fn replays_shipped_manager_migration_paths_order_errors_and_disk_state() {
        let Some(trace) = std::env::var_os("LMCS_TERMINAL_HISTORY_MIGRATION_TRACE") else {
            eprintln!(
                "skipped history migration golden: LMCS_TERMINAL_HISTORY_MIGRATION_TRACE unset; no cross-language check ran"
            );
            return;
        };
        let mut names = HashSet::new();
        let mut failures = 0;
        let mut warnings = 0;
        for row in fs::read_to_string(trace).unwrap().lines() {
            let fields: Vec<_> = row.split('\t').collect();
            assert_eq!(fields.len(), 17, "{row}");
            assert_eq!(fields[0], "M");
            let name = fields[1];
            assert!(names.insert(name.to_owned()), "duplicate {name}");
            let thread = String::from_utf8(unhex(fields[2])).unwrap();
            let terminal = String::from_utf8(unhex(fields[3])).unwrap();
            let lines: usize = fields[4].parse().unwrap();
            let bytes: usize = fields[5].parse().unwrap();
            let dir = TempDir::new();
            let current = history_path(&dir.0, &thread, &terminal);
            let legacy = legacy_history_path(&dir.0, &thread);
            assert_eq!(
                current.file_name().unwrap().to_str().unwrap(),
                fields[9],
                "{name}"
            );
            assert_eq!(
                legacy.file_name().unwrap().to_str().unwrap(),
                fields[10],
                "{name}"
            );
            assert_ne!(current, legacy);
            if let Some(seed) = optional_bytes(fields[6]) {
                fs::write(&current, seed).unwrap();
            }
            if let Some(seed) = optional_bytes(fields[7]) {
                fs::write(&legacy, seed).unwrap();
            }
            let mut disk = TrackedDisk {
                failure: match fields[8] {
                    "none" => None,
                    "exists-current" => Some(("exists".to_owned(), current.clone())),
                    "open-current" => Some(("read".to_owned(), current.clone())),
                    "write-current" => Some(("write".to_owned(), current.clone())),
                    "exists-legacy" => Some(("exists".to_owned(), legacy.clone())),
                    "open-legacy" => Some(("read".to_owned(), legacy.clone())),
                    "remove-legacy" => Some(("remove".to_owned(), legacy.clone())),
                    fault => panic!("unknown fault {fault}"),
                },
                ..Default::default()
            };
            match load_with(&mut disk, &dir.0, &thread, &terminal, bytes, lines) {
                Ok(loaded) => {
                    assert_eq!(fields[12], "-", "{name}");
                    assert_eq!(
                        Some(loaded.history.value()),
                        optional_bytes(fields[11]),
                        "{name}"
                    );
                    let count = usize::from(loaded.cleanup_warning.is_some());
                    assert_eq!(count, fields[16].parse::<usize>().unwrap(), "{name}");
                    warnings += count;
                }
                Err(error) => {
                    failures += 1;
                    assert_eq!(fields[11], "-", "{name}");
                    assert_eq!(error.operation.to_string(), fields[12], "{name}");
                    assert_eq!(error.thread_id, thread, "{name}");
                    assert_eq!(error.terminal_id, terminal, "{name}");
                    assert_eq!(
                        error.cause.kind(),
                        io::ErrorKind::PermissionDenied,
                        "{name}"
                    );
                    assert_eq!(fields[16], "0", "{name}");
                }
            }
            assert_eq!(disk_bytes(&current), optional_bytes(fields[13]), "{name}");
            assert_eq!(disk_bytes(&legacy), optional_bytes(fields[14]), "{name}");
            assert_eq!(disk.calls.join(","), fields[15], "{name}");
        }
        let expected: HashSet<_> = [
            "missing-both",
            "secondary-ignores-legacy",
            "current-wins",
            "empty-current-wins",
            "legacy-normal",
            "legacy-empty",
            "legacy-bounded-unicode",
            "legacy-lossy-utf8",
            "current-rewrite-lines",
            "current-rewrite-bytes",
            "current-malformed-no-rewrite",
            "path-padding-1-default",
            "path-padding-2-default",
            "path-padding-3-default",
            "path-padding-1-secondary",
            "path-padding-2-secondary",
            "path-padding-3-secondary",
            "path-punctuation-default",
            "path-punctuation-secondary",
            "path-non-bmp-utf16",
            "path-unicode-default",
            "path-unicode-secondary",
            "path-base64url-default",
            "path-base64url-secondary",
            "fault-exists-current",
            "fault-open-current",
            "fault-write-current-truncate",
            "fault-exists-legacy",
            "fault-open-legacy",
            "fault-write-current-migrate",
            "fault-remove-legacy",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(names, expected);
        assert_eq!(failures, 6);
        assert_eq!(warnings, 1);
        eprintln!(
            "history migration golden: {} cases, {failures} fatal errors, {warnings} cleanup warning; real files with injected boundary failures",
            names.len()
        );
    }

    /// One `terminal-history-delete-trace.ts` case, as the shipped `TerminalManager` ran it.
    #[derive(Default)]
    struct Replay {
        name: String,
        thread: String,
        has_logs_dir: bool,
        pre: Vec<(String, Option<Vec<u8>>)>,
        post: Vec<(String, Option<Vec<u8>>)>,
        removals: Vec<(String, bool)>,
        swept: bool,
        closed: Option<String>,
        fault: Option<(String, String)>,
        sample_failed: bool,
    }

    fn decode(value: &str) -> String {
        String::from_utf8(unhex(value)).unwrap()
    }

    fn listing(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .map(|name| {
                let path = dir.join(&name);
                let content = if path.is_dir() {
                    None
                } else {
                    Some(fs::read(path).unwrap())
                };
                (name, content)
            })
            .collect();
        entries.sort();
        entries
    }

    #[test]
    fn replays_shipped_manager_deletions_targets_order_failures_and_disk_state() {
        let Some(trace) = std::env::var_os("LMCS_TERMINAL_HISTORY_DELETE_TRACE") else {
            eprintln!(
                "skipped history deletion golden: LMCS_TERMINAL_HISTORY_DELETE_TRACE unset; no cross-language check ran"
            );
            return;
        };
        let mut default_terminal = String::new();
        let mut cases: Vec<Replay> = Vec::new();
        let mut pending: HashMap<u64, usize> = HashMap::new();
        for line in fs::read_to_string(trace).unwrap().lines() {
            let field: Vec<_> = line.split('\t').collect();
            match field[0] {
                "H" => default_terminal = decode(field[1]),
                "C" => {
                    pending.clear();
                    cases.push(Replay {
                        name: field[1].to_owned(),
                        thread: decode(field[2]),
                        has_logs_dir: field[3] == "1",
                        ..Default::default()
                    });
                }
                "E" => {
                    let case = cases.last_mut().unwrap();
                    if decode(field[2]) == "closed" {
                        case.closed = Some(decode(field[3]));
                    }
                }
                "M" => {
                    let case = cases.last_mut().unwrap();
                    match field[2] {
                        "rm" => {
                            pending.insert(field[1].parse().unwrap(), case.removals.len());
                            case.removals.push((decode(field[4]), true));
                        }
                        "readdir" => case.swept = true,
                        _ => {}
                    }
                }
                "N" if field[3] == "rm" => {
                    let index = pending[&field[2].parse::<u64>().unwrap()];
                    cases.last_mut().unwrap().removals[index].1 = field[5] == "ok";
                }
                "D" => {
                    let content = (field[4] != "-").then(|| unhex(field[4]));
                    let entry = (decode(field[2]), content);
                    if decode(field[1]) == "pre" {
                        cases.last_mut().unwrap().pre.push(entry);
                    } else {
                        cases.last_mut().unwrap().post.push(entry);
                    }
                }
                "L" => {
                    cases.last_mut().unwrap().fault = Some((field[2].to_owned(), decode(field[3])));
                }
                "R" if field[2] == "1" && decode(field[1]) == "post" => {
                    cases.last_mut().unwrap().sample_failed = true;
                }
                _ => {}
            }
        }
        assert_eq!(
            cases
                .iter()
                .map(|case| &case.name)
                .collect::<HashSet<_>>()
                .len(),
            cases.len(),
            "duplicate case name in the trace"
        );
        assert_eq!(default_terminal, "term-1");

        let mut swept = 0;
        let mut skipped = 0;
        let mut faults = 0;
        for case in &cases {
            let root = TempDir::new();
            let logs = if case.has_logs_dir {
                root.0.clone()
            } else {
                root.0.join("absent")
            };
            let mut seeds: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
            for (name, content) in case.pre.iter().chain(case.post.iter()) {
                seeds.insert(name.clone(), content.clone());
            }
            if case.swept {
                // A sweep proved its files existed; a case that sampled nothing still lists them
                // in the removals it recorded, so the filter has the same directory to judge.
                for (name, _ok) in &case.removals {
                    seeds
                        .entry(name.clone())
                        .or_insert_with(|| Some(b"measured\n".to_vec()));
                }
            }
            if case.has_logs_dir {
                fs::create_dir_all(&logs).unwrap();
                for (name, content) in &seeds {
                    match content {
                        None => fs::create_dir(logs.join(name)).unwrap(),
                        Some(bytes) => fs::write(logs.join(name), bytes).unwrap(),
                    }
                }
            }
            let failure = case.fault.as_ref().map(|(op, target)| {
                faults += 1;
                if op == "readdir" {
                    ("read_dir".to_owned(), logs.clone())
                } else {
                    ("remove".to_owned(), logs.join(target))
                }
            });

            let mut disk = TrackedDisk {
                failure,
                ..Default::default()
            };
            let failures = if case.removals.is_empty() && !case.swept {
                // The shipped `deleteHistory` flag is the caller's decision, so the faithful replay
                // of a case with no removal is no call at all — and a state the port leaves alone.
                assert_eq!(case.pre, case.post, "{}: nothing was deleted", case.name);
                skipped += 1;
                Vec::new()
            } else if case.swept {
                swept += 1;
                delete_thread_history_with(&mut disk, &logs, &case.thread)
            } else {
                let terminal = case.closed.clone().unwrap_or(default_terminal.clone());
                delete_history_with(&mut disk, &logs, &case.thread, &terminal)
            };
            let attempts: Vec<_> = disk
                .calls
                .iter()
                .filter_map(|call| call.strip_prefix("remove:"))
                .map(str::to_owned)
                .collect();
            let expected: Vec<_> = case
                .removals
                .iter()
                .map(|(name, _ok)| name.clone())
                .collect();
            if case.swept {
                // Removal order is `readdir` order on both sides, so only the set is comparable.
                assert_eq!(
                    attempts.iter().collect::<BTreeSet<_>>(),
                    expected.iter().collect::<BTreeSet<_>>(),
                    "{}: sweep attempts",
                    case.name
                );
            } else {
                assert_eq!(attempts, expected, "{}: current before legacy", case.name);
            }
            let failed: BTreeSet<_> = case
                .removals
                .iter()
                .filter(|(_name, ok)| !*ok)
                .map(|(name, _ok)| name.clone())
                .collect();
            assert_eq!(
                failures.len(),
                failed.len(),
                "{}: reported failures",
                case.name
            );
            for failure in &failures {
                assert_eq!(
                    failure.path.parent().unwrap(),
                    logs.as_path(),
                    "{}",
                    case.name
                );
                let name = failure.path.file_name().unwrap().to_str().unwrap();
                assert!(
                    failed.contains(name),
                    "{}: unexpected failure on {name}",
                    case.name
                );
            }
            if !case.has_logs_dir {
                assert!(!logs.exists(), "{}: deletion creates nothing", case.name);
            } else if !case.sample_failed {
                let expected_state: Vec<_> = {
                    let mut state = case.post.clone();
                    state.sort();
                    state
                };
                assert_eq!(listing(&logs), expected_state, "{}: disk state", case.name);
            }
        }
        assert_eq!(cases.len(), 22, "the shipped trace case count changed");
        assert_eq!(swept, 10, "thread sweeps replayed");
        assert_eq!(
            skipped, 3,
            "closes that deleted nothing replayed as no call"
        );
        assert_eq!(faults, 4, "injected disk failures replayed");
        eprintln!(
            "history deletion golden: {} shipped cases replayed — {swept} thread sweeps, {} single deletes, {skipped} no-delete closes, {faults} injected failures, real directories",
            cases.len(),
            cases.len() - swept - skipped,
        );
    }
}
