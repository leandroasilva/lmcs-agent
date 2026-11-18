//! The rules every provider's usage bars go through, ported from
//! `apps/server/src/provider/providerUsageLimits.ts` and the `ServerProviderUsage*` contracts
//! in `packages/core/src/contracts/providerUsageLimits.ts`.
//!
//! These are the parts that are not provider-shaped: how a percentage is clamped, what order
//! the bars stack in, how a sparse runtime update folds onto the published snapshot, and what
//! a failed probe is allowed to erase. The Claude and Codex mappers in [`crate::claude`] and
//! [`crate::codex`] produce the windows this module orders and merges.

use crate::jsdate;

/// A field of a JSON value, in the three states the shipped mappers can tell apart.
///
/// `Absent` covers both "the key was never written" and "written as `undefined`": JSON cannot
/// carry the second and no shipped caller distinguishes it. `Null` matters on its own only
/// where a provider sends a *partial* view and an explicit `null` is an answer rather than a
/// silence — Codex's `account/rateLimits/updated` notification, and a runtime update that
/// clears a window's reset time.
#[derive(Clone, Debug, PartialEq)]
pub enum Field<T> {
    Absent,
    Null,
    Value(T),
}

impl<T> Field<T> {
    #[must_use]
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Absent | Self::Null => None,
        }
    }

    #[must_use]
    pub fn into_value(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Absent | Self::Null => None,
        }
    }

    /// JS `value !== undefined`, which an explicit `null` passes.
    #[must_use]
    pub fn is_written(&self) -> bool {
        !matches!(self, Self::Absent)
    }

    /// The partial-view merge: an update that writes the field replaces it, including with
    /// `null`; one that leaves it out keeps whatever was observed earlier.
    #[must_use]
    pub fn merged_with(self, previous: Self) -> Self {
        match self {
            Self::Absent => previous,
            update => update,
        }
    }

    #[must_use]
    pub fn map<U>(self, transform: impl FnOnce(T) -> U) -> Field<U> {
        match self {
            Self::Value(value) => Field::Value(transform(value)),
            Self::Absent => Field::Absent,
            Self::Null => Field::Null,
        }
    }
}

impl<T> From<Option<T>> for Field<T> {
    fn from(value: Option<T>) -> Self {
        match value {
            Some(value) => Self::Value(value),
            None => Self::Absent,
        }
    }
}

/// The four window kinds, in the order the client stacks them: the short allowance first so
/// the bar that runs out soonest is on top.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowKind {
    Session,
    Weekly,
    Monthly,
    Other,
}

impl WindowKind {
    /// The wire spelling, which is also the word the Codex stop message names the window with.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Other => "other",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "session" => Some(Self::Session),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    fn order(self) -> i64 {
        match self {
            Self::Session => 0,
            Self::Weekly => 1,
            Self::Monthly => 2,
            Self::Other => 3,
        }
    }
}

/// One rolling quota window. `used_percent` is what the bar shows and `resets_at` is when it
/// refills; both are optional in the *sparse* sense the contract means, except that a
/// provider's partial update can write `null` over a value the previous snapshot carried, and
/// `Field` keeps that distinguishable instead of silently re-inheriting it.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub id: String,
    pub kind: WindowKind,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Field<String>,
    pub window_duration_mins: Field<f64>,
}

/// Credits the provider banks on the account for clearing a limit it hit unfairly. Only
/// present when the provider reports them at all.
#[derive(Clone, Debug, PartialEq)]
pub struct ResetCredits {
    /// The contract says a non-negative integer; Codex has been measured sending `2.5` and
    /// letting a `NaN` through `Math.max`, so the value is whatever the provider said.
    pub available_count: f64,
    pub next_expires_at: Field<String>,
    /// The credit a redeem is pinned to. Codex has no equivalent, so its answer is always
    /// absent; Claude leaves it absent too whenever the bank has no next credit to name.
    pub next_credit_id: Field<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnavailableReason {
    /// The account can never have windows: an API key, Bedrock, a plan without subscriptions.
    Unsupported,
    /// This read failed. Clients keep the last good bars, which is the whole reason the two
    /// reasons are separate.
    ProbeFailed,
}

impl UnavailableReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::ProbeFailed => "probeFailed",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "unsupported" => Some(Self::Unsupported),
            "probeFailed" => Some(Self::ProbeFailed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Unavailable {
    pub reason: UnavailableReason,
    pub message: Field<String>,
}

/// What one provider's account currently reports, as published to clients.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageLimits {
    pub checked_at: String,
    pub windows: Vec<UsageWindow>,
    pub reset_credits: Option<ResetCredits>,
    pub unavailable: Option<Unavailable>,
}

/// What an adapter reports when its runtime pushes a rate-limit update during a turn. Sparse
/// by contract: windows merge by `id` onto the published snapshot and unmentioned windows are
/// unchanged.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct UsageLimitsUpdate {
    pub windows: Vec<UsageWindow>,
}

