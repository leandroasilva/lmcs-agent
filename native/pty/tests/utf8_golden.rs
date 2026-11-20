use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};

use lmcs_pty::utf8::Utf8Decoder;
use serde_json::Value;

fn bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
        .collect()
}

#[test]
fn matches_node_string_decoder_at_every_write_and_eof() {
    let Ok(path) = std::env::var("LMCS_UTF8_TRACE") else {
        eprintln!("skipped UTF-8 golden: set LMCS_UTF8_TRACE to the generated trace");
        return;
    };
    let file = std::fs::File::open(path).expect("read the captured Node decoder trace");
    let mut counts = BTreeMap::<String, usize>::new();
    let mut names = BTreeSet::new();
    let mut total = 0;
    for line in BufReader::new(file).lines() {
        let case: Value = serde_json::from_str(&line.unwrap()).expect("a JSON trace record");
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name.to_string()), "duplicate case {name}");
        let chunks = case["chunks"].as_array().unwrap();
        let writes = case["writes"].as_array().unwrap();
        assert_eq!(chunks.len(), writes.len(), "{name}");
        let mut decoder = Utf8Decoder::new();
        for (index, (chunk, expected)) in chunks.iter().zip(writes).enumerate() {
            let input = bytes(chunk.as_str().unwrap());
            assert_eq!(
                decoder.write(&input),
                expected.as_str().unwrap(),
                "{name}, write {index}, bytes {input:02x?}"
            );
        }
        assert_eq!(
            decoder.finish(),
            case["end"].as_str().unwrap(),
            "{name}, EOF"
        );
        assert_eq!(
            decoder.write(b"\xa9ok"),
            case["reset"].as_str().unwrap(),
            "{name}, reuse after EOF"
        );
        assert_eq!(
            decoder.finish(),
            case["secondEnd"].as_str().unwrap(),
            "{name}, second EOF"
        );
        *counts
            .entry(name.split('/').next().unwrap().to_string())
            .or_default() += 1;
        total += 1;
    }
    assert_eq!(counts["empty"], 1);
    assert_eq!(counts["emptyReads"], 1);
    assert_eq!(counts["burst"], 1);
    assert_eq!(counts["byte"], 256);
    assert_eq!(counts["pair"], 131_072);
    assert_eq!(counts["sample"], 269);
    assert_eq!(counts["random"], 1024);
    assert_eq!(counts.len(), 7);
    assert_eq!(total, 132_624);
    eprintln!("UTF-8 golden: {total} cases replayed, every write/EOF/reset compared");
}
