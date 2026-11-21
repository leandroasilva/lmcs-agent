//! The directory a terminal is allowed to start in, and what the user is told when it is not one.
//!
//! Ported from `assertValidCwd` (`apps/server/src/terminal/Manager.ts:1909`) and the three
//! `TerminalCwd*Error` classes (`packages/core/src/contracts/terminal.ts:239-271`). The rule is one
//! `FileSystem.stat` and three outcomes, and it runs from `openLocked` (:2515) and `restartResolved`
//! (:2937) **before** the session table is read, so a refusal is silent on every other channel: no
//! kill, no event, no history rewrite.
//!
//! Measured rather than inferred — see `apps/server/scripts/terminal-cwd-trace.ts`. The trace shows
//! one `stat` and nothing else per refused call, `/dev/null` refusing as a character device, a
//! symlink to a directory opening with the **link path** it was handed, and a file named with a
//! trailing separator refusing as a *stat error* rather than as "not a directory", because that path
//! fails inside `stat` with ENOTDIR instead of answering with a type.
//!
//! The empty and whitespace-only cwd is out of scope here on purpose: the contract trims it away and
//! rejects it (`TrimmedNonEmptyStringSchema` on `TerminalOpenInput`/`TerminalRestartInput`), so the
//! Manager never sees one.

use std::fmt;

/// The `stats.type` a call answers with, in the order the shipped classifier tests it
/// (`NodeFileSystem.makeFileInfo`: file, directory, symbolic link, block device, character device,
/// FIFO, socket).
///
/// A symbolic link is reachable only through `lstat`; `assertValidCwd` uses `stat`, which follows the
/// link, so the `Ok(SymbolicLink)` arm is unreachable from the terminal rule and exists to keep the
/// type faithful to the source it mirrors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    File,
    Directory,
    SymbolicLink,
    BlockDevice,
    CharacterDevice,
    Fifo,
    Socket,
    Unknown,
}

impl FileKind {
    /// The spelling `stats.type` carries, which is what the trace records and the gate compares.
    #[must_use]
    pub const fn type_name(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Directory => "Directory",
            Self::SymbolicLink => "SymbolicLink",
            Self::BlockDevice => "BlockDevice",
            Self::CharacterDevice => "CharacterDevice",
            Self::Fifo => "FIFO",
            Self::Socket => "Socket",
            Self::Unknown => "Unknown",
        }
    }

    /// Reads back a measured `stats.type`.
    #[must_use]
    pub fn from_type_name(value: &str) -> Option<Self> {
        match value {
            "File" => Some(Self::File),
            "Directory" => Some(Self::Directory),
            "SymbolicLink" => Some(Self::SymbolicLink),
            "BlockDevice" => Some(Self::BlockDevice),
            "CharacterDevice" => Some(Self::CharacterDevice),
            "FIFO" => Some(Self::Fifo),
            "Socket" => Some(Self::Socket),
            "Unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

/// The `PlatformError` reason tag an `errno` maps to. Copied from `handleErrnoException` in
/// `@effect/platform-node-shared`, which is the only thing standing between a syscall failure and the
/// three outcomes of the rule: `ENOENT` alone means "does not exist", and every other mapped code
/// means "could not be accessed".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatReason {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    BadResource,
    Busy,
    Unknown,
}

impl StatReason {
    /// The reason's own `_tag`, which is what the shipped code branches on.
    #[must_use]
    pub const fn tag(self) -> &'static str {
        match self {
            Self::NotFound => "NotFound",
            Self::PermissionDenied => "PermissionDenied",
            Self::AlreadyExists => "AlreadyExists",
            Self::BadResource => "BadResource",
            Self::Busy => "Busy",
            Self::Unknown => "Unknown",
        }
    }

    /// Reads back a measured reason tag.
    #[must_use]
    pub fn from_tag(value: &str) -> Option<Self> {
        match value {
            "NotFound" => Some(Self::NotFound),
            "PermissionDenied" => Some(Self::PermissionDenied),
            "AlreadyExists" => Some(Self::AlreadyExists),
            "BadResource" => Some(Self::BadResource),
            "Busy" => Some(Self::Busy),
            "Unknown" => Some(Self::Unknown),
            _ => None,
        }
    }

    /// `handleErrnoException`'s switch. The codes are the POSIX numbers, identical on the two desktop
    /// hosts except for `ELOOP`.
    ///
    /// Raw codes rather than `io::ErrorKind` are deliberate: `ErrorKind::NotADirectory` is unstable,
    /// and a kind-based mapping is what made the deletion port print `PermissionDenied` for an
    /// `EPERM` that the shipped sweep renders as `Unknown` (see `lifecycle`). `EPERM` is not in this
    /// table, so it lands on `Unknown` here the way it does in Node.
    #[must_use]
    pub const fn from_errno(code: i32) -> Self {
        // ENOENT, EACCES, EEXIST, EBUSY, ENOTDIR, EISDIR agree on macOS and Linux; ELOOP does not.
        #[cfg(target_os = "macos")]
        let eloop = 62;
        #[cfg(not(target_os = "macos"))]
        let eloop = 40;

        match code {
            2 => Self::NotFound,
            13 => Self::PermissionDenied,
            17 => Self::AlreadyExists,
            20 | 21 => Self::BadResource,
            // ENOTDIR, EISDIR, ELOOP.
            other if other == eloop => Self::BadResource,
            16 => Self::Busy,
            _ => Self::Unknown,
        }
    }
}

