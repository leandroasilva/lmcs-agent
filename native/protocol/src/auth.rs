//! The `wsTicket`: what a signed websocket claim is, byte for byte, and which branch refuses one.
//!
//! The upgrade carries its credential in a query parameter rather than a header, because a browser's
//! `WebSocket` cannot set a header (`ws.ts:3804-3877` reads it, `EnvironmentAuth.ts:1075-1095` decides
//! with it). Everything the decision touches is here, ported from
//! `apps/server/src/auth/utils.ts:82-103` (`base64UrlEncode`, `base64UrlDecodeUtf8`, `signPayload`,
//! `timingSafeEqualBase64Url`), `SessionStore.ts:847-951` (`issueWebSocketToken`,
//! `verifyWebSocketToken`) and the claim schema at `SessionStore.ts:438-448`.
//!
//! Four things the port cannot get from a specification, each pinned by `tests/auth_golden.rs` against
//! the text `apps/server/scripts/auth-golden.ts` measured:
//!
//! - **There are two base64url decoders and they disagree.** The payload goes through Effect's
//!   [`decode_base64url`], which strips CRLF, rejects a length that is 1 mod 4, requires the URL-safe
//!   shape, and *fails* on anything else. The signature goes through Node's
//!   [`node_base64url`] (`Buffer.from(…, "base64url")`), which skips whatever it does not understand
//!   and never fails. So `"!!!!"` is a bad payload and an empty signature, and a signature that decodes
//!   to the same bytes compares equal however differently it was spelled ([`timing_safe_equal_base64url`]).
//! - **`AuthSessionId` trims before it counts** (`baseSchemas.ts:6-15,129-131`), with JavaScript's
//!   whitespace set, which is not Rust's: [`js_trim`] keeps U+0085 and U+001C-1F and removes U+00A0,
//!   U+2028, U+2029 and U+FEFF. A token whose `sid` is a lone U+00A0 decodes to nothing, so a mint that
//!   accepted it would refuse it back.
//! - **The claim numbers are JavaScript numbers.** `JSON.parse` turns `1e999` into `Infinity` and
//!   `Schema.Number` accepts it; `DateTime.make` then refuses it (`new Date(1e999).getTime()` is NaN),
//!   which is a different branch from an expired token. serde_json *errors* on that text, which is why
//!   [`decode_claims`] reads the document itself instead of reusing [`crate::json`].
//! - **The branch order is the refusal.** Signature before payload, payload before the clock, clock
//!   before the database row, row expiry before revocation. Nothing about the answer depends on it — all
//!   nine refusals write `invalid_credential` — but the *reason* the tenth case is a 500 rather than a
//!   401 does: `mapSessionVerificationErrors` (`EnvironmentAuth.ts:543-552`) routes the fourteen
//!   `SessionCredentialInvalidError` members to 401 and everything else to 500.

use sha2::Digest as _;

/// The query parameter the upgrade reads (`ws.ts`'s `WEBSOCKET_TICKET_QUERY_PARAM`).
pub const TICKET_PARAM: &str = "wsTicket";
/// `ReusableDevAuth.ts:8`. A token naming a session under this prefix is refused without a database
/// lookup unless it *is* the dev session, so the prefix is not a way to skip the revocation check.
pub const REUSABLE_DEV_SESSION_PREFIX: &str = "dev-auth-";
/// `SessionStore.ts:439-440`: the two literal fields a claim must carry.
pub const CLAIMS_VERSION: f64 = 1.0;
/// The same literal, as the text `Schema.Literal` writes when it refuses a claim.
pub const CLAIMS_VERSION_TEXT: &str = "1";
pub const CLAIMS_KIND: &str = "websocket";
/// `SessionStore.ts:879`: `${encodedPayload}.${signature}`.
pub const TOKEN_SEPARATOR: char = '.';
/// `new Date(ms)` is an invalid date past this, which is why an out-of-range `exp` is refused as a
/// bad claim rather than as an expiry.
pub const DATE_RANGE_MILLISECONDS: f64 = 8.64e15;

// ---------------------------------------------------------------------------
// HMAC-SHA256
// ---------------------------------------------------------------------------

/// HMAC-SHA256, which is `createHmac("sha256", secret).update(payload).digest()`.
///
/// Written out rather than pulled from an `hmac` crate: it is the RFC 2104 construction over the
/// `sha2` the crate already carries for `Sec-WebSocket-Accept`, and the two interesting cases — a key
/// longer than the block, an empty key — are the ones worth having in front of a test
/// (`auth-golden.ts`'s `hmac` block checks RFC 4231's cases 1, 2, 3, 6, 7 and 8).
#[must_use]
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let hashed = sha2::Sha256::digest(key);
        block[..hashed.len()].copy_from_slice(&hashed);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(BLOCK + message.len());
    let mut outer_head = [0u8; BLOCK];
    for (index, byte) in block.iter().enumerate() {
        inner.push(byte ^ 0x36);
        outer_head[index] = byte ^ 0x5c;
    }
    inner.extend_from_slice(message);
    let hashed_inner = sha2::Sha256::digest(&inner);
    let mut outer = Vec::with_capacity(BLOCK + hashed_inner.len());
    outer.extend_from_slice(&outer_head);
    outer.extend_from_slice(&hashed_inner);
    sha2::Sha256::digest(&outer).into()
}

