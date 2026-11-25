//! A DPoP proof, checked the way the shipped verifier checks it.
//!
//! Two sources are folded in here. [`packages/core/src/shared/dpop.ts`] holds the guards, in an order
//! that is itself the behaviour: trim, three segments, *both* decodes, then key, method, url, token,
//! signature, and only then the clock. [`apps/server/src/auth/dpop.ts`] holds the wire text those
//! guards answer with, which collapses nine codes into five reasons, and the replay write a proof has
//! to survive before it authenticates.
//!
//! The signature is the reason this module exists. The offline registry carries no asymmetric verifier
//! — no `p256`, no `ecdsa`, no `ring` — so [`p256_verify`] is written over `num-bigint` and follows
//! noble's choices rather than the textbook: **high-S signatures are accepted**, because
//! `nist.ts` builds P-256 with `lowS: false` and [`verify`] passes no `opts` overriding it; and a
//! signature, point or coordinate that will not decode is a refusal rather than a panic, since noble
//! wraps all of it in the `try` that yields `invalid_signature`.
//!
//! What is *not* ported, and no measured case reaches it: the two `@noble/hashes` shortcuts for a
//! 32-byte input are the whole hash path, so `sha256` here is plain; and `num-bigint` is not
//! constant-time, which matters for a *public* operation like this one (nothing secret is touched —
//! the key is in the proof) but would matter if this file ever grew a signer.

use num_bigint::BigInt;
use serde_json::{Number, Value};
use sha2::Digest as _;

use crate::auth::{decode_base64url, decode_base64url_utf8, encode_base64url, js_trim};

const DPOP_TYP: &str = "dpop+jwt";
const DPOP_ALG: &str = "ES256";
/// `DEFAULT_MAX_AGE_SECONDS`, and the five seconds of forward skew `dpop.ts:180` grants on top of it.
const DEFAULT_MAX_AGE_SECONDS: f64 = 300.0;
const FORWARD_SKEW_SECONDS: f64 = 5.0;

/// `DpopVerificationFailureCode`, kept whole rather than collapsed into what the body prints, because
/// the collapse is `apps/server`'s and the span annotation records the code before it happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    /// `!proof?.trim()`, i.e. no `DPoP` header or one of whitespace only.
    MissingProof,
    /// Not three non-empty segments, or either JSON document failed its schema.
    MalformedProof,
    /// The proof's key is not the one the token bound.
    KeyMismatch,
    /// `htm` is not the request method.
    MethodMismatch,
    /// `htu` is not the normalized request URL, or that URL will not parse.
    UrlMismatch,
    /// `ath` is not the SHA-256 of the access token.
    AccessTokenHashMismatch,
    /// Outside `iat ± 5s .. maxAge`. Checked **after** the signature, which is what
    /// `seam.dpopSignatureOutranksTime` measures.
    TimeWindow,
    /// The signature does not verify, including every shape noble refuses to read.
    InvalidSignature,
    /// A decode that throws inside the shipped `try`: base64 that is not base64, a coordinate of the
    /// wrong length. Same answer on the wire as [`Code::MalformedProof`], different code.
    InvalidProof,
}

impl Code {
    /// `mapDpopFailureReason` (`auth/dpop.ts:21-37`) — the text that reaches the 401 body, and so the
    /// reason the measured `content-length` differs by one character between `key_mismatch` and
    /// `time_window`.
    #[must_use]
    pub fn reason(self) -> Reason {
        match self {
            Self::TimeWindow => Reason::TimeWindow,
            Self::KeyMismatch => Reason::KeyMismatch,
            Self::MethodMismatch | Self::UrlMismatch => Reason::RequestMismatch,
            Self::AccessTokenHashMismatch => Reason::TokenMismatch,
            Self::MissingProof
            | Self::MalformedProof
            | Self::InvalidSignature
            | Self::InvalidProof => Reason::InvalidProof,
        }
    }
}

/// `DpopFailureReason`, the five the verifier produces plus the one the replay store does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    InvalidProof,
    KeyMismatch,
    RequestMismatch,
    TokenMismatch,
    TimeWindow,
    /// Not from a guard: `mapDpopReplayStoreError` writes it when the secret store already holds the
    /// proof's replay key.
    Replay,
}

impl Reason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidProof => "invalid_proof",
            Self::KeyMismatch => "key_mismatch",
            Self::RequestMismatch => "request_mismatch",
            Self::TokenMismatch => "token_mismatch",
            Self::TimeWindow => "time_window",
            Self::Replay => "replay",
        }
    }
}

