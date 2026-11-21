//! The shipped terminal cwd validation, replayed against the trace.
//!
//! Gate: `LMCS_TERMINAL_CWD_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-cwd-trace.ts`. `native/pty/src/cwd.rs` pins each rule in its own
//! module tests; this one holds them to a real `stat` on a real path, so the three refusal tags, the
//! three messages, the `stats.type` spellings and the `PlatformError` reasons are measured rather
//! than re-read from the source.
//!
//! A call window is the pair of `B` rows around one Manager call. The `M` rows are the file-system
//! work it did, the closing `B` the tag it answered with, the `R` the message the user got, and the
//! `K`/`T`/`E`/`S`/`F` rows what the answer left behind. The ported rule is asked the same question
//! the shipped one was — the measured `stat` outcome for the named directory — and both the verdict
//! and the silence around it have to match.
//!
//! Paths are the trace's masked form (`<tmp>/nope`) because the message interpolates the directory
//! exactly as it was named, and the mask is what makes the artifact reproducible. Keeping the mask
//! is also what lets an accepted window be checked for the link path rather than a resolved one:
//! nothing in this fatia canonicalizes.
//!
//! The `A` rows are asserted as answered. The `Q` rows are the harness's own notes about the rule,
//! which no replay reproduces.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use lmcs_pty::cwd::{CwdError, FileKind, StatOutcome, StatReason, assert_valid_cwd};
use lmcs_terminal_history::DEFAULT_TERMINAL_ID;

type Row = Vec<String>;

/// The tags `assertValidCwd` is the only source of. Anything else a call refused with belongs to
/// another rule and is not this golden's to replay.
const REFUSALS: [&str; 3] = [
    "err:TerminalCwdNotFoundError",
    "err:TerminalCwdNotDirectoryError",
    "err:TerminalCwdStatError",
];

/// The directory each fixture label names, after the trace masked its temp root.
fn fixture_path(label: &str) -> Option<&'static str> {
    Some(match label {
        "dir" => "<tmp>/dir",
        "file" => "<tmp>/plain.txt",
        "link-dir" => "<tmp>/link-dir",
        "link-broken" => "<tmp>/link-broken",
        "locked-inner" => "<tmp>/locked/inner",
        "absent" => "<tmp>/nope",
        "devnull" => "/dev/null",
        "file-slash" => "<tmp>/plain.txt/",
        "dir-slash" => "<tmp>/dir/",
        _ => return None,
    })
}

/// The trace's `dirTail`: what a row shows for a path once the root is masked away.
fn dir_tail(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

fn unhex(value: &str) -> String {
    assert!(
        value.len().is_multiple_of(2) && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{value}"
    );
    let bytes: Vec<u8> = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).unwrap()
}

/// What the shipped run answered for each fixture: the `stat` row it measured and the tag the call
/// refused with, `ok` where it opened. This is the part of the golden a re-told artifact cannot pass,
/// because the rule maps a reason to a tag and a host produced one reason per fixture. Without it, a
/// capture that swapped one fixture's whole story — the `stat` failure, the tag and the message
/// together — stays internally consistent and so stays invisible.
const MEASURED: [(&str, &str, &str); 9] = [
    ("dir", "ok Directory", "ok"),
    ("dir-slash", "ok Directory", "ok"),
    ("file", "ok File", "err:TerminalCwdNotDirectoryError"),
    (
        "file-slash",
        "err:PlatformError/BadResource/stat",
        "err:TerminalCwdStatError",
    ),
    ("link-dir", "ok Directory", "ok"),
    (
        "link-broken",
        "err:PlatformError/NotFound/stat",
        "err:TerminalCwdNotFoundError",
    ),
    (
        "absent",
        "err:PlatformError/NotFound/stat",
        "err:TerminalCwdNotFoundError",
    ),
    (
        "locked-inner",
        "err:PlatformError/PermissionDenied/stat",
        "err:TerminalCwdStatError",
    ),
    (
        "devnull",
        "ok CharacterDevice",
        "err:TerminalCwdNotDirectoryError",
    ),
];

