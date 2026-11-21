//! Which client hears which frame, and when it hears the same frame twice.
//!
//! Ported from the websocket fan-out of `apps/server/src/terminal/Manager.ts`: `publishEvent`
//! (Manager.ts:1535), `subscribe` (:2722), `attachStream` (:2730), `metadataEventFromTerminalEvent`
//! (:2787), `offerMetadataEvent` (:2817), `subscribeMetadata` (:2825) and the three helpers they
//! call — `shouldPublishTerminalMetadataEvent` (:389), `terminalEventToAttachEvent` (:404) and
//! `isDuplicateAttachSnapshotEvent` (:422). The transitions themselves belong to [`crate::lifecycle`];
//! this module is only what a client ends up seeing of them.
//!
//! Nothing here writes to a socket, and that is the point. The shipped fan-out hands every listener
//! an Effect and swallows a listener's failure (`Effect.ignoreCause({ log: true })`, Manager.ts:1538),
//! so one disconnected client can neither stop the other clients nor the publisher. Keeping frames as
//! values moves that property out of the writer and into the shape of the layer: a caller that fails
//! to send one subscriber's frames has still produced the list for every other one.
//!
//! Measured against the shipped code, not re-read from it: see `apps/server/scripts/terminal-stream-trace.ts`
//! and `tests/stream_golden.rs`.

use crate::lifecycle::{Event, Metadata};

/// The eight `TerminalEvent` kinds the Manager publishes (`contracts/terminal.ts:210`).
///
/// `Output` is here even though [`crate::lifecycle`] does not publish it: the drain owns output events,
/// and both fan-out rules have an opinion about them — the attach stream forwards them, the metadata
/// stream drops them. `Activity` is here because the subprocess poll publishes it (Manager.ts:2425);
/// that poll is not ported yet, so this port has no producer for the kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Started,
    Output,
    Exited,
    Closed,
    Error,
    Cleared,
    Restarted,
    Activity,
}

impl Kind {
    /// The `type` text the client switches on.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Output => "output",
            Self::Exited => "exited",
            Self::Closed => "closed",
            Self::Error => "error",
            Self::Cleared => "cleared",
            Self::Restarted => "restarted",
            Self::Activity => "activity",
        }
    }

    /// `shouldPublishTerminalMetadataEvent` (Manager.ts:389). A terminal that only produced text, or
    /// that dropped its history, has not changed the row a client renders, so the metadata stream
    /// stays quiet for it — the sessions list is rewritten by the six kinds that can.
    #[must_use]
    pub const fn publishes_metadata(self) -> bool {
        !matches!(self, Self::Output | Self::Cleared)
    }

    /// The kind of a lifecycle transition.
    #[must_use]
    pub const fn from_event(event: &Event) -> Self {
        match event {
            Event::Started { .. } => Self::Started,
            Event::Exited { .. } => Self::Exited,
            Event::Error { .. } => Self::Error,
            Event::Cleared { .. } => Self::Cleared,
            Event::Restarted { .. } => Self::Restarted,
            Event::Closed { .. } => Self::Closed,
        }
    }
}

/// The fields of `TerminalSessionSnapshot` (contracts/terminal.ts:100) that any fan-out rule reads.
///
/// The rest of a snapshot — `cwd`, `worktreePath`, `history`, `label` — rides to the client and no
/// rule in this module looks at it, so building those fields stays with whoever holds the session.
/// The two id fields are here because the dedup rule compares them, and the shipped producer builds
/// them from the same session as the event's own ids (Manager.ts:2251, `snapshot(session)` beside
/// `threadId: session.threadId`), so they always agree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub thread_id: String,
    pub terminal_id: String,
    pub updated_at: String,
    /// `sequence` is optional on the wire (`Schema.optional`), and the dedup rule branches on that
    /// absence rather than defaulting it. Every shipped producer fills it from
    /// `advanceEventSequence`/the drain, so the absent case only arrives with an event built elsewhere.
    pub sequence: Option<u64>,
}

/// One published event as the fan-out sees it.
///
/// The payloads the rules ignore (`output`'s text, `exited`'s code, `activity`'s label) stay on the
/// event the caller published; a frame carries this view because the ordering rules need only the
/// kind, the two ids, the sequence and — for a `started` with no sequence — the snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub kind: Kind,
    pub thread_id: String,
    pub terminal_id: String,
    pub sequence: Option<u64>,
    /// The snapshot a `started` or `restarted` event carries. Only a `started` one is ever read, and
    /// only when the event has no sequence.
    pub snapshot: Option<Snapshot>,
}

