//! The terminal wire contracts, ported from `packages/core/src/contracts/terminal.ts`.
//!
//! This is the surface `terminal.*` and `subscribeTerminal*` publish, so it is what the
//! Rust PTY owner has to agree with byte for byte: seven input shapes, two read-model
//! shapes, three stream unions and the ten-member error union.
//!
//! Three things about the source are worth saying out loud because they are not visible in
//! the shapes themselves:
//!
//! - **Two id spellings sit side by side.** The inputs take `TrimmedNonEmptyString`
//!   ([`NonEmpty`]), which trims on the way in and refuses a blank. The snapshots and
//!   stream events the *server* writes take `Schema.String.check(isNonEmpty())`
//!   ([`BareNonEmpty`]), which accepts `"  "` and never trims. Reading the second as the
//!   first is silent: both accept every id the other does, they only disagree on padding
//!   and blanks.
//! - **The stream unions key on `type`, and it is not the first field.**
//!   `TerminalEventBaseSchema.fields` is spread *before* `type`, so a started event crosses
//!   as `{"threadId":…,"terminalId":…,"sequence":…,"type":"started","snapshot":…}`. An
//!   internally tagged Rust enum writes the tag first, so these unions are [`untagged`]
//!   over per-member structs that declare their fields in the source order. The error union
//!   is the opposite case: `Schema.TaggedError` puts `_tag` first by construction, so it
//!   *is* an internally tagged enum.
//! - **`TerminalClearInput` is not a copy of `TerminalSessionInput`, it is that schema**
//!   (`terminal.ts:76`), so the two have identical fields and one Rust type.
//!
//! [`untagged`]: serde::untagged

use crate::base::{
    Absent, AtLeast, BareNonEmpty, BoundedInt, Check, Checked, Defect, GreaterThan, Int, JsNumber,
    LenientKeys, MaxLength, MaxProperties, MinLength, NonEmpty, Nullable, Optional, Record,
    SafeInt,
};
use crate::provider_instance::ProviderInstanceId;
use crate::wire_tag;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// The id of the first shell opened on a thread. Kept so callers that want "the primary
/// shell" do not hardcode the string.
pub const DEFAULT_TERMINAL_ID: &str = "term-1";

/// `TerminalColsSchema`: an integer in `1..=1000`, both bounds included.
pub type TerminalCols = BoundedInt<1, 1000>;

/// `TerminalRowsSchema`: the same bracket with `500` at the top.
pub type TerminalRows = BoundedInt<1, 500>;

/// `TerminalIdSchema` — `TrimmedNonEmptyString.check(isMaxLength(128))`.
pub type TerminalId = Checked<NonEmpty, MaxLength<128>>;

/// `TerminalEnvKeySchema`'s `isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)` — a shell variable name.
/// Unlike the provider slug this is a predicate over a **bare** `Schema.String`, and that is
/// the whole reason [`TerminalEnv`] drops a bad key instead of failing the record.
static ENV_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("valid"));

pub struct EnvKeyPattern;

impl Check<String> for EnvKeyPattern {
    fn passes(value: &String) -> bool {
        ENV_KEY.is_match(value)
    }

    fn describe() -> String {
        "a shell variable name".to_owned()
    }
}

/// `TerminalEnvSchema` (`terminal.ts:21-25`): a refinement-keyed record under
/// `isMaxProperties(128)`, and one of only two [`LenientKeys`] sites in the contracts. A key
/// that fails the pattern or the 128-character cap **drops its entry**; a value that fails
/// still takes the whole field down.
pub type TerminalEnvKey = Checked<String, (EnvKeyPattern, MaxLength<128>)>;
pub type TerminalEnvValue = Checked<String, MaxLength<8_192>>;
pub type TerminalEnv =
    Checked<Record<TerminalEnvKey, TerminalEnvValue, LenientKeys>, MaxProperties<128>>;