// ---------------------------------------------------------------------------
// base64url, twice
// ---------------------------------------------------------------------------

/// `Encoding.encodeBase64Url`, and Node's `digest("base64url")`: the URL-safe alphabet with **no**
/// padding, which is the only reason a minted token never contains `=`.
#[must_use]
pub fn encode_base64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Why Effect's base64url decoder refused a payload. The three messages are the ones the shipped
/// server puts in a `Defect`, so they are wire text and not diagnostics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Base64UrlError {
    /// After CRLF is stripped: a length that is 1 mod 4 cannot be any base64 at all.
    Length(usize),
    /// The shape test `/^[-_A-Z0-9]*?={0,2}$/i` failing — a character outside the URL-safe alphabet, or
    /// padding in a place the alphabet does not put it.
    Shape,
    /// The one message the underlying standard decoder contributes: the padding repair produced a `=`
    /// that is not in the last two positions.
    StrayPadding,
}

impl Base64UrlError {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Length(length) => {
                format!("Length should be a multiple of 4, but is {length}")
            }
            Self::Shape => "Invalid input".to_owned(),
            Self::StrayPadding => "Found a '=' character, but it is not at the end".to_owned(),
        }
    }
}

/// `Encoding.decodeBase64Url` — see the module header for the rules it encodes.
pub fn decode_base64url(text: &str) -> Result<Vec<u8>, Base64UrlError> {
    let stripped: String = text.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let length = stripped.len();
    if length % 4 == 1 {
        return Err(Base64UrlError::Length(length));
    }
    let equals = stripped.matches('=').count();
    // `/^[-_A-Z0-9]*?={0,2}$/i` — the padding is a *suffix*, so `A=BC` is not a shape the decoder
    // repairs and then rejects, it is simply not base64url. A scan states that more honestly than the
    // regex does: any alphabet character after an `=`, or any character outside the URL-safe set, is
    // the same `Invalid input`.
    let mut padding = false;
    for character in stripped.chars() {
        if character == '=' {
            padding = true;
        } else if padding || !is_url_safe(character) {
            return Err(Base64UrlError::Shape);
        }
    }
    if equals > 2 {
        return Err(Base64UrlError::Shape);
    }
    // A padding repair has to be checked as an *order*, not only a count: `a=` becomes `a===`, whose
    // first `=` is not in the last two positions, and that is a different message from the shape test.
    let padded = match length % 4 {
        2 => format!("{stripped}=="),
        3 => format!("{stripped}="),
        _ => stripped.clone(),
    };
    let standard: String = padded
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    decode_base64(&standard)
}

/// `Encoding.decodeBase64`, which `decodeBase64Url` delegates to after sanitizing. Only the paths a
/// sanitized string can reach are implemented: the length is already a multiple of 4 and every
/// character is alphabet or `=`.
fn decode_base64(text: &str) -> Result<Vec<u8>, Base64UrlError> {
    let characters: Vec<char> = text.chars().collect();
    let length = characters.len();
    // The check Effect writes before decoding, and the one message a payload can earn that the URL-safe
    // shape test cannot see on its own: `a=` is a fine shape and repairs to `a===`, whose first `=` is
    // not in the last two positions.
    if let Some(index) = characters.iter().position(|c| *c == '=')
        && index < length - 2
    {
        return Err(Base64UrlError::StrayPadding);
    }
    let missing = if text.ends_with("==") {
        2
    } else if text.ends_with('=') {
        1
    } else {
        0
    };
    let mut out = Vec::with_capacity(length / 4 * 3 - missing);
    for group in characters.chunks(4) {
        let code = |index: usize| u32::from(base64_code(group[index]));
        let bits = code(0) << 18 | code(1) << 12 | code(2) << 6 | code(3);
        out.push((bits >> 16) as u8);
        out.push((bits >> 8) as u8);
        out.push(bits as u8);
    }
    out.truncate(out.len() - missing);
    Ok(out)
}

/// `getBase64Code`'s table, including the quirk that makes the truncate above correct: `=` codes as 0
/// rather than being an error.
fn base64_code(character: char) -> u8 {
    match character {
        'A'..='Z' => (character as u32 - 'A' as u32) as u8,
        'a'..='z' => (character as u32 - 'a' as u32 + 26) as u8,
        '0'..='9' => (character as u32 - '0' as u32 + 52) as u8,
        '+' | '-' => 62,
        '/' | '_' => 63,
        _ => 0,
    }
}

fn is_url_safe(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '-' || character == '_'
}

/// `base64UrlDecodeUtf8` (`auth/utils.ts:88-90`), which is `Result.getOrThrow` over
/// `Encoding.decodeBase64UrlString` — so a bad payload *throws*, and in `verifyWebSocketToken` that
/// throw is a defect rather than a refusal. The UTF-8 half is the non-fatal `TextDecoder`, which is
/// what `String::from_utf8_lossy` is.
pub fn decode_base64url_utf8(text: &str) -> Result<String, Base64UrlError> {
    Ok(String::from_utf8_lossy(&decode_base64url(text)?).into_owned())
}