/// What `verifyDpopProof` is handed, minus the `maxAgeSeconds` override the route never passes.
pub struct Input<'a> {
    /// `request.headers.dpop`, whose absence is a refusal of its own.
    pub proof: Option<&'a str>,
    /// `request.method`, compared case-insensitively against `htm`.
    pub method: &'a str,
    /// `HttpServerRequest.toURL(request).href`, normalized **after** the decode rather than before:
    /// the server's URL is the side that gets its query and fragment stripped.
    pub url: &'a str,
    /// `Math.floor(DateTime.now.epochMilliseconds / 1000)`.
    pub now_epoch_seconds: i64,
    /// The session's `proofKeyThumbprint`. An empty string is falsy in JavaScript and so skips the
    /// guard, which is why this is tested for truth rather than for presence.
    pub expected_thumbprint: Option<&'a str>,
    /// The token the proof is bound to. Same truthiness.
    pub expected_access_token: Option<&'a str>,
}

/// A proof that passed every guard, before the replay store has seen it.
#[derive(Clone, Debug, PartialEq)]
pub struct Proof {
    pub thumbprint: String,
    pub jti: String,
    /// Kept as the JSON number it arrived as: the window compares it as a float and the stored text
    /// prints it with `Number::toString`, so rounding it to an integer here would be a second
    /// conversion the shipped code does not make.
    pub iat: Number,
}

/// One guard's worth of decoding: base64url that is not base64url **throws**, which the shipped `try`
/// turns into [`Code::InvalidProof`], while a document that decodes and fails its schema is an
/// `Option::None` and so [`Code::MalformedProof`].
fn segment<T>(text: &str, decode: impl FnOnce(&str) -> Option<T>) -> Result<Option<T>, Code> {
    let Ok(utf8) = decode_base64url_utf8(text) else {
        return Err(Code::InvalidProof);
    };
    Ok(decode(&utf8))
}

/// `verifyDpopProof`, in its order, with the two decodes ahead of the guards because that is what makes
/// `seam.dpopKeyOutranksMethod` answer `key_mismatch` on a proof whose `htm` is also wrong.
///
/// # Panics
///
/// Never: everything that throws in the shipped code is a returned `Code` here.
pub fn verify(input: &Input<'_>) -> Result<Proof, Code> {
    let Some(proof) = input.proof.map(js_trim).filter(|proof| !proof.is_empty()) else {
        return Err(Code::MissingProof);
    };
    let parts: Vec<&str> = proof.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(Code::MalformedProof);
    }
    // Both documents are decoded before either is examined, so a throwing payload decode outranks a
    // merely invalid header.
    let header = segment(parts[0], header_jwk)?;
    let claims = segment(parts[1], header_payload)?;
    let Some(jwk) = header else {
        return Err(Code::MalformedProof);
    };
    let Some(claims) = claims else {
        return Err(Code::MalformedProof);
    };

    let thumbprint = jwk_thumbprint(&jwk);
    if input
        .expected_thumbprint
        .is_some_and(|expected| !expected.is_empty() && expected != thumbprint)
    {
        return Err(Code::KeyMismatch);
    }
    if claims.htm.to_uppercase() != input.method.to_uppercase() {
        return Err(Code::MethodMismatch);
    }
    // The claim is compared **raw**: `normalizeDpopHtu` runs on the server's URL only, which is why
    // `seam.dpopUrlNormalized` is refused for signing the URL it asked for and
    // `seam.dpopUrlSignedStripped` is accepted for signing the one the server builds.
    if normalize_htu(input.url).as_deref() != Some(claims.htu.as_str()) {
        return Err(Code::UrlMismatch);
    }
    if input.expected_access_token.is_some_and(|token| {
        !token.is_empty() && claims.ath.as_deref() != Some(access_token_hash(token).as_str())
    }) {
        return Err(Code::AccessTokenHashMismatch);
    }
    let Ok(signature) = decode_base64url(parts[2]) else {
        return Err(Code::InvalidProof);
    };
    let Some(public_key) = public_key_bytes(&jwk) else {
        return Err(Code::InvalidProof);
    };
    let signing_input = sha256(format!("{}.{}", parts[0], parts[1]).as_bytes());
    if !p256_verify(&public_key, &signing_input, &signature) {
        return Err(Code::InvalidSignature);
    }
    let Some(iat) = claims.iat.as_f64() else {
        // Only reachable through `arbitrary_precision`; `Schema.Int` would have rejected the token.
        return Err(Code::MalformedProof);
    };
    let now = input.now_epoch_seconds as f64;
    if iat > now + FORWARD_SKEW_SECONDS || now - iat > DEFAULT_MAX_AGE_SECONDS {
        return Err(Code::TimeWindow);
    }
    Ok(Proof {
        thumbprint,
        jti: claims.jti,
        iat: claims.iat,
    })
}

