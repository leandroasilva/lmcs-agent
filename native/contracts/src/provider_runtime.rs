//! The payload every provider adapter emits, ported from
//! `packages/core/src/contracts/providerRuntime.ts`.
//!
//! Nothing in the provider phase can be ported before this: it is the type each adapter
//! returns, what `subscribeProviderRuntimeEvents` carries, and what the orchestrator folds
//! into thread state. Forty-nine event members, each one `{ …base, type, payload }`, with
//! roughly fifty payload structs behind them.
//!
//! Four things the measurement said that the source does not:
//!
//! - **`IsoDateTime` is `Schema.String`.** `createdAt`, `endedAt` and `resetsAt` are *not*
//!   parsed. Fed `2026-11-21T03:04:05.000+02:00` the shipped codec returns the same
//!   spelling; a port that parsed and re-rendered it would normalize the offset to `Z` and
//!   disagree with every event a non-UTC emitter produced. So they are `String`, and this is
//!   the opposite of [`crate::base::DateTimeUtc`], which the *settings* contracts do parse.
//! - **Every member carries its own required `type` literal**, so unlike the terminal unions
//!   this one cannot swallow a richer payload through declaration order: the tag is the only
//!   discriminator and the probe confirmed a `runtime.error` keeps its `payload.class`. The
//!   events are still `#[serde(untagged)]` over per-member [`wire_tag`]s because that is
//!   what `Schema.Union` is, and because the field order of the spread is the source order.
//! - **`TaggedStruct` keys on `_tag`.** `ToolActivityIcon` and
//!   `ToolActivityNativeAppReference` are unions of tagged structs, so their wire form is
//!   `{"_tag":"website",…}` with the tag written first — measured, and the case where a port
//!   copying the `type` convention above would fail loudly rather than silently.
//! - **`withConstructorDefault` is wire-neutral here too**, re-measured in the one place it
//!   appears: `UserInputQuestion.multiSelect`, a field inside a struct inside an array.
//!   Decoding a question without it and re-encoding writes no `multiSelect`. Fatia 4 measured
//!   the same at the top level.
//!
//! [`wire_tag`]: crate::wire_tag

use crate::base::{
    Absent, Check, Checked, Int, JsNumber, MaxLength, NonEmpty, NonNegativeInt, Optional,
    PositiveInt, Record,
};
use crate::provider_instance::{ProviderDriverKind, ProviderInstanceId};
use crate::provider_usage_limits::ProviderUsageLimitsUpdate;
use crate::wire_tag;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

/// `Schema.Record(Schema.String, Schema.Unknown)` — the escape hatch this module uses nine
/// times. A plain JSON object; `Schema.Unknown` is identity, so values are not validated.
pub type UnknownRecord = Record<String, Value>;

// ---------------------------------------------------------------------------
// Closed literal sets
// ---------------------------------------------------------------------------

/// `RuntimeSessionState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSessionState {
    Starting,
    Ready,
    Running,
    Waiting,
    Stopped,
    Error,
}

/// `RuntimeThreadState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeThreadState {
    Active,
    Idle,
    Archived,
    Closed,
    Compacted,
    Error,
}

/// `RuntimeTurnState`, exported as `ProviderRuntimeTurnStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeTurnState {
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

/// `RuntimePlanStepStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimePlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

/// `RuntimeItemStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

/// `RuntimeContentStreamKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeContentStreamKind {
    AssistantText,
    ReasoningText,
    ReasoningSummaryText,
    PlanText,
    CommandOutput,
    FileChangeOutput,
    Unknown,
}

/// `RuntimeSessionExitKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSessionExitKind {
    Graceful,
    Error,
}

/// `RuntimeErrorClass`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorClass {
    ProviderError,
    TransportError,
    PermissionError,
    ValidationError,
    Unknown,
}

/// `CanonicalItemType`, which inlines the seven `TOOL_LIFECYCLE_ITEM_TYPES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalItemType {
    UserMessage,
    AssistantMessage,
    Reasoning,
    Plan,
    CommandExecution,
    FileChange,
    McpToolCall,
    DynamicToolCall,
    CollabAgentToolCall,
    WebSearch,
    ImageView,
    ReviewEntered,
    ReviewExited,
    ContextCompaction,
    Error,
    Unknown,
}

