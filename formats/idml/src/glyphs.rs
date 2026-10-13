//! Text a command adds in a font that cannot show it. Korean typed into a frame set in a Latin
//! font would show as missing glyphs in InDesign, and its PDF export stops at the warning
//! (InDesign 2026, measured 2026-10-12). So after every command, the characters it inserted that
//! their run's font lacks get Source Han Sans SC Regular: InDesign installs it with every copy
//! (Resources/Required/fonts) and it covers Hangul, Kana, Han and Latin. Text that was already in
//! the document is left as it was.

use present_package::xml::{Tree, escape_text, splice};

use crate::edit::{Para, paragraphs_of};
use crate::{Error, Idml};

/// The font given to inserted characters their own font lacks.
pub(crate) const FALLBACK_FAMILY: &str = "Source Han Sans SC";
const FALLBACK_STYLE: &str = "Regular";

impl Idml {
    /// Edits for `after` (this document with a command applied) that give the characters the
    /// command inserted into `changed` story parts a font that has them, where their own lacks them.
    pub(crate) fn cover_inserted_text(&self, after: &Idml, changed: &[String]) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let mut out = Vec::new();
        for part in changed {
            let Some(story) = part.strip_prefix("Stories/Story_").and_then(|s| s.strip_suffix(".xml")) else { continue };
            // A removed story (its page was deleted) has nothing to cover.
            let Ok((name, src, tree, root)) = after.story_xml(story) else { continue };
            let paras = paragraphs_of(&tree, &src, root)?;
            let old: Vec<String> = match self.story_xml(story) {
                Ok((_, s, t, r)) => paragraphs_of(&t, &s, r)?.iter().map(para_text).collect(),
                Err(_) => Vec::new(), // a new story: all of it was inserted
            };
            let new: Vec<String> = paras.iter().map(para_text).collect();
            let inserted = inserted_positions(&old, &new);
            if inserted.is_empty() {
                continue;
            }
            let lacking = after.lacking_glyphs(story, &new, &inserted);
            if lacking.is_empty() {
                continue;
            }
            let edits = run_edits(&tree, &src, &paras, &lacking)?;
            if !edits.is_empty() {
                out.push((name, splice(&src, edits)?));
            }
        }
        Ok(out)
    }

    /// Of the `inserted` (paragraph, character) positions, those whose run font cannot show them.
    fn lacking_glyphs(&self, story: &str, paras: &[String], inserted: &[(usize, usize)]) -> Vec<(usize, usize)> {
        let Some(sid) = self.source_ids().stories.get(story) else { return Vec::new() };
        let Some(st) = self.document().stories.get(sid) else { return Vec::new() };
        let ranges = st.para_ranges();
        let styles = &self.document().styles;
        let fonts = designcraft_fonts::FontDb::global();
        let mut out = Vec::new();
        for &(pi, ci) in inserted {
            // Only where DesignCraft reads the paragraph exactly as the XML does.
            let (Some(range), Some(text)) = (ranges.get(pi), paras.get(pi)) else { continue };
            let Some(dc_text) = st.text.get(range.clone()) else { continue };
            if dc_text.trim_end_matches(['\n', '\r', '\u{2029}']).chars().count() != text.chars().count() {
                continue;
            }
            let Some((offset, ch)) = dc_text.char_indices().nth(ci) else { continue };
            if ch.is_whitespace() || ch.is_control() {
                continue;
            }
            let at = range.start + offset;
            let Some((_, format)) = st.runs().find(|(r, _)| r.start <= at && at < r.end) else { continue };
            let Some(para) = st.paras.get(pi) else { continue };
            let (_, base) = styles.resolve_para(para);
            let props = styles.resolve_char(&base, format);
            if !shows(fonts, &props.font_family, &props.font_style, ch) {
                out.push((pi, ci));
            }
        }
        // A space between two such characters joins them ("편집 확인" stays one run).
        let mut joined = out.clone();
        for w in out.windows(2) {
            let ((pa, a), (pb, b)) = (w[0], w[1]);
            if pa == pb && b > a + 1 {
                let gap: Vec<char> = paras[pa].chars().skip(a + 1).take(b - a - 1).collect();
                if gap.iter().all(|c| c.is_whitespace()) {
                    joined.extend((a + 1..b).map(|c| (pa, c)));
                }
            }
        }
        joined.sort_unstable();
        joined
    }
}

