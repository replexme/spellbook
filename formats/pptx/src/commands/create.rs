//! New shapes and arrangement of several shapes: duplicate, add a text box
//! or a preset shape, align and distribute.

use serde_json::{json, Value};

use super::shape::{move_to, slide_frame, target, parse_color};
use super::xmledit::{drawing_prefix, escape_attr, ns_prefix};
use super::{check_scope, EMU_PER_PT};
use crate::render::geometry::is_preset;
use crate::xml::{escape_text, splice, Tree, NS_A, NS_P};
use crate::{Error, Presentation};

/// The slide's largest shape id.
fn max_id(tree: &Tree) -> u32 {
    tree.nodes.iter().filter(|n| n.local == "cNvPr").filter_map(|n| n.attr("id")?.parse().ok()).max().unwrap_or(1)
}

/// Copies a shape (or group) right above itself, moved by `dx`, `dy` points.
/// Copies get new ids; their co-authoring ids (`a16:creationId`) are dropped.
pub fn duplicate_element(doc: &mut Presentation, slide: usize, id: u32, dx: f64, dy: f64) -> Result<Value, Error> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err(Error::InvalidCommand("offsets must be numbers".into()));
    }
    let t = target(doc, slide, id)?;
    let shape = t.tree.node(t.shape);
    if t.tree.nodes.iter().any(|n| n.local == "ph" && n.start > shape.start && n.end < shape.end) {
        return Err(Error::Unsupported("placeholders cannot be duplicated".into()));
    }
    let range = shape.start..shape.end;
    let inside = |n: &crate::xml::Node| n.start >= range.start && n.end <= range.end;
    let mut next = max_id(&t.tree);
    let mut remap = std::collections::HashMap::new();
    let mut edits = Vec::new();
    for n in t.tree.nodes.iter().filter(|n| inside(n)) {
        if n.local == "cNvPr" {
            next += 1;
            if let Some(old) = n.attr("id") {
                remap.insert(old.to_owned(), next.to_string());
            }
        }
    }
    for (i, n) in t.tree.nodes.iter().enumerate().filter(|(_, n)| inside(n)) {
        let rel = |r: std::ops::Range<usize>| (r.start - range.start)..(r.end - range.start);
        match n.local.as_str() {
            "cNvPr" | "stCxn" | "endCxn" => {
                if let Some(new) = n.attr("id").and_then(|old| remap.get(old)) {
                    let tag = super::xmledit::start_tag(&t.src, &t.tree, i, &[("id", Some(new.clone()))], n.is_empty_element())?;
                    edits.push((rel(n.start..n.open_end), tag));
                }
            }
            "ext" if n.attr("uri") == Some("{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}") => edits.push((rel(n.start..n.end), Vec::new())),
            "off" if (dx != 0.0 || dy != 0.0) && is_outer_offset(&t.tree, i, t.shape) => {
                let x = n.attr("x").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + (dx * EMU_PER_PT).round() as i64;
                let y = n.attr("y").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + (dy * EMU_PER_PT).round() as i64;
                let tag = super::xmledit::start_tag(&t.src, &t.tree, i, &[("x", Some(x.to_string())), ("y", Some(y.to_string()))], n.is_empty_element())?;
                edits.push((rel(n.start..n.open_end), tag));
            }
            _ => {}
        }
    }
    // Nested edits (a cNvPr id inside a removed ext) cannot both apply.
    edits.sort_by_key(|e| e.0.start);
    let mut kept: Vec<(std::ops::Range<usize>, Vec<u8>)> = Vec::new();
    for e in edits {
        if kept.last().is_some_and(|k| e.0.start < k.0.end) {
            continue;
        }
        kept.push(e);
    }
    let copy = splice(&t.src[range.clone()], kept)?;
    let updated = splice(&t.src, vec![(range.end..range.end, copy)])?;
    check_scope(&t.src, &updated, range.start, range.end)?;
    doc.package_mut().write(&t.part, updated)?;
    let new_id: u32 = remap.get(&id.to_string()).and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(json!({ "op": "duplicate_element", "slide": slide, "shapeId": id, "newShapeId": new_id, "changed": true }))
}

/// Is `off` the offset of the shape's own position (not a child's)?
fn is_outer_offset(tree: &Tree, off: usize, shape: usize) -> bool {
    let Some(xfrm) = tree.node(off).parent else { return false };
    let Some(holder) = tree.node(xfrm).parent else { return false };
    holder == shape || tree.node(holder).parent == Some(shape) && matches!(tree.node(holder).local.as_str(), "spPr" | "grpSpPr")
}

