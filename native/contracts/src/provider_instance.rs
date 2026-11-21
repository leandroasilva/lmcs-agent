//! The provider-instance routing key, ported from the slug schemas in
//! `packages/core/src/contracts/providerInstance.ts`.
//!
//! Only `ProviderInstanceId` is ported so far, because that is the whole of what
//! `terminal.ts` reaches for. The rest of that file — the driver kind, the config envelope
//! and the map — belongs to `server.ts`'s settings and arrives with them.
//!
//! A `Schema.brand` is **erased at runtime**: the wire value is the plain refined string,
//! and the brand exists only so TypeScript cannot pass a `ProjectId` where a
//! `ProviderInstanceId` is expected. Rust gets the same separation from distinct types, so
//! the newtypes below are the port of the brand rather than decoration on top of it.

use crate::base::{Check, Checked, MaxLength, NonEmpty};
use regex::Regex;
use std::sync::LazyLock;

/// `PROVIDER_SLUG_PATTERN` (`providerInstance.ts:49`): a letter, then letters, digits,
/// `-` or `_`. Applied through `Schema.isPattern`, which is `RegExp.test` and therefore
/// looks for a match anywhere — these slugs are anchored only because the pattern carries
/// its own `^…$`.
static PROVIDER_SLUG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]*$").expect("valid"));

/// The `isPattern` half of the shared slug schema.
pub struct ProviderSlugPattern;

impl Check<NonEmpty> for ProviderSlugPattern {
    fn passes(value: &NonEmpty) -> bool {
        PROVIDER_SLUG.is_match(&value.0)
    }

    fn describe() -> String {
        "a provider slug".to_owned()
    }
}

/// `ProviderInstanceId` (`providerInstance.ts:82`) — `slugSchema`, which is
/// `TrimmedNonEmptyString.check(isMaxLength(64), isPattern(PROVIDER_SLUG_PATTERN))`.
///
/// The checks sit on a **transformed** schema, so they run on opposite text in each
/// direction: on the trimmed value coming off the wire, and on the raw value going out.
/// `" codex "` therefore decodes to `"codex"` and refuses to encode.
pub type ProviderInstanceId = Checked<NonEmpty, (MaxLength<64>, ProviderSlugPattern)>;
