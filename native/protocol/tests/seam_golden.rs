//! The seam's golden: the authenticated upgrade, replayed request head for request head.
//!
//! `LMCS_SEAM_GOLDEN=/path/to/seam-golden.json cargo test --test seam_golden`
//!
//! The other captures in this crate each held one piece of the route and named the piece it left out:
//! `upgrade-golden.ts` framed a socket with no auth in front of it, `auth-golden.ts` measured every refusal
//! but never reached a connection, `scope-golden.ts` gated a session whose scopes it handed in, and
//! `session_golden.rs` replays an ungated loop. This file replays the joins —
//! [`lmcs_protocol::transport::authenticated`] — against the ninety-four cases `seam-golden.ts` drove
//! over a real socket against the shipped route's order, with the real `EnvironmentAuth`, the real
//! `SessionStore`, and a real in-memory database it reads back after every case.
//!
//! Five claims the artifact decides and this file refuses to restate as prose:
//!
//! - **The head is the route's, and so is the row it left.** Each case is compared twice: on the bytes the
//!   client read and on the columns the database holds afterwards, which is the only way to see that
//!   `seam.badKeyAuthorized` marks a connection that was never made and `seam.postWs` writes nothing at all.
//! - **Auth outranks framing.** `seam.badTicketBadKey` and `seam.badTicketNoVersion` are requests `ws` would
//!   have answered 400 and the route answers 401, byte for byte including the 114-byte body.
//! - **The row is the only source of scopes.** `seam.readRow` and `seam.operateRow` send byte-identical
//!   second requests and get different answers, because their rows differ.
//! - **A request with no ticket is not an unauthenticated request.** The twenty-three new cases put the
//!   credential in a cookie, in `Authorization`, or in both, and the route's *order* is the whole content:
//!   `seam.cookieBeatsBearer` and `seam.ticketBeatsCookie` each seed a second row so picking the other
//!   credential is a different session id, and `seam.boundBearer` answers 401 with a 150-byte body where
//!   `seam.corruptedSignatureCookie` answers with a 114-byte one.
//! - **A bound token's proof is verified, and then spent.** The thirty-nine proof-shaped cases carry a
//!   real `DPoP:` header over a key the token names, and the capture records the replay row *by name and by
//!   text* — `dpop-proof-j4U-XWK6…` beside `thumbprint=…\njti=…\niat=…\nconsumedAt=…`. So the thumbprint,
//!   the JWS, the window and the spend are all compared rather than assumed: nine of them reach a `101`,
//!   `seam.dpopHighS` because noble leaves `lowS` off and `seam.dpopUrlSignedStripped` because only the
//!   server's own URL is normalized; `seam.dpopReplayedJti` is a 401 over the *bytes* that earned the case
//!   before it a `101`. A case with no recorded row is asserted to have created none, which is what makes
//!   the nineteen 150-byte `invalid_proof` refusals more than a status code.
//!
//! The date is the one header this file does not compare, for the reason `auth_golden.rs` gives: Node stamps
//! the wall clock, and the capture wrote `__DATE__` where it found one.

use std::collections::BTreeMap;
use std::env;
use std::fs;

use lmcs_protocol::auth::{CredentialNames, Replay, Stored, StoredSession};
use lmcs_protocol::deflate::{self, Inbound};
use lmcs_protocol::http::Request;
use lmcs_protocol::session::Group;
use lmcs_protocol::transport::{self, Seam};
use serde_json::Value;

/// Node's stamp for this run. Exempt from the comparison; everything around it is not.
const DATE: &str = "__DATE__";

/// The trace id the route's auth step saw, which is what `auth-golden.ts` measured: no span is open before
/// the ticket is verified.
const TRACE_ID: &str = "unavailable";

