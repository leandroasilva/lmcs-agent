//! The gate's golden: replay the recorded refusals, frame for frame, through the port's dispatch.
//!
//! `LMCS_SCOPE_GOLDEN=/path/to/scope-golden.json cargo test --test scope_golden`
//!
//! [`session_golden`](session_golden.rs) replays a server with no table in front of it, which is what an
//! envelope measurement needs; this file replays the server a client actually meets: the same switch with
//! [`Gate`] wired in, so a request the credential does not cover answers as the rpc's own typed failure
//! instead of running. The capture is `apps/server/scripts/scope-golden.ts`, which served a group whose
//! handlers were wrapped by `ws.ts:605-618`'s `authorizeEffect`/`authorizeStream` verbatim, called each one
//! over a real socket, and wrote down the bytes.
//!
//! Three claims the artifact decided and this file therefore refuses to restate as prose:
//!
//! - **A refusal is an ordinary `Exit`.** Every denied case is `Failure`/`Fail` carrying
//!   `EnvironmentAuthorizationError` with its three keys in that order, for subscriptions as much as for
//!   effects, and the connection keeps answering afterwards (`probe.deniedThenCanary`).
//! - **A method the table omits is not a refusal.** `vcs.deleteBranch` is registered by `WsRpcGroup` and
//!   missing from `RPC_REQUIRED_SCOPES`, so the lookup throws while the handler is still being built: the
//!   client reads a broadcast `Defect` with no `requestId` and then nothing at all, because the socket stayed
//!   open and simply stopped replying.
//! - **`device.list` is gated by its payload**, and its `inspectOnly` branch reaches a handler without any
//!   scope at all (`list.inspectOnly` ran on an empty credential) and outranks `retryHostId` even when that
//!   field is present (`list.inspectOnlyOutranksRetry`).
//!
//! Three exemptions, declared rather than papered over. The probe cases name the method they probe in their
//! **payload** — the oracle's `device.detail` handler gates on `requiredScopeForRpcMethod(input.method)`, a
//! device for reaching an arbitrary lookup through the real table, while `ws.ts:3542` gates on the rpc's own
//! name. Each probe request is therefore replayed with its `tag` rewritten to the method it names and that
//! name registered as a handler, which keeps the two conditions the shipped server had: a handler exists, and
//! the table covers it or does not. `subscribeNoError` is the counterfactual for an rpc whose *exit schema
//! cannot carry* the failure — the server answers `Failure`/`Die`/`"Expected never"`, which is the serializer
//! refusing the error rather than the gate producing another shape — and no method of the real group is like
//! that, which is what `summary.authInExit` and `methodsWithoutExit` are read for below. `streamNoError.granted`
//! is stream framing rather than gating, and `session_golden` already replays that shape as `a.streamBatched`.

use std::collections::BTreeMap;
use std::env;
use std::fs;

use lmcs_protocol::envelope::Message;
use lmcs_protocol::headers::Pair;
use lmcs_protocol::session::{Gate, Group, Outcome, Payload, Session};
use lmcs_protocol::{json, scopes};
use serde_json::{Value, map};

/// The oracle's device for reaching an arbitrary lookup through the real table.
const PROBE: &str = "device.detail";

/// The real method the two synthetic subscriptions stand in for, so the gate consults a table row.
const SUBSCRIBED: &str = "subscribeDeviceState";

/// The one registered handler the shipped table does not cover, per `summary.groupOnly`.
const UNDECLARED: &str = "vcs.deleteBranch";

/// Cases the replay does not answer, for the two reasons the header declares: `streamNoError.denied` and
/// `.deniedThenCanary` measure an exit schema that cannot carry the refusal, and `streamNoError.granted`
/// measures stream framing.
const EXEMPT: [&str; 3] = [
    "streamNoError.denied",
    "streamNoError.deniedThenCanary",
    "streamNoError.granted",
];

/// The number of cases the replay answers, so a case the generator added is either compared or missed
/// out loud rather than filtered away by a name this file never learned.
const REPLAYED: usize = 19;

struct Case {
    scopes: Vec<String>,
    asks: Vec<String>,
    answers: Vec<String>,
    answered: bool,
    canary: bool,
}

fn text(row: &Value, key: &str) -> String {
    row[key]
        .as_str()
        .unwrap_or_else(|| panic!("the capture holds a {key} for every frame"))
        .to_owned()
}

