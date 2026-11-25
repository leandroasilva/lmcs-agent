//! The upgrade: which request becomes a `101`, and which becomes an answer that never was one.
//!
//! Two different writers produced the eight non-`101` responses the capture holds, and merging them is the
//! mistake this module exists to prevent:
//!
//! - **The response pipeline** answers a request that reached the route and never became a socket:
//!   `upgrade-golden.ts` wrote the `GET /ws` with no `Upgrade` as `400 Bad Request` with `Date`,
//!   `Connection: keep-alive`, `Keep-Alive: timeout=5` and a chunked empty body. `seam-golden.ts` then
//!   measured *when* those bytes appear: the route's auth step, its origin read and its connection record
//!   had **already run**, so the session row says the client connected even though no socket ever existed
//!   (see [`crate::transport::Seam::NotUpgrade`]). A port that answered this request before auth, because
//!   "it is only a routing question", loses a database write the shipped server performs.
//! - **The router** answers a request the route never sees: `POST /ws` and `GET /nope` are both
//!   `404 Not Found`, stamped `Date`, chunked, and without the `Keep-Alive` the `400` carries. Nothing is
//!   recorded for these — `seam-golden.ts`'s `seam.postWs` row still has a null `last_connected_at`, which
//!   is what proves method/path matching runs ahead of auth.
//! - **`ws`** writes its own protocol refusals **straight onto the socket**: no `Date`, the connection
//!   already closing, and a byte-exact `Content-Length` counting the sentence —
//!   `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: <n>\r\n`
//!   `[Sec-WebSocket-Version: 13, 8\r\n]\r\n<sentence>` (`abortHandshake`, `websocket-server.js:505-530`).
//!   A port that reworded a sentence without rewriting its length writes a corrupt response. And the
//!   bracket the route opened does not close: the mark ran, the release never does, so the row is left
//!   counting a connection that was refused.
//!
//! Every header name is **title case** on the wire, from both writers: Node does not lowercase the names
//! `ws` hands it. And the `101` carries exactly `Upgrade`, `Connection`, `Sec-WebSocket-Accept`, then
//! `Sec-WebSocket-Protocol`, then `Sec-WebSocket-Extensions` — no `Date`, no `Server`, because nothing a
//! response pipeline would add ran over these bytes.
//!
//! The checks `ws` runs, in order, are key, version, protocol, extension offer: one request can be invalid
//! two ways and the first decides the sentence the client reads. The key check is the surprising one,
//! `/^[+/0-9A-Za-z]{22}==$/` — exactly 24 characters, so an unpadded key is refused, which is *stricter*
//! than RFC 4648 asks and is why a port cannot accept any base64 it can decode.

use base64::Engine;
use sha1_smol::Sha1;

/// RFC 6455's magic string, appended to the key before hashing.
pub const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The `Sec-WebSocket-Key` shape `ws` requires: 22 base64 characters and exactly two `=`.
#[must_use]
pub fn key_is_well_formed(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 24
        && bytes[..22]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && bytes[22] == b'='
        && bytes[23] == b'='
}

/// The `Sec-WebSocket-Accept` value for a key: base64 of the SHA-1 of `key + GUID`.
#[must_use]
pub fn accept(key: &str) -> String {
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest.digest().bytes())
}

/// A refusal `ws` writes itself, with the body it writes for it.
///
/// Notably absent: a wrong method and a missing `Upgrade` header. Neither reaches `ws` — the router has
/// already answered them, which is what [`Routed`] is for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    Key,
    /// A version other than 13 or 8, which is the pair `ws` accepts and therefore the pair the refusal's
    /// `Sec-WebSocket-Version` header advertises.
    Version,
    /// A `Sec-WebSocket-Protocol` header that is not a comma list of tokens.
    Protocol,
    /// A `permessage-deflate` offer that cannot be accepted. The three ways to earn this one — an unknown
    /// parameter, a repeated parameter, an out-of-range `server_max_window_bits` — all write the *same*
    /// sentence, so the client cannot tell them apart.
    Extensions,
}

impl Refusal {
    #[must_use]
    pub const fn body(self) -> &'static str {
        match self {
            Self::Key => "Missing or invalid Sec-WebSocket-Key header",
            Self::Version => "Missing or invalid Sec-WebSocket-Version header",
            Self::Protocol => "Invalid Sec-WebSocket-Protocol header",
            // 55 bytes, which is what the captured `content-length` counts.
            Self::Extensions => "Invalid or unacceptable Sec-WebSocket-Extensions header",
        }
    }
}

