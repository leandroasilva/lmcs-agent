//! The credential's golden: replay the eight primitives `wsTicket` is built out of.
//!
//! `LMCS_AUTH_GOLDEN=/path/to/auth-golden.json cargo test --test auth_golden`
//!
//! [`transport_golden`](transport_golden.rs) compares a socket; this file compares the decisions made
//! *before* one exists. The capture is `apps/server/scripts/auth-golden.ts`, which ran the shipped
//! functions — `signPayload`, `timingSafeEqualBase64Url`, `Encoding.decodeBase64Url`, the
//! `WebSocketClaims` schema, `RPC_REQUIRED_SCOPES`, and both auth failure writers over a real socket —
//! and recorded what each returned for inputs a port cannot guess.
//!
//! Eight tables, replayed whole:
//!
//! | table | the claim |
//! | --- | --- |
//! | `tickets` | base64url of the claim text and its HMAC-SHA256, unpadded, byte for byte |
//! | `splits` | which token shapes are malformed, off JavaScript's `split(".")` |
//! | `queries` | `searchParams.get("wsTicket")` and the whitespace gate in front of it |
//! | `decodes` | Effect's base64url decoder, including which of its three messages a case earns |
//! | `payloads` | the claims schema: the trim, the duplicate key, `1e999`, and the failure text |
//! | `timing` | Node's *other* base64url decoder, the one that cannot fail |
//! | `scopes` | all 147 method → scope pairs, plus the scope a `deviceList` payload picks |
//! | `refusals` | the 401/500 head, and which requests answer with a chunked 404 instead |
//!
//! Two rows are asserted rather than compared, because the port has no say in them:
//! `upgradeRefusal-second` is a write onto a socket the client had already closed, so the capture holds
//! an `EPIPE` and no bytes, and `refuse-span` recorded its trace id as a placeholder. What *is*
//! comparable in that row is `content-length`, which moves 114 → 135 exactly when a 32-character id
//! replaces the word `unavailable` — so a port that forgot the field, or wrote it unquoted, still fails.
//!
//! The reason mapping is worth saying out loud, because it limits what the socket can teach a port:
//! `mapSessionVerificationErrors` (`EnvironmentAuth.ts:543-552`) sends all fourteen credential
//! branches to one `invalid_credential`, so thirteen of the `refusals` rows differ in nothing the
//! client reads. Which branch *ran* is therefore pinned below, off `SessionStore.ts:882-951`, rather
//! than inferred from the artifact.

use std::env;
use std::fs;

use lmcs_protocol::auth::{
    self, Denial, Stored, StoredSession, Upgrade, Verified, authenticate_upgrade, mint,
};
use lmcs_protocol::http::{self, Denied, Request, Routed};
use lmcs_protocol::json;
use lmcs_protocol::scopes;
use serde_json::Value;

/// `auth-golden.ts`'s `SECRET`. The value does not matter to the bytes; that it is 32 of them does,
/// because `SessionStore.ts:487` reads exactly that many out of the secret store.
const SECRET: [u8; 32] = [
    7, 20, 33, 46, 59, 72, 85, 98, 111, 124, 137, 150, 163, 176, 189, 202, 215, 228, 241, 254, 11,
    24, 37, 50, 63, 76, 89, 102, 115, 128, 141, 154,
];

/// A trace id long enough to be the 32 hex characters a span produces, and short enough to count.
const SPAN: &str = "0123456789abcdef0123456789abcdef";

/// The date the capture masked, which the port passes through rather than reading a clock.
const DATE: &str = "Tue, 24 Nov 2026 09:00:00 GMT";

fn artifact() -> Option<Value> {
    let path = env::var_os("LMCS_AUTH_GOLDEN")?;
    let text = fs::read_to_string(&path).expect("the auth golden is readable");
    Some(serde_json::from_str(&text).expect("the auth golden is JSON"))
}

fn rows(document: &Value, table: &str) -> Vec<Value> {
    document[table]
        .as_array()
        .unwrap_or_else(|| panic!("a {table} table"))
        .clone()
}

