//! Where terminal state changes reach the persistence worker, ported from the
//! `queuePersist`/`persistHistory`/`flushPersist` call sites in
//! `apps/server/src/terminal/Manager.ts`.

use std::io;
use std::path::{Path, PathBuf};

use lmcs_terminal_history::{
    DeleteFailure, PersistHandle, SharedHistory, delete_history, delete_thread_history,
};

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
    logs_dir: PathBuf,
    thread_id: String,
    terminal_id: String,
}

impl PersistedOutput {
    pub fn new(
        output: TerminalOutput,
        persist: PersistHandle,
        logs_dir: &Path,
        thread_id: &str,
        terminal_id: &str,
    ) -> Self {
        Self {
            output,
            persist,
            logs_dir: logs_dir.to_path_buf(),
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

    /// `openLocked`'s reset of a terminal it is handing to a different launch (Manager.ts:2592):
    /// history cleared and written immediately, with no sequence and no event. The write is what makes
    /// a later reader see an empty screen rather than the one the killed shell left behind.
    pub fn reset_history(&mut self) -> io::Result<()> {
        self.output.reset_history();
        self.persist_now()
    }

    /// Persists the cleared history before the caller publishes `restarted`.
    pub fn restart(&mut self, pid: u32) -> io::Result<u64> {
        let sequence = self.output.restart(pid);
        self.persist_now()?;
        Ok(sequence)
    }

    /// `startSession`'s failure path: handles are cleaned and the sequence advances, with nothing
    /// persisted, because a spawn that never ran has no history to keep.
    pub fn fail_start(&mut self) -> u64 {
        self.output.close()
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

    /// `deleteHistory`, which the reference manager runs *after* publishing `closed`. Call it
    /// after `close`: a write still queued for this key would land after the removal and put the
    /// file back. Failures are the caller's to log, exactly as the shipped warnings are.
    pub fn delete_history(&self) -> Vec<DeleteFailure> {
        delete_history(&self.logs_dir, &self.thread_id, &self.terminal_id)
    }

    /// `deleteAllHistoryForThread`, reached by closing a thread without a terminal id. Same
    /// warning policy, and the same requirement that this key's queued work be drained first.
    pub fn delete_thread_history(&self) -> Vec<DeleteFailure> {
        delete_thread_history(&self.logs_dir, &self.thread_id)
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