/// The `stat` spelling and the refusal tag the golden recorded for a fixture.
fn measured_for(label: &str) -> (&'static str, &'static str) {
    MEASURED
        .iter()
        .find(|(fixture, _, _)| *fixture == label)
        .map(|(_, stat, tag)| (*stat, *tag))
        .unwrap_or_else(|| {
            panic!("trace named a fixture the golden recorded no measurement for: {label}")
        })
}

/// One measured `stat`, in the two spellings the trace wrote for it.
#[derive(Debug)]
struct Measured {
    label: String,
    status: String,
    detail: String,
}

impl Measured {
    /// The trace's own spelling of the answer: the type it read, or the failure it hit.
    fn spelling(&self) -> String {
        if self.status == "ok" {
            format!("ok {}", self.detail)
        } else {
            self.status.clone()
        }
    }
    /// The port's own outcome, read back through the spellings the host produced. Both readers round
    /// trip, so a measured type or reason the port cannot name — or renames — fails here instead of
    /// quietly landing on `Unknown`.
    fn outcome(&self) -> StatOutcome {
        if self.status == "ok" {
            let kind = FileKind::from_type_name(&self.detail).unwrap_or_else(|| {
                panic!("trace measured a stats.type the port cannot name: {self:?}")
            });
            assert_eq!(
                kind.type_name(),
                self.detail,
                "the port renames a stats.type it read"
            );
            return StatOutcome::Kind(kind);
        }
        let measured = self
            .status
            .strip_prefix("err:PlatformError/")
            .and_then(|rest| rest.strip_suffix("/stat"))
            .unwrap_or_else(|| {
                panic!("trace measured a stat failure the port cannot read: {self:?}")
            });
        let reason = StatReason::from_tag(measured).unwrap_or_else(|| {
            panic!("trace measured a reason the port has no arm for: {measured}")
        });
        assert_eq!(
            reason.tag(),
            measured,
            "the port renames a PlatformError reason it read"
        );
        StatOutcome::Failed(reason)
    }
}

/// One Manager call, as the trace recorded it.
#[derive(Default)]
struct Window {
    kind: String,
    id: String,
    /// The closing `B` row: `ok`, or the tag the call refused with.
    status: String,
    /// The `R` row, present exactly when the call refused.
    message: Option<String>,
    stats: Vec<Measured>,
    /// File-system work other than the `stat`, which the rule must never cause.
    other_calls: Vec<String>,
    events: Vec<String>,
    spawns: Vec<String>,
    kills: Vec<u64>,
    snapshots: Vec<String>,
    disk: Option<(bool, String)>,
}

impl Window {
    /// The ported rule's answer to the call, in the two row spellings the trace wrote for it.
    fn replay(&self) -> (String, String, Option<CwdError>) {
        let Some(stat) = self.stats.first() else {
            return ("ok".to_owned(), "-".to_owned(), None);
        };
        let cwd = fixture_path(&stat.label).unwrap_or_else(|| {
            panic!(
                "trace named a fixture the golden has no path for: {}",
                stat.label
            )
        });
        match assert_valid_cwd(cwd, stat.outcome()) {
            Ok(()) => ("ok".to_owned(), "-".to_owned(), None),
            Err(error) => (format!("err:{}", error.tag()), error.message(), Some(error)),
        }
    }
}

struct Case {
    name: String,
    fixtures: Vec<String>,
    seed: String,
    windows: Vec<Window>,
    timeline: Vec<Row>,
    claims: Vec<Row>,
}

struct Parsed {
    default_terminal: String,
    cases: Vec<Case>,
    /// The `Z` row's own counts, checked against what the rows showed.
    traced_cases: usize,
    traced_snapshots: usize,
    snapshots_seen: usize,
}