/// A `summary` count, as the number of rows it claims to count.
fn measured(document: &Value, table: &str) -> usize {
    document["summary"][table]
        .as_u64()
        .unwrap_or_else(|| panic!("summary.{table}")) as usize
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_else(|| panic!("no {key}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// `tickets`: the mint, from the claim text the shipped code stringified
// ---------------------------------------------------------------------------

/// `base64UrlEncode(JSON.stringify(claims)) + "." + signPayload(payload, secret)`, which is what
/// `SessionStore.ts:847-880` returns. The artifact records the claim text so the row tests the encoder
/// and the HMAC rather than this crate's idea of what the text should be; `Claims::json()` is pinned by
/// the `payloads` table below, and together the two pin `mint`.
#[test]
fn the_ticket_is_the_measured_bytes() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let tickets = rows(&document, "tickets");
    assert_eq!(tickets.len(), measured(&document, "tickets"));
    for row in &tickets {
        let name = text(row, "name");
        let json = text(row, "json");
        let payload = auth::encode_base64url(json.as_bytes());
        assert_eq!(payload, text(row, "payload"), "{name}: payload");
        let signature = auth::sign_payload(&payload, &SECRET);
        assert_eq!(signature, text(row, "signature"), "{name}: signature");
        assert_eq!(
            format!("{payload}.{}", text(row, "signature")),
            text(row, "token"),
            "{name}: token",
        );
        // The alphabet the mint can produce, which is the reason a signature never needs the padding
        // Node's decoder would have to tolerate.
        assert!(
            !payload.contains('=') && !signature.contains('='),
            "{name}: a mint is unpadded",
        );
    }
    // One row end to end, so a change to the claims text cannot hide behind the table.
    assert_eq!(
        mint("sess_01", 1_700_000_000_000.0, 1_700_000_300_000.0, &SECRET),
        text(&tickets[0], "token"),
    );
    // The two rows that a naive encoder would lose: a `+` in the payload text becomes `-`, and the
    // claim text is UTF-8 rather than UTF-16 units.
    assert_eq!(
        mint(
            "sess-01_2/3+4",
            1_700_000_000_000.0,
            1_700_000_300_000.0,
            &SECRET
        ),
        text(&tickets[3], "token"),
        "the sid's own alphabet reaches the payload",
    );
    assert_eq!(
        mint("sess_ãã", 1_700_000_000_000.0, 1_700_000_300_000.0, &SECRET),
        text(&tickets[4], "token"),
    );
}

// ---------------------------------------------------------------------------
// `splits`: which shapes `verifyWebSocketToken` calls malformed
// ---------------------------------------------------------------------------

/// The artifact recorded `token.split(".")`, so this checks the port reads the same two fields out of
/// the same text — including that a third part is never seen, and that the empty strings around a
/// leading or trailing dot are what make a token malformed.
#[test]
fn a_dot_decides_malformed() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let splits = rows(&document, "splits");
    assert_eq!(splits.len(), measured(&document, "splits"));
    for row in &splits {
        let input = text(row, "input");
        let recorded: Vec<&str> = row["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_str)
            .map(Option::unwrap)
            .collect();
        assert_eq!(
            input.split('.').collect::<Vec<&str>>(),
            recorded,
            "{input:?}"
        );
        let first = recorded.first().copied().unwrap_or_default();
        let second = recorded.get(1).copied().unwrap_or_default();
        let denial = auth::verify(input, 0, &SECRET, None, |_| Stored::Missing);
        assert_eq!(
            denial.as_ref().err() == Some(&Denial::MalformedToken),
            first.is_empty() || second.is_empty(),
            "{input:?}: malformed was {:?}, the port says {denial:?}",
            first.is_empty() || second.is_empty(),
        );
    }
}

// ---------------------------------------------------------------------------
// `queries`: the route's read of `?wsTicket`
// ---------------------------------------------------------------------------

/// `toURL(request).searchParams.get("wsTicket")` is form decoding, not a string search, and the gate in
/// front of it is JavaScript truthiness on the trimmed text: `?wsTicket=%20` yields a ticket that is
/// *not used*, which is the row a port that only checks presence would get wrong.
#[test]
fn the_query_param_is_form_encoded() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let queries = rows(&document, "queries");
    assert_eq!(queries.len(), measured(&document, "queries"));
    for row in &queries {
        let url = text(row, "url");
        let (path, search) = http::split_target(url);
        assert_eq!(path, text(row, "path"), "{url:?}: path");
        assert_eq!(search, text(row, "search"), "{url:?}: search");
        let ticket = http::query_param(url, auth::TICKET_PARAM);
        assert_eq!(
            ticket.as_deref(),
            row["ticket"].as_str(),
            "{url:?}: wsTicket"
        );
        let uses = row["uses"].as_bool().unwrap();
        let fell_through = matches!(
            authenticate_upgrade(url, 0, &SECRET, None, |_| Stored::Missing),
            Upgrade::NoTicket
        );
        assert_eq!(fell_through, !uses, "{url:?}: {ticket:?} used = {uses}");
    }
}

// ---------------------------------------------------------------------------
// `decodes`: Effect's base64url, three messages and no more
// ---------------------------------------------------------------------------

#[test]
fn the_url_safe_decoder_refuses_the_way_the_measured_one_does() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let decodes = rows(&document, "decodes");
    assert_eq!(decodes.len(), measured(&document, "decodes"));
    for row in &decodes {
        // The artifact stores the input as JSON text, so `"aGVs\r\nbG8="` arrives escaped and only a
        // parser knows the two characters the case actually sent.
        let input: String = serde_json::from_str(text(row, "input")).unwrap();
        if row["decode"].as_str() == Some("Success") {
            let bytes = auth::decode_base64url(&input).unwrap_or_else(|error| {
                panic!("{input:?}: expected success, got {}", error.message());
            });
            assert_eq!(hex(&bytes), text(row, "bytes"), "{input:?}: bytes");
            assert!(row["utf8"]["ok"].as_bool().unwrap(), "{input:?}: utf8 ok");
            assert_eq!(
                auth::decode_base64url_utf8(&input).unwrap(),
                text(&row["utf8"], "value"),
                "{input:?}: utf8 text is lossy, not fatal",
            );
        } else {
            let message = text(row, "message");
            let error = match auth::decode_base64url(&input) {
                Ok(bytes) => panic!(
                    "{input:?}: expected {message:?}, decoded to {}",
                    hex(&bytes)
                ),
                Err(error) => error,
            };
            assert_eq!(error.message(), message, "{input:?}: message");
            assert_eq!(
                text(&row["utf8"], "thrown"),
                format!("EncodingError:{message}"),
                "{input:?}: the throw carries the same text the decode returns",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// `payloads`: the claims schema, which is the table the port cannot fake
// ---------------------------------------------------------------------------

#[test]
fn the_claims_schema_trims_and_writes_what_the_measured_one_did() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let payloads = rows(&document, "payloads");
    let total = measured(&document, "payloads");
    assert_eq!(payloads.len(), total);
    let accepted = payloads
        .iter()
        .filter(|row| row["decode"].as_str() == Some("Success"))
        .count();
    let mut successes = 0;
    for row in &payloads {
        let json = text(row, "json");
        match auth::decode_claims(json) {
            Ok(claims) => {
                successes += 1;
                assert_eq!(
                    row["decode"].as_str(),
                    Some("Success"),
                    "{json}: the artifact refused this"
                );
                // `sid` is recorded as JSON text, so the row pins the trim and the escaping at once.
                assert_eq!(json::quote(&claims.sid), text(row, "sid"), "{json}: sid");
                assert_eq!(claims.json(), text(row, "roundTrip"), "{json}: re-encoded");
            }
            Err(error) => {
                assert_ne!(
                    row["decode"].as_str(),
                    Some("Success"),
                    "{json}: the port refused an accepted claim"
                );
                assert_eq!(
                    error.message(),
                    text(row, "message"),
                    "{json}: refusal text",
                );
            }
        }
    }
    assert_eq!(
        successes, accepted,
        "the schema accepted as many documents as the capture did"
    );
    assert!(accepted < total, "the table is not all successes");
}

// ---------------------------------------------------------------------------
// `timing`: Node's decoder, which cannot fail
// ---------------------------------------------------------------------------

/// The signature check compares **decoded bytes**, so two base64url texts that differ only in bits the
/// last character drops (`aGVsbG8` and `aGVsbG9`) verify each other. A port that compared texts would
/// reject a token the shipped server accepts, and no test but this one can see it.
#[test]
fn the_signature_compare_is_over_decoded_bytes() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let timing = rows(&document, "timing");
    assert_eq!(timing.len(), measured(&document, "timing"));
    for row in &timing {
        let left = text(row, "left");
        let right = text(row, "right");
        let decoded = row["decoded"].as_array().unwrap();
        for (input, expected) in [(left, 0), (right, 1)] {
            assert_eq!(
                hex(&auth::node_base64url(input)),
                decoded[expected].as_str().unwrap(),
                "{input:?}: Node skips what the alphabet does not contain and keeps the rest",
            );
        }
        assert_eq!(
            auth::timing_safe_equal_base64url(left, right),
            row["equal"].as_bool().unwrap(),
            "{left:?} vs {right:?}",
        );
    }
}

// ---------------------------------------------------------------------------
// `scopes`: the whole table, in order
// ---------------------------------------------------------------------------

#[test]
fn every_method_carries_the_scope_the_route_declared() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let table = document["scopes"]["entries"].as_array().unwrap();
    assert_eq!(
        table.len(),
        scopes::RPC_REQUIRED_SCOPES.len(),
        "the table size"
    );
    assert_eq!(table.len(), measured(&document, "scopeEntries"));
    assert_eq!(
        table.len(),
        document["scopes"]["count"].as_u64().unwrap() as usize
    );
    for (index, entry) in table.iter().enumerate() {
        let pair = entry.as_array().unwrap();
        let (method, scope) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(
            scopes::RPC_REQUIRED_SCOPES[index],
            (method, scope),
            "entry {index} is in a different order",
        );
        assert_eq!(required(method), scope, "{method}");
    }
    // The set of scopes the table can ask for, which is what a session's `scopes` array is measured
    // against.
    let distinct: Vec<&str> = document["scopes"]["distinct"]
        .as_array()
        .unwrap()
        .iter()
        .map(Value::as_str)
        .map(Option::unwrap)
        .collect();
    let mut port: Vec<&str> = scopes::RPC_REQUIRED_SCOPES
        .iter()
        .map(|(_, scope)| *scope)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    port.sort_unstable();
    assert_eq!(port, distinct, "the same seven scope names");

    // The two ways a lookup refuses, and the text a log line reads. The TypeScript throws a plain
    // `Error`, so the tag the capture recorded is `Error:` and nothing more.
    let absent = scopes::required_scope("no.such.method").unwrap_err();
    assert_eq!(
        absent.message(),
        "RPC method no.such.method has no declared authorization scope."
    );
    assert_eq!(
        format!("Error:{}", absent.message()),
        text(&document["scopes"], "unknownThrow"),
        "an unknown method",
    );
    // `toString` is inherited, so the shipped `Object.hasOwn`-free lookup finds nothing and the message
    // names a method a client could never legitimately send.
    let inherited = scopes::required_scope("toString").unwrap_err();
    assert_eq!(
        format!("Error:{}", inherited.message()),
        text(&document["scopes"], "inheritedThrow"),
        "a prototype key is not a declared method",
    );

    // The one method whose scope depends on its payload.
    for row in document["scopes"]["deviceList"].as_array().unwrap() {
        let input = row["input"].as_object().unwrap();
        let read = |key: &str| input.get(key).and_then(Value::as_str);
        assert_eq!(
            scopes::required_scope_for_device_list(read("retryHostId"), read("updateTool")),
            text(row, "scope"),
            "{}",
            json::stringify(row),
        );
    }

    // The body a client reads when the credential is good and the scope is not.
    assert_eq!(
        scopes::authorization_error("orchestration:read"),
        text(&document["scopes"], "authorizationError"),
    );
}

/// The port's lookup, so the table's order is not what the replay trusts.
fn required(method: &str) -> &'static str {
    scopes::required_scope(method).unwrap_or_else(|_| panic!("{method} is not declared"))
}

