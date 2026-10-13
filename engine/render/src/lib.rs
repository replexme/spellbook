//! Format-independent drawing list and CPU rasterizer.
//!
//! A format adapter (PPTX, later publishing) resolves its document into a
//! [`Scene`]: positioned paths, images and glyph runs in points. The same
//! scene is rasterized for the browser canvas, server previews and the AI's
//! observation image, so all three see the same pixels.

use std::sync::Arc;

use designcraft_fonts::{FontDb, FontFace};
use kurbo::{Affine, BezPath, Rect, Shape};
use vello_cpu::peniko::{self, ColorStop, Extend, Gradient};
use vello_cpu::{Pixmap, RenderContext, Resources};

/// Straight (not premultiplied) sRGB colour with alpha.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const BLACK: Rgba = Rgba { r: 0, g: 0, b: 0, a: 255 };
    pub const WHITE: Rgba = Rgba { r: 255, g: 255, b: 255, a: 255 };

    fn color(self) -> peniko::Color {
        peniko::Color::from_rgba8(self.r, self.g, self.b, self.a)
    }
}

#[derive(Debug, Clone)]
pub enum Paint {
    Solid(Rgba),
    /// Linear gradient between two points in the item's coordinate space.
    Linear { start: (f64, f64), end: (f64, f64), stops: Vec<(f32, Rgba)> },
    /// Radial gradient: offset 0 at `center`, 1 at `radius`.
    Radial { center: (f64, f64), radius: f64, stops: Vec<(f32, Rgba)> },
}

#[derive(Debug, Clone)]
pub struct Stroke {
    pub paint: Paint,
    /// Line width in scene points. It does not scale with the item's
    /// transform: a resized group keeps its line widths, as in DrawingML.
    pub width: f64,
    /// Dash pattern in points, empty for solid.
    pub dashes: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct PlacedGlyph {
    pub gid: u32,
    /// Baseline origin in the item's coordinate space (points).
    pub x: f64,
    pub y: f64,
}

#[derive(Clone)]
pub struct GlyphRun {
    pub face: Arc<FontFace>,
    /// Font size in points.
    pub size: f64,
    pub color: Rgba,
    pub glyphs: Vec<PlacedGlyph>,
    /// Synthesized italic: horizontal shear (x += skew * height above the
    /// baseline); 0 for upright.
    pub skew: f64,
    /// Synthesized bold: outline stroke width in points; 0 for none.
    pub embolden: f64,
    /// Text outline drawn over the glyphs: width in points and colour.
    pub outline: Option<(f64, Rgba)>,
}

impl std::fmt::Debug for GlyphRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GlyphRun").field("size", &self.size).field("glyphs", &self.glyphs.len()).finish()
    }
}

#[derive(Debug, Clone)]
pub enum Item {
    Path { path: BezPath, transform: Affine, fill: Option<Paint>, stroke: Option<Stroke> },
    /// `image` stretched over `dest` after cropping to `crop` (in image pixels),
    /// optionally clipped to `clip`.
    Image { image: Arc<Pixmap>, crop: Rect, dest: Rect, transform: Affine, clip: Option<BezPath> },
    Glyphs { run: GlyphRun, transform: Affine },
    /// Items drawn through a Gaussian blur of standard deviation `sigma`
    /// (points), as for soft shadows.
    Blurred { sigma: f64, items: Vec<Item> },
    /// `items` drawn with the alpha of `mask` (drawn on its own, transparent
    /// canvas), as for soft edges and reflections.
    Masked { mask: Vec<Item>, items: Vec<Item> },
}

impl Item {
    /// The item with `t` applied before its own placement.
    pub fn transformed(&self, t: Affine) -> Item {
        match self {
            // Paints are in the item's own coordinates, so only the
            // placement changes.
            Item::Path { path, transform, fill, stroke } => Item::Path { path: path.clone(), transform: t * *transform, fill: fill.clone(), stroke: stroke.clone() },
            Item::Image { image, crop, dest, transform, clip } => Item::Image { image: image.clone(), crop: *crop, dest: *dest, transform: t * *transform, clip: clip.clone() },
            Item::Glyphs { run, transform } => Item::Glyphs { run: run.clone(), transform: t * *transform },
            Item::Blurred { sigma, items } => Item::Blurred { sigma: *sigma, items: items.iter().map(|i| i.transformed(t)).collect() },
            Item::Masked { mask, items } => Item::Masked { mask: mask.iter().map(|i| i.transformed(t)).collect(), items: items.iter().map(|i| i.transformed(t)).collect() },
        }
    }

}