impl Publication {
    #[must_use]
    pub fn new(kind: Kind, thread_id: &str, terminal_id: &str, sequence: Option<u64>) -> Self {
        Self {
            kind,
            thread_id: thread_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            sequence,
            snapshot: None,
        }
    }

    /// A lifecycle transition, seen by a client. The caller attaches the snapshot with
    /// [`Self::with_snapshot`] when it has one, which is exactly when the shipped event carries it.
    #[must_use]
    pub fn from_event(thread_id: &str, event: &Event) -> Self {
        Self::new(
            Kind::from_event(event),
            thread_id,
            event.terminal_id(),
            Some(event.sequence()),
        )
    }

    #[must_use]
    pub fn with_snapshot(mut self, snapshot: Snapshot) -> Self {
        self.snapshot = Some(snapshot);
        self
    }
}

/// `isDuplicateAttachSnapshotEvent` (Manager.ts:422): whether the initial snapshot an attach stream
/// delivers already covers an event that arrived while the stream was setting up.
///
/// Both sequences present — the shipped case — compares them, so anything at or before the snapshot
/// the client is about to receive is dropped. Otherwise the rule falls back to the event's own
/// snapshot, and it can only do that for a `started`: the shipped ternary's false branch reads
/// `event.snapshot` after checking `event.type === "started"`, so an event without a sequence and
/// without a snapshot is simply not a duplicate.
///
/// The stamp comparison is JavaScript's `<=` on strings, i.e. UTF-16 code-unit order. For text a
/// session can hold this agrees with the ordinal order used here: UTF-8 byte order and UTF-16
/// code-unit order rank well-formed strings alike, and the lone surrogates they disagree on cannot
/// appear in a Rust `String`.
#[must_use]
pub fn is_duplicate(publication: &Publication, initial: &Snapshot) -> bool {
    if let (Some(sequence), Some(observed)) = (publication.sequence, initial.sequence) {
        return sequence <= observed;
    }
    publication.kind == Kind::Started
        && publication.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.thread_id == initial.thread_id
                && snapshot.terminal_id == initial.terminal_id
                && snapshot.updated_at <= initial.updated_at
        })
}

/// What the attach stream hands one client, from `TerminalAttachStreamEvent` (contracts/terminal.ts:227).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachFrame {
    /// The `snapshot` frame: the initial one the stream delivers first, and every `started` event
    /// turned into one (`terminalEventToAttachEvent`, Manager.ts:404).
    Snapshot { snapshot: Snapshot },
    /// One of the seven kinds the shipped function passes through unchanged.
    Event(Publication),
}

impl AttachFrame {
    /// The `type` text the client switches on.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Snapshot { .. } => "snapshot",
            Self::Event(publication) => publication.kind.as_str(),
        }
    }
}

/// `terminalEventToAttachEvent` (Manager.ts:404). A `started` never reaches a client as `started`: it
/// becomes a `snapshot` frame carrying the event's own snapshot. The other seven kinds go through.
#[must_use]
pub fn attach_frame(publication: &Publication) -> AttachFrame {
    if publication.kind == Kind::Started {
        // A started event with no snapshot cannot come from a ported producer: the contract makes the
        // field required (contracts/terminal.ts:163) and the shipped manager fills it from the session
        // it just stamped. It is answered instead of panicked on, with the event's own identifiers and
        // no stamp, so a caller that forgot to attach one delivers a frame the client reads as fresh
        // rather than losing the transition.
        return AttachFrame::Snapshot {
            snapshot: match &publication.snapshot {
                Some(snapshot) => snapshot.clone(),
                None => Snapshot {
                    thread_id: publication.thread_id.clone(),
                    terminal_id: publication.terminal_id.clone(),
                    updated_at: String::new(),
                    sequence: publication.sequence,
                },
            },
        };
    }
    AttachFrame::Event(publication.clone())
}

/// One client's attach stream: the events it filters out, the ones it holds until the initial
/// snapshot lands, and the duplicate rule that decides which of them survive.
#[derive(Debug)]
pub struct AttachStream {
    thread_id: String,
    terminal_id: String,
    buffered: Vec<Publication>,
    live: bool,
}

impl AttachStream {
    /// The subscription `attachStream` opens (Manager.ts:2737), before the terminal is looked up.
    #[must_use]
    pub fn new(thread_id: &str, terminal_id: &str) -> Self {
        Self {
            thread_id: thread_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            buffered: Vec::new(),
            live: false,
        }
    }