// ---------------------------------------------------------------------------
// `refusals`: the head the route writes
// ---------------------------------------------------------------------------

/// The 401 and the 500, over a socket: header order, the lowercase `content-type` and
/// `content-length` Node's response pipeline writes, the `Keep-Alive` that only a request without an
/// `Upgrade` header earns, and the body whose length the header promises.
#[test]
fn a_refusal_writes_the_measured_head() {
    let Some(document) = artifact() else {
        eprintln!("skipping auth golden: set LMCS_AUTH_GOLDEN");
        return;
    };
    let refusals = rows(&document, "refusals");
    assert_eq!(refusals.len(), measured(&document, "refusals"));
    let mut compared = 0;
    let mut branched = 0;
    for row in &refusals {
        let case = text(row, "case");
        let head = text(row, "request");
        let request = Request::parse(head);
        // A refusal over an upgrade has no `Keep-Alive` and the connection then FINs; the same refusal
        // on a plain request carries it and the connection stays open. The route does not decide that,
        // the socket's state does, and `is_upgrade` is the port's reading of it.
        let keep_alive = !request.is_upgrade();
        let status = text(row, "statusLine");
        if status == "write error EPIPE" {
            // The client hung up between the two refusals, so there are no bytes to compare. What the
            // port has to get right is that it does not *keep* writing: the row before this one
            // answered in full, and the server wrote onto a socket that was gone.
            assert_eq!(case, "upgradeRefusal-second");
            assert!(
                row["headers"].as_array().unwrap().is_empty(),
                "{case}: nothing was written"
            );
            assert_eq!(text(row, "body"), "", "{case}: nothing was written");
            continue;
        }
        if status == "HTTP/1.1 404 Not Found" {
            // `POST /refuse/missing`: the router never consulted the credential, so it answers with its
            // own bodyless chunked 404. The `chunks` are the framing the capture read, sizes included.
            let mut expected = head_of(status, &row["headers"], "");
            for (index, chunk) in row["chunks"].as_array().unwrap().iter().enumerate() {
                // The capture records the framing as alternating size lines and payloads, and the
                // terminator that follows the zero-size chunk is stored as its own entry.
                expected.push_str(chunk.as_str().unwrap());
                if index % 2 == 0 {
                    expected.push_str("\r\n");
                }
            }
            assert_eq!(
                String::from_utf8(http::routed(DATE, Routed::NoRoute)).unwrap(),
                expected,
                "{case}: the router answered, not the credential",
            );
            compared += 1;
            continue;
        }
        let body = text(row, "body");
        let denied = denied_from(body);
        let trace_id = match text(row, "traceShape") {
            "unavailable" => "unavailable",
            "hex32" => SPAN,
            shape => panic!("{case}: unexpected trace shape {shape}"),
        };
        assert_eq!(
            row["tcp"].as_str().unwrap(),
            if keep_alive { "open" } else { "fin" },
            "{case}: the header and the socket agree",
        );
        assert_eq!(
            String::from_utf8(denied.write(DATE, trace_id, keep_alive)).unwrap(),
            head_of(status, &row["headers"], &body.replace("__TRACE__", SPAN)),
            "{case}: head and body",
        );
        // The body on its own, so a mismatch says which field moved, and its length, because the header
        // the writer computed is the claim a client parses the answer with.
        let written = denied.body(trace_id);
        assert_eq!(written, body.replace("__TRACE__", SPAN), "{case}: body");
        assert_eq!(
            header(&row["headers"], "content-length")
                .parse::<usize>()
                .unwrap(),
            written.len(),
            "{case}: the header counts the body it promises",
        );
        compared += 1;

        // Thirteen rows are the route's own decision, recorded with the ticket it read. The port
        // reaches the same body from the same target, which is the only place this slice's two halves
        // (`authenticate_upgrade` and `Denied`) meet.
        if let Some(branch) = row.get("branch") {
            branched += 1;
            let url = text(branch, "url");
            assert_eq!(
                http::query_param(url, auth::TICKET_PARAM).as_deref(),
                branch["ticket"].as_str(),
                "{case}: the route's read of the query",
            );
            let outcome = authenticate_upgrade(url, 0, &SECRET, None, |_| Stored::Missing);
            assert_eq!(
                branch["usesTicket"].as_bool().unwrap(),
                !matches!(outcome, Upgrade::NoTicket),
                "{case}: the gate in front of the credential",
            );
            let written = match outcome {
                // Falling through to bearer and cookie auth is the `missing_credential` 401, which is
                // the only refusal the ticket step does not write itself.
                Upgrade::NoTicket => Denied::credential("missing_credential", None),
                Upgrade::Denied(denial) => denial.denied(),
                Upgrade::Accepted(_) => panic!("{case}: the capture never accepted a ticket"),
            };
            assert_eq!(
                written.body("unavailable"),
                body,
                "{case}: the decision and the body"
            );
        }
    }
    assert_eq!(
        compared,
        refusals.len() - 1,
        "one row per refusal but the EPIPE"
    );
    assert_eq!(
        branched,
        measured(&document, "branches"),
        "every route decision"
    );
}

