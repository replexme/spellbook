//! Shape outlines in the shape's own box (points, origin top-left).
//!
//! Preset geometries are evaluated from the unmodified ECMA-376
//! `presetShapeDefinitions.xml` (see `data/NOTICE.md`): adjust values, guide
//! formulas and paths, for all 187 presets. Custom geometry (`a:custGeom`)
//! uses the same evaluator with the shape's own definitions.

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::OnceLock;

use kurbo::{Arc as KArc, BezPath, Point, Vec2};

use crate::xml::{Tree, NS_A};

const EMU_PER_PT: f64 = 12_700.0;
const DEFINITIONS: &str = include_str!("../../data/presetShapeDefinitions.xml");
const WARP_DEFINITIONS: &str = include_str!("../../data/presetTextWarpDefinitions.xml");

/// A shape's paths, split by what they draw.
#[derive(Debug, Clone, Default)]
pub struct Geometry {
    /// Subpaths that are filled.
    pub fill: BezPath,
    /// Subpaths that are outlined.
    pub stroke: BezPath,
}

struct Definitions {
    tree: Tree,
    by_name: HashMap<String, usize>,
}

fn parse_definitions(src: &str) -> Definitions {
    let src = src.trim_start_matches('\u{feff}');
    let tree = Tree::parse(src.as_bytes()).expect("bundled preset definitions parse");
    let by_name = tree.node(tree.root).children.iter().map(|&c| (tree.node(c).local.clone(), c)).collect();
    Definitions { tree, by_name }
}

fn definitions() -> &'static Definitions {
    static DEFS: OnceLock<Definitions> = OnceLock::new();
    DEFS.get_or_init(|| parse_definitions(DEFINITIONS))
}

fn warp_definitions() -> &'static Definitions {
    static DEFS: OnceLock<Definitions> = OnceLock::new();
    DEFS.get_or_init(|| parse_definitions(WARP_DEFINITIONS))
}

/// The paths of WordArt warp `a:prstTxWarp` node in a `w`×`h` box, from the
/// ECMA-376 `presetTextWarpDefinitions.xml`; `None` for an unknown preset or
/// `textNoShape`.
pub fn text_warp(tree: &Tree, prst_tx_warp: usize, w: f64, h: f64) -> Option<Vec<BezPath>> {
    let name = tree.node(prst_tx_warp).attr("prst")?;
    let defs = warp_definitions();
    let def = *defs.by_name.get(name)?;
    let overrides = tree.child(prst_tx_warp, NS_A, "avLst").map(|av| (tree, av));
    let paths: Vec<BezPath> = paths(&defs.tree, def, overrides, w, h, false)?.into_iter().map(|(p, _, _)| p).filter(|p| !p.elements().is_empty()).collect();
    (!paths.is_empty()).then_some(paths)
}

/// Is `name` one of the ECMA-376 preset shapes?
pub fn is_preset(name: &str) -> bool {
    definitions().by_name.contains_key(name)
}

/// Angles in DrawingML are 60000ths of a degree.
fn to_rad(a: f64) -> f64 {
    a / 60_000.0 * PI / 180.0
}

struct Guides {
    values: HashMap<String, f64>,
}

impl Guides {
    fn new(w: f64, h: f64) -> Self {
        let ss = w.min(h);
        let mut v = HashMap::new();
        for (k, x) in [
            ("w", w), ("h", h), ("l", 0.0), ("t", 0.0), ("r", w), ("b", h), ("hc", w / 2.0), ("vc", h / 2.0),
            ("ls", w.max(h)), ("ss", ss),
            ("wd2", w / 2.0), ("wd3", w / 3.0), ("wd4", w / 4.0), ("wd5", w / 5.0), ("wd6", w / 6.0),
            ("wd8", w / 8.0), ("wd10", w / 10.0), ("wd12", w / 12.0), ("wd32", w / 32.0),
            ("hd2", h / 2.0), ("hd3", h / 3.0), ("hd4", h / 4.0), ("hd5", h / 5.0), ("hd6", h / 6.0),
            ("hd8", h / 8.0), ("hd10", h / 10.0), ("hd12", h / 12.0), ("hd32", h / 32.0),
            ("ssd2", ss / 2.0), ("ssd4", ss / 4.0), ("ssd6", ss / 6.0), ("ssd8", ss / 8.0),
            ("ssd16", ss / 16.0), ("ssd32", ss / 32.0),
            ("cd2", 10_800_000.0), ("cd4", 5_400_000.0), ("cd8", 2_700_000.0),
            ("3cd4", 16_200_000.0), ("3cd8", 8_100_000.0), ("5cd8", 13_500_000.0), ("7cd8", 18_900_000.0),
        ] {
            v.insert(k.to_owned(), x);
        }
        Self { values: v }
    }

