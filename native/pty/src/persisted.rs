//! Where terminal state changes reach the persistence worker, ported from the
//! `queuePersist`/`persistHistory`/`flushPersist` call sites in
//! `apps/server/src/terminal/Manager.ts`.

use std::io;

use lmcs_terminal_history::{PersistHandle, SharedHistory};

use crate::output::TerminalOutput;
use crate::{Delivery, PendingEvent};

/// Output state that queues a debounced write when visible text lands and waits for
/// a write when the reference manager persists before returning to the caller.
///
/// The immediate paths block this thread until the worker finishes that key, so an
/// async owner must run them off its executor. `drain_next` never blocks: it only
/// hands the live history to the worker.
pub struct PersistedOutput {
    output: TerminalOutput,
    persist: PersistHandle,
    thread_id: String,
    terminal_id: String,
}

impl PersistedOutput {
    pub fn new(
        output: TerminalOutput,
        persist: PersistHandle,
        thread_id: &str,
        terminal_id: &str,
    ) -> Self {
        Self {
            output,
            persist,
            thread_id: thread_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
        }
    }

    pub fn start(&mut self, pid: u32) -> u64 {
        self.output.start(pid)
    }

    pub fn stop(&mut self) {
        self.output.stop();
    }

    pub fn enqueue(&mut self, pid: u32, event: PendingEvent) -> bool {
        self.output.enqueue(pid, event)
    }

    /// Persists the cleared history before the caller publishes `cleared`.
    pub fn clear(&mut self) -> io::Result<u64> {
        let sequence = self.output.clear();
        self.persist_now()?;
        Ok(sequence)
    }

    /// Persists the cleared history before the caller publishes `restarted`.
    pub fn restart(&mut self, pid: u32) -> io::Result<u64> {
        let sequence = self.output.restart(pid);
        self.persist_now()?;
        Ok(sequence)
    }

    /// Persists retained history, so a later reader reopens what the session ended with.
    pub fn close(&mut self) -> io::Result<u64> {
        let sequence = self.output.close();
        self.persist_now()?;
        Ok(sequence)
    }

    /// Waits for queued work on this key; the reference manager does this before
    /// reopening a history file that a previous session may still be holding dirty.
    pub fn flush(&mut self) -> io::Result<()> {
        self.persist.drain(&self.thread_id, &self.terminal_id)
    }

    pub fn drain_next(&mut self, pid: u32) -> Option<Delivery> {
        let delivery = self.output.drain_next(pid);
        // Only a stopped worker rejects, and by then the queue no longer matters;
        // the immediate paths report it to the caller.
        if matches!(
            delivery,
            Some(Delivery::Output {
                history_grew: true,
                ..
            })
        ) {
            let _ = self.queue();
        }
        delivery
    }

    pub fn history_value(&self) -> Vec<u8> {
        self.output.history_value()
    }

    pub fn history_bytes(&self) -> usize {
        self.output.history_bytes()
    }

    pub fn shared_history(&self) -> SharedHistory {
        self.output.shared_history()
    }

    pub fn sequence(&self) -> u64 {
        self.output.sequence()
    }

    pub fn queued(&self) -> usize {
        self.output.queued()
    }

    fn queue(&self) -> io::Result<()> {
        self.persist.enqueue(
            &self.thread_id,
            &self.terminal_id,
            self.output.shared_history(),
            false,
        )
    }

    fn persist_now(&self) -> io::Result<()> {
        self.persist.enqueue(
            &self.thread_id,
            &self.terminal_id,
            self.output.shared_history(),
            true,
        )?;
        self.persist.drain(&self.thread_id, &self.terminal_id)
    }
}