/// What one `stat` answered: a type, or the reason the syscall failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatOutcome {
    Kind(FileKind),
    Failed(StatReason),
}

/// One of the three refusals, carrying the same fields the contracts declare: `cwd` everywhere, plus
/// the swallowed `PlatformError` for the stat case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CwdError {
    NotFound { cwd: String },
    NotDirectory { cwd: String },
    Stat { cwd: String, reason: StatReason },
}

impl CwdError {
    /// The error's `_tag`, which is the half the client protocol keys on.
    #[must_use]
    pub const fn tag(&self) -> &'static str {
        match self {
            Self::NotFound { .. } => "TerminalCwdNotFoundError",
            Self::NotDirectory { .. } => "TerminalCwdNotDirectoryError",
            Self::Stat { .. } => "TerminalCwdStatError",
        }
    }

    /// The `message` getter the shipped classes override. The directory is interpolated raw, so an
    /// absolute temp path reaches the user; the trace records exactly these three sentences.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::NotFound { cwd } => format!("Terminal cwd does not exist: {cwd}"),
            Self::NotDirectory { cwd } => format!("Terminal cwd is not a directory: {cwd}"),
            Self::Stat { cwd, .. } => format!("Failed to access terminal cwd: {cwd}"),
        }
    }

    /// The cause the `TerminalCwdStatError` carries, rendered the way a logged `PlatformError` prints:
    /// reason tag, then the operation. Only the stat variant has one — the other two swallow the cause
    /// and keep the directory.
    #[must_use]
    pub fn cause(&self) -> Option<String> {
        self.stat_reason()
            .map(|reason| format!("PlatformError/{}/stat", reason.tag()))
    }

    /// The reason the `stat` failed, for a caller that needs the tag without the rendered string.
    #[must_use]
    pub const fn stat_reason(&self) -> Option<StatReason> {
        match self {
            Self::Stat { reason, .. } => Some(*reason),
            Self::NotFound { .. } | Self::NotDirectory { .. } => None,
        }
    }
}

impl fmt::Display for CwdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for CwdError {}

