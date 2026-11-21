use lmcs_terminal_history::{BoundedHistory, sanitize};

use crate::{Delivery, PendingEvent, Pipe, Sanitized};

/// In-memory output state; spawning, persistence and publication belong to its owner.
pub struct TerminalOutput {
    pipe: Pipe,
    history: BoundedHistory,
}

impl TerminalOutput {
    pub fn new(history: BoundedHistory) -> Self {
        Self {
            pipe: Pipe::new(),
            history,
        }
    }

    pub fn start(&mut self, pid: u32) -> u64 {
        self.pipe.start(pid)
    }

    pub fn restart(&mut self, pid: u32) -> u64 {
        self.history.clear();
        self.pipe.start(pid)
    }

    pub fn stop(&mut self) {
        self.pipe.stop();
    }

    pub fn close(&mut self) -> u64 {
        self.pipe.close()
    }

    pub fn clear(&mut self) -> u64 {
        self.history.clear();
        self.pipe.clear()
    }

    pub fn enqueue(&mut self, pid: u32, event: PendingEvent) -> bool {
        self.pipe.enqueue(pid, event)
    }

    pub fn drain_next(&mut self, pid: u32) -> Option<Delivery> {
        let history = &mut self.history;
        self.pipe.drain_next(pid, |pending, data| {
            let sanitized = sanitize(pending, data);
            if !sanitized.visible.is_empty() {
                history.append(sanitized.visible.as_bytes());
            }
            Sanitized {
                visible: sanitized.visible,
                pending: sanitized.pending,
            }
        })
    }

    pub fn history(&self) -> &BoundedHistory {
        &self.history
    }

    pub fn sequence(&self) -> u64 {
        self.pipe.sequence()
    }

    pub fn queued(&self) -> usize {
        self.pipe.queued()
    }
}

impl Default for TerminalOutput {
    fn default() -> Self {
        Self::new(BoundedHistory::new(b""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_pty::exit_event;

    fn data(text: &str) -> PendingEvent {
        PendingEvent::Data(text.to_string())
    }

    #[test]
    fn history_changes_at_dequeue_without_changing_raw_deliveries() {
        let mut output = TerminalOutput::default();
        assert!(!output.enqueue(7, data("before-start")));
        assert_eq!(output.start(7), 1);
        let chunks = [
            "prompt\x1b[6",
            "n\x1b[31",
            "mred\x1b[0m",
            "\x1b]11;?\x07",
            "",
        ];
        for (index, chunk) in chunks.iter().enumerate() {
            assert_eq!(output.enqueue(7, data(chunk)), index == 0);
        }
        assert_eq!(output.sequence(), 1);
        assert_eq!(output.history().value(), b"");
        let visible = ["prompt", "", "\x1b[31mred\x1b[0m", "", ""];
        let mut retained = String::new();
        for (index, (chunk, visible)) in chunks.iter().zip(visible).enumerate() {
            assert_eq!(
                output.drain_next(7),
                Some(Delivery::Output {
                    sequence: index as u64 + 2,
                    data: chunk.to_string(),
                    visible: visible.to_string(),
                    history_grew: !visible.is_empty(),
                })
            );
            retained.push_str(visible);
            assert_eq!(output.history().value(), retained.as_bytes());
        }
        assert_eq!(output.queued(), 0);
        assert_eq!(output.drain_next(7), None);
    }

    #[test]
    fn byte_and_line_limits_do_not_truncate_live_output() {
        for (lines, bytes, expected) in [(2, 100, "é\n𐀀tail"), (10, 7, "tail")] {
            let mut output = TerminalOutput::new(BoundedHistory::with_limits(lines, bytes, b""));
            output.start(7);
            let raw = "old\né\n𐀀tail";
            output.enqueue(7, data(raw));
            assert_eq!(
                output.drain_next(7),
                Some(Delivery::Output {
                    sequence: 2,
                    data: raw.to_string(),
                    visible: raw.to_string(),
                    history_grew: true,
                })
            );
            assert_eq!(output.history().value(), expected.as_bytes());
        }
    }

    #[test]
    fn clear_discards_queued_output_and_control_carry_without_stopping_the_process() {
        let mut output = TerminalOutput::default();
        output.start(7);
        output.enqueue(7, data("old\x1b["));
        let held = output.drain_next(7).unwrap();
        assert_eq!(output.history().value(), b"old");
        assert!(!output.enqueue(7, data("discarded")));
        assert_eq!(output.clear(), 3);
        assert_eq!(output.history().value(), b"");
        assert_eq!(output.queued(), 0);
        assert!(output.enqueue(7, data("6nnew")));
        assert_eq!(
            output.drain_next(7),
            Some(Delivery::Output {
                sequence: 4,
                data: "6nnew".to_string(),
                visible: "6nnew".to_string(),
                history_grew: true,
            })
        );
        assert_eq!(output.history().value(), b"6nnew");
        assert!(matches!(held, Delivery::Output { sequence: 2, .. }));
        assert_eq!(output.drain_next(7), None);
    }

    #[test]
    fn exit_retains_history_but_discards_incomplete_controls_and_late_data() {
        let mut output = TerminalOutput::default();
        output.start(7);
        output.enqueue(7, data("kept\x1b]11;"));
        output.enqueue(7, PendingEvent::Exit(exit_event(7, Some(0))));
        output.enqueue(7, data("after-exit"));
        assert!(matches!(
            output.drain_next(7),
            Some(Delivery::Output { .. })
        ));
        assert_eq!(
            output.drain_next(7),
            Some(Delivery::Exit {
                sequence: 3,
                exit_code: Some(7),
                exit_signal: Some(0)
            })
        );
        assert_eq!(output.history().value(), b"kept");
        assert_eq!(output.queued(), 0);
        assert_eq!(output.drain_next(7), None);
        assert!(!output.enqueue(7, data("late")));
    }

    #[test]
    fn start_preserves_restored_history_and_restart_clears_it() {
        let mut output = TerminalOutput::new(BoundedHistory::new(b"restored"));
        assert_eq!(output.start(7), 1);
        assert_eq!(output.history().value(), b"restored");
        output.enqueue(7, data("before\x1b["));
        assert!(output.drain_next(7).is_some());
        output.enqueue(7, data("queued"));
        assert_eq!(output.restart(8), 3);
        assert_eq!(output.history().value(), b"");
        assert_eq!(output.queued(), 0);
        assert!(!output.enqueue(7, data("stale")));
        assert!(output.enqueue(8, data("6nnew")));
        assert!(output.drain_next(8).is_some());
        assert_eq!(output.history().value(), b"6nnew");
        output.stop();
        assert_eq!(output.history().value(), b"6nnew");
        assert!(!output.enqueue(8, data("stopped")));
        assert_eq!(output.close(), 5);
        assert_eq!(output.history().value(), b"6nnew");
    }

    #[test]
    fn a_stale_walker_still_clears_the_new_queue_without_appending_history() {
        let mut output = TerminalOutput::default();
        output.start(7);
        output.enqueue(7, data("held"));
        assert!(output.drain_next(7).is_some());
        output.restart(8);
        assert!(output.enqueue(8, data("new-but-lost")));
        assert_eq!(output.drain_next(7), None);
        assert_eq!(output.queued(), 0);
        assert_eq!(output.history().value(), b"");
        assert_eq!(output.drain_next(8), None);
        assert_eq!(output.sequence(), 3);
    }
}