fn para_text(p: &Para) -> String {
    p.pieces.iter().map(|x| x.text.as_str()).collect()
}

/// (paragraph, character) positions of `new` that are not in `old`: everything between the
/// longest common start and end of the two texts.
fn inserted_positions(old: &[String], new: &[String]) -> Vec<(usize, usize)> {
    let a: Vec<char> = old.join("\n").chars().collect();
    let b: Vec<char> = new.join("\n").chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let max_suffix = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(max_suffix).take_while(|(x, y)| x == y).count();
    let (from, to) = (prefix, b.len() - suffix);
    let mut out = Vec::new();
    let (mut pi, mut ci) = (0, 0);
    for (k, c) in b.iter().enumerate() {
        if *c == '\n' {
            pi += 1;
            ci = 0;
            continue;
        }
        if (from..to).contains(&k) {
            out.push((pi, ci));
        }
        ci += 1;
    }
    out
}

/// Whether `family` (`style`) shows `ch`. A font this engine has answers from its own glyphs; for
/// one it lacks, Han, Kana and Hangul count as shown only in fonts named as CJK fonts.
fn shows(fonts: &designcraft_fonts::FontDb, family: &str, style: &str, ch: char) -> bool {
    if fonts.has_family(family) {
        return fonts.face(family, style).glyph_for(ch) != 0;
    }
    !is_cjk(ch) || cjk_family(family)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x3000..=0x30FF | 0x3130..=0x318F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA960..=0xA97F | 0xAC00..=0xD7AF | 0xD7B0..=0xD7FF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

fn cjk_family(family: &str) -> bool {
    if family.chars().any(is_cjk) {
        return true;
    }
    let f = family.to_lowercase();
    [
        "han sans", "han serif", "cjk", "noto sans kr", "noto serif kr", "noto sans jp", "noto serif jp", "noto sans sc",
        "noto sans tc", "malgun", "nanum", "batang", "gulim", "dotum", "gungsuh", "apple sd", "applegothic", "applemyungjo",
        "pretendard", "spoqa", "kozuka", "hiragino", "ryo ", "yu gothic", "yu mincho", "ms gothic", "ms mincho", "meiryo",
        "simsun", "simhei", "pingfang", "myungjo", "mincho", "gothic neo",
    ]
    .iter()
    .any(|k| f.contains(k))
}

/// XML edits putting each `lacking` (paragraph, character) in its own character run set in the
/// fallback font; everything else about the run is kept.
fn run_edits(tree: &Tree, src: &[u8], paras: &[Para], lacking: &[(usize, usize)]) -> Result<Vec<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    let mut edits = Vec::new();
    for (pi, para) in paras.iter().enumerate() {
        for piece in &para.pieces {
            if !piece.plain {
                continue;
            }
            let local: Vec<usize> = lacking.iter().filter(|&&(p, c)| p == pi && c >= piece.start && c < piece.start + piece.len).map(|&(_, c)| c - piece.start).collect();
            if local.is_empty() {
                continue;
            }
            let content = tree.node(piece.node);
            let Some(run) = content.parent.filter(|&r| tree.node(r).local == "CharacterStyleRange") else { continue };
            let run = tree.node(run);
            let open = std::str::from_utf8(&src[run.start..run.open_end]).map_err(|e| Error::Xml(e.to_string()))?;
            let props = run
                .children
                .iter()
                .copied()
                .find(|&k| tree.node(k).local == "Properties")
                .map(|k| std::str::from_utf8(&src[tree.node(k).start..tree.node(k).end]).map(str::to_string))
                .transpose()
                .map_err(|e| Error::Xml(e.to_string()))?
                .unwrap_or_default();
            let fallback_open = with_attr(&without_attr(open, "ParagraphBreakType"), "FontStyle", FALLBACK_STYLE);
            let fallback_props = with_font(&props, FALLBACK_FAMILY);
            // Alternate plain and fallback segments of the piece's text.
            let chars: Vec<char> = piece.text.chars().collect();
            let mut xml = String::new();
            let mut k = 0;
            while k < chars.len() {
                let lack = local.contains(&k);
                let mut e = k;
                while e < chars.len() && local.contains(&e) == lack {
                    e += 1;
                }
                let text: String = chars[k..e].iter().collect();
                if lack {
                    xml.push_str(&format!("</CharacterStyleRange>{fallback_open}{fallback_props}<Content>{}</Content></CharacterStyleRange>{open}{props}", escape_text(&text)));
                } else {
                    xml.push_str(&format!("<Content>{}</Content>", escape_text(&text)));
                }
                k = e;
            }
            edits.push((content.start..content.end, xml.into_bytes()));
        }
    }
    Ok(edits)
}