    fn get(&self, token: &str) -> Option<f64> {
        self.values.get(token).copied().or_else(|| token.parse::<f64>().ok())
    }

    /// Evaluates a guide formula such as `*/ w adj 100000`.
    fn eval(&self, fmla: &str) -> Option<f64> {
        let mut it = fmla.split_whitespace();
        let op = it.next()?;
        let args: Vec<f64> = it.map(|t| self.get(t)).collect::<Option<_>>()?;
        let a = |i: usize| args.get(i).copied();
        Some(match op {
            "val" => a(0)?,
            "*/" => a(0)? * a(1)? / a(2)?,
            "+-" => a(0)? + a(1)? - a(2)?,
            "+/" => (a(0)? + a(1)?) / a(2)?,
            "?:" => if a(0)? > 0.0 { a(1)? } else { a(2)? },
            "abs" => a(0)?.abs(),
            "at2" => a(1)?.atan2(a(0)?) * 180.0 / PI * 60_000.0,
            "cat2" => a(0)? * a(2)?.atan2(a(1)?).cos(),
            "sat2" => a(0)? * a(2)?.atan2(a(1)?).sin(),
            "cos" => a(0)? * to_rad(a(1)?).cos(),
            "sin" => a(0)? * to_rad(a(1)?).sin(),
            "tan" => a(0)? * to_rad(a(1)?).tan(),
            "max" => a(0)?.max(a(1)?),
            "min" => a(0)?.min(a(1)?),
            "mod" => (a(0)?.powi(2) + a(1)?.powi(2) + a(2)?.powi(2)).sqrt(),
            "pin" => a(1)?.clamp(a(0)?.min(a(2)?), a(2)?.max(a(0)?)),
            "sqrt" => a(0)?.max(0.0).sqrt(),
            _ => return None,
        })
    }

    /// Evaluates `a:gd` children of `list` in order (later guides may use earlier ones).
    fn define(&mut self, tree: &Tree, list: usize) -> Option<()> {
        for gd in tree.children_named(list, NS_A, "gd") {
            let n = tree.node(gd);
            let v = self.eval(n.attr("fmla")?)?;
            self.values.insert(n.attr("name")?.to_owned(), v);
        }
        Some(())
    }
}

/// Builds the paths of a geometry definition (`a:prstGeom` definition or
/// `a:custGeom`) for a `w`×`h` box. `overrides` is the shape's `a:avLst`.
/// Guide values of a shape definition in a `w`×`h` box.
fn guides(tree: &Tree, def: usize, overrides: Option<(&Tree, usize)>, w: f64, h: f64, scale_emu: bool) -> Option<Guides> {
    let mut g = Guides::new(w, h);
    // Custom geometry values are in EMU; preset formulas are unit-free and
    // computed directly in points.
    if scale_emu {
        for v in g.values.values_mut() {
            *v *= EMU_PER_PT;
        }
        // Angle constants are not lengths.
        for (k, x) in [("cd2", 10_800_000.0), ("cd4", 5_400_000.0), ("cd8", 2_700_000.0), ("3cd4", 16_200_000.0), ("3cd8", 8_100_000.0), ("5cd8", 13_500_000.0), ("7cd8", 18_900_000.0)] {
            g.values.insert(k.to_owned(), x);
        }
    }
    if let Some(av) = tree.child(def, NS_A, "avLst") {
        g.define(tree, av)?;
    }
    if let Some((ot, ov)) = overrides {
        g.define(ot, ov)?;
    }
    if let Some(gl) = tree.child(def, NS_A, "gdLst") {
        g.define(tree, gl)?;
    }
    Some(g)
}

