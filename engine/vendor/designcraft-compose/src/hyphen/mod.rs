//! English hyphenation.
//!
//! Lookup order for each word:
//! 1. **InDesign's breaks** ([`English`]): for American, British and Canadian English, the words
//!    whose breaks InDesign 2026 was measured to make but our patterns miss (`assets/hyphenation/
//!    indesign/<lang>.exc`), then Liang patterns trained from all those measured breaks
//!    (`<lang>.pat.z`, raw-deflated; `examples/indesign_hyph.rs` regenerates both);
//! 2. the **dictionary** ([`Dictionary::en_us`]) — the public-domain Moby Hyphenator II word list
//!    by Grady Ward (~160k words), stored compactly in `assets/hyphenation/en-us.dic`; simple
//!    inflections (`'s`, `-s`, `-es`, `-ed`, `-d`) inherit the breaks of their stem;
//! 3. **Liang patterns** ([`Patterns::en_us`]) trained from the same list by [`patgen`]
//!    (`examples/hyphgen.rs` regenerates both files);
//! 4. a small syllable **heuristic** for words outside the pattern alphabet.
//!
//! Then the paragraph's limits ([`Limits`]) are applied.

pub mod dict;
pub mod patgen;
pub mod patterns;

use std::sync::OnceLock;

pub use dict::Dictionary;
pub use patterns::Patterns;

static EN_US_DIC: &[u8] = include_bytes!("../../assets/hyphenation/en-us.dic");
static EN_US_PAT: &str = include_str!("../../assets/hyphenation/en-us.pat");
/// (raw-deflated patterns, exceptions) per [`English`].
static INDESIGN: [(&[u8], &[u8]); 3] = [
    (include_bytes!("../../assets/hyphenation/indesign/en-us.pat.z"), include_bytes!("../../assets/hyphenation/indesign/en-us.exc")),
    (include_bytes!("../../assets/hyphenation/indesign/en-gb.pat.z"), include_bytes!("../../assets/hyphenation/indesign/en-gb.exc")),
    (include_bytes!("../../assets/hyphenation/indesign/en-ca.pat.z"), include_bytes!("../../assets/hyphenation/indesign/en-ca.exc")),
];

/// InDesign's English dictionaries never break before the 2nd letter or after the 2nd-last
/// (on top of the paragraph's limits).
pub const INDESIGN_MIN_BEFORE: usize = 2;
pub const INDESIGN_MIN_AFTER: usize = 2;

/// Which of InDesign's English hyphenation dictionaries a language uses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum English {
    #[default]
    Us,
    Uk,
    Canada,
}

impl English {
    /// The dictionary for an English language (an InDesign name like "English: UK" or a locale
    /// code like `en-GB`): British and Canadian English have their own, every other English
    /// (USA, USA Legal, USA Medical, other regions) uses the American one.
    pub fn of(language: &str) -> English {
        match designcraft_doc::language_tag(language) {
            Some("en-GB") => English::Uk,
            Some("en-CA") => English::Canada,
            _ => English::Us,
        }
    }

    /// The breaks InDesign makes in this English: (patterns, exceptions), loaded on first use.
    fn data(self) -> &'static (Patterns, Dictionary) {
        static D: [OnceLock<(Patterns, Dictionary)>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
        let i = self as usize;
        D[i].get_or_init(|| {
            let (pat, exc) = INDESIGN[i];
            let pat = miniz_oxide::inflate::decompress_to_vec(pat).map_err(|e| format!("{e:?}")).and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()));
            let pat = pat.map(|t| Patterns::parse(&t)).unwrap_or_else(|e| {
                log::error!("InDesign hyphenation patterns: {e}");
                Patterns::default()
            });
            let exc = Dictionary::from_bytes(exc).unwrap_or_else(|e| {
                log::error!("{e}");
                Dictionary::default()
            });
            (pat, exc)
        })
    }
}

impl Dictionary {
    /// The bundled US English dictionary (decoded on first use).
    pub fn en_us() -> &'static Dictionary {
        static D: OnceLock<Dictionary> = OnceLock::new();
        D.get_or_init(|| {
            if EN_US_DIC.is_empty() {
                return Dictionary::default();
            }
            Dictionary::from_bytes(EN_US_DIC).unwrap_or_else(|e| {
                log::error!("{e}");
                Dictionary::default()
            })
        })
    }
}

impl Patterns {
    /// The bundled US English patterns (parsed on first use).
    pub fn en_us() -> &'static Patterns {
        static P: OnceLock<Patterns> = OnceLock::new();
        P.get_or_init(|| Patterns::parse(EN_US_PAT))
    }
}