/// `TerminalThreadInput`.
///
/// The four shapes below whose fields are all text or booleans are `Eq`; the rest are not,
/// because a `Schema.Int` on the wire is a JSON number and `80` and `8e1` are the same size
/// held in two different `JsNumber`s.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalThreadInput {
    pub thread_id: NonEmpty,
}

/// `TerminalSessionInput`, and `TerminalClearInput` — the source does not copy the struct,
/// it names the same schema twice.
pub type TerminalClearInput = TerminalSessionInput;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
}

/// `TerminalOpenInput`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
    pub cwd: NonEmpty,
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub worktree_path: Optional<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cols: Absent<TerminalCols>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub rows: Absent<TerminalRows>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub env: Absent<TerminalEnv>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_instance_id: Absent<ProviderInstanceId>,
}

/// `TerminalAttachInput` — the open input with every context field optional and one extra
/// flag. Note `cwd` moves from required to `Absent` here rather than changing type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cwd: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub worktree_path: Optional<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cols: Absent<TerminalCols>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub rows: Absent<TerminalRows>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub env: Absent<TerminalEnv>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_instance_id: Absent<ProviderInstanceId>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub restart_if_not_running: Absent<bool>,
}

/// `TerminalWriteInput` — `Schema.String.check(isNonEmpty()).check(isMaxLength(65_536))`,
/// measured in UTF-16 units, so a surrogate pair costs two of the 65 536.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
    pub data: Checked<String, (MinLength<1>, MaxLength<65_536>)>,
}

/// `TerminalResizeInput` — the only size input where both dimensions are required.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
}

/// `TerminalRestartInput` — cwd required, sizes required, env optional.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRestartInput {
    pub thread_id: NonEmpty,
    pub terminal_id: TerminalId,
    pub cwd: NonEmpty,
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub worktree_path: Optional<NonEmpty>,
    pub cols: TerminalCols,
    pub rows: TerminalRows,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub env: Absent<TerminalEnv>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_instance_id: Absent<ProviderInstanceId>,
}

/// `TerminalCloseInput` — the one input where `terminalId` is optional, which is how a
/// client closes every shell on a thread.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseInput {
    pub thread_id: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub terminal_id: Absent<TerminalId>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub delete_history: Absent<bool>,
}

/// `TerminalSessionStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Exited,
    Error,
}

/// `TerminalSessionSnapshot` — the full state, including the history buffer. Every
/// server-written id here is [`BareNonEmpty`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub thread_id: BareNonEmpty,
    pub terminal_id: BareNonEmpty,
    pub cwd: BareNonEmpty,
    pub worktree_path: Nullable<NonEmpty>,
    pub status: TerminalSessionStatus,
    pub pid: Nullable<Checked<JsNumber, (SafeInt, GreaterThan<0>)>>,
    pub history: String,
    pub exit_code: Nullable<Int>,
    pub exit_signal: Nullable<Int>,
    pub label: Checked<String, MaxLength<128>>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub sequence: Absent<Checked<JsNumber, (SafeInt, AtLeast<0>)>>,
}

/// `TerminalSummary` — the metadata-stream shape: no history, no sequence, and
/// `hasRunningSubprocess` instead.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub thread_id: BareNonEmpty,
    pub terminal_id: BareNonEmpty,
    pub cwd: BareNonEmpty,
    pub worktree_path: Nullable<NonEmpty>,
    pub status: TerminalSessionStatus,
    pub pid: Nullable<Checked<JsNumber, (SafeInt, GreaterThan<0>)>>,
    pub exit_code: Nullable<Int>,
    pub exit_signal: Nullable<Int>,
    pub has_running_subprocess: bool,
    pub label: Checked<String, MaxLength<128>>,
    pub updated_at: String,
}

