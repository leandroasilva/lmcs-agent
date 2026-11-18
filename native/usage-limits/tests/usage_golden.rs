//! Replays a trace captured from the shipped usage-limit mappers — the shared rules and the
//! Claude, Codex, Cursor, Grok and OpenCode sources — so the Rust port is checked against the
//! real code rather than against a reading of it.
//!
//! Set `LMCS_USAGE_TRACE` to a trace file; the test skips when unset. Regenerate one with:
//! `node apps/server/scripts/usage-limits-trace.ts > /tmp/usage-trace.txt`
//!
//! The first four are functions of their arguments, so their fixture is an argument list.
//! OpenCode and the two Claude credit calls that read the account are not, and their fixture is
//! the world instead: the generator drove the shipped code through a pinned clock, a stubbed
//! filesystem and a stubbed client, and wrote down both what the call returned and which file it
//! opened and what it put on the wire. The replay feeds the same world to the port and compares
//! both halves.
//!
//! The trace stores each record's input as the argument list the shipped call actually got
//! and its result through `canon`, which flattens a window, a snapshot or a published
//! snapshot to `[key, value]` pairs in a fixed field order. Key order is deliberately not
//! evidence: the JavaScript spread gives each call site its own order, and the contract
//! decides what reaches the wire. The Rust side below builds the same pair lists from its own
//! types and compares them structurally, which is also why numbers are compared as values —
//! ECMAScript's `Number::toString` and Rust's shortest-round-trip formatting disagree on
//! shapes like `1e308` while meaning the same number.

use lmcs_usage_limits::claude::{
    ClaudeScopedNames, claude_rate_limit_event_to_update, claude_usage_response_to_limits,
};
use lmcs_usage_limits::claude_credits::{
    self, Claim, ClaimOutcome, Effect, FileText, Platform, ReadOutcome, Reply, UsageRead,
};
use lmcs_usage_limits::codex::{
    CodexRateLimitsFailure, codex_rate_limits_failure_message, codex_rate_limits_to_limits,
    codex_rate_limits_to_update, codex_reset_credits_to_contract, codex_usage_limit_message,
    merge_codex_rate_limits,
};
use lmcs_usage_limits::cursor::cursor_usage_response_to_limits;
use lmcs_usage_limits::grok::grok_usage_response_to_limits;
use lmcs_usage_limits::limits::{
    self, Field, ResetCredits, UnavailableReason, UsageLimits, UsageLimitsUpdate, UsageWindow,
};
use lmcs_usage_limits::opencode;
use lmcs_usage_limits::read;
use serde_json::{Value, json};

fn unhex(value: &str) -> String {
    let bytes: Vec<u8> = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect();
    String::from_utf8(bytes).expect("the trace is utf-8")
}

fn decode(hex: &str) -> Value {
    serde_json::from_str(&unhex(hex)).expect("a json payload")
}

/// The trace's spelling of a value that cannot be put in JSON.
const ABSENT: &str = "__absent";

fn absent() -> Value {
    json!({ ABSENT: true })
}

/// Re-encode a Rust float the way the generator writes one, so a `NaN` percent and the
/// `{"__number":"NaN"}` beside it are the same value here. A signed zero is written `0`, as
/// `JSON.stringify` does.
fn number(value: f64) -> Value {
    if value.is_nan() {
        return json!({ "__number": "NaN" });
    }
    if value == f64::INFINITY {
        return json!({ "__number": "Infinity" });
    }
    if value == f64::NEG_INFINITY {
        return json!({ "__number": "-Infinity" });
    }
    Value::from(value + 0.0)
}

fn text_field(field: &Field<String>) -> Value {
    match field {
        Field::Absent => Value::Null,
        Field::Null => Value::Null,
        Field::Value(text) => Value::String(text.clone()),
    }
}

