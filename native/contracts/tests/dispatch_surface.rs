//! The dispatch surface has to agree with itself even without the TypeScript, and
//! agree with the shipped tables when a golden is supplied.
//!
//! Set `LMCS_CONTRACTS_GOLDEN` to a golden file; the cross-language half skips
//! when unset. Regenerate one with:
//! `node apps/server/scripts/contracts-golden.ts > /tmp/contracts-golden.json`

use std::collections::BTreeSet;

use lmcs_contracts::{
    ORCHESTRATION_WS_METHODS, REGISTERED, STREAMED_METHODS, UNREGISTERED, VOID_SUCCESS_METHODS,
    WS_METHODS,
};

fn declared() -> Vec<&'static str> {
    WS_METHODS
        .iter()
        .chain(ORCHESTRATION_WS_METHODS.iter())
        .map(|(_, tag)| *tag)
        .collect()
}

#[test]
fn the_tables_agree_with_the_registered_set() {
    let all = declared();
    let unique: BTreeSet<&str> = all.iter().copied().collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut repeated: BTreeSet<&str> = BTreeSet::new();
    for tag in all.iter().copied() {
        if !seen.insert(tag) {
            repeated.insert(tag);
        }
    }
    assert_eq!(
        unique.len(),
        all.len(),
        "a tag is declared twice: {repeated:?}"
    );

    let registered: BTreeSet<&str> = REGISTERED.iter().copied().collect();
    assert_eq!(
        registered.len(),
        REGISTERED.len(),
        "a tag is registered twice"
    );

    let undeclared: Vec<&str> = REGISTERED
        .iter()
        .filter(|tag| !unique.contains(**tag))
        .copied()
        .collect();
    assert!(
        undeclared.is_empty(),
        "registered without a declaration: {undeclared:?}"
    );

    let expected_unregistered: BTreeSet<_> = unique.difference(&registered).copied().collect();
    let actual: BTreeSet<&str> = UNREGISTERED.iter().copied().collect();
    assert_eq!(actual, expected_unregistered);
}

/// The two envelope buckets this crate names have to be real: disjoint, drawn from the
/// declared keys, and not exhaustive — because the 94 methods that are neither are the
/// ordinary request/response ones, and a list that swallowed them would be useless.
#[test]
fn the_envelope_buckets_are_disjoint_declared_keys() {
    let declared = declared_keys();
    for (name, list) in [
        ("STREAMED_METHODS", STREAMED_METHODS),
        ("VOID_SUCCESS_METHODS", VOID_SUCCESS_METHODS),
    ] {
        let unique: BTreeSet<&str> = list.iter().copied().collect();
        assert_eq!(unique.len(), list.len(), "{name} repeats a key");
        let undeclared: Vec<_> = list
            .iter()
            .filter(|key| !declared.contains(*key))
            .copied()
            .collect();
        assert!(
            undeclared.is_empty(),
            "{name} names keys that no table declares: {undeclared:?}"
        );
    }
    let overlap: BTreeSet<&str> = STREAMED_METHODS
        .iter()
        .copied()
        .filter(|key| VOID_SUCCESS_METHODS.contains(key))
        .collect();
    assert!(
        overlap.is_empty(),
        "a method cannot both stream and return nothing: {overlap:?}"
    );

    let plain = REGISTERED.len() - STREAMED_METHODS.len() - VOID_SUCCESS_METHODS.len();
    assert!(
        plain > 0,
        "the two buckets swallowed every registered method, so one of them is wrong"
    );
}

fn declared_keys() -> Vec<&'static str> {
    WS_METHODS
        .iter()
        .chain(ORCHESTRATION_WS_METHODS.iter())
        .map(|(key, _)| *key)
        .collect()
}

#[test]
fn every_declared_key_is_a_distinct_identifier() {
    let keys: Vec<_> = WS_METHODS
        .iter()
        .chain(ORCHESTRATION_WS_METHODS.iter())
        .map(|(key, _)| *key)
        .collect();
    let unique: BTreeSet<_> = keys.iter().collect();
    assert_eq!(
        unique.len(),
        keys.len(),
        "a key is reused across the tables"
    );
    for (key, tag) in WS_METHODS.iter().chain(ORCHESTRATION_WS_METHODS.iter()) {
        assert!(
            !key.is_empty() && !tag.is_empty(),
            "{key:?} has an empty field"
        );
    }
}

fn table(value: &serde_json::Value, field: &str) -> Vec<(String, String)> {
    value[field]
        .as_array()
        .unwrap_or_else(|| panic!("{field} is an array"))
        .iter()
        .map(|pair| {
            let pair = pair
                .as_array()
                .unwrap_or_else(|| panic!("{field} holds [key, tag] pairs"));
            let text = |slot: usize| {
                pair[slot]
                    .as_str()
                    .unwrap_or_else(|| panic!("{field} entry {pair:?} has a string at {slot}"))
                    .to_owned()
            };
            (text(0), text(1))
        })
        .collect()
}

