//! Resolves a slide into a drawing list.
//!
//! The slide, its layout, master and theme are read from the original parts;
//! nothing here writes to the package. What cannot be drawn yet is listed in
//! `diagnostics` instead of being approximated silently.

pub mod autofit;
mod chart;
#[doc(hidden)]
pub mod diagram;
mod metafile;
pub mod color;
pub mod eot;
pub mod fonts;
pub mod geometry;
pub mod table;
pub mod text;
mod warp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kurbo::{Affine, BezPath, Rect, Shape};
use present_render::{Item, Paint, Rgba, Scene, Stroke};
use serde::Serialize;
use vello_cpu::Pixmap;

use crate::xml::{Tree, NS_A, NS_P, NS_R};
use crate::{read_relationships, rels_part_for, Error, Presentation, Relationship};

const NS_DSP: &str = "http://schemas.microsoft.com/office/drawing/2008/diagram";
const NS_DGM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
use color::ColorContext;
use fonts::FontSet;
use text::{BodyProps, LineInfo, Paragraph, StyleSource, TextRun, ThemeFonts};

const EMU_PER_PT: f64 = 12_700.0;

pub struct Part {
    pub name: String,
    /// Namespace of the shape elements: PresentationML for slides, layouts
    /// and masters; the diagram drawing namespace for SmartArt drawings.
    pub ns: &'static str,
    pub src: Arc<Vec<u8>>,
    pub tree: Tree,
    pub rels: Vec<Relationship>,
}

fn load_part(pres: &Presentation, name: &str) -> Result<Arc<Part>, Error> {
    load_part_ns(pres, name, NS_P)
}

fn load_part_ns(pres: &Presentation, name: &str, ns: &'static str) -> Result<Arc<Part>, Error> {
    let src = pres.package().read(name)?;
    let tree = Tree::parse(&src)?;
    let rels = read_relationships(pres.package(), &rels_part_for(name), name)?;
    Ok(Arc::new(Part { name: name.to_owned(), ns, src, tree, rels }))
}

/// `cNvPr id` of a shape in any shape namespace.
fn shape_id(tree: &Tree, shape: usize) -> Option<u32> {
    let nv = tree.node(shape).children.iter().copied().find(|&c| tree.node(c).local.starts_with("nv"))?;
    let cnv = tree.node(nv).children.iter().copied().find(|&c| tree.node(c).local == "cNvPr")?;
    tree.node(cnv).attr("id")?.parse().ok()
}

/// Arrowhead at one end of a line: kind, width and length as multiples of the line width.
#[derive(Debug, Clone)]
struct Arrow {
    kind: String,
    width: f64,
    length: f64,
}

fn arrow_size(v: Option<&str>) -> f64 {
    match v {
        Some("sm") => 2.0,
        Some("lg") => 5.0,
        _ => 3.0,
    }
}

/// Outline of an arrowhead whose tip is at `tip`, pointing along `dir`.
fn arrow_path(a: &Arrow, tip: kurbo::Point, dir: kurbo::Vec2, line_width: f64) -> Option<(BezPath, bool)> {
    let d = dir.normalize();
    if !d.x.is_finite() || !d.y.is_finite() {
        return None;
    }
    let n = kurbo::Vec2::new(-d.y, d.x);
    let lw = line_width.max(0.75);
    let (len, half) = (a.length * lw, a.width * lw / 2.0);
    let back = tip - d * len;
    let mut p = BezPath::new();
    match a.kind.as_str() {
        "triangle" => {
            p.move_to(tip);
            p.line_to(back + n * half);
            p.line_to(back - n * half);
            p.close_path();
        }
        "stealth" => {
            p.move_to(tip);
            p.line_to(back + n * half);
            p.line_to(tip - d * (len * 0.5));
            p.line_to(back - n * half);
            p.close_path();
        }
        "arrow" => {
            p.move_to(back + n * half);
            p.line_to(tip);
            p.line_to(back - n * half);
            return Some((p, false));
        }
        "oval" => return Some((kurbo::Ellipse::new(tip, (len / 2.0, half), d.atan2()).to_path(0.1), true)),
        "diamond" => {
            let c = tip;
            p.move_to(c + d * (len / 2.0));
            p.line_to(c + n * half);
            p.line_to(c - d * (len / 2.0));
            p.line_to(c - n * half);
            p.close_path();
        }
        _ => return None,
    }
    Some((p, true))
}

fn related(pres: &Presentation, part: &Part, type_suffix: &str) -> Result<Arc<Part>, Error> {
    let rel = part
        .rels
        .iter()
        .find(|r| !r.external && r.rel_type.ends_with(type_suffix))
        .ok_or_else(|| Error::NotFound(format!("{type_suffix} relationship of {}", part.name)))?;
    load_part(pres, &rel.target)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape_id: Option<u32>,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBoxInfo {
    pub shape_id: u32,
    pub name: String,
    /// Shape box on the slide (x, y, width, height) in points, before rotation.
    pub frame: [f64; 4],
    pub lines: Vec<LineInfo>,
    pub fonts: Vec<text::FontUse>,
    /// How far (points) the text runs past the bottom of the box's text area,
    /// by the height autofit fits against; 0 when it fits. PowerPoint draws
    /// such text outside the shape.
    pub overflow: f64,
    /// The shape is the slide's own; false for layout and master shapes,
    /// whose ids are those of their own part.
    pub on_slide: bool,
}

/// Gaussian standard deviation per glow radius, with the silhouette grown by
/// `GLOW_GROWTH`: fitted to a 10 pt, 60% PowerPoint glow, whose profile it
/// matches within 5 of 255 levels (provisional "glow").
const GLOW_SIGMA_PER_RADIUS: f64 = 0.17;
/// Stroke width, as a multiple of the radius, that grows the glow silhouette.
const GLOW_GROWTH: f64 = 1.05;
/// The same two for text glows: fitted to a 10 pt, 60% glow on 60 pt Arial,
/// within 3 of 255 levels (provisional "glow").
const TEXT_GLOW_GROWTH: f64 = 0.92;
const TEXT_GLOW_SIGMA_PER_RADIUS: f64 = 0.14;

/// Gaussian standard deviation per DrawingML blur radius (`blurRad`),
/// fitted by eye to one PowerPoint text shadow (provisional "shadowBlur").
const SHADOW_SIGMA_PER_RADIUS: f64 = 0.25;

/// Decoded pictures larger than this in total are dropped from the cache.
const IMAGE_CACHE_BYTES: usize = 512 << 20;

/// Fonts and decoded pictures shared across renders of a presentation, so a
/// re-render after an edit does not decode pictures again.
pub struct Resources {
    pub fonts: FontSet,
    images: Mutex<(HashMap<(u32, u64), Option<Arc<Pixmap>>>, usize)>,
}

impl Resources {
    pub fn new(fonts: FontSet) -> Self {
        Self { fonts, images: Mutex::new((HashMap::new(), 0)) }
    }

    /// Decodes the fonts embedded in `doc` and makes them the active
    /// document's fonts. Returns the document's font scope (see
    /// [`FontSet::add_document_fonts`]).
    pub fn open_document(&mut self, doc: &Presentation) -> u32 {
        let scope = self.fonts.add_document_fonts(embedded_fonts(doc));
        self.fonts.set_active_document(scope);
        scope
    }
}

/// The fonts embedded in the presentation (`p:embeddedFontLst`), decoded:
/// (typeface, TrueType bytes) per font file. A file that can't be decoded is
/// left out, so its text is drawn as if the font were not embedded.
pub fn embedded_fonts(doc: &Presentation) -> Vec<(String, Vec<u8>)> {
    let part = doc.presentation_part();
    let (Ok(src), Ok(rels)) = (doc.package().read(part), read_relationships(doc.package(), &rels_part_for(part), part)) else { return Vec::new() };
    let Ok(tree) = Tree::parse(&src) else { return Vec::new() };
    let Some(list) = tree.child(tree.root, NS_P, "embeddedFontLst") else { return Vec::new() };
    let mut out = Vec::new();
    for font in tree.children_named(list, NS_P, "embeddedFont") {
        let Some(typeface) = tree.child(font, NS_P, "font").and_then(|f| tree.node(f).attr("typeface")) else { continue };
        for slot in ["regular", "bold", "italic", "boldItalic"] {
            let Some(rid) = tree.child(font, NS_P, slot).and_then(|s| tree.node(s).attr_ns(NS_R, "id")) else { continue };
            let Some(rel) = rels.iter().find(|r| r.id == rid && !r.external) else { continue };
            let Ok(bytes) = doc.package().read(&rel.target) else { continue };
            if let Ok(ttf) = eot::decode(&bytes) {
                out.push((typeface.to_owned(), ttf));
            }
        }
    }
    out
}

/// Where a slide shape is drawn: its box on the slide (x, y, width, height
/// in points, before rotation) and its own rotation in degrees.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeFrame {
    pub shape_id: u32,
    pub frame: [f64; 4],
    pub rotation: f64,
}

pub struct RenderedSlide {
    pub scene: Scene,
    /// Every shape of the slide itself (not its layout or master), in drawing order.
    pub frames: Vec<ShapeFrame>,
    pub texts: Vec<TextBoxInfo>,
    pub diagnostics: Vec<Diagnostic>,
    /// Layout rules applied that are not yet confirmed against PowerPoint.
    pub provisional: Vec<&'static str>,
}

struct Theme {
    part: Arc<Part>,
    fonts: ThemeFonts,
    fill_styles: Vec<usize>,
    line_styles: Vec<usize>,
    bg_styles: Vec<usize>,
}

fn read_theme(part: Arc<Part>) -> (Theme, HashMap<String, Rgba>) {
    let t = &part.tree;
    let elements = t.child(t.root, NS_A, "themeElements");
    let scheme = elements.and_then(|e| t.child(e, NS_A, "clrScheme")).map(|s| color::read_scheme(t, s)).unwrap_or_default();
    let mut fonts = ThemeFonts::default();
    if let Some(fs) = elements.and_then(|e| t.child(e, NS_A, "fontScheme")) {
        for (key, major) in [("majorFont", true), ("minorFont", false)] {
            let Some(f) = t.child(fs, NS_A, key) else { continue };
            let face = |local: &str| t.child(f, NS_A, local).and_then(|n| t.node(n).attr("typeface")).unwrap_or("").to_owned();
            let hang = t.children_named(f, NS_A, "font").find(|&n| t.node(n).attr("script") == Some("Hang")).and_then(|n| t.node(n).attr("typeface")).map(str::to_owned);
            if major {
                (fonts.major_latin, fonts.major_ea, fonts.major_hang) = (face("latin"), face("ea"), hang);
            } else {
                (fonts.minor_latin, fonts.minor_ea, fonts.minor_hang) = (face("latin"), face("ea"), hang);
            }
        }
    }
    let list = |name: &str| -> Vec<usize> {
        elements
            .and_then(|e| t.child(e, NS_A, "fmtScheme"))
            .and_then(|f| t.child(f, NS_A, name))
            .map(|l| t.node(l).children.clone())
            .unwrap_or_default()
    };
    let theme = Theme { fill_styles: list("fillStyleLst"), line_styles: list("lnStyleLst"), bg_styles: list("bgFillStyleLst"), fonts, part };
    (theme, scheme)
}