    /// Whether the stream has delivered its initial snapshot and stopped buffering.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.live
    }

    /// The filter the shipped listener runs first, and runs before the buffering decision: an event of
    /// another terminal is dropped outright, so an attach never replays a neighbour's history.
    #[must_use]
    pub fn matches(&self, publication: &Publication) -> bool {
        publication.thread_id == self.thread_id && publication.terminal_id == self.terminal_id
    }

    /// One event as the live listener sees it. Before the initial snapshot lands it is held instead,
    /// and nothing is delivered — the window in which `openOrAttachForStream` can publish the very
    /// `started` the snapshot is about to describe.
    pub fn offer(&mut self, publication: &Publication) -> Option<AttachFrame> {
        if !self.matches(publication) {
            return None;
        }
        if !self.live {
            self.buffered.push(publication.clone());
            return None;
        }
        Some(attach_frame(publication))
    }

    /// `openOrAttachForStream` returned `initial`: the snapshot frame first, then the held events in
    /// arrival order minus the duplicates, then live delivery from here on (Manager.ts:2751-2769).
    pub fn opened(&mut self, initial: &Snapshot) -> Vec<AttachFrame> {
        let mut frames = vec![AttachFrame::Snapshot {
            snapshot: initial.clone(),
        }];
        for publication in std::mem::take(&mut self.buffered) {
            if is_duplicate(&publication, initial) {
                continue;
            }
            frames.push(attach_frame(&publication));
        }
        self.live = true;
        frames
    }
}

/// What the metadata stream hands one client, from `TerminalMetadataStreamEvent`
/// (contracts/terminal.ts:149).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MetadataFrame {
    /// The whole sessions view, in the order the Manager sorted it.
    Snapshot { terminals: Vec<Metadata> },
    /// One row, read from the table when the frame is built rather than copied from the event.
    Upsert { terminal: Metadata },
    /// A terminal that left the table.
    Remove {
        thread_id: String,
        terminal_id: String,
    },
}

impl MetadataFrame {
    /// The `type` text the client switches on.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Snapshot { .. } => "snapshot",
            Self::Upsert { .. } => "upsert",
            Self::Remove { .. } => "remove",
        }
    }
}

/// `metadataEventFromTerminalEvent` (Manager.ts:2787), with the read it performs left to the caller.
///
/// The rule that matters is *when* the read happens: the shipped listener calls
/// `readTerminalMetadata` as it handles the event, so a replayed event describes the table as it is
/// now, not as it was when the event was published. Two events that arrived during the setup window
/// therefore produce two identical upserts, and a terminal retention dropped between the event and its
/// replay produces no frame at all.
#[must_use]
pub fn metadata_frame(
    publication: &Publication,
    read: &mut dyn FnMut(&str, &str) -> Option<Metadata>,
) -> Option<MetadataFrame> {
    if !publication.kind.publishes_metadata() {
        return None;
    }
    if publication.kind == Kind::Closed {
        return Some(MetadataFrame::Remove {
            thread_id: publication.thread_id.clone(),
            terminal_id: publication.terminal_id.clone(),
        });
    }
    read(&publication.thread_id, &publication.terminal_id)
        .map(|terminal| MetadataFrame::Upsert { terminal })
}

/// One client's metadata stream: every event of every terminal, held until the sessions view lands.
#[derive(Debug)]
pub struct MetadataStream {
    buffered: Vec<Publication>,
    live: bool,
}

impl Default for MetadataStream {
    fn default() -> Self {
        Self::new()
    }
}

impl MetadataStream {
    #[must_use]
    pub fn new() -> Self {
        Self {
            buffered: Vec::new(),
            live: false,
        }
    }

    #[must_use]
    pub fn is_live(&self) -> bool {
        self.live
    }

    /// `offerMetadataEvent` as the live listener runs it (`subscribeMetadata`, Manager.ts:2832).
    /// Nothing is delivered before [`Self::opened`]; the event is held instead.
    pub fn offer(
        &mut self,
        publication: &Publication,
        read: &mut dyn FnMut(&str, &str) -> Option<Metadata>,
    ) -> Vec<MetadataFrame> {
        if !self.live {
            self.buffered.push(publication.clone());
            return Vec::new();
        }
        metadata_frame(publication, read).into_iter().collect()
    }

    /// The view is delivered before the held events, which are then offered in arrival order and read
    /// against the table as it stands now (Manager.ts:2841-2849).
    pub fn opened(
        &mut self,
        terminals: Vec<Metadata>,
        read: &mut dyn FnMut(&str, &str) -> Option<Metadata>,
    ) -> Vec<MetadataFrame> {
        let mut frames = vec![MetadataFrame::Snapshot { terminals }];
        for publication in std::mem::take(&mut self.buffered) {
            frames.extend(metadata_frame(&publication, read));
        }
        self.live = true;
        frames
    }
}