fn close_window(window: &mut Option<Window>, case: &mut Case) {
    if let Some(done) = window.take() {
        case.windows.push(done);
    }
}

impl Parsed {
    /// The `Z` row counts what the harness wrote; the golden counts what it read, so a case filter
    /// that dropped part of the capture cannot pass on the summary row alone.
    fn totals(&mut self, written_cases: &str, written_snapshots: &str) {
        self.traced_cases = written_cases.parse().expect("case count");
        self.traced_snapshots = written_snapshots.parse().expect("snapshot count");
    }
}

fn parse(trace: &Path) -> Parsed {
    let mut parsed = Parsed {
        default_terminal: String::new(),
        cases: Vec::new(),
        traced_cases: 0,
        traced_snapshots: 0,
        snapshots_seen: 0,
    };
    let mut building: Option<Case> = None;
    let mut window: Option<Window> = None;
    let mut seq = 0u64;

    for line in fs::read_to_string(trace).unwrap().lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[0] {
            "H" => parsed.default_terminal = unhex(fields[1]),
            "Q" => {}
            "C" => {
                assert!(
                    building.is_none() && window.is_none(),
                    "a case started while the previous one was still open"
                );
                building = Some(Case {
                    name: fields[1].to_owned(),
                    fixtures: unhex(fields[3]).split(',').map(str::to_owned).collect(),
                    seed: unhex(fields[4]),
                    windows: Vec::new(),
                    timeline: Vec::new(),
                    claims: Vec::new(),
                });
            }
            "X" => {
                let case = building
                    .as_mut()
                    .expect("the trace closed a case it never opened");
                close_window(&mut window, case);
                assert_eq!(case.name, fields[1], "case rows disagree on the name");
                let done = building.take().expect("case taken above");
                parsed.cases.push(done);
            }
            "A" => {
                let case = building.as_mut().expect("claim outside a case");
                close_window(&mut window, case);
                case.claims.push(vec![
                    "A".to_owned(),
                    unhex(fields[1]),
                    fields[2].to_owned(),
                    unhex(fields[3]),
                ]);
            }
            "Z" => {
                assert!(
                    building.is_none() && window.is_none(),
                    "the trace ended inside a case"
                );
                assert_eq!(fields[3], "end", "the summary row is not last");
                parsed.totals(fields[1], fields[2]);
            }
            "B" | "M" | "R" | "E" | "S" | "F" | "T" | "K" => {
                seq += 1;
                assert_eq!(
                    fields[1],
                    &seq.to_string(),
                    "trace rows are not one sequence: {line}"
                );
                let case = building.as_mut().expect("timed row outside a case");
                case.timeline
                    .push(fields.iter().map(|field| (*field).to_owned()).collect());
                match fields[0] {
                    "B" => {
                        let id = unhex(fields[3]);
                        let status = unhex(fields[4]);
                        if status == "-" {
                            close_window(&mut window, case);
                            window = Some(Window {
                                kind: unhex(fields[2]),
                                id,
                                ..Window::default()
                            });
                        } else {
                            let open = window.as_mut().expect("call closed outside a window");
                            assert_eq!(open.id, id, "a call closed a window it did not open");
                            open.status = status;
                        }
                    }
                    "M" => {
                        let open = window.as_mut().expect("file-system call outside a window");
                        assert_eq!(
                            open.id,
                            unhex(fields[2]),
                            "a file-system call was recorded outside the window that issued it"
                        );
                        let measured = Measured {
                            label: unhex(fields[4]),
                            status: unhex(fields[5]),
                            detail: unhex(fields[6]),
                        };
                        if unhex(fields[3]) == "stat" {
                            open.stats.push(measured);
                        } else {
                            open.other_calls.push(measured.label);
                        }
                    }
                    "R" => {
                        let open = window.as_mut().expect("refusal message outside a window");
                        assert_eq!(
                            open.id,
                            unhex(fields[2]),
                            "a message named no call this window made"
                        );
                        assert!(open.message.is_none(), "one call refused with two messages");
                        open.message = Some(unhex(fields[3]));
                    }
                    "E" => {
                        window
                            .as_mut()
                            .expect("event outside a window")
                            .events
                            .push(unhex(fields[2]));
                    }
                    "S" => {
                        let open = window.as_mut().expect("snapshot outside a window");
                        assert_eq!(
                            open.id,
                            unhex(fields[2]),
                            "a snapshot named no call this window made"
                        );
                        open.snapshots.push(unhex(fields[6]));
                        parsed.snapshots_seen += 1;
                    }
                    "F" => {
                        let open = window.as_mut().expect("disk sample outside a window");
                        if fields[2] == open.id {
                            open.disk = Some((fields[3] == "1", unhex(fields[5])));
                        }
                    }
                    "T" => {
                        window
                            .as_mut()
                            .expect("spawn outside a window")
                            .spawns
                            .push(unhex(fields[5]));
                    }
                    "K" => {
                        window
                            .as_mut()
                            .expect("pty census outside a window")
                            .kills
                            .push(fields[3].parse().expect("kill count"));
                    }
                    _ => unreachable!("row kind matched above"),
                }
            }
            other => panic!("unknown trace row kind: {other}"),
        }
    }
    assert!(
        building.is_none() && window.is_none(),
        "the trace ended without closing its last case"
    );
    assert!(parsed.snapshots_seen > 0, "the trace wrote no snapshot row");
    parsed
}