/// Hyphenation limits from the paragraph's Hyphenation settings.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub min_word: usize,
    pub after_first: usize,
    pub before_last: usize,
    pub capitalized: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { min_word: 5, after_first: 2, before_last: 2, capitalized: true }
    }
}

/// Where a word's break points came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Dictionary,
    Patterns,
    Heuristic,
    None,
}

fn is_apostrophe(c: char) -> bool {
    matches!(c, '\'' | '’' | 'ʼ')
}

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || is_apostrophe(c)
}

/// InDesign's breaks for one lowercase core, or None if a letter is outside its alphabet. An
/// apostrophe splits the core like a compound: each part breaks on its own.
fn indesign_breaks(core: &[char], lang: English) -> Option<Vec<usize>> {
    let (pats, exc) = lang.data();
    if pats.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let mut start = 0;
    for part in core.split(|&c| c == '\'') {
        let n = part.len();
        if n >= 2 {
            let s: String = part.iter().collect();
            let pts: Vec<usize> = match exc.get(&s) {
                Some(m) => (1..n.min(64)).filter(|&i| m & (1 << i) != 0).collect(),
                None => pats.points(part)?.into_iter().filter(|&i| i >= INDESIGN_MIN_BEFORE && n - i >= INDESIGN_MIN_AFTER).collect(),
            };
            out.extend(pts.into_iter().map(|p| start + p));
        }
        start += n + 1;
    }
    Some(out)
}

/// Unrestricted break points of one lowercase core (letters and `'` only, no leading/trailing `'`).
fn core_breaks(core: &[char], lang: English) -> (Vec<usize>, Source) {
    let n = core.len();
    if n < 2 {
        return (vec![], Source::None);
    }
    // InDesign's own breaks first; the word list and patterns below cover other letters.
    if let Some(p) = indesign_breaks(core, lang) {
        return (p, Source::Patterns);
    }
    let dict = Dictionary::en_us();
    let s: String = core.iter().collect();
    let from_mask = |m: u64, len: usize| (1..len.min(64)).filter(|&i| m & (1 << i) != 0).collect::<Vec<_>>();
    if let Some(m) = dict.get(&s) {
        return (from_mask(m, n), Source::Dictionary);
    }
    // Inflections inherit the stem's breaks (the suffix adds no break of its own).
    for suf in ["'s", "s", "es", "ed", "d"] {
        if let Some(stem) = s.strip_suffix(suf)
            && stem.chars().count() >= 2
            && let Some(m) = dict.get(stem)
        {
            return (from_mask(m, stem.chars().count()), Source::Dictionary);
        }
    }
    let pats = Patterns::en_us();
    if !pats.is_empty()
        && let Some(p) = pats.points(core)
    {
        return (p, Source::Patterns);
    }
    (heuristic_points(core), Source::Heuristic)
}