/// A frame the fan-out decided one subscriber should get.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Attach(AttachFrame),
    Metadata(MetadataFrame),
}

impl Frame {
    /// The `type` text of the wire frame, whichever stream it came from.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Attach(frame) => frame.kind(),
            Self::Metadata(frame) => frame.kind(),
        }
    }
}

/// Which subscriber a frame is for.
pub type Subscriber = usize;

/// The listener registry: `terminalEventListeners` (Manager.ts:1531) with one stream's state per
/// entry.
///
/// Two rules the shipped code gives and this type keeps: a subscriber is added before its terminal is
/// looked up, so events published by that lookup are buffered rather than lost or delivered twice;
/// and delivery walks the registry in subscription order, which is what makes two clients of the same
/// terminal see the same interleaving.
#[derive(Debug, Default)]
pub struct Fanout {
    subscribers: Vec<Option<SubscriberState>>,
    len: usize,
}

#[derive(Debug)]
enum SubscriberState {
    Attach(AttachStream),
    Metadata(MetadataStream),
}

impl Fanout {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many subscribers are registered. A removed one leaves a hole rather than renumbering the
    /// others, so a caller holding a stale id cannot deliver to someone else's stream.
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// `subscribe` for one terminal: returns the id `attachStream`'s caller unsubscribes with.
    pub fn attach(&mut self, thread_id: &str, terminal_id: &str) -> Subscriber {
        self.insert(SubscriberState::Attach(AttachStream::new(
            thread_id,
            terminal_id,
        )))
    }

    /// `subscribe` for the whole sessions list.
    pub fn metadata(&mut self) -> Subscriber {
        self.insert(SubscriberState::Metadata(MetadataStream::new()))
    }

    fn insert(&mut self, state: SubscriberState) -> Subscriber {
        self.subscribers.push(Some(state));
        self.len += 1;
        self.subscribers.len() - 1
    }

    /// The remove function `subscribe` returns (Manager.ts:2725). Delivering to a removed id does
    /// nothing, so a late websocket close cannot disturb a new subscriber.
    pub fn unsubscribe(&mut self, subscriber: Subscriber) -> bool {
        let taken = self
            .subscribers
            .get_mut(subscriber)
            .is_some_and(|slot| slot.take().is_some());
        if taken {
            self.len -= 1;
        }
        taken
    }

    #[must_use]
    pub fn is_live(&self, subscriber: Subscriber) -> bool {
        match self.subscribers.get(subscriber).and_then(Option::as_ref) {
            Some(SubscriberState::Attach(stream)) => stream.is_live(),
            Some(SubscriberState::Metadata(stream)) => stream.is_live(),
            None => false,
        }
    }

    /// `publishEvent`: walk the registry in subscription order and say what each subscriber should
    /// receive. A live subscriber's frames come back; one still setting up holds the event instead,
    /// which is how the shipped listener keeps the events its own lookup publishes. An event of
    /// another terminal is not even held for an attach subscriber, because Manager.ts:2738 runs the
    /// filter before the buffering decision.
    pub fn publish(
        &mut self,
        publication: &Publication,
        read: &mut dyn FnMut(&str, &str) -> Option<Metadata>,
    ) -> Vec<(Subscriber, Frame)> {
        let mut delivered = Vec::new();
        for (subscriber, state) in self.subscribers.iter_mut().enumerate() {
            match state {
                Some(SubscriberState::Attach(stream)) => {
                    if let Some(frame) = stream.offer(publication) {
                        delivered.push((subscriber, Frame::Attach(frame)));
                    }
                }
                Some(SubscriberState::Metadata(stream)) => {
                    for frame in stream.offer(publication, read) {
                        delivered.push((subscriber, Frame::Metadata(frame)));
                    }
                }
                None => {}
            }
        }
        delivered
    }

    /// The attach stream's initial frame: `openOrAttachForStream` answered, so deliver the snapshot,
    /// replay what was held, and go live.
    pub fn opened_attach(
        &mut self,
        subscriber: Subscriber,
        initial: &Snapshot,
    ) -> Option<Vec<Frame>> {
        let state = self.subscribers.get_mut(subscriber)?.as_mut()?;
        let SubscriberState::Attach(stream) = state else {
            return None;
        };
        Some(
            stream
                .opened(initial)
                .into_iter()
                .map(Frame::Attach)
                .collect(),
        )
    }