/// `assertValidCwd` once the `stat` has answered. `NotFound` is the only failure that becomes its own
/// error; anything else that went wrong accessing the path becomes the stat error, and a path that
/// answered with any type but `Directory` becomes the not-a-directory error.
pub fn assert_valid_cwd(cwd: &str, outcome: StatOutcome) -> Result<(), CwdError> {
    match outcome {
        StatOutcome::Kind(FileKind::Directory) => Ok(()),
        StatOutcome::Kind(_) => Err(CwdError::NotDirectory {
            cwd: cwd.to_owned(),
        }),
        StatOutcome::Failed(StatReason::NotFound) => Err(CwdError::NotFound {
            cwd: cwd.to_owned(),
        }),
        StatOutcome::Failed(reason) => Err(CwdError::Stat {
            cwd: cwd.to_owned(),
            reason,
        }),
    }
}

/// The `fileSystem.stat(cwd)` itself. `std::fs::metadata` follows a symlink exactly as `fs.stat` does,
/// which is what lets a link to a directory open.
#[must_use]
pub fn stat_cwd(cwd: &str) -> StatOutcome {
    match std::fs::metadata(cwd) {
        Ok(metadata) => StatOutcome::Kind(classify(&metadata)),
        Err(error) => StatOutcome::Failed(reason_from_io(&error)),
    }
}

/// The whole rule, boundary included: one `stat`, one verdict.
pub fn assert_valid_cwd_path(cwd: &str) -> Result<(), CwdError> {
    assert_valid_cwd(cwd, stat_cwd(cwd))
}

/// The shipped ternary chain, in order.
///
/// The four special-file tests are Unix-only in `std`, and Node's `stat` answers them on Windows too.
/// A Windows terminal is already an open gap (`lifecycle`, the reader), so this returns `Unknown`
/// there rather than inventing a mapping nobody has measured.
#[must_use]
pub fn classify(metadata: &std::fs::Metadata) -> FileKind {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        return FileKind::File;
    }
    if file_type.is_dir() {
        return FileKind::Directory;
    }
    if file_type.is_symlink() {
        return FileKind::SymbolicLink;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if file_type.is_block_device() {
            return FileKind::BlockDevice;
        }
        if file_type.is_char_device() {
            return FileKind::CharacterDevice;
        }
        if file_type.is_fifo() {
            return FileKind::Fifo;
        }
        if file_type.is_socket() {
            return FileKind::Socket;
        }
    }
    FileKind::Unknown
}