/// One case, as the replay needs it: the request head, the response bytes the client read, the row as auth
/// met it, the row as the case ended, and the frames in the order the socket carried them.
struct Case {
    name: String,
    request: String,
    head: Vec<u8>,
    seed: Value,
    row: Option<Value>,
    /// `after close: fin` / `open`, which is TCP's ending rather than the frames'.
    peer: Option<String>,
    frames: Vec<Value>,
    /// The replay row the store held after this case, as `ServerSecretStore` spelled it: the generator
    /// reads the name back out of the database, so a port that spent the proof under a different name — or
    /// that spent one it should have refused — cannot pass the head comparison and hide.
    secret: Option<Spent>,
}

/// One `dpop-proof-…` row, both halves of it.
struct Spent {
    name: String,
    value: String,
    bytes: u64,
}

/// What the port wrote into the replay store while answering, which is also the table the next case
/// inherits. Carried across cases on purpose: `seam.dpopReplayedJti` is only a replay because
/// `seam.dpopValid` ran first.
#[derive(Default)]
struct Secrets {
    kept: BTreeMap<String, String>,
}

impl Secrets {
    /// `ServerSecretStore.create` with `SecretAlreadyExistsError`: the name is taken, and the route turns
    /// that one collision into a 401 rather than a 500.
    fn record(&mut self, name: &str, value: &[u8], spent: &mut Vec<(String, String)>) -> Replay {
        if self.kept.contains_key(name) {
            return Replay::Replayed;
        }
        let text = String::from_utf8(value).expect("the store's value is the recorded text");
        spent.push((name.to_owned(), text.clone()));
        self.kept.insert(name.to_owned(), text);
        Replay::Stored
    }
}

/// What the port made of one case, in the order a client would have read it.
struct Written {
    head: Vec<u8>,
    frames: Vec<Vec<u8>>,
    /// Whether the last thing the port wrote was followed by FIN.
    hang_up: bool,
    /// The row the port authenticated, which is not in any byte the client read: the `101` names nothing,
    /// and this is how the cookie-versus-Bearer precedence is compared rather than assumed.
    session: Option<String>,
    /// The replay rows this case created. A refused proof must have created none and an accepted one the
    /// row the generator read back, so the spend is compared instead of being inferred from the status.
    spent: Vec<(String, String)>,
}

/// The port's answer to one recorded request head, with the recorded frames pushed through it.
///
/// The row is written here too, because the route's side effects are part of what the capture measured: a
/// port that marked a refused handshake, or released one `ws` abandoned, would replay the bytes and fail
/// the column.
fn replay(
    case: &Case,
    now: i64,
    secret: &[u8],
    names: &CredentialNames,
    rows: &mut Rows,
    secrets: &mut Secrets,
) -> Written {
    let request = Request::parse(&case.request);
    let seed = case.seed.clone();
    let mut spent = Vec::new();
    let seam = transport::authenticated(
        &request,
        group(),
        now,
        secret,
        None,
        names,
        |session_id| stored(&seed, session_id),
        |name, value| secrets.record(name, value, &mut spent),
        DATE,
        TRACE_ID,
    );
    let mut out = Written {
        head: Vec::new(),
        frames: Vec::new(),
        hang_up: false,
        session: None,
        spent,
    };
    match seam {
        Seam::Denied { head, .. } => out.head = head,
        Seam::NoRoute { head } => out.head = head,
        Seam::NotUpgrade {
            session_id,
            origin,
            head,
        } => {
            // The route ran, the response pipeline answered, and the bracket closed.
            out.session = Some(session_id.clone());
            rows.record(&session_id, &origin);
            rows.mark(&session_id, now);
            rows.release(&session_id);
            out.head = head;
        }
        Seam::Refused {
            session_id,
            origin,
            head,
            ..
        } => {
            // The bracket the route opened and never closed.
            out.session = Some(session_id.clone());
            rows.record(&session_id, &origin);
            rows.mark(&session_id, now);
            out.head = head;
        }
        Seam::Connected {
            session_id,
            origin,
            head,
            mut connection,
        } => {
            out.session = Some(session_id.clone());
            rows.record(&session_id, &origin);
            rows.mark(&session_id, now);
            out.head = head;
            for frame in &case.frames {
                if direction(frame) != "c2s" {
                    continue;
                }
                let written = connection.push(&client_bytes(frame));
                out.hang_up = written.hang_up;
                out.frames.extend(written.frames);
            }
            rows.release(&session_id);
        }
    }
    out
}