/// The `jwk` the header has to carry: `DpopJwtHeaderJson`'s `typ`/`alg` literals plus
/// `DpopJwtHeaderPublicJwk`, whose `d: Schema.optionalKey(Schema.Never)` is what makes
/// `seam.dpopPrivateJwk` malformed rather than a key mismatch. Every other member is dropped by the
/// schema, which is why `seam.dpopJwkHasKid` authenticates and its kid is nowhere in the thumbprint.
fn header_jwk(text: &str) -> Option<Jwk> {
    let Value::Object(fields) = crate::json::parse(text).ok()? else {
        return None;
    };
    if fields.get("typ").and_then(Value::as_str) != Some(DPOP_TYP)
        || fields.get("alg").and_then(Value::as_str) != Some(DPOP_ALG)
    {
        return None;
    }
    let Value::Object(jwk) = fields.get("jwk")? else {
        return None;
    };
    if jwk.contains_key("d") {
        return None;
    }
    let member = |name: &str| {
        jwk.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Some(Jwk {
        kty: member("kty")?,
        crv: member("crv")?,
        x: member("x")?,
        y: member("y")?,
    })
}

/// `DpopJwtPayloadJson`. Unnamed members are dropped rather than refused, which is what
/// `seam.dpopPayloadHasNonce` measures.
fn header_payload(text: &str) -> Option<Claims> {
    let Value::Object(fields) = crate::json::parse(text).ok()? else {
        return None;
    };
    let text = |name: &str| {
        fields
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let iat = match fields.get("iat")? {
        Value::Number(number) if is_javascript_integer(number) => number.clone(),
        _ => return None,
    };
    if let Some(ath) = fields.get("ath")
        && !ath.is_string()
    {
        return None;
    }
    Some(Claims {
        htm: text("htm")?,
        htu: text("htu")?,
        jti: text("jti")?,
        iat,
        ath: text("ath"),
    })
}

/// `Schema.Int`, which is `Number.isInteger`: a JSON `1.0` is an integer to JavaScript and serde reads
/// it as a float, so the two spellings have to be tried in that order.
fn is_javascript_integer(number: &Number) -> bool {
    number.as_i64().is_some()
        || number.as_u64().is_some()
        || number.as_f64().is_some_and(|value| value.fract() == 0.0)
}

struct Jwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}

struct Claims {
    htm: String,
    htu: String,
    jti: String,
    iat: Number,
    ath: Option<String>,
}

/// `dpopThumbprintInput` + `computeDpopJwkThumbprint`: `stableStringify` over exactly four members, so
/// the sorted order is `crv`, `kty`, `x`, `y` and nothing else in the JWK can move the digest.
fn jwk_thumbprint(jwk: &Jwk) -> String {
    let input = format!(
        "{{{}:{},{}:{},{}:{},{}:{}}}",
        crate::json::quote("crv"),
        crate::json::quote(&jwk.crv),
        crate::json::quote("kty"),
        crate::json::quote(&jwk.kty),
        crate::json::quote("x"),
        crate::json::quote(&jwk.x),
        crate::json::quote("y"),
        crate::json::quote(&jwk.y),
    );
    encode_base64url(&sha256(input.as_bytes()))
}

/// `computeDpopAccessTokenHash`.
fn access_token_hash(access_token: &str) -> String {
    encode_base64url(&sha256(access_token.as_bytes()))
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(bytes).into()
}

/// `normalizeDpopHtu`: `new URL(text)`, then `hash = ""` and `search = ""`, then `toString()`.
///
/// Only the shapes this seam can build are ported, which is the honest subset: the URL arrives from
/// [`crate::http::Request::url`], which already put a path on it, so what is left to do is drop the
/// query and the fragment and, for the target that was empty, keep the slash `URL` adds. A text this
/// cannot parse returns `None`, and the guard treats that the same way the shipped code treats
/// `null` — as a mismatch rather than a separate refusal.
#[must_use]
pub fn normalize_htu(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    if scheme_end == 0 {
        return None;
    }
    let authority_start = scheme_end + 3;
    let rest = &url[authority_start..];
    let path_start = rest.find(['/', '?', '#']);
    let authority = match path_start {
        None => rest,
        Some(index) => &rest[..index],
    };
    if authority.is_empty() {
        return None;
    }
    let path = path_start.map_or("", |index| &rest[index..]);
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let path = if path.is_empty() { "/" } else { path };
    Some(format!("{}://{authority}{path}", &url[..scheme_end]))
}

/// The name `verifyRequestDpopProof` spends a proof under: `dpop-proof-` plus the base64url of the
/// SHA-256 of `"<thumbprint>:<jti>"`, i.e. the thumbprint the proof *proved* rather than the one the
/// token named, which are the same string by the time this runs.
#[must_use]
pub fn replay_key(proof: &Proof) -> String {
    let digest = sha256(format!("{}:{}", proof.thumbprint, proof.jti).as_bytes());
    format!("dpop-proof-{}", encode_base64url(&digest))
}

/// The value written beside that name. `consumedAt` is the same clock reading the window compared,
/// spelled the way `DateTime.formatIso` spells it, and `iat` keeps the JSON text it arrived with.
#[must_use]
pub fn stored_value(proof: &Proof, now_millis: i64) -> String {
    format!(
        "thumbprint={}\njti={}\niat={}\nconsumedAt={}",
        proof.thumbprint,
        proof.jti,
        crate::json::number_text(&proof.iat),
        format_iso_millis(now_millis),
    )
}

/// `DateTime.formatIso` for the UTC instant Node's `Date` would print: three fractional digits, always,
/// and a `Z` rather than an offset.
#[must_use]
pub fn format_iso_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let time = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = time / 3_600_000;
    let minute = time % 3_600_000 / 60_000;
    let second = time % 60_000 / 1000;
    let millisecond = time % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z")
}