/// The refusal as bytes: the four fixed headers, the version header when there is one, and the body.
#[must_use]
pub fn refuse(refusal: Refusal) -> Vec<u8> {
    let body = refusal.body();
    let mut out = format!(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: {}\r\n",
        body.len(),
    );
    if refusal == Refusal::Version {
        out.push_str("Sec-WebSocket-Version: 13, 8\r\n");
    }
    out.push_str("\r\n");
    out.push_str(body);
    out.into_bytes()
}

/// Where the router hands a request to `ws` and where it answers alone, the two auth refusals are three
/// writers' work, and the third one is the mistake this module keeps separate from [`Refusal`]:
/// `failEnvironmentAuthInvalid` and `failEnvironmentInternal` (`auth/http.ts`) go through Node's response
/// pipeline, so they get a `Date`, a lowercase `content-type` and `content-length`, and
/// `Connection: keep-alive` — while the socket behind a *websocket* refusal is already being torn down,
/// which is why the measured head for `refuse-missing` over an upgrade carries no `Keep-Alive` and the
/// same refusal over a plain `GET` does.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Denied {
    tag: &'static str,
    code: &'static str,
    reason: &'static str,
    dpop: Option<&'static str>,
    status: (u16, &'static str),
}

impl Denied {
    /// The 401, whose body is `EnvironmentAuthInvalidError`. `dpop` is only ever set by the DPoP paths,
    /// and it moves `content-length` from 114 to 150, so it belongs to the body rather than to a log.
    #[must_use]
    pub const fn credential(reason: &'static str, dpop: Option<&'static str>) -> Self {
        Self {
            tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason,
            dpop,
            status: (401, "Unauthorized"),
        }
    }

    /// The 500, which is the same shape under a different tag: a refused credential and a broken
    /// database are one writer apart and a whole status apart on the wire.
    #[must_use]
    pub const fn internal() -> Self {
        Self {
            tag: "EnvironmentInternalError",
            code: "internal_error",
            reason: "internal_error",
            dpop: None,
            status: (500, "Internal Server Error"),
        }
    }

    /// The JSON the two writers build, with the key order they build it in and the trace id the caller
    /// read off the context manager — `"unavailable"` when there is no span, which is the common case on
    /// an upgrade because the route's auth step runs before any span is opened.
    #[must_use]
    pub fn body(&self, trace_id: &str) -> String {
        let mut out = format!(
            "{{\"_tag\":\"{}\",\"code\":\"{}\",\"reason\":\"{}\"",
            self.tag, self.code, self.reason,
        );
        if let Some(dpop) = self.dpop {
            out.push_str(&format!(",\"dpopFailureReason\":\"{dpop}\""));
        }
        out.push_str(&format!(",\"traceId\":{}", crate::json::quote(trace_id)));
        out.push('}');
        out
    }

    /// The whole response, with the header order Node wrote. `date` is the caller's because Node stamps
    /// the wall clock and the golden exempts that one header from the byte comparison.
    #[must_use]
    pub fn write(&self, date: &str, trace_id: &str, keep_alive: bool) -> Vec<u8> {
        let body = self.body(trace_id);
        let (code, phrase) = self.status;
        let mut out = format!(
            "HTTP/1.1 {code} {phrase}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nDate: {date}\r\nConnection: keep-alive\r\n",
            body.len(),
        );
        if keep_alive {
            out.push_str("Keep-Alive: timeout=5\r\n");
        }
        out.push_str("\r\n");
        out.push_str(&body);
        out.into_bytes()
    }
}

/// A request the websocket layer never turned into a socket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Routed {
    /// `GET` on the websocket route with no `Upgrade: websocket`. The route ran before this was written,
    /// which is the claim [`crate::transport::Seam::NotUpgrade`] carries; this module only knows the
    /// bytes. The only one of these answers that carries a `Keep-Alive`.
    NotUpgrade,
    /// Nothing matched the method or the path: `POST /ws`, `GET /nope`. The route never ran, so nothing
    /// was recorded for it.
    NoRoute,
}

