//! PowerPoint text: property inheritance and line layout.
//!
//! Layout rules measured against PowerPoint for Mac 16.109.1
//! (conformance/results/2026-10-10-powerpoint-rules.md):
//! - 100% line spacing is 1.2 x the largest font size on the line, whatever
//!   the font's own metrics; `spcPct` multiplies it.
//! - Baselines are placed on whole points. PowerPoint's own sub-point
//!   rounding differs by up to about 1 pt per line (rule not yet known).
//! - Stored autofit values (`fontScale`, `lnSpcReduction`) are applied as is;
//!   a shrunk font size is rounded to whole points.
//! - Hangul breaks between words only when the run language is exactly
//!   `ko-KR` and `latinLnBrk` is not set. With `latinLnBrk="1"`, `lang="ko"`,
//!   `lang="en-US"` or no language it breaks per character. `eaLnBrk` had no
//!   effect.
//! - A closing mark may hang past the right edge when its run's `lang` or
//!   `altLang` is Korean or Chinese (any of `.,!?:;)]}` and their East Asian
//!   forms) or Japanese (only `、。，．,.`), and `hangingPunct` is not "0":
//!   when no style sets it, it is on. Runs with neither language East Asian
//!   never hang, even with `hangingPunct="1"`.
//! Defaults follow [MS-OI29500] where Office differs from ECMA-376: no
//! kerning without `kern`, 18 pt, `marL`/`indent` 0, `latinLnBrk` false.
//! The first-baseline offset is a two-point fit and is marked provisional.

use std::sync::Arc;

use designcraft_fonts::{FontFace, ShapedGlyph};
use present_render::{GlyphRun, PlacedGlyph, Rgba};
use serde::Serialize;

use super::color::{self, ColorContext};
use super::fonts::{is_east_asian, Fidelity, FontSet};
use super::Part;
use crate::xml::NS_A;

const EMU_PER_PT: f64 = 12_700.0;
/// Line pitch per point of font size at 100% spacing (measured).
const LINE_FACTOR: f64 = 1.2;

#[derive(Debug, Clone, Default)]
pub struct RunProps {
    pub size: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub latin: Option<String>,
    pub ea: Option<String>,
    pub sym: Option<String>,
    pub color: Option<Rgba>,
    pub lang: Option<String>,
    /// `altLang`: the run's alternate (usually East Asian) language.
    pub alt_lang: Option<String>,
    /// Character spacing in points.
    pub spacing: Option<f64>,
    /// Kerning threshold in points (`kern`).
    pub kern: Option<f64>,
    /// Superscript/subscript offset as a fraction of the size.
    pub baseline: Option<f64>,
    /// Any underline style (`u` other than `none`); drawn as single.
    pub underline: Option<bool>,
    /// Any strikethrough (`strike` other than `noStrike`); drawn as single.
    pub strike: Option<bool>,
    /// Text outline (`a:ln`): `Some(None)` when explicitly without one.
    pub outline: Option<Option<(f64, Rgba)>>,
    /// Text shadow (`a:effectLst/a:outerShdw`): `Some(None)` when explicitly without one.
    pub shadow: Option<Option<TextShadow>>,
    /// Text glow (`a:effectLst/a:glow`): radius in points and colour;
    /// `Some(None)` when explicitly without one.
    pub glow: Option<Option<(f64, Rgba)>>,
    /// Capitals (`cap`): `all`, `small` or `none`.
    pub caps: Option<String>,
}

/// An outer text shadow: offset in points, blur radius and colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextShadow {
    pub dx: f64,
    pub dy: f64,
    pub blur: f64,
    pub color: Rgba,
}

#[derive(Debug, Clone, Copy)]
pub enum Spacing {
    Percent(f64),
    Points(f64),
}

#[derive(Debug, Clone)]
pub enum Bullet {
    None,
    Char { ch: String },
    AutoNum { scheme: String, start: u32 },
}

#[derive(Debug, Clone, Default)]
pub struct ParaProps {
    pub align: Option<String>,
    pub mar_l: Option<f64>,
    pub indent: Option<f64>,
    pub line: Option<Spacing>,
    pub before: Option<Spacing>,
    pub after: Option<Spacing>,
    pub bullet: Option<Bullet>,
    pub bullet_font: Option<String>,
    pub bullet_size_pct: Option<f64>,
    pub bullet_color: Option<Rgba>,
    pub latin_ln_brk: Option<bool>,
    pub hanging_punct: Option<bool>,
    pub def_run: RunProps,
}

fn num(v: Option<&str>) -> Option<f64> {
    v.and_then(|s| s.parse::<f64>().ok())
}

fn flag(v: Option<&str>) -> Option<bool> {
    v.map(|s| s == "1" || s == "true")
}

/// Overlays the properties of `a:rPr`/`a:defRPr`/`a:endParaRPr` node.
pub fn merge_run(base: &mut RunProps, part: &Part, node: usize, colors: &ColorContext) {
    let t = &part.tree;
    let n = t.node(node);
    if let Some(v) = num(n.attr("sz")) {
        base.size = Some(v / 100.0);
    }
    if let Some(v) = flag(n.attr("b")) {
        base.bold = Some(v);
    }
    if let Some(v) = flag(n.attr("i")) {
        base.italic = Some(v);
    }
    if let Some(v) = n.attr("lang") {
        base.lang = Some(v.to_owned());
    }
    if let Some(v) = n.attr("altLang") {
        base.alt_lang = Some(v.to_owned());
    }
    if let Some(v) = num(n.attr("spc")) {
        base.spacing = Some(v / 100.0);
    }
    if let Some(v) = num(n.attr("kern")) {
        base.kern = Some(v / 100.0);
    }
    if let Some(v) = num(n.attr("baseline")) {
        base.baseline = Some(v / 100_000.0);
    }
    if let Some(v) = n.attr("cap") {
        base.caps = Some(v.to_owned());
    }
    if let Some(v) = n.attr("u") {
        base.underline = Some(v != "none");
    }
    if let Some(v) = n.attr("strike") {
        base.strike = Some(v != "noStrike");
    }
    for &c in &n.children {
        let ch = t.node(c);
        if ch.ns.as_deref() != Some(NS_A) {
            continue;
        }
        match ch.local.as_str() {
            // An empty typeface keeps the inherited font.
            "latin" => base.latin = ch.attr("typeface").filter(|s| !s.is_empty()).map(str::to_owned).or(base.latin.take()),
            "ea" => base.ea = ch.attr("typeface").filter(|s| !s.is_empty()).map(str::to_owned).or(base.ea.take()),
            "sym" => base.sym = ch.attr("typeface").filter(|s| !s.is_empty()).map(str::to_owned).or(base.sym.take()),
            "solidFill" => base.color = color::read_child(t, c, colors, None),
            "noFill" => base.color = Some(Rgba { r: 0, g: 0, b: 0, a: 0 }),
            // Measured: drawn over the glyph fill at `w` (1 pt when absent).
            "ln" => {
                let width = num(ch.attr("w")).map(|w| w / EMU_PER_PT).unwrap_or(1.0);
                base.outline = Some(t.child(c, NS_A, "solidFill").and_then(|f| color::read_child(t, f, colors, None)).map(|col| (width, col)));
            }
            "effectLst" => {
                base.shadow = Some(t.child(c, NS_A, "outerShdw").and_then(|sh| {
                    let n = t.node(sh);
                    let dist = num(n.attr("dist")).unwrap_or(0.0) / EMU_PER_PT;
                    let dir = (num(n.attr("dir")).unwrap_or(0.0) / 60_000.0).to_radians();
                    let color = color::read_child(t, sh, colors, None)?;
                    Some(TextShadow { dx: dist * dir.cos(), dy: dist * dir.sin(), blur: num(n.attr("blurRad")).unwrap_or(0.0) / EMU_PER_PT, color })
                }));
                base.glow = Some(t.child(c, NS_A, "glow").and_then(|g| {
                    let rad = num(t.node(g).attr("rad")).unwrap_or(0.0) / EMU_PER_PT;
                    (rad > 0.0).then_some(())?;
                    Some((rad, color::read_child(t, g, colors, None)?))
                }));
            }
            _ => {}
        }
    }
}