/// Howard Hinnant's `civil_from_days`, which is what a `Date`'s UTC fields are computed from. Every
/// division below runs on a non-negative operand, so Rust's truncation is the floor the algorithm wants.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097; // [0, 146096]
    let year_of_century =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
    let year = year_of_century + era * 400;
    let day_of_year =
        day_of_era - (365 * year_of_century + year_of_century / 4 - year_of_century / 100); // [0, 365]
    let shifted_month = (5 * day_of_year + 2) / 153; // [0, 11], March first
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    // January and February belong to the year the century-relative index is counting from.
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// ECDSA P-256, by hand
// ---------------------------------------------------------------------------

/// Short Weierstrass form of P-256: `y² = x³ - 3x + b` over the field below.
fn prime() -> BigInt {
    big("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff")
}

fn order() -> BigInt {
    big("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
}

fn curve_b() -> BigInt {
    big("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b")
}

fn generator() -> (BigInt, BigInt) {
    (
        big("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
        big("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
    )
}

fn big(hex: &str) -> BigInt {
    BigInt::parse_bytes(hex.as_bytes(), 16).expect("a constant that parses")
}

fn count(value: u32) -> BigInt {
    BigInt::from(value)
}

/// `BigInt::is_zero`, without pulling `num-traits` into the crate for one comparison.
fn is_zero(value: &BigInt) -> bool {
    value.sign() == num_bigint::Sign::NoSign
}

fn rem(value: &BigInt, modulus: &BigInt) -> BigInt {
    let rest = value % modulus;
    if rest.sign() == num_bigint::Sign::Minus {
        rest + modulus
    } else {
        rest
    }
}

/// Inversion by Fermat, which is the one route available without `num-integer`: both moduli are prime.
fn mod_inverse(value: &BigInt, modulus: &BigInt) -> BigInt {
    value.modpow(&(modulus - 2u32), modulus)
}

/// A Jacobian point, `(X : Y : Z)` with the affine `x = X / Z²` and `y = Y / Z³`. `None` is the point at
/// infinity, which is what noble calls `null` and what the refusal below answers.
type Point = Option<(BigInt, BigInt, BigInt)>;

/// `dbl-2009-l` for `a = -3`: the `3(X² - Z⁴)` slope is the whole reason the curve's `a` is worth
/// naming, and getting it wrong is a point that is not on the curve.
fn point_double(point: &Point, p: &BigInt) -> Point {
    let (x, y, z) = point.as_ref()?;
    if is_zero(y) || is_zero(z) {
        return None;
    }
    let xx = rem(&(x * x), p);
    let yy = rem(&(y * y), p);
    let yyyy = rem(&(&yy * &yy), p);
    let zz = rem(&(z * z), p);
    let z4 = rem(&(&zz * &zz), p);
    let sum = rem(&(x + yy), p);
    let s = rem(
        &(&count(2) * &rem(&(rem(&(&sum * &sum), p) - &xx - &yyyy), p)),
        p,
    );
    let m = rem(&(&count(3) * &rem(&(&xx - &z4), p)), p);
    let x3 = rem(&(rem(&(m.clone() * &m), p) - &count(2) * &s), p);
    let y3 = rem(&(rem(&(m * (&s - &x3)), p) - &count(8) * &yyyy), p);
    let z3 = rem(&(&count(2) * &rem(&(y * z), p)), p);
    Some((x3, y3, z3))
}

/// `add-1998-cmo-2`, the general Jacobian sum. Mixed coordinates would be one multiplication cheaper per
/// step and nobody verifies one DPoP proof per microsecond here.
fn point_add(left: &Point, right: &Point, p: &BigInt) -> Point {
    let (left, right) = match (left, right) {
        (None, other) | (other, None) => return other.clone(),
        (Some(left), Some(right)) => (left.clone(), right.clone()),
    };
    let (x1, y1, z1) = left;
    let (x2, y2, z2) = right;
    let z1_sq = rem(&(z1.clone() * &z1), p);
    let z2_sq = rem(&(z2.clone() * &z2), p);
    let u1 = rem(&(x1.clone() * &z2_sq), p);
    let u2 = rem(&(x2 * &z1_sq), p);
    let s1 = rem(&(y1.clone() * &z2_sq * &z2), p);
    let s2 = rem(&(y2 * &z1_sq * &z1), p);
    let h = &u2 - &u1;
    let r = &s2 - &s1;
    if is_zero(&h) {
        // Same x and y, so this is the tangent, and the tangent of an inverse pair is infinity. The
        // point to double is the *affine* one, which is why it is `(x1, y1, z1)` and not the `u1`/`s1`
        // the shared denominator moved.
        return if is_zero(&r) {
            point_double(&Some((x1, y1, z1)), p)
        } else {
            None
        };
    }
    let hh = rem(&(h.clone() * &h), p);
    let j = rem(&(h.clone() * &hh), p);
    let rr = &count(2) * &r;
    let v = rem(&(u1 * &hh), p);
    // `4·J`, not `J`: with `rr = 2·(S2 − S1)` and `Z3 = 2·Z1·Z2·H` the affine division by `Z3²` is
    // exact only when the `H³` term carries the same quarter the slope does. Measured against
    // `k · G` from Node's ECDH, which the sum without it fails at `3·G`.
    let x3 = rem(
        &(rem(&(rr.clone() * &rr), p) - &count(4) * &j - &count(8) * &v),
        p,
    );
    let y3 = rem(
        &(rem(&(rr * (&count(4) * &v - &x3)), p) - &count(8) * &(&s1 * &j)),
        p,
    );
    // Z3 = ((Z1+Z2)² - Z1Z1 - Z2Z2) · H
    let z_sum = rem(&(z1 + z2), p);
    let z3 = rem(
        &((&rem(&(z_sum.clone() * z_sum), p) - &z1_sq - &z2_sq) * &h),
        p,
    );
    Some((x3, y3, z3))
}

/// `k · base` by a double-and-add walk over the scalar's bits, high first. Constant-time is not the
/// goal: the scalars here are `u1` and `u2`, both derived from the public signature.
fn point_multiply(scalar: &BigInt, base: &(BigInt, BigInt), p: &BigInt) -> Point {
    let base = Some((base.0.clone(), base.1.clone(), count(1)));
    let mut acc: Point = None;
    for byte in scalar.to_bytes_be().1 {
        for bit in (0..8).rev() {
            acc = point_double(&acc, p);
            if (byte >> bit) & 1 == 1 {
                acc = point_add(&acc, &base, p);
            }
        }
    }
    acc
}

/// `publicKeyBytesFromJwk`: **both** coordinates have to decode to exactly thirty-two bytes, or the
/// function throws and the shipped `try` answers [`Code::InvalidProof`] before the curve is consulted.
/// The check is `!== 32` and not `> 32`, which is what makes `seam.dpopShortX` a refusal of the *key*
/// rather than a signature that failed over a zero-padded point — a difference this seam cannot see,
/// because both spellings reach the same 150-byte `invalid_proof`.
fn public_key_bytes(jwk: &Jwk) -> Option<[u8; 65]> {
    let x = decode_base64url(&jwk.x).ok()?;
    let y = decode_base64url(&jwk.y).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut bytes = [0u8; 65];
    bytes[0] = 0x04;
    bytes[1..33].copy_from_slice(&x);
    bytes[33..].copy_from_slice(&y);
    Some(bytes)
}

/// `p256.verify(signature, hash, publicKey, { prehash: false, format: "compact" })`, with noble's
/// `lowS: false` left as it found it.
///
/// Every refusal noble raises from a bad *shape* is folded into `false`, because the caller's `try`
/// cannot tell them apart: `seam.dpopDerSignature` is a 70-byte signature and `seam.dpopZeroR` a
/// mathematically impossible one, and both answer `invalid_proof`.
#[must_use]
pub fn p256_verify(public_key: &[u8; 65], hash: &[u8; 32], signature: &[u8]) -> bool {
    let Some((r, s)) = compact_signature(signature) else {
        return false;
    };
    let Some((qx, qy, _)) = affine_point(public_key) else {
        return false;
    };
    let p = prime();
    let n = order();
    let e = rem(&be(hash), &n);
    let s_inverse = mod_inverse(&s, &n);
    let u1 = rem(&(&e * &s_inverse), &n);
    let u2 = rem(&(&r * &s_inverse), &n);
    // `BASE.multiplyAndAddUnsafe(P, u1, u2)`: the verification point is `u1·G + u2·Q`, and dropping
    // either half makes every signature verify.
    let (gx, gy) = generator();
    let summed = point_add(
        &point_multiply(&u1, &(gx, gy), &p),
        &point_multiply(&u2, &(qx, qy), &p),
        &p,
    );
    let Some((x, _, z)) = summed else {
        return false;
    };
    if is_zero(&z) {
        return false;
    }
    let z_inverse = mod_inverse(&z, &p);
    let x = rem(&(&x * &rem(&(&z_inverse * &z_inverse), &p)), &p);
    rem(&x, &n) == r
}

/// A big-endian byte string as a non-negative integer, which is how both the signature halves, the hash
/// and the two coordinates are read.
fn be(bytes: &[u8]) -> BigInt {
    BigInt::from_bytes_be(num_bigint::Sign::Plus, bytes)
}

/// The 64-byte compact form, each half read big-endian and neither allowed to be zero or to reach the
/// order. `Signature.fromCompact` is the shape check and `assertValidity` the range, and noble throws
/// in `verify` for both.
fn compact_signature(signature: &[u8]) -> Option<(BigInt, BigInt)> {
    if signature.len() != 64 {
        return None;
    }
    let r = be(&signature[..32]);
    let s = be(&signature[32..]);
    let n = order();
    (r > count(1) && r < n && s > count(1) && s < n).then_some((r, s))
}

/// `Point.fromHex` over the uncompressed form: the prefix, the two coordinates inside the field, and the
/// curve equation itself. The cofactor is 1, so no subgroup test is needed and noble does not run one.
fn affine_point(bytes: &[u8; 65]) -> Point {
    if bytes[0] != 0x04 {
        return None;
    }
    let p = prime();
    let x = be(&bytes[1..33]);
    let y = be(&bytes[33..65]);
    if x >= p || y >= p {
        return None;
    }
    let left = rem(&(y.clone() * &y), &p);
    let xx = rem(&(x.clone() * &x), &p);
    let right = rem(&(&rem(&(xx * &x), &p) - &count(3) * &x + curve_b()), &p);
    if left != right {
        return None;
    }
    Some((x, y, count(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six `(public key, sha256(message), compact signature)` triples produced by Node's own P-256 and
    /// confirmed by `crypto.verify`, which is the only way to test a hand-rolled verifier against
    /// something other than the artifact it is meant to reproduce. Recorded by
    /// `~/.cache/lmcs-port-traces/ec-vectors.mjs`.
    const VECTORS: [(&str, &str, &str, &str, &str); 6] = [
        (
            "4f683e77ea1c22df23ee38b220ddf804942d1bbf5e20b930b32e453be86209ec",
            "622e627d9fee64a3afa99d8e99d00d52389499cd06ed45015058d4af539e3b05",
            "8aab6a6a82cf229e5ae45a72dc909c902dae5fbd145153625eeefa5195d03b6f",
            "636b10367ad18c122f38ac34f62be4cae1363d1477996a3f42f1ac6f5e2db1f9",
            "60124dc0a6364973fbd6052a6b6e8a5ab5fb8c8a9e0b753dc28559174d909f20",
        ),
        (
            "4f683e77ea1c22df23ee38b220ddf804942d1bbf5e20b930b32e453be86209ec",
            "622e627d9fee64a3afa99d8e99d00d52389499cd06ed45015058d4af539e3b05",
            "fed92306d2faa425c2f3400ea0524d1b7fe6db5f5f87f95dca6e55736067fcad",
            "aae7f1e5403a4f7ca8cc46ae278d8aca8fc35c4aa112a0423d29b38619a83919",
            "ef373981a555985d08c84de8ba35f84c44e9fd52deefe6b95f6bea0beec5ba00",
        ),
        (
            "dfc129db5d47754b7095ffb513d66cd09ec9b36cce8e6acbf34d9359885e86cb",
            "c748beed06458ec08b7b2da5de111dd5b7415c1ec6bf18a2d5812b42ef710b12",
            "7f5a26819f2dd8be30a30e78d2c7cf52b12d00bfde085ab9eebd54a268735a34",
            "dbed155bbbe33dcd081f8b1b1793a3afb38482af1fbd5c950f615aa4acc45d2d",
            "5b3aa861b8abd2f498a22b799634b6c95a5aa2a8a9591144941a1e6f80e5832a",
        ),
        (
            "dfc129db5d47754b7095ffb513d66cd09ec9b36cce8e6acbf34d9359885e86cb",
            "c748beed06458ec08b7b2da5de111dd5b7415c1ec6bf18a2d5812b42ef710b12",
            "fed92306d2faa425c2f3400ea0524d1b7fe6db5f5f87f95dca6e55736067fcad",
            "577db6a8d20733e8d01994639cd4e03c90c0da00f4a23ba00cab844a12e0665f",
            "6efd1bbbdf01e9688430156f653f2c66aeb987393b7b7265d6a2631c937bdd48",
        ),
        (
            "e88f8ad44226ecddfc1fad3ee47cfdf765641b462e9f311258cc803bd77d651d",
            "391fbaf244791379d1d149c9bae8b8878d7c5e8f783a069987100dc132b38f15",
            "21d228f6ae6ab4c2ccb653194c356160f291268abcc16c30a62e7a4b455b263a",
            "e4b7e4f3d281262d11b0c9989a2b35bfce7e784f7dae6ca871227284bb7262d1",
            "813d24549f848ba3ab87392b7aa6bf2a13d65e1d0b90ffde5deec48517371441",
        ),
        (
            "e88f8ad44226ecddfc1fad3ee47cfdf765641b462e9f311258cc803bd77d651d",
            "391fbaf244791379d1d149c9bae8b8878d7c5e8f783a069987100dc132b38f15",
            "fed92306d2faa425c2f3400ea0524d1b7fe6db5f5f87f95dca6e55736067fcad",
            "cec87cb02a4d072c9f59e34108690c5a062e91332ddf05d1a2c57b3306197ba3",
            "2bedd8deb9ab5cc9798d8a4a4fec479cdec55ed44913d8caab2fc2c964dd0c12",
        ),
    ];

    fn vector(index: usize) -> ([u8; 65], [u8; 32], Vec<u8>) {
        let (x, y, hash, r, s) = VECTORS[index];
        let mut digest = [0u8; 32];
        digest.copy_from_slice(&hex_bytes(hash));
        (
            point_bytes(x, y),
            digest,
            [hex_bytes(r), hex_bytes(s)].concat(),
        )
    }

    #[test]
    fn verifies_every_vector_the_other_implementation_signed() {
        for index in 0..VECTORS.len() {
            let (public, hash, signature) = vector(index);
            assert!(
                p256_verify(&public, &hash, &signature),
                "vector {index}, signed and verified by Node"
            );
        }
    }

    #[test]
    fn refuses_what_the_curve_equation_refuses() {
        let (public, hash, signature) = vector(0);
        // A y that is not on the curve, and a signature over a different message.
        let (_, _, mut other) = vector(1);
        let off_curve = {
            let (x, _, _, _, _) = VECTORS[0];
            let mut y = hex_bytes(VECTORS[0].1);
            let last = y.len() - 1;
            y[last] ^= 1;
            let mut bytes = [0u8; 65];
            bytes[0] = 0x04;
            bytes[1..33].copy_from_slice(&hex_bytes(x));
            bytes[33..65].copy_from_slice(&y);
            bytes
        };
        assert!(!p256_verify(&off_curve, &hash, &signature));
        assert!(!p256_verify(&public, &vector(2).1, &signature));
        assert!(!p256_verify(&public, &hash, &signature[..63]));
        assert!(!p256_verify(&public, &hash, &signature[1..]));
        other[0] ^= 1;
        assert!(!p256_verify(&public, &hash, &other));
        let mut flipped = signature.clone();
        for byte in &mut flipped {
            *byte ^= 1;
        }
        assert!(
            !p256_verify(&public, &hash, &flipped),
            "the same r with a different s is a different point"
        );
        assert!(
            !p256_verify(&public, &hash, &[0u8; 64]),
            "zero r and zero s"
        );
    }

    /// `nist.ts` fixes `lowS: false` for P-256 and `verify` is called without overriding it, so the
    /// other half of the `s` pair verifies as well. That is what `seam.dpopHighS` measured, and it is
    /// the reason this file normalizes nothing. Node's own `crypto.verify` agrees, which is the only
    /// outside evidence that the fold is `n - s` rather than `s` itself.
    #[test]
    fn a_high_s_is_not_rejected() {
        for index in 0..VECTORS.len() {
            let (public, hash, mut signature) = vector(index);
            let low = be(&signature[32..]);
            let high = order() - low;
            let bytes = high.to_bytes_be().1;
            signature[64 - bytes.len()..64].copy_from_slice(&bytes);
            assert!(
                p256_verify(&public, &hash, &signature),
                "vector {index} with the negated s"
            );
        }
    }

    /// `k · G` for five scalars whose ECDH secret Node computed, which pins the projective walk itself
    /// rather than the signature arithmetic wrapped around it. Recorded by
    /// `~/.cache/lmcs-port-traces/ecdh-truth.mjs`.
    #[test]
    fn the_scalar_walk_lands_where_the_other_implementation_lands() {
        let p = prime();
        let g = generator();
        for (scalar, expected) in [
            (
                "2",
                "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978",
            ),
            (
                "3",
                "5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c",
            ),
            (
                "7",
                "8e533b6fa0bf7b4625bb30667c01fb607ef9f8b8a80fef5b300628703187b2a3",
            ),
            (
                "5d7790b2f96102cac2e32b879b7896d3ca1dddb79fb01c6f074ce9fa69a1dd34",
                "b9974abd781a87e3b68577d276fb0a03d3ca39623be9764107f0c22321d3cc6c",
            ),
            (
                "41cc084385064bf7a076171f51dd38f3a6997462d6d3107ad7a9dc644bf176d0",
                "eb178d90b11426eed08a9c64f901b9971e9a007de446357085b92e8a864a8bbe",
            ),
            (
                "ffd5c4ce07b47290e8594738bc1e91ce4fdb9a1a062b2129d7028c2110bb46a1",
                "fc2a22fab326d186fbe586b3bc15c0693db5967b2eea2c1e80bc0af764f3ee0f",
            ),
            (
                "484924bdcd163e894622c02da8e36a402ace1b8e02972d0bf71a5357228686e6",
                "2eab2d01513c3be45576ab9c070bfc907c033436438277a132835ca0f7c83205",
            ),
            (
                "05a40f7c6b7c883b7fd0e62c3eca73bcb2728cfe38271c6e430b2bb6d5157234",
                "9fa6aa90175e9f3d06ed0d8ce846662bee019b9ce6de43d5a5513e2839a22b17",
            ),
            (
                "0e6b230da57d49bc6f1cb4a551458748909cb7a9e9bc9873861534b4bf7a7bb3",
                "4784dd1c5b3b5e2383017b64edb4fad043d16fe2ebe4bf6a57e0363417248313",
            ),
        ] {
            let point =
                point_multiply(&big(scalar), &g, &p).expect("a real multiple of the generator");
            let (px, _, z) = point;
            let inverse = mod_inverse(&z, &p);
            let affine = rem(&(&px * &rem(&(&inverse * &inverse), &p)), &p);
            assert_eq!(format!("{affine:x}"), expected, "scalar {scalar}");
        }
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    fn point_bytes(x: &str, y: &str) -> [u8; 65] {
        let mut bytes = [0u8; 65];
        bytes[0] = 0x04;
        bytes[1..33].copy_from_slice(&hex_bytes(x));
        bytes[33..65].copy_from_slice(&hex_bytes(y));
        bytes
    }

    /// `publicKeyBytesFromJwk` checks `!== 32`, not `> 32`: a coordinate that decodes **short** is not a
    /// public key either, and the proof never reaches the curve. A 42-character `x` is thirty-one bytes,
    /// which is the shape a real P-256 coordinate has about once every 256 keys — the case the shipped
    /// code refuses and a zero-padding port would silently accept.
    #[test]
    fn a_coordinate_is_a_key_only_at_thirty_two_bytes() {
        let key = |x: &[u8], y: &[u8]| Jwk {
            kty: "EC".to_owned(),
            crv: "P-256".to_owned(),
            x: encode_base64url(x),
            y: encode_base64url(y),
        };
        let bytes = public_key_bytes(&key(&[0x11; 32], &[0x22; 32])).expect("a real key");
        assert_eq!(bytes[0], 0x04);
        assert_eq!(&bytes[1..33], &[0x11; 32][..]);
        assert_eq!(&bytes[33..], &[0x22; 32][..]);
        assert_eq!(
            public_key_bytes(&key(&[0x11; 31], &[0x22; 32])),
            None,
            "a thirty-one-byte x is not a coordinate",
        );
        assert_eq!(
            public_key_bytes(&key(&[0x11; 32], &[0x22; 33])),
            None,
            "a thirty-three-byte y is not a coordinate either",
        );
    }

    /// `parts.length !== 3`, so a fourth segment is as malformed as a missing one — and a lower-bound
    /// check would read the signature out of `parts[2]` and ignore whatever followed it.
    #[test]
    fn a_compact_jwt_has_exactly_three_segments() {
        for proof in ["a.b", "a.b.c.d", "a.b.c.d.e", "a.b.", ".b.c", "a..c"] {
            assert_eq!(
                verify(&Input {
                    proof: Some(proof),
                    method: "GET",
                    url: "http://127.0.0.1/ws",
                    now_epoch_seconds: 1_700_000_000,
                    expected_thumbprint: None,
                    expected_access_token: None,
                }),
                Err(Code::MalformedProof),
                "{proof}"
            );
        }
    }

    #[test]
    fn the_iso_and_the_days_agree_with_the_measured_clock() {
        assert_eq!(
            format_iso_millis(1_700_000_000_000),
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(format_iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_iso_millis(1_704_067_199_999),
            "2023-12-31T23:59:59.999Z"
        );
        assert_eq!(format_iso_millis(-86_400_000), "1969-12-31T00:00:00.000Z");
    }

    #[test]
    fn normalization_strips_query_and_fragment_and_keeps_the_slash() {
        assert_eq!(
            normalize_htu("http://127.0.0.1/ws?surface=web").as_deref(),
            Some("http://127.0.0.1/ws")
        );
        assert_eq!(
            normalize_htu("http://127.0.0.1/ws#frag").as_deref(),
            Some("http://127.0.0.1/ws")
        );
        assert_eq!(
            normalize_htu("http://127.0.0.1").as_deref(),
            Some("http://127.0.0.1/")
        );
        assert_eq!(normalize_htu("not a url"), None);
    }
}