/// The router's answer, chunked and bodyless. `date` is the caller's, because Node stamps the wall clock and
/// the golden exempts that one header from the byte comparison.
#[must_use]
pub fn routed(date: &str, refusal: Routed) -> Vec<u8> {
    let (code, phrase) = match refusal {
        Routed::NotUpgrade => (400, "Bad Request"),
        Routed::NoRoute => (404, "Not Found"),
    };
    let mut out = format!("HTTP/1.1 {code} {phrase}\r\nDate: {date}\r\nConnection: keep-alive\r\n");
    if refusal == Routed::NotUpgrade {
        out.push_str("Keep-Alive: timeout=5\r\n");
    }
    out.push_str("Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
    out.into_bytes()
}

/// Write the `101`, in the measured order. The two optional headers appear only when they were earned:
/// `handshake.noExtensions` proved an unoffered extension is *absent* rather than empty, and
/// `offer.protocolAndDeflate` is the one case that pins the protocol-before-extensions order.
#[must_use]
pub fn upgrade(key: &str, protocol: Option<&str>, extensions: Option<&str>) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n",
        accept(key),
    );
    if let Some(protocol) = protocol {
        out.push_str("Sec-WebSocket-Protocol: ");
        out.push_str(protocol);
        out.push_str("\r\n");
    }
    if let Some(extensions) = extensions {
        out.push_str("Sec-WebSocket-Extensions: ");
        out.push_str(extensions);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

/// What `request.cookies` is: `Cookies.parseHeader` (`unstable/http/Cookies.js:593-617`) over the
/// `cookie` header, as a name-keyed list rather than a `Map`.
///
/// Four rules are the parser's and not RFC 6265's, and the seam measured three of them:
/// - **The first pair of a repeated name wins** — the `Object.hasOwn` guard — so
///   `seam.duplicateCookie`'s `name=junk; name=<token>` authenticates with *nothing* (`invalid_credential`
///   from the signature) rather than with the token in second position.
/// - **A quoted value loses one character at each end** (`substring(eqIdx + 1, terminatorPos - 1)`),
///   which is why `seam.quotedCookie` is the same credential as the bare one. The subtraction is
///   unconditional: a pair ending in the closing quote is what makes it land on the quote.
/// - **A `%` anywhere sends** (`val.indexOf("%") === -1`), and `decodeURIComponent` *throws* on a lone
///   `%`, a non-hex escape and an invalid byte sequence, in which case `tryDecodeURIComponent` hands back
///   the text as it was. This is the reason `seam.percentCookie`'s `%2E` reaches the verifier as `.`.
/// - **A pair with no `=` ends the parse** (`break`, not `continue`), and a pair whose `=` sits past the
///   next `;` is skipped. Neither is measured here; both are how `"junk; name=tok"` still finds `name`.
///
/// Indices are counted in `char`s where JavaScript counts UTF-16 code units, so a non-BMP character in a
/// cookie shifts them by one. No token can reach that: a session token is base64url and a dot.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Cookies {
    entries: Vec<(String, String)>,
}