/// The `Denied` this capture's body describes. Reading the writer's inputs off the recorded body is
/// deliberate: it means a refusal whose reason moved fails the *reason*, not the whole comparison.
fn denied_from(body: &str) -> Denied {
    let value: Value = serde_json::from_str(body).expect("a refusal is a JSON object");
    let tag = value["_tag"].as_str().unwrap_or_default();
    let reason = value["reason"].as_str().unwrap_or_default();
    let dpop = value["dpopFailureReason"].as_str();
    match (tag, reason, dpop) {
        ("EnvironmentInternalError", "internal_error", None) => Denied::internal(),
        ("EnvironmentAuthInvalidError", "missing_credential", None) => {
            Denied::credential("missing_credential", None)
        }
        ("EnvironmentAuthInvalidError", "invalid_credential", None) => {
            Denied::credential("invalid_credential", None)
        }
        ("EnvironmentAuthInvalidError", "invalid_credential", Some("invalid_proof")) => {
            Denied::credential("invalid_credential", Some("invalid_proof"))
        }
        (tag, reason, dpop) => panic!("unmeasured refusal: {tag:?} {reason:?} {dpop:?}"),
    }
}

/// The recorded head as text, so the port's writer is compared to bytes rather than to a summary.
fn head_of(status: &str, headers: &Value, body: &str) -> String {
    let mut out = format!("{status}\r\n");
    for header in headers.as_array().unwrap() {
        out.push_str(&format_header(
            header.as_array().unwrap()[0].as_str().unwrap(),
            header.as_array().unwrap()[1].as_str().unwrap(),
        ));
    }
    out.push_str("\r\n");
    out.push_str(body);
    out
}