/// `Buffer.from(text, "base64url")`. Different machine, different rules: Node's decoder walks the
/// string, drops anything outside the alphabet **including the padding**, and drops whatever bits are
/// left over when the characters run out. It cannot fail, which is exactly why
/// [`timing_safe_equal_base64url`] treats `"!!!!"` as the empty signature.
#[must_use]
pub fn node_base64url(text: &str) -> Vec<u8> {
    let mut bits: u32 = 0;
    let mut held = 0u32;
    let mut out = Vec::new();
    for character in text.chars() {
        let code = match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' | '-' | '_' => base64_code(character),
            // Padding is not data, and neither is anything else the alphabet does not name. A
            // non-BMP character is two UTF-16 code units to Node and one `char` here; neither reads as
            // a base64 digit, so both agree it contributes nothing.
            _ => continue,
        };
        bits = bits << 6 | u32::from(code);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

/// `timingSafeEqualBase64Url` (`auth/utils.ts:96-103`): both sides pre-decoded, then a length check,
/// then a constant-time compare. The pre-decode is the whole claim — the final character of a
/// signature contributes only the bits that survive truncation, so two spellings can be equal.
#[must_use]
pub fn timing_safe_equal_base64url(left: &str, right: &str) -> bool {
    let left = node_base64url(left);
    let right = node_base64url(right);
    if left.len() != right.len() {
        return false;
    }
    // `crypto.timingSafeEqual` on equal-length buffers is a non-short-circuiting xor fold.
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(&right) {
        difference |= left ^ right;
    }
    difference == 0
}

/// `signPayload` (`auth/utils.ts:92-94`).
#[must_use]
pub fn sign_payload(payload: &str, secret: &[u8]) -> String {
    encode_base64url(&hmac_sha256(secret, payload.as_bytes()))
}

// ---------------------------------------------------------------------------
// JavaScript's trim, which is not Rust's
// ---------------------------------------------------------------------------

/// ECMAScript's `WhiteSpace ∪ LineTerminator`, which is not `char::is_whitespace` and differs in both
/// directions: Rust counts U+0085, which is a space separator to Unicode and not one to the language,
/// and misses U+FEFF, which the language trims and Unicode does not call whitespace. The `payloads`
/// table measured both rows, so the table below is a claim and not a taste.
#[must_use]
pub const fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t'..='\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    let start = text.find(|c| !is_js_whitespace(c)).unwrap_or(text.len());
    let remainder = &text[start..];
    let end = remainder
        .char_indices()
        .rfind(|(_, c)| !is_js_whitespace(*c))
        .map_or(0, |(index, c)| index + c.len_utf8());
    &remainder[..end]
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

/// Why `WebSocketClaims` refused a payload's JSON, in the text Effect's schema failure prints. The
/// two-space indent and the `at ["key"]` path are part of the message the shipped server logs, and the
/// golden compares them whole.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayloadError {
    /// `JSON.parse` threw, so `Schema.fromJsonString` never saw a document.
    Syntax,
    /// A document that is not an object: `null`, `123`, `[]`, or a JSON string.
    NotObject,
    Missing {
        field: &'static str,
    },
    /// The field is there and is not what the schema wants. `expected` is the whole phrase before the
    /// newline, because the three shapes differ: a literal writes its own text (`Expected 1`,
    /// `Expected "websocket"`), a primitive names its type (`Expected string`, `Expected number`).
    Expected {
        expected: &'static str,
        field: &'static str,
    },
    /// `TrimmedNonEmptyString`'s check, which runs *after* the trim.
    EmptySid,
}

impl PayloadError {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Syntax => "Expected a valid JSON string".to_owned(),
            Self::NotObject => "Expected object".to_owned(),
            Self::Missing { field } => format!("Missing key\n  at [\"{field}\"]"),
            Self::Expected { expected, field } => {
                format!("Expected {expected}\n  at [\"{field}\"]")
            }
            Self::EmptySid => {
                "Expected a value with a length of at least 1\n  at [\"sid\"]".to_owned()
            }
        }
    }
}

/// A decoded claim. `iat` and `exp` stay `f64` because that is what the schema holds: `1.5` survives,
/// `1e999` survives as infinity and is refused by the clock check rather than here.
#[derive(Clone, Debug, PartialEq)]
pub struct Claims {
    pub sid: String,
    pub iat: f64,
    pub exp: f64,
}

impl Claims {
    /// `JSON.stringify` of the claims object: the five fields in the order the struct declares them,
    /// which is also the order `issueWebSocketToken` builds them in (`SessionStore.ts:854-860`). This
    /// is the exact text the signature covers, so a reordering here invalidates every token.
    #[must_use]
    pub fn json(&self) -> String {
        format!(
            "{{\"v\":{},\"kind\":\"{kind}\",\"sid\":{},\"iat\":{},\"exp\":{}}}",
            crate::json::float_text(CLAIMS_VERSION),
            crate::json::quote(&self.sid),
            crate::json::float_text(self.iat),
            crate::json::float_text(self.exp),
            kind = CLAIMS_KIND,
        )
    }
}

/// `issueWebSocketToken`'s expression: encode, sign, join. The `sid` is written as given, because the
/// store hands this a session id that `AuthSessionId.make` already trimmed.
#[must_use]
pub fn mint(sid: &str, iat: f64, exp: f64, secret: &[u8]) -> String {
    let claims = Claims {
        sid: sid.to_owned(),
        iat,
        exp,
    };
    let payload = encode_base64url(claims.json().as_bytes());
    format!(
        "{payload}{}{}",
        TOKEN_SEPARATOR,
        sign_payload(&payload, secret)
    )
}