impl Cookies {
    #[must_use]
    pub fn parse(header: &str) -> Self {
        let characters: Vec<char> = header.chars().collect();
        let length = characters.len();
        let find = |needle: char, from: usize| {
            let from = from.min(length);
            characters[from..]
                .iter()
                .position(|c| *c == needle)
                .map(|offset| from + offset)
        };
        let text = |range: std::ops::Range<usize>| -> String {
            characters[range.start.min(length)..range.end.min(length)]
                .iter()
                .collect()
        };
        let mut entries = Vec::new();
        let mut pos = 0;
        let mut terminator = 0;
        // `while (true) { if (terminatorPos === strLen) break; … }`, which is how a trailing `;` ends the
        // walk one iteration before the empty pair after it would be read.
        while terminator != length {
            terminator = find(';', pos).unwrap_or(length);
            let Some(equals) = find('=', pos) else {
                break;
            };
            if equals > terminator {
                pos = terminator + 1;
                continue;
            }
            let name = crate::auth::js_trim(&text(pos..equals)).to_owned();
            if !entries.iter().any(|(kept, _)| *kept == name) {
                let value_start = equals + 1;
                let value = if characters.get(value_start) == Some(&'"') {
                    // `substring(start, end)` swaps its arguments when start is past end, so `name="` is
                    // the quote itself rather than the empty string.
                    let start = value_start + 1;
                    let end = terminator.saturating_sub(1);
                    let (low, high) = if start <= end {
                        (start, end)
                    } else {
                        (end, start)
                    };
                    text(low..high)
                } else {
                    text(value_start..terminator)
                };
                let value = crate::auth::js_trim(&value);
                let value = if value.contains('%') {
                    decode_uri_component(value)
                } else {
                    value.to_owned()
                };
                entries.push((name, value));
            }
            pos = terminator + 1;
        }
        Self { entries }
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// `decodeURIComponent`, as far as a cookie header needs it: percent bytes collected and then UTF-8
/// decoded, with the original text returned whenever either step would throw. Unlike
/// [`percent_decode`] this leaves `+` alone, because `decodeURIComponent("+")` is `"+"`.
fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let escape = |offset: usize| bytes.get(offset).copied().and_then(hex_value);
        let (Some(high), Some(low)) = (escape(index + 1), escape(index + 2)) else {
            return text.to_owned();
        };
        out.push(high << 4 | low);
        index += 3;
    }
    // A surrogate encoded as three bytes (`%ED%A0%80`) is invalid UTF-8 here and a `URIError` in
    // JavaScript, so the same refusal covers both.
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// The surfaces `ClientSurface` names (`baseSchemas.ts:158`), which is the whole whitelist
/// `readClientConnectionOrigin` accepts. Anything else is dropped rather than normalised, so a client
/// announcing `tv` is recorded as announcing nothing.
pub const CLIENT_SURFACES: [&str; 4] = ["web", "desktop", "mobile", "cli"];

/// `MAX_CLIENT_APP_VERSION_LENGTH` (`ws.ts:419`), counted in UTF-16 code units because JavaScript
/// measured it in JavaScript.
pub const MAX_CLIENT_APP_VERSION_LENGTH: usize = 64;

/// What the upgrade URL said about the client, as `recordClientConnection` kept it.
///
/// Both fields are optional because the shipped struct is (`OrchestrationClientOrigin`), and the route is
/// *lenient by design*: `ws.ts:421-423` says a malformed value degrades to `{}` rather than failing the
/// connection, so attribution can never be a reason a client is refused. `seam-golden.ts` reads this back
/// out of the database rather than out of the function, since the row is the only place all three rules
/// (whitelist, trim, cap) are visible at once.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Origin {
    pub surface: Option<&'static str>,
    pub app_version: Option<String>,
}

impl Origin {
    /// `SessionStore.ts:605`'s guard: with nothing kept there is no `UPDATE` at all, which is why
    /// `seam.originBogus` left the earlier row alone rather than nulling it.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.surface.is_none() && self.app_version.is_none()
    }
}

/// The handful of request fields the upgrade decision reads, plus every header line it saw.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Request<'a> {
    pub method: &'a str,
    /// The request target as the client wrote it, query and fragment included. This is what
    /// `HttpServerRequest.toURL` reads for the ticket, and the *text* is what the route answers with, so
    /// it is kept undecoded.
    pub target: &'a str,
    /// Lowercased, as Node hands headers to `ws`.
    pub upgrade: Option<&'a str>,
    pub key: Option<&'a str>,
    pub version: Option<&'a str>,
    pub protocol: Option<&'a str>,
    pub extensions: Option<&'a str>,
    /// The `Authorization` header, which the upgrade reads only once the ticket has said nothing
    /// ([`crate::auth::authenticate_request`]). Its *presence* matters as much as its value:
    /// `hasAuthorization` (`EnvironmentAuth.ts:651`) is `headers.authorization !== undefined`, so an
    /// empty one still blocks the dev-cookie fallback.
    pub authorization: Option<&'a str>,
    /// `(name, value)` as written, in arrival order. The fields above are what the upgrade
    /// decision needs; this is what an rpc on the resulting connection is allowed to read, which is
    /// why nothing here is lowercased or joined yet — [`Request::handler_headers`] does that once,
    /// the way Node's parser and `Headers.fromInput` do it.
    pub lines: Vec<(&'a str, &'a str)>,
}