/// `canonWindow`: the four required fields always, the two optional ones only when written.
fn canon_window(window: &UsageWindow) -> Value {
    let mut pairs = vec![
        json!(["id", window.id]),
        json!(["kind", window.kind.as_str()]),
        json!(["label", window.label]),
        json!(["usedPercent", number(window.used_percent)]),
    ];
    if window.resets_at.is_written() {
        pairs.push(json!(["resetsAt", text_field(&window.resets_at)]));
    }
    if window.window_duration_mins.is_written() {
        pairs.push(json!([
            "windowDurationMins",
            match &window.window_duration_mins {
                Field::Value(mins) => number(*mins),
                Field::Null => Value::Null,
                Field::Absent => unreachable!("guarded above"),
            }
        ]));
    }
    Value::Array(pairs)
}

fn canon_windows(windows: &[UsageWindow]) -> Value {
    Value::Array(windows.iter().map(canon_window).collect())
}

/// `canonLimits`.
fn canon_limits(limits: &UsageLimits) -> Value {
    let mut pairs = vec![
        json!(["checkedAt", limits.checked_at]),
        json!(["windows", canon_windows(&limits.windows)]),
    ];
    if let Some(credits) = &limits.reset_credits {
        pairs.push(json!(["resetCredits", canon_credits_pairs(credits)]));
    }
    if let Some(unavailable) = &limits.unavailable {
        let mut reason = vec![json!(["reason", unavailable.reason.as_str()])];
        if unavailable.message.is_written() {
            reason.push(json!(["message", text_field(&unavailable.message)]));
        }
        pairs.push(json!(["unavailable", reason]));
    }
    Value::Array(pairs)
}

/// A reset-credits summary as the generator sees it: a plain object, not pairs, because
/// `canon` has no rule for it.
fn canon_credits_pairs(credits: &ResetCredits) -> Value {
    let mut pairs = vec![json!(["availableCount", number(credits.available_count)])];
    if credits.next_expires_at.is_written() {
        pairs.push(json!([
            "nextExpiresAt",
            text_field(&credits.next_expires_at)
        ]));
    }
    // Only Claude names the credit a redeem is pinned to; Codex leaves the key out.
    if credits.next_credit_id.is_written() {
        pairs.push(json!(["nextCreditId", text_field(&credits.next_credit_id)]));
    }
    Value::Array(pairs)
}

fn canon_credits(credits: &ResetCredits) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("availableCount".to_owned(), number(credits.available_count));
    if credits.next_expires_at.is_written() {
        object.insert(
            "nextExpiresAt".to_owned(),
            text_field(&credits.next_expires_at),
        );
    }
    if credits.next_credit_id.is_written() {
        object.insert(
            "nextCreditId".to_owned(),
            text_field(&credits.next_credit_id),
        );
    }
    Value::Object(object)
}

fn canon_opt_limits(limits: Option<UsageLimits>) -> Value {
    limits.map_or_else(absent, |limits| canon_limits(&limits))
}

fn canon_update(update: &UsageLimitsUpdate) -> Value {
    json!([["windows", canon_windows(&update.windows)]])
}

fn canon_opt_update(update: Option<UsageLimitsUpdate>) -> Value {
    update.map_or_else(absent, |update| canon_update(&update))
}

fn canon_opt_credits(credits: Option<ResetCredits>) -> Value {
    credits.map_or_else(absent, |credits| canon_credits(&credits))
}

/// `canonSnapshot`. An explicit `null` is a written field and is kept; only an absent key
/// disappears.
fn canon_snapshot(snapshot: &Value) -> Value {
    let mut pairs = Vec::new();
    for field in [
        "limitId",
        "planType",
        "rateLimitReachedType",
        "primary",
        "secondary",
    ] {
        if let written @ (Field::Null | Field::Value(_)) = read::field(snapshot, field) {
            pairs.push(json!([
                field,
                match written {
                    Field::Value(value) => value.clone(),
                    // `Field::Absent` cannot reach here; the pattern above is the guard.
                    _ => Value::Null,
                }
            ]));
        }
    }
    Value::Array(pairs)
}

fn canon_opt_snapshot(snapshot: Option<Value>) -> Value {
    snapshot.map_or_else(absent, |snapshot| canon_snapshot(&snapshot))
}

