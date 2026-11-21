use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::{BoundedHistory, history_path};

const DEBOUNCE: Duration = Duration::from_millis(40);

/// Release this lock before waiting on drain or worker shutdown.
pub type SharedHistory = Arc<Mutex<BoundedHistory>>;

pub struct PersistWarning {
    pub thread_id: String,
    pub terminal_id: String,
    pub cause: io::Error,
}

struct Request {
    history: SharedHistory,
    immediate: bool,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, Request>,
    queued: VecDeque<String>,
    active: Option<String>,
    stopped: bool,
}

impl State {
    fn enqueue(&mut self, key: String, mut request: Request) {
        if let Some(previous) = self.pending.get(&key) {
            request.immediate |= previous.immediate;
        } else if self.active.as_ref() != Some(&key) {
            self.queued.push_back(key.clone());
        }
        self.pending.insert(key, request);
    }

    fn begin(&mut self) -> Option<(String, Request)> {
        let key = self.queued.pop_front()?;
        let request = self.pending.remove(&key).expect("queued request");
        self.active = Some(key.clone());
        Some((key, request))
    }

    fn finish(&mut self, key: &str) -> Option<Request> {
        if let Some(request) = self.pending.remove(key) {
            return Some(request);
        }
        self.active = None;
        None
    }

    fn busy(&self, key: &str) -> bool {
        self.pending.contains_key(key)
            || self.active.as_deref() == Some(key)
            || self.queued.iter().any(|queued| queued == key)
    }
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopped = true;
        state.pending.clear();
        state.queued.clear();
        self.changed.notify_all();
    }

    fn wait_delay(&self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        let mut state = self.state.lock().unwrap();
        loop {
            if state.stopped {
                return false;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return true;
            }
            state = self.changed.wait_timeout(state, remaining).unwrap().0;
        }
    }
}

#[derive(Clone)]
pub struct PersistHandle {
    shared: Arc<Shared>,
}

impl PersistHandle {
    /// Retains the live history; immediate requests do not preempt an active delay or write.
    pub fn enqueue(
        &self,
        thread_id: &str,
        terminal_id: &str,
        history: SharedHistory,
        immediate: bool,
    ) -> io::Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        if state.stopped {
            return Err(stopped());
        }
        state.enqueue(
            session_key(thread_id, terminal_id),
            Request { history, immediate },
        );
        self.shared.changed.notify_all();
        Ok(())
    }

    /// Waits for active and pending work, including enqueues during the wait; not a durability barrier.
    pub fn drain(&self, thread_id: &str, terminal_id: &str) -> io::Result<()> {
        self.drain_with(&session_key(thread_id, terminal_id), || {})
    }

    fn drain_with(&self, key: &str, mut on_wait: impl FnMut()) -> io::Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if state.stopped {
                return Err(stopped());
            }
            if !state.busy(key) {
                return Ok(());
            }
            on_wait();
            state = self.shared.changed.wait(state).unwrap();
        }
    }
}

fn session_key(thread_id: &str, terminal_id: &str) -> String {
    format!("{thread_id}\0{terminal_id}")
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "terminal history worker stopped")
}

pub struct HistoryPersistence {
    handle: PersistHandle,
    worker: Option<JoinHandle<()>>,
}

impl HistoryPersistence {
    /// Warnings run on the worker; the callback must not drain or stop that same worker.
    pub fn start(
        logs_dir: PathBuf,
        on_warning: impl FnMut(PersistWarning) + Send + 'static,
    ) -> io::Result<Self> {
        Self::spawn(Disk {
            logs_dir,
            on_warning,
        })
    }

    fn spawn(backend: impl Backend) -> io::Result<Self> {
        let shared = Arc::new(Shared::default());
        let handle = PersistHandle {
            shared: shared.clone(),
        };
        let worker = thread::Builder::new()
            .name("terminal-history".to_owned())
            .spawn(move || {
                let _completion = Completion(shared.clone());
                run(&shared, backend);
            })?;
        Ok(Self {
            handle,
            worker: Some(worker),
        })
    }

    pub fn handle(&self) -> PersistHandle {
        self.handle.clone()
    }

    /// Cancels queued work and timers, then joins; a blocking write already in flight must finish.
    pub fn stop(&mut self) -> io::Result<()> {
        self.handle.shared.stop();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| io::Error::other("terminal history worker panicked"))?;
        }
        Ok(())
    }
}

impl Drop for HistoryPersistence {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct Completion(Arc<Shared>);

impl Drop for Completion {
    fn drop(&mut self) {
        // Wake drainers even if a history lock or warning callback panics on the worker.
        self.0.stop();
    }
}

trait Backend: Send + 'static {
    fn delay(&mut self, shared: &Shared) -> bool {
        shared.wait_delay(DEBOUNCE)
    }
    fn write(&mut self, thread_id: &str, terminal_id: &str, bytes: Vec<u8>) -> io::Result<()>;
    fn warn(&mut self, warning: PersistWarning);
}

struct Disk<F> {
    logs_dir: PathBuf,
    on_warning: F,
}

impl<F: FnMut(PersistWarning) + Send + 'static> Backend for Disk<F> {
    fn write(&mut self, thread_id: &str, terminal_id: &str, bytes: Vec<u8>) -> io::Result<()> {
        fs::write(history_path(&self.logs_dir, thread_id, terminal_id), bytes)
    }

    fn warn(&mut self, warning: PersistWarning) {
        (self.on_warning)(warning);
    }
}

fn run(shared: &Shared, mut backend: impl Backend) {
    loop {
        let (key, mut request) = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.stopped {
                    return;
                }
                if let Some(item) = state.begin() {
                    break item;
                }
                state = shared.changed.wait(state).unwrap();
            }
        };
        loop {
            if !request.immediate && !backend.delay(shared) {
                return;
            }
            if shared.state.lock().unwrap().stopped {
                return;
            }
            let mut parts = key.split('\0');
            let thread_id = parts.next().unwrap_or("");
            let terminal_id = parts.next().unwrap_or("");
            if !thread_id.is_empty() && !terminal_id.is_empty() {
                let bytes = request.history.lock().unwrap().value();
                if let Err(cause) = backend.write(thread_id, terminal_id, bytes) {
                    backend.warn(PersistWarning {
                        thread_id: thread_id.to_owned(),
                        terminal_id: terminal_id.to_owned(),
                        cause,
                    });
                }
            }
            let mut state = shared.state.lock().unwrap();
            if state.stopped {
                return;
            }
            if let Some(next) = state.finish(&key) {
                request = next;
            } else {
                shared.changed.notify_all();
                break;
            }
        }
    }
}

#[cfg(test)]
#[path = "persist_tests.rs"]
mod tests;