fn spacing(part: &Part, node: usize) -> Option<Spacing> {
    let t = &part.tree;
    t.node(node).children.iter().find_map(|&c| {
        let n = t.node(c);
        match n.local.as_str() {
            "spcPct" => num(n.attr("val").map(|v| v.trim_end_matches('%'))).map(|v| Spacing::Percent(if v > 1000.0 { v / 100_000.0 } else { v / 100.0 })),
            "spcPts" => num(n.attr("val")).map(|v| Spacing::Points(v / 100.0)),
            _ => None,
        }
    })
}

/// Overlays the properties of an `a:pPr` or `a:lvlNpPr` node.
pub fn merge_para(base: &mut ParaProps, part: &Part, node: usize, colors: &ColorContext) {
    let t = &part.tree;
    let n = t.node(node);
    if let Some(v) = n.attr("algn") {
        base.align = Some(v.to_owned());
    }
    if let Some(v) = num(n.attr("marL")) {
        base.mar_l = Some(v / EMU_PER_PT);
    }
    if let Some(v) = num(n.attr("indent")) {
        base.indent = Some(v / EMU_PER_PT);
    }
    if let Some(v) = flag(n.attr("latinLnBrk")) {
        base.latin_ln_brk = Some(v);
    }
    if let Some(v) = flag(n.attr("hangingPunct")) {
        base.hanging_punct = Some(v);
    }
    for &c in &n.children {
        let ch = t.node(c);
        if ch.ns.as_deref() != Some(NS_A) {
            continue;
        }
        match ch.local.as_str() {
            "lnSpc" => base.line = spacing(part, c),
            "spcBef" => base.before = spacing(part, c),
            "spcAft" => base.after = spacing(part, c),
            "buNone" => base.bullet = Some(Bullet::None),
            "buChar" => base.bullet = Some(Bullet::Char { ch: ch.attr("char").unwrap_or("•").to_owned() }),
            "buAutoNum" => {
                base.bullet = Some(Bullet::AutoNum {
                    scheme: ch.attr("type").unwrap_or("arabicPeriod").to_owned(),
                    start: num(ch.attr("startAt")).map(|v| v as u32).unwrap_or(1),
                })
            }
            "buFont" => base.bullet_font = ch.attr("typeface").map(str::to_owned),
            "buFontTx" => base.bullet_font = None,
            "buSzPct" => base.bullet_size_pct = num(ch.attr("val")).map(|v| v / 100_000.0),
            "buSzTx" => base.bullet_size_pct = None,
            "buClr" => base.bullet_color = color::read_child(t, c, colors, None),
            "buClrTx" => base.bullet_color = None,
            "defRPr" => merge_run(&mut base.def_run, part, c, colors),
            _ => {}
        }
    }
}

/// A text list style source (`a:lstStyle`, `p:titleStyle`, ...).
#[derive(Clone)]
pub struct StyleSource {
    pub part: Arc<Part>,
    pub node: usize,
}

/// Paragraph properties for `level` (0-based) from sources, lowest priority first.
pub fn level_props(sources: &[StyleSource], level: usize, colors: &ColorContext) -> ParaProps {
    let mut props = ParaProps::default();
    let name = format!("lvl{}pPr", level + 1);
    for s in sources {
        if let Some(n) = s.part.tree.child(s.node, NS_A, &name) {
            merge_para(&mut props, &s.part, n, colors);
        }
    }
    props
}

/// Theme font names for `+mj-lt` style references.
#[derive(Debug, Clone, Default)]
pub struct ThemeFonts {
    pub major_latin: String,
    pub minor_latin: String,
    pub major_ea: String,
    pub minor_ea: String,
    /// `a:font script="Hang"` entries, used when `ea` is empty for Korean.
    pub major_hang: Option<String>,
    pub minor_hang: Option<String>,
}

impl ThemeFonts {
    fn resolve(&self, name: &str) -> String {
        // An empty East Asian theme font means the script font: PowerPoint
        // draws `+mj-ea` in the Hangul font even for Latin letters
        // (conformance/results/2026-10-11-text-rules.md).
        let pick = |v: &String, hang: &Option<String>| if v.is_empty() { hang.clone().unwrap_or_default() } else { v.clone() };
        match name {
            "+mj-lt" => self.major_latin.clone(),
            "+mn-lt" => self.minor_latin.clone(),
            "+mj-ea" => pick(&self.major_ea, &self.major_hang),
            "+mn-ea" => pick(&self.minor_ea, &self.minor_hang),
            other => other.to_owned(),
        }
    }
}

/// Body properties (`a:bodyPr`) after inheritance.
#[derive(Debug, Clone)]
pub struct BodyProps {
    pub insets: [f64; 4],
    pub anchor: String,
    pub wrap: bool,
    pub font_scale: f64,
    pub line_reduction: f64,
    /// Text direction (`vert`): `horz`, `vert`, `vert270`, `eaVert`, ...
    pub vert: String,
    /// Round shrunk font sizes to whole points, as PowerPoint draws them.
    pub round_scaled_sizes: bool,
    /// `spcFirstLastPara`: keep the space before the first paragraph and
    /// after the last (dropped otherwise).
    pub spacing_at_edges: bool,
}

impl Default for BodyProps {
    fn default() -> Self {
        Self { insets: [7.2, 3.6, 7.2, 3.6], anchor: "t".into(), wrap: true, font_scale: 1.0, line_reduction: 0.0, vert: "horz".into(), round_scaled_sizes: true, spacing_at_edges: false }
    }
}