/// The group `seam-golden.ts` served: the three methods whose answers the capture carries, each one
/// authorized the way `ws.ts` authorizes it — inside the handler, off the table in
/// [`lmcs_protocol::scopes`] — which is why all three tags are declared ones.
fn group() -> Group {
    Group::new()
        .returns("server.getSettings", serde_json::json!({"ok": "read"}))
        .returns(
            "server.updateSettings",
            serde_json::json!({"ok": "operate"}),
        )
        .returns("server.getConfig", serde_json::json!({"alive": true}))
}

/// `authSessions.getById`, from the `seed` event the generator wrote before the handshake — which is the
/// row **as auth met it**, not the row at the end of the case. `seam.revokedMidFlight` and the three
/// `seam.origin*` reconnections are the cases that make the difference observable.
///
/// A case can seed a **second** row, and the two that do are the precedence cases: `seam.cookieBeatsBearer`
/// and `seam.ticketBeatsCookie` each send two valid credentials naming two different rows, so a port that
/// picked the other one still got a `101` and would replay green without these entries.
fn stored(seed: &Value, session_id: &str) -> Stored {
    let found = |scopes: &Value, expires_at: &Value, revoked: bool| {
        Stored::Found(StoredSession {
            session_id: session_id.to_owned(),
            expires_at: expires_at.as_i64().expect("a seeded expiry"),
            revoked,
            scopes: scopes
                .as_array()
                .expect("a seeded scope list")
                .iter()
                .map(|scope| scope.as_str().expect("a scope is a string").to_owned())
                .collect(),
        })
    };
    if seed["created"].as_bool() == Some(true) && seed["session"].as_str() == Some(session_id) {
        return found(
            &seed["scopes"],
            &seed["expiresAt"],
            seed["revoked"].as_bool().expect("a seeded revocation"),
        );
    }
    for row in seed["rows"].as_array().into_iter().flatten() {
        let row = row
            .as_array()
            .expect("a seeded extra row is [id, scopes, expiry]");
        if row.first().and_then(Value::as_str) == Some(session_id) {
            return found(&row[1], &row[2], false);
        }
    }
    Stored::Missing
}

/// The names `EnvironmentAuth` reads the credential out of, as the generator recorded them rather than as
/// this file would re-derive them: they come from the server's own config (`auth/utils.ts:11-64`) and a
/// port that guessed `t3_session` would fail every accepted case.
///
/// The dev cookie is absent because the capture ran with no dev session — `summary.devSessionId` is null,
/// which is also what makes `SessionStore`'s dev fast-path unreachable and therefore unported.
struct CookieNames {
    session: String,
    legacy: Option<String>,
}

impl CookieNames {
    fn read(document: &Value) -> Self {
        let recorded = |key: &str| document["summary"][key].as_str().map(str::to_owned);
        Self {
            session: recorded("sessionCookieName")
                .expect("the summary records the session cookie name"),
            legacy: recorded("legacyCookieName"),
        }
    }

