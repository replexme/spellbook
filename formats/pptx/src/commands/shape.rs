//! Commands on a whole shape: position, size, rotation, flips, names, fill,
//! outline and deletion. Positions and sizes are slide points, as `observe`
//! reports them.

use serde_json::{json, Value};

use super::xmledit::{drawing_prefix, rebuild, start_tag, Change};
use super::{check_scope, find_shape, EMU_PER_PT};
use crate::render::{effective_xfrm, read_xfrm};
use crate::xml::{splice, Tree, NS_A, NS_P};
use crate::{non_visual, Error, Presentation};

/// Children of `p:spPr` in schema order.
pub(super) const SP_PR_ORDER: &[&str] = &[
    "xfrm", "custGeom", "prstGeom", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst",
];
const FILLS: &[&str] = &["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
/// Children of `a:ln` in schema order.
const LN_ORDER: &[&str] = &["noFill", "solidFill", "gradFill", "pattFill", "prstDash", "custDash", "round", "bevel", "miter", "headEnd", "tailEnd", "extLst"];
/// Largest coordinate DrawingML allows (ST_Coordinate), in EMU.
const MAX_EMU: f64 = 27_273_042_316_900.0;

/// A slide part parsed once for an edit of one shape.
pub(super) struct Target {
    pub part: String,
    pub src: Vec<u8>,
    pub tree: Tree,
    pub shape: usize,
}

pub(super) fn target(doc: &Presentation, slide: usize, id: u32) -> Result<Target, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let sp_tree = tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound(format!("shape tree in {part}")))?;
    let shape = find_shape(&tree, sp_tree, id).ok_or_else(|| Error::NotFound(format!("shape {id} on slide {slide}")))?;
    Ok(Target { part, src, tree, shape })
}

/// Applies `edits` inside the target shape and writes the part back.
pub(super) fn commit(doc: &mut Presentation, t: &Target, edits: Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<bool, Error> {
    if edits.is_empty() {
        return Ok(false);
    }
    let updated = splice(&t.src, edits)?;
    let n = t.tree.node(t.shape);
    check_scope(&t.src, &updated, n.start, n.end)?;
    let changed = updated != t.src;
    doc.package_mut().write(&t.part, updated)?;
    Ok(changed)
}

fn result(op: &str, t: &Target, slide: usize, id: u32, changed: bool) -> Value {
    json!({ "op": op, "part": t.part, "slide": slide, "shapeId": id, "changed": changed })
}

/// Parses `RRGGBB` or `#RRGGBB`.
pub(super) fn parse_color(color: &str) -> Result<String, Error> {
    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(hex.to_ascii_uppercase())
    } else {
        Err(Error::InvalidCommand(format!("colour must be RRGGBB hex, got {color:?}")))
    }
}

pub(super) fn solid_fill(prefix: &str, rgb: &str) -> Vec<u8> {
    format!(r#"<{prefix}solidFill><{prefix}srgbClr val="{rgb}"/></{prefix}solidFill>"#).into_bytes()
}

fn finite(name: &str, v: f64) -> Result<f64, Error> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(Error::InvalidCommand(format!("{name} must be a finite number")))
    }
}

/// The shape's properties element (`p:spPr`, or `p:grpSpPr` for a group).
fn properties(t: &Target) -> Result<usize, Error> {
    let n = t.tree.node(t.shape);
    let local = match n.local.as_str() {
        "sp" | "pic" | "cxnSp" => "spPr",
        "grpSp" => "grpSpPr",
        other => return Err(Error::Unsupported(format!("<{other}> has no shape properties to edit"))),
    };
    t.tree.child(t.shape, NS_P, local).ok_or_else(|| Error::Xml(format!("shape has no <{local}>")))
}

/// Maps between slide points and the shape's parent coordinates (groups).
/// Scale and offset only: a rotated or flipped group is refused.
struct ParentSpace {
    scale: (f64, f64),
    offset: (f64, f64),
}

