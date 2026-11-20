//! The read side: what the server does with what the terminal sends back.
//!
//! Ported from `enqueueProcessEvent` (`Manager.ts:451-467`) and `drainProcessEvents`
//! (`Manager.ts:1979-2092`). The adapter decides what the PTY library is asked for; this module
//! decides which of the library's deliveries the client ever sees.
//!
//! The shipped shape is a single-flight queue with one walker: every `onData`/`onExit` callback
//! pushes onto `pendingProcessEvents` and only the push that finds no walker running is allowed
//! to start one. The walker takes one event at a time and awaits its publication before taking
//! the next, so a delivery that lands *during* a publication is queued behind it rather than
//! racing it. That is the whole reason this is a queue and not a channel: a terminal that prints
//! 4 KB in eight chunks must reach the client as eight events, in order, with eight sequences.
//!
//! Everything here is measured against the shipped manager, not re-read from it: see
//! `apps/server/scripts/terminal-pipe-trace.ts` and `tests/pipe_golden.rs`.

use crate::node_pty::PtyExitEvent;

/// The visible part of a chunk and the control sequence still open when it ended. The shape of
/// `lmcs-terminal-history`'s `Sanitized`, taken as an argument instead of a dependency: these
/// crates are standalone, and which bytes reach history is that crate's decision, not this one's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sanitized {
    pub visible: String,
    pub pending: String,
}

/// What the read side handed over: a chunk of output, or the child finishing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingEvent {
    Data(String),
    Exit(PtyExitEvent),
}

/// What a walker step publishes. `Output` carries the raw chunk the client receives and the
/// visible text that may or may not reach history; `Exit` ends the walk, as the shipped `return`
/// after the exit publish does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery {
    Output {
        sequence: u64,
        data: String,
        visible: String,
        /// Whether the visible text was long enough to be appended to history. The ring buffer
        /// itself is `lmcs-terminal-history`'s; this only says the shipped gate opened.
        history_grew: bool,
    },
    Exit {
        sequence: u64,
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
    },
}

/// The parts of a terminal session the read side reads and writes.
///
/// `running` is `session.status === "running"` and `process` is `session.process != null`: the
/// shipped guard tests both, and they are separate fields because the shipped code writes them at
/// different moments. That gap is not cosmetic — data delivered between the subscription and the
/// write is dropped by the guard (measured as `dataDuringSetup` and `exitDuringSetup`).
#[derive(Clone, Debug)]
pub struct Pipe {
    process: bool,
    running: bool,
    pid: Option<u32>,
    sequence: u64,
    queue: Vec<PendingEvent>,
    cursor: usize,
    draining: bool,
    /// A control sequence that ran off the end of a chunk. Kept here because the shipped drain
    /// keeps it on the session and clears it at exit.
    pending_control_sequence: String,
    history_appends: usize,
}