fn boolean(row: &Value, key: &str, case: &str) -> bool {
    row[key]
        .as_bool()
        .unwrap_or_else(|| panic!("counts[{case}] lost {key}"))
}

/// The capture, in the shape the replay needs: each case's credential, its requests and its answers paired
/// by index (the client awaited every call), and whether the follow-up got through.
fn artifact() -> Option<(Value, BTreeMap<String, Case>)> {
    let path = env::var_os("LMCS_SCOPE_GOLDEN")?;
    let document: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("the scope golden is readable"))
            .expect("the scope golden is JSON");
    let mut cases: BTreeMap<String, Case> = BTreeMap::new();
    for frame in document["wire"].as_array().expect("a wire array") {
        let name = text(frame, "case");
        let case = cases.entry(name).or_insert_with(|| Case {
            scopes: Vec::new(),
            asks: Vec::new(),
            answers: Vec::new(),
            answered: false,
            canary: false,
        });
        if text(frame, "direction") == "c2s" {
            case.asks.push(text(frame, "frame"));
        } else {
            case.answers.push(text(frame, "frame"));
        }
    }
    let rows = document["counts"].as_object().expect("a counts object");
    for (name, row) in rows {
        let case = cases
            .get_mut(name)
            .unwrap_or_else(|| panic!("counts names a case the wire never produced: {name}"));
        case.scopes = row["scopes"]
            .as_array()
            .expect("a scopes array per case")
            .iter()
            .map(|scope| scope.as_str().expect("a scope is a string").to_owned())
            .collect();
        case.answered = boolean(row, "answered", name);
        case.canary = boolean(row, "canary", name);
        // The frames this file pairs by index are only comparable if the capture it read is the capture the
        // generator counted, which is the claim `summary.cases` makes for the whole run.
        assert_eq!(
            row["c2s"].as_u64().expect("a c2s count") as usize,
            case.asks.len(),
            "{name} does not hold the requests the generator counted",
        );
        assert_eq!(
            row["s2c"].as_u64().expect("an s2c count") as usize,
            case.answers.len(),
            "{name} does not hold the answers the generator counted",
        );
    }
    Some((document, cases))
}

fn row(n: i64) -> Value {
    let mut fields = map::Map::new();
    fields.insert("i".to_owned(), Value::from(n));
    Value::Object(fields)
}

fn member<'a>(payload: &'a Payload, key: &str) -> Option<&'a Value> {
    payload.as_ref().and_then(|value| value.get(key))
}

/// `{scope: <method>}`, the probe's own success shape, read back off the payload it was sent with. The
/// granted cases are compared as bytes, so an answer invented here would fail rather than pass quietly.
fn echo_scope(payload: &Payload, _: &[Pair]) -> Outcome {
    let mut fields = map::Map::new();
    fields.insert(
        "scope".to_owned(),
        member(payload, "method").cloned().unwrap_or(Value::Null),
    );
    Outcome::Success(Value::Object(fields))
}

/// `ws.ts:3513-3529`'s four answers, chosen by the same truthiness the shipped handler uses: an empty string
/// is the field being absent, and `inspectOnly` outranks them until `updateTool` says otherwise.
fn list_ran(payload: &Payload, _: &[Pair]) -> Outcome {
    let given = |key: &str| match member(payload, key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    };
    let inspecting = matches!(member(payload, "inspectOnly"), Some(Value::Bool(true)));
    let ran = if inspecting && given("updateTool").is_none() {
        "inspect"
    } else if given("updateTool").is_some() {
        "updateTool"
    } else if given("retryHostId").is_some() {
        "retryHost"
    } else {
        "list"
    };
    let mut fields = map::Map::new();
    fields.insert("ran".to_owned(), Value::String(ran.to_owned()));
    Outcome::Success(Value::Object(fields))
}

/// The group the recording ran, minus its services. The probe names the payload can carry are all
/// registered, because in the shipped server the *handler* existed for every one of them and only the table
/// was missing — which is the difference this replay is built to keep visible.
fn captured_group() -> Group {
    Group::new()
        .on(PROBE, echo_scope)
        .on("device.open", echo_scope)
        .on("no.such.method", echo_scope)
        .on("toString", echo_scope)
        .on("", echo_scope)
        .on("device.list", list_ran)
        .returns("vcs.deleteBranch", Value::Null)
        .streams(SUBSCRIBED, vec![vec![row(1)], vec![row(2)]])
}

