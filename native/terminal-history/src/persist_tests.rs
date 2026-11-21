use super::*;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};

fn history(value: &str) -> SharedHistory {
    Arc::new(Mutex::new(BoundedHistory::with_limits(
        5,
        128,
        value.as_bytes(),
    )))
}

#[derive(Debug, PartialEq, Eq)]
enum Notice {
    Delay,
    Write(String, String, Vec<u8>),
    Warning(String, String, io::ErrorKind),
}

struct Controlled {
    notices: Sender<Notice>,
    permits: Receiver<io::Result<()>>,
}

impl Backend for Controlled {
    fn delay(&mut self, _shared: &Shared) -> bool {
        self.notices.send(Notice::Delay).unwrap();
        matches!(self.permits.recv(), Ok(Ok(())))
    }

    fn write(&mut self, thread_id: &str, terminal_id: &str, bytes: Vec<u8>) -> io::Result<()> {
        self.notices
            .send(Notice::Write(
                thread_id.to_owned(),
                terminal_id.to_owned(),
                bytes,
            ))
            .unwrap();
        self.permits.recv().unwrap_or_else(|_| Err(stopped()))
    }

    fn warn(&mut self, warning: PersistWarning) {
        self.notices
            .send(Notice::Warning(
                warning.thread_id,
                warning.terminal_id,
                warning.cause.kind(),
            ))
            .unwrap();
    }
}

struct Harness {
    worker: HistoryPersistence,
    notices: Receiver<Notice>,
    permits: Option<Sender<io::Result<()>>>,
}

impl Harness {
    fn new() -> Self {
        let (sender, notices) = mpsc::channel();
        let (permits, receiver) = mpsc::channel();
        let worker = HistoryPersistence::spawn(Controlled {
            notices: sender,
            permits: receiver,
        })
        .unwrap();
        Self {
            worker,
            notices,
            permits: Some(permits),
        }
    }

    fn release(&self) {
        self.permits.as_ref().unwrap().send(Ok(())).unwrap();
    }

    fn expect_write(&self, thread_id: &str, text: &str) {
        assert_eq!(
            self.notices.recv().unwrap(),
            Notice::Write(
                thread_id.to_owned(),
                "term-1".to_owned(),
                text.as_bytes().to_vec()
            )
        );
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.permits.take();
        let _ = self.worker.stop();
    }
}

#[test]
fn pending_merge_keeps_latest_handle_and_or_only_for_pending_requests() {
    let mut state = State::default();
    let old = history("old");
    let next = history("new");
    state.enqueue(
        "a".to_owned(),
        Request {
            history: old.clone(),
            immediate: true,
        },
    );
    let (key, active) = state.begin().unwrap();
    assert!(active.immediate);
    state.enqueue(
        "b".to_owned(),
        Request {
            history: old.clone(),
            immediate: false,
        },
    );
    state.enqueue(
        "b".to_owned(),
        Request {
            history: old.clone(),
            immediate: true,
        },
    );
    state.enqueue(
        "b".to_owned(),
        Request {
            history: next.clone(),
            immediate: false,
        },
    );
    state.enqueue(
        "a".to_owned(),
        Request {
            history: next.clone(),
            immediate: false,
        },
    );
    let followup = state.finish(&key).unwrap();
    assert!(!followup.immediate);
    assert!(Arc::ptr_eq(&followup.history, &next));
    assert!(Arc::ptr_eq(&active.history, &old));
    assert_eq!(state.active.as_deref(), Some("a"));
    assert!(state.finish(&key).is_none());
    let (key, request) = state.begin().unwrap();
    assert_eq!(key, "b");
    assert!(request.immediate);
    assert!(Arc::ptr_eq(&request.history, &next));
    assert!(state.finish(&key).is_none());
    assert!(state.begin().is_none());
}

#[test]
fn live_history_is_sampled_after_delay_and_not_locked_during_write() {
    let h = Harness::new();
    let handle = h.worker.handle();
    let live = history("first");
    handle.enqueue("a", "term-1", live.clone(), false).unwrap();
    assert_eq!(h.notices.recv().unwrap(), Notice::Delay);
    live.lock().unwrap().append(b"-late");
    h.release();
    h.expect_write("a", "first-late");
    live.try_lock()
        .expect("no history lock during filesystem I/O")
        .append(b"-later");
    h.release();
    handle.drain("a", "term-1").unwrap();
    assert!(h.notices.try_recv().is_err());
}