    fn names(&self) -> CredentialNames<'_> {
        CredentialNames {
            session: &self.session,
            legacy: self.legacy.as_deref(),
            dev: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Reading the capture
// ---------------------------------------------------------------------------

fn artifact() -> Option<(Value, Vec<Case>)> {
    let path = env::var_os("LMCS_SEAM_GOLDEN")?;
    let document: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("the seam golden is readable"))
            .expect("the seam golden is JSON");
    let mut order: Vec<String> = Vec::new();
    let mut cases: BTreeMap<String, Case> = BTreeMap::new();
    // Events first, because their order is the order the generator ran the cases, and the `seam.origin*`
    // cases only mean what they say when they share one row in that order.
    for event in array(&document, "events") {
        let name = text(event, "case");
        let case = entry(&mut cases, &mut order, &name);
        match event["event"].as_str().expect("every event is named") {
            "request" => case.request = text(event, "request"),
            "response" => case.head = recorded_head(event),
            "seed" => case.seed = event["seed"].clone(),
            "row" => case.row = Some(event["row"].clone()),
            "peer" => case.peer = Some(text(event, "detail")),
            "secret" => case.secret = Some(Spent {
                name: text(event, "detail"),
                value: text(event, "value"),
                bytes: event["bytes"]
                    .as_u64()
                    .expect("a recorded replay row counts its own bytes"),
            }),
            // `write` records an `EPIPE` on a socket the server had already ended, which is TCP's news and
            // not the route's.
            "write" => {}
            other => panic!(
                "{}: an event this replay has no rule for: {other}",
                case.name
            ),
        }
    }
    for frame in array(&document, "frames") {
        let name = text(frame, "case");
        entry(&mut cases, &mut order, &name)
            .frames
            .push(frame.clone());
    }
    let ordered = order
        .into_iter()
        .map(|name| cases.remove(&name).expect("the order comes from the map"))
        .collect();
    Some((document, ordered))
}

fn entry<'a>(
    cases: &'a mut BTreeMap<String, Case>,
    order: &mut Vec<String>,
    name: &str,
) -> &'a mut Case {
    if !order.iter().any(|seen| seen == name) {
        order.push(name.to_owned());
    }
    cases.entry(name.to_owned()).or_insert_with(|| Case {
        name: name.to_owned(),
        request: String::new(),
        head: Vec::new(),
        seed: Value::Null,
        row: None,
        peer: None,
        frames: Vec::new(),
    })
}

/// The recorded answer as bytes: the status line, the headers in the order they were written, the blank
/// line, and everything the socket carried after it — the refusal's sentence, the pipeline's chunked
/// `0\r\n\r\n`, or nothing at all for a `101`.
fn recorded_head(event: &Value) -> Vec<u8> {
    let mut out = format!("{}\r\n", text(event, "statusLine")).into_bytes();
    for pair in array(event, "headers") {
        let pair = pair.as_array().expect("a header pair");
        out.extend(
            format!(
                "{}: {}\r\n",
                pair[0].as_str().expect("a name"),
                pair[1].as_str().expect("a value"),
            )
            .into_bytes(),
        );
    }
    out.extend(b"\r\n");
    if let Some(tail) = optional(event, "tailHex") {
        out.extend(hex(&tail));
    }
    out
}

/// The recorded client frame as wire bytes, mask included.
///
/// `wireHex` is the **deflated payload, unmasked** — the capture keeps what it wrote rather than what the
/// kernel sent, so the mask has to come back the same way it went on.
fn client_bytes(frame: &Value) -> Vec<u8> {
    let mut out = hex(&text(frame, "headerHex"));
    assert!(
        flag(frame, "masked"),
        "{}: a client frame the capture says was unmasked",
        text(frame, "case"),
    );
    let mut body = recorded_body(frame).unwrap_or_default();
    let (_, key) = out.split_at(out.len() - 4);
    for (index, byte) in body.iter_mut().enumerate() {
        *byte ^= key[index % 4];
    }
    out.extend(body);
    out
}

/// The payload a frame carried, in whichever of the three forms the capture kept it.
fn recorded_body(record: &Value) -> Option<Vec<u8>> {
    if let Some(payload) = record["payload"].as_str() {
        return Some(payload.as_bytes().to_vec());
    }
    optional(record, "wireHex")
        .or_else(|| optional(record, "payloadHex"))
        .map(|hexed| hex(&hexed))
}

// ---------------------------------------------------------------------------
// Comparing one answer
// ---------------------------------------------------------------------------