/// `TerminalMetadataStreamEvent` — the three members of the metadata stream. `type` is the
/// first field in all three, so the key order happens to match what an internally tagged enum
/// would write; the union is still untagged because that is what `Schema.Union` is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminalMetadataStreamEvent {
    Snapshot(TerminalMetadataSnapshotEvent),
    Upsert(TerminalMetadataUpsertEvent),
    Remove(TerminalMetadataRemoveEvent),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetadataSnapshotEvent {
    #[serde(rename = "type")]
    pub kind: MetadataSnapshotTag,
    pub terminals: Vec<TerminalSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetadataUpsertEvent {
    #[serde(rename = "type")]
    pub kind: MetadataUpsertTag,
    pub terminal: TerminalSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetadataRemoveEvent {
    #[serde(rename = "type")]
    pub kind: MetadataRemoveTag,
    pub thread_id: BareNonEmpty,
    pub terminal_id: BareNonEmpty,
}

wire_tag!(MetadataSnapshotTag, "snapshot");
wire_tag!(MetadataUpsertTag, "upsert");
wire_tag!(MetadataRemoveTag, "remove");

/// `TerminalEvent` — the eight members of the output stream. Fields are declared in the
/// source order, which puts the three base fields ahead of `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminalEvent {
    Started(TerminalStartedEvent),
    Output(TerminalOutputEvent),
    Exited(TerminalExitedEvent),
    Closed(TerminalClosedEvent),
    Error(TerminalErrorEvent),
    Cleared(TerminalClearedEvent),
    Restarted(TerminalRestartedEvent),
    Activity(TerminalActivityEvent),
}

/// `TerminalEventBaseSchema`, spread into every member below rather than inherited: the
/// union is built from field objects, so the three keys land first on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventBase {
    pub thread_id: BareNonEmpty,
    pub terminal_id: BareNonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub sequence: Absent<Checked<JsNumber, (SafeInt, AtLeast<0>)>>,
}

/// `TerminalAttachStreamEvent` — the same eight members with a different first one, so a
/// client subscribing to a single terminal gets a snapshot and a client subscribing to the
/// metadata stream gets summaries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TerminalAttachStreamEvent {
    Snapshot(TerminalAttachSnapshotEvent),
    Output(TerminalOutputEvent),
    Exited(TerminalExitedEvent),
    Closed(TerminalClosedEvent),
    Error(TerminalErrorEvent),
    Cleared(TerminalClearedEvent),
    Restarted(TerminalRestartedEvent),
    Activity(TerminalActivityEvent),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachSnapshotEvent {
    #[serde(rename = "type")]
    pub kind: AttachSnapshotTag,
    pub snapshot: TerminalSessionSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartedEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: StartedTag,
    pub snapshot: TerminalSessionSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: OutputTag,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitedEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: ExitedTag,
    pub exit_code: Nullable<Int>,
    pub exit_signal: Nullable<Int>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosedEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: ClosedTag,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalErrorEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: ErrorTag,
    pub message: BareNonEmpty,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClearedEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: ClearedTag,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRestartedEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: RestartedTag,
    pub snapshot: TerminalSessionSnapshot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActivityEvent {
    #[serde(flatten)]
    pub base: TerminalEventBase,
    #[serde(rename = "type")]
    pub kind: ActivityTag,
    pub has_running_subprocess: bool,
    pub label: Checked<String, MaxLength<128>>,
}

// One literal per member, which is what keeps [`TerminalEvent`] decoding like the shipped
// union: an untagged serde union takes the **first** member that deserializes, so a shared
// eight-value tag lets the thin members (`closed`, `cleared`) swallow an `error` event and
// drop its `message`. Measured, not reasoned — that is exactly what the golden caught.
wire_tag!(StartedTag, "started");
wire_tag!(OutputTag, "output");
wire_tag!(ExitedTag, "exited");
wire_tag!(ClosedTag, "closed");
wire_tag!(ErrorTag, "error");
wire_tag!(ClearedTag, "cleared");
wire_tag!(RestartedTag, "restarted");
wire_tag!(ActivityTag, "activity");

// The tag `TerminalAttachStreamEvent` puts where the output stream has `started`. It is a type
// of its own rather than a second name for `MetadataSnapshotTag` because that separation is
// the finding: a snapshot event must decode on this stream and refuse on the other, and a
// started event the reverse.
wire_tag!(AttachSnapshotTag, "snapshot");

/// `TerminalError` — the ten `Schema.TaggedError` classes of the module, flattened through
/// `TerminalCwdError`. Internally tagged is correct here and only here: `TaggedError` puts
/// `_tag` first in the generated struct, so the key order survives.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum TerminalError {
    #[serde(rename = "TerminalCwdNotFoundError")]
    CwdNotFound { cwd: String },
    #[serde(rename = "TerminalCwdNotDirectoryError")]
    CwdNotDirectory { cwd: String },
    #[serde(rename = "TerminalCwdStatError")]
    CwdStat { cwd: String, cause: Defect },
    #[serde(rename = "TerminalHistoryError")]
    History {
        operation: HistoryOperation,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Absent::is_none")]
        cause: Absent<Defect>,
    },
    #[serde(rename = "TerminalSessionLookupError")]
    SessionLookup {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
    #[serde(rename = "TerminalProviderInstanceNotFoundError")]
    ProviderInstanceNotFound {
        #[serde(rename = "providerInstanceId")]
        provider_instance_id: ProviderInstanceId,
    },
    #[serde(rename = "TerminalProviderEnvironmentError")]
    ProviderEnvironment {
        #[serde(rename = "providerInstanceId")]
        provider_instance_id: ProviderInstanceId,
        cause: Defect,
    },
    #[serde(rename = "TerminalNotRunningError")]
    NotRunning {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
    #[serde(rename = "TerminalWriteError")]
    Write {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "terminalPid")]
        terminal_pid: JsNumber,
        cause: Defect,
    },
    #[serde(rename = "TerminalResizeError")]
    Resize {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "terminalPid")]
        terminal_pid: JsNumber,
        cols: TerminalCols,
        rows: TerminalRows,
        cause: Defect,
    },
}

