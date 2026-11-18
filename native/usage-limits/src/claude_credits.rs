//! Claude's banked resets — the CLI's `cedar_ember` program — ported from
//! `apps/server/src/provider/Layers/claudeResetCredits.ts`.
//!
//! Three decisions live here and only one of them is about HTTP. The first is what the usage
//! endpoint's `cedar_ember` block *means*: how many resets the account can still spend, which
//! one a redemption should name, and when the answer is "say nothing at all". The second is what
//! a claim can be told apart as: eight reasons the CLI's own answer arrives under, which of them
//! are final, and the sentence the client sees for each. The third is what the two reads ask of
//! the account before either answer exists — which file, in which order, and whether to send
//! anything at all.
//!
//! The shape of the port follows the reason the three are separable at all. Everything the
//! shipped code asks of the world — a credential file, an account file, a response, the clock,
//! the platform — is handed over as an answer, exactly as in [`crate::opencode`], and what the
//! call did to the outside world comes back as [`Effect`]s so the adapter's own IO layer can be
//! checked against the one these fixtures were measured with. What stays outside this crate is
//! the timeout, the transport, and the keychain macOS keeps its login in.

use serde_json::Value;

use crate::jsdate;
use crate::limits::{Field, ResetCredits};
use crate::paths;
use crate::read;

/// `API_BASE` plus the one path the usage read uses. The query is spelled out rather than
/// carried as parameters because `Url.make` is what turns `urlParams` into a wire URL, and it
/// appends them in declaration order onto a path that has none — so the two ways of writing
/// this agree, and this one needs no percent-encoding rules for two constant `1`s.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

/// The `anthropic-beta` both requests send. The endpoint is not the current OAuth surface
/// without it, so it belongs to the request and not to the transport.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// What the endpoint says the bank holds, after the shape questions are settled.
///
/// `undefined` is the shipped answer for "this account has no bank to report", and it is reached
/// two ways: the block is unusable, or `eligible` is not `true`. Note what is *not* in this
/// list: a usable block with nothing spendable still says `availableCount: 0`, because the bars
/// are allowed to be empty but not to be missing.
#[must_use]
pub fn claude_reset_credits_to_contract(block: &Value, now_ms: f64) -> Option<ResetCredits> {
    let parsed = decode_cedar_ember(block)?;
    let live: Vec<Grant> = parsed
        .grants
        .iter()
        .filter_map(decode_grant)
        .filter(|grant| grant.spendable(now_ms))
        .collect();
    // The count is said only when the bank's own pointer lands on a grant that is still here.
    // A `next_grant_id` that names a paused, spent or expired grant is not a fall-back to
    // counting the rest: the shipped code answers `0` and names no credit at all.
    let next = parsed
        .next_grant_id
        .as_deref()
        .and_then(|wanted| live.iter().find(|grant| grant.id == wanted));
    Some(ResetCredits {
        available_count: match next {
            None => 0.0,
            Some(_) => live.iter().map(|grant| grant.resets_left).sum(),
        },
        next_expires_at: next
            .and_then(|grant| grant.ends_at.as_deref())
            .and_then(jsdate::date_parse)
            .and_then(jsdate::to_iso_string)
            .map_or(Field::Absent, Field::Value),
        next_credit_id: next.map_or(Field::Absent, |grant| Field::Value(grant.id.clone())),
    })
}