/// Structural equality, with numbers compared by value and non-finite ones already tagged.
fn json_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => match (left.as_f64(), right.as_f64()) {
            (Some(left), Some(right)) => left == right,
            _ => left.to_string() == right.to_string(),
        },
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| json_eq(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| json_eq(value, other)))
        }
        _ => left == right,
    }
}

fn arg(input: &Value, index: usize) -> Value {
    input
        .as_array()
        .and_then(|args| args.get(index))
        .cloned()
        .unwrap_or(Value::Null)
}

fn required_string(value: &Value, key: &str) -> String {
    read::as_string(value)
        .unwrap_or_else(|| panic!("{key} is a string in every fixture"))
        .to_owned()
}

/// Every fixture table calls this with the same `checkedAt`, so a missing one is a broken
/// fixture rather than a case to handle.
fn checked_at(input: &Value) -> String {
    required_string(read::property(input, "checkedAt"), "checkedAt")
}

/// The Cursor and Grok mappers take the timestamp as a second argument, since their response
/// body is the provider's own shape and has no room for one.
fn second_argument(input: &Value) -> String {
    required_string(&arg(input, 1), "checkedAt")
}

/// Claude's credit tables take the instant the same way, as a reading of the clock rather than
/// a timestamp string, because a grant is live only strictly after it.
fn second_number_argument(input: &Value) -> f64 {
    read::as_number(&arg(input, 1)).expect("a credit table names the instant")
}

/// The three keys that are members of the shipped `WINDOWS` object through its prototype
/// chain, and therefore draw a row there that the contract cannot describe.
const PROTOTYPE_KEYS: [&str; 3] = ["constructor", "toString", "__proto__"];