/// `Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims))` (`SessionStore.ts:448`).
pub fn decode_claims(text: &str) -> Result<Claims, PayloadError> {
    let document = Document::read(text)?;
    let fields = match document {
        // A nested value where a scalar belongs still has to be *read*, so the object's members are
        // collected with their kinds rather than only their names.
        Document::Object(fields) => fields,
        _ => return Err(PayloadError::NotObject),
    };
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    };
    let required = |name: &'static str| field(name).ok_or(PayloadError::Missing { field: name });
    match required("v")? {
        Document::Number(value) if *value == CLAIMS_VERSION => {}
        _ => {
            return Err(PayloadError::Expected {
                expected: CLAIMS_VERSION_TEXT,
                field: "v",
            });
        }
    }
    match required("kind")? {
        Document::String(value) if value == CLAIMS_KIND => {}
        _ => {
            return Err(PayloadError::Expected {
                expected: "\"websocket\"",
                field: "kind",
            });
        }
    }
    let sid = match required("sid")? {
        Document::String(value) => value,
        _ => {
            return Err(PayloadError::Expected {
                expected: "string",
                field: "sid",
            });
        }
    };
    let sid = js_trim(sid).to_owned();
    if sid.is_empty() {
        return Err(PayloadError::EmptySid);
    }
    let iat = match required("iat")? {
        Document::Number(value) => *value,
        _ => {
            return Err(PayloadError::Expected {
                expected: "number",
                field: "iat",
            });
        }
    };
    let exp = match required("exp")? {
        Document::Number(value) => *value,
        _ => {
            return Err(PayloadError::Expected {
                expected: "number",
                field: "exp",
            });
        }
    };
    Ok(Claims { sid, iat, exp })
}

/// A JSON document, read with V8's semantics rather than serde's.
///
/// `crate::json` cannot be used here: serde_json reports `1e999` as an error and `Schema.Number` sees
/// it as `Infinity`, and that difference is a branch of `verifyWebSocketToken`. Everything else a port
/// could get wrong about this document — duplicate keys keeping the last value, `-0` printing as `0`,
/// an object field in arrival order — is what the `payloads` table measured.
#[derive(Clone, Debug, PartialEq)]
enum Document {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array,
    Object(Vec<(String, Document)>),
}

impl Document {
    fn read(text: &str) -> Result<Self, PayloadError> {
        let characters: Vec<char> = text.chars().collect();
        let mut reader = Reader {
            characters: &characters,
            index: 0,
            depth: 0,
        };
        reader.skip_space();
        let value = reader.value()?;
        reader.skip_space();
        if reader.index != characters.len() {
            return Err(PayloadError::Syntax);
        }
        Ok(value)
    }
}

struct Reader<'a> {
    characters: &'a [char],
    index: usize,
    depth: usize,
}

fn is_digit(character: char) -> bool {
    character.is_ascii_digit()
}

impl<'a> Reader<'a> {
    fn skip_space(&mut self) {
        while let Some(character) = self.characters.get(self.index) {
            if !is_js_whitespace(*character) {
                break;
            }
            self.index += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.characters.get(self.index).copied()
    }

    fn value(&mut self) -> Result<Document, PayloadError> {
        // V8 recurses, so a deeply nested document exhausts its stack instead of parsing. The number
        // it takes is engine-dependent; this one is a port-side guard, not a measurement.
        if self.depth > 256 {
            return Err(PayloadError::Syntax);
        }
        self.depth += 1;
        let read = self.value_inner();
        self.depth -= 1;
        read
    }

    fn value_inner(&mut self) -> Result<Document, PayloadError> {
        Ok(match self.peek() {
            None => return Err(PayloadError::Syntax),
            Some('{') => self.object()?,
            Some('[') => self.array()?,
            Some('"') => Document::String(self.string()?),
            Some('t') if self.literal("true") => Document::Bool(true),
            Some('f') if self.literal("false") => Document::Bool(false),
            Some('n') if self.literal("null") => Document::Null,
            Some('+' | '-' | '0'..='9') => self.number()?,
            _ => return Err(PayloadError::Syntax),
        })
    }

    fn literal(&mut self, word: &str) -> bool {
        let characters: Vec<char> = word.chars().collect();
        if !self.characters[self.index..].starts_with(&characters) {
            return false;
        }
        self.index += characters.len();
        true
    }

    fn object(&mut self) -> Result<Document, PayloadError> {
        self.index += 1;
        let mut fields = Vec::new();
        self.skip_space();
        if self.peek() == Some('}') {
            self.index += 1;
            return Ok(Document::Object(fields));
        }
        loop {
            self.skip_space();
            // A member name has to be a string; V8 does not accept a bare identifier here.
            if self.peek() != Some('"') {
                return Err(PayloadError::Syntax);
            }
            let name = self.string()?;
            self.skip_space();
            if self.peek() != Some(':') {
                return Err(PayloadError::Syntax);
            }
            self.index += 1;
            self.skip_space();
            let value = self.value()?;
            // Later wins, and the position stays where the first occurrence put it — the same rule
            // `JSON.parse` applies and the `payloads` table measured.
            match fields.iter_mut().find(|(key, _)| *key == name) {
                Some(slot) => slot.1 = value,
                None => fields.push((name, value)),
            }
            self.skip_space();
            match self.peek() {
                Some(',') => {
                    self.index += 1;
                }
                Some('}') => {
                    self.index += 1;
                    return Ok(Document::Object(fields));
                }
                _ => return Err(PayloadError::Syntax),
            }
        }
    }

    fn array(&mut self) -> Result<Document, PayloadError> {
        self.index += 1;
        self.skip_space();
        if self.peek() == Some(']') {
            self.index += 1;
            return Ok(Document::Array);
        }
        let mut first = true;
        loop {
            if first {
                first = false;
            } else {
                self.skip_space();
                if self.peek() != Some(',') {
                    return Err(PayloadError::Syntax);
                }
                self.index += 1;
            }
            self.skip_space();
            self.value()?;
            self.skip_space();
            match self.peek() {
                Some(',') => continue,
                Some(']') => {
                    self.index += 1;
                    return Ok(Document::Array);
                }
                _ => return Err(PayloadError::Syntax),
            }
        }
    }

    fn string(&mut self) -> Result<String, PayloadError> {
        self.index += 1;
        let mut out = String::new();
        loop {
            let Some(character) = self.peek() else {
                return Err(PayloadError::Syntax);
            };
            self.index += 1;
            match character {
                '"' => return Ok(out),
                '\\' => {
                    let Some(escape) = self.peek() else {
                        return Err(PayloadError::Syntax);
                    };
                    self.index += 1;
                    match escape {
                        '"' | '\\' | '/' => out.push(escape),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.hex_escape()?),
                        _ => return Err(PayloadError::Syntax),
                    }
                }
                // A raw C0 control character is invalid inside a JSON string, whatever V8's older
                // parsers used to tolerate.
                other if (other as u32) < 0x20 => return Err(PayloadError::Syntax),
                other => out.push(other),
            }
        }
    }