/// `clampPercent`. A percentage the provider did not sanity-check still draws a bar.
#[must_use]
pub fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        js_max(0.0, js_min(100.0, value))
    } else {
        0.0
    }
}

/// `Math.max`. Unlike `f64::max`, ECMAScript propagates `NaN`, and `max(0, -0)` is `+0`.
/// The signed zero is invisible on the wire — `JSON.stringify(-0)` is `"0"` — so the golden
/// cannot pin it; `clamp_percent_never_returns_negative_zero` does.
#[must_use]
pub fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == right {
        // The only equal pair of different signs is `+0` and `-0`, and the result is `+0`.
        return if left == 0.0 { 0.0 } else { left };
    }
    if left > right { left } else { right }
}

/// `Math.min`, which like `Math.max` propagates `NaN` and prefers `-0` where the two zeros
/// tie.
#[must_use]
pub fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == right {
        return if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            left
        };
    }
    if left < right { left } else { right }
}

/// `Math.min(...values)`, whose empty case the shipped callers guard against but which is
/// `Infinity` for a reason: `Math.min()` with no arguments is `+Infinity`.
#[must_use]
pub fn js_min_all(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(f64::INFINITY, |acc, value| js_min(acc, *value))
}

/// `[...windows].toSorted(kindOrder || id.localeCompare)`. `sort_by` is stable, like
/// `toSorted`.
#[must_use]
pub fn sort_windows(windows: impl IntoIterator<Item = UsageWindow>) -> Vec<UsageWindow> {
    let mut windows: Vec<UsageWindow> = windows.into_iter().collect();
    windows.sort_by(|left, right| {
        (left.kind.order() - right.kind.order())
            .cmp(&0)
            .then_with(|| jsdate::locale_compare(&left.id, &right.id))
    });
    windows
}

/// `makeUsageLimits`.
#[must_use]
pub fn make_usage_limits(
    checked_at: impl Into<String>,
    windows: impl IntoIterator<Item = UsageWindow>,
) -> UsageLimits {
    UsageLimits {
        checked_at: checked_at.into(),
        windows: sort_windows(windows),
        reset_credits: None,
        unavailable: None,
    }
}

/// `makeUnavailableUsageLimits`. An empty message is falsy and disappears, so a client shows
/// the reason rather than a blank sentence.
#[must_use]
pub fn make_unavailable_usage_limits(
    checked_at: impl Into<String>,
    reason: UnavailableReason,
    message: Option<String>,
) -> UsageLimits {
    UsageLimits {
        checked_at: checked_at.into(),
        windows: Vec::new(),
        reset_credits: None,
        unavailable: Some(Unavailable {
            reason,
            message: Field::from(message.filter(|message| !message.is_empty())),
        }),
    }
}

