//! The shipped manager's close sequence, replayed against the deletion trace.
//!
//! Gate: `LMCS_TERMINAL_HISTORY_DELETE_TRACE`, pointing at the output of
//! `apps/server/scripts/terminal-history-delete-trace.ts`. The store-level golden in
//! `native/terminal-history/src/store.rs` replays which paths a removal touches; this one replays
//! the call sites that own those removals: what is published, when, and what a failed removal turns
//! into.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use lmcs_pty::PendingEvent;
use lmcs_pty::lifecycle::{
    Event, TERMINAL_DELETE_WARNING, THREAD_DELETE_WARNING, Terminals, Warning,
};
use lmcs_pty::output::TerminalOutput;
use lmcs_pty::persisted::PersistedOutput;
use lmcs_terminal_history::{
    BoundedHistory, DEFAULT_TERMINAL_ID, HistoryPersistence, UNLIMITED_BYTES, history_path,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
}

struct Sample {
    name: String,
    kind: Kind,
    content: Option<Vec<u8>>,
}

/// One terminal the shipped run had open. The `started` event takes sequence 1 and each published
/// `output` event takes one more, which is what the close's sequence is measured against.
#[derive(Default)]
struct Session {
    terminal: String,
    pid: u32,
    /// History the shipped run restored at open, before any output arrived.
    initial: Vec<u8>,
    /// `output` events published for this terminal before the close.
    outputs: usize,
}

#[derive(Default)]
struct Case {
    name: String,
    thread: String,
    has_logs_dir: bool,
    /// The terminals the shipped run opened, in the order it opened them.
    opened: Vec<Session>,
    /// The `closed` events the shipped manager published, in order, with their sequences.
    published: Vec<(String, u64)>,
    /// `logWarning` rows as (message, field names).
    warnings: Vec<(String, String)>,
    pre: Vec<Sample>,
    post: Vec<Sample>,
    readdir: Option<Vec<String>>,
    writes: Vec<(String, Vec<u8>)>,
    /// A `readdir` means the close carried no terminal id and swept the thread.
    swept: bool,
    /// An `rm` means the flag told the shipped close to remove history.
    deletes: bool,
    /// `L` rows mark removals the script failed by injection, which no real filesystem reproduces
    /// per path; those cases replay publication order only.
    injected: bool,
    /// `R post 1` means the shipped run could not sample the directory after the call.
    post_sampled: bool,
    terminal_of_open: HashMap<String, String>,
}

fn unhex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2), "{value}");
    assert!(
        value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{value}"
    );
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn decode(value: &str) -> String {
    String::from_utf8(unhex(value)).unwrap()
}

fn bytes(value: &str) -> Option<Vec<u8>> {
    (value != "-").then(|| unhex(value))
}