/// One recorded header line, with the two placeholders the capture substituted.
fn format_header(name: &str, value: &str) -> String {
    let value = match value {
        "__DATE__" => DATE.to_owned(),
        "__TRACE__" => SPAN.to_owned(),
        other => other.to_owned(),
    };
    format!("{name}: {value}\r\n")
}

/// The value the capture recorded for a header name, which the byte comparison needs alongside its own
/// claim: the writer computes `content-length`, so a body that moved without the header moving is two
/// failures.
fn header(headers: &Value, wanted: &str) -> String {
    headers
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair.as_array().unwrap()[0].as_str().unwrap() == wanted)
        .unwrap_or_else(|| panic!("no {wanted} header"))
        .as_array()
        .unwrap()[1]
        .as_str()
        .unwrap()
        .to_owned()
}

// ---------------------------------------------------------------------------
// The branch order, off the source
// ---------------------------------------------------------------------------

/// The row's own credential. Named here because it is the field the *ticket* never carries
/// (`SessionStore.ts:882-951` reads `scopes: row.value.scopes`), so every success below has to prove the
/// same thing: what the connection may do came from the store, not from the bytes the client sent.
fn credentialed() -> Vec<String> {
    vec!["orchestration:read".to_owned(), "orchestration:operate".to_owned()]
}