/// Run one record through the port and return what it decided, in the trace's own shape.
fn replay(module: &str, name: &str, input: &Value) -> (Value, Option<&'static str>) {
    let first = arg(input, 0);
    match (module, name) {
        ("core", "clampPercent") => (
            number(limits::clamp_percent(
                read::as_number(&first).expect("a number under test"),
            )),
            None,
        ),
        (
            "core",
            "makeUsageLimits.sort" | "makeUsageLimits.idOrder" | "makeUsageLimits.emptyIterable",
        ) => {
            let windows = read::array(&first, "windows")
                .iter()
                .map(|window| read::window_from_value(window))
                .collect::<Vec<_>>();
            (
                canon_limits(&limits::make_usage_limits(checked_at(&first), windows)),
                None,
            )
        }
        ("core", "makeUnavailableUsageLimits") => {
            let reason = required_string(read::property(&first, "reason"), "reason");
            let message = read::optional_string(&first, "message").into_value();
            (
                canon_limits(&limits::make_unavailable_usage_limits(
                    checked_at(&first),
                    UnavailableReason::parse(&reason).expect("a declared reason"),
                    message,
                )),
                None,
            )
        }
        ("core", "applyUsageLimitsUpdate") => {
            let previous = match read::field(&first, "previous") {
                Field::Absent | Field::Null => None,
                Field::Value(value) => Some(read::limits_from_value(value)),
            };
            let update = read::update_from_value(read::property(&first, "update"));
            (
                canon_opt_limits(limits::apply_usage_limits_update(
                    previous.as_ref(),
                    &update,
                    &checked_at(&first),
                )),
                None,
            )
        }
        ("core", "resolveUsageLimitsAfterProbe") => {
            let published = match read::field(&first, "published") {
                Field::Absent | Field::Null => None,
                Field::Value(value) => Some(read::limits_from_value(value)),
            };
            let probed = match read::field(&first, "probed") {
                Field::Absent | Field::Null => None,
                Field::Value(value) => Some(read::limits_from_value(value)),
            };
            (
                canon_opt_limits(limits::resolve_usage_limits_after_probe(
                    published.as_ref(),
                    probed.as_ref(),
                )),
                None,
            )
        }
        ("claude", "claudeRateLimitEventToUpdate") => {
            let names = read::optional_string(&arg(input, 1), "overageIncluded").into_value();
            let produced = claude_rate_limit_event_to_update(
                &first,
                &ClaudeScopedNames {
                    overage_included: names,
                },
            );
            let deviation = read::as_string(read::property(&first, "rateLimitType"))
                .filter(|kind| PROTOTYPE_KEYS.contains(kind))
                .map(|_| "a prototype key names a window the contract cannot carry");
            (canon_opt_update(produced), deviation)
        }
        (
            "claude",
            "claudeUsageResponseToLimits"
            | "claudeUsageResponseToLimits.resetsAt"
            | "claudeUsageResponseToLimits.scopedId",
        ) => {
            let (limits, names) = claude_usage_response_to_limits(&first);
            let mut object = serde_json::Map::new();
            object.insert("limits".to_owned(), canon_limits(&limits));
            let mut names_object = serde_json::Map::new();
            if let Some(overage_included) = &names.overage_included {
                names_object.insert(
                    "overageIncluded".to_owned(),
                    Value::String(overage_included.clone()),
                );
            }
            object.insert("names".to_owned(), Value::Object(names_object));
            (Value::Object(object), None)
        }
        (
            "codex",
            "codexRateLimitsToLimits"
            | "codexRateLimitsToLimits.byLimitId"
            | "codexRateLimitsToLimits.emptyLimitIdMap",
        ) => (canon_limits(&codex_rate_limits_to_limits(&first)), None),
        ("codex", "codexRateLimitsToUpdate") => {
            (canon_opt_update(codex_rate_limits_to_update(&first)), None)
        }
        ("codex", "codexResetCreditsToContract") => (
            canon_opt_credits(codex_reset_credits_to_contract(&first)),
            None,
        ),
        ("codex", "mergeCodexRateLimits") => {
            let previous = arg(input, 0);
            let previous = match previous {
                Value::Null => None,
                value => Some(value),
            };
            (
                canon_opt_snapshot(merge_codex_rate_limits(previous.as_ref(), &arg(input, 1))),
                None,
            )
        }
        ("codex", "codexRateLimitsFailureMessage") => {
            let tag = required_string(read::property(&first, "_tag"), "_tag");
            let failure = match tag.as_str() {
                "CodexAppServerRequestError" => CodexRateLimitsFailure::Request {
                    code: read::as_number(read::property(&first, "code")).expect("an rpc code"),
                },
                "CodexAppServerSpawnError" => CodexRateLimitsFailure::Spawn,
                "CodexAppServerProcessExitedError" => CodexRateLimitsFailure::ProcessExited,
                "CodexAppServerProtocolParseError"
                | "CodexAppServerTransportError"
                | "CodexAppServerInputStreamEndedError"
                | "CodexAppServerIdentifierGenerationError" => CodexRateLimitsFailure::Other,
                other => panic!("an unmapped Codex error tag {other:?}"),
            };
            (
                Value::String(codex_rate_limits_failure_message(&failure)),
                None,
            )
        }
        ("codex", "codexUsageLimitMessage" | "codexUsageLimitMessage.nextStep") => (
            Value::String(codex_usage_limit_message(
                &first,
                read::as_string(&arg(input, 1)).expect("an event timestamp"),
            )),
            None,
        ),
        (
            "credits",
            "claudeResetCreditsToContract.shape"
            | "claudeResetCreditsToContract.grant"
            | "claudeResetCreditsToContract.timestamp"
            | "claudeResetCreditsToContract.nextGrant",
        ) => (
            canon_opt_credits(claude_credits::claude_reset_credits_to_contract(
                &first,
                second_number_argument(input),
            )),
            None,
        ),
        (
            "credits",
            "consumeClaudeResetCredit.ids"
            | "consumeClaudeResetCredit.credentials"
            | "consumeClaudeResetCredit.account"
            | "consumeClaudeResetCredit.status"
            | "consumeClaudeResetCredit.request",
        ) => (canon_claim(&claim_outcome(&first)), None),
        (
            "credits",
            "readClaudeResetCredits.bank"
            | "readClaudeResetCredits.credentials"
            | "readClaudeResetCredits.status",
        ) => (canon_read(&read_outcome(&first)), None),
        ("credits", "claudeAccountConfigPath") => {
            // The second branch of the shipped function is this machine's home directory, so no
            // row takes it; the port's own unit test decides an absent or empty directory.
            let config_dir = read::as_string(&first);
            (
                Value::String(claude_credits::account_config_path(
                    config_dir,
                    "/host/home",
                )),
                None,
            )
        }
        (
            "cursor",
            "cursorUsageResponseToLimits.billingCycleEnd" | "cursorUsageResponseToLimits.planUsage",
        ) => (
            canon_limits(&cursor_usage_response_to_limits(
                &first,
                &second_argument(input),
            )),
            None,
        ),
        (
            "grok",
            "grokUsageResponseToLimits.config"
            | "grokUsageResponseToLimits.creditUsagePercent"
            | "grokUsageResponseToLimits.currentPeriod",
        ) => (
            canon_limits(&grok_usage_response_to_limits(
                &first,
                &second_argument(input),
            )),
            None,
        ),
        ("opencode", _) => (canon_opencode(&opencode_outcome(&first)), None),
        (module, name) => panic!("no port wired up for {module} {name}"),
    }
}

