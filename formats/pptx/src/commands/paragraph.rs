//! Paragraph formatting, lists, letter case and text-box settings.

use serde_json::{json, Value};

use super::shape::{commit, target, Target};
use super::xmledit::{drawing_prefix, escape_attr, rebuild, Change};
use super::EMU_PER_PT;
use crate::xml::{escape_text, NS_A, NS_P};
use crate::{Error, Presentation};

/// Children of `a:pPr` in schema order.
const PPR_ORDER: &[&str] = &["lnSpc", "spcBef", "spcAft", "buClrTx", "buClr", "buSzTx", "buSzPct", "buSzPts", "buFontTx", "buFont", "buNone", "buAutoNum", "buChar", "buBlip", "tabLst", "defRPr", "extLst"];
/// Children of `a:p` in schema order.
const P_ORDER: &[&str] = &["pPr", "r", "br", "fld", "endParaRPr"];
/// Children of `a:bodyPr` in schema order.
const BODY_ORDER: &[&str] = &["prstTxWarp", "noAutofit", "normAutofit", "spAutoFit", "scene3d", "sp3d", "flatTx", "extLst"];
const SCHEMES: &[&str] = &["arabicPeriod", "arabicParenR", "arabicParenBoth", "arabicPlain", "alphaLcPeriod", "alphaUcPeriod", "alphaLcParenR", "alphaUcParenR", "romanLcPeriod", "romanUcPeriod", "circleNumDbPlain", "hangulGanadaPeriod", "hangulChosungPeriod", "ea1JpnKorPeriod"];

fn result(op: &str, t: &Target, slide: usize, id: u32, changed: bool) -> Value {
    json!({ "op": op, "part": t.part, "slide": slide, "shapeId": id, "changed": changed })
}

fn paragraphs(t: &Target, index: Option<usize>) -> Result<Vec<usize>, Error> {
    let body = t.tree.child(t.shape, NS_P, "txBody").ok_or_else(|| Error::InvalidCommand("shape has no text".into()))?;
    let all: Vec<usize> = t.tree.children_named(body, NS_A, "p").collect();
    match index {
        None => Ok(all),
        Some(i) => all.get(i).map(|&p| vec![p]).ok_or_else(|| Error::NotFound(format!("paragraph {i} (shape has {})", all.len()))),
    }
}

/// Applies `change` to each selected paragraph's `a:pPr`, creating it when absent.
fn edit_ppr(doc: &mut Presentation, slide: usize, id: u32, paragraph: Option<usize>, op: &str, change: &Change) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let a = drawing_prefix(&t.tree)?;
    let mut edits = Vec::new();
    for p in paragraphs(&t, paragraph)? {
        match t.tree.child(p, NS_A, "pPr") {
            Some(ppr) => edits.push((t.tree.node(ppr).start..t.tree.node(ppr).end, rebuild(&t.src, &t.tree, ppr, change)?)),
            None => {
                let built = super::format::new_props(&a, "pPr", change);
                let insert = Change { insert: vec![("pPr", built)], order: P_ORDER, ..Default::default() };
                edits.push((t.tree.node(p).start..t.tree.node(p).end, rebuild(&t.src, &t.tree, p, &insert)?));
            }
        }
    }
    let changed = commit(doc, &t, edits)?;
    Ok(result(op, &t, slide, id, changed))
}