    fn hex_escape(&mut self) -> Result<char, PayloadError> {
        let first = self.four_hex()?;
        // A high surrogate only means something with the low one after it. A lone surrogate is what
        // JavaScript keeps as one code unit and a Rust `String` cannot hold, so it becomes the
        // replacement character; no session id reaches that path, because the store made the id.
        if !(0xD800..0xDC00).contains(&first) {
            return char::from_u32(first).ok_or(PayloadError::Syntax);
        }
        if self.peek() != Some('\\') || self.characters.get(self.index + 1) != Some(&'u') {
            return Ok('\u{fffd}');
        }
        self.index += 2;
        let low = self.four_hex()?;
        if !(0xDC00..0xE000).contains(&low) {
            return Ok('\u{fffd}');
        }
        char::from_u32(0x1_0000 + ((first - 0xD800) << 10) + (low - 0xDC00))
            .ok_or(PayloadError::Syntax)
    }

    fn four_hex(&mut self) -> Result<u32, PayloadError> {
        let slice: String = self.characters[self.index..].iter().take(4).collect();
        if slice.len() != 4 {
            return Err(PayloadError::Syntax);
        }
        let value = u32::from_str_radix(&slice, 16).map_err(|_| PayloadError::Syntax)?;
        self.index += 4;
        Ok(value)
    }

    fn number(&mut self) -> Result<Document, PayloadError> {
        let start = self.index;
        if self.peek().is_some_and(|c| c == '+' || c == '-') {
            self.index += 1;
        }
        let digits = self.index;
        while self.peek().is_some_and(is_digit) {
            self.index += 1;
        }
        if self.index == digits {
            return Err(PayloadError::Syntax);
        }
        if self.peek() == Some('.') {
            self.index += 1;
            let fraction = self.index;
            while self.peek().is_some_and(is_digit) {
                self.index += 1;
            }
            if self.index == fraction {
                return Err(PayloadError::Syntax);
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.index += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.index += 1;
            }
            let exponent = self.index;
            while self.peek().is_some_and(is_digit) {
                self.index += 1;
            }
            if self.index == exponent {
                return Err(PayloadError::Syntax);
            }
        }
        let text: String = self.characters[start..self.index].iter().collect();
        // Rust's `f64::from_str` overflows to infinity the way `JSON.parse` does, which is the whole
        // reason this file reads numbers itself.
        let value = text.parse::<f64>().map_err(|_| PayloadError::Syntax)?;
        Ok(Document::Number(value))
    }
}

// ---------------------------------------------------------------------------
// verifyWebSocketToken
// ---------------------------------------------------------------------------

/// The row `authSessions.getById` answers with. Only the two columns `verifyWebSocketToken` reads, and
/// their inputs rather than their `DateTime` shape: the store has already clipped them.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredSession {
    pub session_id: String,
    /// `AuthenticatedSession.expiresAt`, already an integer of milliseconds because the store read it
    /// out of a `DateTimeUtc` column.
    pub expires_at: i64,
    /// `revokedAt !== null`, which is the last check a live session meets.
    pub revoked: bool,
    /// `row.value.scopes`, i.e. what the credential covers. The ticket never carries them — `WebSocketClaims`
    /// is `v`/`kind`/`sid`/`iat`/`exp` (`SessionStore.ts:852-858`) — so a server that read scopes off the
    /// payload would be taking authorization from the client.
    pub scopes: Vec<String>,
}

/// What the row lookup returned. A failure is its own case because it is the only one that reaches a
/// 500: `WebSocketTokenVerificationError` is not a member of `SessionCredentialInvalidError`.
#[derive(Clone, Debug, PartialEq)]
pub enum Stored {
    Found(StoredSession),
    Missing,
    Failed,
}