impl Pipe {
    /// A session with no process yet: the state before a spawn, where every delivery is dropped.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            process: false,
            running: false,
            pid: None,
            sequence: 0,
            queue: Vec::new(),
            cursor: 0,
            draining: false,
            pending_control_sequence: String::new(),
            history_appends: 0,
        }
    }

    /// `startProcess`: the process exists, it is running, and the `started`/`restarted` event
    /// takes the next sequence. Also the walk-reset: the shipped code clears the queue and the
    /// walker flag before spawning, so a previous process cannot leave work behind.
    #[must_use]
    pub fn start(&mut self, pid: u32) -> u64 {
        self.process = true;
        self.running = true;
        self.pid = Some(pid);
        self.queue.clear();
        self.cursor = 0;
        self.draining = false;
        self.pending_control_sequence.clear();
        self.advance()
    }

    /// `stopProcess` without an event of its own: used by restart and by the kill path.
    pub fn stop(&mut self) {
        self.process = false;
        self.running = false;
        self.pid = None;
        self.queue.clear();
        self.cursor = 0;
        self.draining = false;
        self.pending_control_sequence.clear();
    }

    /// `closeSession`, which stops the process and publishes `closed` with its own sequence.
    #[must_use]
    pub fn close(&mut self) -> u64 {
        self.stop();
        self.advance()
    }

    /// Whether a callback still has a session to deliver to. Three separate fields, three
    /// separate reasons to be false, and the shipped check is the conjunction of all of them.
    #[must_use]
    pub fn accepts(&self, from_pid: u32) -> bool {
        self.process && self.running && self.pid == Some(from_pid)
    }

    /// `enqueueProcessEvent`. `true` means "you own the walk"; `false` means either the event was
    /// dropped or it is queued behind a walk already running, and the shipped caller returns
    /// without forking a second walker in both cases.
    pub fn enqueue(&mut self, from_pid: u32, event: PendingEvent) -> bool {
        if !self.accepts(from_pid) {
            return false;
        }
        self.queue.push(event);
        if self.draining {
            return false;
        }
        self.draining = true;
        true
    }

    /// One iteration of `drainProcessEvents`: take the event at the cursor, advance the sequence,
    /// and return what gets published. `None` is the shipped `idle` — including the case where the
    /// session went stale while a publication was awaited, which also clears the queue.
    pub fn drain_next(
        &mut self,
        from_pid: u32,
        sanitize: impl FnOnce(&str, &str) -> Sanitized,
    ) -> Option<Delivery> {
        if !self.accepts(from_pid) {
            self.queue.clear();
            self.cursor = 0;
            self.draining = false;
            return None;
        }

        let event = self.queue.get(self.cursor).cloned();
        let Some(event) = event else {
            self.queue.clear();
            self.cursor = 0;
            self.draining = false;
            return None;
        };

        // The cursor, not a `remove(0)`: the shipped walker leaves consumed events in place and
        // drops the array only once the cursor passes the end. Deliveries that arrive during the
        // publication the caller is about to await append behind the cursor either way.
        self.cursor += 1;
        if self.cursor >= self.queue.len() {
            self.queue.clear();
            self.cursor = 0;
        }

        match event {
            PendingEvent::Data(data) => {
                let sanitized = sanitize(&self.pending_control_sequence, &data);
                self.pending_control_sequence = sanitized.pending;
                let history_grew = !sanitized.visible.is_empty();
                if history_grew {
                    self.history_appends += 1;
                }
                Some(Delivery::Output {
                    sequence: self.advance(),
                    data,
                    visible: sanitized.visible,
                    history_grew,
                })
            }
            PendingEvent::Exit(event) => {
                // Teardown comes first, and it is why no delivery after an exit is ever seen: the
                // subscriptions are disposed, the pid is gone, and the status is no longer
                // running. Measured as `exitThenLateData`, where the subscription is still live.
                self.process = false;
                self.running = false;
                self.pid = None;
                self.pending_control_sequence.clear();
                self.queue.clear();
                self.cursor = 0;
                self.draining = false;
                Some(Delivery::Exit {
                    sequence: self.advance(),
                    // `Number.isInteger` on both fields. The port cannot receive a non-integer
                    // through `PtyExitEvent`, so the code gate is always satisfied and the signal
                    // gate is exactly "was one reported": a `0` signal survives as `Some(0)` and
                    // only a genuinely absent signal publishes `null`.
                    exit_code: Some(event.exit_code),
                    exit_signal: event.signal,
                })
            }
        }
    }

    /// The last assigned sequence; its publication may still be suspended.
    #[must_use]
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// How many chunks reached history. The shipped `if (sanitized.visibleText.length > 0)` gate,
    /// which is what makes an empty or all-control chunk publish without growing the buffer.
    #[must_use]
    pub fn history_appends(&self) -> usize {
        self.history_appends
    }

    /// Events still waiting. Observational: the golden reads it to say a walk did not stall.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.queue.len().saturating_sub(self.cursor)
    }

    /// `advanceEventSequence`: the stamp is taken when the event is dequeued, not when it is
    /// delivered, which is why a publication suspended across a `close` keeps the lower sequence.
    fn advance(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }
}

impl Default for Pipe {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(text: &str) -> PendingEvent {
        PendingEvent::Data(text.to_string())
    }

    /// The identity sanitizer: every byte is visible, which is all the transport tests need.
    fn plain(_: &str, text: &str) -> Sanitized {
        Sanitized {
            visible: text.to_string(),
            pending: String::new(),
        }
    }