/// `CanonicalRequestType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalRequestType {
    CommandExecutionApproval,
    FileReadApproval,
    FileChangeApproval,
    ApplyPatchApproval,
    ExecCommandApproval,
    McpElicitationApproval,
    PermissionApproval,
    ToolUserInput,
    DynamicToolCall,
    AuthTokensRefresh,
    Unknown,
}

/// `RuntimeTaskStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeTaskStatus {
    Pending,
    Running,
    Waiting,
    Idle,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

/// `TaskCompletedPayload.status` — a *different* set from [`RuntimeTaskStatus`], sharing only
/// three of its words. The source spells the terminal task state with `stopped` while the
/// progress row spells it `cancelled`/`interrupted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskCompletedStatus {
    Completed,
    Failed,
    Stopped,
}

/// `HookCompletedPayload.outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookOutcome {
    Success,
    Error,
    Cancelled,
}

/// `ToolActivitySurface`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolActivitySurface {
    Browser,
    Computer,
}

/// `ToolActivitySource.kind` — the surface plus `integration`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolActivitySourceKind {
    Browser,
    Computer,
    Integration,
}

/// `TaskAgentLinkage.agentKind`, stamped at ingestion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskAgentKind {
    Agent,
    Background,
}

/// `ProviderApprovalDecision`, reached through `RequestOpenedPayload.options`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderApprovalDecision {
    Accept,
    AcceptForSession,
    AcceptAlways,
    Decline,
    Cancel,
}

// ---------------------------------------------------------------------------
// `RuntimeEventRaw`
// ---------------------------------------------------------------------------

/// `RuntimeEventRawSource`: eight literals plus
/// `Schema.TemplateLiteral(["acp.", Schema.String, ".extension"])`.
///
/// The template half is a prefix and a suffix test with nothing between them required:
/// measured, `acp..extension` decodes (the captured `String` matches empty) and so does
/// `acp.a.b.extension`, while `acp.`, `.extension` and `acp.extension` all refuse. That last
/// one is the reason the two halves cannot overlap — strip the prefix *then* the suffix, and
/// a string whose suffix starts inside the prefix has no middle left.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeEventRawSource {
    CodexAppServerNotification,
    CodexAppServerRequest,
    CodexEventMsg,
    ClaudeSdkMessage,
    ClaudeSdkPermission,
    CodexSdkThreadEvent,
    OpenCodeSdkEvent,
    AcpJsonRpc,
    /// The template literal's capture, already stripped of both bounds.
    AcpExtension(String),
}

impl RuntimeEventRawSource {
    fn as_wire(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::CodexAppServerNotification => "codex.app-server.notification".into(),
            Self::CodexAppServerRequest => "codex.app-server.request".into(),
            Self::CodexEventMsg => "codex.eventmsg".into(),
            Self::ClaudeSdkMessage => "claude.sdk.message".into(),
            Self::ClaudeSdkPermission => "claude.sdk.permission".into(),
            Self::CodexSdkThreadEvent => "codex.sdk.thread-event".into(),
            Self::OpenCodeSdkEvent => "opencode.sdk.event".into(),
            Self::AcpJsonRpc => "acp.jsonrpc".into(),
            Self::AcpExtension(middle) => format!("acp.{middle}.extension").into(),
        }
    }

    fn from_wire(text: &str) -> Option<Self> {
        Some(match text {
            "codex.app-server.notification" => Self::CodexAppServerNotification,
            "codex.app-server.request" => Self::CodexAppServerRequest,
            "codex.eventmsg" => Self::CodexEventMsg,
            "claude.sdk.message" => Self::ClaudeSdkMessage,
            "claude.sdk.permission" => Self::ClaudeSdkPermission,
            "codex.sdk.thread-event" => Self::CodexSdkThreadEvent,
            "opencode.sdk.event" => Self::OpenCodeSdkEvent,
            "acp.jsonrpc" => Self::AcpJsonRpc,
            other => Self::AcpExtension(
                other
                    .strip_prefix("acp.")?
                    .strip_suffix(".extension")?
                    .to_owned(),
            ),
        })
    }
}