/// Placeholder identity of a shape: (type, idx).
fn placeholder(tree: &Tree, shape: usize) -> Option<(String, Option<u32>)> {
    let nv = tree.node(shape).children.iter().copied().find(|&c| tree.node(c).local.starts_with("nv"))?;
    let ph = tree.path(nv, &[(NS_P, "nvPr"), (NS_P, "ph")])?;
    let n = tree.node(ph);
    Some((n.attr("type").unwrap_or("obj").to_owned(), n.attr("idx").and_then(|v| v.parse().ok())))
}

fn same_ph_type(a: &str, b: &str) -> bool {
    let norm = |t: &str| match t {
        "ctrTitle" => "title",
        "subTitle" | "obj" => "body",
        other => other,
    }
    .to_owned();
    norm(a) == norm(b)
}

fn sp_tree(part: &Part) -> Option<usize> {
    part.tree.path(part.tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")])
}

/// The placeholder shape in `part` matching (type, idx).
fn find_placeholder(part: &Part, ty: &str, idx: Option<u32>) -> Option<usize> {
    let t = &part.tree;
    let tree_node = sp_tree(part)?;
    let shapes: Vec<(usize, String, Option<u32>)> =
        t.node(tree_node).children.iter().filter_map(|&c| placeholder(t, c).map(|(ty, idx)| (c, ty, idx))).collect();
    if let Some(i) = idx {
        if let Some((s, _, _)) = shapes.iter().find(|(_, _, x)| *x == Some(i)) {
            return Some(*s);
        }
    }
    shapes.iter().find(|(_, t2, _)| same_ph_type(ty, t2)).map(|(s, _, _)| *s)
}

/// A shape and the placeholders it inherits from, nearest first.
type Chain = Vec<(Arc<Part>, usize)>;

struct Ctx<'a> {
    pres: &'a Presentation,
    fonts: &'a FontSet,
    resources: &'a Resources,
    theme: Theme,
    colors: ColorContext,
    pres_part: Arc<Part>,
    master: Arc<Part>,
    layout: Arc<Part>,
    /// 1-based number of the slide being drawn (slide number fields).
    slide_number: usize,
    /// Fills of the enclosing groups, innermost last (for `a:grpFill`).
    group_fills: Vec<Option<(Arc<Part>, usize)>>,
    /// Record shape frames (only while walking the slide's own shapes).
    record_frames: bool,
    out: RenderedSlide,
}

fn num(v: Option<&str>) -> Option<f64> {
    v.and_then(|s| s.parse::<f64>().ok())
}

/// Position, rotation and flips of an `a:xfrm`, in points.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Xfrm {
    pub rect: Rect,
    pub rot: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub child: Option<Rect>,
}

pub(crate) fn read_xfrm(tree: &Tree, xfrm: usize) -> Option<Xfrm> {
    let n = tree.node(xfrm);
    let off = tree.child(xfrm, NS_A, "off")?;
    let ext = tree.child(xfrm, NS_A, "ext")?;
    let (x, y) = (num(tree.node(off).attr("x"))? / EMU_PER_PT, num(tree.node(off).attr("y"))? / EMU_PER_PT);
    let (w, h) = (num(tree.node(ext).attr("cx"))? / EMU_PER_PT, num(tree.node(ext).attr("cy"))? / EMU_PER_PT);
    let child = match (tree.child(xfrm, NS_A, "chOff"), tree.child(xfrm, NS_A, "chExt")) {
        (Some(o), Some(e)) => {
            let (cx, cy) = (num(tree.node(o).attr("x"))? / EMU_PER_PT, num(tree.node(o).attr("y"))? / EMU_PER_PT);
            let (cw, ch) = (num(tree.node(e).attr("cx"))? / EMU_PER_PT, num(tree.node(e).attr("cy"))? / EMU_PER_PT);
            Some(Rect::new(cx, cy, cx + cw, cy + ch))
        }
        _ => None,
    };
    Some(Xfrm {
        rect: Rect::new(x, y, x + w, y + h),
        rot: num(n.attr("rot")).unwrap_or(0.0) / 60_000.0,
        flip_h: n.attr("flipH") == Some("1"),
        flip_v: n.attr("flipV") == Some("1"),
        child,
    })
}

impl Xfrm {
    /// Maps the shape's own box (0,0)-(w,h) onto the slide.
    fn transform(&self, flips: bool) -> Affine {
        let (w, h) = (self.rect.width(), self.rect.height());
        let c = (w / 2.0, h / 2.0);
        let mut a = Affine::translate((self.rect.x0, self.rect.y0)) * Affine::rotate_about(self.rot.to_radians(), kurbo::Point::new(c.0, c.1));
        if flips && (self.flip_h || self.flip_v) {
            a = a * Affine::translate(c) * Affine::scale_non_uniform(if self.flip_h { -1.0 } else { 1.0 }, if self.flip_v { -1.0 } else { 1.0 }) * Affine::translate((-c.0, -c.1));
        }
        a
    }
}

impl<'a> Ctx<'a> {
    /// Notes that a layout rule not yet confirmed against PowerPoint was used.
    fn provisional(&mut self, rule: &'static str) {
        if !self.out.provisional.contains(&rule) {
            self.out.provisional.push(rule);
        }
    }

    fn diag(&mut self, shape: Option<u32>, kind: &str, detail: impl Into<String>) {
        self.out.diagnostics.push(Diagnostic { shape_id: shape, kind: kind.to_owned(), detail: detail.into() });
    }

    /// The chain for `shape` in `part`: itself, then layout and master placeholders.
    fn chain(&self, part: &Arc<Part>, shape: usize) -> Chain {
        let mut chain = vec![(part.clone(), shape)];
        if let Some((ty, idx)) = placeholder(&part.tree, shape) {
            let mut ty = ty;
            if !Arc::ptr_eq(part, &self.layout) && !Arc::ptr_eq(part, &self.master) {
                if let Some(l) = find_placeholder(&self.layout, &ty, idx) {
                    ty = placeholder(&self.layout.tree, l).map(|p| p.0).unwrap_or(ty);
                    chain.push((self.layout.clone(), l));
                }
            }
            if !Arc::ptr_eq(part, &self.master) {
                if let Some(m) = find_placeholder(&self.master, &ty, None) {
                    chain.push((self.master.clone(), m));
                }
            }
        }
        chain
    }

    fn sp_pr_child(&self, chain: &Chain, local: &str) -> Option<(Arc<Part>, usize)> {
        chain.iter().find_map(|(p, s)| p.tree.child(*s, p.ns, "spPr").and_then(|sp| p.tree.child(sp, NS_A, local)).map(|n| (p.clone(), n)))
    }

    fn paint_from_fill(&self, part: &Part, fill: usize, ph: Option<Rgba>, bounds: Rect, shape: Option<u32>) -> Result<Option<Paint>, String> {
        let t = &part.tree;
        let n = t.node(fill);
        Ok(match n.local.as_str() {
            "noFill" => None,
            "solidFill" => color::read_child(t, fill, &self.colors, ph).map(Paint::Solid),
            "gradFill" => {
                let stops: Vec<(f32, Rgba)> = t
                    .child(fill, NS_A, "gsLst")
                    .map(|l| {
                        t.children_named(l, NS_A, "gs")
                            .filter_map(|g| Some(((num(t.node(g).attr("pos"))? / 100_000.0) as f32, color::read_child(t, g, &self.colors, ph)?)))
                            .collect()
                    })
                    .unwrap_or_default();
                if stops.is_empty() {
                    return Ok(None);
                }
                let stops = color::linear_light_stops(stops);
                let angle = t.child(fill, NS_A, "lin").and_then(|l| num(t.node(l).attr("ang"))).map(|a| a / 60_000.0);
                if angle.is_none() {
                    let _ = shape;
                    // Path gradient (circle/rect/shape) drawn as a radial gradient
                    // from the centre of a:fillToRect to the farthest corner.
                    let ftr = t.child(fill, NS_A, "path").and_then(|p| t.child(p, NS_A, "fillToRect"));
                    let f = |k: &str| ftr.and_then(|n| num(t.node(n).attr(k))).unwrap_or(50_000.0) / 100_000.0;
                    let (l, tp, r, b) = (f("l"), f("t"), f("r"), f("b"));
                    let cx = bounds.x0 + bounds.width() * (l + (1.0 - r)) / 2.0;
                    let cy = bounds.y0 + bounds.height() * (tp + (1.0 - b)) / 2.0;
                    let radius = [(bounds.x0, bounds.y0), (bounds.x1, bounds.y0), (bounds.x0, bounds.y1), (bounds.x1, bounds.y1)]
                        .iter()
                        .map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
                        .fold(1.0, f64::max);
                    return Ok(Some(Paint::Radial { center: (cx, cy), radius, stops }));
                }
                let th = angle.unwrap_or(90.0).to_radians();
                let (cx, cy) = (bounds.center().x, bounds.center().y);
                let half = (bounds.width() * th.cos().abs() + bounds.height() * th.sin().abs()) / 2.0;
                Some(Paint::Linear { start: (cx - half * th.cos(), cy - half * th.sin()), end: (cx + half * th.cos(), cy + half * th.sin()), stops })
            }
            "blipFill" => return Err("picture fill not drawn".into()),
            "pattFill" => {
                let fg = t.child(fill, NS_A, "fgClr").and_then(|c| color::read_child(t, c, &self.colors, ph));
                return match fg {
                    Some(c) => Err(format!("pattern fill drawn as its foreground colour {c:?}")),
                    None => Err("pattern fill not drawn".into()),
                };
            }
            "grpFill" => {
                return match self.group_fills.last().cloned().flatten() {
                    Some((gp, gn)) => self.paint_from_fill(&gp, gn, ph, bounds, shape),
                    None => Ok(None),
                };
            }
            _ => None,
        })
    }

