//! Builds the InDesign English hyphenation data from InDesign's own measured breaks.
//!
//! ```text
//! cargo run --release -p designcraft-compose --example indesign_hyph -- <en-us|en-gb|en-ca> <out-dir> <measured.txt>… [--validate]
//! ```
//!
//! Input: `word|p1,p2,…` lines written by `experiments/indesign-compose/hyphenation/points-fast.jsx`
//! (where InDesign 2026 put a hyphen in each word with hyphenation limits 1/1). Nothing of Adobe's
//! is read: only the breaks InDesign produced. Writes `<key>.pat` (Liang patterns trained from the
//! breaks by `hyphen::patgen`, raw-deflated like `hyphen::dict`) and `<key>.exc` (the words the
//! patterns still get wrong, in the `hyphen::dict` format), so every measured word breaks exactly as
//! in InDesign.
//! `--validate` first trains on 90% of the words and reports how the held-out 10% fare.
//! `--check` trains nothing: it counts the measured words that the data compiled into this build
//! (through `hyphen::hyphen_points`, limits 1/1 as measured) breaks differently.

use std::path::PathBuf;

use designcraft_compose::hyphen::dict::Dictionary;
use designcraft_compose::hyphen::patgen::{self, Level};
use designcraft_compose::hyphen::{English, INDESIGN_MIN_AFTER, INDESIGN_MIN_BEFORE, Limits, hyphen_points};