/// The OpenCode fixtures are the whole world the shipped call saw: the gate's two arguments,
/// the environment it read, what `auth.json` answered, and what the endpoint answered. The
/// port gets the same fixture, and the record it is checked against carries the side effects
/// as well as the limits, because which file was opened and what went on the wire are half of
/// what the read decides.
fn opencode_outcome(fixture: &Value) -> opencode::Outcome {
    let server_url = required_string(read::property(fixture, "serverUrl"), "serverUrl");
    let checked_at = required_string(read::property(fixture, "checkedAt"), "checkedAt");
    let environment = opencode_environment(read::property(fixture, "environment"));
    let probe = opencode::Probe {
        enabled: read::property(fixture, "enabled")
            .as_bool()
            .expect("the gate is a boolean"),
        server_url: &server_url,
        environment: &environment,
        // No row reaches it, since every fixture names a home or an `XDG_DATA_HOME`. A port
        // that consulted the host's own answer first would draw a different `authPath`.
        os_home: "/host/home",
        auth_file: opencode_auth_file(read::property(fixture, "authFile")),
        response: opencode_response(read::property(fixture, "response")),
    };
    opencode::read_opencode_go_usage_limits(&probe, &checked_at)
}

/// `process.env`, as far as this read can see it. A key the fixture left out is a key the
/// environment does not have, which is how the generator writes `undefined`.
fn opencode_environment(value: &Value) -> opencode::Environment<'_> {
    let mut values = opencode::Environment::new();
    if let Value::Object(object) = value {
        for (name, value) in object {
            if let Value::String(text) = value {
                values.insert(name.as_str(), text.as_str());
            }
        }
    }
    values
}

/// The three answers the read can get from the filesystem. An empty file is `contents`, not
/// an absence, so the key's presence decides rather than its truthiness.
fn opencode_auth_file(value: &Value) -> opencode::AuthFile<'_> {
    if let Field::Value(contents) = read::field(value, "contents") {
        return opencode::AuthFile::Contents(
            read::as_string(contents).expect("the auth file is text"),
        );
    }
    if read::truthy(read::property(value, "notFound")) {
        return opencode::AuthFile::NotFound;
    }
    assert!(
        read::truthy(read::property(value, "blocked")),
        "an auth file is present, missing, or unreadable"
    );
    opencode::AuthFile::Unreadable
}

/// A response with no `body` on the input line is a response that had none, which reaches the
/// shipped schema as the empty text it then refuses to parse.
fn opencode_response(value: &Value) -> opencode::Response<'_> {
    opencode::Response {
        status: read::as_number(read::property(value, "status")).expect("a status number") as u16,
        body: read::as_string(read::property(value, "body")).unwrap_or_default(),
    }
}