fn parse(trace: &Path) -> Vec<Case> {
    let mut cases: Vec<Case> = Vec::new();
    let mut open_call = String::new();
    for line in fs::read_to_string(trace).unwrap().lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let case = cases.last_mut();
        match fields[0] {
            "C" => cases.push(Case {
                name: fields[1].to_owned(),
                thread: decode(fields[2]),
                has_logs_dir: fields[3] == "1",
                ..Case::default()
            }),
            "O" if decode(fields[2]) == "issue" && decode(fields[3]).starts_with("open-") => {
                open_call = decode(fields[3]);
            }
            "E" => {
                let case = case.unwrap();
                let (kind, terminal) = (decode(fields[2]), decode(fields[3]));
                match kind.as_str() {
                    "closed" => case
                        .published
                        .push((terminal, fields[4].parse().expect("event sequence"))),
                    "started" => {
                        case.terminal_of_open
                            .insert(open_call.clone(), terminal.clone());
                        case.opened.push(Session {
                            terminal,
                            ..Session::default()
                        });
                    }
                    "output" => {
                        case.opened
                            .iter_mut()
                            .rev()
                            .find(|session| session.terminal == terminal)
                            .expect("output for an opened terminal")
                            .outputs += 1
                    }
                    _ => {}
                }
            }
            "S" => {
                let case = case.unwrap();
                let terminal = case.terminal_of_open[fields[1]].clone();
                let slot = case
                    .opened
                    .iter_mut()
                    .rev()
                    .find(|session| session.terminal == terminal)
                    .unwrap();
                slot.pid = fields[4].parse().expect("pid");
                slot.initial = bytes(fields[3]).unwrap_or_default();
            }
            "M" => {
                let case = case.unwrap();
                match fields[2] {
                    "write" => case
                        .writes
                        .push((decode(fields[4]), bytes(fields[6]).unwrap_or_default())),
                    "rm" => case.deletes = true,
                    "readdir" => {
                        case.swept = true;
                        case.deletes = true;
                        case.readdir = bytes(fields[6]).map(|payload| {
                            String::from_utf8(payload)
                                .unwrap()
                                .split('\u{1}')
                                .filter(|name| !name.is_empty())
                                .map(str::to_owned)
                                .collect()
                        });
                    }
                    _ => {}
                }
            }
            "G" => {
                let case = case.unwrap();
                assert_eq!(decode(fields[2]), "Warn", "{}", case.name);
                case.warnings.push((decode(fields[3]), decode(fields[4])));
            }
            "D" => {
                let case = case.unwrap();
                let sample = Sample {
                    name: decode(fields[2]),
                    kind: match fields[3] {
                        "d" => Kind::Directory,
                        _ => Kind::File,
                    },
                    content: bytes(fields[4]),
                };
                if decode(fields[1]) == "pre" {
                    case.pre.push(sample);
                } else {
                    case.post.push(sample);
                }
            }
            "R" if decode(fields[1]) == "post" => case.unwrap().post_sampled = fields[2] == "0",
            "L" => case.unwrap().injected = true,
            "R" | "O" | "H" | "Q" | "N" | "A" | "X" | "Z" => {}
            code => panic!("unknown trace row {code}"),
        }
    }
    cases
}

/// What the shipped run had in history when it closed: the last write of that terminal's file.
fn persisted(case: &Case, dir: &Path, terminal: &str) -> Vec<u8> {
    let name = history_path(dir, &case.thread, terminal)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    case.writes
        .iter()
        .rev()
        .find(|(target, _)| *target == name)
        .map(|(_, payload)| payload.clone())
        .unwrap_or_default()
}

fn listing(dir: &Path) -> Vec<Sample> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut samples: Vec<_> = entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            let kind = if entry.file_type().unwrap().is_dir() {
                Kind::Directory
            } else {
                Kind::File
            };
            Sample {
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                kind,
                content: (kind == Kind::File).then(|| fs::read(&path).unwrap()),
            }
        })
        .collect();
    samples.sort_by(|left, right| left.name.cmp(&right.name));
    samples
}

fn rendered(samples: &[Sample]) -> Vec<(&str, &'static str, Option<&[u8]>)> {
    samples
        .iter()
        .map(|sample| {
            (
                sample.name.as_str(),
                match sample.kind {
                    Kind::File => "f",
                    Kind::Directory => "d",
                },
                sample.content.as_deref(),
            )
        })
        .collect()
}

/// Publications, each with the history files that were still on disk at that moment. Reading the
/// disk inside the callback is what makes a removal that jumped the publication observable.
type Observed = Vec<(String, u64, Vec<Option<Vec<u8>>>)>;

#[derive(Clone, Default)]
struct Publications(Arc<Mutex<Observed>>);

impl Publications {
    fn watch(&self, targets: Vec<PathBuf>) -> impl FnMut(&Event) + use<> {
        let this = self.clone();
        move |event: &Event| {
            let present = targets.iter().map(|target| fs::read(target).ok()).collect();
            this.0.lock().unwrap().push((
                event.terminal_id().to_owned(),
                event.sequence(),
                present,
            ));
        }
    }

    fn taken(&self) -> Observed {
        self.0.lock().unwrap().clone()
    }
}