/// Unrestricted break points of `word` (char indices; a hyphen goes before that char), handling
/// case, apostrophes (`don't`, `’s`), surrounding punctuation and compounds (each letter run is
/// hyphenated separately). No break is ever placed next to an apostrophe or non-letter.
pub fn word_breaks(word: &str, lang: English) -> (Vec<usize>, Source) {
    let chars: Vec<char> = word.chars().collect();
    let mut out = Vec::new();
    let mut src = Source::None;
    let mut i = 0;
    while i < chars.len() {
        if !is_word_char(chars[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && is_word_char(chars[j]) {
            j += 1;
        }
        let (mut a, mut b) = (i, j);
        while a < b && is_apostrophe(chars[a]) {
            a += 1;
        }
        while b > a && is_apostrophe(chars[b - 1]) {
            b -= 1;
        }
        let core: Vec<char> = chars[a..b].iter().map(|&c| if is_apostrophe(c) { '\'' } else { c.to_lowercase().next().unwrap_or(c) }).collect();
        let (pts, s) = core_breaks(&core, lang);
        if src == Source::None {
            src = s;
        }
        out.extend(pts.into_iter().filter(|&p| p > 0 && p < core.len() && core[p - 1] != '\'' && core[p] != '\'').map(|p| a + p));
        i = j;
    }
    (out, src)
}

/// Allowed hyphenation points in `word` as char indices (a hyphen goes before that char), with
/// the paragraph limits applied to each letter run.
pub fn hyphen_points(word: &str, lim: &Limits, lang: English) -> Vec<usize> {
    let chars: Vec<char> = word.chars().collect();
    let (pts, _) = word_breaks(word, lang);
    if pts.is_empty() {
        return pts;
    }
    let min_before = lim.after_first.max(1);
    let min_after = lim.before_last.max(1);
    // Run bounds of each point's letter run (trimmed of apostrophes).
    let run_of = |p: usize| {
        let mut a = p;
        while a > 0 && is_word_char(chars[a - 1]) {
            a -= 1;
        }
        let mut b = p;
        while b < chars.len() && is_word_char(chars[b]) {
            b += 1;
        }
        while a < b && is_apostrophe(chars[a]) {
            a += 1;
        }
        while b > a && is_apostrophe(chars[b - 1]) {
            b -= 1;
        }
        (a, b)
    };
    pts.into_iter()
        .filter(|&p| {
            let (a, b) = run_of(p);
            let run = &chars[a..b];
            let letters = run.iter().filter(|c| c.is_alphabetic()).count();
            if letters < lim.min_word.max(2) {
                return false;
            }
            if letters > 1 && run.iter().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase()) {
                return false;
            }
            if !lim.capitalized && run[0].is_uppercase() {
                return false;
            }
            let before = chars[a..p].iter().filter(|c| c.is_alphabetic()).count();
            let after = chars[p..b].iter().filter(|c| c.is_alphabetic()).count();
            before >= min_before && after >= min_after
        })
        .collect()
}

/// `word` with `-` at every hyphenation point (tests and diagnostics).
pub fn hyphenate_word(word: &str, lim: &Limits, lang: English) -> String {
    let pts = hyphen_points(word, lim, lang);
    let mut s = String::with_capacity(word.len() + pts.len());
    for (i, ch) in word.chars().enumerate() {
        if pts.contains(&i) {
            s.push('-');
        }
        s.push(ch);
    }
    s
}

// ---------- heuristic fallback (words outside the pattern alphabet) ----------

fn is_vowel(c: char) -> bool {
    matches!(c.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u' | 'y') || (c.is_alphabetic() && !c.is_ascii())
}

fn onset_pair(a: char, b: char) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    matches!(
        (a, b),
        ('c' | 's' | 't' | 'p' | 'w' | 'g', 'h')
            | ('b' | 'c' | 'd' | 'f' | 'g' | 'k' | 'p' | 't', 'r')
            | ('b' | 'c' | 'f' | 'g' | 'k' | 'p' | 's', 'l')
            | ('q', 'u')
            | ('s', 't' | 'p' | 'c' | 'k')
    )
}

/// Syllable heuristic: V-CV ("ty-po"), VC-CV ("hap-pen"), keeping onset clusters ("gra-phy").
fn heuristic_points(c: &[char]) -> Vec<usize> {
    let n = c.len();
    if n < 4 || !c.iter().all(|c| c.is_alphabetic()) {
        return vec![];
    }
    let v: Vec<bool> = c.iter().map(|&x| is_vowel(x)).collect();
    let mut out = vec![];
    for i in 1..n {
        let ok = if v[i - 1] && !v[i] {
            (i + 1 < n && v[i + 1]) || (i + 2 < n && onset_pair(c[i], c[i + 1]) && v[i + 2])
        } else if !v[i - 1] && !v[i] {
            i >= 2 && v[i - 2] && i + 1 < n && v[i + 1] && !onset_pair(c[i - 1], c[i]) && c[i - 1] != c[i] || (c[i - 1] == c[i] && i >= 2 && v[i - 2])
        } else {
            false
        };
        // Both parts need a sounded vowel: a trailing silent `e`, `ed` or `es` doesn't count.
        let right: String = c[i..].iter().collect();
        let core = right.strip_suffix("ed").or_else(|| right.strip_suffix("es")).or_else(|| right.strip_suffix('e')).unwrap_or(&right);
        if ok && core.chars().any(is_vowel) && core.len() > 1 && v[..i].iter().any(|x| *x) {
            out.push(i);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(w: &str) -> String {
        hyphenate_word(w, &Limits::default(), English::Us)
    }

    /// Breaks measured in InDesign 2026 (limits 1/1) with the old one-word-at-a-time method.
    fn measured(text: &str) -> Vec<(String, Vec<usize>)> {
        text.lines()
            .filter_map(|l| l.split_once('|'))
            .map(|(w, p)| (w.to_string(), p.split(',').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect()))
            .collect()
    }

    #[test]
    fn breaks_where_indesign_does() {
        let lim = Limits { min_word: 5, after_first: 1, before_last: 1, capitalized: true }; // points.jsx kept the default 5
        for (lang, text) in [
            (English::Us, include_str!("../../assets/hyphenation/indesign/measured-en-us.txt")),
            (English::Uk, include_str!("../../assets/hyphenation/indesign/measured-en-gb.txt")),
        ] {
            let words = measured(text);
            assert!(words.len() > 40);
            for (w, want) in words {
                assert_eq!(hyphen_points(&w, &lim, lang), want, "{lang:?} {w}");
            }
        }
    }

    #[test]
    fn languages_pick_indesigns_dictionary() {
        assert_eq!(English::of("English: UK"), English::Uk);
        assert_eq!(English::of("$ID/English: UK"), English::Uk);
        assert_eq!(English::of("en-GB"), English::Uk);
        assert_eq!(English::of("English: Canadian"), English::Canada);
        assert_eq!(English::of("English: USA"), English::Us);
        assert_eq!(English::of("English: USA Legal"), English::Us);
        assert_eq!(English::of("en"), English::Us);
        assert_eq!(hyphenate_word("colour", &Limits { min_word: 3, ..Limits::default() }, English::Uk), "col-our");
    }

    #[test]
    fn bundled_data_loads() {
        assert!(Dictionary::en_us().len() > 150_000, "{}", Dictionary::en_us().len());
        assert!(Patterns::en_us().len() > 1000, "{}", Patterns::en_us().len());
    }

    #[test]
    fn dictionary_words() {
        assert_eq!(h("happen"), "hap-pen");
        assert_eq!(h("typography"), "ty-pog-ra-phy");
        assert_eq!(h("composition"), "com-po-si-tion");
        // InDesign's breaks (the Moby word list said "hy-phen-a-tion").
        assert_eq!(h("hyphenation"), "hy-phen-ation");
        assert_eq!(h("international"), "in-ter-na-tion-al");
        assert_eq!(h("cat"), "cat");
        assert!(!h("changed").contains('-'));
        assert_eq!(h("NASA"), "NASA");
        assert_eq!(word_breaks("publication", English::Us).1, Source::Patterns);
        assert_eq!(h("paragraph"), "para-graph");
        assert_eq!(h("Editors"), "Ed-i-tors");
    }

    #[test]
    fn case_apostrophes_and_punctuation() {
        assert_eq!(h("Typography"), "Ty-pog-ra-phy");
        assert_eq!(h("TYPOGRAPHY"), "TYPOGRAPHY");
        assert_eq!(h("typography,"), "ty-pog-ra-phy,");
        assert_eq!(h("“typography”"), "“ty-pog-ra-phy”");
        assert_eq!(h("typography's"), "ty-pog-ra-phy's");
        assert_eq!(h("typography’s"), "ty-pog-ra-phy’s");
        assert_eq!(h("'typography'"), "'ty-pog-ra-phy'");
        // Compounds: each part separately, never next to the hyphen.
        assert_eq!(h("typography-composition"), "ty-pog-ra-phy-com-po-si-tion");
    }

    #[test]
    fn inflections_inherit_the_stem() {
        assert_eq!(h("ripples"), "rip-ples");
        assert_eq!(h("gradients"), "gra-di-ents");
        assert_eq!(h("restrained"), "re-strained");
    }

    #[test]
    fn patterns_cover_unknown_words() {
        // Not in the word list: the trained patterns decide.
        let (pts, src) = word_breaks("hyperlocalization", English::Us);
        assert_eq!(src, Source::Patterns);
        assert!(pts.len() >= 4, "{}", h("hyperlocalization"));
        let (_, src) = word_breaks("zzyzx", English::Us);
        assert_ne!(src, Source::Dictionary);
    }

    #[test]
    fn limits_are_respected() {
        let lim = Limits { min_word: 5, after_first: 3, before_last: 3, capitalized: false };
        for w in ["typography", "hyphenation", "justification", "Paragraph", "beautiful"] {
            for p in hyphen_points(w, &lim, English::Us) {
                assert!(p >= 3 && p <= w.chars().count() - 3, "{w} {p}");
            }
        }
        assert!(hyphen_points("Paragraph", &lim, English::Us).is_empty());
        let lim = Limits { min_word: 12, ..Limits::default() };
        assert!(hyphen_points("typography", &lim, English::Us).is_empty());
    }

    #[test]
    fn heuristic_fallback() {
        let c: Vec<char> = "happen".chars().collect();
        assert_eq!(heuristic_points(&c), vec![3]);
    }
}