/// Everything the shipped call proved about the directory, and about the silence around a refusal.
fn verify(case: &Case, window: &Window) {
    if window.status.is_empty() {
        // The trace stamps an output or exit probe with a single `B` row so its events land in order.
        // No Manager call answered it, so the rule had nothing to say.
        assert!(
            matches!(window.kind.as_str(), "emit" | "exit"),
            "{} {} a call window never closed",
            case.name,
            window.id
        );
        assert!(
            window.stats.is_empty() && window.message.is_none(),
            "{} {} a probe call was answered like a real one",
            case.name,
            window.id
        );
        return;
    }
    assert!(
        window.status == "ok" || REFUSALS.contains(&window.status.as_str()),
        "{} {} refused for a reason outside this fatia: {}",
        case.name,
        window.id,
        window.status
    );
    for stat in &window.stats {
        assert!(
            case.fixtures.iter().any(|fixture| fixture == &stat.label),
            "{} {} statted a fixture the case did not create: {}",
            case.name,
            window.id,
            stat.label
        );
        let (recorded_stat, recorded_tag) = measured_for(&stat.label);
        assert_eq!(
            stat.spelling(),
            recorded_stat,
            "{} {} the run answered {} differently than the golden recorded",
            case.name,
            window.id,
            stat.label
        );
        assert_eq!(
            window.status, recorded_tag,
            "{} {} the run refused {} differently than the golden recorded",
            case.name, window.id, stat.label
        );
    }

    let (status, message, error) = window.replay();
    assert_eq!(
        (status.as_str(), message.as_str()),
        (
            window.status.as_str(),
            window.message.as_deref().unwrap_or("-")
        ),
        "{} {} cwd verdict",
        case.name,
        window.id
    );
    assert_eq!(
        window.message.is_some(),
        window.status != "ok",
        "{} {} a refusal message and a refusal tag disagree",
        case.name,
        window.id
    );

    if window.status != "ok" {
        assert_eq!(
            window.stats.len(),
            1,
            "{} {} a refusal did not rest on exactly one stat",
            case.name,
            window.id
        );
        assert!(
            window.other_calls.is_empty(),
            "{} {} a refusal touched the history directory: {:?}",
            case.name,
            window.id,
            window.other_calls
        );
        assert!(
            window.events.is_empty(),
            "{} {} a refusal published {:?}",
            case.name,
            window.id,
            window.events
        );
        assert!(
            window.spawns.is_empty(),
            "{} {} a refusal spawned a shell",
            case.name,
            window.id
        );
        assert!(
            window.kills.iter().all(|kills| *kills == 0),
            "{} {} a refusal killed a process: {:?}",
            case.name,
            window.id,
            window.kills
        );
        let disk = window.disk.as_ref().unwrap_or_else(|| {
            panic!(
                "{} {} a refusal left the history file unsampled",
                case.name, window.id
            )
        });
        assert_eq!(
            disk.clone(),
            (true, case.seed.clone()),
            "{} {} a refusal rewrote the history file",
            case.name,
            window.id
        );
    } else if let Some(stat) = window.stats.first() {
        // The call validated and was accepted, so it went on to start a shell in the directory it was
        // handed. A resolved or normalized path would show the target, not the name the caller used.
        let named = dir_tail(fixture_path(&stat.label).expect("fixture path checked above"));
        assert_eq!(
            window.spawns.as_slice(),
            [named.to_owned()],
            "{} {} opened somewhere other than the directory it was given",
            case.name,
            window.id
        );
        assert_eq!(
            window.snapshots.as_slice(),
            [named.to_owned()],
            "{} {} the record kept a different path than the shell was given",
            case.name,
            window.id
        );
    }

    if window.status == "err:TerminalCwdStatError" {
        let cause = error.and_then(|error| error.cause()).unwrap_or_else(|| {
            panic!(
                "{} {} a stat refusal carried no cause",
                case.name, window.id
            )
        });
        let failed = window
            .stats
            .first()
            .expect("a stat refusal measured no stat")
            .status
            .clone();
        assert_eq!(
            format!("err:{cause}"),
            failed,
            "{} {} the refusal did not carry the stat that failed",
            case.name,
            window.id
        );
    }
}