#[test]
fn replays_shipped_manager_close_publications_warnings_and_disk() {
    let Some(trace) = std::env::var_os("LMCS_TERMINAL_HISTORY_DELETE_TRACE") else {
        eprintln!(
            "skipped manager close golden: LMCS_TERMINAL_HISTORY_DELETE_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let cases = parse(Path::new(&trace));
    assert_eq!(cases.len(), 22, "{}", trace.display());
    let (mut publications, mut sweeps, mut injected, mut compared, mut replayed, mut produced) =
        (0, 0, 0, 0, 0, 0);
    for case in &cases {
        let root = std::env::temp_dir().join(format!(
            "lmcs-manager-close-{}-{}-{}",
            std::process::id(),
            case.name,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = if case.has_logs_dir {
            fs::create_dir_all(&root).unwrap();
            root.clone()
        } else {
            root.join("absent")
        };
        // Survivors are known only from the post sample, so the two together are the state the
        // shipped close started from. Names the sweep saw but neither sample recorded are seeded
        // with placeholder content: their content is not what the case measures.
        let mut seeds: HashMap<String, Option<Vec<u8>>> = HashMap::new();
        for name in case.readdir.as_deref().unwrap_or_default() {
            seeds.insert(name.clone(), Some(b"measured\n".to_vec()));
        }
        for sample in case.pre.iter().chain(case.post.iter()) {
            seeds.insert(
                sample.name.clone(),
                match sample.kind {
                    Kind::Directory => None,
                    Kind::File => Some(sample.content.clone().unwrap()),
                },
            );
        }
        if case.has_logs_dir {
            for (name, content) in &seeds {
                let path = dir.join(name);
                match content {
                    None => fs::create_dir(&path).unwrap(),
                    Some(content) => fs::write(&path, content).unwrap(),
                }
            }
        }
        // The files the port must not remove before publishing.
        let targets: Vec<PathBuf> = case
            .opened
            .iter()
            .map(|session| history_path(&dir, &case.thread, &session.terminal))
            .collect();
        let worker = HistoryPersistence::start(dir.clone(), drop).unwrap();
        let handle = worker.handle();
        let mut terminals = Terminals::new(&dir);
        for session in &case.opened {
            let persisted = persisted(case, &dir, &session.terminal);
            // The trace records the history each publish left behind, not the chunk that produced
            // it, so the first output event carries whatever the shipped run appended.
            let appended = persisted
                .strip_prefix(session.initial.as_slice())
                .unwrap_or_default()
                .to_vec();
            let mut output = PersistedOutput::new(
                TerminalOutput::new(BoundedHistory::with_limits(
                    5_000,
                    UNLIMITED_BYTES,
                    &session.initial,
                )),
                handle.clone(),
                &dir,
                &case.thread,
                &session.terminal,
            );
            // The shipped open published `started`, which took the sequence before the close's.
            output.start(session.pid);
            for index in 0..session.outputs {
                let chunk = if index == 0 {
                    String::from_utf8(appended.clone()).expect("output is valid utf8")
                } else {
                    String::new()
                };
                output.enqueue(session.pid, PendingEvent::Data(chunk));
                while output.drain_next(session.pid).is_some() {}
            }
            assert_eq!(
                output.history_value(),
                persisted,
                "{}: the port reaches the history the shipped run persisted for {}",
                case.name,
                session.terminal
            );
            terminals.insert(&case.thread, &session.terminal, output);
        }
        // What the shipped run had on disk when its close started. A terminal that never persisted
        // has no file, so existence is compared rather than assumed.
        let baseline: Vec<Option<Vec<u8>>> =
            targets.iter().map(|target| fs::read(target).ok()).collect();
        let published = Publications::default();
        let mut watch = published.watch(targets.clone());
        // A `readdir` proves the close carried no terminal id and swept. A thread close without the
        // flag leaves no such mark, so every opened session publishing `closed` is the next best
        // evidence; a single-terminal close of one session is behaviorally identical either way.
        let swept =
            case.swept || (case.opened.len() > 1 && case.published.len() == case.opened.len());
        let warnings = if swept {
            sweeps += 1;
            terminals
                .close(&case.thread, None, Some(case.deletes), &mut watch)
                .unwrap()
        } else {
            let terminal = case
                .published
                .first()
                .map(|(name, _sequence)| name.clone())
                .or_else(|| case.opened.first().map(|session| session.terminal.clone()))
                .unwrap_or_else(|| DEFAULT_TERMINAL_ID.to_owned());
            terminals
                .close(
                    &case.thread,
                    Some(&terminal),
                    Some(case.deletes),
                    &mut watch,
                )
                .unwrap()
        };
        drop(worker);
        let observed = published.taken();
        publications += observed.len();
        assert_eq!(
            observed
                .iter()
                .map(|(terminal, sequence, _)| (terminal.clone(), *sequence))
                .collect::<Vec<_>>(),
            case.published,
            "{}: publications",
            case.name
        );
        if case.injected {
            injected += 1;
            // An injected `rm` fault leaves the file, which no real directory reproduces, so these
            // cases cannot compare the port's warnings. What they do replay is the log contract the
            // shipped run wrote: the message text, and the field names in the order they are logged.
            for (message, fields) in &case.warnings {
                replayed += 1;
                let message_constant = if fields.split(',').any(|name| name == "terminalId") {
                    TERMINAL_DELETE_WARNING
                } else {
                    THREAD_DELETE_WARNING
                };
                let warning = Warning {
                    message: message_constant,
                    thread_id: case.thread.clone(),
                    terminal_id: (message_constant == TERMINAL_DELETE_WARNING).then(|| {
                        case.published
                            .first()
                            .map(|(terminal, _)| terminal.clone())
                            .unwrap_or_default()
                    }),
                    error: "injected".to_owned(),
                };
                assert_eq!(
                    (warning.message.to_owned(), warning_fields(&warning)),
                    (message.clone(), fields.clone()),
                    "{}: warning contract",
                    case.name
                );
            }
        } else {
            compared += 1;
            produced += case.warnings.len();
            for (terminal, _sequence, present) in &observed {
                let index = case
                    .opened
                    .iter()
                    .position(|session| session.terminal == *terminal)
                    .unwrap();
                let mut expected = baseline.clone();
                expected[index] = Some(persisted(case, &dir, terminal));
                assert_eq!(
                    *present, expected,
                    "{}: the close writes the history it publishes and removes nothing before it",
                    case.name
                );
            }
            assert_eq!(
                warnings
                    .iter()
                    .map(|warning| (warning.message.to_owned(), warning_fields(warning)))
                    .collect::<Vec<_>>(),
                case.warnings,
                "{}: warnings",
                case.name
            );
            assert!(
                warnings
                    .iter()
                    .all(|warning| warning.message == TERMINAL_DELETE_WARNING
                        || warning.message == THREAD_DELETE_WARNING),
                "{}: warning text",
                case.name
            );
            assert_eq!(
                rendered(&listing(&dir)),
                rendered(&sorted(&case.post)),
                "{}: disk after close",
                case.name
            );
        }
        if !case.has_logs_dir {
            assert!(!dir.exists(), "{}: close creates no directory", case.name);
        }
        let _ = fs::remove_dir_all(&root);
    }
    assert_eq!(sweeps, 10);
    assert_eq!(injected, 4);
    assert_eq!(compared, 18);
    assert_eq!(
        replayed + produced,
        4,
        "every shipped warning row was accounted for"
    );
    eprintln!(
        "manager close golden: 22 shipped cases replayed — {publications} publications observed against a real \
         directory, {sweeps} thread sweeps, {compared} cases compared for warnings and disk state, {injected} \
         injected-fault cases replayed for publication order; of the 4 shipped warning rows, {produced} matched \
         a warning the port produced by failing a real removal and {replayed} matched the port's message and field \
         names for a fault no real filesystem reproduces"
    );
}

fn sorted(samples: &[Sample]) -> Vec<Sample> {
    let mut samples: Vec<_> = samples
        .iter()
        .map(|sample| Sample {
            name: sample.name.clone(),
            kind: sample.kind,
            content: sample.content.clone(),
        })
        .collect();
    samples.sort_by(|left, right| left.name.cmp(&right.name));
    samples
}

fn warning_fields(warning: &lmcs_pty::lifecycle::Warning) -> String {
    warning
        .fields()
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect::<Vec<_>>()
        .join(",")
}