/// A session the ticket proved.
///
/// `scopes` are the row's, in the row's order, and they are the whole reason this type is not just a
/// `String`: they are what [`crate::session::Gate`] is built from, which is the only thing `ws.ts`'s
/// dispatch consults per request. The rest of `VerifiedSession` (`method`, `client`, `subject`, the
/// echoed `token`) is what handlers and services read, and belongs to the layer above this crate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verified {
    pub session_id: String,
    pub scopes: Vec<String>,
}

impl Verified {
    /// The connection's gate, i.e. `ws.ts:3811`'s `session` handed to `makeWsRpcLayer` and read on every
    /// request (`ws.ts:609`/`616`). Consumed because one ticket proves one connection.
    #[must_use]
    pub fn gate(self) -> crate::session::Gate {
        crate::session::Gate::new(self.scopes)
    }
}

/// Why the ticket was refused. Each name is the error class the shipped server yields, which is how
/// `isSessionCredentialInvalidError` decides the status — only [`Denial::Store`] is not a member of
/// that union, and the reason mapping says so by returning `None`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Denial {
    MalformedToken,
    BadSignature,
    /// `InvalidWebSocketTokenPayloadError`, which wraps the base64 throw and the schema refusal
    /// alike; the text is kept so a log can say which.
    BadPayload(String),
    /// `claims.sid` starts with the dev prefix but is not the dev session.
    DevPrefix,
    /// `DateTime.make(claims.exp)` is `None`.
    UnusableExpiration,
    /// The token's own `exp` has passed.
    TokenExpired,
    /// The database refused to answer.
    Store,
    /// `UnknownWebSocketSessionError`, from a missing row.
    UnknownSession,
    /// `WebSocketSessionExpiredError`, from the row's expiry against the same clock.
    SessionExpired,
    WebSocketSessionRevoked,
}

impl Denial {
    /// The branch's error tag, which is what the reason mapping is written against.
    #[must_use]
    pub fn error(&self) -> &'static str {
        match self {
            Self::MalformedToken => "MalformedWebSocketTokenError",
            Self::BadSignature => "InvalidWebSocketTokenSignatureError",
            Self::BadPayload(_) => "InvalidWebSocketTokenPayloadError",
            Self::DevPrefix | Self::UnknownSession => "UnknownWebSocketSessionError",
            Self::UnusableExpiration => "InvalidSessionExpirationClaimError",
            Self::TokenExpired => "WebSocketTokenExpiredError",
            Self::Store => "WebSocketTokenVerificationError",
            Self::SessionExpired => "WebSocketSessionExpiredError",
            Self::WebSocketSessionRevoked => "WebSocketSessionRevokedError",
        }
    }

    /// `EnvironmentAuth.ts:370-373`, which has exactly two answers, and the refusal this one earns:
    /// a credential that was presented and rejected reads `invalid_credential`, and only the database
    /// failure has no reason at all because it never reaches a 401.
    #[must_use]
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Store => None,
            _ => Some("invalid_credential"),
        }
    }

    /// The response this branch is written as.
    #[must_use]
    pub fn denied(&self) -> crate::http::Denied {
        match self.reason() {
            Some(reason) => crate::http::Denied::credential(reason, None),
            None => crate::http::Denied::internal(),
        }
    }
}

/// `DateTime.make(claims.exp)`, reduced to what the branch asks: is this a date, and if so when.
///
/// `new Date(ms)` truncates toward zero and refuses anything past ±8.64e15, so `1e999`,
/// `9007199254740992` and `NaN` are the same refusal and `1.5` is the same instant as `1`.
#[must_use]
pub fn date_clip(milliseconds: f64) -> Option<i64> {
    if !milliseconds.is_finite() {
        return None;
    }
    let clipped = milliseconds.trunc();
    if clipped.abs() > DATE_RANGE_MILLISECONDS {
        return None;
    }
    Some(clipped as i64)
}

/// The six branches, in `SessionStore.ts:882-951`'s order.
///
/// `now` is the clock *after* the payload decoded, because that is where `DateTime.now` is read, and it
/// is an integer of milliseconds because `Date.now()` is — a port that stamped the clock at the top of
/// the function would disagree with the shipped server on a token that expires in the meantime.
pub fn verify(
    token: &str,
    now: i64,
    secret: &[u8],
    dev_session_id: Option<&str>,
    mut lookup: impl FnMut(&str) -> Stored,
) -> Result<Verified, Denial> {
    let parts: Vec<&str> = token.split(TOKEN_SEPARATOR).collect();
    let payload = parts.first().copied().unwrap_or_default();
    let signature = parts.get(1).copied().unwrap_or_default();
    // `if (!encodedPayload || !signature)`, i.e. JavaScript truthiness on two strings: an empty one is
    // a malformed token, so `.` and `a.` and `""` all fail here rather than at the signature.
    if payload.is_empty() || signature.is_empty() {
        return Err(Denial::MalformedToken);
    }
    if !timing_safe_equal_base64url(signature, &sign_payload(payload, secret)) {
        return Err(Denial::BadSignature);
    }
    let text = match decode_base64url_utf8(payload) {
        Ok(text) => text,
        Err(error) => return Err(Denial::BadPayload(error.message())),
    };
    let claims = match decode_claims(&text) {
        Ok(claims) => claims,
        Err(error) => return Err(Denial::BadPayload(error.message())),
    };
    if claims.sid.starts_with(REUSABLE_DEV_SESSION_PREFIX) && dev_session_id != Some(&claims.sid) {
        return Err(Denial::DevPrefix);
    }
    // `DateTime.make(claims.exp)` first, and the *raw* claim against the clock second: the two differ
    // for a fractional `exp`, which is a claim the schema accepts and the comparison floors.
    date_clip(claims.exp).ok_or(Denial::UnusableExpiration)?;
    if claims.exp <= now as f64 {
        return Err(Denial::TokenExpired);
    }
    match lookup(&claims.sid) {
        Stored::Missing => Err(Denial::UnknownSession),
        Stored::Failed => Err(Denial::Store),
        Stored::Found(row) => {
            if row.expires_at <= now {
                return Err(Denial::SessionExpired);
            }
            if row.revoked {
                return Err(Denial::WebSocketSessionRevoked);
            }
            Ok(Verified {
                session_id: row.session_id,
                scopes: row.scopes,
            })
        }
    }
}