    /// The metadata stream's initial frame: the whole view, then the held events read against the
    /// table now.
    pub fn opened_metadata(
        &mut self,
        subscriber: Subscriber,
        terminals: Vec<Metadata>,
        read: &mut dyn FnMut(&str, &str) -> Option<Metadata>,
    ) -> Option<Vec<Frame>> {
        let state = self.subscribers.get_mut(subscriber)?.as_mut()?;
        let SubscriberState::Metadata(stream) = state else {
            return None;
        };
        Some(
            stream
                .opened(terminals, read)
                .into_iter()
                .map(Frame::Metadata)
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Status;

    fn event(kind: Kind, thread: &str, terminal: &str, sequence: u64) -> Publication {
        Publication::new(kind, thread, terminal, Some(sequence))
    }

    fn started(thread: &str, terminal: &str, sequence: Option<u64>, stamp: &str) -> Publication {
        Publication::new(Kind::Started, thread, terminal, sequence).with_snapshot(Snapshot {
            thread_id: thread.to_owned(),
            terminal_id: terminal.to_owned(),
            updated_at: stamp.to_owned(),
            sequence,
        })
    }

    fn snap(thread: &str, terminal: &str, sequence: Option<u64>, stamp: &str) -> Snapshot {
        Snapshot {
            thread_id: thread.to_owned(),
            terminal_id: terminal.to_owned(),
            updated_at: stamp.to_owned(),
            sequence,
        }
    }

    fn row(thread: &str, terminal: &str, status: Status, stamp: &str) -> Metadata {
        Metadata {
            thread_id: thread.to_owned(),
            terminal_id: terminal.to_owned(),
            status,
            pid: (status == Status::Running).then_some(7400),
            exit_code: None,
            exit_signal: None,
            updated_at: stamp.to_owned(),
        }
    }

    /// The table the metadata stream reads, as a plain list of rows: the stream's rules are about
    /// *when* a read happens, not about what a session table holds.
    fn reader(rows: Vec<Metadata>) -> impl FnMut(&str, &str) -> Option<Metadata> {
        move |thread: &str, terminal: &str| {
            rows.iter()
                .find(|entry| entry.thread_id == thread && entry.terminal_id == terminal)
                .cloned()
        }
    }

    fn attach_kinds(frames: &[AttachFrame]) -> Vec<&'static str> {
        frames.iter().map(AttachFrame::kind).collect()
    }

    fn metadata_kinds(frames: &[MetadataFrame]) -> Vec<&'static str> {
        frames.iter().map(MetadataFrame::kind).collect()
    }