/// Appends shape XML (`build` gets the new id and the p/a prefixes) on top
/// of the slide.
pub(super) fn append_shape(doc: &mut Presentation, slide: usize, build: impl FnOnce(u32, &str, &str) -> String) -> Result<u32, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let sp_tree = tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound("shape tree".into()))?;
    let n = tree.node(sp_tree);
    if n.is_empty_element() {
        return Err(Error::Unsupported("empty shape tree element".into()));
    }
    let p = n.prefix().to_owned();
    let a = match ns_prefix(&src, &tree, NS_A) {
        Some(prefix) => format!("{prefix}:"),
        None => drawing_prefix(&tree).map_err(|_| Error::Unsupported("slide does not declare the DrawingML namespace".into()))?,
    };
    let id = max_id(&tree) + 1;
    let xml = build(id, &p, &a);
    let updated = splice(&src, vec![(n.close_start..n.close_start, xml.into_bytes())])?;
    check_scope(&src, &updated, n.start, n.end)?;
    doc.package_mut().write(&part, updated)?;
    Ok(id)
}

fn check_box(x: f64, y: f64, w: f64, h: f64) -> Result<(), Error> {
    if [x, y, w, h].iter().any(|v| !v.is_finite() || v.abs() > 2_000_000.0) || w <= 0.0 || h <= 0.0 {
        return Err(Error::InvalidCommand("position and positive size in points".into()));
    }
    Ok(())
}