fn build(tree: &Tree, def: usize, overrides: Option<(&Tree, usize)>, w: f64, h: f64, scale_emu: bool) -> Option<Geometry> {
    let mut out = Geometry::default();
    for (bp, fill, stroke) in paths(tree, def, overrides, w, h, scale_emu)? {
        if fill {
            out.fill.extend(bp.elements().iter().copied());
        }
        if stroke {
            out.stroke.extend(bp.elements().iter().copied());
        }
    }
    Some(out)
}

/// Each `a:path` of definition `def` with whether it is filled and outlined.
fn paths(tree: &Tree, def: usize, overrides: Option<(&Tree, usize)>, w: f64, h: f64, scale_emu: bool) -> Option<Vec<(BezPath, bool, bool)>> {
    let g = guides(tree, def, overrides, w, h, scale_emu)?;
    let unit = if scale_emu { EMU_PER_PT } else { 1.0 };
    let list = tree.child(def, NS_A, "pathLst")?;
    let mut out = Vec::new();
    for path in tree.children_named(list, NS_A, "path") {
        let n = tree.node(path);
        let (pw, ph) = (n.attr("w").and_then(|v| v.parse::<f64>().ok()), n.attr("h").and_then(|v| v.parse::<f64>().ok()));
        let (bw, bh) = (w * unit, h * unit);
        let sx = pw.filter(|v| *v > 0.0).map(|v| bw / v).unwrap_or(1.0) / unit;
        let sy = ph.filter(|v| *v > 0.0).map(|v| bh / v).unwrap_or(1.0) / unit;
        let fill = n.attr("fill") != Some("none");
        let stroke = n.attr("stroke") != Some("0") && n.attr("stroke") != Some("false");
        let pt = |p: usize| -> Option<Point> {
            let a = tree.node(p);
            Some(Point::new(g.get(a.attr("x")?)? * sx, g.get(a.attr("y")?)? * sy))
        };
        let mut bp = BezPath::new();
        let mut current = Point::ZERO;
        for &cmd in &n.children {
            let c = tree.node(cmd);
            let pts: Vec<Point> = tree.children_named(cmd, NS_A, "pt").map(pt).collect::<Option<_>>()?;
            match c.local.as_str() {
                "moveTo" => {
                    current = *pts.first()?;
                    bp.move_to(current);
                }
                "lnTo" => {
                    current = *pts.first()?;
                    bp.line_to(current);
                }
                "cubicBezTo" if pts.len() == 3 => {
                    bp.curve_to(pts[0], pts[1], pts[2]);
                    current = pts[2];
                }
                "quadBezTo" if pts.len() == 2 => {
                    bp.quad_to(pts[0], pts[1]);
                    current = pts[1];
                }
                "arcTo" => {
                    let wr = g.get(c.attr("wR")?)? * sx;
                    let hr = g.get(c.attr("hR")?)? * sy;
                    let (st, sw) = (to_rad(g.get(c.attr("stAng")?)?), to_rad(g.get(c.attr("swAng")?)?));
                    // The angles are of the ellipse as drawn (not parametric).
                    let param = |ang: f64| (ang.sin() * wr).atan2(ang.cos() * hr);
                    let (s0, s1) = (param(st), param(st + sw));
                    let mut sweep = s1 - s0;
                    if sw > 0.0 && sweep <= 0.0 {
                        sweep += 2.0 * PI;
                    } else if sw < 0.0 && sweep >= 0.0 {
                        sweep -= 2.0 * PI;
                    }
                    if sw.abs() >= 2.0 * PI - 1e-9 {
                        sweep = sw.signum() * 2.0 * PI;
                    }
                    let center = current - Vec2::new(wr * s0.cos(), hr * s0.sin());
                    let arc = KArc::new(center, (wr, hr), s0, sweep, 0.0);
                    if bp.elements().is_empty() {
                        bp.move_to(current);
                    }
                    bp.extend(arc.append_iter(0.05));
                    current = center + Vec2::new(wr * (s0 + sweep).cos(), hr * (s0 + sweep).sin());
                }
                "close" => bp.close_path(),
                _ => return None,
            }
        }
        out.push((bp, fill, stroke));
    }
    Some(out)
}