/// Indents (points), space before/after (points) and line spacing (a
/// multiple like 1.5, or points) of the selected paragraphs.
#[allow(clippy::too_many_arguments)]
pub fn set_paragraph_format(
    doc: &mut Presentation,
    slide: usize,
    id: u32,
    paragraph: Option<usize>,
    indent_left: Option<f64>,
    indent_first: Option<f64>,
    space_before: Option<f64>,
    space_after: Option<f64>,
    line_spacing: Option<f64>,
    line_spacing_points: Option<f64>,
) -> Result<Value, Error> {
    let a = {
        let t = target(doc, slide, id)?;
        drawing_prefix(&t.tree)?
    };
    let all = [indent_left, indent_first, space_before, space_after, line_spacing, line_spacing_points];
    if all.iter().all(Option::is_none) {
        return Err(Error::InvalidCommand("set_paragraph_format needs at least one value".into()));
    }
    if all.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1584.0) || line_spacing.is_some_and(|v| !(0.0..=96.0).contains(&v)) || line_spacing.is_some() && line_spacing_points.is_some() {
        return Err(Error::InvalidCommand("values out of range (or both line spacing kinds given)".into()));
    }
    let emu = |v: f64| ((v * EMU_PER_PT).round() as i64).to_string();
    let mut change = Change { order: PPR_ORDER, ..Default::default() };
    if let Some(v) = indent_left {
        change.attrs.push(("marL", Some(emu(v))));
    }
    if let Some(v) = indent_first {
        change.attrs.push(("indent", Some(emu(v))));
    }
    let pts = |v: f64| format!(r#"<{a}spcPts val="{}"/>"#, (v * 100.0).round() as i64);
    if let Some(v) = line_spacing {
        change.remove.push("lnSpc");
        change.insert.push(("lnSpc", format!(r#"<{a}lnSpc><{a}spcPct val="{}"/></{a}lnSpc>"#, (v * 100_000.0).round() as i64).into_bytes()));
    }
    if let Some(v) = line_spacing_points {
        change.remove.push("lnSpc");
        change.insert.push(("lnSpc", format!("<{a}lnSpc>{}</{a}lnSpc>", pts(v)).into_bytes()));
    }
    if let Some(v) = space_before {
        change.remove.push("spcBef");
        change.insert.push(("spcBef", format!("<{a}spcBef>{}</{a}spcBef>", pts(v)).into_bytes()));
    }
    if let Some(v) = space_after {
        change.remove.push("spcAft");
        change.insert.push(("spcAft", format!("<{a}spcAft>{}</{a}spcAft>", pts(v)).into_bytes()));
    }
    edit_ppr(doc, slide, id, paragraph, "set_paragraph_format", &change)
}

/// Turns the selected paragraphs into a bulleted or numbered list, or plain.
pub fn set_paragraph_list(doc: &mut Presentation, slide: usize, id: u32, paragraph: Option<usize>, kind: &str, bullet: Option<&str>, scheme: Option<&str>, start: Option<u32>) -> Result<Value, Error> {
    let a = {
        let t = target(doc, slide, id)?;
        drawing_prefix(&t.tree)?
    };
    let mut change = Change { remove: vec!["buNone", "buAutoNum", "buChar", "buBlip", "buFont", "buFontTx"], order: PPR_ORDER, ..Default::default() };
    // PowerPoint's own list indent for the first level.
    let indent = [("marL", Some("342900".to_owned())), ("indent", Some("-342900".to_owned()))];
    match kind {
        "none" => {
            change.insert.push(("buNone", format!("<{a}buNone/>").into_bytes()));
            change.attrs.extend([("marL", Some("0".to_owned())), ("indent", Some("0".to_owned()))]);
        }
        "bullet" => {
            let ch = bullet.unwrap_or("•");
            if ch.chars().count() != 1 {
                return Err(Error::InvalidCommand("bullet must be one character".into()));
            }
            change.insert.push(("buFont", format!(r#"<{a}buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/>"#).into_bytes()));
            change.insert.push(("buChar", format!(r#"<{a}buChar char="{}"/>"#, escape_attr(ch)).into_bytes()));
            change.attrs.extend(indent);
        }
        "number" => {
            let scheme = scheme.unwrap_or("arabicPeriod");
            if !SCHEMES.contains(&scheme) {
                return Err(Error::InvalidCommand(format!("scheme {scheme:?}; one of {}", SCHEMES.join(", "))));
            }
            let start = start.filter(|&s| s != 1).map(|s| format!(r#" startAt="{s}""#)).unwrap_or_default();
            change.insert.push(("buAutoNum", format!(r#"<{a}buAutoNum type="{scheme}"{start}/>"#).into_bytes()));
            change.attrs.extend(indent);
        }
        other => return Err(Error::InvalidCommand(format!("kind must be none, bullet or number, got {other:?}"))),
    }
    edit_ppr(doc, slide, id, paragraph, "set_paragraph_list", &change)
}

/// Changes letter case of the text itself, as PowerPoint's Change Case does.
pub fn set_text_case(doc: &mut Presentation, slide: usize, id: u32, paragraph: Option<usize>, case: &str) -> Result<Value, Error> {
    if !matches!(case, "upper" | "lower" | "title" | "sentence") {
        return Err(Error::InvalidCommand(format!("case must be upper, lower, title or sentence, got {case:?}")));
    }
    let t = target(doc, slide, id)?;
    let mut edits = Vec::new();
    for p in paragraphs(&t, paragraph)? {
        // Word and sentence starts carry across runs.
        let (mut word_start, mut sentence_start) = (true, true);
        for r in t.tree.children_named(p, NS_A, "r") {
            let Some(tn) = t.tree.child(r, NS_A, "t") else { continue };
            let text = t.tree.text(&t.src, tn)?;
            let mut out = String::new();
            for c in text.chars() {
                let mapped: String = match case {
                    "upper" => c.to_uppercase().collect(),
                    "lower" => c.to_lowercase().collect(),
                    "title" => if word_start { c.to_uppercase().collect() } else { c.to_lowercase().collect() },
                    _ => if sentence_start && c.is_alphabetic() { c.to_uppercase().collect() } else { c.to_lowercase().collect() },
                };
                out.push_str(&mapped);
                word_start = c.is_whitespace();
                if matches!(c, '.' | '!' | '?') {
                    sentence_start = true;
                } else if c.is_alphabetic() {
                    sentence_start = false;
                }
            }
            if out != text {
                let n = t.tree.node(tn);
                let tag = &t.src[n.start..n.open_end];
                let bytes = [tag, escape_text(&out).as_bytes(), format!("</{}>", n.qname).as_bytes()].concat();
                if n.is_empty_element() {
                    continue;
                }
                edits.push((n.start..n.end, bytes));
            }
        }
    }
    let changed = commit(doc, &t, edits)?;
    Ok(result("set_text_case", &t, slide, id, changed))
}

fn body_pr(t: &Target) -> Result<usize, Error> {
    let body = t.tree.child(t.shape, NS_P, "txBody").ok_or_else(|| Error::InvalidCommand("shape has no text".into()))?;
    t.tree.child(body, NS_A, "bodyPr").ok_or_else(|| Error::Xml("text body without a:bodyPr".into()))
}

/// Autofit mode: `none`, `shrink` (shrink text on overflow) or `resize`
/// (resize shape to fit text). The values are then recomputed.
pub fn text_autofit(doc: &mut Presentation, slide: usize, id: u32, mode: &str) -> Result<Value, Error> {
    let local = match mode {
        "none" => "noAutofit",
        "shrink" => "normAutofit",
        "resize" => "spAutoFit",
        other => return Err(Error::InvalidCommand(format!("mode must be none, shrink or resize, got {other:?}"))),
    };
    let t = target(doc, slide, id)?;
    let body = body_pr(&t)?;
    let a = drawing_prefix(&t.tree)?;
    let change = Change { remove: vec!["noAutofit", "normAutofit", "spAutoFit"], insert: vec![(local, format!("<{a}{local}/>").into_bytes())], order: BODY_ORDER, ..Default::default() };
    let n = t.tree.node(body);
    let changed = commit(doc, &t, vec![(n.start..n.end, rebuild(&t.src, &t.tree, body, &change)?)])?;
    Ok(result("text_autofit", &t, slide, id, changed))
}

/// WordArt text shapes (`a:prstTxWarp` presets, ECMA-376 ST_TextShapeType).
const WARPS: &[&str] = &[
    "textNoShape", "textPlain", "textStop", "textTriangle", "textTriangleInverted", "textChevron", "textChevronInverted", "textRingInside", "textRingOutside", "textArchUp", "textArchDown", "textCircle", "textButton", "textArchUpPour", "textArchDownPour", "textCirclePour", "textButtonPour", "textCurveUp", "textCurveDown", "textCanUp", "textCanDown", "textWave1", "textWave2", "textDoubleWave1", "textWave4", "textInflate", "textDeflate", "textInflateBottom", "textDeflateBottom", "textInflateTop", "textDeflateTop", "textDeflateInflate", "textDeflateInflateDeflate", "textFadeRight", "textFadeLeft", "textFadeUp", "textFadeDown", "textSlantUp", "textSlantDown", "textCascadeUp", "textCascadeDown",
];

/// Bends the shape's text into a WordArt shape (`preset`, e.g.
/// `textArchUp`), with optional adjust values by guide name (`adj`,
/// `adj1`, ...; preset units). `none` removes the warp.
pub fn set_fontwork(doc: &mut Presentation, slide: usize, id: u32, preset: &str, adjust: &std::collections::BTreeMap<String, f64>) -> Result<Value, Error> {
    if preset != "none" && !WARPS.contains(&preset) {
        return Err(Error::InvalidCommand(format!("preset {preset:?}; one of none, {}", WARPS.join(", "))));
    }
    if let Some((k, _)) = adjust.iter().find(|(k, v)| !v.is_finite() || !k.starts_with("adj") || !k[3..].chars().all(|c| c.is_ascii_digit())) {
        return Err(Error::InvalidCommand(format!("adjust {k:?}: names are adj, adj1, adj2 ... with finite values")));
    }
    let t = target(doc, slide, id)?;
    let body = body_pr(&t)?;
    let a = drawing_prefix(&t.tree)?;
    let insert = if preset == "none" {
        Vec::new()
    } else {
        let gds: String = adjust.iter().map(|(k, v)| format!(r#"<{a}gd name="{k}" fmla="val {}"/>"#, v.round() as i64)).collect();
        vec![("prstTxWarp", format!(r#"<{a}prstTxWarp prst="{preset}"><{a}avLst>{gds}</{a}avLst></{a}prstTxWarp>"#).into_bytes())]
    };
    let change = Change { remove: vec!["prstTxWarp"], insert, order: BODY_ORDER, ..Default::default() };
    let n = t.tree.node(body);
    let changed = commit(doc, &t, vec![(n.start..n.end, rebuild(&t.src, &t.tree, body, &change)?)])?;
    Ok(result("set_fontwork", &t, slide, id, changed))
}

/// Text box settings: insets (points: left, top, right, bottom), vertical
/// anchor (`top`, `middle`, `bottom`), word wrap and text direction.
pub fn set_text_box(doc: &mut Presentation, slide: usize, id: u32, insets: Option<[f64; 4]>, anchor: Option<&str>, wrap: Option<bool>, direction: Option<&str>) -> Result<Value, Error> {
    let mut attrs: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(ins) = insets {
        if ins.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1584.0) {
            return Err(Error::InvalidCommand("insets must be 0 to 1584 pt".into()));
        }
        for (k, v) in ["lIns", "tIns", "rIns", "bIns"].iter().zip(ins) {
            attrs.push((k, Some(((v * EMU_PER_PT).round() as i64).to_string())));
        }
    }
    if let Some(an) = anchor {
        let v = match an {
            "top" => "t",
            "middle" => "ctr",
            "bottom" => "b",
            other => return Err(Error::InvalidCommand(format!("anchor must be top, middle or bottom, got {other:?}"))),
        };
        attrs.push(("anchor", Some(v.to_owned())));
    }
    if let Some(w) = wrap {
        attrs.push(("wrap", Some(if w { "square" } else { "none" }.to_owned())));
    }
    if let Some(d) = direction {
        if !matches!(d, "horz" | "vert" | "vert270" | "eaVert" | "wordArtVert" | "mongolianVert" | "wordArtVertRtl") {
            return Err(Error::InvalidCommand(format!("direction {d:?}")));
        }
        attrs.push(("vert", Some(d.to_owned())));
    }
    if attrs.is_empty() {
        return Err(Error::InvalidCommand("set_text_box needs insets, anchor, wrap or direction".into()));
    }
    let t = target(doc, slide, id)?;
    let body = body_pr(&t)?;
    let n = t.tree.node(body);
    let changed = commit(doc, &t, vec![(n.start..n.end, rebuild(&t.src, &t.tree, body, &Change { attrs, ..Default::default() })?)])?;
    Ok(result("set_text_box", &t, slide, id, changed))
}

/// Replaces characters `start .. end` of paragraph `paragraph` with `text`,
/// keeping run formatting: the new text takes the formatting of the run
/// where the range starts. Offsets count characters as `observe` shows the
/// paragraph (a line break is one character, U+000B).
pub fn replace_text_range(doc: &mut Presentation, slide: usize, id: u32, paragraph: usize, start: usize, end: usize, text: &str) -> Result<Value, Error> {
    if start > end {
        return Err(Error::InvalidCommand("start must not be after end".into()));
    }
    if text.chars().any(|c| c.is_control() && c != '\t') {
        return Err(Error::InvalidCommand("replacement contains control characters (line breaks need replace_text)".into()));
    }
    let t = target(doc, slide, id)?;
    let p = *paragraphs(&t, Some(paragraph))?.first().expect("one paragraph");
    // Character spans of the paragraph's runs, breaks and fields.
    let mut parts: Vec<(usize, usize, usize, &str)> = Vec::new(); // node, from, to, kind
    let mut pos = 0;
    for &c in &t.tree.node(p).children {
        let n = t.tree.node(c);
        let len = match n.local.as_str() {
            "r" | "fld" => t.tree.child(c, NS_A, "t").map(|x| t.tree.text(&t.src, x)).transpose()?.map(|s| s.chars().count()).unwrap_or(0),
            "br" => 1,
            _ => continue,
        };
        parts.push((c, pos, pos + len, if n.local == "r" { "run" } else { "atom" }));
        pos += len;
    }
    if end > pos {
        return Err(Error::InvalidCommand(format!("range ends after the paragraph ({pos} characters)")));
    }
    if parts.is_empty() {
        // An empty paragraph: write the text as its only run.
        let edits = super::paragraph_edits_one(&t.tree, &t.src, p, text)?;
        let changed = commit(doc, &t, edits)?;
        return Ok(result("replace_text_range", &t, slide, id, changed));
    }
    // The run that receives the new text: the one containing `start`, or the
    // run ending there when inserting at its end.
    let host = parts
        .iter()
        .position(|&(_, from, to, kind)| kind == "run" && from <= start && (start < to || (start == to && start == end)))
        .ok_or_else(|| Error::Unsupported("the range starts inside a field or at a line break".into()))?;
    let mut edits = Vec::new();
    for (k, &(node, from, to, kind)) in parts.iter().enumerate() {
        let overlaps = from < end && start < to;
        if k != host && !overlaps {
            continue;
        }
        if kind == "atom" {
            if start <= from && to <= end {
                edits.push((t.tree.node(node).start..t.tree.node(node).end, Vec::new()));
                continue;
            }
            return Err(Error::Unsupported("the range cuts through a field".into()));
        }
        let tn = t.tree.child(node, NS_A, "t").ok_or_else(|| Error::Xml("run without a:t".into()))?;
        let old: Vec<char> = t.tree.text(&t.src, tn)?.chars().collect();
        let keep_head: String = old[..start.saturating_sub(from).min(old.len())].iter().collect();
        let keep_tail: String = old[end.saturating_sub(from).min(old.len())..].iter().collect();
        let new_text = if k == host { format!("{keep_head}{text}{keep_tail}") } else if start <= from { keep_tail } else { keep_head };
        if new_text.is_empty() && k != host {
            edits.push((t.tree.node(node).start..t.tree.node(node).end, Vec::new()));
            continue;
        }
        let n = t.tree.node(tn);
        let head = start_tag_bytes(&t.src, n);
        edits.push((n.start..n.end, [head, escape_text(&new_text).into_bytes(), format!("</{}>", n.qname).into_bytes()].concat()));
    }
    let changed = commit(doc, &t, edits)?;
    Ok(result("replace_text_range", &t, slide, id, changed))
}

/// The start tag of an element as written (an empty element gets one).
fn start_tag_bytes(src: &[u8], n: &crate::xml::Node) -> Vec<u8> {
    if n.is_empty_element() {
        format!("<{}>", n.qname).into_bytes()
    } else {
        src[n.start..n.open_end].to_vec()
    }
}