#[test]
fn immediate_followup_does_not_replace_active_request_or_overtake_delay() {
    let h = Harness::new();
    let handle = h.worker.handle();
    handle
        .enqueue("a", "term-1", history("old"), false)
        .unwrap();
    assert_eq!(h.notices.recv().unwrap(), Notice::Delay);
    handle
        .enqueue("b", "term-1", history("other"), true)
        .unwrap();
    handle.enqueue("a", "term-1", history("new"), true).unwrap();
    assert!(h.notices.try_recv().is_err());
    h.release();
    h.expect_write("a", "old");
    h.release();
    h.expect_write("a", "new");
    h.release();
    h.expect_write("b", "other");
    handle.drain("a", "term-1").unwrap();
    h.release();
    handle.drain("b", "term-1").unwrap();
}

#[test]
fn immediate_active_request_does_not_make_a_later_request_immediate() {
    let h = Harness::new();
    let handle = h.worker.handle();
    handle.enqueue("a", "term-1", history("old"), true).unwrap();
    h.expect_write("a", "old");
    handle
        .enqueue("a", "term-1", history("new"), false)
        .unwrap();
    h.release();
    assert_eq!(h.notices.recv().unwrap(), Notice::Delay);
    h.release();
    h.expect_write("a", "new");
    h.release();
    handle.drain("a", "term-1").unwrap();
}

#[test]
fn drain_waits_for_active_and_followup_writes_but_not_unrelated_work() {
    let h = Harness::new();
    let handle = h.worker.handle();
    handle
        .enqueue("a", "term-1", history("first"), true)
        .unwrap();
    h.expect_write("a", "first");
    handle.drain("idle", "term-1").unwrap();
    let (waiting, wait_receipt) = mpsc::channel();
    let (drained, drain_receipt) = mpsc::channel();
    let drainer = handle.clone();
    let thread = thread::spawn(move || {
        let result = drainer.drain_with(&session_key("a", "term-1"), || {
            waiting.send(()).unwrap();
        });
        drained.send(result).unwrap();
    });
    wait_receipt.recv().unwrap();
    handle
        .enqueue("a", "term-1", history("second"), true)
        .unwrap();
    handle
        .enqueue("b", "term-1", history("other"), true)
        .unwrap();
    h.release();
    h.expect_write("a", "second");
    assert!(drain_receipt.try_recv().is_err());
    h.release();
    h.expect_write("b", "other");
    drain_receipt.recv().unwrap().unwrap();
    thread.join().unwrap();
    h.release();
    handle.drain("b", "term-1").unwrap();
}

#[test]
fn write_failures_warn_then_process_pending_work_and_allow_drain() {
    let h = Harness::new();
    let handle = h.worker.handle();
    handle
        .enqueue("a", "term-1", history("first"), true)
        .unwrap();
    h.expect_write("a", "first");
    handle
        .enqueue("a", "term-1", history("retry"), true)
        .unwrap();
    handle
        .enqueue("b", "term-1", history("other"), true)
        .unwrap();
    h.permits
        .as_ref()
        .unwrap()
        .send(Err(io::ErrorKind::PermissionDenied.into()))
        .unwrap();
    assert_eq!(
        h.notices.recv().unwrap(),
        Notice::Warning(
            "a".to_owned(),
            "term-1".to_owned(),
            io::ErrorKind::PermissionDenied
        )
    );
    h.expect_write("a", "retry");
    h.release();
    h.expect_write("b", "other");
    handle.drain("a", "term-1").unwrap();
    h.release();
    handle.drain("b", "term-1").unwrap();
}