impl ParentSpace {
    fn of(t: &Target) -> Result<Self, Error> {
        let mut groups = Vec::new();
        let mut at = t.tree.node(t.shape).parent;
        while let Some(p) = at {
            if t.tree.node(p).is(NS_P, "grpSp") {
                groups.push(p);
            }
            at = t.tree.node(p).parent;
        }
        // slide = scale * parent + offset, composed from the outermost group in.
        let (mut scale, mut offset) = ((1.0, 1.0), (0.0, 0.0));
        for &g in groups.iter().rev() {
            let x = t.tree.path(g, &[(NS_P, "grpSpPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&t.tree, x)).ok_or_else(|| Error::Unsupported("group without a position".into()))?;
            if x.rot != 0.0 || x.flip_h || x.flip_v {
                return Err(Error::Unsupported("shape is inside a rotated or flipped group".into()));
            }
            let ch = x.child.unwrap_or(x.rect);
            let s = (x.rect.width() / ch.width().max(1e-9), x.rect.height() / ch.height().max(1e-9));
            // child -> group parent: rect.x0 + (c - ch.x0) * s
            let local = ((s.0, s.1), (x.rect.x0 - ch.x0 * s.0, x.rect.y0 - ch.y0 * s.1));
            offset = (offset.0 + scale.0 * local.1 .0, offset.1 + scale.1 * local.1 .1);
            scale = (scale.0 * local.0 .0, scale.1 * local.0 .1);
        }
        Ok(Self { scale, offset })
    }
}

/// A shape position in EMU of its parent space plus rotation and flips.
struct Placement {
    x: i64,
    y: i64,
    cx: i64,
    cy: i64,
    rot: i64,
    flip_h: bool,
    flip_v: bool,
}

/// Where the shape's `a:xfrm` lives, or where one would be inserted.
fn xfrm_node(t: &Target) -> Result<(Option<usize>, usize), Error> {
    if t.tree.node(t.shape).local == "graphicFrame" {
        let x = t.tree.child(t.shape, NS_P, "xfrm").ok_or_else(|| Error::Xml("graphic frame without <p:xfrm>".into()))?;
        return Ok((Some(x), t.shape));
    }
    let props = properties(t)?;
    Ok((t.tree.child(props, NS_A, "xfrm"), props))
}

fn edit_placement(doc: &mut Presentation, slide: usize, id: u32, op: &str, f: impl FnOnce(&mut Placement, &ParentSpace) -> Result<(), Error>) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let space = ParentSpace::of(&t)?;
    let (own, props) = xfrm_node(&t)?;
    let x = match own {
        Some(x) => read_xfrm(&t.tree, x),
        None => effective_xfrm(doc, slide, id)?,
    }
    .ok_or_else(|| Error::Unsupported(format!("shape {id} has no position to start from")))?;
    let emu = |v: f64| (v * EMU_PER_PT).round() as i64;
    let mut p = Placement { x: emu(x.rect.x0), y: emu(x.rect.y0), cx: emu(x.rect.width()), cy: emu(x.rect.height()), rot: (x.rot * 60_000.0).round() as i64, flip_h: x.flip_h, flip_v: x.flip_v };
    // Keep the stored values exactly when they are not changed.
    if let Some(xn) = own {
        let read = |child: &str, a: &str| t.tree.child(xn, NS_A, child).and_then(|c| t.tree.node(c).attr(a)).and_then(|v| v.parse::<i64>().ok());
        p.x = read("off", "x").unwrap_or(p.x);
        p.y = read("off", "y").unwrap_or(p.y);
        p.cx = read("ext", "cx").unwrap_or(p.cx);
        p.cy = read("ext", "cy").unwrap_or(p.cy);
        p.rot = t.tree.node(xn).attr("rot").and_then(|v| v.parse().ok()).unwrap_or(p.rot);
    }
    f(&mut p, &space)?;
    if [p.x, p.y].iter().any(|v| (*v as f64).abs() > MAX_EMU) || [p.cx, p.cy].iter().any(|v| *v < 0 || *v as f64 > MAX_EMU) {
        return Err(Error::InvalidCommand("position or size out of range".into()));
    }
    let attrs = vec![
        ("rot", (p.rot != 0).then(|| p.rot.to_string())),
        ("flipH", p.flip_h.then(|| "1".to_owned())),
        ("flipV", p.flip_v.then(|| "1".to_owned())),
    ];
    let mut edits = Vec::new();
    match own {
        Some(xn) => {
            let n = t.tree.node(xn);
            if n.is_empty_element() {
                return Err(Error::Xml("empty <a:xfrm>".into()));
            }
            // The start tag alone; off and ext are separate edits.
            edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, xn, &attrs, false)?));
            for (child, a, b) in [("off", ("x", p.x), ("y", p.y)), ("ext", ("cx", p.cx), ("cy", p.cy))] {
                let c = t.tree.child(xn, NS_A, child).ok_or_else(|| Error::Xml(format!("<a:xfrm> without <a:{child}>")))?;
                let change = Change { attrs: vec![(a.0, Some(a.1.to_string())), (b.0, Some(b.1.to_string()))], ..Default::default() };
                edits.push((t.tree.node(c).start..t.tree.node(c).end, rebuild(&t.src, &t.tree, c, &change)?));
            }
        }
        None => {
            let a = drawing_prefix(&t.tree)?;
            let mut head = format!("<{a}xfrm");
            for (k, v) in &attrs {
                if let Some(v) = v {
                    head.push_str(&format!(r#" {k}="{v}""#));
                }
            }
            let xfrm = format!(r#"{head}><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm>"#, p.x, p.y, p.cx, p.cy);
            let change = Change { insert: vec![("xfrm", xfrm.into_bytes())], order: SP_PR_ORDER, ..Default::default() };
            edits.push((t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &change)?));
        }
    }
    let changed = commit(doc, &t, edits)?;
    Ok(result(op, &t, slide, id, changed))
}

/// The shape's box on the slide (x, y, width, height in points).
pub(super) fn slide_frame(doc: &Presentation, slide: usize, id: u32) -> Result<[f64; 4], Error> {
    let t = target(doc, slide, id)?;
    let space = ParentSpace::of(&t)?;
    let (own, _) = xfrm_node(&t)?;
    let x = match own {
        Some(x) => read_xfrm(&t.tree, x),
        None => effective_xfrm(doc, slide, id)?,
    }
    .ok_or_else(|| Error::Unsupported(format!("shape {id} has no position")))?;
    Ok([
        space.offset.0 + space.scale.0 * x.rect.x0,
        space.offset.1 + space.scale.1 * x.rect.y0,
        space.scale.0 * x.rect.width(),
        space.scale.1 * x.rect.height(),
    ])
}

pub fn move_to(doc: &mut Presentation, slide: usize, id: u32, x: f64, y: f64) -> Result<Value, Error> {
    let (x, y) = (finite("x", x)?, finite("y", y)?);
    edit_placement(doc, slide, id, "move", |p, s| {
        p.x = (((x - s.offset.0) / s.scale.0) * EMU_PER_PT).round() as i64;
        p.y = (((y - s.offset.1) / s.scale.1) * EMU_PER_PT).round() as i64;
        Ok(())
    })
}

pub fn resize(doc: &mut Presentation, slide: usize, id: u32, width: f64, height: f64) -> Result<Value, Error> {
    let (w, h) = (finite("width", width)?, finite("height", height)?);
    if w < 0.0 || h < 0.0 {
        return Err(Error::InvalidCommand("width and height must not be negative".into()));
    }
    edit_placement(doc, slide, id, "resize", |p, s| {
        p.cx = ((w / s.scale.0) * EMU_PER_PT).round() as i64;
        p.cy = ((h / s.scale.1) * EMU_PER_PT).round() as i64;
        Ok(())
    })
}

pub fn rotate(doc: &mut Presentation, slide: usize, id: u32, degrees: f64) -> Result<Value, Error> {
    let d = finite("degrees", degrees)?.rem_euclid(360.0);
    edit_placement(doc, slide, id, "rotate", |p, _| {
        p.rot = ((d * 60_000.0).round() as i64) % 21_600_000;
        Ok(())
    })
}

pub fn flip(doc: &mut Presentation, slide: usize, id: u32, horizontal: Option<bool>, vertical: Option<bool>) -> Result<Value, Error> {
    if horizontal.is_none() && vertical.is_none() {
        return Err(Error::InvalidCommand("flip needs horizontal or vertical".into()));
    }
    edit_placement(doc, slide, id, "flip", |p, _| {
        p.flip_h = horizontal.unwrap_or(p.flip_h);
        p.flip_v = vertical.unwrap_or(p.flip_v);
        Ok(())
    })
}

/// Sets an attribute of the shape's `p:cNvPr` (`name`, `descr`).
pub fn set_non_visual(doc: &mut Presentation, slide: usize, id: u32, op: &str, attr: &str, value: &str) -> Result<Value, Error> {
    if value.chars().any(|c| c.is_control() && c != '\t' && c != '\n') {
        return Err(Error::InvalidCommand(format!("{attr} contains control characters")));
    }
    let t = target(doc, slide, id)?;
    let cnv = non_visual(&t.tree, t.shape).ok_or_else(|| Error::Unsupported("shape without non-visual properties".into()))?;
    let n = t.tree.node(cnv);
    let change = Change { attrs: vec![(attr, Some(value.to_owned()))], ..Default::default() };
    let bytes = rebuild(&t.src, &t.tree, cnv, &change)?;
    let changed = commit(doc, &t, vec![(n.start..n.end, bytes)])?;
    Ok(result(op, &t, slide, id, changed))
}

/// Does an animation or a connector outside the shape refer to its id?
/// Removing such a shape makes PowerPoint repair the file.
pub(super) fn referenced_elsewhere(t: &Target, id: u32) -> bool {
    let id_text = id.to_string();
    let (start, end) = (t.tree.node(t.shape).start, t.tree.node(t.shape).end);
    t.tree.nodes.iter().any(|n| {
        let outside = n.start < start || n.start >= end;
        outside && ((n.local == "spTgt" && n.attr("spid") == Some(&id_text)) || ((n.local == "stCxn" || n.local == "endCxn") && n.attr("id") == Some(&id_text)))
    })
}

/// Removes a shape. Refused while an animation or a connector refers to it,
/// since PowerPoint would then repair the file.
pub fn delete_element(doc: &mut Presentation, slide: usize, id: u32) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let shape_range = t.tree.node(t.shape).start..t.tree.node(t.shape).end;
    if referenced_elsewhere(&t, id) {
        return Err(Error::Unsupported(format!("shape {id} is used by an animation or a connector")));
    }
    let changed = commit(doc, &t, vec![(shape_range, Vec::new())])?;
    Ok(result("delete_element", &t, slide, id, changed))
}