pub fn merge_body(base: &mut BodyProps, part: &Part, node: usize) {
    let t = &part.tree;
    let n = t.node(node);
    for (i, k) in ["lIns", "tIns", "rIns", "bIns"].iter().enumerate() {
        if let Some(v) = num(n.attr(k)) {
            base.insets[i] = v / EMU_PER_PT;
        }
    }
    if let Some(v) = flag(n.attr("spcFirstLastPara")) {
        base.spacing_at_edges = v;
    }
    if let Some(v) = n.attr("anchor") {
        base.anchor = v.to_owned();
    }
    if let Some(v) = n.attr("wrap") {
        base.wrap = v != "none";
    }
    if let Some(v) = n.attr("vert") {
        base.vert = v.to_owned();
    }
    if let Some(fit) = t.child(node, NS_A, "normAutofit") {
        base.font_scale = num(t.node(fit).attr("fontScale")).map(|v| v / 100_000.0).unwrap_or(1.0);
        base.line_reduction = num(t.node(fit).attr("lnSpcReduction")).map(|v| v / 100_000.0).unwrap_or(0.0);
    } else if t.child(node, NS_A, "noAutofit").is_some() || t.child(node, NS_A, "spAutoFit").is_some() {
        base.font_scale = 1.0;
        base.line_reduction = 0.0;
    }
}

/// One character with its resolved run.
struct Char {
    c: char,
    run: usize,
    width: f64,
}

struct Shaped {
    face: Arc<FontFace>,
    run: usize,
    glyph: ShapedGlyph,
    char_index: usize,
}

/// A run of text with resolved properties.
#[derive(Clone)]
pub struct TextRun {
    pub text: String,
    pub props: RunProps,
    /// Forced line break (`a:br`).
    pub line_break: bool,
}

#[derive(Clone)]
pub struct Paragraph {
    pub props: ParaProps,
    pub runs: Vec<TextRun>,
    /// Properties for an empty paragraph's height (`a:endParaRPr`).
    pub end_props: RunProps,
    /// Split off by a CR or LF inside the text: PowerPoint starts a new
    /// paragraph there and gives it a bullet even when it is empty.
    pub from_text_break: bool,
}

/// Splits a paragraph at CR and LF characters in its text, as PowerPoint
/// does (measured: each starts a new bulleted paragraph with its spacing).
/// Pieces take the paragraph's properties; an empty piece is sized by the
/// run that held the break.
pub fn split_text_breaks(para: Paragraph) -> Vec<Paragraph> {
    let is_break = |c: char| c == '\n' || c == '\r';
    if !para.runs.iter().any(|r| r.text.contains(is_break)) {
        return vec![para];
    }
    let Paragraph { props, runs, end_props, .. } = para;
    let mut out = Vec::new();
    let mut current: Vec<TextRun> = Vec::new();
    for run in runs {
        let mut pieces = run.text.split(is_break).peekable();
        while let Some(piece) = pieces.next() {
            if !piece.is_empty() || run.line_break {
                current.push(TextRun { text: piece.to_owned(), props: run.props.clone(), line_break: run.line_break });
            }
            if pieces.peek().is_some() {
                out.push(Paragraph { props: props.clone(), runs: std::mem::take(&mut current), end_props: run.props.clone(), from_text_break: true });
            }
        }
    }
    let end_props = match out.last() {
        Some(prev) if current.is_empty() => prev.end_props.clone(),
        _ => end_props,
    };
    out.push(Paragraph { props, runs: current, end_props, from_text_break: true });
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInfo {
    pub text: String,
    /// Baseline from the top of the shape box, points.
    pub baseline: f64,
    pub left: f64,
    pub width: f64,
    /// The break is within 1 pt of fitting another word: PowerPoint itself
    /// may break this line differently.
    pub near_edge: bool,
    /// Largest font size on the line after autofit scaling (points).
    pub size: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontUse {
    pub requested: String,
    pub used: String,
    pub fidelity: Fidelity,
}

pub struct TextLayout {
    pub runs: Vec<GlyphRun>,
    /// Underline and strikethrough bars, in the same coordinates as `runs`.
    pub decorations: Vec<(kurbo::Rect, Rgba)>,
    /// Text shadows, drawn under all of the box's text: glyphs and blur
    /// radius in points.
    pub shadows: Vec<(GlyphRun, f64)>,
    /// Text glows, drawn under the shadows: glyphs, radius in points and
    /// glow colour.
    pub glows: Vec<(GlyphRun, f64, Rgba)>,
    /// For each of `runs`: East Asian glyphs (kept upright in `eaVert` text).
    pub upright: Vec<bool>,
    /// Height of the text from the top of the first line box to the bottom
    /// of the last, excluding insets (points).
    pub content_height: f64,
    /// Height PowerPoint uses when fitting text to the box (autofit), which
    /// differs slightly from the drawn line pitch; see `fit_line_height`.
    pub fit_height: f64,
    pub lines: Vec<LineInfo>,
    pub fonts: Vec<FontUse>,
    pub provisional: Vec<&'static str>,
}

fn record_font(fonts: &mut Vec<FontUse>, requested: &str, used: &str, fidelity: Fidelity) {
    if !fonts.iter().any(|f| f.requested == requested && f.used == used && f.fidelity == fidelity) {
        fonts.push(FontUse { requested: requested.to_owned(), used: used.to_owned(), fidelity });
    }
}

/// Stands for `<a:br>` among a paragraph's characters.
const LINE_BREAK: char = '\n';

fn is_space(c: char) -> bool {
    c == ' ' || c == '\u{3000}' || c == '\t'
}

fn no_break_before(c: char) -> bool {
    ".,!?:;)]}%\u{3001}\u{3002}\u{300D}\u{300F}\u{3009}\u{300B}\u{FF09}\u{FF0C}\u{FF0E}\u{2019}\u{201D}\u{2026}·".contains(c)
}

/// Whether `c`, in a run with languages `langs` (`lang`, `altLang`), may
/// sit past the right edge (see the module comment; measured in PowerPoint).
fn hangs_past_edge(c: char, langs: [Option<&str>; 2], hanging_punct: Option<bool>) -> bool {
    if hanging_punct == Some(false) {
        return false;
    }
    langs.iter().flatten().any(|l| match l.split('-').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "ko" | "zh" => no_break_before(c) && c != '%',
        "ja" => "\u{3001}\u{3002}\u{FF0C}\u{FF0E},.".contains(c),
        _ => false,
    })
}

fn no_break_after(c: char) -> bool {
    "([{\u{300C}\u{300E}\u{3008}\u{300A}\u{FF08}\u{2018}\u{201C}".contains(c)
}

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F)
}

fn auto_number(scheme: &str, n: u32) -> String {
    let alpha = |n: u32, upper: bool| {
        let c = (b'a' + ((n - 1) % 26) as u8) as char;
        if upper { c.to_ascii_uppercase() } else { c }
    };
    match scheme {
        "arabicParenR" => format!("{n})"),
        "arabicParenBoth" => format!("({n})"),
        "arabicPlain" => format!("{n}"),
        "alphaLcPeriod" => format!("{}.", alpha(n, false)),
        "alphaUcPeriod" => format!("{}.", alpha(n, true)),
        "alphaLcParenR" => format!("{})", alpha(n, false)),
        "circleNumDbPlain" | "circleNumWdBlackPlain" if (1..=20).contains(&n) => char::from_u32(0x2460 + n - 1).unwrap_or('?').to_string(),
        _ => format!("{n}."),
    }
}