/// The table the route writes, as the cases left it.
///
/// Keyed by session id rather than by case because the origin cases reconnect to **one** row three times,
/// and it is the `COALESCE` across those connections that `seam.originKeepsPrevious` measures.
#[derive(Default)]
struct Rows {
    kept: BTreeMap<String, Kept>,
}

#[derive(Clone, Default, Eq, PartialEq)]
struct Kept {
    connected_at: Option<i64>,
    surface: Option<String>,
    app_version: Option<String>,
    /// Not a column: `SessionStore`'s in-memory registry, which is what `listActive` reads.
    connected: bool,
}

impl Rows {
    /// `recordClientConnection`, including `SessionStore.ts:605`'s guard — with nothing kept there is no
    /// update at all — and `setClientConnection`'s `COALESCE`, which keeps whatever the column held.
    fn record(&mut self, session_id: &str, origin: &lmcs_protocol::http::Origin) {
        if origin.is_empty() {
            return;
        }
        let entry = self.kept.entry(session_id.to_owned()).or_default();
        if origin.surface.is_some() {
            entry.surface = origin.surface.map(str::to_owned);
        }
        if origin.app_version.is_some() {
            entry.app_version = origin.app_version.clone();
        }
    }

    fn mark(&mut self, session_id: &str, now: i64) {
        let entry = self.kept.entry(session_id.to_owned()).or_default();
        entry.connected_at = Some(now);
        entry.connected = true;
    }

    fn release(&mut self, session_id: &str) {
        if let Some(entry) = self.kept.get_mut(session_id) {
            entry.connected = false;
        }
    }

    fn get(&self, session_id: &str) -> Kept {
        self.kept.get(session_id).cloned().unwrap_or_default()
    }
}

/// The columns, after the case. `revoked_at` and `expires_at` are left out of the model because the port
/// has no way to write them: `seam.revokedMidFlight`'s `revoked_at` is the oracle's own mid-case `revoke()`
/// and the scopes are compared against the seed instead, which is what proves the route touched nothing but
/// the two connection columns.
///
/// `seam.noTicket` is the case with no row read at all — the generator seeds no row for it, so there is
/// nothing to compare and this returns false rather than panicking.
fn compare_row(case: &Case, rows: &Rows) -> bool {
    let Some(record) = &case.row else {
        assert!(
            case.seed["session"].is_null(),
            "{}: the capture read no row for a ticket that named one",
            case.name,
        );
        return false;
    };
    let session = case.seed["session"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: a row event for a ticket naming nothing", case.name));
    let kept = rows.get(session);
    if record["missing"].as_bool() == Some(true) {
        assert!(
            kept.connected_at.is_none() && !kept.connected,
            "{}: the route wrote a row that was never created",
            case.name,
        );
        return true;
    }
    assert_eq!(
        kept.connected_at,
        record["lastConnectedAt"].as_i64(),
        "{}: a different `last_connected_at`",
        case.name,
    );
    assert_eq!(
        kept.surface,
        record["surface"].as_str().map(str::to_owned),
        "{}: a different `client_surface`",
        case.name,
    );
    assert_eq!(
        kept.app_version,
        record["appVersion"].as_str().map(str::to_owned),
        "{}: a different `client_app_version`",
        case.name,
    );
    assert_eq!(
        kept.connected,
        record["connected"].as_bool().expect("a connected flag"),
        "{}: the session registry says otherwise",
        case.name,
    );
    assert_eq!(
        case.seed["scopes"], record["scopes"],
        "{}: the route changed the row's scopes",
        case.name,
    );
    assert_eq!(
        case.seed["expiresAt"], record["expiresAt"],
        "{}: the route changed the row's expiry",
        case.name,
    );
    true
}

/// One s2c frame the port wrote, against the frame the capture recorded.
fn compare_frame(
    case: &Case,
    index: usize,
    record: &Value,
    got: &[u8],
    reader: Option<&mut Inbound>,
) {
    assert!(
        flag(record, "fin") && !flag(record, "masked"),
        "{} #{index}: a server answer this file has no rule for",
        case.name,
    );
    let header = hex(&text(record, "headerHex"));
    if flag(record, "rsv1") {
        // The deflate stream is `ws`'s zlib and not this port's, so the frame is compared on what it *says*
        // and on what the body inflates to through this connection's own context — which is the claim a
        // browser actually depends on.
        assert_eq!(
            got[0], header[0],
            "{} #{index}: wrong head flags on a deflated answer",
            case.name,
        );
        let Some(reader) = reader else {
            panic!(
                "{} #{index}: an RSV1 answer on a connection that never negotiated deflate",
                case.name
            );
        };
        let plain = reader
            .inflate(&got[head_len(got)..], flag(record, "fin"))
            .expect("the port's own answer inflates");
        assert_eq!(
            String::from_utf8_lossy(&plain),
            text(record, "inflated"),
            "{} #{index}: a deflated answer that does not inflate to the recorded text",
            case.name,
        );
        return;
    }
    // Uncompressed: the whole frame is the claim, head first because `814d` and `817e0100` are different
    // answers to the same request.
    assert!(
        got.len() >= header.len(),
        "{} #{index}: a frame shorter than the recorded header",
        case.name,
    );
    assert_eq!(
        &got[..header.len()],
        &header[..],
        "{} #{index}: wrote {} where the capture recorded {}: {}",
        case.name,
        show(&got[..header.len()]),
        text(record, "headerHex"),
        String::from_utf8_lossy(&got[header.len()..]),
    );
    assert_eq!(
        &got[header.len()..],
        recorded_body(record).unwrap_or_default().as_slice(),
        "{} #{index}: a different body: {}",
        case.name,
        String::from_utf8_lossy(&got[header.len()..]),
    );
}

/// The header length of a frame **the server wrote**, which is never masked.
fn head_len(frame: &[u8]) -> usize {
    match frame.get(1).map(|byte| byte & 0x7f) {
        Some(126) => 4,
        Some(127) => 10,
        _ => 2,
    }
}

fn show(frame: &[u8]) -> String {
    frame
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

// ---------------------------------------------------------------------------
// The capture's own helpers
// ---------------------------------------------------------------------------

fn array<'a>(record: &'a Value, key: &str) -> &'a Vec<Value> {
    record[key]
        .as_array()
        .unwrap_or_else(|| panic!("the capture holds a {key} array"))
}

