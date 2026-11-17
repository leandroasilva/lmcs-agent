//! What the subscription providers say about the account's usage, ported from
//! `apps/server/src/provider/providerUsageLimits.ts`,
//! `apps/server/src/provider/Layers/claudeUsageLimits.ts`,
//! `apps/server/src/provider/Layers/codexUsageLimits.ts`,
//! `apps/server/src/provider/Layers/cursorUsageLimits.ts` and
//! `apps/server/src/provider/Layers/grokUsageLimits.ts`.
//!
//! The Limits view draws one bar per rolling quota window per account. Three things make that
//! picture up, and each is a module here:
//!
//! - [`limits`] — the provider-independent rules: clamping a percentage, the order bars stack
//!   in, folding a sparse mid-turn update onto the published snapshot, and what a failed probe
//!   may erase.
//! - [`claude`], [`codex`], [`cursor`] and [`grok`] — each provider's way of naming the same
//!   windows, so a turn-driven event lands on the row the status probe drew instead of opening
//!   a second one. Two of them also decide what a response with nothing in it means: an
//!   account that cannot have bars, and an account that has not used any yet.
//! - [`jsdate`] — the epoch arithmetic both mappers lean on, since a reset time arrives as an
//!   ISO string from one and epoch seconds from the other, and the wait in a Codex stop
//!   message is a `Date.parse` difference.
//!
//! [`read`] is the boundary these are written against: the shipped mappers question the
//! provider's own JSON with JavaScript predicates (`typeof … === "number"`, `!== undefined`)
//! rather than trusting its declared types, and a port that trusts the types would answer
//! differently about a malformed snapshot.
//!
//! The wire types this crate does *not* own — the published snapshot a client receives, the
//! instance it belongs to — stay in [`crate::limits`] as values, and the orchestration layer
//! that decides when to probe is outside this crate.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod grok;
pub mod jsdate;
pub mod limits;
pub mod read;