    /// Fill of a shape: explicit spPr fill, else its style's fillRef.
    fn shape_fill(&mut self, chain: &Chain, bounds: Rect, id: u32) -> Option<Paint> {
        for (p, s) in chain {
            let t = &p.tree;
            let Some(sp) = t.child(*s, p.ns, "spPr") else { continue };
            if let Some(&f) = t.node(sp).children.iter().find(|&&c| matches!(t.node(c).local.as_str(), "noFill" | "solidFill" | "gradFill" | "blipFill" | "pattFill" | "grpFill")) {
                return match self.paint_from_fill(p, f, None, bounds, Some(id)) {
                    Ok(paint) => paint,
                    Err(e) => {
                        self.diag(Some(id), "fill", e);
                        if t.node(f).local == "gradFill" { self.gradient_fallback(p, f, bounds) } else { None }
                    }
                };
            }
        }
        let (f, ph) = self.style_fill(chain)?;
        let theme = self.theme.part.clone();
        match self.paint_from_fill(&theme, f, ph, bounds, Some(id)) {
            Ok(p) => p,
            Err(e) => {
                self.diag(Some(id), "fill", e);
                if theme.tree.node(f).local == "gradFill" { self.gradient_fallback(&theme, f, bounds) } else { None }
            }
        }
    }

    /// The theme fill a shape's `p:style/a:fillRef` points at, with its colour.
    fn style_fill(&self, chain: &Chain) -> Option<(usize, Option<Rgba>)> {
        let (p, s) = chain.first()?;
        let t = &p.tree;
        let r = t.path(*s, &[(p.ns, "style"), (NS_A, "fillRef")])?;
        let idx = num(t.node(r).attr("idx"))? as usize;
        let ph = color::read_child(t, r, &self.colors, None);
        let (list, i) = if idx >= 1001 { (&self.theme.bg_styles, idx - 1001) } else { (&self.theme.fill_styles, idx.checked_sub(1)?) };
        Some((*list.get(i)?, ph))
    }

    fn gradient_fallback(&self, part: &Part, fill: usize, bounds: Rect) -> Option<Paint> {
        let t = &part.tree;
        let stops: Vec<(f32, Rgba)> = t
            .child(fill, NS_A, "gsLst")
            .map(|l| t.children_named(l, NS_A, "gs").filter_map(|g| Some(((num(t.node(g).attr("pos"))? / 100_000.0) as f32, color::read_child(t, g, &self.colors, None)?))).collect())
            .unwrap_or_default();
        (!stops.is_empty()).then(|| Paint::Linear { start: (bounds.center().x, bounds.y0), end: (bounds.center().x, bounds.y1), stops })
    }

    fn arrows(&self, chain: &Chain) -> [Option<Arrow>; 2] {
        let Some((p, l)) = self.sp_pr_child(chain, "ln") else { return [None, None] };
        let read = |local: &str| {
            let e = p.tree.child(l, NS_A, local)?;
            let n = p.tree.node(e);
            let kind = n.attr("type").filter(|k| *k != "none")?.to_owned();
            Some(Arrow { kind, width: arrow_size(n.attr("w")), length: arrow_size(n.attr("len")) })
        };
        [read("headEnd"), read("tailEnd")]
    }

    fn shape_stroke(&mut self, chain: &Chain, bounds: Rect, id: u32) -> Option<Stroke> {
        let ln = self.sp_pr_child(chain, "ln");
        let (mut width, mut paint, mut dashes, mut decided) = (None, None, Vec::new(), false);
        if let Some((p, l)) = &ln {
            let t = &p.tree;
            width = num(t.node(*l).attr("w")).map(|w| w / EMU_PER_PT);
            for &c in &t.node(*l).children {
                match t.node(c).local.as_str() {
                    "noFill" => decided = true,
                    "solidFill" | "gradFill" => {
                        paint = self.paint_from_fill(p, c, None, bounds, Some(id)).ok().flatten();
                        decided = true;
                    }
                    "prstDash" => {
                        let w = width.unwrap_or(0.75).max(0.5);
                        dashes = match t.node(c).attr("val") {
                            Some("dash") | Some("sysDash") => vec![3.0 * w, 1.0 * w],
                            Some("dot") | Some("sysDot") => vec![w, w],
                            Some("lgDash") => vec![8.0 * w, 3.0 * w],
                            Some("dashDot") | Some("sysDashDot") => vec![3.0 * w, w, w, w],
                            _ => Vec::new(),
                        }
                    }
                    _ => {}
                }
            }
        }
        if !decided {
            let (p, s) = chain.first()?;
            let t = &p.tree;
            if let Some(r) = t.path(*s, &[(p.ns, "style"), (NS_A, "lnRef")]) {
                let idx = num(t.node(r).attr("idx")).unwrap_or(0.0) as usize;
                let ph = color::read_child(t, r, &self.colors, None);
                if let Some(&l) = idx.checked_sub(1).and_then(|i| self.theme.line_styles.get(i)) {
                    let theme = self.theme.part.clone();
                    let tt = &theme.tree;
                    width = width.or_else(|| num(tt.node(l).attr("w")).map(|w| w / EMU_PER_PT));
                    if let Some(&f) = tt.node(l).children.iter().find(|&&c| matches!(tt.node(c).local.as_str(), "solidFill" | "noFill" | "gradFill")) {
                        paint = self.paint_from_fill(&theme, f, ph, bounds, Some(id)).ok().flatten();
                    }
                }
            }
        }
        paint.map(|paint| Stroke { paint, width: width.unwrap_or(0.75), dashes })
    }

    fn outline(&mut self, chain: &Chain, w: f64, h: f64, id: u32) -> Option<geometry::Geometry> {
        if let Some((p, g)) = self.sp_pr_child(chain, "prstGeom") {
            let path = geometry::preset(&p.tree, g, w, h);
            if path.is_none() {
                let name = p.tree.node(g).attr("prst").unwrap_or("?").to_owned();
                self.diag(Some(id), "geometry", format!("preset '{name}' not drawn"));
            }
            return path;
        }
        if let Some((p, g)) = self.sp_pr_child(chain, "custGeom") {
            let path = geometry::custom(&p.tree, g, w, h);
            if path.is_none() {
                self.diag(Some(id), "geometry", "custom geometry not drawn");
            }
            return path;
        }
        let r = Rect::new(0.0, 0.0, w, h).to_path(0.1);
        Some(geometry::Geometry { fill: r.clone(), stroke: r })
    }

    fn image(&mut self, part: &Part, rid: &str) -> Option<Arc<Pixmap>> {
        let rel = part.rels.iter().find(|r| r.id == rid && !r.external)?;
        let key = self.pres.package().content_key(&rel.target)?;
        if let Some(cached) = self.resources.images.lock().unwrap_or_else(|e| e.into_inner()).0.get(&key) {
            return cached.clone();
        }
        let decoded = self.pres.package().read(&rel.target).ok().and_then(|bytes| {
            if let Some(played) = metafile::play_emf(&bytes) {
                return self.metafile_pixmap(played);
            }
            let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
            let (w, h) = (u16::try_from(img.width()).ok()?, u16::try_from(img.height()).ok()?);
            Some(Arc::new(present_render::pixmap_from_rgba(w, h, img.as_raw())))
        });
        let mut cache = self.resources.images.lock().unwrap_or_else(|e| e.into_inner());
        let size = decoded.as_ref().map_or(0, |p| p.width() as usize * p.height() as usize * 4);
        if cache.1 + size > IMAGE_CACHE_BYTES {
            cache.0.clear();
            cache.1 = 0;
        }
        cache.1 += size;
        cache.0.insert(key, decoded.clone());
        decoded
    }

    /// A played metafile drawn to a transparent bitmap (at most 2048 pixels
    /// on its longer side, two per point).
    fn metafile_pixmap(&self, played: metafile::Played) -> Option<Arc<Pixmap>> {
        let mut items = Vec::new();
        for op in played.ops {
            match op {
                metafile::Op::Item(i) => items.push(i),
                metafile::Op::Text(t) => {
                    let run = TextRun {
                        text: t.text,
                        props: text::RunProps { size: Some(t.size), bold: Some(t.bold), italic: Some(t.italic), color: Some(t.color), latin: Some(t.face.clone()), ea: Some(t.face), ..Default::default() },
                        line_break: false,
                    };
                    let para = Paragraph { props: text::ParaProps { align: Some("l".into()), ..Default::default() }, runs: vec![run.clone()], end_props: run.props.clone(), from_text_break: false };
                    let body = BodyProps { insets: [0.0; 4], wrap: false, ..Default::default() };
                    let mut lay = text::layout(&[para], &body, 10_000.0, 10_000.0, self.fonts, &self.theme.fonts);
                    let (w, base) = lay.lines.first().map(|l| (l.width, l.baseline)).unwrap_or((0.0, 0.0));
                    // Reference point: TA_CENTER/TA_RIGHT across, TA_BASELINE/TA_BOTTOM up.
                    let dx = match t.align & 6 {
                        6 => w / 2.0,
                        2 => w,
                        _ => 0.0,
                    };
                    let dy = match t.align & 24 {
                        24 => base,
                        8 => lay.content_height,
                        _ => 0.0,
                    };
                    let place = Affine::translate(t.at.to_vec2()) * Affine::rotate(-t.angle.to_radians()) * Affine::translate((-dx, -dy));
                    for run in std::mem::take(&mut lay.runs) {
                        items.push(Item::Glyphs { run, transform: place });
                    }
                }
            }
        }
        let scale = (2048.0 / played.width.max(played.height)).min(2.0);
        let scene = Scene { width: played.width, height: played.height, background: None, items };
        Some(Arc::new(present_render::rasterize_transparent(&scene, self.fonts.db(), scale)))
    }