/// One page or slide in points.
#[derive(Debug, Clone)]
pub struct Scene {
    pub width: f64,
    pub height: f64,
    pub background: Option<Paint>,
    pub items: Vec<Item>,
}

/// Rendered RGBA8 pixels (premultiplied), row-major.
pub struct Raster {
    pub width: u16,
    pub height: u16,
    pub pixels: Vec<u8>,
}

/// Draw without SIMD instructions (for a server whose CPU's SIMD support is not
/// trusted, such as x86 emulated on ARM, where the detected AVX2 path smears pages).
static SCALAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Makes every later rasterization in this process scalar (`true`) or detected (`false`).
pub fn set_scalar(scalar: bool) {
    SCALAR.store(scalar, std::sync::atomic::Ordering::Relaxed);
}

fn new_context(w: u16, h: u16) -> RenderContext {
    // One thread: vello_cpu's threaded dispatcher cannot draw filter layers (blurred shadows, glow,
    // soft edges) and panics on them. It is switched on whenever this crate is built with
    // designcraft-render (present-idml), whose vello_cpu dependency enables "multithreading".
    let mut settings = vello_cpu::RenderSettings { num_threads: 0, ..Default::default() };
    if SCALAR.load(std::sync::atomic::Ordering::Relaxed) {
        settings.level = vello_cpu::Level::baseline();
    }
    RenderContext::new_with(w, h, settings)
}

fn set_paint(ctx: &mut RenderContext, paint: &Paint) {
    match paint {
        Paint::Solid(c) => ctx.set_paint(c.color()),
        Paint::Linear { start, end, stops } => {
            let stops: Vec<ColorStop> = stops.iter().map(|(o, c)| ColorStop::from((*o, c.color()))).collect();
            let g = Gradient::new_linear(*start, *end).with_stops(stops.as_slice()).with_extend(Extend::Pad);
            ctx.set_paint(g);
        }
        Paint::Radial { center, radius, stops } => {
            let stops: Vec<ColorStop> = stops.iter().map(|(o, c)| ColorStop::from((*o, c.color()))).collect();
            let g = Gradient::new_radial(*center, *radius as f32).with_stops(stops.as_slice()).with_extend(Extend::Pad);
            ctx.set_paint(g);
        }
    }
}

/// A paint's geometry mapped by `t` (for strokes drawn in scene space).
fn map_paint(paint: &Paint, t: Affine) -> Paint {
    let m = |p: (f64, f64)| {
        let q = t * kurbo::Point::new(p.0, p.1);
        (q.x, q.y)
    };
    match paint {
        Paint::Solid(c) => Paint::Solid(*c),
        Paint::Linear { start, end, stops } => Paint::Linear { start: m(*start), end: m(*end), stops: stops.clone() },
        Paint::Radial { center, radius, stops } => {
            let s = t.as_coeffs();
            let scale = ((s[0] * s[3] - s[1] * s[2]).abs()).sqrt();
            Paint::Radial { center: m(*center), radius: radius * scale, stops: stops.clone() }
        }
    }
}