/// Chosen on the 215,113 measured American words (2026-10-12): trained on 9 in 10, the held-out
/// 21,512 broke exactly as InDesign in 19,647 cases; the 6 default levels gave 17,381 and the
/// public Hunspell patterns break 11,436 of InDesign's own 44,254 dictionary words differently.
const INDESIGN_LEVELS: &[Level] = &[
    Level { min_len: 1, max_len: 5, good_weight: 1, bad_weight: 2, threshold: 2 },
    Level { min_len: 2, max_len: 6, good_weight: 2, bad_weight: 1, threshold: 2 },
    Level { min_len: 3, max_len: 7, good_weight: 1, bad_weight: 2, threshold: 1 },
    Level { min_len: 3, max_len: 8, good_weight: 2, bad_weight: 1, threshold: 1 },
    Level { min_len: 4, max_len: 9, good_weight: 1, bad_weight: 2, threshold: 1 },
    Level { min_len: 4, max_len: 9, good_weight: 2, bad_weight: 1, threshold: 1 },
    Level { min_len: 5, max_len: 9, good_weight: 1, bad_weight: 2, threshold: 1 },
    Level { min_len: 5, max_len: 9, good_weight: 2, bad_weight: 1, threshold: 1 },
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let validate = args.iter().any(|a| a == "--validate");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if pos.len() < 3 {
        eprintln!("usage: indesign_hyph <en-us|en-gb|en-ca> <out-dir> <measured.txt>… [--validate]");
        std::process::exit(2);
    }
    let key = pos[0].as_str();
    let out_dir = PathBuf::from(pos[1]);
    let mut words: Vec<(Vec<char>, Vec<usize>)> = Vec::new();
    for f in &pos[2..] {
        for line in std::fs::read_to_string(f).expect("read measured file").lines() {
            let Some((w, p)) = line.trim().split_once('|') else { continue };
            let w: Vec<char> = w.chars().collect();
            if w.is_empty() || !w.iter().all(|c| c.is_ascii_lowercase()) {
                continue;
            }
            let p: Vec<usize> = p.split(',').filter(|x| !x.is_empty()).map(|x| x.parse().expect("break position")).collect();
            words.push((w, p));
        }
    }
    words.sort();
    words.dedup();
    let before = words.len();
    words.dedup_by(|a, b| a.0 == b.0);
    if words.len() != before {
        println!("warning: {} words were measured with different breaks; kept the first", before - words.len());
    }
    println!("{key}: {} measured words", words.len());
    if args.iter().any(|a| a == "--check") {
        let lang = English::of(key);
        let lim = Limits { min_word: 3, after_first: 1, before_last: 1, capitalized: true };
        let wrong: Vec<_> = words.iter().filter(|(w, b)| hyphen_points(&w.iter().collect::<String>(), &lim, lang) != *b).collect();
        println!("{key} ({lang:?}): {} of {} measured words break differently", wrong.len(), words.len());
        for (w, b) in wrong.iter().take(10) {
            println!("  {} measured {b:?}", w.iter().collect::<String>());
        }
        return;
    }
    // Breaks the patterns give once InDesign's dictionary minimums apply.
    let allowed = |w: &[char], p: Vec<usize>| p.into_iter().filter(|&i| i >= INDESIGN_MIN_BEFORE && w.len() - i >= INDESIGN_MIN_AFTER).collect::<Vec<_>>();
    let mut log = |s: String| println!("  {s}");
    // Levels: INDESIGN_LEVELS, or HYPHGEN_LEVELS="min,max,good,bad,threshold;…" for tuning.
    let custom: Option<Vec<patgen::Level>> = std::env::var("HYPHGEN_LEVELS").ok().map(|s| {
        s.split(';')
            .map(|l| {
                let v: Vec<u32> = l.split(',').map(|x| x.trim().parse().expect("number")).collect();
                patgen::Level { min_len: v[0] as usize, max_len: v[1] as usize, good_weight: v[2], bad_weight: v[3], threshold: v[4] }
            })
            .collect()
    });
    let levels = custom.as_deref().unwrap_or(INDESIGN_LEVELS);
    let margins = (INDESIGN_MIN_BEFORE, INDESIGN_MIN_AFTER);
    if validate {
        let (fit, hold): (Vec<_>, Vec<_>) = words.iter().cloned().enumerate().partition(|(i, _)| i % 10 != 0);
        let fit: Vec<_> = fit.into_iter().map(|x| x.1).collect();
        let hold: Vec<_> = hold.into_iter().map(|x| x.1).collect();
        let p = patgen::train_within(&fit, levels, margins, &mut log);
        let same = hold.iter().filter(|(w, b)| allowed(w, p.points(w).unwrap_or_default()) == *b).count();
        println!("held-out: {same} of {} words break exactly as InDesign", hold.len());
    }
    let pats = patgen::train_within(&words, levels, margins, &mut log);
    let exceptions: Vec<(String, u64)> = words
        .iter()
        .filter(|(w, b)| allowed(w, pats.points(w).unwrap_or_default()) != *b)
        .map(|(w, b)| (w.iter().collect(), b.iter().fold(0u64, |m, &i| m | 1 << i)))
        .collect();
    println!("{key}: {} patterns; {} of {} words need an exception", pats.len(), exceptions.len(), words.len());
    let mut out = String::new();
    out.push_str(&format!("% {key} hyphenation patterns (Liang/TeX notation) that break where InDesign 2026 does.\n"));
    out.push_str("% Generated by examples/indesign_hyph.rs: trained with DesignCraft's patgen-style trainer from the\n");
    out.push_str("% breaks InDesign produced for a word list (experiments/indesign-compose/hyphenation/points-fast.jsx).\n");
    for line in pats.to_tex().chunks(12) {
        out.push_str(&line.join(" "));
        out.push('\n');
    }
    std::fs::create_dir_all(&out_dir).expect("mkdir");
    let packed = miniz_oxide::deflate::compress_to_vec(out.as_bytes(), 10);
    std::fs::write(out_dir.join(format!("{key}.pat.z")), &packed).expect("write patterns");
    let exc = Dictionary::from_entries(exceptions);
    let bytes = exc.to_bytes();
    assert_eq!(Dictionary::from_bytes(&bytes).expect("roundtrip").len(), exc.len());
    std::fs::write(out_dir.join(format!("{key}.exc")), &bytes).expect("write exceptions");
    println!("{key}.pat.z {} bytes ({} as text), {key}.exc {} bytes", packed.len(), out.len(), bytes.len());
}
