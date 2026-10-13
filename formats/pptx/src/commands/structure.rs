//! Grouping, connectors and freeform shapes.

use kurbo::Point;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::shape::{parse_color, slide_frame, target};
use super::xmledit::{drawing_prefix, rebuild, start_tag, Change};
use super::{check_scope, EMU_PER_PT};
use crate::render::geometry::{connection_sites, is_preset};
use crate::xml::{splice, Tree, NS_A, NS_P};
use crate::{non_visual, shape_id, Error, Presentation};

type Edit = (std::ops::Range<usize>, Vec<u8>);

fn sp_tree(tree: &Tree) -> Result<usize, Error> {
    tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound("shape tree".into()))
}

/// The element holding a shape's own position.
fn own_xfrm(tree: &Tree, shape: usize) -> Option<usize> {
    match tree.node(shape).local.as_str() {
        "grpSp" => tree.path(shape, &[(NS_P, "grpSpPr"), (NS_A, "xfrm")]),
        "graphicFrame" => tree.child(shape, NS_P, "xfrm"),
        _ => tree.path(shape, &[(NS_P, "spPr"), (NS_A, "xfrm")]),
    }
}

fn emu(tree: &Tree, node: Option<usize>, attr: &str) -> i64 {
    node.and_then(|n| tree.node(n).attr(attr)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

fn write_slide(doc: &mut Presentation, part: &str, src: &[u8], tree: &Tree, edits: Vec<Edit>) -> Result<(), Error> {
    let container = sp_tree(tree)?;
    let updated = splice(src, edits)?;
    check_scope(src, &updated, tree.node(container).start, tree.node(container).end)?;
    doc.package_mut().write(part, updated).map_err(Error::from)
}

/// Groups top-level shapes. The group takes the place of the topmost of
/// them in the stacking order; its child space equals its box, so nothing
/// moves on screen.
pub fn group(doc: &mut Presentation, slide: usize, ids: &[u32]) -> Result<Value, Error> {
    if ids.len() < 2 {
        return Err(Error::InvalidCommand("group needs two or more shapes".into()));
    }
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let container = sp_tree(&tree)?;
    let mut members: Vec<usize> = Vec::new();
    for &id in ids {
        let el = tree.node(container).children.iter().copied().find(|&c| shape_id(&tree, c) == Some(id)).ok_or_else(|| Error::InvalidCommand(format!("shape {id} is not a top-level shape of slide {slide}")))?;
        let n = tree.node(el);
        if tree.nodes.iter().any(|x| x.local == "ph" && x.start > n.start && x.end < n.end) {
            return Err(Error::Unsupported("placeholders cannot be grouped".into()));
        }
        if tree.nodes.iter().any(|x| x.local == "tbl" && x.start > n.start && x.end < n.end) {
            return Err(Error::Unsupported("tables cannot be grouped".into()));
        }
        if own_xfrm(&tree, el).is_none() {
            return Err(Error::Unsupported(format!("shape {id} has no position of its own")));
        }
        members.push(el);
    }
    members.sort_by_key(|&m| tree.node(m).start);
    members.dedup();
    let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
    for &m in &members {
        let x = own_xfrm(&tree, m);
        let (off, ext) = (x.and_then(|x| tree.child(x, NS_A, "off")), x.and_then(|x| tree.child(x, NS_A, "ext")));
        let (ox, oy, cx, cy) = (emu(&tree, off, "x"), emu(&tree, off, "y"), emu(&tree, ext, "cx"), emu(&tree, ext, "cy"));
        (x0, y0, x1, y1) = (x0.min(ox), y0.min(oy), x1.max(ox + cx), y1.max(oy + cy));
    }
    let next = tree.nodes.iter().filter(|n| n.local == "cNvPr").filter_map(|n| n.attr("id")?.parse::<u32>().ok()).max().unwrap_or(1) + 1;
    let p = tree.node(container).prefix().to_owned();
    let a = drawing_prefix(&tree)?;
    let (w, h) = (x1 - x0, y1 - y0);
    let mut group = format!(
        r#"<{p}grpSp><{p}nvGrpSpPr><{p}cNvPr id="{next}" name="Group {}"/><{p}cNvGrpSpPr/><{p}nvPr/></{p}nvGrpSpPr><{p}grpSpPr><{a}xfrm><{a}off x="{x0}" y="{y0}"/><{a}ext cx="{w}" cy="{h}"/><{a}chOff x="{x0}" y="{y0}"/><{a}chExt cx="{w}" cy="{h}"/></{a}xfrm></{p}grpSpPr>"#,
        next - 1
    )
    .into_bytes();
    for &m in &members {
        group.extend_from_slice(&src[tree.node(m).start..tree.node(m).end]);
    }
    group.extend(format!("</{p}grpSp>").into_bytes());
    let top = *members.last().expect("two or more");
    let mut edits: Vec<Edit> = members.iter().filter(|&&m| m != top).map(|&m| (tree.node(m).start..tree.node(m).end, Vec::new())).collect();
    edits.push((tree.node(top).start..tree.node(top).end, group));
    edits.sort_by_key(|e| e.0.start);
    write_slide(doc, &part, &src, &tree, edits)?;
    Ok(json!({ "op": "group", "slide": slide, "shapeId": next, "changed": true }))
}

/// Takes a group's shapes out to where the group was, positioned as they
/// appeared. Refused for rotated or flipped groups and for shapes that use
/// the group's fill.
pub fn ungroup(doc: &mut Presentation, slide: usize, id: u32) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = t.shape;
    if t.tree.node(g).local != "grpSp" {
        return Err(Error::InvalidCommand(format!("shape {id} is not a group")));
    }
    let x = t.tree.path(g, &[(NS_P, "grpSpPr"), (NS_A, "xfrm")]).ok_or_else(|| Error::Unsupported("group without a position".into()))?;
    let xn = t.tree.node(x);
    if xn.attr("rot").is_some_and(|r| r != "0") || xn.attr("flipH") == Some("1") || xn.attr("flipV") == Some("1") {
        return Err(Error::Unsupported("rotated or flipped groups".into()));
    }
    let gn = t.tree.node(g);
    if super::shape::referenced_elsewhere(&t, id) {
        return Err(Error::Unsupported(format!("group {id} is used by an animation or a connector")));
    }
    if t.tree.nodes.iter().any(|n| n.local == "grpFill" && n.start > gn.start && n.end < gn.end) {
        return Err(Error::Unsupported("shapes in the group use its fill".into()));
    }
    let get = |child: &str, a: &str| emu(&t.tree, t.tree.child(x, NS_A, child), a) as f64;
    let (ox, oy, cx, cy) = (get("off", "x"), get("off", "y"), get("ext", "cx"), get("ext", "cy"));
    let (chx, chy) = (get("chOff", "x"), get("chOff", "y"));
    let (chw, chh) = (get("chExt", "cx"), get("chExt", "cy"));
    let (sx, sy) = (if chw > 0.0 { cx / chw } else { 1.0 }, if chh > 0.0 { cy / chh } else { 1.0 });
    let mut out = Vec::new();
    let children: Vec<usize> = gn.children.iter().copied().filter(|&c| !matches!(t.tree.node(c).local.as_str(), "nvGrpSpPr" | "grpSpPr" | "extLst")).collect();
    for (k, &c) in children.iter().enumerate() {
        let n = t.tree.node(c);
        if k > 0 {
            out.extend_from_slice(&t.src[t.tree.node(children[k - 1]).end..n.start]);
        }
        let mut edits: Vec<Edit> = Vec::new();
        if let Some(cx_node) = own_xfrm(&t.tree, c) {
            for (el, (ka, kb), map) in [("off", ("x", "y"), true), ("ext", ("cx", "cy"), false)] {
                let Some(e) = t.tree.child(cx_node, NS_A, el) else { continue };
                let (va, vb) = (emu(&t.tree, Some(e), ka) as f64, emu(&t.tree, Some(e), kb) as f64);
                let (na, nb) = if map { (ox + (va - chx) * sx, oy + (vb - chy) * sy) } else { (va * sx, vb * sy) };
                let en = t.tree.node(e);
                let tag = start_tag(&t.src, &t.tree, e, &[(ka, Some((na.round() as i64).to_string())), (kb, Some((nb.round() as i64).to_string()))], en.is_empty_element())?;
                let end = if en.is_empty_element() { en.end } else { en.open_end };
                edits.push(((en.start - n.start)..(end - n.start), tag));
            }
        }
        out.extend(splice(&t.src[n.start..n.end], edits)?);
    }
    super::shape::commit(doc, &t, vec![(gn.start..gn.end, out)])?;
    Ok(json!({ "op": "ungroup", "slide": slide, "shapeId": id, "changed": true }))
}

/// One end of a connector: glued to `shape_id` at connection site `site`
/// (nearest to the other end when absent), or a free point in slide points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct End {
    pub shape_id: Option<u32>,
    pub site: Option<u32>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

/// Connection sites of a shape on the slide (rotation applied).
fn sites_of(doc: &Presentation, slide: usize, id: u32) -> Result<Vec<Point>, Error> {
    let t = target(doc, slide, id)?;
    let [x, y, w, h] = slide_frame(doc, slide, id)?;
    let preset = t.tree.path(t.shape, &[(NS_P, "spPr"), (NS_A, "prstGeom")]).and_then(|g| t.tree.node(g).attr("prst")).unwrap_or("rect");
    let mut local = connection_sites(preset, w, h).unwrap_or_default();
    if local.is_empty() {
        // Shapes without sites of their own connect at their edge middles.
        local = vec![Point::new(w / 2.0, 0.0), Point::new(0.0, h / 2.0), Point::new(w / 2.0, h), Point::new(w, h / 2.0)];
    }
    let rot = own_xfrm(&t.tree, t.shape).and_then(|n| t.tree.node(n).attr("rot")).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 60_000.0;
    let c = Point::new(w / 2.0, h / 2.0);
    let turn = kurbo::Affine::translate((x, y)) * kurbo::Affine::rotate_about(rot.to_radians(), c);
    Ok(local.into_iter().map(|p| turn * p).collect())
}

/// Resolves both ends to slide points and glue (shape, site).
fn resolve(doc: &Presentation, slide: usize, start: &End, end: &End) -> Result<((Point, Option<(u32, u32)>), (Point, Option<(u32, u32)>)), Error> {
    let free = |e: &End| -> Result<Option<Point>, Error> {
        match (e.shape_id, e.x, e.y) {
            (None, Some(x), Some(y)) if x.is_finite() && y.is_finite() => Ok(Some(Point::new(x, y))),
            (None, _, _) => Err(Error::InvalidCommand("a connector end needs shapeId or x and y".into())),
            _ => Ok(None),
        }
    };
    let (fs, fe) = (free(start)?, free(end)?);
    let ss = start.shape_id.map(|id| sites_of(doc, slide, id)).transpose()?;
    let es = end.shape_id.map(|id| sites_of(doc, slide, id)).transpose()?;
    let pick = |sites: &[Point], site: Option<u32>, toward: &[Point]| -> Result<u32, Error> {
        match site {
            Some(s) if (s as usize) < sites.len() => Ok(s),
            Some(s) => Err(Error::InvalidCommand(format!("connection site {s}; the shape has {}", sites.len()))),
            None => Ok((0..sites.len()).min_by(|&a, &b| {
                let d = |k: usize| toward.iter().map(|t| sites[k].distance(*t)).fold(f64::MAX, f64::min);
                d(a).total_cmp(&d(b))
            }).unwrap_or(0) as u32),
        }
    };
    let toward_end: Vec<Point> = fe.map(|p| vec![p]).or_else(|| es.clone()).unwrap_or_default();
    let s_idx = ss.as_ref().map(|s| pick(s, start.site, &toward_end)).transpose()?;
    let p0 = match (&ss, s_idx) {
        (Some(s), Some(i)) => s[i as usize],
        _ => fs.expect("checked"),
    };
    let e_idx = es.as_ref().map(|s| pick(s, end.site, &[p0])).transpose()?;
    let p1 = match (&es, e_idx) {
        (Some(s), Some(i)) => s[i as usize],
        _ => fe.expect("checked"),
    };
    Ok(((p0, start.shape_id.zip(s_idx)), (p1, end.shape_id.zip(e_idx))))
}

fn xfrm_xml(a: &str, p0: Point, p1: Point) -> String {
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let flip = format!("{}{}", if p1.x < p0.x { r#" flipH="1""# } else { "" }, if p1.y < p0.y { r#" flipV="1""# } else { "" });
    format!(r#"<{a}xfrm{flip}><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm>"#, e(p0.x.min(p1.x)), e(p0.y.min(p1.y)), e((p1.x - p0.x).abs()), e((p1.y - p0.y).abs()))
}

fn glue_xml(a: &str, start: Option<(u32, u32)>, end: Option<(u32, u32)>) -> String {
    let mut s = String::new();
    if let Some((id, idx)) = start {
        s.push_str(&format!(r#"<{a}stCxn id="{id}" idx="{idx}"/>"#));
    }
    if let Some((id, idx)) = end {
        s.push_str(&format!(r#"<{a}endCxn id="{id}" idx="{idx}"/>"#));
    }
    s
}

/// A connector (`straightConnector1`, `bentConnector3`, `curvedConnector3`)
/// between two shapes or points, with optional colour, width and end arrow.
#[allow(clippy::too_many_arguments)]
pub fn add_connector(doc: &mut Presentation, slide: usize, preset: &str, start: &End, end: &End, color: Option<&str>, width: Option<f64>, arrow: Option<&str>) -> Result<Value, Error> {
    if !matches!(preset, "straightConnector1" | "bentConnector2" | "bentConnector3" | "curvedConnector3" | "line") {
        return Err(Error::InvalidCommand(format!("connector {preset:?}; one of straightConnector1, bentConnector2, bentConnector3, curvedConnector3, line")));
    }
    let color = color.map(parse_color).transpose()?;
    if let Some(w) = width.filter(|w| !(0.0..=1584.0).contains(w)) {
        return Err(Error::InvalidCommand(format!("line width {w} outside 0-1584 pt")));
    }
    if let Some(a) = arrow.filter(|a| !matches!(*a, "none" | "triangle" | "stealth" | "diamond" | "oval" | "arrow")) {
        return Err(Error::InvalidCommand(format!("arrow {a:?}")));
    }
    let ((p0, g0), (p1, g1)) = resolve(doc, slide, start, end)?;
    let id = super::create::append_shape(doc, slide, |id, p, a| {
        let mut ln = String::new();
        if let Some(c) = &color {
            ln.push_str(&format!(r#"<{a}solidFill><{a}srgbClr val="{c}"/></{a}solidFill>"#));
        }
        if let Some(t) = arrow.filter(|t| *t != "none") {
            ln.push_str(&format!(r#"<{a}tailEnd type="{t}"/>"#));
        }
        let w = width.map(|w| format!(r#" w="{}""#, (w * EMU_PER_PT).round() as i64)).unwrap_or_default();
        let ln = if ln.is_empty() && w.is_empty() { String::new() } else { format!("<{a}ln{w}>{ln}</{a}ln>") };
        format!(
            r#"<{p}cxnSp><{p}nvCxnSpPr><{p}cNvPr id="{id}" name="Connector {}"/><{p}cNvCxnSpPr>{}</{p}cNvCxnSpPr><{p}nvPr/></{p}nvCxnSpPr><{p}spPr>{}<{a}prstGeom prst="{preset}"><{a}avLst/></{a}prstGeom>{ln}</{p}spPr><{p}style><{a}lnRef idx="1"><{a}schemeClr val="accent1"/></{a}lnRef><{a}fillRef idx="0"><{a}schemeClr val="accent1"/></{a}fillRef><{a}effectRef idx="0"><{a}schemeClr val="accent1"/></{a}effectRef><{a}fontRef idx="minor"><{a}schemeClr val="tx1"/></{a}fontRef></{p}style></{p}cxnSp>"#,
            id - 1,
            glue_xml(a, g0, g1),
            xfrm_xml(a, p0, p1)
        )
    })?;
    Ok(json!({ "op": "add_connector", "slide": slide, "shapeId": id, "changed": true }))
}

/// Re-attaches or re-routes a connector; an end left out keeps its glue
/// (re-measured, since the shapes may have moved).
pub fn set_connector(doc: &mut Presentation, slide: usize, id: u32, start: Option<&End>, end: Option<&End>, preset: Option<&str>) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    if t.tree.node(t.shape).local != "cxnSp" {
        return Err(Error::InvalidCommand(format!("shape {id} is not a connector")));
    }
    let nv = non_visual(&t.tree, t.shape).and_then(|c| t.tree.node(c).parent).and_then(|nv| t.tree.child(nv, NS_P, "cNvCxnSpPr")).ok_or_else(|| Error::Xml("connector without cNvCxnSpPr".into()))?;
    let glue = |name: &str| t.tree.child(nv, NS_A, name).and_then(|g| Some(End { shape_id: t.tree.node(g).attr("id")?.parse().ok(), site: t.tree.node(g).attr("idx")?.parse().ok(), x: None, y: None }));
    let [x, y, w, h] = slide_frame(doc, slide, id)?;
    let xn = own_xfrm(&t.tree, t.shape).map(|n| t.tree.node(n));
    let (fh, fv) = (xn.is_some_and(|n| n.attr("flipH") == Some("1")), xn.is_some_and(|n| n.attr("flipV") == Some("1")));
    let here0 = End { shape_id: None, site: None, x: Some(if fh { x + w } else { x }), y: Some(if fv { y + h } else { y }) };
    let here1 = End { shape_id: None, site: None, x: Some(if fh { x } else { x + w }), y: Some(if fv { y } else { y + h }) };
    let s = start.cloned().or_else(|| glue("stCxn")).unwrap_or(here0);
    let e = end.cloned().or_else(|| glue("endCxn")).unwrap_or(here1);
    let ((p0, g0), (p1, g1)) = resolve(doc, slide, &s, &e)?;
    let a = drawing_prefix(&t.tree)?;
    let mut edits: Vec<Edit> = Vec::new();
    let nvn = t.tree.node(nv);
    let mut insert = Vec::new();
    if let Some((sid, idx)) = g0 {
        insert.push(("stCxn", format!(r#"<{a}stCxn id="{sid}" idx="{idx}"/>"#).into_bytes()));
    }
    if let Some((eid, idx)) = g1 {
        insert.push(("endCxn", format!(r#"<{a}endCxn id="{eid}" idx="{idx}"/>"#).into_bytes()));
    }
    let glue_change = Change { remove: vec!["stCxn", "endCxn"], insert, order: &["cxnSpLocks", "stCxn", "endCxn", "extLst"], ..Default::default() };
    edits.push((nvn.start..nvn.end, rebuild(&t.src, &t.tree, nv, &glue_change)?));
    let sp = t.tree.child(t.shape, NS_P, "spPr").ok_or_else(|| Error::Xml("connector without spPr".into()))?;
    let mut change = Change { remove: vec!["xfrm"], insert: vec![("xfrm", xfrm_xml(&a, p0, p1).into_bytes())], order: super::shape::SP_PR_ORDER, ..Default::default() };
    if let Some(pr) = preset {
        if !is_preset(pr) {
            return Err(Error::InvalidCommand(format!("unknown connector shape {pr:?}")));
        }
        change.remove.push("prstGeom");
        change.insert.push(("prstGeom", format!(r#"<{a}prstGeom prst="{pr}"><{a}avLst/></{a}prstGeom>"#).into_bytes()));
    }
    let spn = t.tree.node(sp);
    edits.push((spn.start..spn.end, rebuild(&t.src, &t.tree, sp, &change)?));
    edits.sort_by_key(|e| e.0.start);
    super::shape::commit(doc, &t, edits)?;
    Ok(json!({ "op": "set_connector", "slide": slide, "shapeId": id, "changed": true }))
}

/// A freeform line or shape through `points` (slide points).
pub fn add_freeform(doc: &mut Presentation, slide: usize, points: &[[f64; 2]], closed: bool, fill: Option<&str>, line: Option<&str>) -> Result<Value, Error> {
    if points.len() < 2 || points.iter().flatten().any(|v| !v.is_finite()) {
        return Err(Error::InvalidCommand("a freeform needs two or more points".into()));
    }
    let fill = fill.map(parse_color).transpose()?;
    let line = line.map(parse_color).transpose()?;
    let (x0, y0) = points.iter().fold((f64::MAX, f64::MAX), |b, p| (b.0.min(p[0]), b.1.min(p[1])));
    let (x1, y1) = points.iter().fold((f64::MIN, f64::MIN), |b, p| (b.0.max(p[0]), b.1.max(p[1])));
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let (w, h) = (e(x1 - x0).max(1), e(y1 - y0).max(1));
    let id = super::create::append_shape(doc, slide, |id, p, a| {
        let pt = |q: &[f64; 2]| format!(r#"<{a}pt x="{}" y="{}"/>"#, e(q[0] - x0), e(q[1] - y0));
        let mut path = format!("<{a}moveTo>{}</{a}moveTo>", pt(&points[0]));
        for q in &points[1..] {
            path.push_str(&format!("<{a}lnTo>{}</{a}lnTo>", pt(q)));
        }
        if closed {
            path.push_str(&format!("<{a}close/>"));
        }
        let fill_xml = match (&fill, closed) {
            (Some(c), _) => format!(r#"<{a}solidFill><{a}srgbClr val="{c}"/></{a}solidFill>"#),
            (None, false) => format!("<{a}noFill/>"),
            (None, true) => String::new(),
        };
        let line_xml = line.as_ref().map(|c| format!(r#"<{a}ln><{a}solidFill><{a}srgbClr val="{c}"/></{a}solidFill></{a}ln>"#)).unwrap_or_default();
        format!(
            r#"<{p}sp><{p}nvSpPr><{p}cNvPr id="{id}" name="Freeform {}"/><{p}cNvSpPr/><{p}nvPr/></{p}nvSpPr><{p}spPr><{a}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{w}" cy="{h}"/></{a}xfrm><{a}custGeom><{a}avLst/><{a}gdLst/><{a}ahLst/><{a}cxnLst/><{a}rect l="0" t="0" r="r" b="b"/><{a}pathLst><{a}path w="{w}" h="{h}">{path}</{a}path></{a}pathLst></{a}custGeom>{fill_xml}{line_xml}</{p}spPr><{p}style><{a}lnRef idx="2"><{a}schemeClr val="accent1"><{a}shade val="15000"/></{a}schemeClr></{a}lnRef><{a}fillRef idx="1"><{a}schemeClr val="accent1"/></{a}fillRef><{a}effectRef idx="0"><{a}schemeClr val="accent1"/></{a}effectRef><{a}fontRef idx="minor"><{a}schemeClr val="lt1"/></{a}fontRef></{p}style></{p}sp>"#,
            id - 1,
            e(x0),
            e(y0)
        )
    })?;
    Ok(json!({ "op": "add_freeform", "slide": slide, "shapeId": id, "changed": true }))
}