/// A start tag with attribute `key` set to `value` (replaced or added).
fn with_attr(tag: &str, key: &str, value: &str) -> String {
    let t = without_attr(tag, key);
    let name_end = t.find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(t.len());
    format!("{} {key}=\"{value}\"{}", &t[..name_end], &t[name_end..])
}

/// A start tag without attribute `key`.
fn without_attr(tag: &str, key: &str) -> String {
    let needle = format!(" {key}=\"");
    match tag.find(&needle) {
        Some(at) => {
            let rest = &tag[at + needle.len()..];
            let close = rest.find('"').map_or(tag.len(), |e| at + needle.len() + e + 1);
            format!("{}{}", &tag[..at], &tag[close..])
        }
        None => tag.to_string(),
    }
}

/// A run's `Properties` element (possibly empty) with its applied font set to `family`.
fn with_font(props: &str, family: &str) -> String {
    let font = format!("<AppliedFont type=\"string\">{}</AppliedFont>", escape_text(family));
    if props.trim().is_empty() {
        return format!("<Properties>{font}</Properties>");
    }
    if let (Some(a), Some(b)) = (props.find("<AppliedFont"), props.find("</AppliedFont>")) {
        return format!("{}{font}{}", &props[..a], &props[b + "</AppliedFont>".len()..]);
    }
    if let Some(stripped) = props.strip_suffix("/>") {
        return format!("{stripped}>{font}</Properties>");
    }
    match props.rfind("</Properties>") {
        Some(at) => format!("{}{font}{}", &props[..at], &props[at..]),
        None => format!("<Properties>{font}</Properties>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_what_a_command_inserted() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(inserted_positions(&s(&["Hello world"]), &s(&["Hello 세계 world"])), [(0, 6), (0, 7), (0, 8)]);
        assert_eq!(inserted_positions(&s(&[]), &s(&["가", "b"])), [(0, 0), (1, 0)]);
        assert!(inserted_positions(&s(&["same"]), &s(&["same"])).is_empty());
    }

    #[test]
    fn rewrites_tags_and_properties() {
        assert_eq!(with_attr("<CharacterStyleRange FontStyle=\"Bold\" PointSize=\"12\">", "FontStyle", "Regular"), "<CharacterStyleRange FontStyle=\"Regular\" PointSize=\"12\">");
        assert_eq!(with_attr("<CharacterStyleRange>", "FontStyle", "Regular"), "<CharacterStyleRange FontStyle=\"Regular\">");
        assert_eq!(without_attr("<C ParagraphBreakType=\"NextFrame\" A=\"1\">", "ParagraphBreakType"), "<C A=\"1\">");
        assert_eq!(
            with_font("<Properties><Leading type=\"unit\">12</Leading><AppliedFont type=\"string\">Minion Pro</AppliedFont></Properties>", "X"),
            "<Properties><Leading type=\"unit\">12</Leading><AppliedFont type=\"string\">X</AppliedFont></Properties>"
        );
        assert_eq!(with_font("", "X"), "<Properties><AppliedFont type=\"string\">X</AppliedFont></Properties>");
        assert_eq!(with_font("<Properties/>", "X"), "<Properties><AppliedFont type=\"string\">X</AppliedFont></Properties>");
    }

    #[test]
    fn knows_cjk_fonts_by_name() {
        assert!(cjk_family("Source Han Sans SC") && cjk_family("나눔고딕") && cjk_family("Kozuka Gothic Pr6N"));
        assert!(!cjk_family("Minion Pro") && !cjk_family("Interstate") && !cjk_family("Letter Gothic Std"));
    }
}