/// The reason tag for a failed `stat`, preferring the raw code because that is the table Node applies.
#[must_use]
fn reason_from_io(error: &std::io::Error) -> StatReason {
    if let Some(code) = error.raw_os_error() {
        return StatReason::from_errno(code);
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => StatReason::NotFound,
        std::io::ErrorKind::PermissionDenied => StatReason::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => StatReason::AlreadyExists,
        _ => StatReason::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(cwd: &str, outcome: StatOutcome) -> (String, String, Option<String>) {
        let error = assert_valid_cwd(cwd, outcome).expect_err("the case must refuse");
        (error.tag().to_string(), error.message(), error.cause())
    }

    #[test]
    fn only_a_directory_is_accepted() {
        assert!(assert_valid_cwd("/srv", StatOutcome::Kind(FileKind::Directory)).is_ok());
        for kind in [
            FileKind::File,
            FileKind::SymbolicLink,
            FileKind::BlockDevice,
            FileKind::CharacterDevice,
            FileKind::Fifo,
            FileKind::Socket,
            FileKind::Unknown,
        ] {
            let (tag, _, _) = refused("/srv", StatOutcome::Kind(kind));
            assert_eq!(tag, "TerminalCwdNotDirectoryError", "{tag} for {kind:?}");
        }
    }

    #[test]
    fn the_three_messages_are_the_contracts_own() {
        assert_eq!(
            refused("/tmp/gone", StatOutcome::Failed(StatReason::NotFound),),
            (
                "TerminalCwdNotFoundError".to_string(),
                "Terminal cwd does not exist: /tmp/gone".to_string(),
                None,
            ),
        );
        assert_eq!(
            refused("/tmp/plain.txt", StatOutcome::Kind(FileKind::File)),
            (
                "TerminalCwdNotDirectoryError".to_string(),
                "Terminal cwd is not a directory: /tmp/plain.txt".to_string(),
                None,
            ),
        );
        assert_eq!(
            refused(
                "/tmp/locked/inner",
                StatOutcome::Failed(StatReason::PermissionDenied),
            ),
            (
                "TerminalCwdStatError".to_string(),
                "Failed to access terminal cwd: /tmp/locked/inner".to_string(),
                Some("PlatformError/PermissionDenied/stat".to_string()),
            ),
        );
    }

    #[test]
    fn a_file_named_with_a_trailing_separator_is_a_stat_error_not_a_type() {
        // Measured: `stat("<tmp>/plain.txt/")` fails with ENOTDIR, so the refusal is the stat error.
        // Calling this NotDirectory instead would be the obvious wrong port.
        let (tag, message, cause) = refused(
            "/tmp/plain.txt/",
            StatOutcome::Failed(StatReason::from_errno(20)),
        );
        assert_eq!(tag, "TerminalCwdStatError");
        assert_eq!(message, "Failed to access terminal cwd: /tmp/plain.txt/");
        assert_eq!(cause, Some("PlatformError/BadResource/stat".to_string()));
    }

    #[test]
    fn the_errno_table_is_the_shipped_one() {
        assert_eq!(StatReason::from_errno(2), StatReason::NotFound);
        assert_eq!(StatReason::from_errno(13), StatReason::PermissionDenied);
        assert_eq!(StatReason::from_errno(17), StatReason::AlreadyExists);
        assert_eq!(StatReason::from_errno(20), StatReason::BadResource);
        assert_eq!(StatReason::from_errno(21), StatReason::BadResource);
        assert_eq!(StatReason::from_errno(16), StatReason::Busy);
        let eloop = if cfg!(target_os = "macos") { 62 } else { 40 };
        assert_eq!(StatReason::from_errno(eloop), StatReason::BadResource);
        // EPERM is in no branch of the shipped switch, and stays `Unknown` here too.
        assert_eq!(StatReason::from_errno(1), StatReason::Unknown);
        assert_eq!(StatReason::from_errno(0), StatReason::Unknown);
    }

    #[test]
    fn reason_tags_and_types_round_trip_the_measured_spellings() {
        for reason in [
            StatReason::NotFound,
            StatReason::PermissionDenied,
            StatReason::AlreadyExists,
            StatReason::BadResource,
            StatReason::Busy,
            StatReason::Unknown,
        ] {
            assert_eq!(StatReason::from_tag(reason.tag()), Some(reason));
        }
        // The four spellings the trace actually recorded.
        for name in ["Directory", "File", "CharacterDevice", "Unknown"] {
            assert_eq!(FileKind::from_type_name(name).unwrap().type_name(), name);
        }
        assert_eq!(FileKind::Fifo.type_name(), "FIFO");
        assert_eq!(FileKind::from_type_name("folder"), None);
        // A label the port never measured must fail the read-back rather than land on a real variant,
        // which is what lets the golden tell a renamed spelling from a read one.
        assert_eq!(StatReason::from_tag("busy"), None);
        assert_eq!(StatReason::from_tag("PermissionDenied "), None);
    }

    #[test]
    fn a_busy_or_looping_path_refuses_as_a_stat_error() {
        // No traced fixture produces ELOOP or EBUSY, so these two rows of the shipped switch have
        // their owner here rather than in the golden.
        let eloop = if cfg!(target_os = "macos") { 62 } else { 40 };
        for (code, reason) in [(16, "Busy"), (eloop, "BadResource")] {
            let (tag, _, cause) =
                refused("/srv", StatOutcome::Failed(StatReason::from_errno(code)));
            assert_eq!(tag, "TerminalCwdStatError", "errno {code} is not ENOENT");
            assert_eq!(cause, Some(format!("PlatformError/{reason}/stat")));
        }
    }

    #[test]
    fn the_verdict_reads_the_answered_stat_and_touches_nothing_else() {
        // The shipped rule runs before the session table is read, so the verdict has to come from the
        // outcome it was handed and never from a second look at the path.
        let dir = std::env::temp_dir();
        assert_eq!(
            refused(&dir.to_string_lossy(), StatOutcome::Kind(FileKind::File)).0,
            "TerminalCwdNotDirectoryError",
            "a directory on disk cannot overrule the stat it was answered with"
        );
        assert!(
            assert_valid_cwd("/dev/null", StatOutcome::Kind(FileKind::Directory)).is_ok(),
            "and a character device on disk cannot overrule an answer that says directory"
        );
        assert!(
            !std::fs::metadata("/dev/null").unwrap().is_dir(),
            "the two readings disagree, which is the premise this test rests on"
        );
    }

    #[test]
    fn a_real_directory_a_real_file_and_nothing_at_all_behave_as_measured() {
        let root = std::env::temp_dir().join(format!(
            "lmcs-cwd-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join("dir");
        let file = root.join("plain.txt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, "plain\n").unwrap();

        let result = assert_valid_cwd_path(&dir.to_string_lossy());
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            stat_cwd(&dir.to_string_lossy()),
            StatOutcome::Kind(FileKind::Directory),
        );

        assert_eq!(
            stat_cwd(&file.to_string_lossy()),
            StatOutcome::Kind(FileKind::File),
        );
        assert_eq!(
            assert_valid_cwd_path(&file.to_string_lossy())
                .expect_err("a file must refuse")
                .tag(),
            "TerminalCwdNotDirectoryError",
        );

        // The measured ENOTDIR, on the host that produced the trace.
        let slashed = format!("{}/", file.to_string_lossy());
        assert_eq!(
            stat_cwd(&slashed),
            StatOutcome::Failed(StatReason::BadResource),
            "Node reports ENOTDIR as BadResource for a file with a trailing separator",
        );
        assert_eq!(
            assert_valid_cwd_path(&slashed)
                .expect_err("the trailing separator must refuse")
                .tag(),
            "TerminalCwdStatError",
        );

        let missing = root.join("nope");
        assert_eq!(
            assert_valid_cwd_path(&missing.to_string_lossy())
                .expect_err("an absent path must refuse")
                .tag(),
            "TerminalCwdNotFoundError",
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_opens_and_a_dangling_one_is_not_found() {
        let root = std::env::temp_dir().join(format!(
            "lmcs-cwd-links-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join("dir");
        std::fs::create_dir_all(&dir).unwrap();
        let to_dir = root.join("link-dir");
        let to_gone = root.join("link-broken");
        std::os::unix::fs::symlink("dir", &to_dir).unwrap();
        std::os::unix::fs::symlink("gone", &to_gone).unwrap();

        // `stat` follows the link, so the gate sees `Directory` while the caller's path stays the link.
        assert_eq!(
            stat_cwd(&to_dir.to_string_lossy()),
            StatOutcome::Kind(FileKind::Directory),
        );
        assert_eq!(
            stat_cwd(&to_gone.to_string_lossy()),
            StatOutcome::Failed(StatReason::NotFound),
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_character_device_answers_with_a_type_and_refuses_as_not_a_directory() {
        // Measured on macOS and Linux: /dev/null stats fine as `CharacterDevice`, so the refusal is
        // about the type and never a stat error.
        let outcome = stat_cwd("/dev/null");
        assert_eq!(outcome, StatOutcome::Kind(FileKind::CharacterDevice));
        assert_eq!(
            assert_valid_cwd("/dev/null", outcome)
                .expect_err("a character device must refuse")
                .tag(),
            "TerminalCwdNotDirectoryError",
        );
    }
}