/// `applyUsageLimitsUpdate`.
///
/// Folds a sparse runtime update into the limits a provider currently publishes. Windows
/// upsert by `id`; a window the update omits keeps its previous values, and a window that
/// arrives without `resetsAt` or `windowDurationMins` keeps whatever the last probe resolved
/// for it. An update with no windows leaves `previous` untouched.
///
/// An `unsupported` snapshot stays unsupported: an account that cannot have subscription
/// windows will not start reporting them mid-turn.
#[must_use]
pub fn apply_usage_limits_update(
    previous: Option<&UsageLimits>,
    update: &UsageLimitsUpdate,
    checked_at: &str,
) -> Option<UsageLimits> {
    if update.windows.is_empty()
        || previous
            .and_then(|limits| limits.unavailable.as_ref())
            .is_some_and(|unavailable| unavailable.reason == UnavailableReason::Unsupported)
    {
        return previous.cloned();
    }

    // A `Vec` rather than a map, because the order rows arrive in is the order a JS `Map`
    // keeps before the sort: an update that names an existing id rewrites that row in place,
    // and only a new id appends.
    let mut merged: Vec<UsageWindow> = previous
        .map(|limits| limits.windows.clone())
        .unwrap_or_default();
    // Codex sends this notification beside every token-usage tick, almost always with
    // unchanged numbers. Decide "nothing changed" per window on the way through so the no-op
    // case never allocates a new snapshot.
    let mut changed = false;
    for window in &update.windows {
        let position = merged
            .iter()
            .position(|candidate| candidate.id == window.id);
        let existing = position.map(|index| merged[index].clone());
        let next = UsageWindow {
            used_percent: clamp_percent(window.used_percent),
            resets_at: inherit(
                &window.resets_at,
                existing.as_ref().map(|row| &row.resets_at),
            ),
            window_duration_mins: inherit(
                &window.window_duration_mins,
                existing.as_ref().map(|row| &row.window_duration_mins),
            ),
            ..window.clone()
        };
        match position {
            None => {
                merged.push(next);
                changed = true;
            }
            Some(index) => {
                if !usage_window_equals(&merged[index], &next) {
                    merged[index] = next;
                    changed = true;
                }
            }
        }
    }
    if !changed
        && let Some(previous) = previous
        && previous.unavailable.is_none()
    {
        return Some(previous.clone());
    }
    Some(UsageLimits {
        checked_at: checked_at.to_owned(),
        windows: sort_windows(merged),
        // Redemption state belongs to the account, not to this turn's notification, so it
        // rides along untouched and a previous snapshot without it stays without it.
        reset_credits: previous.and_then(|limits| limits.reset_credits.clone()),
        unavailable: None,
    })
}

/// The inherit-or-keep step: a window that arrives without the field takes the published
/// row's value, and a row whose value was cleared to `null` inherits that `null` rather than
/// reaching back further.
fn inherit<T: Clone>(written: &Field<T>, existing: Option<&Field<T>>) -> Field<T> {
    match (written, existing) {
        (Field::Absent, Some(prior)) if prior.is_written() => prior.clone(),
        _ => written.clone(),
    }
}

/// `usageWindowEquals` — JS `===` on the six fields the snapshot carries, so a `NaN` percent
/// never equals itself and re-publishes.
#[must_use]
pub fn usage_window_equals(a: &UsageWindow, b: &UsageWindow) -> bool {
    a.id == b.id
        && a.kind == b.kind
        && a.label == b.label
        && a.used_percent == b.used_percent
        && a.resets_at == b.resets_at
        && a.window_duration_mins == b.window_duration_mins
}