impl<'a> Request<'a> {
    /// `request.cookies`, i.e. `parseHeader(this.headers.cookie ?? "")` over the **first** `Cookie` line.
    /// Node does not fold two of them into one value before this layer sees them, which is what
    /// `seam.duplicateCookieHeaders` measured: the second line names no credential at all and the first
    /// still authenticates.
    #[must_use]
    pub fn cookies(&self) -> Cookies {
        Cookies::parse(
            self.lines
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("cookie"))
                .map_or("", |(_, value)| value),
        )
    }

    /// The socket's header list, in the shape [`crate::headers`] prepends to every `Request` frame.
    #[must_use]
    pub fn handler_headers(&self) -> Vec<crate::headers::Pair> {
        crate::headers::from_lines(self.lines.iter().copied())
    }

    /// `readClientConnectionOrigin` (`ws.ts:424-440`), field for field.
    ///
    /// Two asymmetries are the whole function and neither is guessable: the surface is matched **raw**, so
    /// `?clientSurface=%20web` is not a surface, while the version is trimmed first, so
    /// `?clientAppVersion=%20%20` is absent rather than blank. And the version cap is a length test, not a
    /// truncation — a 65-character version is *dropped*, which is what `seam.originTooLong` and
    /// `seam.originExactlyMax` put on either side of 64.
    #[must_use]
    pub fn client_origin(&self) -> Origin {
        let surface = query_param(self.target, "clientSurface")
            .and_then(|value| CLIENT_SURFACES.into_iter().find(|known| *known == value));
        // `?.trim() ?? ""`, then two conditions on the trimmed text.
        let app_version = query_param(self.target, "clientAppVersion")
            .map(|value| crate::auth::js_trim(&value).to_owned())
            .filter(|value| {
                !value.is_empty() && value.encode_utf16().count() <= MAX_CLIENT_APP_VERSION_LENGTH
            });
        Origin {
            surface,
            app_version,
        }
    }

    /// A header by name, first line wins — the way Node's parsed header map hands one to Effect, whose
    /// keys are already lowercased.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&'a str> {
        self.lines
            .iter()
            .find(|(line, _)| line.eq_ignore_ascii_case(name))
            .map(|(_, value)| *value)
    }

    /// `HttpServerRequest.toURL` (`HttpServerRequest.ts:1027-1035`): `new URL(request.url, protocol +
    /// "://" + (headers.host ?? "localhost"))`, with the protocol flipped by `x-forwarded-proto: https`.
    /// The caller takes `.href`, which is what [`crate::dpop::normalize_htu`] then strips.
    ///
    /// This is the origin-form half of WHATWG, which is all this route can be handed: Node reports an
    /// absolute-form target only to a proxy, and a target that is neither origin-form nor empty never
    /// reaches `/ws` at all, so `None` here is the same answer `toURL` would have failed to build. The
    /// parts of `new URL` that cannot move for a target the HTTP parser already accepted are not
    /// ported — IDNA on the host, the default-port rule, and percent-encoding of path characters.
    #[must_use]
    pub fn url(&self) -> Option<String> {
        let host = self.header("host").unwrap_or("localhost");
        let scheme = if self.header("x-forwarded-proto") == Some("https") {
            "https"
        } else {
            "http"
        };
        let authority = host.to_ascii_lowercase();
        // An empty authority, or one holding a delimiter, is the throw the route answers with — and it
        // carries no `dpopFailureReason`, because the guard that reaches it is before the proof.
        if authority.is_empty()
            || !authority.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '-' | '.' | '_' | ':' | '[' | ']' | '%' | '~')
            })
        {
            return None;
        }
        let path = match self.target {
            "" => "/",
            target if target.starts_with('/') => target,
            _ => return None,
        };
        Some(format!("{scheme}://{authority}{path}"))
    }

    /// Whether the router hands the request to the websocket layer at all, which needs a `GET` and an
    /// `Upgrade` header spelling the whole token `websocket`, case-insensitively. Everything [`Refusal`] can
    /// produce presupposes it.
    #[must_use]
    pub fn is_upgrade(&self) -> bool {
        self.method == "GET"
            && self
                .upgrade
                .is_some_and(|upgrade| upgrade.eq_ignore_ascii_case("websocket"))
    }

    /// Read the fields out of a request head. Every `name: value` line is kept, in order, so a
    /// connection can later answer what an rpc on it may read; the six slots are the ones the
    /// upgrade decision looks at.
    #[must_use]
    pub fn parse(head: &'a str) -> Self {
        let mut out = Self::default();
        let mut lines = head.split("\r\n");
        if let Some(line) = lines.next() {
            let mut pieces = line.split(' ');
            out.method = pieces.next().unwrap_or_default();
            out.target = pieces.next().unwrap_or_default();
        }
        for line in lines {
            if line.is_empty() {
                break;
            }
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            out.lines.push((name, value));
            let slot = match name.trim().to_ascii_lowercase().as_str() {
                "upgrade" => &mut out.upgrade,
                "sec-websocket-key" => &mut out.key,
                "sec-websocket-version" => &mut out.version,
                "sec-websocket-protocol" => &mut out.protocol,
                "sec-websocket-extensions" => &mut out.extensions,
                "authorization" => &mut out.authorization,
                _ => continue,
            };
            // A header repeated in the head has already been comma-joined by Node before this layer sees
            // it, which is what `headers.repeated` measured; the overwrite is only the fallback for a
            // caller that hands this function raw lines.
            *slot = Some(value);
        }
        out
    }

    /// `ws`'s order of checks (`websocket-server.js:248-320`), up to but not including the extension
    /// offer, which needs [`crate::deflate::negotiate`] and so belongs to the caller.
    #[must_use]
    pub fn refusal(&self) -> Option<Refusal> {
        if !self.key.is_some_and(key_is_well_formed) {
            return Some(Refusal::Key);
        }
        if !matches!(self.version, Some("13") | Some("8")) {
            return Some(Refusal::Version);
        }
        if self
            .protocol
            .is_some_and(|protocol| !is_token_list(protocol))
        {
            return Some(Refusal::Protocol);
        }
        None
    }
}