/// Where a line may start: `result[k]` is true when a break is allowed
/// before character `k`. `korean_words[k]` is true when character `k` keeps
/// Hangul words together (run language `ko-KR` without `latinLnBrk`).
pub fn break_opportunities(text: &[char], korean_words: &[bool]) -> Vec<bool> {
    let n = text.len();
    let mut allowed = vec![false; n + 1];
    for k in 1..n {
        let (a, b) = (text[k - 1], text[k]);
        allowed[k] = if is_space(a) && !is_space(b) {
            true
        } else if is_space(b) || no_break_before(b) || no_break_after(a) {
            false
        } else if a == '-' && b.is_alphanumeric() {
            true
        } else if is_hangul(a) && is_hangul(b) {
            !(korean_words[k - 1] && korean_words[k])
        } else {
            (is_east_asian(a) && !is_hangul(a))
                || (is_east_asian(b) && !is_hangul(b))
                || (is_hangul(a) && !korean_words[k - 1])
                || (is_hangul(b) && !korean_words[k])
        };
    }
    allowed
}

/// Height of one line at 100% spacing when PowerPoint sizes a box to its
/// text. Measured from PowerPoint's own auto-size results: font-independent
/// (Malgun Gothic, Calibri, Noto Sans KR, Pretendard) and linear in size,
/// within 0.04 pt at 12, 24 and 36 pt
/// (conformance/results/2026-10-11-autofit.md).
pub fn fit_line_height(size: f64) -> f64 {
    1.20875 * size + 0.105
}