    fn walk(&mut self, part: &Arc<Part>, parent: usize, base: Affine, placeholders: bool) {
        let children = part.tree.node(parent).children.clone();
        for c in children {
            let n = part.tree.node(c);
            if n.ns.as_deref() == Some("http://schemas.openxmlformats.org/markup-compatibility/2006") && n.local == "AlternateContent" {
                // Draw the Fallback branch: we do not implement the Choice extensions.
                if let Some(fb) = part.tree.node(c).children.iter().copied().find(|&x| part.tree.node(x).local == "Fallback") {
                    self.walk(part, fb, base, placeholders);
                }
                continue;
            }
            if n.ns.as_deref() != Some(part.ns) {
                continue;
            }
            let id = shape_id(&part.tree, c).unwrap_or(0);
            let hidden = part
                .tree
                .node(c)
                .children
                .iter()
                .find(|&&x| part.tree.node(x).local.starts_with("nv"))
                .and_then(|nv| part.tree.child(*nv, part.ns, "cNvPr"))
                .is_some_and(|cnv| part.tree.node(cnv).attr("hidden") == Some("1"));
            if hidden {
                continue;
            }
            if !placeholders && placeholder(&part.tree, c).is_some() {
                continue;
            }
            if self.record_frames {
                self.record_frame(part, c, id, base);
            }
            match n.local.as_str() {
                "sp" | "cxnSp" => self.shape(part, c, id, base),
                "pic" => self.picture(part, c, id, base),
                "grpSp" => {
                    let Some(x) = part.tree.path(c, &[(part.ns, "grpSpPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&part.tree, x)) else {
                        self.walk(part, c, base, placeholders);
                        continue;
                    };
                    // Children are positioned in the group's child space
                    // (chOff/chExt), mapped onto the group's box.
                    let ch = x.child.unwrap_or(x.rect);
                    let (sx, sy) = (x.rect.width() / ch.width().max(1e-9), x.rect.height() / ch.height().max(1e-9));
                    let g = base * x.transform(true) * Affine::scale_non_uniform(sx, sy) * Affine::translate((-ch.x0, -ch.y0));
                    let own = part.tree.child(c, part.ns, "grpSpPr").and_then(|sp| {
                        part.tree.node(sp).children.iter().copied().find(|&f| matches!(part.tree.node(f).local.as_str(), "noFill" | "solidFill" | "gradFill" | "blipFill" | "pattFill"))
                    });
                    let inherited = self.group_fills.last().cloned().flatten();
                    self.group_fills.push(own.map(|f| (part.clone(), f)).or(inherited));
                    self.walk(part, c, g, placeholders);
                    self.group_fills.pop();
                }
                "graphicFrame" => {
                    let uri = part.tree.path(c, &[(NS_A, "graphic"), (NS_A, "graphicData")]).and_then(|d| part.tree.node(d).attr("uri")).unwrap_or("").to_owned();
                    if uri.ends_with("/diagram") && self.smartart(part, c, base) {
                        continue;
                    }
                    if uri.ends_with("/table") {
                        self.table(part, c, id, base);
                        continue;
                    }
                    if uri.ends_with("/chart") && self.chart(part, c, base) {
                        continue;
                    }
                    // An embedded object shows its saved preview picture.
                    if uri.ends_with("/ole") {
                        let data = part.tree.path(c, &[(NS_A, "graphic"), (NS_A, "graphicData")]);
                        let mut nodes = Vec::new();
                        if let Some(d) = data {
                            let mut stack = vec![d];
                            while let Some(n) = stack.pop() {
                                nodes.push(n);
                                stack.extend(part.tree.node(n).children.iter().rev());
                            }
                        }
                        // The first preview outside an mc:Choice (the
                        // Fallback, or the object's own picture).
                        let in_choice = |n: usize| {
                            let mut at = part.tree.node(n).parent;
                            while let Some(a) = at {
                                if part.tree.node(a).local == "Choice" {
                                    return true;
                                }
                                at = part.tree.node(a).parent;
                            }
                            false
                        };
                        let pic = nodes.iter().copied().find(|&n| part.tree.node(n).is(NS_P, "pic") && !in_choice(n)).or_else(|| nodes.iter().copied().find(|&n| part.tree.node(n).is(NS_P, "pic")));
                        if let Some(pic) = pic {
                            self.picture(part, pic, id, base);
                            continue;
                        }
                    }
                    let what = if uri.ends_with("/table") {
                        "table"
                    } else if uri.contains("chart") {
                        "chart"
                    } else if uri.ends_with("/diagram") {
                        "SmartArt without a saved drawing (its own layout is not implemented)"
                    } else {
                        "embedded object"
                    };
                    self.diag(Some(id), "notDrawn", format!("{what} not drawn yet"));
                }
                "contentPart" => self.diag(Some(id), "notDrawn", "ink not drawn"),
                _ => {}
            }
        }
    }

    fn record_frame(&mut self, part: &Arc<Part>, shape: usize, id: u32, base: Affine) {
        let t = &part.tree;
        let xfrm = match t.node(shape).local.as_str() {
            "sp" | "cxnSp" | "pic" => self.chain(part, shape).iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&p.tree, x))),
            "grpSp" => t.path(shape, &[(part.ns, "grpSpPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(t, x)),
            "graphicFrame" => t.child(shape, part.ns, "xfrm").and_then(|x| read_xfrm(t, x)),
            _ => None,
        };
        let Some(x) = xfrm else { return };
        let origin = base * kurbo::Point::new(x.rect.x0, x.rect.y0);
        let c = base.as_coeffs();
        let (sx, sy) = (c[0].hypot(c[1]), c[2].hypot(c[3]));
        self.out.frames.push(ShapeFrame { shape_id: id, frame: [origin.x, origin.y, x.rect.width() * sx, x.rect.height() * sy], rotation: x.rot });
    }

    /// Draws a SmartArt frame from the drawing PowerPoint saved with it
    /// (`dsp:drawing`). Returns false when the file has no such drawing.
    fn smartart(&mut self, part: &Arc<Part>, frame: usize, base: Affine) -> bool {
        let t = &part.tree;
        let Some(xfrm) = t.child(frame, part.ns, "xfrm").and_then(|x| read_xfrm(t, x)) else { return false };
        let Some(ids) = t.path(frame, &[(NS_A, "graphic"), (NS_A, "graphicData"), (NS_DGM, "relIds")]) else { return false };
        let Some(dm) = t.node(ids).attr_ns(NS_R, "dm").and_then(|r| part.rels.iter().find(|x| x.id == r)).map(|r| r.target.clone()) else { return false };
        let Ok(data) = load_part(self.pres, &dm) else { return false };
        let rel = |k: &str| t.node(ids).attr_ns(NS_R, k).and_then(|r| part.rels.iter().find(|x| x.id == r)).map(|r| r.target.clone());
        let rels = [Some(dm.clone()), rel("lo"), rel("qs"), rel("cs")];
        let drawing = data.tree.nodes.iter().find(|n| n.local == "dataModelExt").and_then(|n| n.attr("relId")).and_then(|r| part.rels.iter().find(|x| x.id == r)).and_then(|r| load_part_ns(self.pres, &r.target, NS_DSP).ok());
        let tree_node = drawing.as_ref().and_then(|d| d.tree.child(d.tree.root, NS_DSP, "spTree"));
        // Without a saved drawing PowerPoint lays the SmartArt out itself.
        let (Some(drawing), Some(tree_node)) = (drawing, tree_node) else { return self.diagram(part, frame, base, xfrm.rect, rels) };
        if !drawing.tree.node(tree_node).children.iter().any(|&c| matches!(drawing.tree.node(c).local.as_str(), "sp" | "grpSp")) {
            return self.diagram(part, frame, base, xfrm.rect, rels);
        }
        // Drawing coordinates are relative to the frame.
        let record = std::mem::replace(&mut self.record_frames, false);
        self.walk(&drawing, tree_node, base * Affine::translate((xfrm.rect.x0, xfrm.rect.y0)), true);
        self.record_frames = record;
        true
    }

    fn shape(&mut self, part: &Arc<Part>, shape: usize, id: u32, base: Affine) {
        let chain = self.chain(part, shape);
        let mut box_drawn = false;
        let Some(xfrm) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&p.tree, x))) else {
            return;
        };
        let (w, h) = (xfrm.rect.width(), xfrm.rect.height());
        let bounds = Rect::new(0.0, 0.0, w, h);
        let transform = base * xfrm.transform(true);
        let first_item = self.out.scene.items.len();
        let mut effect_outline = bounds.to_path(0.1);
        if let Some(geom) = self.outline(&chain, w, h, id) {
            let path = geom.fill.clone();
            effect_outline = if path.elements().is_empty() { geom.stroke.clone() } else { path.clone() };
            // A picture fill is drawn as the picture clipped to the outline.
            let explicit = chain.iter().find_map(|(p, s)| {
                let sp = p.tree.child(*s, p.ns, "spPr")?;
                p.tree.node(sp).children.iter().copied().find(|&c| matches!(p.tree.node(c).local.as_str(), "noFill" | "solidFill" | "gradFill" | "blipFill" | "pattFill" | "grpFill")).map(|c| (p.clone(), c))
            });
            // Without an explicit fill, the style may point at a theme picture fill.
            let picture = match &explicit {
                Some((p, f)) => (p.tree.node(*f).local == "blipFill").then(|| (p.clone(), *f)),
                None => self.style_fill(&chain).map(|(f, _)| (self.theme.part.clone(), f)).filter(|(p, f)| p.tree.node(*f).local == "blipFill"),
            };
            let picture_filled = picture.is_some();
            if let Some((p, f)) = picture {
                if let Some(item) = self.blip_item(&p, f, bounds, transform, Some(path.clone()), Some(id)) {
                    self.out.scene.items.push(item);
                }
            }
            let fill = if part.tree.node(shape).local == "cxnSp" || picture_filled {
                None
            } else if part.tree.node(shape).attr("useBgFill") == Some("1") && explicit.is_none() {
                // Filled with the slide background (an explicit fill wins,
                // as PowerPoint draws it).
                if self.out.scene.background.is_none() {
                    self.diag(Some(id), "fill", "background fill of a picture background not drawn");
                }
                self.out.scene.background.clone().map(|bg| match bg {
                    // A gradient background spans the slide, not the shape.
                    Paint::Linear { start, end, stops } => {
                        let inv = transform.inverse();
                        Paint::Linear { start: (inv * kurbo::Point::from(start)).into(), end: (inv * kurbo::Point::from(end)).into(), stops }
                    }
                    solid => solid,
                })
            } else {
                self.shape_fill(&chain, bounds, id)
            };
            let stroke = self.shape_stroke(&chain, bounds, id);
            let heads = if stroke.is_some() { self.arrows(&chain) } else { [None, None] };
            let mut arrow_items = Vec::new();
            if let Some(s) = &stroke {
                use kurbo::{ParamCurve, ParamCurveArclen};
                // Arrows point along the first and last segments that have
                // length (a bent connector with no width ends in a
                // zero-length segment).
                let segs: Vec<kurbo::PathSeg> = geom.stroke.segments().filter(|g| g.arclen(1e-3) > 1e-6).collect();
                let ends = [
                    segs.first().map(|g| (g.start(), g.start() - g.eval(0.01))),
                    segs.last().map(|g| (g.end(), g.end() - g.eval(0.99))),
                ];
                for (arrow, end) in heads.iter().zip(ends) {
                    if let (Some(a), Some((tip, dir))) = (arrow, end) {
                        if let Some((p, filled)) = arrow_path(a, tip, dir, s.width) {
                            let (fill, stroke) = if filled {
                                (Some(s.paint.clone()), None)
                            } else {
                                (None, Some(Stroke { paint: s.paint.clone(), width: s.width, dashes: Vec::new() }))
                            };
                            arrow_items.push(Item::Path { path: p, transform, fill, stroke });
                        }
                    }
                }
            }
            if fill.is_some() || stroke.is_some() {
                box_drawn = true;
                let outline = if fill.is_some() { &path } else { &geom.stroke };
                self.shadow(&chain, outline, transform, id);
            }
            // Some presets fill and outline different subpaths.
            if fill.is_some() && !path.elements().is_empty() {
                self.out.scene.items.push(Item::Path { path, transform, fill, stroke: None });
            }
            if stroke.is_some() && !geom.stroke.elements().is_empty() {
                self.out.scene.items.push(Item::Path { path: geom.stroke, transform, fill: None, stroke });
            }
            self.out.scene.items.extend(arrow_items);
        }
        let geometry_end = self.out.scene.items.len();
        if let Some(body) = part.tree.child(shape, part.ns, "txBody") {
            // SmartArt drawings place text in their own rectangle.
            let text_xfrm = part.tree.child(shape, part.ns, "txXfrm").and_then(|x| read_xfrm(&part.tree, x)).unwrap_or(xfrm);
            // A shape with neither fill nor outline casts its shadow from
            // its text (measured, 2026-10-11-edit-commands-2.md).
            let text_shadow = if box_drawn { None } else { self.shape_shadow_spec(&chain) };
            self.text(part, &chain, shape, body, id, text_xfrm, base, text_shadow);
        }
        self.effects(&chain, first_item..geometry_end, &effect_outline, transform, w, h, id);
    }

    /// Glow, soft edges and reflection of `a:effectLst`, applied to the items
    /// the shape drew from `geometry.start` on (outer shadows are drawn with
    /// the shape itself); `geometry` are its fill, outline or picture items,
    /// before its text. `outline` is the shape's outline in its own box.
    #[allow(clippy::too_many_arguments)]
    fn effects(&mut self, chain: &Chain, geometry: std::ops::Range<usize>, outline: &BezPath, transform: Affine, w: f64, h: f64, id: u32) {
        let first_item = geometry.start;
        let Some((p, e)) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "effectLst")]).map(|e| (p.clone(), e))) else { return };
        let t = &p.tree;
        let emu = |n: usize, k: &str| num(t.node(n).attr(k)).unwrap_or(0.0) / EMU_PER_PT;
        let frac = |n: usize, k: &str, d: f64| num(t.node(n).attr(k)).map(|v| v / 100_000.0).unwrap_or(d);
        let mut undrawn = Vec::new();
        for &c in &t.node(e).children {
            match t.node(c).local.as_str() {
                "outerShdw" => {}
                "glow" => {
                    let rad = emu(c, "rad");
                    let Some(color) = color::read_child(t, c, &self.colors, None) else { continue };
                    if rad <= 0.0 {
                        continue;
                    }
                    // The glow colour behind the shape, seen through a blurred,
                    // opaque silhouette of what the shape draws (fill, outline,
                    // picture; not its text) grown by the radius. A shape that
                    // draws none of these has no glow (PowerPoint, 24 of 24
                    // unfilled shapes). The opaque mask keeps overlaps from
                    // compounding the alpha.
                    let opaque = Paint::Solid(Rgba { a: 255, ..color });
                    let grow = |width: f64| Some(Stroke { paint: opaque.clone(), width: width + rad * GLOW_GROWTH, dashes: Vec::new() });
                    let silhouette: Vec<Item> = self.out.scene.items[geometry.clone()]
                        .iter()
                        .filter_map(|i| match i {
                            Item::Path { path, transform, fill, stroke } => {
                                let filled = matches!(fill, Some(Paint::Solid(c)) if c.a > 0) || matches!(fill, Some(Paint::Linear { .. } | Paint::Radial { .. }));
                                let width = stroke.as_ref().map(|s| s.width);
                                (filled || width.is_some()).then(|| Item::Path { path: path.clone(), transform: *transform, fill: filled.then(|| opaque.clone()), stroke: grow(width.unwrap_or(0.0)) })
                            }
                            Item::Image { .. } => Some(Item::Path { path: outline.clone(), transform, fill: Some(opaque.clone()), stroke: grow(0.0) }),
                            _ => None,
                        })
                        .collect();
                    if silhouette.is_empty() {
                        continue;
                    }
                    let area = outline.bounding_box().inflate(rad * 3.0 + w.max(h), rad * 3.0 + w.max(h)).to_path(0.1);
                    let glow = Item::Path { path: area, transform, fill: Some(Paint::Solid(color)), stroke: None };
                    self.out.scene.items.insert(first_item, Item::Masked { mask: vec![Item::Blurred { sigma: rad * GLOW_SIGMA_PER_RADIUS, items: silhouette }], items: vec![glow] });
                    self.provisional("glow");
                }
                "softEdge" => {
                    let rad = emu(c, "rad").min(w.min(h) / 2.0);
                    if rad <= 0.0 {
                        continue;
                    }
                    // The shape fades out towards its edge: drawn through a
                    // blurred copy of its outline shrunk by half the radius.
                    let inset = Affine::translate((w / 2.0, h / 2.0)) * Affine::scale_non_uniform(((w - rad) / w).max(0.0), ((h - rad) / h).max(0.0)) * Affine::translate((-w / 2.0, -h / 2.0));
                    let mask = Item::Path { path: inset * outline.clone(), transform, fill: Some(Paint::Solid(present_render::Rgba::WHITE)), stroke: None };
                    let items: Vec<Item> = self.out.scene.items.drain(first_item..).collect();
                    self.out.scene.items.push(Item::Masked { mask: vec![Item::Blurred { sigma: rad / 4.0, items: vec![mask] }], items });
                    self.provisional("softEdge");
                }
                "reflection" => {
                    let (st, end_a, end_pos) = (frac(c, "stA", 1.0), frac(c, "endA", 0.0), frac(c, "endPos", 1.0));
                    let (dist, blur) = (emu(c, "dist"), emu(c, "blurRad"));
                    // Mirrored about the bottom edge (PowerPoint's default
                    // reflection, sy = -100%), fading from stA to endA.
                    let mirror = Affine::translate((0.0, 2.0 * h + dist)) * Affine::scale_non_uniform(1.0, -1.0);
                    let to_slide = transform * mirror * transform.inverse();
                    let copy: Vec<Item> = self.out.scene.items[first_item..].iter().map(|i| i.transformed(to_slide)).collect();
                    let (y0, y1) = (h + dist, h + dist + end_pos * h);
                    let white = |a: f64| present_render::Rgba { a: (a.clamp(0.0, 1.0) * 255.0).round() as u8, ..present_render::Rgba::WHITE };
                    let fade = Item::Path {
                        path: Rect::new(-w, y0, 2.0 * w, y0 + h).to_path(0.1),
                        transform,
                        fill: Some(Paint::Linear { start: (0.0, y0), end: (0.0, y1.max(y0 + 0.01)), stops: vec![(0.0, white(st)), (1.0, white(end_a))] }),
                        stroke: None,
                    };
                    let reflected = if blur > 0.0 { vec![Item::Blurred { sigma: blur / 2.0, items: copy }] } else { copy };
                    self.out.scene.items.push(Item::Masked { mask: vec![fade], items: reflected });
                    self.provisional("reflection");
                }
                other => undrawn.push(other.to_owned()),
            }
        }
        if !undrawn.is_empty() {
            self.diag(Some(id), "effect", format!("effects not drawn: {}", undrawn.join(", ")));
        }
    }

    /// The shape's own outer shadow (`spPr/effectLst/outerShdw`) as a text shadow.
    fn shape_shadow_spec(&self, chain: &Chain) -> Option<text::TextShadow> {
        let (p, e) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "effectLst")]).map(|e| (p.clone(), e)))?;
        let t = &p.tree;
        let sh = t.child(e, NS_A, "outerShdw")?;
        let n = t.node(sh);
        let dist = num(n.attr("dist")).unwrap_or(0.0) / EMU_PER_PT;
        let dir = (num(n.attr("dir")).unwrap_or(0.0) / 60_000.0).to_radians();
        let color = color::read_child(t, sh, &self.colors, None)?;
        Some(text::TextShadow { dx: dist * dir.cos(), dy: dist * dir.sin(), blur: num(n.attr("blurRad")).unwrap_or(0.0) / EMU_PER_PT, color })
    }

    /// Draws `a:outerShdw` of the shape's effect list under the shape: the
    /// outline offset by distance/direction in the shadow colour, softened by
    /// layered strokes approximating the blur radius.
    fn shadow(&mut self, chain: &Chain, outline: &BezPath, transform: Affine, id: u32) {
        let Some((p, e)) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "effectLst")]).map(|e| (p.clone(), e))) else { return };
        let t = &p.tree;
        let Some(sh) = t.child(e, NS_A, "outerShdw") else { return };
        let n = t.node(sh);
        let Some(color) = color::read_child(t, sh, &self.colors, None) else { return };
        let dist = num(n.attr("dist")).unwrap_or(0.0) / EMU_PER_PT;
        let dir = num(n.attr("dir")).unwrap_or(0.0) / 60_000.0;
        let blur = num(n.attr("blurRad")).unwrap_or(0.0) / EMU_PER_PT;
        let (sx, sy) = (num(n.attr("sx")).unwrap_or(100_000.0) / 100_000.0, num(n.attr("sy")).unwrap_or(100_000.0) / 100_000.0);
        // Offset is on the slide, not rotated with the shape.
        let offset = Affine::translate((dist * dir.to_radians().cos(), dist * dir.to_radians().sin()));
        let bounds = outline.bounding_box();
        let scale = Affine::translate((bounds.center().x, bounds.center().y)) * Affine::scale_non_uniform(sx, sy) * Affine::translate((-bounds.center().x, -bounds.center().y));
        let shadow_t = offset * transform * scale;
        let item = Item::Path { path: outline.clone(), transform: shadow_t, fill: Some(Paint::Solid(color)), stroke: None };
        if blur > 0.0 {
            self.provisional("shadowBlur");
            self.out.scene.items.push(Item::Blurred { sigma: blur * SHADOW_SIGMA_PER_RADIUS, items: vec![item] });
        } else {
            self.out.scene.items.push(item);
        }
        let _ = id;
    }

    /// An image item for `a:blipFill` node `blip_fill` of `part`, stretched
    /// over `dest` and cropped by `a:srcRect`.
    fn blip_item(&mut self, part: &Part, blip_fill: usize, dest: Rect, transform: Affine, clip: Option<BezPath>, id: Option<u32>) -> Option<Item> {
        let t = &part.tree;
        let blip = t.child(blip_fill, NS_A, "blip")?;
        let Some(rid) = t.node(blip).attr_ns(NS_R, "embed").map(str::to_owned) else {
            self.diag(id, "notDrawn", "linked picture not drawn");
            return None;
        };
        let Some(mut img) = self.image(part, &rid) else {
            self.diag(id, "notDrawn", "picture format not decoded (e.g. EMF/WMF)");
            return None;
        };
        if let Some(a) = t.child(blip, NS_A, "alphaModFix").and_then(|n| num(t.node(n).attr("amt"))) {
            let mut pm = (*img).clone();
            pm.multiply_alpha((a / 100_000.0 * 255.0).round().clamp(0.0, 255.0) as u8);
            img = Arc::new(pm);
        }
        if let Some(lum) = t.child(blip, NS_A, "lum") {
            // Brightness shifts and contrast scales around mid-grey (approximation).
            let bright = num(t.node(lum).attr("bright")).unwrap_or(0.0) / 100_000.0;
            let contrast = num(t.node(lum).attr("contrast")).unwrap_or(0.0) / 100_000.0;
            let mut pm = (*img).clone();
            let factor = if contrast >= 0.0 { 1.0 / (1.0 - contrast).max(0.01) } else { 1.0 + contrast };
            for px in pm.data_mut() {
                if px.a == 0 {
                    continue;
                }
                let a = px.a as f64 / 255.0;
                let adj = |c: u8| {
                    let v = c as f64 / 255.0 / a;
                    let v = ((v - 0.5) * factor + 0.5 + bright).clamp(0.0, 1.0);
                    (v * a * 255.0).round() as u8
                };
                (px.r, px.g, px.b) = (adj(px.r), adj(px.g), adj(px.b));
            }
            img = Arc::new(pm);
            if !self.out.provisional.contains(&"pictureBrightnessContrast") {
                self.out.provisional.push("pictureBrightnessContrast");
            }
        }
        if t.child(blip, NS_A, "duotone").is_some() || t.child(blip, NS_A, "grayscl").is_some() || t.child(blip, NS_A, "biLevel").is_some() {
            self.diag(id, "picture", "picture recolouring (duotone/greyscale/black and white) not applied");
        }
        if t.child(blip_fill, NS_A, "tile").is_some() {
            self.diag(id, "picture", "tiled picture fill drawn stretched");
        }
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        let mut crop = Rect::new(0.0, 0.0, iw, ih);
        if let Some(src) = t.child(blip_fill, NS_A, "srcRect") {
            let f = |k: &str| num(t.node(src).attr(k)).unwrap_or(0.0) / 100_000.0;
            crop = Rect::new(iw * f("l"), ih * f("t"), iw * (1.0 - f("r")), ih * (1.0 - f("b")));
        }
        Some(Item::Image { image: img, crop, dest, transform, clip })
    }

    fn picture(&mut self, part: &Arc<Part>, pic: usize, id: u32, base: Affine) {
        let chain = self.chain(part, pic);
        let Some(xfrm) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&p.tree, x))) else { return };
        let (w, h) = (xfrm.rect.width(), xfrm.rect.height());
        let Some(blip_fill) = part.tree.child(pic, part.ns, "blipFill") else { return };
        let clip = self.outline(&chain, w, h, id).map(|g| g.fill).filter(|_| self.sp_pr_child(&chain, "prstGeom").is_some_and(|(p, g)| p.tree.node(g).attr("prst") != Some("rect")));
        let transform = base * xfrm.transform(true);
        let first_item = self.out.scene.items.len();
        let outline = clip.clone().unwrap_or_else(|| Rect::new(0.0, 0.0, w, h).to_path(0.1));
        if let Some(item) = self.blip_item(part, blip_fill, Rect::new(0.0, 0.0, w, h), transform, clip, Some(id)) {
            self.out.scene.items.push(item);
        }
        if let Some(stroke) = self.shape_stroke(&chain, Rect::new(0.0, 0.0, w, h), id) {
            let path = self.outline(&chain, w, h, id).map(|g| g.stroke).unwrap_or_else(|| Rect::new(0.0, 0.0, w, h).to_path(0.1));
            self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(stroke) });
        }
        let end = self.out.scene.items.len();
        self.effects(&chain, first_item..end, &outline, transform, w, h, id);
    }

    /// Paragraphs and body properties of a text body, after inheritance.
    fn text_inputs(&mut self, part: &Arc<Part>, chain: &Chain, shape: usize, body: usize) -> (Vec<Paragraph>, BodyProps) {
        let t = &part.tree;
        // Body properties: master, then layout, then the shape.
        let mut body_props = BodyProps::default();
        for (p, s) in chain.iter().rev() {
            if let Some(b) = p.tree.child(*s, p.ns, "txBody").and_then(|tb| p.tree.child(tb, NS_A, "bodyPr")) {
                text::merge_body(&mut body_props, p, b);
            }
        }
        // List style sources, lowest priority first.
        let ph = placeholder(t, shape);
        let mut sources: Vec<StyleSource> = Vec::new();
        match &ph {
            Some((ty, _)) => {
                let name = match ty.as_str() {
                    "title" | "ctrTitle" => "titleStyle",
                    "body" | "subTitle" | "obj" => "bodyStyle",
                    _ => "otherStyle",
                };
                if let Some(n) = self.master.tree.path(self.master.tree.root, &[(NS_P, "txStyles"), (NS_P, name)]) {
                    sources.push(StyleSource { part: self.master.clone(), node: n });
                }
            }
            None => {
                if let Some(n) = self.pres_part.tree.child(self.pres_part.tree.root, NS_P, "defaultTextStyle") {
                    sources.push(StyleSource { part: self.pres_part.clone(), node: n });
                }
            }
        }
        for (p, s) in chain.iter().rev() {
            if let Some(ls) = p.tree.child(*s, p.ns, "txBody").and_then(|tb| p.tree.child(tb, NS_A, "lstStyle")) {
                sources.push(StyleSource { part: p.clone(), node: ls });
            }
        }
        // Shape style font colour and font (p:style/a:fontRef).
        let font_ref = t.path(shape, &[(part.ns, "style"), (NS_A, "fontRef")]);
        let ref_color = font_ref.and_then(|r| color::read_child(t, r, &self.colors, None));
        let ref_font = font_ref.and_then(|r| t.node(r).attr("idx")).map(|i| if i == "major" { "+mj-lt" } else { "+mn-lt" });

        // In a SmartArt drawing the style's theme fonts replace the inherited
        // ones, East Asian included (measured: Hangul under a presentation
        // default of Arial is drawn in the theme's NanumSquareRound).
        let ref_ea = font_ref.filter(|_| part.ns == NS_DSP).and_then(|r| t.node(r).attr("idx")).map(|i| if i == "major" { "+mj-ea" } else { "+mn-ea" });
        let overlay = text::RunProps { color: ref_color, latin: ref_font.map(str::to_owned), ea: ref_ea.map(str::to_owned), ..Default::default() };
        let paragraphs = self.paragraphs(part, body, &sources, &overlay);
        (paragraphs, body_props)
    }

    /// Draws the East Asian runs of vertical East Asian text one glyph at a
    /// time, each turned back a quarter turn about its em box centre, and
    /// removes them from `layout`.
    fn emit_upright(&mut self, layout: &mut text::TextLayout, transform: Affine) {
        let mut rest = Vec::new();
        for (run, ea) in std::mem::take(&mut layout.runs).into_iter().zip(std::mem::take(&mut layout.upright)) {
            if !ea {
                rest.push(run);
                continue;
            }
            let k = run.size / run.face.units_per_em().max(1.0);
            for g in &run.glyphs {
                let advance = run.face.advance(g.gid) * k;
                // The em box centre: half the advance along the line, the
                // middle of the size across it (ascent ~0.88, descent ~0.12).
                let c = kurbo::Point::new(g.x + advance / 2.0, g.y - run.size * 0.38);
                let turn = Affine::translate(c.to_vec2()) * Affine::rotate(-std::f64::consts::FRAC_PI_2) * Affine::translate(-c.to_vec2());
                let mut one = run.clone();
                one.glyphs = vec![g.clone()];
                self.out.scene.items.push(Item::Glyphs { run: one, transform: transform * turn });
            }
        }
        layout.runs = rest;
    }

    /// The glyphs of `run` as one path in the text box.
    fn run_path(&self, run: &present_render::GlyphRun) -> BezPath {
        let k = run.size / run.face.units_per_em().max(1.0);
        let shear = Affine::new([1.0, 0.0, -run.skew, 1.0, 0.0, 0.0]);
        let mut out = BezPath::new();
        for g in &run.glyphs {
            let outline = self.fonts.db().outline(&run.face, g.gid);
            out.extend((Affine::translate((g.x, g.y)) * shear * Affine::scale(k) * (*outline).clone()).elements().iter().copied());
        }
        out
    }

    /// Draws laid-out text bent by a WordArt warp, as paths: glows, shadows,
    /// glyphs and bars in the same order as `emit_text`.
    fn emit_warped(&mut self, layout: &mut text::TextLayout, warp: &warp::Warp, transform: Affine) {
        let runs = std::mem::take(&mut layout.runs);
        let paths: Vec<BezPath> = runs.iter().map(|r| self.run_path(r)).collect();
        let Some(ink) = warp::ink_box(&paths) else { return };
        let line = |l: &text::LineInfo| (l.baseline, l.size);
        let reference = match (layout.lines.first(), layout.lines.last()) {
            (Some(f), Some(l)) => warp.reference(line(f), line(l)),
            _ => ink.y1,
        };
        self.provisional("textWarp");
        let solid = |c: Rgba| Some(Paint::Solid(c));
        for (run, rad, color) in std::mem::take(&mut layout.glows) {
            let opaque = Rgba { a: 255, ..color };
            let path = warp.apply(ink, reference, &self.run_path(&run));
            let silhouette = Item::Path { path, transform, fill: solid(opaque), stroke: Some(Stroke { paint: Paint::Solid(opaque), width: rad * TEXT_GLOW_GROWTH, dashes: Vec::new() }) };
            let area = Rect::new(-1.0e5, -1.0e5, 1.0e5, 1.0e5).to_path(0.1);
            let glow = Item::Path { path: area, transform, fill: solid(color), stroke: None };
            self.out.scene.items.push(Item::Masked { mask: vec![Item::Blurred { sigma: rad * TEXT_GLOW_SIGMA_PER_RADIUS, items: vec![silhouette] }], items: vec![glow] });
            self.provisional("glow");
        }
        for (run, blur) in std::mem::take(&mut layout.shadows) {
            let item = Item::Path { path: warp.apply(ink, reference, &self.run_path(&run)), transform, fill: solid(run.color), stroke: None };
            if blur > 0.0 {
                self.provisional("shadowBlur");
                self.out.scene.items.push(Item::Blurred { sigma: blur * SHADOW_SIGMA_PER_RADIUS, items: vec![item] });
            } else {
                self.out.scene.items.push(item);
            }
        }
        for (run, path) in runs.iter().zip(paths) {
            let path = warp.apply(ink, reference, &path);
            if run.color.a > 0 {
                let stroke = (run.embolden > 0.0).then(|| Stroke { paint: Paint::Solid(run.color), width: run.embolden, dashes: Vec::new() });
                self.out.scene.items.push(Item::Path { path: path.clone(), transform, fill: solid(run.color), stroke });
            }
            if let Some((width, color)) = run.outline {
                self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(Stroke { paint: Paint::Solid(color), width, dashes: Vec::new() }) });
            }
        }
        for (rect, color) in std::mem::take(&mut layout.decorations) {
            self.out.scene.items.push(Item::Path { path: warp.apply(ink, reference, &rect.to_path(0.1)), transform, fill: solid(color), stroke: None });
        }
        layout.upright.clear();
    }

    /// Draws laid-out text: shadows underneath, then glyph runs and their
    /// underline/strikethrough bars.
    fn emit_text(&mut self, layout: &mut text::TextLayout, transform: Affine) {
        let (runs, bars, shadows) = (std::mem::take(&mut layout.runs), std::mem::take(&mut layout.decorations), std::mem::take(&mut layout.shadows));
        // Glows as for shapes: the colour through a blurred, opaque
        // silhouette of the glyphs grown by the radius.
        for (mut run, rad, color) in std::mem::take(&mut layout.glows) {
            let opaque = Rgba { a: 255, ..color };
            run.color = opaque;
            run.outline = Some((rad * TEXT_GLOW_GROWTH, opaque));
            let area = Rect::new(-1.0e5, -1.0e5, 1.0e5, 1.0e5).to_path(0.1);
            let glow = Item::Path { path: area, transform, fill: Some(Paint::Solid(color)), stroke: None };
            self.out.scene.items.push(Item::Masked { mask: vec![Item::Blurred { sigma: rad * TEXT_GLOW_SIGMA_PER_RADIUS, items: vec![Item::Glyphs { run, transform }] }], items: vec![glow] });
            self.provisional("glow");
        }
        // One blur layer per blur radius for the whole text body.
        let mut groups: Vec<(f64, Vec<Item>)> = Vec::new();
        for (run, blur) in shadows {
            let item = Item::Glyphs { run, transform };
            match groups.iter_mut().find(|(b, _)| *b == blur) {
                Some((_, items)) => items.push(item),
                None => groups.push((blur, vec![item])),
            }
        }
        for (blur, items) in groups {
            if blur > 0.0 {
                self.provisional("shadowBlur");
                self.out.scene.items.push(Item::Blurred { sigma: blur * SHADOW_SIGMA_PER_RADIUS, items });
            } else {
                self.out.scene.items.extend(items);
            }
        }
        for run in runs {
            self.out.scene.items.push(Item::Glyphs { run, transform });
        }
        for (rect, color) in bars {
            self.out.scene.items.push(Item::Path { path: rect.to_path(0.1), transform, fill: Some(Paint::Solid(color)), stroke: None });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, part: &Arc<Part>, chain: &Chain, shape: usize, body: usize, id: u32, xfrm: Xfrm, base: Affine, shape_shadow: Option<text::TextShadow>) {
        let t = &part.tree;
        let body_node = body;
        let (mut paragraphs, body_props) = self.text_inputs(part, chain, shape, body);
        if let Some(sh) = shape_shadow {
            for r in paragraphs.iter_mut().flat_map(|p| p.runs.iter_mut()) {
                if r.props.shadow.is_none() {
                    r.props.shadow = Some(Some(sh));
                }
            }
        }
        // A group scales the text box but not the text: PowerPoint lays the
        // text out at its own size in the box as drawn on the slide.
        let (sx, sy) = axis_scales(base);
        let (w, h) = (xfrm.rect.width() * sx, xfrm.rect.height() * sy);
        // A SmartArt drawing shape's text box (txXfrm) is its text area already.
        let body_props = if t.child(shape, part.ns, "txXfrm").is_some() { body_props } else { in_text_area(body_props, chain, w, h) };
        let mut body = body_props.clone();
        let (lw, lh, frame, turned) = turn_vertical(&mut body, w, h);
        let mut layout = text::layout(&paragraphs, &body, lw, lh, self.fonts, &self.theme.fonts);
        let overflow = overflow_of(&layout, &body, lh);
        // Text rotates with the shape but does not mirror.
        let transform = base * xfrm.transform(false) * Affine::scale_non_uniform(1.0 / sx, 1.0 / sy) * frame;
        // WordArt warps (horizontal text only).
        let align = match paragraphs.first().and_then(|p| p.props.align.as_deref()) {
            Some("ctr") => 0.5,
            Some("r") => 1.0,
            _ => 0.0,
        };
        let warp = t
            .child(body_node, NS_A, "bodyPr")
            .and_then(|b| t.child(b, NS_A, "prstTxWarp"))
            .filter(|_| !turned)
            .and_then(|n| geometry::text_warp(t, n, lw, lh))
            .and_then(|paths| warp::Warp::new(&paths, lw, lh, align));
        if let Some(warp) = warp {
            self.emit_warped(&mut layout, &warp, transform);
        } else {
            if body_props.vert == "eaVert" {
                self.emit_upright(&mut layout, transform);
            }
            self.emit_text(&mut layout, transform);
        }
        for p in layout.provisional {
            if !self.out.provisional.contains(&p) {
                self.out.provisional.push(p);
            }
        }
        let name = t
            .node(shape)
            .children
            .iter()
            .find(|&&x| t.node(x).local.starts_with("nv"))
            .and_then(|nv| t.child(*nv, part.ns, "cNvPr"))
            .and_then(|c| t.node(c).attr("name"))
            .unwrap_or("")
            .to_owned();
        let origin = base * kurbo::Point::new(xfrm.rect.x0, xfrm.rect.y0);
        self.out.texts.push(TextBoxInfo { shape_id: id, name, frame: [origin.x, origin.y, w, h], lines: layout.lines, fonts: layout.fonts, overflow, on_slide: false });
    }

    /// Paragraphs of text body `body` with list styles `sources` (lowest
    /// priority first). `overlay` sets the colour and bold of the default run
    /// (shape style or table style) and supplies a font when none is inherited.
    fn paragraphs(&self, part: &Part, body: usize, sources: &[StyleSource], overlay: &text::RunProps) -> Vec<Paragraph> {
        let t = &part.tree;
        let mut paragraphs = Vec::new();
        for p in t.children_named(body, NS_A, "p") {
            let ppr = t.child(p, NS_A, "pPr");
            let level = ppr.and_then(|n| num(t.node(n).attr("lvl"))).unwrap_or(0.0) as usize;
            let mut props = text::level_props(sources, level, &self.colors);
            if overlay.color.is_some() {
                props.def_run.color = overlay.color;
            }
            if overlay.bold.is_some() {
                props.def_run.bold = overlay.bold;
            }
            if overlay.ea.is_some() {
                // A table style's font replaces the inherited default fonts.
                props.def_run.latin = overlay.latin.clone();
                props.def_run.ea = overlay.ea.clone();
            } else if props.def_run.latin.is_none() {
                props.def_run.latin = overlay.latin.clone();
            }
            if let Some(n) = ppr {
                text::merge_para(&mut props, part, n, &self.colors);
            }
            let mut runs = Vec::new();
            let mut end_props = props.def_run.clone();
            for &c in &t.node(p).children {
                let n = t.node(c);
                if n.ns.as_deref() != Some(NS_A) {
                    continue;
                }
                let mut rp = props.def_run.clone();
                if let Some(r) = t.child(c, NS_A, "rPr") {
                    text::merge_run(&mut rp, part, r, &self.colors);
                }
                match n.local.as_str() {
                    "r" | "fld" => {
                        let mut text = t.child(c, NS_A, "t").and_then(|x| t.text(&part.src, x).ok()).unwrap_or_default();
                        // PowerPoint draws the current number, not the stored text.
                        if n.local == "fld" && n.attr("type") == Some("slidenum") {
                            text = self.slide_number.to_string();
                        }
                        runs.push(TextRun { text, props: rp, line_break: false });
                    }
                    "br" => runs.push(TextRun { text: String::new(), props: rp, line_break: true }),
                    "endParaRPr" => text::merge_run(&mut end_props, part, c, &self.colors),
                    _ => {}
                }
            }
            paragraphs.extend(text::split_text_breaks(Paragraph { props, runs, end_props, from_text_break: false }));
        }
        paragraphs
    }

    fn background(&mut self, parts: &[Arc<Part>], size: Rect) {
        for part in parts {
            let t = &part.tree;
            let Some(bg) = t.path(t.root, &[(NS_P, "cSld"), (NS_P, "bg")]) else { continue };
            if let Some(pr) = t.child(bg, NS_P, "bgPr") {
                let Some(&f) = t.node(pr).children.iter().find(|&&c| t.node(c).ns.as_deref() == Some(NS_A) && t.node(c).local.ends_with("Fill")) else { return };
                if t.node(f).local == "blipFill" {
                    if let Some(item) = self.blip_item(part, f, size, Affine::IDENTITY, None, None) {
                        self.out.scene.items.insert(0, item);
                    }
                    return;
                }
                match self.paint_from_fill(part, f, None, size, None) {
                    Ok(p) => self.out.scene.background = p,
                    Err(e) => {
                        self.diag(None, "background", e);
                        self.out.scene.background = self.gradient_fallback(part, f, size);
                    }
                }
                return;
            }
            if let Some(r) = t.child(bg, NS_P, "bgRef") {
                let idx = num(t.node(r).attr("idx")).unwrap_or(0.0) as usize;
                let ph = color::read_child(t, r, &self.colors, None);
                let list = if idx >= 1001 { self.theme.bg_styles.get(idx - 1001) } else { idx.checked_sub(1).and_then(|i| self.theme.fill_styles.get(i)) };
                if let Some(&f) = list {
                    let theme = self.theme.part.clone();
                    if theme.tree.node(f).local == "blipFill" {
                        if let Some(item) = self.blip_item(&theme, f, size, Affine::IDENTITY, None, None) {
                            self.out.scene.items.insert(0, item);
                        }
                        return;
                    }
                    match self.paint_from_fill(&theme, f, ph, size, None) {
                        Ok(p) => self.out.scene.background = p,
                        Err(e) => {
                            self.diag(None, "background", e);
                            self.out.scene.background = ph.map(Paint::Solid);
                        }
                    }
                }
                return;
            }
        }
    }
}