fn draw(ctx: &mut RenderContext, item: &Item, view: Affine, fonts: &FontDb) {
    match item {
        Item::Path { path, transform, fill, stroke } => {
            ctx.set_transform(view * *transform);
            if let Some(fill) = fill {
                set_paint(ctx, fill);
                ctx.fill_path(path);
            }
            if let Some(s) = stroke {
                if s.width > 0.0 {
                    // Stroke in scene space so the width is not scaled.
                    let scene_path = *transform * path.clone();
                    let mut ks = kurbo::Stroke::new(s.width);
                    if !s.dashes.is_empty() {
                        ks = ks.with_dashes(0.0, s.dashes.iter().copied());
                    }
                    ctx.set_transform(view);
                    ctx.set_stroke(ks);
                    set_paint(ctx, &map_paint(&s.paint, *transform));
                    ctx.stroke_path(&scene_path);
                }
            }
        }
        Item::Image { image, crop, dest, transform, clip } => {
            ctx.set_transform(view * *transform);
            if let Some(clip) = clip {
                ctx.push_clip_layer(clip);
            }
            let sx = dest.width() / crop.width().max(1e-9);
            let sy = dest.height() / crop.height().max(1e-9);
            ctx.set_paint(vello_cpu::Image {
                image: vello_cpu::ImageSource::Pixmap(image.clone()),
                sampler: peniko::ImageSampler::default().with_quality(peniko::ImageQuality::Medium),
            });
            ctx.set_paint_transform(Affine::translate((dest.x0, dest.y0)) * Affine::scale_non_uniform(sx, sy) * Affine::translate((-crop.x0, -crop.y0)));
            ctx.fill_rect(dest);
            ctx.reset_paint_transform();
            if clip.is_some() {
                ctx.pop_layer();
            }
        }
        Item::Blurred { sigma, items } => {
            let k = view.as_coeffs()[0].hypot(view.as_coeffs()[1]);
            let blur = vello_common::filter_effects::Filter::from_primitive(vello_common::filter_effects::FilterPrimitive::GaussianBlur {
                std_deviation: (*sigma * k) as f32,
                edge_mode: vello_common::filter_effects::EdgeMode::None,
            });
            ctx.push_filter_layer(blur);
            for i in items {
                draw(ctx, i, view, fonts);
            }
            ctx.pop_layer();
        }
        Item::Masked { mask, items } => {
            let (w, h) = (ctx.width(), ctx.height());
            let mut mctx = new_context(w, h);
            for i in mask {
                draw(&mut mctx, i, view, fonts);
            }
            mctx.flush();
            let mut pix = Pixmap::new(w, h);
            let mut res = Resources::new();
            mctx.render(&mut pix, &mut res);
            let m = vello_cpu::Mask::new_alpha(&pix);
            ctx.push_layer(None, None, None, Some(m), None);
            for i in items {
                draw(ctx, i, view, fonts);
            }
            ctx.pop_layer();
        }
        Item::Glyphs { run, transform } => {
            let k = run.size / run.face.units_per_em().max(1.0);
            // Outlines are y-down: a positive skew leans the tops right.
            let shear = Affine::new([1.0, 0.0, -run.skew, 1.0, 0.0, 0.0]);
            for g in &run.glyphs {
                // Colour emoji and other bitmap glyphs (sbix, CBDT) draw their
                // bitmap, even where the font also has a placeholder outline.
                if g.gid != 0 {
                    if let Some(bitmap) = bitmap_glyph(&run.face, g.gid, run.size * view.as_coeffs()[0].abs()) {
                        let (img, r) = &*bitmap;
                        let dest = Rect::new(g.x + r.x0 * run.size, g.y + r.y0 * run.size, g.x + r.x1 * run.size, g.y + r.y1 * run.size);
                        let item = Item::Image { image: img.clone(), crop: Rect::new(0.0, 0.0, img.width() as f64, img.height() as f64), dest, transform: *transform, clip: None };
                        draw(ctx, &item, view, fonts);
                        continue;
                    }
                }
                let outline = fonts.outline(&run.face, g.gid);
                if outline.elements().is_empty() {
                    continue;
                }
                let glyph = *transform * Affine::translate((g.x, g.y)) * shear * Affine::scale(k);
                if run.color.a > 0 {
                    ctx.set_paint(run.color.color());
                    ctx.set_transform(view * glyph);
                    ctx.fill_path(&outline);
                    if run.embolden > 0.0 {
                        ctx.set_transform(view);
                        ctx.set_stroke(kurbo::Stroke::new(run.embolden));
                        ctx.stroke_path(&(glyph * (*outline).clone()));
                    }
                }
                if let Some((width, color)) = run.outline {
                    ctx.set_transform(view);
                    ctx.set_paint(color.color());
                    ctx.set_stroke(kurbo::Stroke::new(width));
                    ctx.stroke_path(&(glyph * (*outline).clone()));
                }
            }
        }
    }
}

/// Rasterizes `scene` at `scale` pixels per point.
pub fn rasterize(scene: &Scene, fonts: &FontDb, scale: f64) -> Raster {
    let w = (scene.width * scale).round().clamp(1.0, u16::MAX as f64) as u16;
    let h = (scene.height * scale).round().clamp(1.0, u16::MAX as f64) as u16;
    let view = Affine::scale(scale);
    let mut ctx = new_context(w, h);
    ctx.set_paint(Rgba::WHITE.color());
    ctx.fill_rect(&Rect::new(0.0, 0.0, w as f64, h as f64));
    if let Some(bg) = &scene.background {
        ctx.set_transform(view);
        set_paint(&mut ctx, bg);
        ctx.fill_rect(&Rect::new(0.0, 0.0, scene.width, scene.height));
    }
    for item in &scene.items {
        draw(&mut ctx, item, view, fonts);
    }
    ctx.flush();
    let mut pixels = vec![0u8; w as usize * h as usize * 4];
    let mut res = Resources::new();
    if let Some(pm) = vello_cpu::PixmapMut::new(w, h, &mut pixels) {
        ctx.render(pm, &mut res);
    }
    Raster { width: w, height: h, pixels }
}