/// An explicit fill replaces "filled with the slide background"
/// (`useBgFill`), as PowerPoint's own fill change does.
pub(super) fn drop_background_fill(t: &Target) -> Result<Option<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    let n = t.tree.node(t.shape);
    if n.attr("useBgFill").is_none() {
        return Ok(None);
    }
    Ok(Some((n.start..n.open_end, start_tag(&t.src, &t.tree, t.shape, &[("useBgFill", None)], false)?)))
}

pub fn fill_color(doc: &mut Presentation, slide: usize, id: u32, color: &str) -> Result<Value, Error> {
    let rgb = parse_color(color)?;
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let a = drawing_prefix(&t.tree)?;
    let change = Change { remove: FILLS.to_vec(), insert: vec![("solidFill", solid_fill(&a, &rgb))], order: SP_PR_ORDER, ..Default::default() };
    let n = t.tree.node(props);
    let mut edits = vec![(n.start..n.end, rebuild(&t.src, &t.tree, props, &change)?)];
    edits.extend(drop_background_fill(&t)?);
    let changed = commit(doc, &t, edits)?;
    Ok(result("fill_color", &t, slide, id, changed))
}

/// Edits the shape's own `a:ln`, adding one when the line comes from the
/// theme style.
fn edit_line(doc: &mut Presentation, slide: usize, id: u32, op: &str, change: Change, new_ln: impl FnOnce(&str) -> String) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let edit = match t.tree.child(props, NS_A, "ln") {
        Some(ln) => (t.tree.node(ln).start..t.tree.node(ln).end, rebuild(&t.src, &t.tree, ln, &change)?),
        None => {
            let a = drawing_prefix(&t.tree)?;
            let insert = Change { insert: vec![("ln", new_ln(&a).into_bytes())], order: SP_PR_ORDER, ..Default::default() };
            (t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &insert)?)
        }
    };
    let changed = commit(doc, &t, vec![edit])?;
    Ok(result(op, &t, slide, id, changed))
}