/// `resolveUsageLimitsAfterProbe`. Choose what to publish after a status probe finishes. A
/// probe that failed this time must not wipe bars a previous probe or a turn already
/// established, so the last good snapshot stays; `unsupported` is authoritative and replaces
/// them.
///
/// A successful probe replaces the published windows outright, including any runtime update
/// that landed while it was running: the read takes a few seconds at most, the probe is the
/// fresher full read in every case except that window, and per-window epoch bookkeeping to
/// reconcile the two was more code than the sub-second regression it prevented. The next
/// runtime event corrects it.
#[must_use]
pub fn resolve_usage_limits_after_probe(
    published: Option<&UsageLimits>,
    probed: Option<&UsageLimits>,
) -> Option<UsageLimits> {
    if let Some(probed) = &probed
        && probed
            .unavailable
            .as_ref()
            .is_some_and(|unavailable| unavailable.reason == UnavailableReason::ProbeFailed)
        && let Some(
            published @ UsageLimits {
                unavailable: None, ..
            },
        ) = published
    {
        return Some(published.clone());
    }
    probed.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: &str, kind: WindowKind, used_percent: f64) -> UsageWindow {
        UsageWindow {
            id: id.to_owned(),
            kind,
            label: kind.as_str().to_owned(),
            used_percent,
            resets_at: Field::Absent,
            window_duration_mins: Field::Absent,
        }
    }

    fn ids(limits: &UsageLimits) -> Vec<&str> {
        limits
            .windows
            .iter()
            .map(|window| window.id.as_str())
            .collect()
    }

    #[test]
    fn clamp_percent_rejects_the_non_finite_instead_of_clamping_it() {
        assert_eq!(clamp_percent(100.5), 100.0);
        assert_eq!(clamp_percent(-1.0), 0.0);
        // `Number.isFinite` fails for the infinities, so an unbounded percentage is read as an
        // empty bar rather than a full one — the difference between this and a plain clamp.
        assert_eq!(clamp_percent(f64::INFINITY), 0.0);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
        // The result of `Math.max(0, Math.min(100, -0))` is `+0`; the two zeros are equal, and
        // JSON prints both as `0`, so the sign is invisible on the wire and pinned only here.
        assert!(!clamp_percent(-0.0).is_sign_negative());
    }

    #[test]
    fn the_math_helpers_propagate_nan_where_javascript_does() {
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(100.0, f64::NAN).is_nan());
        // `Math.min()` with no arguments is `+Infinity`, which is what makes an empty credit
        // list a missing countdown rather than one at the epoch.
        assert_eq!(js_min_all(&[]), f64::INFINITY);
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(!js_max(0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn windows_stack_shortest_allowance_first_then_the_locale_order() {
        let limits = make_usage_limits(
            "2026-05-01T00:00:00.000Z",
            [
                window("z_other", WindowKind::Other, 0.0),
                window("seven_day_gpt5", WindowKind::Weekly, 0.0),
                window("m_monthly", WindowKind::Monthly, 0.0),
                window("seven_day_gpt_5", WindowKind::Weekly, 0.0),
                window("five_hour", WindowKind::Session, 0.0),
            ],
        );
        assert_eq!(
            ids(&limits),
            [
                "five_hour",
                "seven_day_gpt_5",
                "seven_day_gpt5",
                "m_monthly",
                "z_other"
            ]
        );
    }

    #[test]
    fn an_unwritten_field_inherits_and_a_written_null_clears() {
        let published = make_usage_limits(
            "earlier",
            [UsageWindow {
                resets_at: Field::Value("2026-05-01T00:00:00.000Z".to_owned()),
                window_duration_mins: Field::Value(300.0),
                ..window("five_hour", WindowKind::Session, 10.0)
            }],
        );

        let kept = apply_usage_limits_update(
            Some(&published),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, 20.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(
            kept.windows[0].resets_at,
            Field::Value("2026-05-01T00:00:00.000Z".to_owned())
        );
        assert_eq!(kept.windows[0].window_duration_mins, Field::Value(300.0));
        assert_eq!(kept.checked_at, "later");

        // The shipped spread tests `=== undefined`, so an explicit `null` is an answer: the
        // bar loses its countdown instead of reaching back to the previous snapshot.
        let cleared = apply_usage_limits_update(
            Some(&published),
            &UsageLimitsUpdate {
                windows: vec![UsageWindow {
                    resets_at: Field::Null,
                    ..window("five_hour", WindowKind::Session, 20.0)
                }],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(cleared.windows[0].resets_at, Field::Null);

        // A row whose countdown was cleared once stays cleared: the inherit test is
        // `existing?.resetsAt !== undefined`, and `null` passes it. Reading it as "nothing was
        // observed" instead would resurrect a countdown the provider took away.
        let cleared_once = make_usage_limits(
            "middle",
            [UsageWindow {
                resets_at: Field::Null,
                ..window("five_hour", WindowKind::Session, 20.0)
            }],
        );
        let stayed = apply_usage_limits_update(
            Some(&cleared_once),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, 30.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(stayed.windows[0].resets_at, Field::Null);
    }

    #[test]
    fn an_unchanged_notification_reuses_the_snapshot_and_a_nan_one_does_not() {
        let published =
            make_usage_limits("earlier", [window("five_hour", WindowKind::Session, 0.0)]);
        let unchanged = apply_usage_limits_update(
            Some(&published),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, 0.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(unchanged, published);

        // `clampPercent` turns the `NaN` into `0`, and the published row still holds the `NaN`
        // the provider sent, so the comparison cannot see them as the same row. The
        // equality test is JS `===` for exactly this reason: a `NaN` bar re-publishes.
        let stalled = make_usage_limits(
            "earlier",
            [window("five_hour", WindowKind::Session, f64::NAN)],
        );
        let after = apply_usage_limits_update(
            Some(&stalled),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, f64::NAN)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(after.checked_at, "later");
        assert_eq!(after.windows[0].used_percent, 0.0);

        // With nothing to say, the update leaves the snapshot alone, checked-at included.
        let empty =
            apply_usage_limits_update(Some(&published), &UsageLimitsUpdate::default(), "later")
                .expect("an update over a snapshot yields a snapshot");
        assert_eq!(empty, published);
        assert_eq!(
            apply_usage_limits_update(None, &UsageLimitsUpdate::default(), "later"),
            None
        );
    }

    #[test]
    fn a_runtime_event_cannot_make_an_unsupported_account_supported() {
        let unsupported = make_unavailable_usage_limits(
            "earlier",
            UnavailableReason::Unsupported,
            Some("API key".to_owned()),
        );
        let after = apply_usage_limits_update(
            Some(&unsupported),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, 40.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(after, unsupported);

        // A `probeFailed` snapshot is only a stalled read, so the event draws over it.
        let stalled =
            make_unavailable_usage_limits("earlier", UnavailableReason::ProbeFailed, None);
        let after = apply_usage_limits_update(
            Some(&stalled),
            &UsageLimitsUpdate {
                windows: vec![window("five_hour", WindowKind::Session, 40.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(ids(&after), ["five_hour"]);
        assert_eq!(after.unavailable, None);
        // The empty message is falsy and disappears.
        assert_eq!(
            make_unavailable_usage_limits(
                "now",
                UnavailableReason::Unsupported,
                Some(String::new())
            )
            .unavailable
            .expect("an unavailable snapshot")
            .message,
            Field::Absent
        );
    }

    #[test]
    fn a_failed_probe_keeps_the_bars_and_an_unsupported_answer_replaces_them() {
        let published =
            make_usage_limits("published", [window("five_hour", WindowKind::Session, 1.0)]);
        let probed_failed = make_unavailable_usage_limits(
            "probed",
            UnavailableReason::ProbeFailed,
            Some("timeout".to_owned()),
        );
        assert_eq!(
            resolve_usage_limits_after_probe(Some(&published), Some(&probed_failed)),
            Some(published.clone())
        );
        assert_eq!(
            resolve_usage_limits_after_probe(None, Some(&probed_failed)),
            Some(probed_failed.clone())
        );
        let probed_unsupported =
            make_unavailable_usage_limits("probed", UnavailableReason::Unsupported, None);
        assert_eq!(
            resolve_usage_limits_after_probe(Some(&published), Some(&probed_unsupported)),
            Some(probed_unsupported)
        );
        assert_eq!(
            resolve_usage_limits_after_probe(Some(&published), None),
            None
        );
    }

    #[test]
    fn credits_survive_a_merge_onto_their_own_snapshot() {
        let published = UsageLimits {
            reset_credits: Some(ResetCredits {
                available_count: 2.0,
                next_expires_at: Field::Value("2026-05-01T00:00:00.000Z".to_owned()),
                next_credit_id: Field::Absent,
            }),
            ..make_usage_limits("earlier", [window("primary", WindowKind::Session, 1.0)])
        };
        let after = apply_usage_limits_update(
            Some(&published),
            &UsageLimitsUpdate {
                windows: vec![window("secondary", WindowKind::Weekly, 2.0)],
            },
            "later",
        )
        .expect("an update over a snapshot yields a snapshot");
        assert_eq!(after.reset_credits, published.reset_credits);
        assert_eq!(ids(&after), ["primary", "secondary"]);
    }

    #[test]
    fn merged_with_keeps_the_previous_answer_only_when_this_one_is_silent() {
        assert_eq!(
            Field::Absent.merged_with(Field::Value("earlier")),
            Field::Value("earlier")
        );
        assert_eq!(
            Field::Null.merged_with(Field::Value("earlier")),
            Field::Null
        );
        assert_eq!(
            Field::Value("later").merged_with(Field::Value("earlier")),
            Field::Value("later")
        );
        assert!(Field::<u8>::Null.is_written());
        assert!(!Field::<u8>::Absent.is_written());
    }
}