/// `{limits, effects}`, in the shape `canon` left it. The effect objects stay plain objects,
/// which is what the generator's `canon` does to anything it has no rule for.
fn canon_opencode(outcome: &opencode::Outcome) -> Value {
    let effects: Vec<Value> = outcome
        .effects
        .iter()
        .map(|effect| match effect {
            opencode::Effect::AuthFile { path } => json!({ "authPath": path }),
            opencode::Effect::UsageRequest { authorization } => {
                json!({ "url": opencode::USAGE_URL, "authorization": authorization })
            }
        })
        .collect();
    json!({ "limits": canon_limits(&outcome.limits), "effects": effects })
}

/// The claim's world: the platform the login would live on, the two files and what they
/// answered, the ids and version the shipped caller passed in, and the one reply the endpoint
/// gave. As with OpenCode, the record compares the effects as well, because a claim that was
/// never sent is a different decision from one that came back `unavailable`.
fn claim_outcome(fixture: &Value) -> ClaimOutcome {
    let config_dir = required_string(read::property(fixture, "configDir"), "configDir");
    let account_config_path = required_string(
        read::property(fixture, "accountConfigPath"),
        "accountConfigPath",
    );
    let version = required_string(read::property(fixture, "version"), "version");
    let grant_id = required_string(read::property(fixture, "grantId"), "grantId");
    let request_id = required_string(read::property(fixture, "requestId"), "requestId");
    let reply = credit_reply(read::property(fixture, "reply"));
    let claim = Claim {
        platform: credit_platform(read::property(fixture, "platform")),
        config_dir: &config_dir,
        account_config_path: &account_config_path,
        credentials: credit_file(read::property(fixture, "credentials")),
        account: credit_file(read::property(fixture, "account")),
        version: &version,
        grant_id: &grant_id,
        request_id: &request_id,
        reply,
    };
    claude_credits::consume_claude_reset_credit(&claim)
}

/// The usage read's world, which is the claim's with the account record left out — the read
/// asks the endpoint for the bank and never needs to know who owns the login.
fn read_outcome(fixture: &Value) -> ReadOutcome {
    let config_dir = required_string(read::property(fixture, "configDir"), "configDir");
    let version = required_string(read::property(fixture, "version"), "version");
    let now_ms = read::as_number(read::property(fixture, "nowMs"))
        .expect("every read fixture names the instant it was made at");
    let reply = credit_reply(read::property(fixture, "reply"));
    let usage_read = UsageRead {
        platform: credit_platform(read::property(fixture, "platform")),
        config_dir: &config_dir,
        version: &version,
        credentials: credit_file(read::property(fixture, "credentials")),
        now_ms,
        reply,
    };
    claude_credits::read_claude_reset_credits(&usage_read)
}

/// The pinned `HostProcessPlatform`. A row could leave it to the generating machine, which
/// would make the trace a fact about the laptop that ran the script.
fn credit_platform(value: &Value) -> Platform {
    match required_string(value, "platform").as_str() {
        "darwin" => Platform::Darwin,
        _ => Platform::Other,
    }
}

/// The three answers a file read can give. As in OpenCode's `authFile`, an empty file is
/// `contents` and not an absence, so the key's presence decides rather than its truthiness.
fn credit_file(value: &Value) -> FileText<'_> {
    if let Field::Value(contents) = read::field(value, "contents") {
        return FileText::Contents(read::as_string(contents).expect("a credit file is text"));
    }
    if read::truthy(read::property(value, "notFound")) {
        return FileText::NotFound;
    }
    assert!(
        read::truthy(read::property(value, "blocked")),
        "a credit file is present, missing, or unreadable"
    );
    FileText::Unreadable
}

/// A reply with no `body` is one that had none — a `204`, which reaches the shipped schema as
/// the empty text it then refuses to parse.
fn credit_reply(value: &Value) -> Reply<'_> {
    Reply {
        status: read::as_number(read::property(value, "status")).expect("a status number") as u16,
        body: read::as_string(read::property(value, "body")).unwrap_or_default(),
    }
}