/// `Struct({ eligible: Boolean, grants: optional(Array(Unknown)), next_grant_id:
/// optional(NullOr(String)) })` through `decodeUnknownOption`. The array's *elements* are not
/// questioned here, which is the difference between this block and the OpenCode usage body: an
/// unusable grant is dropped on its own and the bank keeps reporting the others.
fn decode_cedar_ember(block: &Value) -> Option<CedarEmber> {
    if !matches!(block, Value::Object(_)) {
        return None;
    }
    if read::as_bool(read::property(block, "eligible")) != Some(true) {
        return None;
    }
    let grants = match read::field(block, "grants") {
        Field::Absent => Vec::new(),
        Field::Value(Value::Array(items)) => items.clone(),
        // `null` is not an optional array, and neither is a bucket: the whole block is refused.
        _ => return None,
    };
    let next_grant_id = match read::field(block, "next_grant_id") {
        Field::Absent | Field::Null => None,
        Field::Value(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    Some(CedarEmber {
        grants,
        next_grant_id,
    })
}

struct CedarEmber {
    grants: Vec<Value>,
    next_grant_id: Option<String>,
}

/// `Struct({ id: String.check(isPattern(GRANT_ID)), resets_left: Int.check(>= 0), ends_at:
/// optional(NullOr(String)), paused: optional(Boolean), usable_now: optional(Boolean) })`
/// through `decodeUnknownOption`, so a field of the wrong type is the end of this grant and of
/// nothing else.
fn decode_grant(raw: &Value) -> Option<Grant> {
    if !matches!(raw, Value::Object(_)) {
        return None;
    }
    let id = read::as_string(read::property(raw, "id"))?;
    if !grant_id_ok(id) {
        return None;
    }
    let id = id.to_owned();
    // `Schema.Int` is `Number.isSafeInteger`, so the largest count the account could report
    // exactly is `2^53 - 1` and `9007199254740992` is no count at all.
    let resets_left = read::as_number(read::property(raw, "resets_left"))?;
    if !resets_left.is_finite()
        || resets_left.fract() != 0.0
        || resets_left.abs() > 9007199254740991.0
        || resets_left < 0.0
    {
        return None;
    }
    let ends_at = match read::field(raw, "ends_at") {
        Field::Absent | Field::Null => None,
        Field::Value(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    let paused = optional_bool(read::field(raw, "paused"))?;
    let usable_now = optional_bool(read::field(raw, "usable_now"))?;
    Some(Grant {
        id,
        resets_left,
        ends_at,
        paused,
        usable_now,
    })
}

struct Grant {
    id: String,
    resets_left: f64,
    ends_at: Option<String>,
    paused: Option<bool>,
    usable_now: Option<bool>,
}

impl Grant {
    /// `!grant.paused && grant.usable_now && (grant.ends_at == null ||
    /// isFutureTimestamp(grant.ends_at, nowMs))`. The two optional booleans are read as
    /// JavaScript reads them: an absent `paused` is not paused, and an absent `usable_now` is
    /// not usable — the asymmetry is the whole reason a grant with no `usable_now` never counts.
    fn spendable(&self, now_ms: f64) -> bool {
        self.paused != Some(true)
            && self.usable_now == Some(true)
            && match &self.ends_at {
                None => true,
                Some(text) => is_future_timestamp(text, now_ms),
            }
    }
}

fn optional_bool(field: Field<&Value>) -> Option<Option<bool>> {
    match field {
        Field::Absent => Some(None),
        // A `null` is not an optional boolean either, so the grant is refused the same way a
        // string in the same position refuses it.
        Field::Null => None,
        Field::Value(value) => read::as_bool(value).map(Some),
    }
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`, then the instant has
/// to be strictly after `nowMs` and the day has to exist in its own month.
///
/// Three things this gate knows that the Effect date parser does not: it is anchored without
/// `trim`, so a padded text is refused here where the parser would have taken it; it wants a
/// colon in the offset, so `+0200` is refused although `Date.parse` reads it; and it is
/// case-sensitive on both the `T` and the `Z`.
fn is_future_timestamp(text: &str, now_ms: f64) -> bool {
    if !complete_timestamp(text) {
        return false;
    }
    // `Date.parse(value) > nowMs` — an hour of 25 or a month of 13 passes the pattern and dies
    // here instead, which is why the pattern is not the whole answer.
    let Some(instant) = jsdate::date_parse(text) else {
        return false;
    };
    if instant.partial_cmp(&now_ms) != Some(std::cmp::Ordering::Greater) {
        return false;
    }
    // `Date.UTC(y, m - 1, d) <= Date.UTC(y, m, 0)`, the second of which is `Date.UTC`'s own way
    // of naming the last day of the month. The pattern already rejected an unknown day of the
    // month, so this is not a check of what the text claims but of what the calendar allows:
    // February 29 in a common year parses — V8 rolls it into March 1 — and this is what
    // refuses it.
    let bytes = text.as_bytes();
    let year = digits(bytes, 0, 4) as f64;
    let month = digits(bytes, 5, 7) as f64;
    let day = digits(bytes, 8, 10) as f64;
    match (
        jsdate::date_utc(year, month - 1.0, day),
        jsdate::date_utc(year, month, 0.0),
    ) {
        (Some(day_start), Some(last_day)) => day_start <= last_day,
        // Either side being `NaN` makes the shipped comparison false, so a text the calendar
        // cannot place is not a future instant.
        _ => false,
    }
}

/// `COMPLETE_TIMESTAMP`, written out because the port has no regex engine: four digits, `-`,
/// two, `-`, two, `T`, two `:` two `:` two, an optional `.` with one or more digits, then `Z`
/// or a `±HH:MM` offset, and the end of the text. No `trim`, no lowercase, no compact offset,
/// no `[Europe/Berlin]`, no `GMT`.
fn complete_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    let groups: [(usize, usize); 3] = [(0, 4), (5, 7), (8, 10)];
    if bytes.len() < 19 {
        return false;
    }
    if !groups.iter().all(|(from, to)| all_digits(bytes, *from, *to))
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || !all_digits(bytes, 11, 13)
        || bytes[13] != b':'
        || !all_digits(bytes, 14, 16)
        || bytes[16] != b':'
        || !all_digits(bytes, 17, 19)
    {
        return false;
    }
    let mut rest = &text[19..];
    if let Some(after_fraction) = rest.strip_prefix('.') {
        let digits = after_fraction
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0 {
            return false;
        }
        rest = &after_fraction[digits..];
    }
    if rest == "Z" {
        return true;
    }
    let offset = rest.as_bytes();
    offset.len() == 6
        && matches!(offset[0], b'+' | b'-')
        && all_digits(offset, 1, 3)
        && offset[3] == b':'
        && all_digits(offset, 4, 6)
}

fn all_digits(bytes: &[u8], from: usize, to: usize) -> bool {
    to <= bytes.len() && bytes[from..to].iter().all(u8::is_ascii_digit)
}

fn digits(text: &[u8], from: usize, to: usize) -> i64 {
    let mut value = 0_i64;
    for byte in &text[from..to] {
        value = value * 10 + i64::from(byte - b'0');
    }
    value
}

/// `GRANT_ID`, which is lowercase-only — an uppercase id the CLI could never have minted is a
/// grant this reader drops rather than a spelling it forgives.
fn grant_id_ok(text: &str) -> bool {
    bounded_id(text, 40, |character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '_' | '-')
    })
}

/// `REQUEST_ID`, the same charset with the case rule removed and a longer allowance.
fn request_id_ok(text: &str) -> bool {
    bounded_id(text, 64, |character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
    })
}

fn bounded_id(text: &str, limit: usize, allowed: impl Fn(char) -> bool) -> bool {
    !text.is_empty() && text.chars().count() <= limit && text.chars().all(&allowed)
}

/// What the endpoint's `result` said, in the contract's words. `cooldown` and `unavailable` are
/// not here: the shipped code turns those into failures, not outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsumeOutcome {
    /// `reset`
    Reset,
    /// `not_limited`
    NothingToReset,
    /// `already_used`
    AlreadyRedeemed,
    /// `ineligible`
    NoCredit,
}

impl ConsumeOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reset => "reset",
            Self::NothingToReset => "nothingToReset",
            Self::AlreadyRedeemed => "alreadyRedeemed",
            Self::NoCredit => "noCredit",
        }
    }
}

/// The eight reasons a claim can fail, with the sentence the client is given for each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimFailure {
    MalformedCredit,
    LoginUnreadable,
    AccountUnreadable,
    SignedOut,
    RateLimited,
    CoolingDown,
    Unconfirmed,
    RequestFailed,
}

impl ClaimFailure {
    /// `RESET_CREDIT_FAILURES`.
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            Self::MalformedCredit => "Claude returned a malformed reset credit.",
            Self::LoginUnreadable => "Claude could not read its login.",
            Self::AccountUnreadable => "Claude could not read its account.",
            Self::SignedOut => "Sign in to Claude again to redeem resets.",
            Self::RateLimited => "Claude is rate limiting resets. Try again soon.",
            Self::CoolingDown => "Claude resets are cooling down. Try again later.",
            Self::Unconfirmed => {
                "Claude could not confirm the reset. If you are still limited in a moment, try again."
            }
            Self::RequestFailed => "Claude could not redeem the reset.",
        }
    }

    /// `isSettledClaudeResetCreditFailure`: everything except an answer that never arrived and
    /// an answer that could not say whether the claim landed may be reported and forgotten. The
    /// other two keep the request id so the retry asks about the same claim.
    #[must_use]
    pub fn is_settled(self) -> bool {
        !matches!(self, Self::RequestFailed | Self::Unconfirmed)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedCredit => "malformedCredit",
            Self::LoginUnreadable => "loginUnreadable",
            Self::AccountUnreadable => "accountUnreadable",
            Self::SignedOut => "signedOut",
            Self::RateLimited => "rateLimited",
            Self::CoolingDown => "coolingDown",
            Self::Unconfirmed => "unconfirmed",
            Self::RequestFailed => "requestFailed",
        }
    }
}

/// What the two files the claim reads said. A missing file is the normal case — a signed-out
/// account simply has none — while any other failure is a fact the caller has to be told about.
#[derive(Clone, Copy, Debug)]
pub enum FileText<'a> {
    Contents(&'a str),
    NotFound,
    Unreadable,
}

#[derive(Clone, Copy, Debug)]
pub struct Reply<'a> {
    pub status: u16,
    pub body: &'a str,
}

/// The platform the CLI runs on, since that decides where the login lives. macOS keeps it in the
/// keychain, which this reader cannot reach, so the feature is not offered there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Other,
}

/// What the claim reads from the world. The account path arrives already resolved, because
/// resolving it is [`account_config_path`]'s job and the shipped caller does that before the
/// claim runs.
pub struct Claim<'a> {
    pub platform: Platform,
    pub config_dir: &'a str,
    pub account_config_path: &'a str,
    pub credentials: FileText<'a>,
    pub account: FileText<'a>,
    pub version: &'a str,
    pub grant_id: &'a str,
    pub request_id: &'a str,
    pub reply: Reply<'a>,
}

/// What the usage read gets from the world, and when it was made. `now_ms` is the clock the
/// shipped call reads through `DateTime.now`, and the only thing that decides whether a grant
/// has expired.
pub struct UsageRead<'a> {
    pub platform: Platform,
    pub config_dir: &'a str,
    pub version: &'a str,
    pub credentials: FileText<'a>,
    pub now_ms: f64,
    pub reply: Reply<'a>,
}

/// What the call did, in the order it did it. The three headers are the whole of what the
/// shipped request sets — `content-type` and the trace context are the transport's own doing,
/// and a golden that restated them would be evidence about the wrong layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    CredentialsFile { path: String },
    AccountFile { path: String },
    UsageRequest {
        url: String,
        authorization: String,
        beta: String,
        user_agent: String,
    },
    ClaimRequest {
        url: String,
        authorization: String,
        beta: String,
        user_agent: String,
        body: String,
    },
}

impl Effect {
    /// `withClaudeHeaders`, which both requests carry unchanged.
    fn beta() -> String {
        OAUTH_BETA.to_owned()
    }

    fn user_agent(version: &str) -> String {
        format!("claude-cli/{version} (external, cli)")
    }
}

/// What a call decided, and what it had to do to decide it.
pub struct ClaimOutcome {
    pub result: Result<ConsumeOutcome, ClaimFailure>,
    pub effects: Vec<Effect>,
}

/// What the usage read decided, and what it had to do to decide it.
pub struct ReadOutcome {
    pub credits: Option<ResetCredits>,
    pub effects: Vec<Effect>,
}

/// `claudeAccountConfigPath`: the account record beside the CLI's own directory, or in the home
/// directory when no such directory was named — and an empty one is not a directory.
#[must_use]
pub fn account_config_path(config_dir: Option<&str>, os_home: &str) -> String {
    match config_dir {
        Some(dir) if !dir.is_empty() => paths::posix_join(&[dir, ".claude.json"]),
        _ => paths::posix_join(&[os_home, ".claude.json"]),
    }
}

/// `consumeClaudeResetCredit`, less the clock, the deadline and the transport.
#[must_use]
pub fn consume_claude_reset_credit(claim: &Claim<'_>) -> ClaimOutcome {
    let mut effects = Vec::new();
    let result = claim_result(claim, &mut effects);
    ClaimOutcome { result, effects }
}

fn claim_result(claim: &Claim<'_>, effects: &mut Vec<Effect>) -> Result<ConsumeOutcome, ClaimFailure> {
    // Both ids are asked before anything is read, so a claim that cannot be named never touches
    // the account's files and never gets an id onto the wire.
    if !grant_id_ok(claim.grant_id) || !request_id_ok(claim.request_id) {
        return Err(ClaimFailure::MalformedCredit);
    }
    let token = access_token(claim.platform, claim.config_dir, claim.credentials, effects)?;
    effects.push(Effect::AccountFile {
        path: claim.account_config_path.to_owned(),
    });
    let organization = organization_uuid(claim)?;
    // The two are asked together and only after both files were opened, which is why a claim
    // with no login still reads the account record before saying it is signed out.
    let (Some(token), Some(organization)) = (token, organization) else {
        return Err(ClaimFailure::SignedOut);
    };
    effects.push(Effect::ClaimRequest {
        url: claim_url(&organization),
        authorization: format!("Bearer {token}"),
        beta: Effect::beta(),
        user_agent: Effect::user_agent(claim.version),
        body: format!(
            "{{\"program\":\"cedar_ember\",\"grant_id\":\"{}\",\"request_id\":\"{}\"}}",
            claim.grant_id, claim.request_id
        ),
    });
    decode_claim(claim.reply)
}

/// `readClaudeResetCredits`, less the clock, the deadline and the transport. The shipped
/// version ends in `Effect.orElseSucceed(() => undefined)`, so every failure it can raise —
/// an unreadable login, a redirect, a body that is not the shape — is the same answer as an
/// account with no bank: nothing at all. That is why this returns an `Option` rather than a
/// `Result`, and why the effects are the interesting half of the record.
#[must_use]
pub fn read_claude_reset_credits(read: &UsageRead<'_>) -> ReadOutcome {
    let mut effects = Vec::new();
    let credits = usage_credits(read, &mut effects);
    ReadOutcome { credits, effects }
}

fn usage_credits(read: &UsageRead<'_>, effects: &mut Vec<Effect>) -> Option<ResetCredits> {
    let token = access_token(read.platform, read.config_dir, read.credentials, effects).ok()??;
    effects.push(Effect::UsageRequest {
        url: USAGE_URL.to_owned(),
        authorization: format!("Bearer {token}"),
        beta: Effect::beta(),
        user_agent: Effect::user_agent(read.version),
    });
    let block = decode_usage_body(read.reply)?;
    claude_reset_credits_to_contract(&block, read.now_ms)
}

/// `UsageResponse = Struct({ cedar_ember: optional(NullOr(Unknown)) })` after
/// `filterStatusOk`. The struct has one optional field and `Unknown` accepts anything, so the
/// only bodies that fail this are ones that are not an object at all — and a body that fails
/// is, like every other failure here, no bank.
fn decode_usage_body(reply: Reply<'_>) -> Option<Value> {
    if !(200..=299).contains(&reply.status) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(reply.body).ok()?;
    match read::field(&parsed, "cedar_ember") {
        Field::Absent | Field::Null => None,
        Field::Value(block) => Some(block.clone()),
    }
}

/// The login the CLI keeps in its own directory. macOS keeps it in the keychain instead, and that
/// branch is taken **before** the file is opened — which is why a claim on a Mac reads the account
/// record and no credentials at all.
fn access_token(
    platform: Platform,
    config_dir: &str,
    credentials: FileText<'_>,
    effects: &mut Vec<Effect>,
) -> Result<Option<String>, ClaimFailure> {
    if platform == Platform::Darwin {
        return Ok(None);
    }
    let path = paths::posix_join(&[config_dir, ".credentials.json"]);
    effects.push(Effect::CredentialsFile { path });
    let contents = match credentials {
        FileText::Contents(text) => text,
        FileText::NotFound => "{}",
        // `Effect.mapError` turns any non-`NotFound` failure into the login message; there is no
        // second guess to make about a file the reader could not open.
        FileText::Unreadable => return Err(ClaimFailure::LoginUnreadable),
    };
    let parsed = read_json(contents, ClaimFailure::LoginUnreadable)?;
    let oauth = read::property(&parsed, "claudeAiOauth");
    Ok(trimmed_non_empty(read::as_string(read::property(
        oauth,
        "accessToken",
    ))))
}

/// `Config`'s one interesting key. A record the CLI wrote for another host's layout is the same
/// silence as no record at all.
fn organization_uuid(claim: &Claim<'_>) -> Result<Option<String>, ClaimFailure> {
    let contents = match claim.account {
        FileText::Contents(text) => text,
        FileText::NotFound => "{}",
        FileText::Unreadable => return Err(ClaimFailure::AccountUnreadable),
    };
    let parsed = read_json(contents, ClaimFailure::AccountUnreadable)?;
    let account = read::property(&parsed, "oauthAccount");
    Ok(trimmed_non_empty(read::as_string(read::property(
        account,
        "organizationUuid",
    ))))
}

/// `Schema.decodeEffect(Schema.fromJsonString(Struct))`: the file has to be JSON and it has to be
/// an object, and both failures are the stage's own message rather than an empty record. What the
/// schema does *not* question is left to the `?.…?.…` the caller writes, where a missing or
/// wrongly typed key is silence.
fn read_json(contents: &str, failure: ClaimFailure) -> Result<Value, ClaimFailure> {
    match serde_json::from_str::<Value>(contents) {
        Ok(parsed @ Value::Object(_)) => Ok(parsed),
        _ => Err(failure),
    }
}

/// `value?.trim() || undefined`, which makes a blank credential and no credential the same thing.
fn trimmed_non_empty(text: Option<&str>) -> Option<String> {
    text.map(|value| jsdate::trim_js(value).to_owned())
        .filter(|value| !value.is_empty())
}

/// `new URL(path, API_BASE)` for the path the shipped code built with
/// `encodeURIComponent(organization)`.
fn claim_url(organization: &str) -> String {
    format!(
        "https://api.anthropic.com/api/organizations/{}/reset_rate_limits",
        url_encode_component(organization)
    )
}

/// `encodeURIComponent`: everything outside the unreserved set and outside `!'()*-._~` goes, as
/// UTF-8 bytes in percent-hex uppercase.
fn url_encode_component(text: &str) -> String {
    let mut encoded = String::new();
    for character in text.chars() {
        if character.is_ascii_alphanumeric()
            || matches!(character, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')' )
        {
            encoded.push(character);
        } else {
            for byte in character.encode_utf8(&mut [0u8; 4]).as_bytes() {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    encoded
}

/// `filterStatusOk` then `Schema.decodeUnknownSync(ClaimResponse)`, with the two statuses the
/// shipped code asks about first. A body that does not say one of the six words is a failure to
/// redeem rather than a word the port does not know, so it lands on `requestFailed` like any
/// other answer that could not be read — and `requestFailed` is unsettled, which is the part
/// that matters: an unreadable answer keeps the request id for a retry.
fn decode_claim(reply: Reply<'_>) -> Result<ConsumeOutcome, ClaimFailure> {
    if reply.status == 429 {
        return Err(ClaimFailure::RateLimited);
    }
    if reply.status == 401 || reply.status == 403 {
        return Err(ClaimFailure::SignedOut);
    }
    if !(200..=299).contains(&reply.status) {
        return Err(ClaimFailure::RequestFailed);
    }
    let Ok(parsed) = serde_json::from_str::<Value>(reply.body) else {
        return Err(ClaimFailure::RequestFailed);
    };
    match read::as_string(read::property(&parsed, "result")) {
        Some("reset") => Ok(ConsumeOutcome::Reset),
        Some("not_limited") => Ok(ConsumeOutcome::NothingToReset),
        Some("already_used") => Ok(ConsumeOutcome::AlreadyRedeemed),
        Some("ineligible") => Ok(ConsumeOutcome::NoCredit),
        Some("cooldown") => Err(ClaimFailure::CoolingDown),
        // Claude could not say whether the claim landed, so, like the CLI, the request id is
        // kept and the retry asks about the same claim.
        Some("unavailable") => Err(ClaimFailure::Unconfirmed),
        _ => Err(ClaimFailure::RequestFailed),
    }
}