/// Lays out paragraphs in a box of `width`×`height` points.
pub fn layout(paragraphs: &[Paragraph], body: &BodyProps, width: f64, height: f64, fonts: &FontSet, theme: &ThemeFonts) -> TextLayout {
    let shown;
    let paragraphs = if paragraphs.iter().any(|p| p.runs.iter().any(|r| needs_display_form(&r.props))) {
        shown = paragraphs.iter().map(display_form).collect::<Vec<_>>();
        &shown[..]
    } else {
        paragraphs
    };
    let mut out = TextLayout { runs: Vec::new(), decorations: Vec::new(), shadows: Vec::new(), glows: Vec::new(), upright: Vec::new(), content_height: 0.0, fit_height: 0.0, lines: Vec::new(), fonts: Vec::new(), provisional: Vec::new() };
    let mut last_size = 0.0;
    let avail = (width - body.insets[0] - body.insets[2]).max(0.0);
    let mut auto_counter: Vec<(String, u32)> = Vec::new();
    let mut y = 0.0;
    let mut first_line_of_box = true;
    let mut placed: Vec<(f64, GlyphRun, bool)> = Vec::new();
    let mut placed_shadows: Vec<(f64, GlyphRun, f64)> = Vec::new();
    let mut placed_glows: Vec<(f64, GlyphRun, f64, Rgba)> = Vec::new();
    // Underline/strikethrough bars: line baseline, x range, top offset from
    // the (whole-point) baseline, thickness, colour.
    let mut bars: Vec<(f64, f64, f64, f64, f64, Rgba)> = Vec::new();
    let mut infos: Vec<LineInfo> = Vec::new();

    let para_count = paragraphs.len();
    for (pi, para) in paragraphs.iter().enumerate() {
        let p = &para.props;
        let scale = body.font_scale;
        // A shrunk size is rounded to whole points (measured: 24 pt at 85%
        // is drawn at 20 pt, 18 pt at 92.5% at 17 pt).
        let size_of = |r: &RunProps| {
            let s = r.size.unwrap_or(18.0) * scale;
            if scale < 1.0 && body.round_scaled_sizes { s.round().max(1.0) } else { s }
        };

        // Characters with run indexes; empty paragraphs keep their end size.
        // A line break is a zero-width LINE_BREAK ending its line, so
        // consecutive breaks leave empty lines sized by the break's run.
        let mut runs: Vec<&RunProps> = Vec::new();
        let mut chars: Vec<Char> = Vec::new();
        for r in &para.runs {
            runs.push(&r.props);
            let ri = runs.len() - 1;
            if r.line_break {
                chars.push(Char { c: LINE_BREAK, run: ri, width: 0.0 });
                continue;
            }
            chars.extend(r.text.chars().map(|c| Char { c, run: ri, width: 0.0 }));
        }

        // Shape font segments.
        let mut shaped: Vec<Shaped> = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i].c == LINE_BREAK {
                i += 1;
                continue;
            }
            let run = runs[chars[i].run];
            let bold = run.bold.unwrap_or(false);
            let italic = run.italic.unwrap_or(false);
            let ea = is_east_asian(chars[i].c);
            let requested = if ea {
                theme.resolve(run.ea.as_deref().filter(|s| !s.is_empty()).unwrap_or("+mn-ea"))
            } else {
                theme.resolve(run.latin.as_deref().unwrap_or("+mn-lt"))
            };
            let requested = if requested.is_empty() && ea { theme.resolve("+mn-lt") } else { requested };
            let (mut face, mut fidelity) = match fonts.family_face(&requested, bold, italic) {
                Some((f, fid)) => (Some(f), fid),
                None => (None, Fidelity::Substituted),
            };
            let primary = face.clone();
            if face.as_ref().is_none_or(|f| !f.covers(chars[i].c)) {
                let family_found = face.is_some();
                // An East Asian character the East Asian font lacks is drawn
                // in the run's Latin font when that has it (measured: Hangul
                // in an Arial East Asian font with a NanumSquareRound Latin
                // font is drawn in NanumSquareRound; with an Arial Latin font
                // in Malgun Gothic), else in a gothic or serif face as the
                // run's font is sans serif or not.
                let latin = if ea { fonts.family_face(&theme.resolve(run.latin.as_deref().unwrap_or("+mn-lt")), bold, italic).map(|(f, _)| f).filter(|f| f.covers(chars[i].c)) } else { None };
                let sans = face.as_ref().is_none_or(|f| super::fonts::is_sans_serif(f));
                match latin.or_else(|| fonts.substitute_in_style(chars[i].c, bold, italic, sans)) {
                    Some(f) => {
                        face = Some(f);
                        if family_found {
                            fidelity = Fidelity::GlyphFallback;
                        }
                    }
                    None => fidelity = Fidelity::MissingGlyph,
                }
            }
            let Some(face) = face.or_else(|| fonts.substitute_for('A', bold, italic)) else {
                i += 1;
                continue;
            };
            // Extend the segment while run, script class and face stay the
            // same. Spaces are not East Asian: PowerPoint sets a space between
            // Hangul words in the Latin font (measured: Calibri's 0.227 em,
            // not Malgun Gothic's 0.375 em).
            let mut j = i + 1;
            // A fallback face covers only what the authored face cannot draw.
            let fallback = primary.as_ref().is_some_and(|p| !Arc::ptr_eq(p, &face));
            while j < chars.len() && chars[j].run == chars[i].run && chars[j].c != LINE_BREAK && is_east_asian(chars[j].c) == ea && face.covers(chars[j].c) && !(fallback && primary.as_ref().is_some_and(|p| p.covers(chars[j].c))) {
                j += 1;
            }
            record_font(&mut out.fonts, &requested, &face.family, fidelity);
            let text: String = chars[i..j].iter().map(|c| c.c).collect();
            let size = size_of(run);
            let kern_on = run.kern.is_some_and(|k| size >= k);
            let features: Vec<_> = if kern_on { Vec::new() } else { designcraft_fonts::feature("-kern").into_iter().collect() };
            let offsets: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
            for g in designcraft_fonts::shape(&face, &text, &features, |c| c) {
                let ci = offsets.iter().rposition(|&b| b <= g.cluster as usize).unwrap_or(0);
                shaped.push(Shaped { face: face.clone(), run: chars[i].run, glyph: g, char_index: i + ci });
            }
            i = j;
        }
        for s in &shaped {
            let size = size_of(runs[s.run]);
            chars[s.char_index].width += s.glyph.x_advance as f64 * size / s.face.units_per_em().max(1.0);
        }
        for ch in chars.iter_mut() {
            ch.width += runs[ch.run].spacing.unwrap_or(0.0);
        }

        // Bullet.
        let first_props = runs.first().copied().unwrap_or(&para.end_props);
        let mut bullet_text = None;
        match &p.bullet {
            Some(Bullet::Char { ch }) if !chars.is_empty() || para.from_text_break => bullet_text = Some(ch.clone()),
            Some(Bullet::AutoNum { scheme, start }) if !chars.is_empty() || para.from_text_break => {
                let counter = match auto_counter.iter_mut().find(|(s, _)| s == scheme) {
                    Some(c) => {
                        c.1 += 1;
                        c.1
                    }
                    None => {
                        auto_counter.push((scheme.clone(), *start));
                        *start
                    }
                };
                bullet_text = Some(auto_number(scheme, counter));
            }
            _ => auto_counter.clear(),
        }

        let mar_l = p.mar_l.unwrap_or(0.0);
        let indent = p.indent.unwrap_or(0.0);
        // The bullet's glyphs (x from 0) and width.
        let bullet: Option<(GlyphRun, f64)> = bullet_text.as_ref().and_then(|bt| {
            let bsize = size_of(first_props) * p.bullet_size_pct.unwrap_or(1.0);
            let family = p.bullet_font.clone().unwrap_or_else(|| theme.resolve(first_props.latin.as_deref().unwrap_or("+mn-lt")));
            let bch = bt.chars().next().unwrap_or('•');
            let face = fonts
                .family_face(&family, false, false)
                .map(|(f, _)| f)
                .filter(|f| bt.chars().all(|c| f.covers(c)) || f.covers(char::from_u32(0xF000 + (bch as u32 & 0xFF)).unwrap_or(bch)))
                .or_else(|| fonts.substitute_for(bch, false, false))?;
            let k = bsize / face.units_per_em().max(1.0);
            // Symbol fonts map their glyphs at U+F0xx.
            let text: String = if face.covers(bch) { bt.clone() } else { bt.chars().map(|c| char::from_u32(0xF000 + (c as u32 & 0xFF)).unwrap_or(c)).collect() };
            let mut bx = 0.0;
            let glyphs: Vec<PlacedGlyph> = designcraft_fonts::shape(&face, &text, &[], |c| c)
                .into_iter()
                .map(|g| {
                    let pg = PlacedGlyph { gid: g.gid, x: bx + g.x_offset as f64 * k, y: 0.0 };
                    bx += g.x_advance as f64 * k;
                    pg
                })
                .collect();
            let color = p.bullet_color.or(first_props.color).unwrap_or(Rgba::BLACK);
            Some((GlyphRun { face, size: bsize, color, glyphs, skew: 0.0, embolden: 0.0, outline: None }, bx))
        });
        // Where the first line's text starts (from the left inset): after a
        // hanging bullet at the left margin, otherwise right after the bullet.
        let bullet_left = mar_l + indent;
        let first_text = match &bullet {
            Some((_, bw)) if indent < 0.0 => mar_l.max(bullet_left + bw),
            Some((_, bw)) => bullet_left + bw,
            None => bullet_left.max(0.0),
        };
        let latin_ln_brk = p.latin_ln_brk.unwrap_or(false);
        // A hanging closing mark may sit past the right edge: the line fits
        // when the text before it fits; otherwise the mark must fit.
        let hangs = |k: usize| {
            let r = runs[chars[k].run];
            hangs_past_edge(chars[k].c, [r.lang.as_deref(), r.alt_lang.as_deref()], p.hanging_punct)
        };
        let korean_words = |k: usize| !latin_ln_brk && runs[chars[k].run].lang.as_deref().is_some_and(|l| l.eq_ignore_ascii_case("ko-KR"));

        let text: Vec<char> = chars.iter().map(|c| c.c).collect();
        let word_mode: Vec<bool> = (0..chars.len()).map(korean_words).collect();
        let n = chars.len();
        let allowed = break_opportunities(&text, &word_mode);

        // Greedy fill.
        let mut lines: Vec<(usize, usize, bool)> = Vec::new(); // start, end, near_edge
        let mut start = 0;
        while start < n || (start == 0 && n == 0) {
            if n == 0 {
                lines.push((0, 0, false));
                break;
            }
            let line_avail = if lines.is_empty() { avail - first_text } else { avail - mar_l };
            let line_avail = if body.wrap { line_avail.max(1.0) } else { f64::INFINITY };
            let mut w = 0.0;
            let mut end = start;
            let mut last_ok: Option<usize> = None;
            let mut near_edge = false;
            while end < n {
                if end > start && chars[end - 1].c == LINE_BREAK {
                    break;
                }
                if end > start && allowed[end] {
                    last_ok = Some(end);
                }
                let cw = chars[end].width;
                if w + cw > line_avail && !is_space(chars[end].c) && chars[end].c != LINE_BREAK && !hangs(end) && end > start {
                    break;
                }
                w += cw;
                end += 1;
            }
            if end < n && chars[end - 1].c != LINE_BREAK {
                // Overflowed: break at the last opportunity, else mid-word.
                if let Some(b) = last_ok.filter(|&b| b > start) {
                    // The rest of the would-be word: how much it missed by.
                    let mut word_end = end;
                    while word_end < n && !allowed[word_end] {
                        word_end += 1;
                    }
                    let fitted: f64 = chars[start..b].iter().map(|c| c.width).sum::<f64>();
                    let word: f64 = chars[b..word_end].iter().map(|c| c.width).sum::<f64>();
                    let trailing: f64 = chars[start..b].iter().rev().take_while(|c| is_space(c.c)).map(|c| c.width).sum();
                    near_edge = fitted - trailing + word - line_avail < 1.0;
                    end = b;
                }
            }
            lines.push((start, end, near_edge));
            start = end;
            if start == 0 {
                break;
            }
        }
        // A break at the end of the paragraph is followed by an empty line.
        if n > 0 && chars[n - 1].c == LINE_BREAK {
            lines.push((n, n, false));
        }

        // Vertical placement.
        let spacing_pts = |s: Option<Spacing>, size: f64| match s {
            Some(Spacing::Points(v)) => v,
            Some(Spacing::Percent(v)) => v * LINE_FACTOR * size,
            None => 0.0,
        };
        let para_size = if n == 0 { size_of(&para.end_props) } else { runs.iter().map(|r| size_of(r)).fold(0.0, f64::max) };
        // PowerPoint drops the space before the first paragraph and after
        // the last, for placement and anchoring alike, unless the body says
        // spcFirstLastPara (conformance/results/2026-10-11-text-rules.md).
        if pi > 0 || body.spacing_at_edges {
            y += spacing_pts(p.before, para_size);
            out.fit_height += spacing_pts(p.before, para_size);
        }
        for (li, &(s, e, near_edge)) in lines.iter().enumerate() {
            let max_size = if s == e { if s == n && n > 0 { size_of(&para.end_props) } else { para_size } } else { chars[s..e].iter().map(|c| size_of(runs[c.run])).fold(0.0, f64::max) };
            let lh = match p.line {
                Some(Spacing::Points(v)) => v,
                Some(Spacing::Percent(v)) => LINE_FACTOR * max_size * (v - body.line_reduction).max(0.0),
                None => LINE_FACTOR * max_size * (1.0 - body.line_reduction),
            };
            let baseline = if first_line_of_box {
                first_line_of_box = false;
                // Two-point fit (100% and 150%): 0.96 s at 100%, plus ~0.62 of the extra pitch.
                if !out.provisional.contains(&"firstBaseline") {
                    out.provisional.push("firstBaseline");
                }
                y + 0.96 * max_size + 0.617 * (lh - LINE_FACTOR * max_size)
            } else {
                y + lh
            };
            y = baseline;
            last_size = max_size;
            // Horizontal placement.
            let content_end = (s..e).rev().find(|&k| !is_space(chars[k].c) && chars[k].c != LINE_BREAK).map(|k| k + 1).unwrap_or(s);
            let line_w: f64 = chars[s..content_end].iter().map(|c| c.width).sum();
            let align = p.align.as_deref().unwrap_or("l");
            // The first line's bullet and text align as one block from the
            // bullet's position; later lines from the left margin.
            let (block_left, text_left) = if li == 0 { (if bullet.is_some() { bullet_left } else { first_text }, first_text) } else { (mar_l, mar_l) };
            let block_w = (text_left - block_left) + line_w;
            let room = avail - block_left;
            let shift = match align {
                "ctr" if body.wrap || room.is_finite() => (room - block_w) / 2.0,
                "r" => room - block_w,
                _ => 0.0,
            };
            let x0 = body.insets[0] + text_left;
            let mut bullet_run = None;
            if li == 0 {
                if let Some((run, _)) = &bullet {
                    let mut run = run.clone();
                    for g in run.glyphs.iter_mut() {
                        g.x += body.insets[0] + block_left + shift;
                    }
                    bullet_run = Some(run);
                }
            }
            let x_start = x0 + shift;
            // Glyph runs for this line, split by face/run.
            let mut x = x_start;
            let mut char_x = vec![0.0; e.saturating_sub(s) + 1];
            for (k, slot) in char_x.iter_mut().enumerate() {
                *slot = x;
                if s + k < e {
                    x += chars[s + k].width;
                }
            }
            let mut line_runs: Vec<GlyphRun> = Vec::new();
            let mut line_shadows: Vec<(Option<TextShadow>, Option<(f64, Rgba)>)> = Vec::new();
            let mut line_upright: Vec<bool> = Vec::new();
            // Shaped glyphs are in character order, so the glyphs of one
            // character follow each other and advance from its start.
            let (mut cur_char, mut within) = (usize::MAX, 0.0);
            for g in shaped.iter().filter(|g| g.char_index >= s && g.char_index < content_end) {
                let size = size_of(runs[g.run]);
                let k = size / g.face.units_per_em().max(1.0);
                if g.char_index != cur_char {
                    (cur_char, within) = (g.char_index, 0.0);
                }
                let gx = char_x[g.char_index - s] + within + g.glyph.x_offset as f64 * k;
                within += g.glyph.x_advance as f64 * k;
                let rise = runs[g.run].baseline.unwrap_or(0.0) * size;
                let color = runs[g.run].color.unwrap_or(Rgba::BLACK);
                let pg = PlacedGlyph { gid: g.glyph.gid, x: gx, y: -rise - g.glyph.y_offset as f64 * k };
                // Styles the face lacks are synthesized as PowerPoint draws
                // them: italic as a 0.3398 shear, bold as a 0.023 em stroke.
                let run = runs[g.run];
                let skew = if run.italic.unwrap_or(false) && !g.face.italic { SYNTHETIC_ITALIC_SKEW } else { 0.0 };
                let embolden = if run.bold.unwrap_or(false) && g.face.weight < 600.0 { SYNTHETIC_BOLD_STROKE * size } else { 0.0 };
                let outline = run.outline.flatten();
                let shadow = (run.shadow.flatten(), run.glow.flatten());
                let ea = is_east_asian(chars[g.char_index].c);
                match line_runs.last_mut() {
                    Some(r) if Arc::ptr_eq(&r.face, &g.face) && r.size == size && r.color == color && r.skew == skew && r.embolden == embolden && r.outline == outline && line_shadows.last() == Some(&shadow) && line_upright.last() == Some(&ea) => r.glyphs.push(pg),
                    _ => {
                        line_runs.push(GlyphRun { face: g.face.clone(), size, color, glyphs: vec![pg], skew, embolden, outline });
                        line_shadows.push(shadow);
                        line_upright.push(ea);
                    }
                }
            }
            line_bars(&mut bars, baseline, &chars[s..content_end], &char_x, &shaped, s, &runs, &size_of);
            if let Some(b) = bullet_run {
                placed.push((baseline, b, false));
            }
            // Shadows: the glyphs in the shadow colour, offset and blurred.
            for (r, (sh, glow)) in line_runs.iter().zip(&line_shadows) {
                if let Some((rad, color)) = *glow {
                    placed_glows.push((baseline, r.clone(), rad, color));
                }
                let Some(sh) = sh else { continue };
                let mut copy = r.clone();
                copy.color = sh.color;
                copy.outline = None;
                for g in copy.glyphs.iter_mut() {
                    g.x += sh.dx;
                    g.y += sh.dy;
                }
                placed_shadows.push((baseline, copy, sh.blur));
            }
            for (r, ea) in line_runs.into_iter().zip(line_upright) {
                placed.push((baseline, r, ea));
            }
            infos.push(LineInfo {
                text: chars[s..e].iter().map(|c| c.c).filter(|&c| c != LINE_BREAK).collect(),
                baseline,
                left: x_start,
                width: line_w,
                near_edge,
                size: max_size,
            });
            out.fit_height += match p.line {
                Some(Spacing::Points(v)) => v,
                Some(Spacing::Percent(v)) => fit_line_height(max_size) * (v - body.line_reduction).max(0.0),
                None => fit_line_height(max_size) * (1.0 - body.line_reduction),
            };
        }
        if pi + 1 < para_count || body.spacing_at_edges {
            y += spacing_pts(p.after, para_size);
            out.fit_height += spacing_pts(p.after, para_size);
        }
    }

    // Vertical anchor: whole points, as PowerPoint places baselines. The
    // block ends below the last baseline by the rest of its line box
    // (1.2 s line pitch minus the 0.96 s first-baseline drop).
    let block = y + (LINE_FACTOR - 0.96) * last_size;
    out.content_height = block;
    let inner = height - body.insets[1] - body.insets[3];
    let top = body.insets[1]
        + match body.anchor.as_str() {
            "ctr" => (inner - block) / 2.0,
            "b" => inner - block,
            _ => 0.0,
        };
    for (baseline, mut run, ea) in placed {
        let b = (top + baseline).round();
        for g in run.glyphs.iter_mut() {
            g.y += b;
        }
        out.runs.push(run);
        out.upright.push(ea);
    }
    for (baseline, mut run, blur) in placed_shadows {
        let b = (top + baseline).round();
        for g in run.glyphs.iter_mut() {
            g.y += b;
        }
        out.shadows.push((run, blur));
    }
    for (baseline, mut run, rad, color) in placed_glows {
        let b = (top + baseline).round();
        for g in run.glyphs.iter_mut() {
            g.y += b;
        }
        out.glows.push((run, rad, color));
    }
    for mut info in infos {
        info.baseline = (top + info.baseline).round();
        out.lines.push(info);
    }
    for (baseline, x0, x1, offset, thickness, color) in bars {
        let y = (top + baseline).round() + offset;
        out.decorations.push((kurbo::Rect::new(x0.round(), y, x1.round(), y + thickness), color));
    }
    out
}

