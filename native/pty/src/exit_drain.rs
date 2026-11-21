use std::time::{Duration, Instant};

use crate::node_pty::PtyExitEvent;

const DRAIN_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainAction {
    CloseReader,
    PublishExit(PtyExitEvent),
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Reading,
    Closed,
    Draining {
        exit: PtyExitEvent,
        deadline: Instant,
    },
    Closing(PtyExitEvent),
    Finished,
}

/// Coordinates observed child exit with reader closure; it does not observe or reap the child.
#[derive(Debug, Default)]
pub struct ExitDrain {
    state: State,
}

impl ExitDrain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accepts_data(&self) -> bool {
        matches!(self.state, State::Reading | State::Draining { .. })
    }

    pub fn deadline(&self) -> Option<Instant> {
        match self.state {
            State::Draining { deadline, .. } => Some(deadline),
            _ => None,
        }
    }

    pub fn child_exited(&mut self, exit: PtyExitEvent, now: Instant) -> Option<DrainAction> {
        match self.state {
            State::Reading => {
                self.state = State::Draining {
                    exit,
                    deadline: now + DRAIN_TIMEOUT,
                };
                None
            }
            State::Closed => {
                self.state = State::Finished;
                Some(DrainAction::PublishExit(exit))
            }
            _ => None,
        }
    }

    /// Call only after preceding data was consumed and the reader was joined.
    pub fn reader_closed(&mut self) -> Option<DrainAction> {
        match self.state {
            State::Reading => {
                self.state = State::Closed;
                None
            }
            State::Draining { exit, .. } | State::Closing(exit) => {
                self.state = State::Finished;
                Some(DrainAction::PublishExit(exit))
            }
            _ => None,
        }
    }

    /// CloseReader requests cancellation, not EOF: incomplete UTF-8 must not be flushed.
    pub fn expire(&mut self, now: Instant) -> Option<DrainAction> {
        if let State::Draining { exit, deadline } = self.state
            && now >= deadline
        {
            self.state = State::Closing(exit);
            return Some(DrainAction::CloseReader);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_pty::exit_event;

    #[test]
    fn eof_alone_does_not_publish_exit_or_start_a_timer() {
        let mut drain = ExitDrain::new();
        assert!(drain.accepts_data());
        assert_eq!(drain.reader_closed(), None);
        assert!(!drain.accepts_data());
        assert_eq!(drain.deadline(), None);
        assert_eq!(drain.expire(Instant::now()), None);
        let exit = exit_event(7, Some(0));
        assert_eq!(
            drain.child_exited(exit, Instant::now()),
            Some(DrainAction::PublishExit(exit))
        );
        assert_eq!(drain.reader_closed(), None);
    }

    #[test]
    fn output_does_not_extend_the_single_child_exit_deadline() {
        let now = Instant::now();
        let exit = exit_event(0, Some(9));
        let mut drain = ExitDrain::new();
        assert_eq!(drain.child_exited(exit, now), None);
        assert!(drain.accepts_data());
        assert_eq!(drain.deadline(), Some(now + DRAIN_TIMEOUT));
        assert_eq!(drain.expire(now + Duration::from_millis(199)), None);
        assert_eq!(
            drain.expire(now + DRAIN_TIMEOUT),
            Some(DrainAction::CloseReader)
        );
        assert!(!drain.accepts_data());
        assert_eq!(drain.deadline(), None);
        assert_eq!(drain.expire(now + Duration::from_secs(1)), None);
        assert_eq!(drain.reader_closed(), Some(DrainAction::PublishExit(exit)));
        assert_eq!(drain.reader_closed(), None);
        assert_eq!(drain.child_exited(exit, now), None);
    }

    #[test]
    fn natural_close_cancels_the_deadline() {
        let now = Instant::now();
        let exit = exit_event(3, None);
        let mut drain = ExitDrain::new();
        drain.child_exited(exit, now);
        assert_eq!(drain.reader_closed(), Some(DrainAction::PublishExit(exit)));
        assert_eq!(drain.deadline(), None);
        assert_eq!(drain.expire(now + DRAIN_TIMEOUT), None);
        assert!(!drain.accepts_data());
    }

    #[test]
    fn repeated_observation_cannot_change_status_or_restart_the_deadline() {
        let now = Instant::now();
        let exit = exit_event(3, Some(0));
        let mut drain = ExitDrain::new();
        drain.child_exited(exit, now);
        assert_eq!(
            drain.child_exited(exit_event(8, Some(9)), now + Duration::from_millis(199)),
            None
        );
        assert_eq!(drain.deadline(), Some(now + DRAIN_TIMEOUT));
        assert_eq!(drain.reader_closed(), Some(DrainAction::PublishExit(exit)));
    }
}