/// A bitmap glyph (colour emoji) decoded once: its image and its box
/// relative to the pen position on the baseline, in ems (y down).
type BitmapGlyph = Arc<(Arc<Pixmap>, Rect)>;

/// The bitmap of glyph `gid` from the strike closest to (and preferably
/// not below) `pixels` per em, if the face has bitmaps.
fn bitmap_glyph(face: &FontFace, gid: u32, pixels: f64) -> Option<BitmapGlyph> {
    use skrifa::bitmap::{BitmapData, BitmapStrikes, Origin};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<(String, u32, u32), Option<BitmapGlyph>>>> = OnceLock::new();
    let font = face.skrifa()?;
    let strikes = BitmapStrikes::new(&font);
    if strikes.is_empty() {
        return None;
    }
    let gid16 = skrifa::GlyphId::new(gid);
    let strike = strikes.iter().filter(|s| s.get(gid16).is_some()).min_by(|a, b| {
        let score = |p: f32| if (p as f64) >= pixels { p as f64 - pixels } else { 10_000.0 + pixels - p as f64 };
        score(a.ppem()).total_cmp(&score(b.ppem()))
    })?;
    let key = (format!("{}/{}", face.family, face.style), gid, strike.ppem() as u32);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return hit.clone();
    }
    let glyph = strike.get(gid16)?;
    let decoded = (|| -> Option<BitmapGlyph> {
        let (w, h, rgba) = match glyph.data {
            BitmapData::Png(bytes) => {
                let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
                dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
                let mut reader = dec.read_info().ok()?;
                let mut buf = vec![0; reader.output_buffer_size()?];
                let info = reader.next_frame(&mut buf).ok()?;
                let px = &buf[..info.buffer_size()];
                let rgba: Vec<u8> = match info.color_type {
                    png::ColorType::Rgba => px.to_vec(),
                    png::ColorType::Rgb => px.chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
                    png::ColorType::GrayscaleAlpha => px.chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
                    png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 255]).collect(),
                    _ => return None,
                };
                (info.width, info.height, rgba)
            }
            BitmapData::Bgra(bytes) => {
                // Premultiplied BGRA to straight RGBA.
                let rgba = bytes
                    .chunks(4)
                    .flat_map(|c| {
                        let a = c[3].max(1) as u32;
                        let un = |v: u8| ((v as u32 * 255 + a / 2) / a).min(255) as u8;
                        [un(c[2]), un(c[1]), un(c[0]), c[3]]
                    })
                    .collect();
                (glyph.width, glyph.height, rgba)
            }
            BitmapData::Mask(_) => return None,
        };
        let ppem = glyph.ppem_y.max(1.0) as f64;
        let upem = face.units_per_em().max(1.0);
        let (wem, hem) = (w as f64 / glyph.ppem_x.max(1.0) as f64, h as f64 / ppem);
        // Left edge and top edge in ems from the pen on the baseline.
        let (x0, top) = match glyph.placement_origin {
            Origin::BottomLeft => (glyph.bearing_x as f64 / upem + glyph.inner_bearing_x as f64 / ppem, -(glyph.bearing_y as f64 / upem + glyph.inner_bearing_y as f64 / ppem) - hem),
            Origin::TopLeft => (glyph.bearing_x as f64 / upem + glyph.inner_bearing_x as f64 / ppem, -(glyph.bearing_y as f64 / upem + glyph.inner_bearing_y as f64 / ppem)),
        };
        let pm = pixmap_from_rgba(u16::try_from(w).ok()?, u16::try_from(h).ok()?, &rgba);
        Some(Arc::new((Arc::new(pm), Rect::new(x0, top, x0 + wem, top + hem))))
    })();
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, decoded.clone());
    decoded
}