fn owned(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, tag)| ((*key).to_owned(), (*tag).to_owned()))
        .collect()
}

fn owned_tags(tags: &[&str]) -> Vec<String> {
    tags.iter().map(|tag| (*tag).to_owned()).collect()
}

#[test]
fn replays_the_golden_dumped_from_the_shipped_tables() {
    let Some(path) = std::env::var_os("LMCS_CONTRACTS_GOLDEN") else {
        eprintln!("skipped: LMCS_CONTRACTS_GOLDEN is unset, so no cross-language check ran");
        return;
    };
    let text = std::fs::read_to_string(&path).expect("the golden file is readable");
    let golden: serde_json::Value = serde_json::from_str(&text).expect("the golden is JSON");

    // Declaration order is part of what the ported tables claim to reproduce, and the
    // generator emits it as an array so no parser feature has to preserve it.
    assert_eq!(table(&golden, "wsMethods"), owned(WS_METHODS));
    assert_eq!(
        table(&golden, "orchestrationWsMethods"),
        owned(ORCHESTRATION_WS_METHODS)
    );

    let registered: Vec<String> = golden["registered"]
        .as_array()
        .expect("registered is an array")
        .iter()
        .map(|tag| {
            tag.as_str()
                .expect("a registered tag is a string")
                .to_owned()
        })
        .collect();
    assert_eq!(registered, owned_tags(REGISTERED));

    let unregistered: Vec<String> = golden["reconciliation"]["declaredNotRegistered"]
        .as_array()
        .expect("declaredNotRegistered is an array")
        .iter()
        .map(|entry| entry["tag"].as_str().expect("a tag").to_owned())
        .collect();
    assert_eq!(unregistered, owned_tags(UNREGISTERED));

    let registered_not_declared = golden["reconciliation"]["registeredNotDeclared"]
        .as_array()
        .expect("registeredNotDeclared is an array");
    assert!(
        registered_not_declared.is_empty(),
        "the shipped group registers undeclared tags: {registered_not_declared:?}"
    );
    let duplicates = golden["reconciliation"]["duplicateTags"]
        .as_array()
        .expect("duplicateTags is an array");
    assert!(
        duplicates.is_empty(),
        "the shipped tables repeat a tag: {duplicates:?}"
    );

    assert_eq!(
        declared().len(),
        WS_METHODS.len() + ORCHESTRATION_WS_METHODS.len()
    );
    assert!(
        !REGISTERED.is_empty() && REGISTERED.len() < declared().len(),
        "the declared-but-unregistered gap this crate records has changed shape"
    );

    // The envelope census. Every scalar below is an *invariant* rather than a number this
    // crate hard-codes, so the assertions still mean something when a method is added: the
    // three buckets have to partition the registered set, `Rpc.key` has to be derived from
    // the tag for all of them, every method has to share the one interned `Schema.Defect()`,
    // and the only methods with a `Never` error channel have to be exactly the streamed ones.
    let envelope = &golden["rpcEnvelope"];
    let count = |field: &str| {
        envelope[field]
            .as_u64()
            .unwrap_or_else(|| panic!("{field} is a number")) as usize
    };
    let keys = |field: &str| -> Vec<String> {
        envelope[field]
            .as_array()
            .unwrap_or_else(|| panic!("{field} is an array"))
            .iter()
            .map(|key| key.as_str().expect("a method key").to_owned())
            .collect()
    };

    assert_eq!(count("total"), REGISTERED.len());
    assert_eq!(keys("streamedKeys"), owned_tags(STREAMED_METHODS));
    assert_eq!(keys("voidSuccessKeys"), owned_tags(VOID_SUCCESS_METHODS));
    assert_eq!(count("streamed"), STREAMED_METHODS.len());
    assert_eq!(count("voidSuccess"), VOID_SUCCESS_METHODS.len());
    assert_eq!(
        count("plain") + count("streamed") + count("voidSuccess"),
        count("total"),
        "the envelope buckets do not partition the registered methods"
    );
    assert_eq!(
        count("derivedKey"),
        count("total"),
        "an Rpc.key was overridden"
    );
    assert_eq!(
        count("sharedDefect"),
        count("total"),
        "a method carries its own defect schema, so the Defect port is no longer one behaviour"
    );
    assert_eq!(
        count("neverError"),
        count("streamed"),
        "the methods with a `Never` error channel are exactly the streamed ones"
    );
    assert_eq!(count("voidPayload"), 0, "a method takes no payload");
    assert_eq!(
        count("streamSuccessVoid"),
        0,
        "a stream carries `Void` elements, so it can never emit"
    );
    assert_eq!(
        count("streamErrorNever"),
        0,
        "a stream has a `Never` error channel, so it can never fail"
    );
}