/// The three refusals and the accepted answer all have to be in the capture, or the replay proves
/// nothing about the rule it is supposed to hold.
fn assert_coverage(cases: &[Case]) {
    let statuses: BTreeSet<&str> = cases
        .iter()
        .flat_map(|case| case.windows.iter())
        .map(|window| window.status.as_str())
        .collect();
    for expected in ["ok"].into_iter().chain(REFUSALS) {
        assert!(
            statuses.contains(&expected),
            "the capture never measured {expected}, so the replay would prove nothing: {statuses:?}"
        );
    }
}

#[test]
fn replays_shipped_terminal_cwd_validation() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_CWD_TRACE") else {
        eprintln!("skipped cwd golden: LMCS_TERMINAL_CWD_TRACE unset; no cross-language check ran");
        return;
    };
    let trace = PathBuf::from(trace);
    let parsed = parse(&trace);
    assert_eq!(parsed.default_terminal, DEFAULT_TERMINAL_ID);
    assert_eq!(
        parsed.snapshots_seen, parsed.traced_snapshots,
        "the trace counted snapshots it did not write"
    );
    assert_coverage(&parsed.cases);

    let mut timed = 0;
    for case in &parsed.cases {
        assert!(
            !case.windows.is_empty(),
            "{} traced no Manager call",
            case.name
        );
        for window in &case.windows {
            assert!(
                !window.kind.is_empty(),
                "{} traced an unlabelled call",
                case.name
            );
            verify(case, window);
        }
        for claim in &case.claims {
            assert_eq!(
                claim[2], "match",
                "{} measured a diff: {} {}",
                claim[1], claim[3], case.name
            );
        }
        timed += case.timeline.len();
    }
    assert_eq!(
        parsed.traced_cases,
        parsed.cases.len(),
        "every traced case replayed"
    );
    eprintln!(
        "cwd golden: {} cases, {} snapshots, {} timed rows from {}",
        parsed.cases.len(),
        parsed.snapshots_seen,
        timed,
        trace.display()
    );
}