fn needs_display_form(r: &RunProps) -> bool {
    r.baseline.is_some_and(|b| b != 0.0) || matches!(r.caps.as_deref(), Some("all" | "small"))
}

/// The paragraph as PowerPoint draws it (measured, 2026-10-11-text-rules.md
/// section 8): superscript and subscript at two thirds of the size, rounded
/// to whole points, raised or lowered by the percentage of the original size;
/// all capitals as upper case; small capitals as upper case at 0.8 of the size
/// for the letters that were lower case.
fn display_form(p: &Paragraph) -> Paragraph {
    let mut runs = Vec::new();
    for r in &p.runs {
        if !needs_display_form(&r.props) || r.line_break {
            runs.push(r.clone());
            continue;
        }
        let mut props = r.props.clone();
        let size = props.size.unwrap_or(18.0);
        if let Some(b) = props.baseline.filter(|b| *b != 0.0) {
            let small = (size * 2.0 / 3.0).round().max(1.0);
            props.size = Some(small);
            props.baseline = Some(b * size / small);
        }
        match props.caps.take().as_deref() {
            Some("all") => runs.push(TextRun { text: r.text.chars().flat_map(char::to_uppercase).collect(), props, line_break: false }),
            Some("small") => {
                // Split into stretches of lower-case and other characters.
                let mut current = String::new();
                let mut lower = None;
                let flush = |runs: &mut Vec<TextRun>, text: &mut String, lower: bool| {
                    if text.is_empty() {
                        return;
                    }
                    let mut props = props.clone();
                    if lower {
                        props.size = Some(props.size.unwrap_or(18.0) * 0.8);
                    }
                    runs.push(TextRun { text: std::mem::take(text), props, line_break: false });
                };
                for c in r.text.chars() {
                    let is_lower = c.is_lowercase();
                    if lower.is_some_and(|l| l != is_lower) {
                        flush(&mut runs, &mut current, lower.unwrap_or(false));
                    }
                    lower = Some(is_lower);
                    current.extend(c.to_uppercase());
                }
                flush(&mut runs, &mut current, lower.unwrap_or(false));
            }
            _ => runs.push(TextRun { text: r.text.clone(), props, line_break: false }),
        }
    }
    Paragraph { runs, ..p.clone() }
}