/// `SessionStore.ts:882-951` is nine denials and one success, and they are two wire shapes apart at
/// most, so what a replay can lose is which branch *ran*. That is knowable only from the error tag,
/// which is what `mapSessionVerificationErrors` (`EnvironmentAuth.ts:543-552`) reads before it writes a
/// status — hence a test written against the source rather than the artifact.
#[test]
fn the_branch_order_is_the_functions() {
    let future = 2_000_000_000_000i64;
    let signed = |payload: &str| format!("{payload}.{}", auth::sign_payload(payload, &SECRET));
    let denied = |token: &str, now: i64, dev: Option<&str>, stored: Stored| -> Denial {
        auth::verify(token, now, &SECRET, dev, |_| stored.clone()).unwrap_err()
    };
    let live = Stored::Found(StoredSession {
        session_id: "sess_01".to_owned(),
        expires_at: future + 1,
        revoked: false,
        scopes: credentialed(),
    });
    let accepted = |session_id: &str| {
        Ok(Verified {
            session_id: session_id.to_owned(),
            scopes: credentialed(),
        })
    };

    // 1. Two empty halves are malformed before anything is signed, so `.` never reaches the HMAC.
    for token in ["", ".", "a."] {
        assert_eq!(
            denied(token, 0, None, Stored::Missing),
            Denial::MalformedToken,
            "{token:?} is malformed, not unsigned",
        );
    }
    // 2. A token signed with another secret fails before its payload is decoded — and note that the
    //    payload here is decodable, so a port that read the claims first would disagree.
    assert_eq!(
        auth::verify(
            &format!("eyJ2Ijox.{}", auth::sign_payload("eyJ2Ijox", &[0; 32])),
            0,
            &SECRET,
            None,
            |_| Stored::Missing,
        )
        .unwrap_err(),
        Denial::BadSignature,
    );
    // 3. Signed, and then the *first* decoder refuses: `a` is a length that is not a multiple of four.
    let short = denied(&signed("a"), 0, None, Stored::Missing);
    assert_eq!(short.error(), "InvalidWebSocketTokenPayloadError");
    assert_eq!(short.reason(), Some("invalid_credential"));
    assert_eq!(
        payload_message(&short),
        "Length should be a multiple of 4, but is 1",
        "the message is Effect's, not the base64 crate's",
    );
    // 4. The second decoder refuses: valid base64url, so the text is read, and it is not the schema.
    let junk = auth::encode_base64url(b"{}");
    let payload = denied(&signed(&junk), 0, None, Stored::Missing);
    assert_eq!(payload.error(), "InvalidWebSocketTokenPayloadError");
    assert_eq!(
        payload_message(&payload),
        "Missing key\n  at [\"v\"]",
        "and the JSON that decodes still has to be the claims object",
    );
    // 5. A dev-prefixed session is refused before the clock is read at all.
    let dev = mint("dev-auth-1", 1_000.0, future as f64 + 1_000.0, &SECRET);
    assert_eq!(
        denied(&dev, future, None, Stored::Missing),
        Denial::DevPrefix
    );
    assert_eq!(
        auth::verify(&dev, future, &SECRET, Some("dev-auth-1"), |_| live.clone()),
        accepted("sess_01"),
        "the reusable dev cookie is the one session the prefix does not refuse",
    );
    // 6. `DateTime.make(exp)` first, so a claim that is not a date is a bad claim rather than an
    //    expired token.
    let overflow =
        auth::encode_base64url(br#"{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1e999}"#);
    assert_eq!(
        denied(&signed(&overflow), future, None, Stored::Missing),
        Denial::UnusableExpiration,
    );
    // 7. The raw claim against the clock, which a truncated comparison would move: `exp` half a
    //    millisecond ahead of `now` is still alive.
    let fractional = mint("sess_01", 1_000.0, future as f64 + 0.5, &SECRET);
    assert_eq!(
        denied(&fractional, future, None, Stored::Missing),
        Denial::UnknownSession
    );

    assert_eq!(
        denied(
            &mint("sess_01", 1_000.0, future as f64 - 0.5, &SECRET),
            future,
            None,
            Stored::Missing
        ),
        Denial::TokenExpired,
    );
    assert_eq!(
        denied(
            &mint("sess_01", 1_000.0, future as f64, &SECRET),
            future,
            None,
            Stored::Missing
        ),
        Denial::TokenExpired,
        "an `exp` equal to the clock is expired",
    );
    // 8-9. The row is read last, and a row that is gone is not a database that failed.
    assert_eq!(
        denied(
            &mint("sess_01", 1_000.0, future as f64 + 1_000.0, &SECRET),
            future,
            None,
            Stored::Missing
        ),
        Denial::UnknownSession
    );
    let failed = denied(
        &mint("sess_01", 1_000.0, future as f64 + 1_000.0, &SECRET),
        future,
        None,
        Stored::Failed,
    );
    assert_eq!(failed, Denial::Store);
    assert_eq!(
        failed.reason(),
        None,
        "the one branch that is not a credential failure"
    );
    assert_eq!(
        failed.denied().body("unavailable"),
        r#"{"_tag":"EnvironmentInternalError","code":"internal_error","reason":"internal_error","traceId":"unavailable"}"#,
        "109 bytes and a 500",
    );
    // 10-11. Row expiry and revocation, in that order, and expiry is `<=` again.
    let token = mint("sess_01", 1_000.0, future as f64 + 1_000.0, &SECRET);
    let at = Stored::Found(StoredSession {
        session_id: "sess_01".to_owned(),
        expires_at: future,
        revoked: false,
        scopes: credentialed(),
    });
    assert_eq!(
        denied(&token, future, None, at),
        Denial::SessionExpired,
        "a row that expires on the same millisecond has expired",
    );
    assert_eq!(
        denied(
            &token,
            future,
            None,
            Stored::Found(StoredSession {
                session_id: "sess_01".to_owned(),
                expires_at: future + 1,
                revoked: true,
                scopes: credentialed(),
            }),
        ),
        Denial::WebSocketSessionRevoked,
    );
    // 12. And the success, which is the row the whole chain exists to reach.
    assert_eq!(
        auth::verify(&token, future, &SECRET, None, |_| live.clone()),
        accepted("sess_01"),
    );
    assert_eq!(
        Denial::TokenExpired.denied().body("unavailable"),
        r#"{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","traceId":"unavailable"}"#,
        "the 401 the client reads, 114 bytes",
    );
    // Every branch's tag, because the mapping is written against the tag rather than the reason.
    let tags: Vec<&str> = [
        Denial::MalformedToken,
        Denial::BadSignature,
        Denial::BadPayload(String::new()),
        Denial::DevPrefix,
        Denial::UnusableExpiration,
        Denial::TokenExpired,
        Denial::UnknownSession,
        Denial::Store,
        Denial::SessionExpired,
        Denial::WebSocketSessionRevoked,
    ]
    .iter()
    .map(Denial::error)
    .collect();
    assert_eq!(
        tags,
        [
            "MalformedWebSocketTokenError",
            "InvalidWebSocketTokenSignatureError",
            "InvalidWebSocketTokenPayloadError",
            "UnknownWebSocketSessionError",
            "InvalidSessionExpirationClaimError",
            "WebSocketTokenExpiredError",
            "UnknownWebSocketSessionError",
            "WebSocketTokenVerificationError",
            "WebSocketSessionExpiredError",
            "WebSocketSessionRevokedError",
        ],
    );
}
/// The message a payload denial carries, which is the only way to tell the two decoders apart: both
/// yield `InvalidWebSocketTokenPayloadError`, and only the text says which one ran.
fn payload_message(denial: &Denial) -> String {
    match denial {
        Denial::BadPayload(message) => message.clone(),
        other => panic!("{other:?} is not a payload refusal"),
    }
}