pub fn line_color(doc: &mut Presentation, slide: usize, id: u32, color: &str) -> Result<Value, Error> {
    let rgb = parse_color(color)?;
    let a = {
        let t = target(doc, slide, id)?;
        drawing_prefix(&t.tree)?
    };
    let fill = solid_fill(&a, &rgb);
    let change = Change { remove: vec!["noFill", "solidFill", "gradFill", "pattFill"], insert: vec![("solidFill", fill.clone())], order: LN_ORDER, ..Default::default() };
    edit_line(doc, slide, id, "line_color", change, |a| format!("<{a}ln>{}</{a}ln>", String::from_utf8_lossy(&fill)))
}

pub fn line_width(doc: &mut Presentation, slide: usize, id: u32, width: f64) -> Result<Value, Error> {
    let w = finite("width", width)?;
    if !(0.0..=1584.0).contains(&w) {
        return Err(Error::InvalidCommand("line width must be 0 to 1584 pt".into()));
    }
    let emu = (w * EMU_PER_PT).round() as i64;
    let change = Change { attrs: vec![("w", Some(emu.to_string()))], order: LN_ORDER, ..Default::default() };
    edit_line(doc, slide, id, "line_width", change, |a| format!(r#"<{a}ln w="{emu}"/>"#))
}

/// Shows or hides a slide in the slide show (`p:sld/@show`).
pub fn set_slide_hidden(doc: &mut Presentation, slide: usize, hidden: bool) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let root = tree.node(tree.root);
    let tag = start_tag(&src, &tree, tree.root, &[("show", hidden.then(|| "0".to_owned()))], false)?;
    let updated = splice(&src, vec![(root.start..root.open_end, tag)])?;
    check_scope(&src, &updated, root.start, root.open_end)?;
    let changed = updated != src;
    doc.package_mut().write(&part, updated)?;
    Ok(json!({ "op": "set_slide_hidden", "part": part, "slide": slide, "hidden": hidden, "changed": changed }))
}