/// Draws `scene` on a transparent canvas (no background), as for a picture
/// made from a drawing.
pub fn rasterize_transparent(scene: &Scene, fonts: &FontDb, scale: f64) -> Pixmap {
    let w = (scene.width * scale).round().clamp(1.0, u16::MAX as f64) as u16;
    let h = (scene.height * scale).round().clamp(1.0, u16::MAX as f64) as u16;
    let view = Affine::scale(scale);
    let mut ctx = new_context(w, h);
    for item in &scene.items {
        draw(&mut ctx, item, view, fonts);
    }
    ctx.flush();
    let mut pix = Pixmap::new(w, h);
    let mut res = Resources::new();
    ctx.render(&mut pix, &mut res);
    pix
}

impl Raster {
    /// Encodes as PNG (RGB; the canvas is opaque).
    pub fn to_png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, self.width as u32, self.height as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let rgb: Vec<u8> = self.pixels.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            let mut w = enc.write_header().expect("in-memory PNG header");
            w.write_image_data(&rgb).expect("in-memory PNG data");
        }
        out
    }
}

/// Builds an image from straight RGBA8 pixels.
pub fn pixmap_from_rgba(width: u16, height: u16, rgba: &[u8]) -> Pixmap {
    let data = rgba
        .chunks_exact(4)
        .map(|p| {
            let a = p[3] as u16;
            let m = |c: u8| ((c as u16 * a + 127) / 255) as u8;
            vello_cpu::color::PremulRgba8 { r: m(p[0]), g: m(p[1]), b: m(p[2]), a: p[3] }
        })
        .collect();
    Pixmap::from_parts(data, width, height)
}

/// Axis-aligned rectangle as a path.
pub fn rect_path(r: Rect) -> BezPath {
    r.to_path(0.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stroke_width_ignores_item_scale() {
        let db = FontDb::with_font_dirs(Vec::new());
        // A tiny square scaled up 1000x with a 1 pt line: the line stays 1 pt.
        let scene = Scene {
            width: 100.0,
            height: 100.0,
            background: None,
            items: vec![Item::Path {
                path: rect_path(Rect::new(0.0, 0.0, 0.05, 0.05)),
                transform: Affine::translate((25.0, 25.0)) * Affine::scale(1000.0),
                fill: None,
                stroke: Some(Stroke { paint: Paint::Solid(Rgba::BLACK), width: 1.0, dashes: Vec::new() }),
            }],
        };
        let r = rasterize(&scene, &db, 1.0);
        let at = |x: usize, y: usize| r.pixels[(y * 100 + x) * 4];
        assert_eq!(at(50, 50), 255, "inside stays white");
        assert!(at(25, 50) < 128, "edge is drawn");
    }

    #[test]
    fn every_blurred_item_is_blurred() {
        let db = FontDb::with_font_dirs(Vec::new());
        let square = |x: f64| Item::Blurred {
            sigma: 2.0,
            items: vec![Item::Path { path: rect_path(Rect::new(x, 20.0, x + 20.0, 40.0)), transform: Affine::IDENTITY, fill: Some(Paint::Solid(Rgba::BLACK)), stroke: None }],
        };
        let scene = Scene { width: 100.0, height: 60.0, background: None, items: vec![square(10.0), square(60.0)] };
        let r = rasterize(&scene, &db, 1.0);
        let at = |x: usize, y: usize| r.pixels[(y * 100 + x) * 4];
        // Just outside each square the blur leaves grey, not white.
        for x in [8, 58] {
            assert!(at(x, 30) < 250 && at(x, 30) > 5, "square near x={x}: {}", at(x, 30));
        }
    }

    #[test]
    fn fills_a_rectangle() {
        let db = FontDb::with_font_dirs(Vec::new());
        let scene = Scene {
            width: 10.0,
            height: 10.0,
            background: None,
            items: vec![Item::Path {
                path: rect_path(Rect::new(0.0, 0.0, 5.0, 10.0)),
                transform: Affine::IDENTITY,
                fill: Some(Paint::Solid(Rgba { r: 255, g: 0, b: 0, a: 255 })),
                stroke: None,
            }],
        };
        let r = rasterize(&scene, &db, 1.0);
        assert_eq!(&r.pixels[0..4], &[255, 0, 0, 255]);
        let right = (9 * 4) as usize;
        assert_eq!(&r.pixels[right..right + 4], &[255, 255, 255, 255]);
        assert!(r.to_png().starts_with(b"\x89PNG"));
    }
}