/// The context for drawing slide `index`, and its slide, layout and master.
fn slide_context<'a>(pres: &'a Presentation, index: usize, resources: &'a Resources) -> Result<(Ctx<'a>, Arc<Part>), Error> {
    let fonts = &resources.fonts;
    let pres_part = load_part(pres, pres.presentation_part())?;
    let slide = load_part(pres, pres.slide_part(index)?)?;
    let layout = related(pres, &slide, "/slideLayout")?;
    let master = related(pres, &layout, "/slideMaster")?;
    let theme_part = related(pres, &master, "/theme")?;
    let (theme, scheme) = read_theme(theme_part);
    let mut map = master.tree.child(master.tree.root, NS_P, "clrMap").map(|m| color::read_map(&master.tree, m)).unwrap_or_default();
    for part in [&layout, &slide] {
        if let Some(o) = part.tree.path(part.tree.root, &[(NS_P, "clrMapOvr"), (NS_A, "overrideClrMapping")]) {
            map = color::read_map(&part.tree, o);
        }
    }
    let size = pres_part
        .tree
        .child(pres_part.tree.root, NS_P, "sldSz")
        .and_then(|s| Some((num(pres_part.tree.node(s).attr("cx"))? / EMU_PER_PT, num(pres_part.tree.node(s).attr("cy"))? / EMU_PER_PT)))
        .unwrap_or((720.0, 540.0));
    let ctx = Ctx {
        pres,
        fonts,
        resources,
        theme,
        colors: ColorContext { scheme, map },
        pres_part,
        master,
        layout,
        slide_number: index,
        group_fills: Vec::new(),
        record_frames: false,
        out: RenderedSlide {
            scene: Scene { width: size.0, height: size.1, background: None, items: Vec::new() },
            frames: Vec::new(),
            texts: Vec::new(),
            diagnostics: Vec::new(),
            provisional: Vec::new(),
        },
    };
    Ok((ctx, slide))
}