    fn escapes(pending: &str, text: &str) -> Sanitized {
        match (pending, text) {
            ("", "\x1b[3") => Sanitized {
                visible: String::new(),
                pending: text.to_string(),
            },
            ("\x1b[3", "1mX") => Sanitized {
                visible: "X".to_string(),
                pending: String::new(),
            },
            other => panic!("unexpected sanitizer input: {other:?}"),
        }
    }

    #[test]
    fn nothing_is_accepted_before_the_process_is_running() {
        let mut pipe = Pipe::new();
        // `dataDuringSetup`: the subscription exists, the session fields do not.
        assert!(!pipe.enqueue(1, data("early")));
        assert_eq!(pipe.start(1), 1);
        assert!(pipe.accepts(1));
        assert!(
            !pipe.accepts(2),
            "a delivery from another process is not this one"
        );
    }

    #[test]
    fn only_the_first_delivery_of_a_burst_starts_a_walk() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        assert!(pipe.enqueue(7, data("a")));
        assert!(!pipe.enqueue(7, data("b")), "a walk is already running");
        assert!(!pipe.enqueue(7, data("c")));
        assert_eq!(pipe.queued(), 3);
    }

    #[test]
    fn a_walk_empties_the_queue_in_order_and_then_reports_idle() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        for chunk in ["a", "b", "c"] {
            pipe.enqueue(7, data(chunk));
        }
        let sequences: Vec<u64> = std::iter::from_fn(|| pipe.drain_next(7, plain))
            .map(|delivery| match delivery {
                Delivery::Output { sequence, .. } => sequence,
                Delivery::Exit { sequence, .. } => sequence,
            })
            .collect();
        // `started` took 1, so the three chunks are 2, 3, 4 — one sequence each, none skipped.
        assert_eq!(sequences, vec![2, 3, 4]);
        assert!(pipe.drain_next(7, plain).is_none());
        assert_eq!(pipe.queued(), 0);
    }

    #[test]
    fn a_stale_walk_clears_what_was_queued_and_publishes_nothing() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        pipe.enqueue(7, data("a"));
        pipe.enqueue(7, data("b"));
        pipe.stop();
        assert!(pipe.drain_next(7, plain).is_none());
        assert_eq!(
            pipe.queued(),
            0,
            "the queue is dropped, not left for the next session"
        );
    }

    #[test]
    fn an_exit_follows_prior_output_and_discards_later_events() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        pipe.enqueue(7, data("held"));
        pipe.enqueue(7, data("queued"));
        pipe.enqueue(
            7,
            PendingEvent::Exit(PtyExitEvent {
                exit_code: 3,
                signal: Some(0),
            }),
        );
        pipe.enqueue(7, data("queued-after-exit"));
        let kinds: Vec<&str> = std::iter::from_fn(|| pipe.drain_next(7, plain))
            .map(|delivery| match delivery {
                Delivery::Output { .. } => "output",
                Delivery::Exit { .. } => "exit",
            })
            .collect();
        assert_eq!(kinds, vec!["output", "output", "exit"]);
        assert!(
            !pipe.enqueue(7, data("late-after-exit")),
            "the exit disposed the session, so nothing after it is delivered"
        );
    }

    #[test]
    fn a_zero_signal_is_a_signal_and_an_absent_one_is_not() {
        let cases = [
            (
                PtyExitEvent {
                    exit_code: 0,
                    signal: Some(0),
                },
                Some(0),
                Some(0),
            ),
            (
                PtyExitEvent {
                    exit_code: 0,
                    signal: Some(9),
                },
                Some(0),
                Some(9),
            ),
            (
                PtyExitEvent {
                    exit_code: 0,
                    signal: None,
                },
                Some(0),
                None,
            ),
        ];
        for (event, code, signal) in cases {
            let mut pipe = Pipe::new();
            let _ = pipe.start(7);
            assert!(pipe.enqueue(7, PendingEvent::Exit(event)));
            match pipe.drain_next(7, plain) {
                Some(Delivery::Exit {
                    exit_code,
                    exit_signal,
                    ..
                }) => assert_eq!((exit_code, exit_signal), (code, signal)),
                other => panic!("expected the exit, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_empty_chunk_is_delivered_without_touching_history() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        pipe.enqueue(7, data(""));
        match pipe.drain_next(7, plain) {
            Some(Delivery::Output {
                sequence,
                data,
                visible,
                history_grew,
            }) => {
                assert_eq!(
                    sequence, 2,
                    "the sequence advances for a chunk with nothing in it"
                );
                assert_eq!(data, "");
                assert_eq!(visible, "");
                assert!(!history_grew);
            }
            other => panic!("expected the output, got {other:?}"),
        }
        assert_eq!(pipe.history_appends(), 0);
    }

    #[test]
    fn sanitizer_carry_does_not_change_raw_deliveries() {
        let mut pipe = Pipe::new();
        let _ = pipe.start(7);
        pipe.enqueue(7, data("\x1b[3"));
        pipe.enqueue(7, data("1mX"));
        assert_eq!(
            pipe.drain_next(7, escapes),
            Some(Delivery::Output {
                sequence: 2,
                data: "\x1b[3".to_string(),
                visible: String::new(),
                history_grew: false,
            })
        );
        assert_eq!(
            pipe.drain_next(7, escapes),
            Some(Delivery::Output {
                sequence: 3,
                data: "1mX".to_string(),
                visible: "X".to_string(),
                history_grew: true,
            })
        );
        assert_eq!(pipe.history_appends(), 1);
    }

    #[test]
    fn exit_stop_and_start_each_clear_sanitizer_carry() {
        for transition in ["exit", "stop", "start"] {
            let mut pipe = Pipe::new();
            let _ = pipe.start(7);
            pipe.enqueue(7, data("\x1b[3"));
            assert!(pipe.drain_next(7, escapes).is_some());
            assert_eq!(pipe.pending_control_sequence, "\x1b[3");
            match transition {
                "exit" => {
                    pipe.enqueue(
                        7,
                        PendingEvent::Exit(PtyExitEvent {
                            exit_code: 0,
                            signal: None,
                        }),
                    );
                    assert!(matches!(
                        pipe.drain_next(7, escapes),
                        Some(Delivery::Exit { .. })
                    ));
                }
                "stop" => pipe.stop(),
                "start" => {
                    let _ = pipe.start(8);
                }
                _ => unreachable!(),
            }
            assert!(pipe.pending_control_sequence.is_empty(), "{transition}");
        }
    }

    #[test]
    fn a_dequeued_output_keeps_the_walk_until_idle() {
        let mut pipe = Pipe::new();
        assert_eq!(pipe.start(7), 1);
        assert!(pipe.enqueue(7, data("held")));
        assert!(pipe.drain_next(7, plain).is_some());
        assert_eq!(pipe.sequence(), 2);
        assert!(!pipe.enqueue(7, data("during-publish")));
        assert_eq!(
            pipe.drain_next(7, plain),
            Some(Delivery::Output {
                sequence: 3,
                data: "during-publish".to_string(),
                visible: "during-publish".to_string(),
                history_grew: true,
            })
        );
        assert!(pipe.drain_next(7, plain).is_none());
        assert!(pipe.enqueue(7, data("after-idle")));
    }

    #[test]
    fn an_old_walker_clears_the_new_process_queue_like_the_shipped_manager() {
        let mut pipe = Pipe::new();
        assert_eq!(pipe.start(7), 1);
        pipe.enqueue(7, data("held"));
        let held = pipe.drain_next(7, plain).unwrap();
        assert_eq!(pipe.start(8), 3);
        assert!(pipe.enqueue(8, data("new-but-queued")));
        assert_eq!(pipe.queued(), 1);
        // Manager.ts clears the shared queue even when expectedPid belongs to the old process.
        assert!(pipe.drain_next(7, plain).is_none());
        assert_eq!(pipe.queued(), 0);
        assert!(pipe.drain_next(8, plain).is_none());
        assert!(matches!(held, Delivery::Output { sequence: 2, .. }));
        assert!(pipe.enqueue(8, data("after-stale-drain")));
    }
}
