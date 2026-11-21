//! The usage-limit wire shapes, ported from
//! `packages/core/src/contracts/providerUsageLimits.ts`.
//!
//! Only the four schemas the provider-runtime union reaches are ported here:
//! `ServerProviderUsageWindow`, `ServerProviderResetCredits`, `ServerProviderUsageLimits`
//! and `ProviderUsageLimitsUpdate`. The source-file's other exports
//! (`UsageLimitSource*`, `ProviderConsumeResetCredit*`, `UsageLimitsReport`) belong to the
//! settings and HTTP surfaces and arrive with them.
//!
//! This is the only place in the ported contracts with a `Schema.isBetween`: the
//! [`Between<0, 100>`] on `usedPercent` is inclusive at both ends and rejects `NaN` and
//! `Infinity` because both comparisons are false, which is what an `f64` range test does
//! for free. The measured values are `0` ✓, `100` ✓, `100.000001` ✗, `-0.000001` ✗,
//! `1e308` ✗ and `1e-320` ✓.

use crate::base::{
    Absent, Between, Checked, Lenient, NonEmpty, NonNegativeInt,
};
use serde::{Deserialize, Serialize};

/// `ServerProviderUsageWindow.kind` — orders and labels the bar, nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageWindowKind {
    Session,
    Weekly,
    Monthly,
    Other,
}

/// `usedPercent: Schema.Number.check(isBetween({minimum: 0, maximum: 100}))`.
pub type UsedPercent = Checked<crate::base::JsNumber, Between<0, 100>>;

/// `ServerProviderUsageWindow`. `resetsAt` and `checkedAt` are `IsoDateTime`, which in
/// these contracts is `Schema.String` — **not** a parsed date.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderUsageWindow {
    pub id: NonEmpty,
    pub kind: UsageWindowKind,
    pub label: NonEmpty,
    pub used_percent: UsedPercent,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub resets_at: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub window_duration_mins: Absent<NonNegativeInt>,
}

/// `ServerProviderResetCredits`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderResetCredits {
    pub available_count: NonNegativeInt,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub next_expires_at: Absent<String>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub next_credit_id: Absent<NonEmpty>,
}

/// `ServerProviderUsageLimits.unavailable.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageUnavailableReason {
    Unsupported,
    ProbeFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUnavailable {
    pub reason: UsageUnavailableReason,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub message: Absent<NonEmpty>,
}

/// `ServerProviderUsageLimits`. `windows` is a `ForwardCompatibleArray`, so an element the
/// current build cannot decode is **dropped** instead of failing the snapshot — the one
/// place in this module where a bad row costs one entry rather than the whole field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderUsageLimits {
    pub checked_at: String,
    pub windows: Lenient<ServerProviderUsageWindow>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub reset_credits: Absent<ServerProviderResetCredits>,
    #[serde(default, skip_serializing_if = "Absent::is_none")]
    pub unavailable: Absent<UsageUnavailable>,
}

/// `ProviderUsageLimitsUpdate` — the sparse mid-turn push. A plain `Vec` here, not
/// [`Lenient`]: the source declares `Schema.Array`, so one bad window fails the update.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageLimitsUpdate {
    pub windows: Vec<ServerProviderUsageWindow>,
}