/// Resolves slide `index` (1-based) into a drawing list.
pub fn render_slide(pres: &Presentation, index: usize, resources: &Resources) -> Result<RenderedSlide, Error> {
    let (mut ctx, slide) = slide_context(pres, index, resources)?;
    let (layout, master) = (ctx.layout.clone(), ctx.master.clone());
    let bounds = Rect::new(0.0, 0.0, ctx.out.scene.width, ctx.out.scene.height);
    ctx.background(&[slide.clone(), layout.clone(), master.clone()], bounds);
    let shows = |p: &Part| p.tree.node(p.tree.root).attr("showMasterSp") != Some("0");
    if shows(&slide) && shows(&layout) {
        if let Some(n) = sp_tree(&master) {
            ctx.walk(&master, n, Affine::IDENTITY, false);
        }
    }
    if shows(&slide) {
        if let Some(n) = sp_tree(&layout) {
            ctx.walk(&layout, n, Affine::IDENTITY, false);
        }
    }
    let master_texts = ctx.out.texts.len();
    if let Some(n) = sp_tree(&slide) {
        ctx.record_frames = true;
        ctx.walk(&slide, n, Affine::IDENTITY, true);
    }
    for t in &mut ctx.out.texts[master_texts..] {
        t.on_slide = true;
    }
    Ok(ctx.out)
}