fn canon_effects(effects: &[Effect]) -> Vec<Value> {
    effects
        .iter()
        .map(|effect| match effect {
            Effect::CredentialsFile { path } => json!({ "credentialsFile": path }),
            Effect::AccountFile { path } => json!({ "accountFile": path }),
            Effect::UsageRequest {
                url,
                authorization,
                beta,
                user_agent,
            } => json!({
                "request": {
                    "method": "GET",
                    "url": url,
                    "authorization": authorization,
                    "beta": beta,
                    "userAgent": user_agent,
                }
            }),
            Effect::ClaimRequest {
                url,
                authorization,
                beta,
                user_agent,
                body,
            } => json!({
                "request": {
                    "method": "POST",
                    "url": url,
                    "authorization": authorization,
                    "beta": beta,
                    "userAgent": user_agent,
                    "body": body,
                }
            }),
        })
        .collect()
}

/// What the claim decided, in the shape the harness wrote it. A failure is recorded as its
/// reason, its sentence and whether the caller may forget it; a success leaves all three null
/// rather than leaving them out, because the harness spread one object over both branches.
fn canon_claim(outcome: &ClaimOutcome) -> Value {
    let (result, failure, message, settled) = match outcome.result {
        Ok(outcome) => (
            json!(outcome.as_str()),
            Value::Null,
            Value::Null,
            Value::Null,
        ),
        Err(failure) => (
            Value::Null,
            json!(failure.as_str()),
            json!(failure.message()),
            json!(failure.is_settled()),
        ),
    };
    json!({
        "outcome": result,
        "failure": failure,
        "message": message,
        "settled": settled,
        "effects": canon_effects(&outcome.effects),
    })
}

/// `{credits, effects}`. The shipped read turns every failure into "no resets", so an account
/// with no bank and an unreadable login are the same answer here, and only the effects say
/// which of the two the call was.
fn canon_read(outcome: &ReadOutcome) -> Value {
    json!({
        "credits": match &outcome.credits {
            Some(credits) => canon_credits(credits),
            None => absent(),
        },
        "effects": canon_effects(&outcome.effects),
    })
}

struct Record {
    module: String,
    name: String,
    input: Value,
    expected: Value,
}

fn records(text: &str) -> Vec<Record> {
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(lines.len() % 3, 0, "every record is a C/I/R triple");
    lines
        .chunks(3)
        .map(|chunk| {
            let mut fields = chunk[0].split(' ');
            assert_eq!(fields.next(), Some("C"), "a record starts with C");
            let module = fields.next().expect("a module").to_owned();
            let name = fields.next().expect("a function").to_owned();
            assert!(
                fields.next().is_none(),
                "a record names module and function"
            );
            assert!(chunk[1].starts_with("I "), "the second line is the input");
            assert!(chunk[2].starts_with("R "), "the third line is the result");
            Record {
                module,
                name,
                input: decode(&chunk[1][2..]),
                expected: decode(&chunk[2][2..]),
            }
        })
        .collect()
}