impl Serialize for RuntimeEventRawSource {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_wire())
    }
}

impl<'de> Deserialize<'de> for RuntimeEventRawSource {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <String as Deserialize>::deserialize(deserializer)?;
        Self::from_wire(&text).ok_or_else(|| {
            serde::de::Error::invalid_value(serde::de::Unexpected::Str(&text), &"a raw source")
        })
    }
}

/// `RuntimeEventRaw` — the provider-native message behind an event, kept so a bug report can
/// be read against the provider's own protocol. `payload` is `Schema.Unknown` and therefore
/// required on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventRaw {
    pub source: RuntimeEventRawSource,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub method: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub message_type: Absent<NonEmpty>,
    pub payload: Value,
}

/// `ProviderRefs`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRefs {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_turn_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_item_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_request_id: Absent<NonEmpty>,
}

// ---------------------------------------------------------------------------
// The shared event base
// ---------------------------------------------------------------------------

/// `ProviderRuntimeEventBase`, spread into all forty-nine members rather than inherited, which
/// is what the source does and what puts these ten keys ahead of `type` on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeEventBase {
    pub event_id: NonEmpty,
    pub provider: ProviderDriverKind,
    /// Optional during the driver/instance migration; routing flips to instance-id-only once
    /// every emitter populates it.
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_instance_id: Absent<ProviderInstanceId>,
    pub thread_id: NonEmpty,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub turn_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub item_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub request_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_refs: Absent<ProviderRefs>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub raw: Absent<RuntimeEventRaw>,
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub message: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub resume: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfiguredPayload {
    pub config: UnknownRecord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateChangedPayload {
    pub state: RuntimeSessionState,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reason: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reason: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub recoverable: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub exit_kind: Absent<RuntimeSessionExitKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub provider_thread_id: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStateChangedPayload {
    pub state: RuntimeThreadState,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub before_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub after_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdatedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub metadata: Absent<UnknownRecord>,
}

/// `ThreadTokenUsageSnapshot` — the context-window bar's whole input. `usedTokens` is the
/// only required count, and the `last*` half exists because a fold needs the delta, not the
/// running total.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageSnapshot {
    pub used_tokens: NonNegativeInt,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub total_processed_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub max_tokens: Absent<PositiveInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cached_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reasoning_output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_used_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_cached_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_reasoning_output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_uses: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub duration_ms: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub compacts_automatically: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub auto_compact_threshold: Absent<PositiveInt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageUpdatedPayload {
    pub usage: ThreadTokenUsageSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeStartedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub realtime_session_id: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeItemAddedPayload {
    pub item: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeAudioDeltaPayload {
    pub audio: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeErrorPayload {
    pub message: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeClosedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reason: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub model: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub effort: Absent<NonEmpty>,
}

/// `TurnTokenUsage`'s two members. They differ by *both* the `usageStatus` literal and which
/// counts are required, which is the shape a declaration-ordered union can get wrong: a
/// `complete` row missing `inputTokens` must fail rather than fall through to the sparse
/// member. Measured — it fails.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TurnTokenUsage {
    Complete(TurnTokenUsageComplete),
    Partial(TurnTokenUsagePartial),
}

wire_tag!(UsageStatusComplete, "complete");

/// `Schema.Literals(["partial", "unavailable"])` — two spellings, one member.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageStatusPartial {
    Partial,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTokenUsageComplete {
    pub usage_scope: UsageScopeMainAgent,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cached_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cache_creation_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reasoning_tokens: Absent<NonNegativeInt>,
    pub has_subagents: bool,
    pub usage_status: UsageStatusComplete,
    pub input_tokens: NonNegativeInt,
    pub output_tokens: NonNegativeInt,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTokenUsagePartial {
    pub usage_scope: UsageScopeMainAgent,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cached_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cache_creation_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reasoning_tokens: Absent<NonNegativeInt>,
    pub has_subagents: bool,
    pub usage_status: UsageStatusPartial,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output_tokens: Absent<NonNegativeInt>,
}

wire_tag!(UsageScopeMainAgent, "main_agent");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedPayload {
    pub state: RuntimeTurnState,
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub stop_reason: Optional<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub usage: Absent<Value>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub model_usage: Absent<UnknownRecord>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub total_cost_usd: Absent<JsNumber>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub error_message: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub token_usage: Absent<TurnTokenUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAbortedPayload {
    pub reason: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub token_usage: Absent<TurnTokenUsage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlanStep {
    pub step: NonEmpty,
    pub status: RuntimePlanStepStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPlanUpdatedPayload {
    #[serde(default, skip_serializing_if = "Optional::is_none")]
    pub explanation: Optional<NonEmpty>,
    pub plan: Vec<RuntimePlanStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProposedDeltaPayload {
    pub delta: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProposedCompletedPayload {
    pub plan_markdown: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiffUpdatedPayload {
    pub unified_diff: String,
}

/// The `isPattern(/^[A-Za-z0-9._-]+$/u)` on a native app id. The `u` flag is not decoration:
/// it is why `a😀` is refused rather than counted as one character the class allows.
static APP_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]+$").expect("valid"));

pub struct AppIdPattern;

impl Check<NonEmpty> for AppIdPattern {
    fn passes(value: &NonEmpty) -> bool {
        APP_ID.is_match(&value.0)
    }

    fn describe() -> String {
        "an application identifier".to_owned()
    }
}

/// `ToolActivityNativeAppReference` — two `TaggedStruct`s, so the wire keys on `_tag`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "kebab-case")]
pub enum ToolActivityNativeAppReference {
    AppId {
        app_id: Checked<NonEmpty, (MaxLength<512>, AppIdPattern)>,
    },
    DisplayName {
        display_name: Checked<NonEmpty, MaxLength<160>>,
    },
}

/// `ToolActivityIcon`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "kebab-case")]
pub enum ToolActivityIcon {
    Website {
        page_url: Checked<NonEmpty, MaxLength<4_096>>,
        #[serde(default, skip_serializing_if = "Absent::is_none")]
        favicon_url: Absent<Checked<NonEmpty, MaxLength<4_096>>>,
        #[serde(default, skip_serializing_if = "Absent::is_none")]
        favicon_url_dark: Absent<Checked<NonEmpty, MaxLength<4_096>>>,
    },
    NativeApp {
        app: ToolActivityNativeAppReference,
    },
    ThemedLogo {
        logo_url: Checked<NonEmpty, MaxLength<4_096>>,
        #[serde(default, skip_serializing_if = "Absent::is_none")]
        logo_url_dark: Absent<Checked<NonEmpty, MaxLength<4_096>>>,
    },
}

/// `ToolActivitySource`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivitySource {
    pub key: Checked<NonEmpty, MaxLength<512>>,
    pub name: Checked<NonEmpty, MaxLength<160>>,
    pub kind: ToolActivitySourceKind,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub icon: Absent<ToolActivityIcon>,
}

/// `ItemLifecyclePayload` — one struct behind `item.started`, `item.updated` and
/// `item.completed`, so those three members differ only by their tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLifecyclePayload {
    pub item_type: CanonicalItemType,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub status: Absent<RuntimeItemStatus>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub title: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_surface: Absent<ToolActivitySurface>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_icon: Absent<ToolActivityIcon>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_source: Absent<ToolActivitySource>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub data: Absent<Value>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub parent_tool_use_id: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDeltaPayload {
    pub stream_kind: RuntimeContentStreamKind,
    pub delta: String,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub content_index: Absent<Int>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub summary_index: Absent<Int>,
}

/// `ProviderApprovalOption`, declared in `orchestration.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderApprovalOption {
    pub decision: ProviderApprovalDecision,
    pub label: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub warning: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOpenedPayload {
    pub request_type: CanonicalRequestType,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub app_name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub options: Absent<Vec<ProviderApprovalOption>>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub args: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestResolvedPayload {
    pub request_type: CanonicalRequestType,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub decision: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub resolution: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestionOption {
    pub label: NonEmpty,
    pub description: String,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub value: Absent<String>,
}

/// `UserInputQuestion`. `multi_select` carries a `withConstructorDefault`, measured
/// wire-neutral here as at the top level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: NonEmpty,
    pub header: NonEmpty,
    pub question: NonEmpty,
    pub options: Vec<UserInputQuestionOption>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub allow_custom_answer: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub multi_select: Absent<bool>,
}

wire_tag!(ResponseModeMessage, "message");

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequestedPayload {
    pub questions: Vec<UserInputQuestion>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub response_mode: Absent<ResponseModeMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputResolvedPayload {
    pub answers: UnknownRecord,
}

/// `RuntimeTaskUsage` — the typed rollup, named to match the orchestration-v2 subagent
/// vocabulary so the eventual migration is a rename.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskUsage {
    pub total_tokens: NonNegativeInt,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub cached_input_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reasoning_output_tokens: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_uses: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub duration_ms: Absent<NonNegativeInt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkflowPhase {
    pub index: NonNegativeInt,
    pub title: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunHandles {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub run_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub script_path: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub transcript_dir: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub session_url: Absent<NonEmpty>,
}

/// `taskAgentLinkageFields`, spread into the four task payloads. Repeated on terminal rows on
/// purpose: a client fold must be able to reconstruct an agent whose start row aged out.
///
/// Not `Eq`: [`NonNegativeInt`] wraps [`JsNumber`], which stops at `PartialEq` because a
/// number is the one thing here whose equality a float could break.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentLinkage {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub task_type: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_kind: Absent<TaskAgentKind>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub title: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub role: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub model: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub effort: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_use_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub parent_agent_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub workflow_name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_index: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub phase_index: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub phase_title: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub phases: Absent<Vec<TaskWorkflowPhase>>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub attempt: Absent<NonNegativeInt>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub run_handles: Absent<TaskRunHandles>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output_file: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_path: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub timeline_bypass: Absent<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStartedPayload {
    pub task_id: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub description: Absent<NonEmpty>,
    #[serde(flatten)]
    pub linkage: TaskAgentLinkage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressPayload {
    pub task_id: NonEmpty,
    pub description: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub summary: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub usage: Absent<Value>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub typed_usage: Absent<RuntimeTaskUsage>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub last_tool_name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub status: Absent<RuntimeTaskStatus>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub error: Absent<NonEmpty>,
    #[serde(flatten)]
    pub linkage: TaskAgentLinkage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdatedPayload {
    pub task_id: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub status: Absent<RuntimeTaskStatus>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub description: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub error: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub ended_at: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub is_backgrounded: Absent<bool>,
    #[serde(flatten)]
    pub linkage: TaskAgentLinkage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletedPayload {
    pub task_id: NonEmpty,
    pub status: TaskCompletedStatus,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub summary: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub usage: Absent<Value>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub typed_usage: Absent<RuntimeTaskUsage>,
    #[serde(flatten)]
    pub linkage: TaskAgentLinkage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStartedPayload {
    pub hook_id: NonEmpty,
    pub hook_name: NonEmpty,
    pub hook_event: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookProgressPayload {
    pub hook_id: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub stdout: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub stderr: Absent<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCompletedPayload {
    pub hook_id: NonEmpty,
    pub outcome: HookOutcome,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub stdout: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub stderr: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub exit_code: Absent<Int>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgressPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_use_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub summary: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub elapsed_seconds: Absent<JsNumber>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub task_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub parent_tool_use_id: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSummaryPayload {
    pub summary: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub preceding_tool_use_ids: Absent<Vec<NonEmpty>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusPayload {
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub is_authenticating: Absent<bool>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub output: Absent<Vec<String>>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub error: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdatedPayload {
    pub account: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRateLimitsUpdatedPayload {
    pub limits: ProviderUsageLimitsUpdate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusUpdatedPayload {
    pub status: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthCompletedPayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub name: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub error: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReroutedPayload {
    pub from_model: NonEmpty,
    pub to_model: NonEmpty,
    pub reason: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWarningPayload {
    pub summary: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub details: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub path: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub range: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeprecationNoticePayload {
    pub summary: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub details: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedFile {
    pub filename: NonEmpty,
    pub file_id: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedFileFailure {
    pub filename: NonEmpty,
    pub error: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesPersistedPayload {
    pub files: Vec<PersistedFile>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub failed: Absent<Vec<PersistedFileFailure>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDeniedPayload {
    pub tool_name: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub tool_use_id: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reason: Absent<NonEmpty>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub agent_id: Absent<NonEmpty>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWarningPayload {
    pub message: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorPayload {
    pub message: NonEmpty,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub class: Absent<RuntimeErrorClass>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub detail: Absent<Value>,
}

// ---------------------------------------------------------------------------
// The forty-nine members
// ---------------------------------------------------------------------------

/// One union member: the base spread, then the member's own literal, then its payload — the
/// source's field order, which is the wire's key order.
macro_rules! runtime_event {
    ($event:ident, $tag:ident, $wire:literal, $payload:ident) => {
        wire_tag!($tag, $wire);

        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $event {
            #[serde(flatten)]
            pub base: ProviderRuntimeEventBase,
            #[serde(rename = "type")]
            pub kind: $tag,
            pub payload: $payload,
        }
    };
}

runtime_event!(SessionStartedEvent, SessionStartedTag, "session.started", SessionStartedPayload);
runtime_event!(SessionConfiguredEvent, SessionConfiguredTag, "session.configured", SessionConfiguredPayload);
runtime_event!(SessionStateChangedEvent, SessionStateChangedTag, "session.state.changed", SessionStateChangedPayload);
runtime_event!(SessionExitedEvent, SessionExitedTag, "session.exited", SessionExitedPayload);
runtime_event!(ThreadStartedEvent, ThreadStartedTag, "thread.started", ThreadStartedPayload);
runtime_event!(ThreadStateChangedEvent, ThreadStateChangedTag, "thread.state.changed", ThreadStateChangedPayload);
runtime_event!(ThreadMetadataUpdatedEvent, ThreadMetadataUpdatedTag, "thread.metadata.updated", ThreadMetadataUpdatedPayload);
runtime_event!(ThreadTokenUsageUpdatedEvent, ThreadTokenUsageUpdatedTag, "thread.token-usage.updated", ThreadTokenUsageUpdatedPayload);
runtime_event!(ThreadRealtimeStartedEvent, ThreadRealtimeStartedTag, "thread.realtime.started", ThreadRealtimeStartedPayload);
runtime_event!(ThreadRealtimeItemAddedEvent, ThreadRealtimeItemAddedTag, "thread.realtime.item-added", ThreadRealtimeItemAddedPayload);
runtime_event!(ThreadRealtimeAudioDeltaEvent, ThreadRealtimeAudioDeltaTag, "thread.realtime.audio.delta", ThreadRealtimeAudioDeltaPayload);
runtime_event!(ThreadRealtimeErrorEvent, ThreadRealtimeErrorTag, "thread.realtime.error", ThreadRealtimeErrorPayload);
runtime_event!(ThreadRealtimeClosedEvent, ThreadRealtimeClosedTag, "thread.realtime.closed", ThreadRealtimeClosedPayload);
runtime_event!(TurnStartedEvent, TurnStartedTag, "turn.started", TurnStartedPayload);
runtime_event!(TurnCompletedEvent, TurnCompletedTag, "turn.completed", TurnCompletedPayload);
runtime_event!(TurnAbortedEvent, TurnAbortedTag, "turn.aborted", TurnAbortedPayload);
runtime_event!(TurnPlanUpdatedEvent, TurnPlanUpdatedTag, "turn.plan.updated", TurnPlanUpdatedPayload);
runtime_event!(TurnProposedDeltaEvent, TurnProposedDeltaTag, "turn.proposed.delta", TurnProposedDeltaPayload);
runtime_event!(TurnProposedCompletedEvent, TurnProposedCompletedTag, "turn.proposed.completed", TurnProposedCompletedPayload);
runtime_event!(TurnDiffUpdatedEvent, TurnDiffUpdatedTag, "turn.diff.updated", TurnDiffUpdatedPayload);
runtime_event!(ItemStartedEvent, ItemStartedTag, "item.started", ItemLifecyclePayload);
runtime_event!(ItemUpdatedEvent, ItemUpdatedTag, "item.updated", ItemLifecyclePayload);
runtime_event!(ItemCompletedEvent, ItemCompletedTag, "item.completed", ItemLifecyclePayload);
runtime_event!(ContentDeltaEvent, ContentDeltaTag, "content.delta", ContentDeltaPayload);
runtime_event!(RequestOpenedEvent, RequestOpenedTag, "request.opened", RequestOpenedPayload);
runtime_event!(RequestResolvedEvent, RequestResolvedTag, "request.resolved", RequestResolvedPayload);
runtime_event!(UserInputRequestedEvent, UserInputRequestedTag, "user-input.requested", UserInputRequestedPayload);
runtime_event!(UserInputResolvedEvent, UserInputResolvedTag, "user-input.resolved", UserInputResolvedPayload);
runtime_event!(TaskStartedEvent, TaskStartedTag, "task.started", TaskStartedPayload);
runtime_event!(TaskProgressEvent, TaskProgressTag, "task.progress", TaskProgressPayload);
runtime_event!(TaskUpdatedEvent, TaskUpdatedTag, "task.updated", TaskUpdatedPayload);
runtime_event!(TaskCompletedEvent, TaskCompletedTag, "task.completed", TaskCompletedPayload);
runtime_event!(HookStartedEvent, HookStartedTag, "hook.started", HookStartedPayload);
runtime_event!(HookProgressEvent, HookProgressTag, "hook.progress", HookProgressPayload);
runtime_event!(HookCompletedEvent, HookCompletedTag, "hook.completed", HookCompletedPayload);
runtime_event!(ToolProgressEvent, ToolProgressTag, "tool.progress", ToolProgressPayload);
runtime_event!(ToolSummaryEvent, ToolSummaryTag, "tool.summary", ToolSummaryPayload);
runtime_event!(AuthStatusEvent, AuthStatusTag, "auth.status", AuthStatusPayload);
runtime_event!(AccountUpdatedEvent, AccountUpdatedTag, "account.updated", AccountUpdatedPayload);
runtime_event!(AccountRateLimitsUpdatedEvent, AccountRateLimitsUpdatedTag, "account.rate-limits.updated", AccountRateLimitsUpdatedPayload);
runtime_event!(McpStatusUpdatedEvent, McpStatusUpdatedTag, "mcp.status.updated", McpStatusUpdatedPayload);
runtime_event!(McpOauthCompletedEvent, McpOauthCompletedTag, "mcp.oauth.completed", McpOauthCompletedPayload);
runtime_event!(ModelReroutedEvent, ModelReroutedTag, "model.rerouted", ModelReroutedPayload);
runtime_event!(ConfigWarningEvent, ConfigWarningTag, "config.warning", ConfigWarningPayload);
runtime_event!(DeprecationNoticeEvent, DeprecationNoticeTag, "deprecation.notice", DeprecationNoticePayload);
runtime_event!(FilesPersistedEvent, FilesPersistedTag, "files.persisted", FilesPersistedPayload);
runtime_event!(ToolDeniedEvent, ToolDeniedTag, "tool.denied", ToolDeniedPayload);
runtime_event!(RuntimeWarningEvent, RuntimeWarningTag, "runtime.warning", RuntimeWarningPayload);
runtime_event!(RuntimeErrorEvent, RuntimeErrorTag, "runtime.error", RuntimeErrorPayload);

/// `ProviderRuntimeEvent` (`ProviderRuntimeEventV2`) — the forty-nine members, in
/// declaration order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(clippy::enum_variant_names)]
pub enum ProviderRuntimeEvent {
    SessionStarted(SessionStartedEvent),
    SessionConfigured(SessionConfiguredEvent),
    SessionStateChanged(SessionStateChangedEvent),
    SessionExited(SessionExitedEvent),
    ThreadStarted(ThreadStartedEvent),
    ThreadStateChanged(ThreadStateChangedEvent),
    ThreadMetadataUpdated(ThreadMetadataUpdatedEvent),
    ThreadTokenUsageUpdated(ThreadTokenUsageUpdatedEvent),
    ThreadRealtimeStarted(ThreadRealtimeStartedEvent),
    ThreadRealtimeItemAdded(ThreadRealtimeItemAddedEvent),
    ThreadRealtimeAudioDelta(ThreadRealtimeAudioDeltaEvent),
    ThreadRealtimeError(ThreadRealtimeErrorEvent),
    ThreadRealtimeClosed(ThreadRealtimeClosedEvent),
    TurnStarted(TurnStartedEvent),
    TurnCompleted(TurnCompletedEvent),
    TurnAborted(TurnAbortedEvent),
    TurnPlanUpdated(TurnPlanUpdatedEvent),
    TurnProposedDelta(TurnProposedDeltaEvent),
    TurnProposedCompleted(TurnProposedCompletedEvent),
    TurnDiffUpdated(TurnDiffUpdatedEvent),
    ItemStarted(ItemStartedEvent),
    ItemUpdated(ItemUpdatedEvent),
    ItemCompleted(ItemCompletedEvent),
    ContentDelta(ContentDeltaEvent),
    RequestOpened(RequestOpenedEvent),
    RequestResolved(RequestResolvedEvent),
    UserInputRequested(UserInputRequestedEvent),
    UserInputResolved(UserInputResolvedEvent),
    TaskStarted(TaskStartedEvent),
    TaskProgress(TaskProgressEvent),
    TaskUpdated(TaskUpdatedEvent),
    TaskCompleted(TaskCompletedEvent),
    HookStarted(HookStartedEvent),
    HookProgress(HookProgressEvent),
    HookCompleted(HookCompletedEvent),
    ToolProgress(ToolProgressEvent),
    ToolSummary(ToolSummaryEvent),
    AuthStatus(AuthStatusEvent),
    AccountUpdated(AccountUpdatedEvent),
    AccountRateLimitsUpdated(AccountRateLimitsUpdatedEvent),
    McpStatusUpdated(McpStatusUpdatedEvent),
    McpOauthCompleted(McpOauthCompletedEvent),
    ModelRerouted(ModelReroutedEvent),
    ConfigWarning(ConfigWarningEvent),
    DeprecationNotice(DeprecationNoticeEvent),
    FilesPersisted(FilesPersistedEvent),
    ToolDenied(ToolDeniedEvent),
    RuntimeWarning(RuntimeWarningEvent),
    RuntimeError(RuntimeErrorEvent),
}

// ---------------------------------------------------------------------------
// The module's one pure function
// ---------------------------------------------------------------------------

/// `MONITOR_TASK_TYPES` — watch loops: a Monitor-tool task or a background shell.
const MONITOR_TASK_TYPES: &[&str] = &["monitor", "monitor_mcp", "local_bash", "shell"];

/// `INERT_TASK_TYPES` — plan-mode bookkeeping, neither an agent nor a watch loop.
const INERT_TASK_TYPES: &[&str] = &["plan", "dream"];

/// `classifyTaskAgentKind` — the agent-vs-background call stamped at ingestion.
///
/// Both gates are exact-match and neither trims: `MONITOR` and `" monitor "` are **not**
/// members of the set, so they classify as `agent`. On the other side, `agentId` is
/// blank-sensitive rather than present-sensitive — `""` and `"  "` are not agent linkage,
/// because the gate is `agentId.trim().length > 0` and not `!== undefined`. A task launched
/// from inside a subagent is background work *unless* its own type is agent-flavored, which
/// is why a nested agent can outlive its parent and stay in the roster.
pub fn classify_task_agent_kind(
    task_type: Option<&str>,
    agent_id: Option<&str>,
) -> TaskAgentKind {
    let non_agent_type = task_type.is_some_and(|kind| {
        MONITOR_TASK_TYPES.contains(&kind) || INERT_TASK_TYPES.contains(&kind)
    });
    let linked_to_agent = agent_id.is_some_and(|id| !id.trim().is_empty());
    if linked_to_agent {
        return if task_type.is_none() || non_agent_type {
            TaskAgentKind::Background
        } else {
            TaskAgentKind::Agent
        };
    }
    if non_agent_type {
        TaskAgentKind::Background
    } else {
        TaskAgentKind::Agent
    }
}

// The source re-exports the turn-state enum under a second name; so does the port, so that
// a caller reading both files side by side sees the same identifier.
pub type ProviderRuntimeTurnStatus = RuntimeTurnState;