/// A shape's text ready to lay out at different autofit settings.
pub struct TextMeasure {
    pub paragraphs: Vec<Paragraph>,
    pub body: BodyProps,
    pub width: f64,
    pub height: f64,
    pub theme: ThemeFonts,
}

/// How much `t` stretches the x and y axes.
fn axis_scales(t: Affine) -> (f64, f64) {
    let [a, b, c, d, _, _] = t.as_coeffs();
    (a.hypot(b).max(1e-9), c.hypot(d).max(1e-9))
}

/// The scale the groups around shape `id` (below `parent`) apply to it.
fn group_scale(tree: &Tree, parent: usize, id: u32) -> Option<(f64, f64)> {
    for &c in &tree.node(parent).children {
        if shape_id(tree, c) == Some(id) && tree.node(c).local != "grpSp" {
            return Some((1.0, 1.0));
        }
        if tree.node(c).local == "grpSp" {
            if let Some((ix, iy)) = group_scale(tree, c, id) {
                let x = tree.path(c, &[(NS_P, "grpSpPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(tree, x));
                let (gx, gy) = x.and_then(|x| x.child.map(|ch| (x.rect.width() / ch.width().max(1e-9), x.rect.height() / ch.height().max(1e-9)))).unwrap_or((1.0, 1.0));
                return Some((ix * gx, iy * gy));
            }
        }
    }
    None
}

fn find_shape(tree: &Tree, parent: usize, id: u32) -> Option<usize> {
    for &c in &tree.node(parent).children {
        if shape_id(tree, c) == Some(id) && tree.node(c).local != "grpSp" {
            return Some(c);
        }
        if tree.node(c).local == "grpSp" {
            if let Some(f) = find_shape(tree, c, id) {
                return Some(f);
            }
        }
    }
    None
}

/// The position PowerPoint uses for shape `shape_id` on slide `index`, in
/// its parent's coordinates: its own `a:xfrm`, or for a placeholder without
/// one, the layout's or master's.
pub(crate) fn effective_xfrm(pres: &Presentation, index: usize, shape_id: u32) -> Result<Option<Xfrm>, Error> {
    let resources = Resources::new(FontSet::empty());
    let (ctx, slide) = slide_context(pres, index, &resources)?;
    let Some(tree_node) = sp_tree(&slide) else { return Ok(None) };
    let Some(shape) = find_shape(&slide.tree, tree_node, shape_id) else { return Ok(None) };
    Ok(ctx.chain(&slide, shape).iter().find_map(|(p, s)| {
        let t = &p.tree;
        let xfrm = match t.node(*s).local.as_str() {
            "graphicFrame" => t.child(*s, p.ns, "xfrm"),
            _ => t.path(*s, &[(p.ns, "spPr"), (NS_A, "xfrm")]),
        };
        xfrm.and_then(|x| read_xfrm(t, x))
    }))
}

/// Inputs for laying out the text of shape `shape_id` on slide `index`, or
/// `None` when the shape has no text body.
pub fn measure_shape_text(pres: &Presentation, index: usize, shape_id: u32, resources: &Resources) -> Result<Option<TextMeasure>, Error> {
    let (mut ctx, slide) = slide_context(pres, index, resources)?;
    let Some(tree_node) = sp_tree(&slide) else { return Ok(None) };
    let Some(shape) = find_shape(&slide.tree, tree_node, shape_id) else { return Ok(None) };
    let Some(body) = slide.tree.child(shape, NS_P, "txBody") else { return Ok(None) };
    let chain = ctx.chain(&slide, shape);
    let Some(xfrm) = chain.iter().find_map(|(p, s)| p.tree.path(*s, &[(p.ns, "spPr"), (NS_A, "xfrm")]).and_then(|x| read_xfrm(&p.tree, x))) else { return Ok(None) };
    let (paragraphs, body_props) = ctx.text_inputs(&slide, &chain, shape, body);
    let (sx, sy) = group_scale(&slide.tree, tree_node, shape_id).unwrap_or((1.0, 1.0));
    let (width, height) = (xfrm.rect.width() * sx, xfrm.rect.height() * sy);
    let body = in_text_area(body_props, &chain, width, height);
    Ok(Some(TextMeasure { paragraphs, body, width, height, theme: ctx.theme.fonts.clone() }))
}

/// Vertical text (`bodyPr`/`tcPr` `vert`) is laid out in its `w`×`h` box
/// turned a quarter turn, insets turned along, and then turned back. Turns
/// `body`'s insets and returns the layout box's width and height, the turn
/// from the layout box to the box, and whether the text is vertical. (In
/// vertical East Asian text, eaVert, East Asian glyphs also stand upright.)
/// Points by which laid-out text exceeds the text area of a box `height` high
/// (in the text's own direction), measured as autofit measures it.
fn overflow_of(layout: &text::TextLayout, body: &BodyProps, height: f64) -> f64 {
    let room = height - body.insets[1] - body.insets[3];
    let over = layout.fit_height - room;
    // Under half a point is the rounding of stored sizes, not visible.
    if over >= 0.5 { (over * 100.0).round() / 100.0 } else { 0.0 }
}

fn turn_vertical(body: &mut BodyProps, w: f64, h: f64) -> (f64, f64, Affine, bool) {
    let clockwise = match body.vert.as_str() {
        "vert" | "eaVert" | "wordArtVert" | "mongolianVert" | "wordArtVertRtl" => true,
        "vert270" => false,
        _ => return (w, h, Affine::IDENTITY, false),
    };
    let [l, t, r, b] = body.insets;
    body.insets = if clockwise { [t, r, b, l] } else { [b, l, t, r] };
    let frame = if clockwise { Affine::new([0.0, 1.0, -1.0, 0.0, w, 0.0]) } else { Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, h]) };
    (h, w, frame, true)
}

/// Body properties whose insets also keep the text inside the shape
/// geometry's text rectangle (a rounded rectangle's text stays clear of its
/// corners), the geometry being the shape's own or inherited.
fn in_text_area(mut body: BodyProps, chain: &Chain, w: f64, h: f64) -> BodyProps {
    let geom = chain.iter().find_map(|(p, s)| {
        let sp = p.tree.child(*s, p.ns, "spPr")?;
        p.tree.child(sp, NS_A, "prstGeom").or_else(|| p.tree.child(sp, NS_A, "custGeom")).map(|g| (p, g))
    });
    if let Some(r) = geom.and_then(|(p, g)| geometry::text_rect(&p.tree, g, w, h)) {
        let [l, t, r_, b] = body.insets;
        body.insets = [l + r.x0, t + r.y0, r_ + (w - r.x1), b + (h - r.y1)];
    }
    body
}
