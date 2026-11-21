//! The provider-instance routing key, ported from the slug schemas in
//! `packages/core/src/contracts/providerInstance.ts`.
//!
//! Both `ProviderInstanceId` and `ProviderDriverKind` are here because every provider
//! runtime event carries both. The rest of that file — the config envelope and the map —
//! belongs to `server.ts`'s settings and arrives with them.
//!
//! A `Schema.brand` is **erased at runtime**: the wire value is the plain refined string,
//! and the brand exists only so TypeScript cannot pass a `ProjectId` where a
//! `ProviderInstanceId` is expected. Rust gets the same separation from distinct types, so
//! the newtypes below are the port of the brand rather than decoration on top of it.

use crate::base::{Check, Checked, MaxLength, NonEmpty};
use regex::Regex;
use serde::{Deserialize, Serialize};
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

/// `ProviderDriverKind` (`providerInstance.ts:64`) — the same `slugSchema` under a different
/// brand, so the wire behaviour is identical and only the TypeScript type differs. Rust has
/// no brand to lean on, which is why this is a newtype rather than a second alias: a
/// `provider` field and an `instanceId` field must not be interchangeable in the port even
/// though they are interchangeable on the wire.
///
/// Both are **open**: an unknown driver kind must decode, because a fork's threads outlive
/// the build that registered it.
///
/// Deliberately no `Hash`/`Ord`: [`Checked`] orders and hashes nothing, and the port has no
/// map keyed by a driver kind yet. Add them to [`Checked`] when one needs it, rather than
/// here, so the bound stays with the type that carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProviderDriverKind(pub ProviderInstanceId);