fn text(record: &Value, key: &str) -> String {
    record[key]
        .as_str()
        .unwrap_or_else(|| panic!("the capture holds a {key} for every record"))
        .to_owned()
}

fn optional(record: &Value, key: &str) -> Option<String> {
    record[key].as_str().map(str::to_owned)
}

fn flag(record: &Value, key: &str) -> bool {
    record[key].as_bool().unwrap_or_else(|| {
        panic!(
            "the capture holds a {key} for every frame: {:?}",
            record["case"].as_str()
        )
    })
}

fn direction(record: &Value) -> String {
    text(record, "direction")
}

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "hex of odd length: {text:?}");
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex characters"))
        .collect()
}

/// The signing secret the generator recorded, as bytes.
fn secret(document: &Value) -> Vec<u8> {
    let encoded = document["summary"]["secret"]
        .as_str()
        .expect("the summary records the secret");
    let bytes = hex(encoded);
    assert_eq!(bytes.len(), 32, "an HMAC-SHA256 secret is 32 bytes");
    bytes
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

#[test]
fn the_capture_is_the_ports_own_bytes_and_columns() {
    let Some((document, cases)) = artifact() else {
        eprintln!("skipping: LMCS_SEAM_GOLDEN is unset");
        return;
    };
    let secret = secret(&document);
    let now = document["summary"]["nowMs"].as_i64().expect("a clock");
    let names = CookieNames::read(&document);
    let summary = string_list(&document, "upgraded");
    let mut rows = Rows::default();
    let mut heads = 0;
    let mut rows_compared = 0;
    let mut frames_compared = 0;
    let mut deflated = 0;
    let mut connections = 0;
    for case in &cases {
        let written = replay(case, now, &secret, &names.names(), &mut rows);
        assert_eq!(
            written.head,
            case.head,
            "{}: a different answer\n port: {}\ncapture: {}",
            case.name,
            String::from_utf8_lossy(&written.head),
            String::from_utf8_lossy(&case.head),
        );
        heads += 1;
        // The `101` cases are the ones with a conversation, and the list the generator wrote is the one
        // this file has to agree with — a case the port refused and the route accepted shows up here.
        let upgraded = summary.iter().any(|name| name == &case.name);
        assert_eq!(
            upgraded,
            written.head.starts_with(b"HTTP/1.1 101"),
            "{}: the port and the capture disagree about which requests became sockets",
            case.name,
        );
        if upgraded {
            // Which row the connection is *on* is invisible on the wire, and the credential order is exactly
            // the thing that decides it: `seam.cookieBeatsBearer` and `seam.ticketBeatsCookie` both present
            // two valid credentials naming two seeded rows.
            assert_eq!(
                written.session.as_deref(),
                case.seed["session"].as_str(),
                "{}: the port authenticated a different session than the case seeded",
                case.name,
            );
        }
        if !upgraded {
            if let Some(peer) = &case.peer {
                panic!(
                    "{}: the capture read a socket the port never made ({peer})",
                    case.name
                );
            }
            rows_compared += usize::from(compare_row(case, &rows));
            continue;
        }
        connections += 1;
        let expected: Vec<&Value> = case
            .frames
            .iter()
            .filter(|frame| direction(frame) == "s2c")
            .collect();
        assert_eq!(
            written.frames.len(),
            expected.len(),
            "{}: the port wrote {} frames where the capture holds {}",
            case.name,
            written.frames.len(),
            expected.len(),
        );
        // One inflate context per deflated connection, fed the port's own answers in order — the same
        // shape `transport_golden.rs` compares on, for the same reason.
        let mut reader =
            deflate::negotiate(Request::parse(&case.request).extensions.unwrap_or_default())
                .expect("the offer the capture sent is one the port accepts")
                .as_ref()
                .map(Inbound::new);
        for (index, record) in expected.iter().enumerate() {
            compare_frame(case, index, record, &written.frames[index], reader.as_mut());
            frames_compared += 1;
            if flag(record, "rsv1") {
                deflated += 1;
            }
        }
        // `after close: fin` is the capture's own word for the FIN this port says it would have written.
        let hung_up = case.peer.as_deref() == Some("after close: fin");
        assert_eq!(
            written.hang_up, hung_up,
            "{}: the port and the capture disagree about who ended the socket",
            case.name,
        );
        rows_compared += usize::from(compare_row(case, &rows));
    }
    assert_eq!(
        cases.len(),
        document["summary"]["scenarios"]
            .as_u64()
            .expect("a scenario count") as usize,
        "the replay does not hold the cases the generator ran",
    );
    assert_eq!(heads, cases.len(), "a case without a head");
    assert_eq!(
        frames_compared,
        document["summary"]["serverToClient"]
            .as_u64()
            .expect("a frame count") as usize,
        "not every recorded answer was compared",
    );
    assert_eq!(
        deflated,
        document["summary"]["rsv1Used"].as_u64().expect("a count") as usize,
        "not every deflated answer was compared",
    );
    assert_eq!(
        connections,
        string_list(&document, "upgraded").len(),
        "the port made a different number of connections",
    );
    assert_eq!(
        rows_compared,
        array(&document, "events")
            .iter()
            .filter(|event| event["event"] == "row")
            .count(),
        "not every recorded row was compared",
    );
    eprintln!(
        "seam_golden: {heads} heads, {frames_compared} answers ({deflated} deflated), {rows_compared} rows"
    );
}

fn string_list(document: &Value, key: &str) -> Vec<String> {
    array(&document["summary"], key)
        .iter()
        .map(|name| name.as_str().expect("a case name").to_owned())
        .collect()
}