/// `new URL(target, base)` to the two pieces the websocket route reads.
///
/// The fragment is cut before anything else, which is what makes `/ws##?wsTicket=x` a request with **no**
/// query at all, and the query keeps its `?` because that is the text `url.search` answers with and the
/// golden compares against.
#[must_use]
pub fn split_target(target: &str) -> (&str, &str) {
    let head = target.split('#').next().unwrap_or(target);
    match head.find('?') {
        // A `?` with nothing after it is no query at all, which is what `url.search` reports: the
        // empty string, not the bare marker.
        Some(index) if index + 1 < head.len() => (&head[..index], &head[index..]),
        Some(index) => (&head[..index], ""),
        None => (head, ""),
    }
}

/// `url.searchParams`, as far as the route needs it: the pairs in order, decoded the way
/// `application/x-www-form-urlencoded` says. That is not a string search — `+` is a space, `%zz` survives
/// as three characters, a bare key is the empty string rather than an absent one, and only the first `=`
/// separates, so `wsTicket=a=b` names the value `a=b`.
#[must_use]
pub fn query_pairs(search: &str) -> Vec<(String, String)> {
    let search = search.strip_prefix('?').unwrap_or(search);
    let mut out = Vec::new();
    for token in search.split('&') {
        if token.is_empty() {
            continue;
        }
        let (name, value) = match token.split_once('=') {
            Some((name, value)) => (name, value),
            None => (token, ""),
        };
        out.push((percent_decode(name), percent_decode(value)));
    }
    out
}