/// One recorded request, with its `tag` replaced by the name the gate is asked about. Everything else — the
/// id, the payload, the trace fields the client wrote — stays the recording's own text, since the loop is
/// what is under test and the frame is not.
fn retarget(ask: &str) -> (String, String) {
    let request: Value = serde_json::from_str(ask).expect("a recorded request parses");
    let tag = match request["tag"].as_str() {
        Some(PROBE) => request["payload"]["method"]
            .as_str()
            .unwrap_or_else(|| panic!("the probe case carried no method: {ask}"))
            .to_owned(),
        Some("subscribeAuthError" | "subscribeNoError") => SUBSCRIBED.to_owned(),
        Some(tag) => tag.to_owned(),
        None => panic!("a recorded request carries a tag: {ask}"),
    };
    let mut retargeted = request;
    retargeted["tag"] = Value::String(tag.clone());
    (retargeted.to_string(), tag)
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one replay, written as the loop over the capture it is reading"
)]
fn every_recorded_refusal_is_the_ports_own_bytes() {
    let Some((_, cases)) = artifact() else {
        eprintln!("skipping: LMCS_SCOPE_GOLDEN is unset");
        return;
    };
    let mut replayed = 0;
    for (name, case) in &cases {
        if EXEMPT.contains(&name.as_str()) {
            continue;
        }
        let mut session =
            Session::gated(captured_group(), Vec::new(), Gate::new(case.scopes.clone()));
        let mut spoken = 0;
        for (index, ask) in case.asks.iter().enumerate() {
            let (frame, tag) = retarget(ask);
            if tag == "canary" {
                // This file's oracle served one ungated rpc, which the port has no table row to consult — and
                // which the shipped server has no way to serve, since `ws.ts` runs every handler's effect
                // through `observeRpcEffect` (the seam golden measured that in `seam-golden.ts`). What it
                // proved — that the connection outlived the answer before it — is the `answered` column,
                // compared once per case against [`Session::deafened`] rather than request by request.
                continue;
            }
            let reply = session.receive(&frame);
            assert!(
                !reply.closes(),
                "{name} frame {index} ended a connection the recording kept open",
            );
            let written: Vec<String> = reply.frames().iter().map(Message::encode).collect();
            // One frame per request in every case here: the refusal, the echo, or the broadcast. So the
            // pairing is the recording's own, and an extra frame is a difference rather than a reordering.
            let want: Vec<String> = case.answers.iter().skip(spoken).take(1).cloned().collect();
            assert_eq!(
                written,
                want,
                "{name} frame {index} on [{}] asked {frame}",
                case.scopes.join("+"),
            );
            spoken += 1;
        }
        // Survival, off the column the client wrote rather than a claim here. A case that did not ask twice
        // has no such column, so its equivalent is read off the bytes: the connection only goes quiet after
        // a broadcast `Defect`, which is the one frame the throw produces.
        if case.canary {
            assert_eq!(
                session.deafened(),
                !case.answered,
                "{name}: the client was {answer}after the case's own answer",
                answer = if case.answered { "" } else { "never answered " },
            );
            assert!(
                case.asks.len() == case.answers.len() + usize::from(!case.answered),
                "{name} is a canary case whose frames do not pair",
            );
        } else {
            let thrown = case
                .answers
                .iter()
                .any(|answer| answer.starts_with(r#"{"_tag":"Defect""#));
            assert_eq!(
                session.deafened(),
                thrown,
                "{name}: the recording threw {thrown} and the port went quiet {}",
                session.deafened(),
            );
        }
        replayed += 1;
    }
    assert_eq!(replayed, REPLAYED, "the capture changed shape");
    for exempt in EXEMPT {
        assert!(
            cases.contains_key(exempt),
            "the capture lost {exempt}, which this file exempts by name",
        );
    }
}

/// The refusal's body, checked against the capture's own text rather than against a claim made here: the
/// port writes the error `EnvironmentAuthorizationError` declares, in the order its fields are declared.
#[test]
fn the_typed_refusal_carries_the_error_the_schema_writes() {
    let Some((document, _)) = artifact() else {
        eprintln!("skipping: LMCS_SCOPE_GOLDEN is unset");
        return;
    };
    let mut refusals = 0;
    for frame in document["wire"].as_array().expect("a wire array") {
        if text(frame, "direction") != "s2c" {
            continue;
        }
        let body = text(frame, "frame");
        let record: Value = serde_json::from_str(&body).expect("a recorded answer parses");
        let Some(cause) = record["exit"]["cause"].as_array() else {
            continue;
        };
        // One cause per refusal, and the typed one at that: the `Die` cases belong to the shape test below.
        let Some(error) = cause
            .iter()
            .find(|entry| entry["_tag"] == "Fail")
            .map(|entry| &entry["error"])
        else {
            continue;
        };
        let required = error["requiredScope"]
            .as_str()
            .expect("a refusal names the scope it needed");
        assert_eq!(
            json::stringify(error),
            scopes::authorization_error(required),
            "the port's body is not the recorded one: {body}",
        );
        assert_eq!(
            cause.len(),
            1,
            "a refusal carried more than its own failure: {body}",
        );
        refusals += 1;
    }
    assert!(refusals >= 8, "the capture recorded {refusals} refusals");
}

/// The table half: what the generator read out of `WsRpcGroup` and `RpcAuthorization.ts`, row by row.
#[test]
fn the_ports_table_answers_every_declared_method_the_same_way() {
    let Some((document, _)) = artifact() else {
        eprintln!("skipping: LMCS_SCOPE_GOLDEN is unset");
        return;
    };
    let declared = document["declared"].as_array().expect("a declared array");
    assert_eq!(
        declared.len(),
        scopes::RPC_REQUIRED_SCOPES.len(),
        "the port's table and the shipped one no longer have the same length",
    );
    let summary = &document["summary"];
    let group_only: Vec<&str> = summary["groupOnly"]
        .as_array()
        .expect("a groupOnly list")
        .iter()
        .map(|method| method.as_str().expect("a method name"))
        .collect();
    for item in declared {
        let method = text(item, "method");
        let scope = text(item, "scope");
        assert_eq!(
            scopes::required_scope(&method),
            Ok(scope.as_str()),
            "{method} is declared as {scope} in the capture",
        );
        assert!(
            !group_only.contains(&method.as_str()),
            "{method} is both a table row and a handler the table omits",
        );
        // The other half of the group's own claim: every row the capture measured has a handler.
        assert!(
            item["handler"].as_bool().unwrap_or(false),
            "{method} lost its handler in the shipped group, so the port's row is now untested",
        );
    }
    // `vcs.deleteBranch` is the reason the gate has three answers instead of two, and the port must not
    // quietly grow a row for it: adding one would turn a broadcast `Defect` into a refusal.
    assert_eq!(
        group_only,
        ["vcs.deleteBranch"],
        "the shipped group's untabled handler moved",
    );
    assert!(
        matches!(
            scopes::required_scope(UNDECLARED),
            Err(scopes::UndeclaredScope { .. })
        ),
        "the port grew a row the shipped table does not have",
    );

    let distinct: Vec<&str> = summary["distinct"]
        .as_array()
        .expect("a distinct list")
        .iter()
        .map(|scope| scope.as_str().expect("a scope name"))
        .collect();
    let mut ported: Vec<&str> = scopes::RPC_REQUIRED_SCOPES
        .iter()
        .map(|(_, scope)| *scope)
        .collect();
    ported.sort_unstable();
    ported.dedup();
    assert_eq!(ported, distinct, "the reachable scopes moved");

    // `device.list` is the one row whose scope the table does not answer on its own.
    let list = declared
        .iter()
        .find(|item| text(item, "method") == "device.list")
        .expect("device.list is a table row");
    assert_eq!(text(list, "scope"), "orchestration:read");
    assert_eq!(
        scopes::required_scope_for_device_list(None, None),
        "orchestration:read",
    );
    for (retry, update, want) in [
        (Some("host-1"), None, "orchestration:operate"),
        (None, Some("codex"), "orchestration:operate"),
        // `list.emptyStringsAreAbsent`: `input.retryHostId || input.updateTool` is truthiness.
        (Some(""), Some(""), "orchestration:read"),
    ] {
        assert_eq!(
            scopes::required_scope_for_device_list(retry, update),
            want,
            "device.list({retry:?}, {update:?})",
        );
    }
}

/// The claim the dispatch rests on, read off the capture rather than assumed: every method the table covers
/// can encode the refusal in its exit schema, so the `Die` shape the `subscribeNoError` cases measured is
/// unreachable through the shipped group. If a maintainer drops the error from a subscription this fails
/// here, where the port's one refusal shape is written down, instead of in a client that got a defect.
#[test]
fn no_method_the_table_covers_needs_the_other_shape() {
    let Some((document, _)) = artifact() else {
        eprintln!("skipping: LMCS_SCOPE_GOLDEN is unset");
        return;
    };
    let summary = &document["summary"];
    let declared = document["declared"].as_array().expect("a declared array");
    assert_eq!(
        summary["authInExit"].as_u64().expect("an authInExit count"),
        declared.len() as u64,
        "a declared method lost the error channel, and the port writes a Fail for it",
    );
    assert_eq!(
        summary["methodsWithoutExit"]
            .as_array()
            .expect("a methodsWithoutExit list")
            .len(),
        0,
    );
    // Every streaming method is exactly the set whose *plain* error channel lacks the failure, which is
    // why `authInError` alone would have answered the question wrongly.
    assert_eq!(
        summary["nonStreamsWithoutError"]
            .as_array()
            .expect("a nonStreamsWithoutError list")
            .len(),
        0,
    );
    assert_eq!(
        summary["streamMethods"]
            .as_u64()
            .expect("a streamMethods count"),
        summary["streamsWithoutError"]
            .as_u64()
            .expect("a streamsWithoutError count"),
        "the methods missing the error channel are no longer exactly the streams",
    );
    for item in declared {
        let method = text(item, "method");
        assert!(
            item["authInExit"].as_bool().unwrap_or(false),
            "{method} cannot carry the refusal this port writes",
        );
    }
    // And the shape the port does *not* write is on the wire once, as measured, so this file cannot drift
    // into believing the two are the same claim.
    let die = cases_answer(&document, "streamNoError.denied");
    assert!(
        die.contains(r#""_tag":"Die""#) && die.contains("Expected never"),
        "the counterfactual case stopped measuring the shape it was added for: {die}",
    );
}

/// One case's first answer, straight out of the capture.
fn cases_answer(document: &Value, case: &str) -> String {
    document["wire"]
        .as_array()
        .expect("a wire array")
        .iter()
        .find(|frame| text(frame, "case") == case && text(frame, "direction") == "s2c")
        .map(|frame| text(frame, "frame"))
        .unwrap_or_else(|| panic!("{case} recorded no answer"))
}

/// The two fatal cases, named: the throw is the only thing in the capture that leaves a connection open and
/// unable to answer, and the count that says so is the measurement this file is built on.
#[test]
fn the_capture_says_which_refusals_a_connection_survives() {
    let Some((document, cases)) = artifact() else {
        eprintln!("skipping: LMCS_SCOPE_GOLDEN is unset");
        return;
    };
    let survived: Vec<&str> = document["summary"]["survived"]
        .as_array()
        .expect("a survived list")
        .iter()
        .map(|name| name.as_str().expect("a case name"))
        .collect();
    assert_eq!(
        survived,
        ["probe.deniedThenCanary", "streamNoError.deniedThenCanary"],
        "the cases whose follow-up got an answer moved",
    );
    for (name, want) in [
        ("probe.deniedThenCanary", true),
        ("deleteBranch.thenCanary", false),
        ("probe.undeclaredThenCanary", false),
    ] {
        assert_eq!(
            cases[name].answered, want,
            "{name} was {want} for the client in this capture",
        );
        assert!(cases[name].canary, "{name} is not a canary case");
    }
    // Four cases asked twice on purpose; the fifth that sent more than one frame is
    // `streamNoError.granted`, whose extra requests are a stream's acks.
    let asked_twice: Vec<&String> = cases
        .iter()
        .filter(|(_, case)| case.asks.len() > 1)
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        asked_twice.len(),
        5,
        "the capture grew or lost a canary case"
    );
    assert_eq!(
        cases.values().filter(|case| case.canary).count(),
        4,
        "the survival column no longer covers the four refusals it was written for",
    );
}
