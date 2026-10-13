//! Character and paragraph formatting of a shape's text: every run, line
//! break and field, or those of one paragraph.

use serde_json::{json, Value};

use super::shape::{commit, parse_color, solid_fill, target, Target};
use super::xmledit::{drawing_prefix, rebuild, Change};
use crate::xml::{NS_A, NS_P};
use crate::{Error, Presentation};

/// Children of a run's properties (`a:rPr`, `a:endParaRPr`) in schema order.
const RPR_ORDER: &[&str] = &[
    "ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin", "ea", "cs", "sym",
    "hlinkClick", "hlinkMouseOver", "rtl", "extLst",
];
const FILLS: &[&str] = &["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
/// Children of `a:p` in schema order.
const P_ORDER: &[&str] = &["pPr", "r", "br", "fld", "endParaRPr"];

/// One character-format change.
pub enum CharFormat {
    /// `sz` in points.
    Size(f64),
    Bold(bool),
    Italic(bool),
    Underline(bool),
    Strikethrough(bool),
    Color(String),
    Family(String),
    /// Character spacing in points (`spc`).
    Spacing(f64),
    /// Language tag (`lang`), e.g. `ko-KR`.
    Language(String),
    /// Superscript (> 0) or subscript (< 0) offset as a fraction; 0 for normal.
    Script(f64),
    /// Outer text shadow, or `None` to remove it.
    Shadow(Option<super::style::Shadow>),
}

impl CharFormat {
    fn op(&self) -> &'static str {
        match self {
            Self::Size(_) => "font_size",
            Self::Bold(_) => "bold",
            Self::Italic(_) => "italic",
            Self::Underline(_) => "underline",
            Self::Strikethrough(_) => "strikethrough",
            Self::Color(_) => "font_color",
            Self::Family(_) => "font_family",
            Self::Spacing(_) => "set_character_spacing",
            Self::Language(_) => "set_text_language",
            Self::Script(_) => "set_script_position",
            Self::Shadow(_) => "text_shadow",
        }
    }

    fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Size(s) if !(s.is_finite() && (1.0..=4000.0).contains(s)) => Err(Error::InvalidCommand("font size must be 1 to 4000 pt".into())),
            Self::Color(c) => parse_color(c).map(|_| ()),
            Self::Family(f) if f.trim().is_empty() || f.chars().any(char::is_control) => Err(Error::InvalidCommand("font family must be a name".into())),
            Self::Spacing(v) if !(v.is_finite() && (-4000.0..=4000.0).contains(v)) => Err(Error::InvalidCommand("character spacing must be -4000 to 4000 pt".into())),
            Self::Language(l) if l.is_empty() || l.len() > 35 || !l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => Err(Error::InvalidCommand(format!("language must be a tag like ko-KR, got {l:?}"))),
            Self::Script(v) if !(v.is_finite() && (-1.0..=1.0).contains(v)) => Err(Error::InvalidCommand("script offset must be -1 to 1".into())),
            Self::Shadow(Some(sh)) => sh.validate(),
            _ => Ok(()),
        }
    }

    /// The change to a properties element; `a` is the DrawingML prefix.
    fn change(&self, a: &str) -> Change<'static> {
        let flag = |name: &'static str, v: &bool, on: &str, off: &str| Change { attrs: vec![(name, Some(if *v { on } else { off }.to_owned()))], ..Default::default() };
        match self {
            Self::Size(s) => Change { attrs: vec![("sz", Some(((s * 100.0).round() as i64).to_string()))], ..Default::default() },
            Self::Bold(v) => flag("b", v, "1", "0"),
            Self::Italic(v) => flag("i", v, "1", "0"),
            Self::Underline(v) => flag("u", v, "sng", "none"),
            Self::Strikethrough(v) => flag("strike", v, "sngStrike", "noStrike"),
            Self::Color(c) => {
                let rgb = parse_color(c).expect("validated");
                Change { remove: FILLS.to_vec(), insert: vec![("solidFill", solid_fill(a, &rgb))], order: RPR_ORDER, ..Default::default() }
            }
            Self::Spacing(v) => Change { attrs: vec![("spc", Some(((v * 100.0).round() as i64).to_string()))], ..Default::default() },
            Self::Language(l) => Change { attrs: vec![("lang", Some(l.clone()))], ..Default::default() },
            Self::Script(v) => Change { attrs: vec![("baseline", (*v != 0.0).then(|| ((v * 100_000.0).round() as i64).to_string()))], ..Default::default() },
            Self::Shadow(sh) => {
                // An empty effect list switches off an inherited shadow.
                let list = match sh {
                    Some(sh) => format!("<{a}effectLst>{}</{a}effectLst>", sh.xml(a)),
                    None => format!("<{a}effectLst/>"),
                };
                let insert = vec![("effectLst", list.into_bytes())];
                Change { remove: vec!["effectLst", "effectDag"], insert, order: RPR_ORDER, ..Default::default() }
            }
            Self::Family(f) => {
                let face = super::xmledit::escape_attr(f);
                Change {
                    remove: vec!["latin", "ea"],
                    insert: vec![("latin", format!(r#"<{a}latin typeface="{face}"/>"#).into_bytes()), ("ea", format!(r#"<{a}ea typeface="{face}"/>"#).into_bytes())],
                    order: RPR_ORDER,
                    ..Default::default()
                }
            }
        }
    }
}

/// The shape's paragraphs, or only paragraph `index` (0-based).
fn paragraphs(t: &Target, index: Option<usize>) -> Result<Vec<usize>, Error> {
    let body = t.tree.child(t.shape, NS_P, "txBody").ok_or_else(|| Error::InvalidCommand("shape has no text".into()))?;
    let all: Vec<usize> = t.tree.children_named(body, NS_A, "p").collect();
    match index {
        None => Ok(all),
        Some(i) => all.get(i).map(|&p| vec![p]).ok_or_else(|| Error::NotFound(format!("paragraph {i} (shape has {})", all.len()))),
    }
}

/// Applies `format` to every run, break and field (and the end-of-paragraph
/// properties) of the selected paragraphs.
pub fn char_format(doc: &mut Presentation, slide: usize, id: u32, paragraph: Option<usize>, format: &CharFormat) -> Result<Value, Error> {
    format.validate()?;
    let t = target(doc, slide, id)?;
    let a = drawing_prefix(&t.tree)?;
    let change = format.change(&a);
    let mut edits = Vec::new();
    for p in paragraphs(&t, paragraph)? {
        let mut has_runs = false;
        let mut end_props = None;
        for &c in &t.tree.node(p).children {
            let n = t.tree.node(c);
            if n.ns.as_deref() != Some(NS_A) {
                continue;
            }
            match n.local.as_str() {
                "r" | "br" | "fld" => {
                    has_runs = true;
                    match t.tree.child(c, NS_A, "rPr") {
                        Some(rpr) => edits.push((t.tree.node(rpr).start..t.tree.node(rpr).end, rebuild(&t.src, &t.tree, rpr, &change)?)),
                        None => {
                            // A run without properties gets them as its first child.
                            let wrapper = Change { insert: vec![("rPr", new_props(&a, "rPr", &change))], order: &["rPr", "pPr", "t"], ..Default::default() };
                            edits.push((n.start..n.end, rebuild(&t.src, &t.tree, c, &wrapper)?));
                        }
                    }
                }
                "endParaRPr" => end_props = Some(c),
                _ => {}
            }
        }
        match end_props {
            Some(e) => edits.push((t.tree.node(e).start..t.tree.node(e).end, rebuild(&t.src, &t.tree, e, &change)?)),
            // An empty paragraph's height comes from these properties.
            None if !has_runs => {
                let insert = Change { insert: vec![("endParaRPr", new_props(&a, "endParaRPr", &change))], order: P_ORDER, ..Default::default() };
                edits.push((t.tree.node(p).start..t.tree.node(p).end, rebuild(&t.src, &t.tree, p, &insert)?));
            }
            None => {}
        }
    }
    let changed = commit(doc, &t, edits)?;
    Ok(json!({ "op": format.op(), "part": t.part, "slide": slide, "shapeId": id, "changed": changed }))
}

/// A new properties element carrying only `change`.
pub(super) fn new_props(a: &str, local: &str, change: &Change) -> Vec<u8> {
    let mut s = format!("<{a}{local}");
    for (k, v) in &change.attrs {
        if let Some(v) = v {
            s.push_str(&format!(r#" {k}="{v}""#));
        }
    }
    if change.insert.is_empty() {
        s.push_str("/>");
        return s.into_bytes();
    }
    s.push('>');
    let mut out = s.into_bytes();
    let mut children: Vec<&(&str, Vec<u8>)> = change.insert.iter().collect();
    children.sort_by_key(|(l, _)| change.order.iter().position(|o| o == l).unwrap_or(usize::MAX));
    for (_, bytes) in children {
        out.extend_from_slice(bytes);
    }
    out.extend_from_slice(format!("</{a}{local}>").as_bytes());
    out
}

/// Sets horizontal alignment (`a:pPr/@algn`) of the selected paragraphs.
pub fn paragraph_alignment(doc: &mut Presentation, slide: usize, id: u32, paragraph: Option<usize>, align: &str) -> Result<Value, Error> {
    let algn = match align {
        "left" => "l",
        "center" => "ctr",
        "right" => "r",
        "justify" => "just",
        "distributed" => "dist",
        other => return Err(Error::InvalidCommand(format!("align must be left, center, right, justify or distributed, got {other:?}"))),
    };
    let t = target(doc, slide, id)?;
    let a = drawing_prefix(&t.tree)?;
    let mut edits = Vec::new();
    for p in paragraphs(&t, paragraph)? {
        let change = Change { attrs: vec![("algn", Some(algn.to_owned()))], ..Default::default() };
        match t.tree.child(p, NS_A, "pPr") {
            Some(ppr) => edits.push((t.tree.node(ppr).start..t.tree.node(ppr).end, rebuild(&t.src, &t.tree, ppr, &change)?)),
            None => {
                let insert = Change { insert: vec![("pPr", format!(r#"<{a}pPr algn="{algn}"/>"#).into_bytes())], order: P_ORDER, ..Default::default() };
                edits.push((t.tree.node(p).start..t.tree.node(p).end, rebuild(&t.src, &t.tree, p, &insert)?));
            }
        }
    }
    let changed = commit(doc, &t, edits)?;
    Ok(json!({ "op": "paragraph_alignment", "part": t.part, "slide": slide, "shapeId": id, "changed": changed }))
}