#[test]
fn stop_rejects_enqueues_and_drains_and_joins_the_accepted_write() {
    let mut h = Harness::new();
    let handle = h.worker.handle();
    handle
        .enqueue("a", "term-1", history("first"), true)
        .unwrap();
    h.expect_write("a", "first");
    let pending = history("never");
    let weak = Arc::downgrade(&pending);
    handle.enqueue("b", "term-1", pending, true).unwrap();
    let (waiting, wait_receipt) = mpsc::channel();
    let drainer = handle.clone();
    let drain_thread = thread::spawn(move || {
        drainer.drain_with(&session_key("a", "term-1"), || {
            waiting.send(()).unwrap();
        })
    });
    wait_receipt.recv().unwrap();
    handle.shared.stop();
    assert_eq!(
        drain_thread.join().unwrap().unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(
        handle
            .enqueue("c", "term-1", history("no"), true)
            .unwrap_err()
            .kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(
        handle.drain("idle", "term-1").unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    h.release();
    h.worker.stop().unwrap();
    h.worker.stop().unwrap();
    assert!(h.notices.try_recv().is_err());
}

#[test]
fn public_stop_joins_while_a_write_is_in_flight() {
    let (notices, received) = mpsc::channel();
    let (permits, receiver) = mpsc::channel();
    let mut worker = HistoryPersistence::spawn(Controlled {
        notices,
        permits: receiver,
    })
    .unwrap();
    let handle = worker.handle();
    let value = history("in flight");
    let weak = Arc::downgrade(&value);
    handle.enqueue("a", "term-1", value, true).unwrap();
    assert_eq!(
        received.recv().unwrap(),
        Notice::Write("a".to_owned(), "term-1".to_owned(), b"in flight".to_vec())
    );
    let (waiting, wait_receipt) = mpsc::channel();
    let drainer = handle.clone();
    let drain_thread = thread::spawn(move || {
        drainer.drain_with(&session_key("a", "term-1"), || {
            waiting.send(()).unwrap();
        })
    });
    wait_receipt.recv().unwrap();
    let (stopped, stop_receipt) = mpsc::channel();
    let stop_thread = thread::spawn(move || {
        worker.stop().unwrap();
        assert!(
            weak.upgrade().is_none(),
            "stop returned before the write finished"
        );
        stopped.send(()).unwrap();
    });
    assert_eq!(
        drain_thread.join().unwrap().unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert!(stop_receipt.try_recv().is_err());
    permits.send(Ok(())).unwrap();
    stop_receipt.recv().unwrap();
    stop_thread.join().unwrap();
}

#[test]
fn default_backend_delay_waits_at_least_forty_milliseconds() {
    struct Timestamp(Sender<Instant>);
    impl Backend for Timestamp {
        fn write(&mut self, _thread: &str, _terminal: &str, _bytes: Vec<u8>) -> io::Result<()> {
            self.0.send(Instant::now()).unwrap();
            Ok(())
        }
        fn warn(&mut self, _warning: PersistWarning) {
            panic!("unexpected write failure");
        }
    }
    let (written, writes) = mpsc::channel();
    let mut worker = HistoryPersistence::spawn(Timestamp(written)).unwrap();
    let handle = worker.handle();
    let start = Instant::now();
    handle
        .enqueue("a", "term-1", history("delayed"), false)
        .unwrap();
    assert!(writes.recv().unwrap().duration_since(start) >= Duration::from_millis(40));
    handle.drain("a", "term-1").unwrap();
    worker.stop().unwrap();
}

struct WaitingBackend {
    entered: Sender<Instant>,
    written: Sender<Instant>,
    delay: Duration,
}

impl Backend for WaitingBackend {
    fn delay(&mut self, shared: &Shared) -> bool {
        self.entered.send(Instant::now()).unwrap();
        shared.wait_delay(self.delay)
    }
    fn write(&mut self, _thread: &str, _terminal: &str, _bytes: Vec<u8>) -> io::Result<()> {
        self.written.send(Instant::now()).unwrap();
        Ok(())
    }
    fn warn(&mut self, _warning: PersistWarning) {
        panic!("unexpected write failure");
    }
}

#[test]
fn cancellation_wakes_a_waiting_timer_without_writing_or_keeping_pending_history() {
    let (entered, entry) = mpsc::channel();
    let (written, writes) = mpsc::channel();
    let mut worker = HistoryPersistence::spawn(WaitingBackend {
        entered,
        written,
        delay: Duration::from_secs(86_400),
    })
    .unwrap();
    let handle = worker.handle();
    let value = history("not written");
    let weak = Arc::downgrade(&value);
    handle.enqueue("a", "term-1", value, false).unwrap();
    entry.recv().unwrap();
    worker.stop().unwrap();
    assert!(writes.try_recv().is_err());
    assert!(weak.upgrade().is_none());
}

#[test]
fn debounce_waits_for_its_deadline_despite_enqueue_notifications() {
    let (entered, entry) = mpsc::channel();
    let (written, writes) = mpsc::channel();
    let mut worker = HistoryPersistence::spawn(WaitingBackend {
        entered,
        written,
        delay: DEBOUNCE,
    })
    .unwrap();
    let handle = worker.handle();
    handle
        .enqueue("a", "term-1", history("first"), false)
        .unwrap();
    let start = entry.recv().unwrap();
    handle
        .enqueue("a", "term-1", history("immediate"), true)
        .unwrap();
    let first = writes.recv().unwrap();
    assert!(first.duration_since(start) >= DEBOUNCE);
    writes.recv().unwrap();
    handle.drain("a", "term-1").unwrap();
    assert!(entry.try_recv().is_err());
    worker.stop().unwrap();
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = std::env::temp_dir().join(format!(
                "lmcs-history-persist-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn real_worker_replaces_reopens_and_clears_files_after_drain() {
    let directory = TempDir::new();
    let (warnings, received) = mpsc::channel();
    let mut worker = HistoryPersistence::start(directory.0.clone(), move |warning| {
        warnings.send(warning).unwrap()
    })
    .unwrap();
    let handle = worker.handle();
    let live = history("a long initial snapshot");
    handle
        .enqueue("thread/one", "term-1", live.clone(), false)
        .unwrap();
    handle.drain("thread/one", "term-1").unwrap();
    let path = history_path(&directory.0, "thread/one", "term-1");
    assert_eq!(fs::read(&path).unwrap(), b"a long initial snapshot");
    {
        let mut history = live.lock().unwrap();
        history.clear();
        history.append("é\n".as_bytes());
    }
    handle
        .enqueue("thread/one", "term-1", live.clone(), true)
        .unwrap();
    handle.drain("thread/one", "term-1").unwrap();
    assert_eq!(
        crate::load_history(&directory.0, "thread/one", "term-1", 128, 5)
            .unwrap()
            .history
            .value(),
        "é\n".as_bytes()
    );
    live.lock().unwrap().clear();
    handle.enqueue("thread/one", "term-1", live, true).unwrap();
    handle
        .enqueue("thread/one", "term-2", history("second"), true)
        .unwrap();
    handle.drain("thread/one", "term-1").unwrap();
    handle.drain("thread/one", "term-2").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"");
    assert_eq!(
        fs::read(history_path(&directory.0, "thread/one", "term-2")).unwrap(),
        b"second"
    );
    worker.stop().unwrap();
    assert!(received.try_recv().is_err());
}

#[test]
fn real_write_failure_is_a_warning_and_drain_still_completes() {
    let directory = TempDir::new();
    let root = directory.0.join("missing");
    let (warnings, received) = mpsc::channel();
    let mut worker =
        HistoryPersistence::start(root.clone(), move |warning| warnings.send(warning).unwrap())
            .unwrap();
    let handle = worker.handle();
    handle
        .enqueue("thread", "term-2", history("retained"), true)
        .unwrap();
    handle.drain("thread", "term-2").unwrap();
    let warning = received.recv().unwrap();
    assert_eq!(warning.thread_id, "thread");
    assert_eq!(warning.terminal_id, "term-2");
    assert_eq!(warning.cause.kind(), io::ErrorKind::NotFound);
    assert!(!root.exists());
    fs::create_dir(&root).unwrap();
    handle
        .enqueue("thread", "term-2", history("next"), true)
        .unwrap();
    handle.drain("thread", "term-2").unwrap();
    assert_eq!(
        fs::read(history_path(&root, "thread", "term-2")).unwrap(),
        b"next"
    );
    worker.stop().unwrap();
    assert!(received.try_recv().is_err());
}

#[test]
fn warning_callback_panic_releases_drainers_and_is_reported_by_join() {
    let directory = TempDir::new();
    let mut worker = HistoryPersistence::start(directory.0.join("missing"), |_| {
        panic!("test warning panic")
    })
    .unwrap();
    let handle = worker.handle();
    handle
        .enqueue("thread", "term-1", history("first"), true)
        .unwrap();
    assert_eq!(
        handle.drain("thread", "term-1").unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(worker.stop().unwrap_err().kind(), io::ErrorKind::Other);
}

#[test]
fn poisoned_history_releases_drainers_and_is_reported_by_join() {
    let directory = TempDir::new();
    let mut worker =
        HistoryPersistence::start(directory.0.clone(), |_| panic!("unexpected warning")).unwrap();
    let poisoned = history("never written");
    let holder = poisoned.clone();
    assert!(
        thread::spawn(move || {
            let _guard = holder.lock().unwrap();
            panic!("poison history");
        })
        .join()
        .is_err()
    );
    let handle = worker.handle();
    handle.enqueue("thread", "term-1", poisoned, true).unwrap();
    assert_eq!(
        handle.drain("thread", "term-1").unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(worker.stop().unwrap_err().kind(), io::ErrorKind::Other);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
}

#[test]
fn session_key_splitting_retains_the_reference_empty_and_nul_behavior() {
    let directory = TempDir::new();
    let mut worker =
        HistoryPersistence::start(directory.0.clone(), |_| panic!("unexpected warning")).unwrap();
    let handle = worker.handle();
    for (thread_id, terminal_id) in [("", "term-1"), ("thread", ""), ("thread\0", "term-1")] {
        handle
            .enqueue(thread_id, terminal_id, history("ignored"), true)
            .unwrap();
        handle.drain(thread_id, terminal_id).unwrap();
    }
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    handle
        .enqueue("thread", "term-1\0suffix", history("first two parts"), true)
        .unwrap();
    handle.drain("thread", "term-1\0suffix").unwrap();
    assert_eq!(
        fs::read(history_path(&directory.0, "thread", "term-1")).unwrap(),
        b"first two parts"
    );
    worker.stop().unwrap();
}

fn unhex(value: &str) -> String {
    assert!(value.len().is_multiple_of(2));
    assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    String::from_utf8(
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect(),
    )
    .unwrap()
}

fn immediate(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid immediate flag"),
    }
}

#[test]
fn replays_the_shipped_keyed_worker_scheduling_trace() {
    let Some(path) = std::env::var_os("LMCS_TERMINAL_PERSIST_WORKER_TRACE") else {
        eprintln!(
            "skipped persistence scheduling golden: LMCS_TERMINAL_PERSIST_WORKER_TRACE unset; no cross-language check ran"
        );
        return;
    };
    let mut names = HashSet::new();
    let mut name = None;
    let mut state = State::default();
    let mut histories: HashMap<String, SharedHistory> = HashMap::new();
    let mut active: Option<(String, Request)> = None;
    let mut followup = None;
    let mut writes = 0;
    let mut events = 0;
    for row in fs::read_to_string(path).unwrap().lines() {
        events += 1;
        let fields: Vec<_> = row.split('\t').collect();
        match fields.as_slice() {
            ["C", case] => {
                assert!(name.is_none());
                assert!(names.insert((*case).to_owned()));
                name = Some((*case).to_owned());
                state = State::default();
                histories.clear();
            }
            ["H", id, text] => {
                assert!(name.is_some());
                assert!(
                    histories
                        .insert((*id).to_owned(), history(&unhex(text)))
                        .is_none()
                );
            }
            ["E", thread_id, terminal_id, id, flag] => {
                assert!(name.is_some());
                state.enqueue(
                    session_key(&unhex(thread_id), &unhex(terminal_id)),
                    Request {
                        history: histories[*id].clone(),
                        immediate: immediate(flag),
                    },
                );
            }
            ["B", key, id, flag] => {
                assert!(name.is_some());
                assert!(active.is_none());
                let (started, request) = followup
                    .take()
                    .or_else(|| state.begin())
                    .expect("queued work");
                assert_eq!(started, unhex(key), "{name:?}");
                assert!(Arc::ptr_eq(&request.history, &histories[*id]), "{name:?}");
                assert_eq!(request.immediate, immediate(flag), "{name:?}");
                active = Some((started, request));
            }
            ["A", id, text] => {
                histories[*id]
                    .lock()
                    .unwrap()
                    .append(unhex(text).as_bytes());
            }
            ["W", text] => {
                let (key, request) = active.take().expect("active write");
                assert_eq!(
                    request.history.lock().unwrap().value(),
                    unhex(text).as_bytes(),
                    "{name:?}"
                );
                followup = state.finish(&key).map(|request| (key, request));
                writes += 1;
            }
            ["D", thread_id, terminal_id] => {
                assert!(name.is_some());
                assert!(
                    !state.busy(&session_key(&unhex(thread_id), &unhex(terminal_id))),
                    "{name:?}"
                );
            }
            ["X"] => {
                assert!(name.take().is_some());
                assert!(active.is_none() && followup.is_none());
                assert!(
                    state.pending.is_empty() && state.queued.is_empty() && state.active.is_none()
                );
            }
            _ => panic!("unknown trace record: {row}"),
        }
    }
    assert!(name.is_none());
    let expected: HashSet<_> = [
        "active-followup-before-other-key",
        "pending-immediate-or-latest-history",
        "active-immediate-not-inherited-by-followup",
        "active-request-not-replaced",
        "mutable-history-sampled-late",
        "independent-idle-drain",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(names, expected);
    assert_eq!(writes, 11);
    assert_eq!(events, 73);
    eprintln!(
        "persistence scheduling golden: {} scenarios, {events} events, {writes} writes; shipped keyed helper, not Manager I/O or wall-clock timing",
        names.len()
    );
}