/// What the upgrade route's auth step decided.
#[must_use]
pub fn authenticate_upgrade(
    target: &str,
    now: i64,
    secret: &[u8],
    dev_session_id: Option<&str>,
    lookup: impl FnMut(&str) -> Stored,
) -> Upgrade {
    // `if (websocketTicket && websocketTicket.trim().length > 0)`: a bare `?wsTicket`, an empty one,
    // and one that is only whitespace all fall through to header and cookie auth.
    let Some(ticket) = crate::http::query_param(target, TICKET_PARAM) else {
        return Upgrade::NoTicket;
    };
    if ticket.is_empty() || js_trim(&ticket).is_empty() {
        return Upgrade::NoTicket;
    }
    match verify(&ticket, now, secret, dev_session_id, lookup) {
        Ok(verified) => Upgrade::Accepted(verified),
        Err(denial) => Upgrade::Denied(denial),
    }
}

/// The three outcomes of `authenticateWebSocketUpgrade` that this crate owns. The fourth is
/// `authenticateRequest`, which reads bearer and cookie credentials and belongs to the HTTP auth slice
/// rather than to the ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Upgrade {
    Accepted(Verified),
    Denied(Denial),
    NoTicket,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231's cases, which is the only way to check a hand-rolled HMAC against something other than
    /// the artifact that measures the shipped code. `auth-golden.ts` covers the same function from the
    /// other side, in its `tickets` table: 32-byte secret, base64url digest, no padding.
    #[test]
    fn hmac_matches_rfc_4231() {
        let hex =
            |bytes: &[u8]| -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() };
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 20], &[0xdd; 50])),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        );
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 131], &[0x54; 80])),
            "c58c0bf825155131c3f8892fb18a8d53c9cf99cce291120929aa28a0af7f2fa1"
        );
        assert_eq!(
            hex(&hmac_sha256(&[], b"")),
            "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"
        );
    }

    #[test]
    fn the_mint_is_the_measured_token() {
        // `auth-golden.ts`'s `canonical` row: the same secret, the same claims, the same two strings.
        let secret = Vec::from_iter((0..32u32).map(|index| ((index * 13 + 7) & 0xff) as u8));
        let token = mint("sess_01", 1_700_000_000_000.0, 1_700_000_300_000.0, &secret);
        assert_eq!(
            token,
            "eyJ2IjoxLCJraW5kIjoid2Vic29ja2V0Iiwic2lkIjoic2Vzc18wMSIsImlhdCI6MTcwMDAwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMzAwMDAwfQ.wBgssj3CaQy1i5gO4FwpM7bPH0DOeWeB1uWly71YeCY"
        );
    }

    #[test]
    fn the_two_decoders_disagree_on_purpose() {
        assert_eq!(decode_base64url("SGVsbG8").unwrap(), b"Hello");
        assert_eq!(
            decode_base64url("aGVsbG8==").unwrap_err().message(),
            "Length should be a multiple of 4, but is 9"
        );
        assert_eq!(
            decode_base64url("aGVs+G8=").unwrap_err().message(),
            "Invalid input"
        );
        assert_eq!(
            decode_base64url("A==").unwrap_err().message(),
            "Found a '=' character, but it is not at the end"
        );
        // Padding is a suffix, so an `=` in the middle is not a document the repair can save: the
        // regex refuses it first, and `auth-golden.ts` measured which of the two messages that is.
        assert_eq!(
            decode_base64url("A=BC").unwrap_err().message(),
            "Invalid input"
        );
        assert_eq!(
            decode_base64url("a=").unwrap_err().message(),
            "Found a '=' character, but it is not at the end"
        );
        assert_eq!(node_base64url("!!!!"), Vec::<u8>::new());
        assert!(timing_safe_equal_base64url("!!!!", ""));
        assert!(timing_safe_equal_base64url("aGVsbG8", "aGVsbG9"));
    }

    #[test]
    fn trim_follows_javascript_not_unicode() {
        assert_eq!(js_trim(" a "), "a");
        assert_eq!(js_trim("\u{a0}\u{2028}a\u{2029}\u{feff}"), "a");
        assert_eq!(js_trim("\u{85}a\u{1f}"), "\u{85}a\u{1f}");
        assert!(js_trim("\u{a0}").is_empty());
        // The two directions of the divergence, which is why the set is written out rather than
        // delegated to `char::is_whitespace`.
        assert!(
            '\u{85}'.is_whitespace() && !js_trim("\u{85}").is_empty(),
            "Unicode calls it a space, the language does not"
        );
        assert!(
            !'\u{feff}'.is_whitespace() && js_trim("\u{feff}").is_empty(),
            "the language trims the byte-order mark, Unicode does not call it a space"
        );
    }

    #[test]
    fn claims_take_the_schema_messages_verbatim() {
        assert_eq!(
            decode_claims(r#"{"v":1,"kind":"websocket","sid":" a ","iat":1,"exp":2}"#).unwrap(),
            Claims {
                sid: "a".to_owned(),
                iat: 1.0,
                exp: 2.0
            }
        );
        assert_eq!(
            decode_claims(r#"{"v":"1","kind":"websocket","sid":"s","iat":1,"exp":2}"#)
                .unwrap_err()
                .message(),
            "Expected 1\n  at [\"v\"]"
        );
        assert_eq!(
            decode_claims(r#"{"v":1,"kind":"websocket","sid":"  ","iat":1,"exp":2}"#)
                .unwrap_err()
                .message(),
            "Expected a value with a length of at least 1\n  at [\"sid\"]"
        );
        assert_eq!(
            decode_claims("null").unwrap_err().message(),
            "Expected object"
        );
        assert_eq!(
            decode_claims("not json").unwrap_err().message(),
            "Expected a valid JSON string"
        );
    }

    /// The one row serde cannot read: `1e999` is infinity to `JSON.parse`, so the claims decode succeeds
    /// and the clock refuses it.
    #[test]
    fn an_overflowing_number_survives_the_parse_and_dies_at_the_clock() {
        let claims = decode_claims(r#"{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":1e999}"#)
            .expect("Schema.Number accepts Infinity");
        assert!(claims.exp.is_infinite());
        assert_eq!(
            claims.json(),
            r#"{"v":1,"kind":"websocket","sid":"s","iat":1,"exp":null}"#
        );
        assert_eq!(date_clip(claims.exp), None);
        assert_eq!(date_clip(-1.5), Some(-1));
        assert_eq!(date_clip(9_007_199_254_740_992.0), None);
    }

    #[test]
    fn the_branch_order_decides_the_denial() {
        let secret = [7u8; 32];
        let now = 1_700_000_100_000;
        let live = |sid: &str| {
            Stored::Found(StoredSession {
                session_id: sid.to_owned(),
                expires_at: 1_800_000_000_000,
                revoked: false,
                scopes: vec!["orchestration:read".to_owned()],
            })
        };
        let token = mint("sess_01", 1_700_000_000_000.0, 1_700_000_300_000.0, &secret);
        assert_eq!(
            verify(&token, now, &secret, None, live).unwrap(),
            Verified {
                session_id: "sess_01".to_owned(),
                scopes: vec!["orchestration:read".to_owned()],
            }
        );
        assert_eq!(
            verify(".", now, &secret, None, live).unwrap_err(),
            Denial::MalformedToken
        );
        // A wrong secret is a signature failure, and the payload is never read.
        assert_eq!(
            verify(&token, now, &[9u8; 32], None, live).unwrap_err(),
            Denial::BadSignature
        );
        let expired = mint("sess_01", 1_600_000_000_000.0, 1_600_000_001_000.0, &secret);
        assert_eq!(
            verify(&expired, now, &secret, None, live).unwrap_err(),
            Denial::TokenExpired
        );
        let dev = mint(
            "dev-auth-x",
            1_700_000_000_000.0,
            1_700_000_300_000.0,
            &secret,
        );
        assert_eq!(
            verify(&dev, now, &secret, None, live).unwrap_err(),
            Denial::DevPrefix
        );
        assert_eq!(
            verify(&dev, now, &secret, Some("dev-auth-x"), |_| Stored::Missing).unwrap_err(),
            Denial::UnknownSession
        );
        assert_eq!(
            verify(&token, now, &secret, None, |_| Stored::Failed).unwrap_err(),
            Denial::Store
        );
        assert_eq!(Denial::Store.reason(), None);
        assert_eq!(Denial::TokenExpired.reason(), Some("invalid_credential"));
    }

    #[test]
    fn a_ticket_only_counts_when_it_is_not_whitespace() {
        assert_eq!(
            authenticate_upgrade("/ws?wsTicket=%20", 0, &[], None, |_| Stored::Missing),
            Upgrade::NoTicket
        );
        assert_eq!(
            authenticate_upgrade("/ws", 0, &[], None, |_| Stored::Missing),
            Upgrade::NoTicket
        );
        let secret = [1u8; 32];
        let token = mint("s", 0.0, 10.0, &secret);
        let target = format!("/ws?wsTicket={token}");
        assert_eq!(
            authenticate_upgrade(&target, 5, &secret, None, |sid| Stored::Found(
                StoredSession {
                    session_id: sid.to_owned(),
                    expires_at: 100,
                    revoked: false,
                    scopes: Vec::new(),
                }
            )),
            Upgrade::Accepted(Verified {
                session_id: "s".to_owned(),
                scopes: Vec::new(),
            })
        );
    }
}
