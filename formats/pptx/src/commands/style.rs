//! Shape styling and arrangement: fills, transparency, outline style,
//! shadows, locks, cropping and stacking order.

use serde_json::{json, Value};

use super::shape::{commit, parse_color, solid_fill, target, Target, SP_PR_ORDER};
use super::xmledit::{drawing_prefix, rebuild, Change};
use super::{check_scope, EMU_PER_PT};
use crate::xml::{splice, NS_A, NS_P};
use crate::{non_visual, Error, Presentation};

const COLORS: &[&str] = &["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"];
const FILLS: &[&str] = &["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
/// Children of `a:ln` in schema order.
const LN_ORDER: &[&str] = &["noFill", "solidFill", "gradFill", "pattFill", "prstDash", "custDash", "round", "bevel", "miter", "headEnd", "tailEnd", "extLst"];
/// Children of `a:effectLst` in schema order.
const EFFECT_ORDER: &[&str] = &["blur", "fillOverlay", "glow", "innerShdw", "outerShdw", "prstShdw", "reflection", "softEdge"];
const DASHES: &[&str] = &["solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot"];
const ARROWS: &[&str] = &["none", "triangle", "stealth", "diamond", "oval", "arrow"];

/// An outer shadow. Defaults are PowerPoint's "Offset: Bottom Right".
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shadow {
    pub rgb: [u8; 3],
    /// 0 (invisible) to 1 (opaque).
    pub opacity: f64,
    /// Blur radius in points.
    pub blur: f64,
    /// Offset in points.
    pub distance: f64,
    /// Direction in degrees clockwise from the x axis (45 = down right).
    pub angle: f64,
}

impl Default for Shadow {
    fn default() -> Self {
        Self { rgb: [0, 0, 0], opacity: 0.4, blur: 4.0, distance: 3.0, angle: 45.0 }
    }
}

impl Shadow {
    pub fn validate(&self) -> Result<(), Error> {
        let ok = (0.0..=1.0).contains(&self.opacity) && (0.0..=1584.0).contains(&self.blur) && (0.0..=1584.0).contains(&self.distance) && self.angle.is_finite();
        if ok {
            Ok(())
        } else {
            Err(Error::InvalidCommand("shadow needs opacity 0-1, blur and distance 0-1584 pt".into()))
        }
    }

    /// `a:outerShdw` with prefix `a`.
    pub fn xml(&self, a: &str) -> String {
        let [r, g, b] = self.rgb;
        format!(
            r#"<{a}outerShdw blurRad="{}" dist="{}" dir="{}" algn="tl" rotWithShape="0"><{a}srgbClr val="{r:02X}{g:02X}{b:02X}"><{a}alpha val="{}"/></{a}srgbClr></{a}outerShdw>"#,
            (self.blur * EMU_PER_PT).round() as i64,
            (self.distance * EMU_PER_PT).round() as i64,
            ((self.angle.rem_euclid(360.0)) * 60_000.0).round() as i64 % 21_600_000,
            (self.opacity * 100_000.0).round() as i64
        )
    }

    /// A shadow from optional command fields.
    pub fn from_parts(color: Option<&str>, opacity: Option<f64>, blur: Option<f64>, distance: Option<f64>, angle: Option<f64>) -> Result<Self, Error> {
        let d = Self::default();
        let rgb = match color {
            Some(c) => {
                let hex = parse_color(c)?;
                let v = u32::from_str_radix(&hex, 16).expect("validated hex");
                [(v >> 16) as u8, (v >> 8) as u8, v as u8]
            }
            None => d.rgb,
        };
        let s = Self { rgb, opacity: opacity.unwrap_or(d.opacity), blur: blur.unwrap_or(d.blur), distance: distance.unwrap_or(d.distance), angle: angle.unwrap_or(d.angle) };
        s.validate()?;
        Ok(s)
    }
}

fn result(op: &str, t: &Target, slide: usize, id: u32, changed: bool) -> Value {
    json!({ "op": op, "part": t.part, "slide": slide, "shapeId": id, "changed": changed })
}

fn properties(t: &Target) -> Result<usize, Error> {
    let n = t.tree.node(t.shape);
    let local = match n.local.as_str() {
        "sp" | "pic" | "cxnSp" => "spPr",
        "grpSp" => "grpSpPr",
        other => return Err(Error::Unsupported(format!("<{other}> has no shape properties to edit"))),
    };
    t.tree.child(t.shape, NS_P, local).ok_or_else(|| Error::Xml(format!("shape has no <{local}>")))
}

/// Sets or removes `a:alpha` on every colour inside `fill` (a fill element).
fn alpha_edits(t: &Target, fill: usize, opacity: f64) -> Result<Vec<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    let a = drawing_prefix(&t.tree)?;
    let mut edits = Vec::new();
    let n = t.tree.node(fill);
    let colors: Vec<usize> = t.tree.nodes.iter().enumerate().filter(|(_, c)| c.start >= n.start && c.end <= n.end && c.ns.as_deref() == Some(NS_A) && COLORS.contains(&c.local.as_str())).map(|(i, _)| i).collect();
    if colors.is_empty() {
        return Err(Error::Unsupported("fill has no colour".into()));
    }
    for c in colors {
        let insert = if opacity < 1.0 { vec![("alpha", format!(r#"<{a}alpha val="{}"/>"#, (opacity * 100_000.0).round() as i64).into_bytes())] } else { vec![] };
        let change = Change { remove: vec!["alpha"], insert, ..Default::default() };
        edits.push((t.tree.node(c).start..t.tree.node(c).end, rebuild(&t.src, &t.tree, c, &change)?));
    }
    Ok(edits)
}

fn check_opacity(opacity: f64) -> Result<(), Error> {
    if (0.0..=1.0).contains(&opacity) {
        Ok(())
    } else {
        Err(Error::InvalidCommand("opacity must be 0 to 1".into()))
    }
}

/// The theme of the target's slide (slide -> layout -> master -> theme):
/// its source bytes and tree.
fn slide_theme(doc: &Presentation, t: &Target) -> Result<Option<(Vec<u8>, crate::xml::Tree)>, Error> {
    let rel = |part: &str, suffix: &str| -> Result<Option<String>, Error> {
        Ok(crate::read_relationships(doc.package(), &crate::rels_part_for(part), part)?.into_iter().find(|r| r.rel_type.ends_with(suffix)).map(|r| r.target))
    };
    let Some(layout) = rel(&t.part, "/slideLayout")? else { return Ok(None) };
    let Some(master) = rel(&layout, "/slideMaster")? else { return Ok(None) };
    let Some(theme) = rel(&master, "/theme")? else { return Ok(None) };
    let src = doc.package().read(&theme)?.to_vec();
    let tree = crate::xml::Tree::parse(&src)?;
    Ok(Some((src, tree)))
}

/// The effects of the theme style a shape's `p:style/a:effectRef` points at,
/// as children for the shape's own `a:effectLst`: a shape's own list
/// replaces the style's, so those effects are carried over when one is
/// first written. Refused when they use the style colour (`phClr`).
fn style_effects(doc: &Presentation, t: &Target, a: &str) -> Result<Vec<u8>, Error> {
    let Some(effect_ref) = t.tree.path(t.shape, &[(NS_P, "style"), (NS_A, "effectRef")]) else { return Ok(Vec::new()) };
    let idx: usize = t.tree.node(effect_ref).attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
    if idx == 0 {
        return Ok(Vec::new());
    }
    let Some((src, tree)) = slide_theme(doc, t)? else { return Ok(Vec::new()) };
    let Some(list) = tree.nodes.iter().position(|n| n.local == "effectStyleLst") else { return Ok(Vec::new()) };
    let Some(&style) = tree.node(list).children.get(idx - 1) else { return Ok(Vec::new()) };
    let Some(effects) = tree.child(style, NS_A, "effectLst") else {
        return if tree.child(style, NS_A, "effectDag").is_some() { Err(Error::Unsupported("the shape's theme effects are an effect graph (effectDag)".into())) } else { Ok(Vec::new()) };
    };
    let n = tree.node(effects);
    if n.is_empty_element() || n.children.is_empty() {
        return Ok(Vec::new());
    }
    let inner = &src[n.open_end..n.close_start];
    let text = std::str::from_utf8(inner).map_err(|e| Error::Xml(e.to_string()))?;
    let theme_prefix = tree.node(n.children[0]).qname.split_once(':').map(|(p, _)| format!("{p}:")).unwrap_or_default();
    if text.contains("phClr") || theme_prefix != a {
        return Err(Error::Unsupported("the shape's theme effects use the style colour; set its effects from scratch first".into()));
    }
    Ok(inner.to_vec())
}

/// Replaces the effects named in `remove` in the shape's own `a:effectLst`
/// with `insert`. A shape without its own list gets one holding its theme
/// style's effects plus the change; an empty list then switches the style's
/// effects off.
fn edit_effects(doc: &Presentation, t: &Target, remove: &[&str], insert: Vec<(&str, Vec<u8>)>) -> Result<(std::ops::Range<usize>, Vec<u8>), Error> {
    let props = properties(t)?;
    let a = drawing_prefix(&t.tree)?;
    if let Some(list) = t.tree.child(props, NS_A, "effectLst") {
        let change = Change { remove: remove.to_vec(), insert, order: EFFECT_ORDER, ..Default::default() };
        return Ok((t.tree.node(list).start..t.tree.node(list).end, rebuild(&t.src, &t.tree, list, &change)?));
    }
    // Build the list from the style's effects, then apply the change to it.
    let inherited = style_effects(doc, t, &a)?;
    let decl = match a.trim_end_matches(':') {
        "" => format!(" xmlns=\"{NS_A}\""),
        p => format!(" xmlns:{p}=\"{NS_A}\""),
    };
    let draft = [format!("<{a}effectLst{decl}>").into_bytes(), inherited, format!("</{a}effectLst>").into_bytes()].concat();
    let tree = crate::xml::Tree::parse(&draft)?;
    let rebuilt = rebuild(&draft, &tree, tree.root, &Change { remove: remove.to_vec(), insert, order: EFFECT_ORDER, ..Default::default() })?;
    // Drop the namespace declaration added for parsing.
    let list = String::from_utf8(rebuilt).map_err(|e| Error::Xml(e.to_string()))?.replacen(&decl, "", 1);
    let change = Change { remove: vec!["effectDag"], insert: vec![("effectLst", list.into_bytes())], order: SP_PR_ORDER, ..Default::default() };
    Ok((t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &change)?))
}

/// The theme fill a shape's `p:style/a:fillRef` points at, written out as
/// the shape's own fill: only for a plain solid fill of the placeholder
/// colour, which becomes the colour the reference names.
fn style_solid_fill(doc: &Presentation, t: &Target, opacity: f64) -> Result<Option<Vec<u8>>, Error> {
    let Some(fill_ref) = t.tree.path(t.shape, &[(NS_P, "style"), (NS_A, "fillRef")]) else { return Ok(None) };
    let idx: usize = t.tree.node(fill_ref).attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
    let Some(color) = t.tree.node(fill_ref).children.first().copied() else { return Ok(None) };
    if !(1..1000).contains(&idx) {
        return Ok(None);
    }
    let Some((_, tree)) = slide_theme(doc, t)? else { return Ok(None) };
    let Some(list) = tree.nodes.iter().position(|n| n.local == "fillStyleLst") else { return Ok(None) };
    let Some(&style) = tree.node(list).children.get(idx - 1) else { return Ok(None) };
    let n = tree.node(style);
    let plain = n.local == "solidFill" && n.children.len() == 1 && tree.node(n.children[0]).local == "schemeClr" && tree.node(n.children[0]).attr("val") == Some("phClr") && tree.node(n.children[0]).children.is_empty();
    if !plain {
        return Ok(None);
    }
    let a = drawing_prefix(&t.tree)?;
    let insert = if opacity < 1.0 { vec![("alpha", format!(r#"<{a}alpha val="{}"/>"#, (opacity * 100_000.0).round() as i64).into_bytes())] } else { vec![] };
    let color = rebuild(&t.src, &t.tree, color, &Change { remove: vec!["alpha"], insert, ..Default::default() })?;
    Ok(Some([format!("<{a}solidFill>").into_bytes(), color, format!("</{a}solidFill>").into_bytes()].concat()))
}

/// Transparency of the shape's fill. A fill from the theme style is first
/// written into the shape (same colour) so it can carry the transparency.
pub fn fill_opacity(doc: &mut Presentation, slide: usize, id: u32, opacity: f64) -> Result<Value, Error> {
    check_opacity(opacity)?;
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let own = t.tree.node(props).children.iter().copied().find(|&c| FILLS.contains(&t.tree.node(c).local.as_str()));
    if own.is_none() && t.tree.node(t.shape).attr("useBgFill") == Some("1") {
        return Err(Error::Unsupported("shape is filled with the slide background; set fill_color first".into()));
    }
    let edits = match own {
        Some(fill) if matches!(t.tree.node(fill).local.as_str(), "solidFill" | "gradFill" | "pattFill") => alpha_edits(&t, fill, opacity)?,
        Some(_) => return Err(Error::Unsupported("shape has no fill colour (no fill or a picture fill)".into())),
        None => {
            let fill = style_solid_fill(doc, &t, opacity)?.ok_or_else(|| Error::Unsupported("shape's theme fill is not a plain colour; set fill_color first".into()))?;
            let change = Change { insert: vec![("solidFill", fill)], order: SP_PR_ORDER, ..Default::default() };
            vec![(t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &change)?)]
        }
    };
    let changed = commit(doc, &t, edits)?;
    Ok(result("fill_opacity", &t, slide, id, changed))
}

/// Transparency of the shape's own outline.
pub fn line_opacity(doc: &mut Presentation, slide: usize, id: u32, opacity: f64) -> Result<Value, Error> {
    check_opacity(opacity)?;
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let fill = t
        .tree
        .child(props, NS_A, "ln")
        .and_then(|ln| t.tree.node(ln).children.iter().copied().find(|&c| matches!(t.tree.node(c).local.as_str(), "solidFill" | "gradFill" | "pattFill")))
        .ok_or_else(|| Error::Unsupported("shape has no outline colour of its own; set line_color first".into()))?;
    let edits = alpha_edits(&t, fill, opacity)?;
    let changed = commit(doc, &t, edits)?;
    Ok(result("line_opacity", &t, slide, id, changed))
}

/// Dash pattern and arrowheads of the shape's outline.
pub fn set_line_style(doc: &mut Presentation, slide: usize, id: u32, dash: Option<&str>, head: Option<&str>, tail: Option<&str>) -> Result<Value, Error> {
    if let Some(d) = dash.filter(|d| !DASHES.contains(d)) {
        return Err(Error::InvalidCommand(format!("dash {d:?}; one of {}", DASHES.join(", "))));
    }
    for e in [head, tail].into_iter().flatten() {
        if !ARROWS.contains(&e) {
            return Err(Error::InvalidCommand(format!("arrowhead {e:?}; one of {}", ARROWS.join(", "))));
        }
    }
    if dash.is_none() && head.is_none() && tail.is_none() {
        return Err(Error::InvalidCommand("set_line_style needs dash, head or tail".into()));
    }
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let a = drawing_prefix(&t.tree)?;
    let mut remove = Vec::new();
    let mut insert = Vec::new();
    if let Some(d) = dash {
        remove.extend(["prstDash", "custDash"]);
        insert.push(("prstDash", format!(r#"<{a}prstDash val="{d}"/>"#).into_bytes()));
    }
    for (local, v) in [("headEnd", head), ("tailEnd", tail)] {
        if let Some(v) = v {
            remove.push(local);
            insert.push((local, format!(r#"<{a}{local} type="{v}"/>"#).into_bytes()));
        }
    }
    let edit = match t.tree.child(props, NS_A, "ln") {
        Some(ln) => (t.tree.node(ln).start..t.tree.node(ln).end, rebuild(&t.src, &t.tree, ln, &Change { remove, insert, order: LN_ORDER, ..Default::default() })?),
        None => {
            let mut children: Vec<_> = insert;
            children.sort_by_key(|(l, _)| LN_ORDER.iter().position(|o| o == l));
            let body: Vec<u8> = children.into_iter().flat_map(|(_, b)| b).collect();
            let ln = [format!("<{a}ln>").into_bytes(), body, format!("</{a}ln>").into_bytes()].concat();
            let change = Change { insert: vec![("ln", ln)], order: SP_PR_ORDER, ..Default::default() };
            (t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &change)?)
        }
    };
    let changed = commit(doc, &t, vec![edit])?;
    Ok(result("set_line_style", &t, slide, id, changed))
}

/// No fill, a solid colour, or a linear gradient through `colors`.
pub fn set_shape_fill(doc: &mut Presentation, slide: usize, id: u32, fill: &str, color: Option<&str>, colors: &[String], angle: Option<f64>) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let props = properties(&t)?;
    let a = drawing_prefix(&t.tree)?;
    let bytes = match fill {
        "none" => format!("<{a}noFill/>").into_bytes(),
        "solid" => solid_fill(&a, &parse_color(color.ok_or_else(|| Error::InvalidCommand("solid fill needs color".into()))?)?),
        "gradient" => {
            if colors.len() < 2 {
                return Err(Error::InvalidCommand("gradient needs at least two colors".into()));
            }
            let mut stops = String::new();
            for (k, c) in colors.iter().enumerate() {
                let pos = (k as f64 / (colors.len() - 1) as f64 * 100_000.0).round() as i64;
                stops.push_str(&format!(r#"<{a}gs pos="{pos}"><{a}srgbClr val="{}"/></{a}gs>"#, parse_color(c)?));
            }
            let ang = ((angle.unwrap_or(90.0).rem_euclid(360.0)) * 60_000.0).round() as i64 % 21_600_000;
            format!(r#"<{a}gradFill rotWithShape="1"><{a}gsLst>{stops}</{a}gsLst><{a}lin ang="{ang}" scaled="0"/></{a}gradFill>"#).into_bytes()
        }
        other => return Err(Error::InvalidCommand(format!("fill must be none, solid or gradient, got {other:?}"))),
    };
    let local = match fill {
        "none" => "noFill",
        "solid" => "solidFill",
        _ => "gradFill",
    };
    let change = Change { remove: FILLS.to_vec(), insert: vec![(local, bytes)], order: SP_PR_ORDER, ..Default::default() };
    let n = t.tree.node(props);
    let mut edits = vec![(n.start..n.end, rebuild(&t.src, &t.tree, props, &change)?)];
    edits.extend(super::shape::drop_background_fill(&t)?);
    let changed = commit(doc, &t, edits)?;
    Ok(result("set_shape_fill", &t, slide, id, changed))
}

/// Adds, replaces or switches off the shape's outer shadow.
pub fn set_shape_shadow(doc: &mut Presentation, slide: usize, id: u32, shadow: Option<Shadow>) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let a = drawing_prefix(&t.tree)?;
    let insert = shadow.map(|s| ("outerShdw", s.xml(&a).into_bytes())).into_iter().collect();
    let edit = edit_effects(doc, &t, &["outerShdw"], insert)?;
    let changed = commit(doc, &t, vec![edit])?;
    Ok(result("set_shape_shadow", &t, slide, id, changed))
}

/// A glow around the shape: radius in points, colour and opacity (0 to 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glow {
    pub radius: f64,
    pub rgb: [u8; 3],
    pub opacity: f64,
}

/// A reflection below the shape: `size` is the reflected fraction of the
/// shape's height, `opacity` where it starts (it fades to none), and
/// `distance` and `blur` in points. Defaults are PowerPoint's "Tight
/// Reflection: Touching".
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reflection {
    pub size: f64,
    pub opacity: f64,
    pub distance: f64,
    pub blur: f64,
}

impl Default for Reflection {
    fn default() -> Self {
        Self { size: 0.35, opacity: 0.52, distance: 0.0, blur: 0.5 }
    }
}

fn rgb_of(color: &str) -> Result<[u8; 3], Error> {
    let v = u32::from_str_radix(&parse_color(color)?, 16).expect("validated hex");
    Ok([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

impl Glow {
    pub fn from_parts(radius: f64, color: &str, opacity: Option<f64>) -> Result<Self, Error> {
        let g = Self { radius, rgb: rgb_of(color)?, opacity: opacity.unwrap_or(0.6) };
        if !(radius > 0.0 && radius <= 150.0) || !(0.0..=1.0).contains(&g.opacity) {
            return Err(Error::InvalidCommand("glow needs radius above 0 up to 150 pt and opacity 0-1".into()));
        }
        Ok(g)
    }

    fn xml(&self, a: &str) -> String {
        let [r, g, b] = self.rgb;
        format!(r#"<{a}glow rad="{}"><{a}srgbClr val="{r:02X}{g:02X}{b:02X}"><{a}alpha val="{}"/></{a}srgbClr></{a}glow>"#, (self.radius * EMU_PER_PT).round() as i64, (self.opacity * 100_000.0).round() as i64)
    }
}

impl Reflection {
    pub fn from_parts(size: Option<f64>, opacity: Option<f64>, distance: Option<f64>, blur: Option<f64>) -> Result<Self, Error> {
        let d = Self::default();
        let r = Self { size: size.unwrap_or(d.size), opacity: opacity.unwrap_or(d.opacity), distance: distance.unwrap_or(d.distance), blur: blur.unwrap_or(d.blur) };
        let ok = r.size > 0.0 && r.size <= 1.0 && (0.0..=1.0).contains(&r.opacity) && (0.0..=1584.0).contains(&r.distance) && (0.0..=1584.0).contains(&r.blur);
        if !ok {
            return Err(Error::InvalidCommand("reflection needs size above 0 up to 1, opacity 0-1, distance and blur 0-1584 pt".into()));
        }
        Ok(r)
    }

    /// As PowerPoint writes its reflection presets: mirrored below the
    /// shape, fading to 0.3% opacity.
    fn xml(&self, a: &str) -> String {
        format!(
            r#"<{a}reflection blurRad="{}" stA="{}" endA="300" endPos="{}" dist="{}" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>"#,
            (self.blur * EMU_PER_PT).round() as i64,
            (self.opacity * 100_000.0).round() as i64,
            (self.size * 100_000.0).round() as i64,
            (self.distance * EMU_PER_PT).round() as i64
        )
    }
}

/// Sets, replaces or removes (`Some(None)`) the shape's glow, soft edges
/// (radius in points) and reflection; `None` leaves an effect as it is.
pub fn set_shape_effects(doc: &mut Presentation, slide: usize, id: u32, glow: Option<Option<Glow>>, soft_edge: Option<Option<f64>>, reflection: Option<Option<Reflection>>) -> Result<Value, Error> {
    if glow.is_none() && soft_edge.is_none() && reflection.is_none() {
        return Err(Error::InvalidCommand("set at least one of glow, softEdge and reflection".into()));
    }
    if let Some(Some(r)) = soft_edge {
        if !(r > 0.0 && r <= 1584.0) {
            return Err(Error::InvalidCommand("softEdge radius must be above 0 up to 1584 pt (0 removes it)".into()));
        }
    }
    let t = target(doc, slide, id)?;
    let a = drawing_prefix(&t.tree)?;
    let (mut remove, mut insert) = (Vec::new(), Vec::new());
    if let Some(g) = glow {
        remove.push("glow");
        insert.extend(g.map(|g| ("glow", g.xml(&a).into_bytes())));
    }
    if let Some(r) = reflection {
        remove.push("reflection");
        insert.extend(r.map(|r| ("reflection", r.xml(&a).into_bytes())));
    }
    if let Some(s) = soft_edge {
        remove.push("softEdge");
        insert.extend(s.map(|s| ("softEdge", format!(r#"<{a}softEdge rad="{}"/>"#, (s * EMU_PER_PT).round() as i64).into_bytes())));
    }
    let edit = edit_effects(doc, &t, &remove, insert)?;
    let changed = commit(doc, &t, vec![edit])?;
    Ok(result("set_shape_effects", &t, slide, id, changed))
}

/// Sets or clears protections (`noMove`, `noResize`, ...) on the shape's
/// locks element.
pub fn set_object_lock(doc: &mut Presentation, slide: usize, id: u32, locks: &std::collections::BTreeMap<String, bool>) -> Result<Value, Error> {
    const NAMES: &[&str] = &["noGrp", "noUngrp", "noSelect", "noRot", "noChangeAspect", "noMove", "noResize", "noEditPoints", "noAdjustHandles", "noChangeArrowheads", "noChangeShapeType", "noTextEdit", "noCrop", "noDrilldown"];
    if let Some(bad) = locks.keys().find(|k| !NAMES.contains(&k.as_str())) {
        return Err(Error::InvalidCommand(format!("lock {bad:?}; one of {}", NAMES.join(", "))));
    }
    let t = target(doc, slide, id)?;
    let (props_local, locks_local) = match t.tree.node(t.shape).local.as_str() {
        "sp" => ("cNvSpPr", "spLocks"),
        "pic" => ("cNvPicPr", "picLocks"),
        "cxnSp" => ("cNvCxnSpPr", "cxnSpLocks"),
        "grpSp" => ("cNvGrpSpPr", "grpSpLocks"),
        "graphicFrame" => ("cNvGraphicFramePr", "graphicFrameLocks"),
        other => return Err(Error::Unsupported(format!("locks on <{other}>"))),
    };
    let nv = t.tree.node(t.shape).children.iter().copied().find(|&c| t.tree.node(c).local.starts_with("nv")).ok_or_else(|| Error::Xml("shape without non-visual properties".into()))?;
    let props = t.tree.child(nv, NS_P, props_local).ok_or_else(|| Error::Xml(format!("shape without <{props_local}>")))?;
    let attrs: Vec<(&str, Option<String>)> = locks.iter().map(|(k, v)| (k.as_str(), v.then(|| "1".to_owned()))).collect();
    let a = drawing_prefix(&t.tree)?;
    let edit = match t.tree.child(props, NS_A, locks_local) {
        Some(l) => (t.tree.node(l).start..t.tree.node(l).end, rebuild(&t.src, &t.tree, l, &Change { attrs, ..Default::default() })?),
        None => {
            let mut el = format!("<{a}{locks_local}");
            for (k, v) in &attrs {
                if let Some(v) = v {
                    el.push_str(&format!(r#" {k}="{v}""#));
                }
            }
            el.push_str("/>");
            let change = Change { insert: vec![(locks_local, el.into_bytes())], order: &[locks_local, "extLst"], ..Default::default() };
            (t.tree.node(props).start..t.tree.node(props).end, rebuild(&t.src, &t.tree, props, &change)?)
        }
    };
    let changed = commit(doc, &t, vec![edit])?;
    Ok(result("set_object_lock", &t, slide, id, changed))
}

/// Crops a picture: the fraction (0 to 1) cut from each side, and with `geometry` its outline
/// (`ellipse`: the picture shows inside the oval of its box, as PowerPoint's "Crop to Shape"
/// writes it; `rect`: a plain rectangle again).
/// Without `crop` ([left, top, right, bottom]) the picture keeps its framing.
pub fn crop_image(doc: &mut Presentation, slide: usize, id: u32, crop: Option<[f64; 4]>, geometry: Option<&str>) -> Result<Value, Error> {
    if let Some(g) = geometry.filter(|g| !matches!(*g, "ellipse" | "rect")) {
        return Err(Error::InvalidCommand(format!("crop geometry {g:?} (ellipse or rect)")));
    }
    if crop.is_none() && geometry.is_none() {
        return Err(Error::InvalidCommand("crop_image needs crop fractions or a geometry".into()));
    }
    let all = crop.unwrap_or([0.0; 4]);
    let [left, top, right, bottom] = all;
    if all.iter().any(|v| !v.is_finite() || *v < -1.0 || *v >= 1.0) || left + right >= 1.0 || top + bottom >= 1.0 {
        return Err(Error::InvalidCommand("crop fractions must leave part of the picture (left + right < 1, top + bottom < 1)".into()));
    }
    let t = target(doc, slide, id)?;
    let fill = t.tree.child(t.shape, NS_P, "blipFill").filter(|_| t.tree.node(t.shape).local == "pic").ok_or_else(|| Error::InvalidCommand("crop_image needs a picture".into()))?;
    let a = drawing_prefix(&t.tree)?;
    let v = |f: f64| (f * 100_000.0).round() as i64;
    let mut rect = format!("<{a}srcRect");
    for (k, f) in [("l", left), ("t", top), ("r", right), ("b", bottom)] {
        if v(f) != 0 {
            rect.push_str(&format!(r#" {k}="{}""#, v(f)));
        }
    }
    rect.push_str("/>");
    let change = Change { remove: vec!["srcRect"], insert: vec![("srcRect", rect.into_bytes())], order: &["blip", "srcRect", "tile", "stretch"], ..Default::default() };
    let n = t.tree.node(fill);
    let mut edits = Vec::new();
    if crop.is_some() {
        edits.push((n.start..n.end, rebuild(&t.src, &t.tree, fill, &change)?));
    }
    if let Some(g) = geometry {
        let sp = t.tree.child(t.shape, NS_P, "spPr").ok_or_else(|| Error::Xml("picture without spPr".into()))?;
        let outline = Change {
            remove: vec!["prstGeom", "custGeom"],
            insert: vec![("prstGeom", format!(r#"<{a}prstGeom prst="{g}"><{a}avLst/></{a}prstGeom>"#).into_bytes())],
            order: super::shape::SP_PR_ORDER,
            ..Default::default()
        };
        let spn = t.tree.node(sp);
        edits.push((spn.start..spn.end, rebuild(&t.src, &t.tree, sp, &outline)?));
        edits.sort_by_key(|e| e.0.start);
    }
    let changed = commit(doc, &t, edits)?;
    Ok(result("crop_image", &t, slide, id, changed))
}

/// Reorders the shapes of the slide's shape tree (or of one group): the
/// given shape moves to `front`, `back`, one step `forward` or `backward`;
/// or, with `order`, the whole list of top-level shapes is given.
pub fn arrange(doc: &mut Presentation, slide: usize, id: Option<u32>, action: Option<&str>, order: Option<&[u32]>) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = crate::xml::Tree::parse(&src)?;
    let sp_tree = tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound("shape tree".into()))?;
    let container = match id {
        Some(id) => {
            let t = target(doc, slide, id)?;
            let parent = t.tree.node(t.shape).parent.ok_or_else(|| Error::Xml("shape without parent".into()))?;
            if !t.tree.node(parent).is(NS_P, "spTree") && !t.tree.node(parent).is(NS_P, "grpSp") {
                return Err(Error::Unsupported("shape inside alternate content".into()));
            }
            parent
        }
        None => sp_tree,
    };
    // Shapes (and alternate-content wrappers) in drawing order.
    let items: Vec<usize> = tree.node(container).children.iter().copied().filter(|&c| !matches!(tree.node(c).local.as_str(), "nvGrpSpPr" | "grpSpPr" | "extLst")).collect();
    let id_of = |c: usize| non_visual(&tree, c).and_then(|n| tree.node(n).attr("id")).and_then(|v| v.parse::<u32>().ok());
    let mut new_order = items.clone();
    match (id, action, order) {
        (Some(id), Some(action), None) => {
            let k = items.iter().position(|&c| id_of(c) == Some(id)).ok_or_else(|| Error::NotFound(format!("shape {id}")))?;
            let item = new_order.remove(k);
            let to = match action {
                "front" => new_order.len(),
                "back" => 0,
                "forward" => (k + 1).min(new_order.len()),
                "backward" => k.saturating_sub(1),
                other => return Err(Error::InvalidCommand(format!("action must be front, back, forward or backward, got {other:?}"))),
            };
            new_order.insert(to, item);
        }
        (None, None, Some(order)) => {
            let ids: Vec<Option<u32>> = items.iter().map(|&c| id_of(c)).collect();
            let mut wanted: Vec<u32> = order.to_vec();
            let mut have: Vec<u32> = ids.iter().flatten().copied().collect();
            wanted.sort_unstable();
            have.sort_unstable();
            if wanted != have || ids.iter().any(Option::is_none) {
                return Err(Error::InvalidCommand("order must list every top-level shape id exactly once".into()));
            }
            new_order = order.iter().map(|o| items[ids.iter().position(|i| *i == Some(*o)).expect("checked")]).collect();
        }
        _ => return Err(Error::InvalidCommand("give a shape and an action, or the full order".into())),
    }
    if new_order == items {
        return Ok(json!({ "op": if order.is_some() { "set_reading_order" } else { "z_order" }, "slide": slide, "changed": false }));
    }
    // Rewrite the run from the first to the last item: element bytes in the
    // new order, the text between them as it was.
    let first = tree.node(items[0]).start;
    let last = tree.node(*items.last().expect("non-empty")).end;
    let mut out = Vec::new();
    for (k, &slot) in items.iter().enumerate() {
        if k > 0 {
            out.extend_from_slice(&src[tree.node(items[k - 1]).end..tree.node(slot).start]);
        }
        let n = tree.node(new_order[k]);
        out.extend_from_slice(&src[n.start..n.end]);
    }
    let updated = splice(&src, vec![(first..last, out)])?;
    check_scope(&src, &updated, tree.node(container).start, tree.node(container).end)?;
    doc.package_mut().write(&part, updated)?;
    Ok(json!({ "op": if order.is_some() { "set_reading_order" } else { "z_order" }, "slide": slide, "changed": true }))
}