fn paragraphs_xml(a: &str, paragraphs: &[String], size: Option<f64>, center: bool) -> Result<String, Error> {
    if let Some(s) = size.filter(|s| !(1.0..=4000.0).contains(s)) {
        return Err(Error::InvalidCommand(format!("font size {s} outside 1-4000 pt")));
    }
    let sz = size.map(|s| format!(r#" sz="{}""#, (s * 100.0).round() as i64)).unwrap_or_default();
    let ppr = if center { format!(r#"<{a}pPr algn="ctr"/>"#) } else { String::new() };
    let texts: Vec<&str> = if paragraphs.is_empty() { vec![""] } else { paragraphs.iter().map(String::as_str).collect() };
    let mut out = String::new();
    for text in texts {
        if text.chars().any(|c| c.is_control() && c != '\t') {
            return Err(Error::InvalidCommand("paragraph text contains control characters".into()));
        }
        if text.is_empty() {
            out.push_str(&format!(r#"<{a}p>{ppr}<{a}endParaRPr lang="ko-KR" altLang="en-US"{sz}/></{a}p>"#));
        } else {
            out.push_str(&format!(r#"<{a}p>{ppr}<{a}r><{a}rPr lang="ko-KR" altLang="en-US"{sz}/><{a}t>{}</{a}t></{a}r></{a}p>"#, escape_text(text)));
        }
    }
    Ok(out)
}

/// A text box sized to its text, as PowerPoint's Text Box tool makes it.
pub fn add_text_box(doc: &mut Presentation, slide: usize, x: f64, y: f64, width: f64, height: f64, paragraphs: &[String], size: Option<f64>) -> Result<Value, Error> {
    check_box(x, y, width, height)?;
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let mut body = Err(Error::Xml("not built".into()));
    let id = append_shape(doc, slide, |id, p, a| {
        body = paragraphs_xml(a, paragraphs, size, false);
        let text = body.as_ref().map(String::as_str).unwrap_or("");
        format!(
            r#"<{p}sp><{p}nvSpPr><{p}cNvPr id="{id}" name="TextBox {}"/><{p}cNvSpPr txBox="1"/><{p}nvPr/></{p}nvSpPr><{p}spPr><{a}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm><{a}prstGeom prst="rect"><{a}avLst/></{a}prstGeom><{a}noFill/></{p}spPr><{p}txBody><{a}bodyPr wrap="square" rtlCol="0"><{a}spAutoFit/></{a}bodyPr><{a}lstStyle/>{text}</{p}txBody></{p}sp>"#,
            id - 1, e(x), e(y), e(width), e(height)
        )
    })?;
    body?;
    Ok(json!({ "op": "add_text_box", "slide": slide, "shapeId": id, "changed": true }))
}

/// A preset shape (`rect`, `ellipse`, `rightArrow`, ...) styled with the
/// theme's first accent colour, as PowerPoint inserts it, with optional
/// fill, outline and centred text.
#[allow(clippy::too_many_arguments)]
pub fn add_shape(doc: &mut Presentation, slide: usize, preset: &str, x: f64, y: f64, width: f64, height: f64, fill: Option<&str>, line: Option<&str>, paragraphs: &[String]) -> Result<Value, Error> {
    if !is_preset(preset) {
        return Err(Error::InvalidCommand(format!("unknown preset shape {preset:?}")));
    }
    check_box(x, y, width, height)?;
    let fill = fill.map(parse_color).transpose()?;
    let line = line.map(parse_color).transpose()?;
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let mut body = Ok(String::new());
    let id = append_shape(doc, slide, |id, p, a| {
        let fill_xml = fill.map(|c| format!(r#"<{a}solidFill><{a}srgbClr val="{c}"/></{a}solidFill>"#)).unwrap_or_default();
        let line_xml = line.map(|c| format!(r#"<{a}ln><{a}solidFill><{a}srgbClr val="{c}"/></{a}solidFill></{a}ln>"#)).unwrap_or_default();
        body = paragraphs_xml(a, paragraphs, None, true);
        let text = body.as_ref().map(String::as_str).unwrap_or("");
        format!(
            r#"<{p}sp><{p}nvSpPr><{p}cNvPr id="{id}" name="{} {}"/><{p}cNvSpPr/><{p}nvPr/></{p}nvSpPr><{p}spPr><{a}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm><{a}prstGeom prst="{}"><{a}avLst/></{a}prstGeom>{fill_xml}{line_xml}</{p}spPr><{p}style><{a}lnRef idx="2"><{a}schemeClr val="accent1"><{a}shade val="15000"/></{a}schemeClr></{a}lnRef><{a}fillRef idx="1"><{a}schemeClr val="accent1"/></{a}fillRef><{a}effectRef idx="0"><{a}schemeClr val="accent1"/></{a}effectRef><{a}fontRef idx="minor"><{a}schemeClr val="lt1"/></{a}fontRef></{p}style><{p}txBody><{a}bodyPr rtlCol="0" anchor="ctr"/><{a}lstStyle/>{text}</{p}txBody></{p}sp>"#,
            escape_attr(preset), id - 1, e(x), e(y), e(width), e(height), escape_attr(preset)
        )
    })?;
    body?;
    Ok(json!({ "op": "add_shape", "slide": slide, "shapeId": id, "changed": true }))
}

pub(super) fn slide_size(doc: &Presentation) -> Result<(f64, f64), Error> {
    let src = doc.package().read(doc.presentation_part())?;
    let tree = Tree::parse(&src)?;
    // Without sldSz, the renderer's default (4:3, 720 x 540 pt) applies.
    let size = tree.child(tree.root, NS_P, "sldSz");
    let v = |k: &str| size.and_then(|s| tree.node(s).attr(k)).and_then(|v| v.parse::<f64>().ok()).map(|v| v / EMU_PER_PT);
    Ok((v("cx").unwrap_or(720.0), v("cy").unwrap_or(540.0)))
}

/// Lines shapes up on one edge or centre line, of their combined box or of
/// the slide.
pub fn align(doc: &mut Presentation, slide: usize, ids: &[u32], to: &str, relative_to_slide: bool) -> Result<Value, Error> {
    if ids.is_empty() || (!relative_to_slide && ids.len() < 2) {
        return Err(Error::InvalidCommand("align needs two shapes, or one with relativeTo slide".into()));
    }
    let frames: Vec<[f64; 4]> = ids.iter().map(|&i| slide_frame(doc, slide, i)).collect::<Result<_, _>>()?;
    let (x0, y0, x1, y1) = if relative_to_slide {
        let (sw, sh) = slide_size(doc)?;
        (0.0, 0.0, sw, sh)
    } else {
        frames.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, f| (b.0.min(f[0]), b.1.min(f[1]), b.2.max(f[0] + f[2]), b.3.max(f[1] + f[3])))
    };
    for (&id, f) in ids.iter().zip(&frames) {
        let (x, y) = match to {
            "left" => (x0, f[1]),
            "center" => ((x0 + x1 - f[2]) / 2.0, f[1]),
            "right" => (x1 - f[2], f[1]),
            "top" => (f[0], y0),
            "middle" => (f[0], (y0 + y1 - f[3]) / 2.0),
            "bottom" => (f[0], y1 - f[3]),
            other => return Err(Error::InvalidCommand(format!("to must be left, center, right, top, middle or bottom, got {other:?}"))),
        };
        if (x - f[0]).abs() > 1e-6 || (y - f[1]).abs() > 1e-6 {
            move_to(doc, slide, id, x, y)?;
        }
    }
    Ok(json!({ "op": "align", "slide": slide, "shapeIds": ids, "changed": true }))
}

/// Spaces three or more shapes evenly between the outermost two.
pub fn distribute(doc: &mut Presentation, slide: usize, ids: &[u32], direction: &str) -> Result<Value, Error> {
    if ids.len() < 3 {
        return Err(Error::InvalidCommand("distribute needs three or more shapes".into()));
    }
    let axis = match direction {
        "horizontal" => 0,
        "vertical" => 1,
        other => return Err(Error::InvalidCommand(format!("direction must be horizontal or vertical, got {other:?}"))),
    };
    let mut items: Vec<(u32, [f64; 4])> = ids.iter().map(|&i| slide_frame(doc, slide, i).map(|f| (i, f))).collect::<Result<_, _>>()?;
    items.sort_by(|a, b| a.1[axis].total_cmp(&b.1[axis]));
    let first = items[0].1;
    let last = items[items.len() - 1].1;
    let span = last[axis] + last[axis + 2] - first[axis];
    let sizes: f64 = items.iter().map(|(_, f)| f[axis + 2]).sum();
    let gap = (span - sizes) / (items.len() - 1) as f64;
    let mut at = first[axis] + first[axis + 2] + gap;
    for (id, f) in &items[1..items.len() - 1] {
        let (x, y) = if axis == 0 { (at, f[1]) } else { (f[0], at) };
        move_to(doc, slide, *id, x, y)?;
        at += f[axis + 2] + gap;
    }
    Ok(json!({ "op": "distribute", "slide": slide, "shapeIds": ids, "changed": true }))
}
