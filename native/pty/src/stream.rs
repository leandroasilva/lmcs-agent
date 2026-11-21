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
    Remove { thread_id: String, terminal_id: String },
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
    read(&publication.thread_id, &publication.terminal_id).map(|terminal| MetadataFrame::Upsert {
        terminal,
    })
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