/// Geometry of `a:prstGeom` node in a `w`×`h` box, or `None` for an unknown preset.
pub fn preset(tree: &Tree, prst_geom: usize, w: f64, h: f64) -> Option<Geometry> {
    let name = tree.node(prst_geom).attr("prst")?;
    let defs = definitions();
    let def = *defs.by_name.get(name)?;
    let overrides = tree.child(prst_geom, NS_A, "avLst").map(|av| (tree, av));
    build(&defs.tree, def, overrides, w, h, false)
}

/// Geometry of preset shape `name` in a `w`×`h` box with adjust values
/// `adj` (guide name, value in the preset's units, e.g. 16667).
pub fn preset_named(name: &str, adj: &[(String, f64)], w: f64, h: f64) -> Option<Geometry> {
    let defs = definitions();
    let def = *defs.by_name.get(name)?;
    let av: String = adj.iter().map(|(n, v)| format!(r#"<a:gd name="{n}" fmla="val {}"/>"#, v.round() as i64)).collect();
    let xml = format!(r#"<a:avLst xmlns:a="{NS_A}">{av}</a:avLst>"#);
    let tree = Tree::parse(xml.as_bytes()).ok()?;
    let root = tree.root;
    build(&defs.tree, def, Some((&tree, root)), w, h, false)
}

/// The text rectangle (`a:rect`) of preset shape `name` in a `w`×`h` box.
pub fn text_rect_named(name: &str, adj: &[(String, f64)], w: f64, h: f64) -> Option<kurbo::Rect> {
    let defs = definitions();
    let def = *defs.by_name.get(name)?;
    let av: String = adj.iter().map(|(n, v)| format!(r#"<a:gd name="{n}" fmla="val {}"/>"#, v.round() as i64)).collect();
    let xml = format!(r#"<a:avLst xmlns:a="{NS_A}">{av}</a:avLst>"#);
    let tree = Tree::parse(xml.as_bytes()).ok()?;
    let g = guides(&defs.tree, def, Some((&tree, tree.root)), w, h, false)?;
    rect_of(&defs.tree, def, &g, 1.0)
}

/// The text rectangle of shape geometry `geom` (`a:prstGeom` or
/// `a:custGeom`) in a `w`×`h` box, in points. `None` when the geometry has
/// none (the text then uses the whole box).
pub fn text_rect(tree: &Tree, geom: usize, w: f64, h: f64) -> Option<kurbo::Rect> {
    if tree.node(geom).local == "prstGeom" {
        let defs = definitions();
        let def = *defs.by_name.get(tree.node(geom).attr("prst")?)?;
        let overrides = tree.child(geom, NS_A, "avLst").map(|av| (tree, av));
        let g = guides(&defs.tree, def, overrides, w, h, false)?;
        rect_of(&defs.tree, def, &g, 1.0)
    } else {
        let g = guides(tree, geom, None, w, h, true)?;
        rect_of(tree, geom, &g, EMU_PER_PT)
    }
}

fn rect_of(tree: &Tree, def: usize, g: &Guides, unit: f64) -> Option<kurbo::Rect> {
    let n = tree.node(tree.child(def, NS_A, "rect")?);
    let v = |a: &str| Some(g.get(n.attr(a)?)? / unit);
    Some(kurbo::Rect::new(v("l")?, v("t")?, v("r")?, v("b")?))
}

/// Names and default values of the adjust values of preset shape `name`,
/// in order.
pub fn adjust_names(name: &str) -> Vec<(String, f64)> {
    let defs = definitions();
    let Some(&def) = defs.by_name.get(name) else { return Vec::new() };
    defs.tree
        .child(def, NS_A, "avLst")
        .map(|av| {
            defs.tree
                .children_named(av, NS_A, "gd")
                .filter_map(|g| {
                    let n = defs.tree.node(g);
                    let v = n.attr("fmla")?.strip_prefix("val ")?.trim().parse::<f64>().ok()?;
                    Some((n.attr("name")?.to_owned(), v))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Connection sites (`a:cxnLst`) of preset shape `name` in a `w`×`h` box,
/// in the box's coordinates (points), by index.
pub fn connection_sites(name: &str, w: f64, h: f64) -> Option<Vec<Point>> {
    let defs = definitions();
    let def = *defs.by_name.get(name)?;
    let g = guides(&defs.tree, def, None, w, h, false)?;
    let Some(list) = defs.tree.child(def, NS_A, "cxnLst") else { return Some(Vec::new()) };
    defs.tree
        .children_named(list, NS_A, "cxn")
        .map(|c| {
            let pos = defs.tree.child(c, NS_A, "pos")?;
            let n = defs.tree.node(pos);
            Some(Point::new(g.get(n.attr("x")?)?, g.get(n.attr("y")?)?))
        })
        .collect()
}

/// Geometry of `a:custGeom` node in a `w`×`h` box.
pub fn custom(tree: &Tree, cust_geom: usize, w: f64, h: f64) -> Option<Geometry> {
    build(tree, cust_geom, None, w, h, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prst(name: &str, av: &str) -> (Tree, usize) {
        let src = format!(r#"<a:prstGeom xmlns:a="{NS_A}" prst="{name}"><a:avLst>{av}</a:avLst></a:prstGeom>"#);
        let t = Tree::parse(src.as_bytes()).unwrap();
        let r = t.root;
        (t, r)
    }

    #[test]
    fn all_presets_evaluate() {
        let defs = definitions();
        // 187 definitions; one name appears twice in the ECMA file.
        assert_eq!(defs.by_name.len(), 186);
        let mut failed = Vec::new();
        for name in defs.by_name.keys() {
            let (t, r) = prst(name, "");
            if preset(&t, r, 200.0, 100.0).is_none() {
                failed.push(name.clone());
            }
        }
        assert!(failed.is_empty(), "{failed:?}");
    }

    #[test]
    fn rect_and_ellipse_bounds() {
        use kurbo::Shape;
        let (t, r) = prst("rect", "");
        let g = preset(&t, r, 200.0, 100.0).unwrap();
        assert_eq!(g.fill.bounding_box(), kurbo::Rect::new(0.0, 0.0, 200.0, 100.0));
        let (t, r) = prst("ellipse", "");
        let b = preset(&t, r, 200.0, 100.0).unwrap().fill.bounding_box();
        assert!((b.x0).abs() < 0.5 && (b.x1 - 200.0).abs() < 0.5 && (b.y0).abs() < 0.5 && (b.y1 - 100.0).abs() < 0.5, "{b:?}");
    }

    #[test]
    fn zero_radius_corners_stay_finite() {
        use kurbo::Shape;
        let (t, r) = prst("round2SameRect", r#"<a:gd name="adj1" fmla="val 50000"/><a:gd name="adj2" fmla="val 0"/>"#);
        let g = preset(&t, r, 40.0, 623.0).unwrap();
        let b = g.fill.bounding_box();
        assert!(b.x0.is_finite() && b.y1.is_finite(), "{b:?}");
        assert!((b.x1 - 40.0).abs() < 0.5 && (b.y1 - 623.0).abs() < 0.5, "{b:?}");
    }

    #[test]
    fn adjust_values_override_defaults() {
        use kurbo::Shape;
        // roundRect corner radius: ss * adj / 100000; with adj 50000 on a 100x100 box it is a circle.
        let (t, r) = prst("roundRect", r#"<a:gd name="adj" fmla="val 50000"/>"#);
        let g = preset(&t, r, 100.0, 100.0).unwrap();
        let area = g.fill.area().abs();
        assert!((area - PI * 2500.0).abs() < 30.0, "{area}");
    }
}