    fn delivered_kinds(frames: &[(Subscriber, Frame)]) -> Vec<&'static str> {
        frames.iter().map(|(_, frame)| frame.kind()).collect()
    }

    fn delivered_ids(frames: &[(Subscriber, Frame)]) -> Vec<Subscriber> {
        frames.iter().map(|(subscriber, _)| *subscriber).collect()
    }

    #[test]
    fn only_text_and_cleared_history_leave_the_sessions_list_alone() {
        let publishing = [
            Kind::Started,
            Kind::Exited,
            Kind::Closed,
            Kind::Error,
            Kind::Restarted,
            Kind::Activity,
        ];
        for kind in publishing {
            assert!(
                kind.publishes_metadata(),
                "{} changes the row a client renders",
                kind.as_str()
            );
        }
        for kind in [Kind::Output, Kind::Cleared] {
            assert!(
                !kind.publishes_metadata(),
                "{} leaves the sessions list untouched",
                kind.as_str()
            );
        }
        assert_eq!(
            Kind::from_event(&Event::Cleared {
                terminal_id: "term-1".to_owned(),
                sequence: 4,
            }),
            Kind::Cleared
        );
        assert_eq!(
            event(Kind::Restarted, "thread-a", "term-1", 1).thread_id,
            "thread-a",
            "the wire text is what the client switches on"
        );
        assert_eq!(
            [
                Kind::Started,
                Kind::Output,
                Kind::Exited,
                Kind::Closed,
                Kind::Error,
                Kind::Cleared,
                Kind::Restarted,
                Kind::Activity,
            ]
            .map(Kind::as_str),
            [
                "started",
                "output",
                "exited",
                "closed",
                "error",
                "cleared",
                "restarted",
                "activity"
            ]
        );
    }

    #[test]
    fn a_started_arrives_as_a_snapshot_and_the_rest_as_themselves() {
        // `terminalEventToAttachEvent` answers for all eight kinds, so the fan-out never drops one.
        for kind in [
            Kind::Output,
            Kind::Exited,
            Kind::Closed,
            Kind::Error,
            Kind::Cleared,
            Kind::Restarted,
            Kind::Activity,
        ] {
            let publication = event(kind, "thread-a", "term-1", 3);
            let AttachFrame::Event(carried) = attach_frame(&publication) else {
                panic!("{} reaches the client as itself", kind.as_str());
            };
            assert_eq!(carried, publication);
        }
        let publication = started("thread-a", "term-1", Some(3), "t3");
        let AttachFrame::Snapshot { snapshot } = attach_frame(&publication) else {
            panic!("a started is never delivered as started");
        };
        assert_eq!(
            snapshot.updated_at, "t3",
            "the frame carries the event's own snapshot, which is the session as the start stamped it"
        );
        let bare = Publication::new(Kind::Started, "thread-a", "term-1", Some(3));
        let AttachFrame::Snapshot { snapshot } = attach_frame(&bare) else {
            panic!("a started without a snapshot is answered, not dropped");
        };
        assert_eq!(
            (snapshot.thread_id.as_str(), snapshot.terminal_id.as_str()),
            ("thread-a", "term-1"),
            "the event's own identifiers survive; nothing invents a session"
        );
    }

    #[test]
    fn a_frame_at_or_before_the_snapshot_is_dropped() {
        let initial = snap("thread-a", "term-1", Some(5), "t5");
        for sequence in [0, 4, 5] {
            assert!(
                is_duplicate(
                    &event(Kind::Exited, "thread-a", "term-1", sequence),
                    &initial
                ),
                "sequence {sequence} is already in the snapshot the client is about to get"
            );
        }
        assert!(
            !is_duplicate(&event(Kind::Exited, "thread-a", "term-1", 6), &initial),
            "the next sequence is news"
        );
        assert!(
            !is_duplicate(
                &event(Kind::Output, "thread-a", "term-1", 6),
                &snap("thread-a", "term-1", Some(5), "t5")
            ),
            "the rule does not care which kind it is covering, only where it landed"
        );
    }

    #[test]
    fn an_unsequenced_started_is_dropped_only_by_its_own_stamp() {
        let initial = snap("thread-a", "term-1", None, "t5");
        // The shipped ternary's false branch reads a snapshot only off a started event.
        assert!(
            !is_duplicate(
                &Publication::new(Kind::Exited, "thread-a", "term-1", None),
                &initial
            ),
            "an unsequenced event that is not a start is news, whatever the snapshot would have said"
        );
        assert!(
            is_duplicate(&started("thread-a", "term-1", None, "t5"), &initial),
            "same session, same stamp: the snapshot describes it"
        );
        assert!(
            is_duplicate(&started("thread-a", "term-1", None, "t1"), &initial),
            "same session, older stamp: the snapshot is fresher than the event"
        );
        assert!(
            !is_duplicate(&started("thread-a", "term-1", None, "t6"), &initial),
            "a later stamp is news even without a sequence"
        );
        assert!(
            !is_duplicate(&started("thread-a", "term-2", None, "t1"), &initial),
            "another terminal's start is not covered by this snapshot"
        );
        assert!(
            !is_duplicate(&started("thread-b", "term-1", None, "t1"), &initial),
            "another thread's start is not covered either"
        );
        let restarted = Publication::new(Kind::Restarted, "thread-a", "term-1", None)
            .with_snapshot(snap("thread-a", "term-1", None, "t1"));
        assert!(
            !is_duplicate(&restarted, &initial),
            "only a started event's snapshot is read, whatever else carries one"
        );
        assert!(
            !is_duplicate(
                &Publication::new(Kind::Started, "thread-a", "term-1", None),
                &initial
            ),
            "a started with no snapshot at all cannot be shown to describe the session"
        );
    }

    #[test]
    fn an_attach_holds_events_until_its_snapshot_lands() {
        let mut stream = AttachStream::new("thread-a", "term-1");
        assert_eq!(
            stream.offer(&event(Kind::Output, "thread-a", "term-1", 1)),
            None,
            "nothing is delivered before the initial snapshot"
        );
        assert_eq!(
            stream.offer(&event(Kind::Exited, "thread-a", "term-1", 2)),
            None
        );
        assert!(!stream.is_live());

        let frames = stream.opened(&snap("thread-a", "term-1", Some(2), "t2"));
        assert_eq!(
            attach_kinds(&frames),
            ["snapshot"],
            "the exited event at sequence 2 is the state the snapshot describes"
        );

        let output = event(Kind::Output, "thread-a", "term-1", 3);
        assert_eq!(
            stream.offer(&output),
            Some(AttachFrame::Event(output.clone())),
            "after the snapshot, an event goes straight out"
        );
        assert!(stream.is_live());

        let later = started("thread-a", "term-1", Some(4), "t4");
        assert_eq!(
            stream.offer(&later),
            Some(AttachFrame::Snapshot {
                snapshot: snap("thread-a", "term-1", Some(4), "t4"),
            }),
            "a terminal that starts again is announced to an already-attached client as a snapshot"
        );
    }

    #[test]
    fn an_attach_buffers_its_own_start_and_keeps_the_rest() {
        let mut stream = AttachStream::new("thread-a", "term-1");
        // What `attachStream` of a closed terminal does: subscribe, then open, which publishes a
        // started the initial snapshot already describes.
        stream.offer(&started("thread-a", "term-1", Some(1), "t1"));
        stream.offer(&event(Kind::Output, "thread-a", "term-1", 2));
        stream.offer(&event(Kind::Exited, "thread-a", "term-1", 3));
        let frames = stream.opened(&snap("thread-a", "term-1", Some(1), "t1"));
        assert_eq!(
            attach_kinds(&frames),
            ["snapshot", "output", "exited"],
            "the start the open caused is dropped and the events after it are replayed in order"
        );
    }

    #[test]
    fn an_attach_never_holds_a_neighbour_s_event() {
        let mut stream = AttachStream::new("thread-a", "term-1");
        let neighbour = event(Kind::Exited, "thread-a", "term-2", 1);
        let other_thread = event(Kind::Exited, "thread-b", "term-1", 1);
        assert_eq!(stream.offer(&neighbour), None);
        assert_eq!(stream.offer(&other_thread), None);
        let frames = stream.opened(&snap("thread-a", "term-1", Some(0), "t0"));
        assert_eq!(
            attach_kinds(&frames),
            ["snapshot"],
            "the filter runs before the buffering decision, so a neighbour's exit is never replayed"
        );
        assert!(
            !stream.matches(&neighbour)
                && stream.matches(&event(Kind::Output, "thread-a", "term-1", 4)),
            "the same predicate the shipped listener returns on"
        );
    }

    #[test]
    fn a_metadata_snapshot_lands_before_events_read_the_table_now() {
        let mut stream = MetadataStream::new();
        let rows = vec![row("thread-a", "term-1", Status::Exited, "t3")];
        let mut read = reader(rows.clone());
        assert!(
            stream
                .offer(&event(Kind::Output, "thread-a", "term-1", 1), &mut read)
                .is_empty(),
            "nothing is delivered before the view"
        );
        // The two events that do belong to the sessions list are held too: delivering one before the
        // view would have the client render a row it has not seen the list of, and delivering it only
        // before the view would lose it, so the hold is what makes the replay below non-empty.
        assert_eq!(
            stream.offer(&event(Kind::Restarted, "thread-a", "term-1", 2), &mut read),
            Vec::new(),
            "a restarted event arriving before the view is held, not delivered and not dropped"
        );
        assert_eq!(
            stream.offer(&event(Kind::Exited, "thread-a", "term-1", 3), &mut read),
            Vec::new()
        );
        assert!(!stream.is_live());

        let frames = stream.opened(rows.clone(), &mut read);
        assert_eq!(
            metadata_kinds(&frames),
            ["snapshot", "upsert", "upsert"],
            "the two metadata events held for one terminal replay as the same row twice, because the read happens now rather than when each event was published — and the held output produced nothing"
        );
        let MetadataFrame::Upsert { terminal } = &frames[1] else {
            panic!("a restarted event is an upsert");
        };
        assert_eq!(
            terminal.updated_at, "t3",
            "the row is the current one, not the one the event described"
        );
        assert!(
            stream
                .offer(&event(Kind::Cleared, "thread-a", "term-1", 4), &mut read)
                .is_empty(),
            "a cleared terminal does not rewrite the list"
        );
        assert!(
            stream
                .offer(&event(Kind::Output, "thread-a", "term-1", 5), &mut read)
                .is_empty(),
            "neither does text"
        );
        assert_eq!(
            metadata_kinds(&stream.offer(&event(Kind::Error, "thread-a", "term-1", 6), &mut read)),
            ["upsert"]
        );
    }

    #[test]
    fn a_closed_terminal_loses_its_row_even_when_the_table_forgot_it() {
        let mut stream = MetadataStream::new();
        let mut read = reader(Vec::new());
        let closed = event(Kind::Closed, "thread-a", "term-1", 3);
        // Live delivery: the shipped rule answers a closed event from the event, not from the table.
        stream.opened(Vec::new(), &mut read);
        assert_eq!(
            stream.offer(&closed, &mut read),
            vec![MetadataFrame::Remove {
                thread_id: "thread-a".to_owned(),
                terminal_id: "term-1".to_owned(),
            }],
            "a remove needs no row, which is why a client still learns about a terminal that left"
        );
        assert_eq!(
            stream.offer(&event(Kind::Exited, "thread-a", "term-1", 4), &mut read),
            Vec::new(),
            "an exited event for a terminal the table no longer has produces nothing"
        );
    }

    #[test]
    fn the_registry_delivers_in_subscription_order() {
        let rows = vec![
            row("thread-a", "term-1", Status::Running, "t2"),
            row("thread-a", "term-2", Status::Running, "t1"),
        ];
        let mut read = reader(rows.clone());
        let mut fanout = Fanout::new();
        let first = fanout.attach("thread-a", "term-1");
        let watcher = fanout.metadata();
        let second = fanout.attach("thread-a", "term-1");
        assert_eq!(fanout.len(), 3);
        // Each client finishes its own lookup: two terminals and the whole list, all live.
        for subscriber in [first, second] {
            fanout.opened_attach(subscriber, &snap("thread-a", "term-1", Some(5), "t2"));
        }
        fanout.opened_metadata(watcher, rows.clone(), &mut read);
        assert!(
            fanout.is_live(first) && fanout.is_live(watcher) && fanout.is_live(second),
            "an attach of one terminal and a sessions watcher share the registry"
        );

        let exited = event(Kind::Exited, "thread-a", "term-1", 6);
        let delivered = fanout.publish(&exited, &mut read);
        assert_eq!(
            delivered_ids(&delivered),
            vec![first, watcher, second],
            "two clients of one terminal and the sessions watcher hear the same event in the order they subscribed"
        );
        assert_eq!(delivered_kinds(&delivered), ["exited", "upsert", "exited"]);

        let neighbour = event(Kind::Exited, "thread-a", "term-2", 7);
        assert_eq!(
            delivered_ids(&fanout.publish(&neighbour, &mut read)),
            vec![watcher],
            "only the sessions watcher hears a terminal it did not attach to"
        );

        // A client whose lookup is still in flight when an event lands: it holds the event and replays
        // it after its own snapshot, which is the window the duplicate rule exists for.
        let late = fanout.attach("thread-a", "term-1");
        assert_eq!(
            delivered_ids(&fanout.publish(&exited, &mut read)),
            vec![first, watcher, second],
            "the setting-up client delivers nothing yet"
        );
        assert_eq!(
            fanout.opened_attach(late, &snap("thread-a", "term-1", Some(5), "t2")),
            Some(vec![
                Frame::Attach(AttachFrame::Snapshot {
                    snapshot: snap("thread-a", "term-1", Some(5), "t2"),
                }),
                Frame::Attach(AttachFrame::Event(exited.clone())),
            ]),
            "the held event is above the snapshot it must not duplicate, so it follows it"
        );
    }

    #[test]
    fn a_detached_subscriber_hears_nothing() {
        let rows = vec![row("thread-a", "term-1", Status::Exited, "t1")];
        let mut read = reader(rows.clone());
        let mut fanout = Fanout::new();
        let attach = fanout.attach("thread-a", "term-1");
        let watcher = fanout.metadata();
        assert!(!fanout.is_live(attach));
        assert!(
            fanout
                .publish(&event(Kind::Exited, "thread-a", "term-1", 0), &mut read)
                .is_empty(),
            "a subscriber that has not delivered its initial frame holds the event instead of losing it"
        );
        assert!(fanout.unsubscribe(attach));
        assert!(
            !fanout.unsubscribe(attach),
            "the remove function is idempotent, so a late websocket close cannot drop a new client"
        );
        assert_eq!(fanout.len(), 1);
        assert!(
            fanout
                .opened_attach(attach, &snap("thread-a", "term-1", Some(0), "t0"))
                .is_none(),
            "an id that is gone gets no initial frame"
        );
        fanout.opened_metadata(watcher, rows, &mut read);
        assert_eq!(
            delivered_ids(
                &fanout.publish(&event(Kind::Exited, "thread-a", "term-1", 1), &mut read)
            ),
            vec![watcher],
            "the remaining subscriber is untouched"
        );
        assert!(fanout.unsubscribe(watcher));
        assert!(fanout.is_empty());
        assert_eq!(
            fanout.publish(&event(Kind::Exited, "thread-a", "term-1", 2), &mut read),
            Vec::new()
        );
    }
}