/// What the shipped code decides, per function. The counts are the trace's own partition: a
/// fixture table that stops being replayed would otherwise lower the bar silently.
const EXPECTED_COUNTS: &[(&str, usize)] = &[
    ("opencode readOpenCodeGoUsageLimits.credentials", 88),
    ("cursor cursorUsageResponseToLimits.billingCycleEnd", 59),
    ("credits claudeResetCreditsToContract.timestamp", 46),
    ("claude claudeRateLimitEventToUpdate", 44),
    ("claude claudeUsageResponseToLimits.resetsAt", 37),
    ("credits claudeResetCreditsToContract.grant", 37),
    ("codex codexUsageLimitMessage", 36),
    ("opencode readOpenCodeGoUsageLimits.resetsAt", 35),
    ("codex codexRateLimitsToLimits", 31),
    ("codex codexRateLimitsToUpdate", 31),
    ("grok grokUsageResponseToLimits.currentPeriod", 31),
    ("cursor cursorUsageResponseToLimits.planUsage", 24),
    ("opencode readOpenCodeGoUsageLimits.authFile", 21),
    ("codex codexResetCreditsToContract", 20),
    ("credits claudeResetCreditsToContract.shape", 20),
    ("credits readClaudeResetCredits.status", 20),
    ("credits consumeClaudeResetCredit.status", 17),
    ("grok grokUsageResponseToLimits.creditUsagePercent", 17),
    ("opencode readOpenCodeGoUsageLimits.percent", 17),
    ("claude claudeUsageResponseToLimits", 16),
    ("opencode readOpenCodeGoUsageLimits.padding", 16),
    ("credits consumeClaudeResetCredit.credentials", 14),
    ("credits consumeClaudeResetCredit.request", 14),
    ("opencode readOpenCodeGoUsageLimits.gate", 14),
    ("opencode readOpenCodeGoUsageLimits.status", 14),
    ("opencode readOpenCodeGoUsageLimits.usageBody", 13),
    ("claude claudeUsageResponseToLimits.scopedId", 12),
    ("core applyUsageLimitsUpdate", 12),
    ("credits claudeResetCreditsToContract.nextGrant", 12),
    ("core clampPercent", 11),
    ("opencode readOpenCodeGoUsageLimits.authPath", 11),
    ("credits claudeAccountConfigPath", 10),
    ("codex codexUsageLimitMessage.nextStep", 9),
    ("credits consumeClaudeResetCredit.account", 9),
    ("credits consumeClaudeResetCredit.ids", 9),
    ("core resolveUsageLimitsAfterProbe", 8),
    ("credits readClaudeResetCredits.bank", 8),
    ("codex codexRateLimitsFailureMessage", 7),
    ("codex mergeCodexRateLimits", 7),
    ("credits readClaudeResetCredits.credentials", 5),
    ("core makeUnavailableUsageLimits", 4),
    ("grok grokUsageResponseToLimits.config", 4),
    ("opencode readOpenCodeGoUsageLimits.overlay", 2),
    ("codex codexRateLimitsToLimits.byLimitId", 1),
    ("codex codexRateLimitsToLimits.emptyLimitIdMap", 1),
    ("core makeUsageLimits.emptyIterable", 1),
    ("core makeUsageLimits.idOrder", 1),
    ("core makeUsageLimits.sort", 1),
];
const EXPECTED_TOTAL: usize = 877;

#[test]
fn replays_the_shipped_usage_limit_decisions() {
    let Ok(path) = std::env::var("LMCS_USAGE_TRACE") else {
        eprintln!(
            "skipping the usage-limits golden: set LMCS_USAGE_TRACE to a trace from \
             apps/server/scripts/usage-limits-trace.ts"
        );
        return;
    };
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read the trace at {}: {error}", path));
    let records = records(&text);

    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for record in &records {
        *counts
            .entry(format!("{} {}", record.module, record.name))
            .or_default() += 1;
    }
    assert_eq!(
        counts.len(),
        EXPECTED_COUNTS.len(),
        "the trace replayed {counts:?}, which is not the wired-up set"
    );
    for (label, expected) in EXPECTED_COUNTS {
        assert_eq!(
            counts.get(*label).copied().unwrap_or_default(),
            *expected,
            "{label} is not the table the trace captured"
        );
    }
    assert_eq!(records.len(), EXPECTED_TOTAL, "the trace's record count");

    let mut deviations = 0;
    for record in &records {
        let (produced, deviation) = replay(&record.module, &record.name, &record.input);
        if let Some(reason) = deviation {
            // A deviation has to stay visible: the shipped answer must not already be the
            // one the port gives, or the entry is papering over a port that changed.
            assert!(
                !json_eq(&record.expected, &absent()),
                "{} {:?} was expected to deviate but matches",
                record.name,
                record.input
            );
            deviations += 1;
            assert!(
                json_eq(&produced, &absent()),
                "{reason} for {:?}, got {produced}",
                record.input
            );
            continue;
        }
        assert!(
            json_eq(&produced, &record.expected),
            "{} {} differed\n  input    {}\n  shipped  {}\n  rust     {}",
            record.module,
            record.name,
            record.input,
            record.expected,
            produced
        );
    }
    assert_eq!(
        deviations, 6,
        "the prototype-key events are six records; a different count means the \
         deviation list no longer describes the trace"
    );
}