/// `searchParams.get(name)`, which answers the **first** match and is case sensitive, so a client that
/// sends `?WSTICKET=a&wsTicket=b` authenticates with `b`.
#[must_use]
pub fn query_param(target: &str, name: &str) -> Option<String> {
    let (_, search) = split_target(target);
    query_pairs(search)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// WHATWG's `UTF-8 decode` over the percent-decoding: bytes first, replacement characters after, which
/// is why `%C3%A9` and `%D8%A3` arrive as text while a lone `%C3` does not.
fn percent_decode(token: &str) -> String {
    let bytes = token.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                match (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high << 4 | low);
                        index += 3;
                    }
                    _ => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One hex digit, or nothing. Working byte by byte rather than by slicing the string is also what keeps
/// this total: `%` before a multi-byte character is not a character boundary to index into.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `subprotocol.parse`'s rule: a comma-separated list of non-empty RFC 7230 tokens.
fn is_token_list(value: &str) -> bool {
    value.split(',').all(|token| {
        let token = token.trim();
        !token.is_empty()
            && token.bytes().all(|byte| {
                b"!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                    .contains(&byte)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The RFC 6455 example the capture sends on every scenario.
    #[test]
    fn the_accept_value_is_the_rfc_example() {
        assert_eq!(
            accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn the_key_must_be_padded_to_exactly_24_characters() {
        assert!(key_is_well_formed("dGhlIHNhbXBsZSBub25jZQ=="));
        assert!(!key_is_well_formed("dGhlIHNhbXBsZSBub25jZ="));
        assert!(!key_is_well_formed(""));
    }

    /// Every recorded `101`, checked against the artifact's header list.
    #[test]
    fn the_upgrade_writes_the_measured_headers_in_order() {
        assert_eq!(
            upgrade("dGhlIHNhbXBsZSBub25jZQ==", None, Some("permessage-deflate")),
            b"HTTP/1.1 101 Switching Protocols\r\n\
              Upgrade: websocket\r\n\
              Connection: Upgrade\r\n\
              Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\
              Sec-WebSocket-Extensions: permessage-deflate\r\n\
              \r\n"
                .to_vec()
        );
        assert_eq!(
            upgrade("dGhlIHNhbXBsZSBub25jZQ==", Some("t3"), None),
            b"HTTP/1.1 101 Switching Protocols\r\n\
              Upgrade: websocket\r\n\
              Connection: Upgrade\r\n\
              Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\
              Sec-WebSocket-Protocol: t3\r\n\
              \r\n"
                .to_vec()
        );
    }

    /// The two answers the router writes before `ws` is consulted, byte for byte apart from the date.
    #[test]
    fn the_router_answers_a_request_that_is_not_an_upgrade() {
        assert_eq!(
            routed("Tue, 24 Nov 2026 09:00:00 GMT", Routed::NotUpgrade),
            b"HTTP/1.1 400 Bad Request\r\nDate: Tue, 24 Nov 2026 09:00:00 GMT\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec()
        );
        assert_eq!(
            routed("Tue, 24 Nov 2026 09:00:00 GMT", Routed::NoRoute),
            b"HTTP/1.1 404 Not Found\r\nDate: Tue, 24 Nov 2026 09:00:00 GMT\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec()
        );
    }

    /// `handshake.missingKey` and `handshake.version7`, byte for byte including the length.
    #[test]
    fn the_refusals_carry_their_own_length() {
        assert_eq!(
            refuse(Refusal::Key),
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 43\r\n\r\nMissing or invalid Sec-WebSocket-Key header".to_vec()
        );
        assert_eq!(
            refuse(Refusal::Version),
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 47\r\nSec-WebSocket-Version: 13, 8\r\n\r\nMissing or invalid Sec-WebSocket-Version header".to_vec()
        );
        assert_eq!(
            refuse(Refusal::Extensions),
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 55\r\n\r\nInvalid or unacceptable Sec-WebSocket-Extensions header".to_vec()
        );
    }

    /// Which request the router answers and which `ws` answers, in `ws`'s order.
    #[test]
    fn the_checks_run_in_ws_order() {
        let missing_key = Request::parse(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        assert!(missing_key.is_upgrade());
        assert_eq!(missing_key.refusal(), Some(Refusal::Key));
        assert!(
            !Request::parse("GET /ws?orchestrationProtocol=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .is_upgrade(),
            "with no `Upgrade` header the router answers, so `ws` never sees it"
        );
        assert!(
            !Request {
                method: "POST",
                upgrade: Some("websocket"),
                ..Default::default()
            }
            .is_upgrade()
        );
        let well_formed = Request {
            method: "GET",
            upgrade: Some("websocket"),
            key: Some("dGhlIHNhbXBsZSBub25jZQ=="),
            ..Default::default()
        };
        assert_eq!(
            Request {
                version: Some("8"),
                ..well_formed.clone()
            }
            .refusal(),
            None,
            "hybi-08 is accepted, which is why `handshake.badVersion` got a 101"
        );
        assert_eq!(
            Request {
                version: Some("7"),
                ..well_formed
            }
            .refusal(),
            Some(Refusal::Version),
        );
    }

    #[test]
    fn a_protocol_header_is_a_list_of_tokens() {
        assert!(is_token_list("t3"));
        assert!(is_token_list("t3, chat"));
        assert!(!is_token_list("t3,,"));
        assert!(!is_token_list("\"quoted\""));
    }

    /// The three measured cookie rules, and the two the seam could not reach but the vendored parser has.
    #[test]
    fn the_first_pair_of_a_repeated_name_wins() {
        // `seam.duplicateCookie`: the junk in first position is the credential, so the token is never read.
        let cookies = Cookies::parse("t3_session_test=junk; t3_session_test=good");
        assert_eq!(cookies.get("t3_session_test"), Some("junk"));
        // ...and the second name is still parsed, so only the repeated one is lost.
        let cookies = Cookies::parse("a=1; b=2; a=3");
        assert_eq!(cookies.get("b"), Some("2"));
        assert_eq!(cookies.get("a"), Some("1"));
    }

    #[test]
    fn a_quoted_value_loses_one_character_at_each_end() {
        assert_eq!(
            Cookies::parse("a=\"token\"; b=x").get("a"),
            Some("token"),
            "`seam.quotedCookie` authenticated, so the quotes cost nothing"
        );
        assert_eq!(
            Cookies::parse("a=").get("a"),
            Some(""),
            "an empty value is present, which is what makes an empty session cookie a credential"
        );
        assert_eq!(
            Cookies::parse("a=\"").get("a"),
            Some("\""),
            "`substring(start, end)` swaps its arguments, so the lone quote is what survives"
        );
    }

    #[test]
    fn a_percent_anywhere_sends_and_a_bad_escape_survives() {
        assert_eq!(
            Cookies::parse("a=%2E%2E").get("a"),
            Some(".."),
            "`seam.percentCookie`: the flag is `indexOf(\"%\")`, then the whole value is decoded"
        );
        assert_eq!(
            Cookies::parse("a=100%").get("a"),
            Some("100%"),
            "`decodeURIComponent` throws and `tryDecodeURIComponent` hands the text back"
        );
        assert_eq!(
            Cookies::parse("a=%zz").get("a"),
            Some("%zz"),
            "a non-hex escape is the same throw"
        );
        assert_eq!(
            Cookies::parse("a=%ED%A0%80").get("a"),
            Some("%ED%A0%80"),
            "an encoded surrogate is a `URIError`, which the same fallback covers"
        );
        assert_eq!(
            Cookies::parse("a=b+c%2E").get("a"),
            Some("b+c."),
            "unlike a query string, a cookie value does not read `+` as a space — and the decode only runs \
             because the `%` is there at all"
        );
    }

    #[test]
    fn an_unseparated_pair_ends_the_parse_and_an_equals_after_a_semicolon_skips_one() {
        assert_eq!(
            Cookies::parse("junk").entries,
            Vec::new(),
            "no `=` left in the remainder is the `break`, so nothing after it is read either"
        );
        assert_eq!(
            Cookies::parse("junk; a=1").get("a"),
            Some("1"),
            "...but a leading bare token only skips its own run, because `indexOf(\"=\")` searches past the \
             `;` and the skip is the `eqIdx > terminatorPos` branch"
        );
        assert_eq!(
            Cookies::parse("a=1; junk").get("a"),
            Some("1"),
            "a trailing one is never read, because the walk ends at the last `;`"
        );
        let cookies = Cookies::parse("a; b=2; c=3");
        assert_eq!(
            (cookies.get("a"), cookies.get("b"), cookies.get("c")),
            (None, Some("2"), Some("3")),
            "an `=` past the next `;` skips that pair rather than naming the whole run"
        );
    }

    #[test]
    fn names_and_values_are_trimmed_and_semicolons_are_not_part_of_a_value() {
        let cookies = Cookies::parse("  a  =  b  ;c=d;");
        assert_eq!(
            cookies,
            Cookies {
                entries: vec![
                    ("a".to_owned(), "b".to_owned()),
                    ("c".to_owned(), "d".to_owned())
                ],
            },
            "the trailing `;` ends the walk one iteration early rather than naming an empty pair"
        );
        assert_eq!(Cookies::parse(""), Cookies::default());
        assert_eq!(
            Cookies::parse("A=1").get("a"),
            None,
            "cookie names are compared as written, so the configured name has to match exactly"
        );
    }

    /// `seam.duplicateCookieHeaders` got a 101, which is only possible if the two headers were *not*
    /// comma-joined — a join would have corrupted the signature and read `invalid_credential`.
    #[test]
    fn the_credential_is_read_from_the_first_cookie_header() {
        let request = Request::parse(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: s=junk\r\nCookie: s=good\r\n\r\n",
        );
        assert_eq!(request.cookies().get("s"), Some("junk"));
        assert_eq!(
            Request::parse("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").cookies(),
            Cookies::default(),
            "no `Cookie` header is an empty list, not an absent credential of its own"
        );
        assert_eq!(
            Request::parse("GET /ws HTTP/1.1\r\ncookie: s=good\r\n\r\n")
                .cookies()
                .get("s"),
            Some("good"),
            "the header *name* is matched case-insensitively, as Node hands it lowercased"
        );
    }
}