const SYNTHETIC_ITALIC_SKEW: f64 = 0.3398;
const SYNTHETIC_BOLD_STROKE: f64 = 0.023;

/// Underline and strikethrough bars of one line (`chars` up to its last
/// visible character, positioned at `char_x`). Measured from PowerPoint for
/// Mac (conformance/results/2026-10-11-text-rules.md): an underline is one
/// bar per stretch of underlined text, size/10 below the baseline, as thick
/// as the first character's font says; a strikethrough follows each font's
/// own strikeout position and thickness. Both snap to whole points.
#[allow(clippy::too_many_arguments)]
fn line_bars(bars: &mut Vec<(f64, f64, f64, f64, f64, Rgba)>, baseline: f64, chars: &[Char], char_x: &[f64], shaped: &[Shaped], first: usize, runs: &[&RunProps], size_of: &dyn Fn(&RunProps) -> f64) {
    let face_of = |k: usize| shaped.iter().find(|g| g.char_index == first + k).map(|g| g.face.clone());
    let n = chars.len();
    for strike in [false, true] {
        let on = |k: usize| {
            let r = runs[chars[k].run];
            if strike { r.strike.unwrap_or(false) } else { r.underline.unwrap_or(false) }
        };
        let mut k = 0;
        while k < n {
            if !on(k) {
                k += 1;
                continue;
            }
            let (start, color, face) = (k, runs[chars[k].run].color.unwrap_or(Rgba::BLACK), face_of(k));
            let mut size: f64 = 0.0;
            while k < n && on(k) && runs[chars[k].run].color.unwrap_or(Rgba::BLACK) == color {
                // A strikethrough breaks where the font changes.
                if strike && k > start && (chars[k].run != chars[start].run || !match (face_of(k), &face) {
                    (Some(a), Some(b)) => Arc::ptr_eq(&a, b),
                    _ => true,
                }) {
                    break;
                }
                size = size.max(size_of(runs[chars[k].run]));
                k += 1;
            }
            let mut end = k;
            while !strike && end > start && is_space(chars[end - 1].c) {
                end -= 1;
            }
            let Some(face) = face.filter(|_| end > start) else { continue };
            let (underline, strike_pos, strike_size) = super::fonts::decoration_metrics(&face);
            let (offset, thickness) = if strike {
                (-(strike_pos * size).round(), (strike_size * size).round().max(1.0))
            } else {
                ((size / 10.0).round(), (underline * size).round().max(1.0))
            };
            bars.push((baseline, char_x[start], char_x[end], offset, thickness, color));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starts(text: &str, korean_words: bool) -> Vec<usize> {
        let chars: Vec<char> = text.chars().collect();
        let allowed = break_opportunities(&chars, &vec![korean_words; chars.len()]);
        (0..chars.len()).filter(|&k| allowed[k]).collect()
    }

    fn paragraph(runs: Vec<TextRun>, props: ParaProps) -> Paragraph {
        Paragraph { props, runs, end_props: RunProps { size: Some(10.0), ..Default::default() }, from_text_break: false }
    }

    fn run(text: &str, size: f64) -> TextRun {
        TextRun { text: text.into(), props: RunProps { size: Some(size), ..Default::default() }, line_break: false }
    }

    fn br(size: f64) -> TextRun {
        TextRun { text: String::new(), props: RunProps { size: Some(size), ..Default::default() }, line_break: true }
    }

    fn baselines(paras: &[Paragraph], anchor: &str) -> Vec<(String, f64)> {
        let body = BodyProps { insets: [0.0; 4], anchor: anchor.into(), ..Default::default() };
        layout(paras, &body, 400.0, 300.0, &FontSet::empty(), &ThemeFonts::default()).lines.into_iter().map(|l| (l.text, l.baseline)).collect()
    }

    #[test]
    fn consecutive_line_breaks_leave_empty_lines() {
        let lines = baselines(&[paragraph(vec![run("a", 20.0), br(20.0), br(20.0), run("b", 20.0), br(20.0)], ParaProps::default())], "t");
        let texts: Vec<&str> = lines.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(texts, ["a", "", "b", ""]);
        // Each break line is a full 24 pt (1.2 x 20 pt) line; the trailing empty line uses the end size.
        assert_eq!(lines[2].1 - lines[0].1, 48.0);
        assert_eq!(lines[3].1 - lines[2].1, 12.0);
    }

    #[test]
    fn line_break_after_a_full_line_adds_no_empty_line() {
        // Without fonts, letter spacing alone gives each character 10 pt:
        // "a " is 20 pt wide in a 15 pt box, so the break comes after a full line.
        let body = BodyProps { insets: [0.0; 4], ..Default::default() };
        let spaced = |mut r: TextRun| {
            r.props.spacing = Some(10.0);
            r
        };
        let para = paragraph(vec![spaced(run("a ", 20.0)), spaced(br(20.0)), spaced(run("b", 20.0))], ParaProps::default());
        let lines = layout(&[para], &body, 15.0, 300.0, &FontSet::empty(), &ThemeFonts::default()).lines;
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["a ", "b"]);
    }

    #[test]
    fn closing_mark_hangs_by_run_language_unless_turned_off() {
        // Ten 10 pt characters in a 90 pt box: nine fill it, the tenth overflows.
        let body = BodyProps { insets: [0.0; 4], ..Default::default() };
        let lines = |text: &str, lang: Option<&str>, hanging: Option<bool>| {
            let mut r = run(text, 20.0);
            r.props.spacing = Some(10.0);
            r.props.lang = lang.map(str::to_owned);
            let props = ParaProps { hanging_punct: hanging, ..Default::default() };
            let para = Paragraph { props, runs: vec![r], end_props: RunProps::default(), from_text_break: false };
            layout(&[para], &body, 90.0, 300.0, &FontSet::empty(), &ThemeFonts::default()).lines.len()
        };
        assert_eq!(lines("abcdefghi)", Some("ko-KR"), None), 1, "unset is on");
        assert_eq!(lines("abcdefghi)", Some("ko-KR"), Some(true)), 1);
        assert_eq!(lines("abcdefghi)", Some("ko-KR"), Some(false)), 2);
        assert_eq!(lines("abcdefghi)", Some("zh-TW"), None), 1);
        assert_eq!(lines("abcdefghi)", Some("ja-JP"), None), 2, "Japanese hangs only commas and full stops");
        assert_eq!(lines("abcdefghi\u{3002}", Some("ja-JP"), None), 1);
        assert_eq!(lines("abcdefghi)", Some("en-US"), Some(true)), 2, "Latin languages never hang");
        assert_eq!(lines("abcdefghi)", None, Some(true)), 2);
        let alt = |alt: &str| {
            let mut r = run("abcdefghi)", 20.0);
            r.props.spacing = Some(10.0);
            r.props.lang = Some("en-US".into());
            r.props.alt_lang = Some(alt.into());
            let para = Paragraph { props: ParaProps::default(), runs: vec![r], end_props: RunProps::default(), from_text_break: false };
            layout(&[para], &body, 90.0, 300.0, &FontSet::empty(), &ThemeFonts::default()).lines.len()
        };
        assert_eq!(alt("ko-KR"), 1, "an East Asian altLang hangs too");
        assert_eq!(alt("en-US"), 2);
    }

    #[test]
    fn space_before_first_and_after_last_paragraph_is_ignored() {
        let before = ParaProps { before: Some(Spacing::Points(30.0)), ..Default::default() };
        let after = ParaProps { after: Some(Spacing::Points(30.0)), ..Default::default() };
        let plain = [paragraph(vec![run("a", 20.0)], ParaProps::default()), paragraph(vec![run("b", 20.0)], ParaProps::default())];
        let edges = [paragraph(vec![run("a", 20.0)], before.clone()), paragraph(vec![run("b", 20.0)], after.clone())];
        let inner = [paragraph(vec![run("a", 20.0)], after), paragraph(vec![run("b", 20.0)], before)];
        for anchor in ["t", "ctr", "b"] {
            assert_eq!(baselines(&edges, anchor), baselines(&plain, anchor), "{anchor}");
            let (p, i) = (baselines(&plain, anchor), baselines(&inner, anchor));
            assert_eq!(i[1].1 - i[0].1, p[1].1 - p[0].1 + 60.0, "{anchor}: inner spacing applies");
        }
    }

    #[test]
    fn line_feed_in_text_starts_a_bulleted_paragraph() {
        let props = ParaProps { bullet: Some(Bullet::Char { ch: "•".into() }), ..Default::default() };
        let pieces = split_text_breaks(paragraph(vec![run("a\nb\n", 20.0)], props));
        let texts: Vec<String> = pieces.iter().map(|p| p.runs.iter().map(|r| r.text.as_str()).collect()).collect();
        assert_eq!(texts, ["a", "b", ""]);
        assert!(pieces.iter().all(|p| p.from_text_break));
        assert_eq!(pieces[2].end_props.size, Some(20.0), "an empty piece is sized by the run that held the break");
        let untouched = split_text_breaks(paragraph(vec![run("a", 20.0)], ParaProps::default()));
        assert!(untouched.len() == 1 && !untouched[0].from_text_break);
    }

    #[test]
    fn scripts_and_capitals_are_drawn_as_powerpoint_does() {
        let mut sup = run("x", 40.0);
        sup.props.baseline = Some(0.3);
        let mut small = run("aB가", 40.0);
        small.props.caps = Some("small".into());
        let shown = display_form(&paragraph(vec![sup, small], ParaProps::default()));
        let r = &shown.runs;
        assert_eq!((r[0].props.size, r[0].props.baseline.map(|b| (b * 27.0 * 100.0).round() / 100.0)), (Some(27.0), Some(12.0)), "2/3 size, raised 30% of 40 pt");
        assert_eq!(r[1].text, "A");
        assert_eq!(r[1].props.size, Some(32.0));
        assert_eq!((r[2].text.as_str(), r[2].props.size), ("B가", Some(40.0)));
    }

    #[test]
    fn korean_words_break_only_after_spaces() {
        // "모든 국민은": only before 국.
        assert_eq!(starts("모든 국민은", true), vec![3]);
    }

    #[test]
    fn korean_characters_break_between_syllables() {
        assert_eq!(starts("모든 국민은", false), vec![1, 3, 4, 5]);
    }

    #[test]
    fn latin_words_never_break_inside() {
        assert_eq!(starts("Internationalization ok", false), vec![21]);
    }

    #[test]
    fn closing_punctuation_stays_with_the_previous_character() {
        // No break before '.' or ',' even in character mode.
        assert_eq!(starts("가나.다", false), vec![1, 3]);
    }
}