/// `TerminalHistoryError`'s `operation` — the three verbs its `message` interpolates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryOperation {
    Read,
    Truncate,
    Migrate,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
        serde_json::from_value::<T>(value).map_err(|error| error.to_string())
    }

    fn encode<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).expect("serializable")
    }

    /// The two id spellings, measured on the same bytes. A server-written `"  "` thread id
    /// is a valid one; a client sending it in an input is not.
    #[test]
    fn the_two_id_spellings_disagree_on_padding() {
        let bare: BareNonEmpty = serde_json::from_value(json!("  ")).expect("non-empty");
        assert_eq!(
            bare.0, "  ",
            "the snapshot spelling neither trims nor refuses"
        );

        assert!(
            decode::<NonEmpty>(json!("  ")).is_err(),
            "the input spelling trims and then fails isNonEmpty"
        );
        assert_eq!(
            decode::<NonEmpty>(json!(" t-1 "))
                .expect("trims to a real id")
                .0,
            "t-1"
        );
    }

    /// Both bounds are inclusive and the integer filter runs before them.
    #[test]
    fn the_size_brackets_are_closed_on_both_ends() {
        for good in [1, 1000] {
            let cols: TerminalCols =
                serde_json::from_value(json!(good)).expect("inside the bracket");
            assert_eq!(cols.as_i64(), good);
        }
        for bad in [0, 1001, 1_000_000] {
            assert!(
                decode::<TerminalCols>(json!(bad)).is_err(),
                "{bad} is outside"
            );
        }
        assert!(
            decode::<TerminalCols>(json!(1.5)).is_err(),
            "the type layer refuses"
        );
        assert!(
            decode::<TerminalRows>(json!(1000)).is_err(),
            "rows stop at 500, where cols are still legal"
        );
        assert!(
            decode::<TerminalCols>(json!(9_007_199_254_740_992i64)).is_err(),
            "`Schema.Int` is isSafeInteger, not an i64 read"
        );
        assert_eq!(
            TerminalCols::new(1001),
            None,
            "the lax constructor is the one place a Rust caller can build an illegal size"
        );
    }

    /// `{"  ": "v"}` loses an entry and keeps the record; `{"PATH": "x".repeat(8193)}` takes
    /// the field down. The asymmetry is the `LenientKeys` rule and it is per direction of
    /// the check, not per record.
    #[test]
    fn a_bad_env_key_drops_and_a_bad_env_value_fails() {
        let kept: Absent<TerminalEnv> =
            serde_json::from_value(json!({ "PATH": "/usr/bin", "1BAD": "v" }))
                .expect("the bad key is dropped, not fatal");
        let entries = kept.0.expect("one valid entry survived").0;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.0.keys().next().expect("the survivor").0, "PATH");

        assert!(
            decode::<TerminalEnv>(json!({ "PATH": "x".repeat(8_193) })).is_err(),
            "a value over 8 192 UTF-16 units is not a dropped entry"
        );
    }

    /// The key order comes from the construction literal, and here the base fields are
    /// spread before `type`. A client that stringifies both servers and diffs them would
    /// see this.
    #[test]
    fn an_output_event_writes_its_base_fields_before_its_tag() {
        let event = TerminalEvent::Output(TerminalOutputEvent {
            base: TerminalEventBase {
                thread_id: Checked::wrap("t-1".to_owned()),
                terminal_id: Checked::wrap("term-1".to_owned()),
                sequence: Absent(Some(Checked::wrap(JsNumber(serde_json::Number::from(7))))),
            },
            kind: OutputTag,
            data: "ls\r\n".to_owned(),
        });
        assert_eq!(
            encode(&event),
            r#"{"threadId":"t-1","terminalId":"term-1","sequence":7,"type":"output","data":"ls\r\n"}"#
        );
    }

    /// What the golden caught and the shape of the union is built to prevent: an untagged
    /// serde union takes the **first** member that deserializes, so a tag type holding all
    /// eight literals let `{type:"error", message}` decode as a *closed* event and silently
    /// drop the message. Each member owning its own literal fixes that, and it is also what
    /// keeps the two streams one member apart.
    #[test]
    fn each_member_owns_its_tag_so_a_thin_one_cannot_swallow_a_richer_one() {
        let event: TerminalEvent = serde_json::from_value(json!({
            "threadId": "t-1",
            "terminalId": "term-1",
            "type": "error",
            "message": "spawn failed",
        }))
        .expect("the error member");
        assert_eq!(
            encode(&event),
            r#"{"threadId":"t-1","terminalId":"term-1","type":"error","message":"spawn failed"}"#,
            "the message survives, so the closed member did not match first"
        );

        let snapshot = || {
            json!({
                "threadId": "t-1",
                "terminalId": "term-1",
                "cwd": "/",
                "worktreePath": null,
                "status": "running",
                "pid": null,
                "history": "",
                "exitCode": null,
                "exitSignal": null,
                "label": "zsh",
                "updatedAt": "2026-11-21T00:00:00.000Z",
            })
        };
        assert!(
            decode::<TerminalEvent>(json!({
                "threadId": "t-1", "terminalId": "term-1", "type": "snapshot", "snapshot": snapshot(),
            }))
            .is_err(),
            "a snapshot event belongs to the attach stream"
        );
        assert!(
            decode::<TerminalAttachStreamEvent>(json!({
                "threadId": "t-1", "terminalId": "term-1", "type": "started", "snapshot": snapshot(),
            }))
            .is_err(),
            "and a started event to the output one"
        );
        assert!(
            serde_json::from_value::<TerminalAttachStreamEvent>(json!({
                "threadId": "t-1", "terminalId": "term-1", "type": "snapshot", "snapshot": snapshot(),
            }))
            .is_ok(),
            "the reverse does decode"
        );
    }

    /// `Schema.Int` is a JSON number, so an integer-valued float is a pid and `8e1` is a
    /// legal column count. Reading these into Rust integers would refuse both.
    #[test]
    fn integral_floats_are_integers_here() {
        let snapshot: TerminalSessionSnapshot = serde_json::from_value(json!({
            "threadId": "t-1",
            "terminalId": "term-1",
            "cwd": "/",
            "worktreePath": null,
            "status": "running",
            "pid": 4160e0,
            "history": "",
            "exitCode": null,
            "exitSignal": null,
            "label": "zsh",
            "updatedAt": "2026-11-21T00:00:00.000Z",
        }))
        .expect("a float spelling of an integer is an integer");
        assert_eq!(snapshot.pid.0.expect("pid").0.0.as_f64(), Some(4160.0));

        let cols: TerminalCols = serde_json::from_value(json!(8e1)).expect("80");
        assert_eq!(cols.as_i64(), 80);
    }

    /// An absent key and a `null` are different facts, and only one of them is an absence.
    #[test]
    fn a_null_worktree_path_is_present_and_an_absent_key_is_not() {
        let explicit: TerminalOpenInput = serde_json::from_value(json!({
            "threadId": "t-1",
            "terminalId": "term-1",
            "cwd": "/",
            "worktreePath": null,
        }))
        .expect("NullOr accepts null");
        assert_eq!(
            explicit.worktree_path,
            Optional(Absent(Some(Nullable(None)))),
            "the key is present and holds null"
        );
        assert!(encode(&explicit).contains(r#""worktreePath":null"#));

        let omitted: TerminalOpenInput = serde_json::from_value(json!({
            "threadId": "t-1",
            "terminalId": "term-1",
            "cwd": "/",
        }))
        .expect("the key is optional");
        assert_eq!(omitted.worktree_path, Optional(Absent(None)));
        assert!(
            !encode(&omitted).contains("worktreePath"),
            "and it is not written back"
        );

        assert!(
            decode::<TerminalOpenInput>(json!({
                "threadId": "t-1",
                "terminalId": "term-1",
                "cwd": "/",
                "worktreePath": "  ",
            }))
            .is_err(),
            "but `Schema.optional` trims first, so a blank is neither a null nor a path"
        );
    }

    /// The `TaggedError` fields are the whole wire object: `message` is a getter on the
    /// class, so nothing here carries it.
    #[test]
    fn the_error_union_tags_first_and_carries_no_message() {
        let error: TerminalError = serde_json::from_value(json!({
            "_tag": "TerminalWriteError",
            "threadId": "t-1",
            "terminalId": "term-1",
            "terminalPid": 4160,
            "cause": {"message": "broken pipe"},
        }))
        .expect("a recorded write error");
        assert_eq!(
            encode(&error),
            r#"{"_tag":"TerminalWriteError","threadId":"t-1","terminalId":"term-1","terminalPid":4160,"cause":{"name":"Error","message":"broken pipe"}}"#
        );

        assert!(
            decode::<TerminalError>(json!({"threadId": "t-1", "terminalId": "term-1"})).is_err(),
            "without a `_tag` no member matches, since every member keys on one"
        );
        let unknown = decode::<TerminalError>(json!({"_tag": "TerminalSomethingElse"}));
        assert!(
            unknown.is_err(),
            "and an unknown tag is refused, not defaulted"
        );
    }

    /// The checks on a transformed schema run on the trimmed text coming in and the raw text
    /// going out, so the same string passes one way and fails the other.
    #[test]
    fn the_provider_slug_checks_run_on_opposite_text_per_direction() {
        let id: ProviderInstanceId =
            serde_json::from_value(json!(" codex_work ")).expect("trimmed on decode");
        assert_eq!(id.0.0, "codex_work");
        assert_eq!(encode(&id), r#""codex_work""#);

        let padded: ProviderInstanceId = Checked::wrap(NonEmpty(" codex_work ".to_owned()));
        assert!(
            serde_json::to_string(&padded)
                .expect_err("the pattern sees the spaces")
                .to_string()
                .contains("a provider slug"),
            "the two checks report together, so the message names both"
        );
        assert!(decode::<ProviderInstanceId>(json!("1bad")).is_err());
        assert!(decode::<ProviderInstanceId>(json!("a".repeat(65))).is_err());
    }
}
