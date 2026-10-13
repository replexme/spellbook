//! Enhanced metafiles (EMF): the GDI records are played into drawing items
//! in the picture's frame (points). EMF+ records (in GDI comments) are
//! skipped; PowerPoint writes dual files whose GDI records draw the same.
//!
//! Covered: mapping (window/viewport, map modes, world transforms), save
//! and restore, pens, brushes and fonts (with stock objects), lines,
//! polygons, polylines and Béziers (16 and 32 bit), rectangles, rounded
//! rectangles, ellipses, arcs, chords and pies, paths, pattern fills
//! (`BITBLT` without a source), device-independent bitmaps and text.
//! Clipping and raster operations other than copy are not applied.

use std::collections::HashMap;
use std::f64::consts::PI;

use kurbo::{Affine, BezPath, Point, Rect, Shape};
use present_render::{Item, Paint, Rgba, Stroke};

/// Text to lay out: the string, font, size (points), colour, and where its
/// reference point sits with the alignment flags (`TA_*`).
pub(super) struct TextOp {
    pub text: String,
    pub face: String,
    pub size: f64,
    pub bold: bool,
    pub italic: bool,
    pub color: Rgba,
    pub at: Point,
    pub align: u32,
    pub angle: f64,
}

pub(super) enum Op {
    Item(Item),
    Text(TextOp),
}

/// The played file: its frame size in points and what to draw.
pub(super) struct Played {
    pub width: f64,
    pub height: f64,
    pub ops: Vec<Op>,
}

#[derive(Clone)]
enum Obj {
    Pen { color: Rgba, width: f64, null: bool },
    Brush { color: Rgba, null: bool },
    Font { height: f64, bold: bool, italic: bool, face: String, angle: f64 },
}

#[derive(Clone)]
struct Dc {
    world: Affine,
    map_mode: u32,
    win_org: (f64, f64),
    win_ext: (f64, f64),
    vp_org: (f64, f64),
    vp_ext: (f64, f64),
    pen: Obj,
    brush: Obj,
    font: Obj,
    text_color: Rgba,
    text_align: u32,
    winding: bool,
    pos: Point,
}

fn rgb(c: u32) -> Rgba {
    Rgba { r: (c & 0xFF) as u8, g: ((c >> 8) & 0xFF) as u8, b: ((c >> 16) & 0xFF) as u8, a: 255 }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn u32(&self, at: usize) -> u32 {
        self.0.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0)
    }
    fn i32(&self, at: usize) -> i32 {
        self.u32(at) as i32
    }
    fn i16(&self, at: usize) -> i16 {
        self.0.get(at..at + 2).map(|b| i16::from_le_bytes([b[0], b[1]])).unwrap_or(0)
    }
    fn f32(&self, at: usize) -> f32 {
        f32::from_bits(self.u32(at))
    }
}

fn stock(index: u32) -> Option<Obj> {
    let gray = |v: u8| Rgba { r: v, g: v, b: v, a: 255 };
    Some(match index {
        0 => Obj::Brush { color: gray(255), null: false },
        1 => Obj::Brush { color: gray(192), null: false },
        2 => Obj::Brush { color: gray(128), null: false },
        3 => Obj::Brush { color: gray(64), null: false },
        4 => Obj::Brush { color: gray(0), null: false },
        5 => Obj::Brush { color: gray(0), null: true },
        6 => Obj::Pen { color: gray(255), width: 0.0, null: false },
        7 => Obj::Pen { color: gray(0), width: 0.0, null: false },
        8 => Obj::Pen { color: gray(0), width: 0.0, null: true },
        10..=17 => Obj::Font { height: 12.0, bold: false, italic: false, face: "Arial".into(), angle: 0.0 },
        _ => return None,
    })
}

/// Device-independent bitmap (BITMAPINFO at `bmi`, pixels at `bits`) as an
/// RGBA image, top row first.
fn dib(data: &[u8], bmi: usize, cb_bmi: usize, bits: usize, cb_bits: usize) -> Option<(u32, u32, Vec<u8>)> {
    let r = Reader(data);
    let header = r.u32(bmi) as usize;
    let w = r.i32(bmi + 4);
    let h = r.i32(bmi + 8);
    let bpp = r.0.get(bmi + 14..bmi + 16).map(|b| u16::from_le_bytes([b[0], b[1]]))? as u32;
    let compression = r.u32(bmi + 16);
    let pixels = data.get(bits..bits + cb_bits)?;
    if compression == 4 || compression == 5 {
        // JPEG or PNG inside.
        let img = image::load_from_memory(pixels).ok()?.to_rgba8();
        return Some((img.width(), img.height(), img.into_raw()));
    }
    if w <= 0 || h == 0 || !matches!(compression, 0 | 3) {
        return None;
    }
    let (w, top_down) = (w as u32, h < 0);
    let h = h.unsigned_abs();
    let colors = if bpp <= 8 { (cb_bmi.saturating_sub(header)) / 4 } else { 0 };
    let palette: Vec<[u8; 3]> = (0..colors).map(|i| {
        let o = bmi + header + i * 4;
        [data.get(o + 2).copied().unwrap_or(0), data.get(o + 1).copied().unwrap_or(0), data.get(o).copied().unwrap_or(0)]
    }).collect();
    let stride = ((w * bpp).div_ceil(32) * 4) as usize;
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let row = if top_down { y } else { h - 1 - y } as usize;
        let line = pixels.get(row * stride..row * stride + stride)?;
        for x in 0..w as usize {
            let (r, g, b, a) = match bpp {
                32 => (line[x * 4 + 2], line[x * 4 + 1], line[x * 4], 255),
                24 => (line[x * 3 + 2], line[x * 3 + 1], line[x * 3], 255),
                8 | 4 | 1 => {
                    let idx = match bpp {
                        8 => line[x] as usize,
                        4 => ((line[x / 2] >> if x % 2 == 0 { 4 } else { 0 }) & 0xF) as usize,
                        _ => ((line[x / 8] >> (7 - x % 8)) & 1) as usize,
                    };
                    let c = palette.get(idx).copied().unwrap_or([0, 0, 0]);
                    (c[0], c[1], c[2], 255)
                }
                _ => return None,
            };
            let o = (y * w + x as u32) as usize * 4;
            out[o..o + 4].copy_from_slice(&[r, g, b, a]);
        }
    }
    Some((w, h, out))
}

/// Plays EMF `data`; `None` if it is not an EMF.
pub(super) fn play_emf(data: &[u8]) -> Option<Played> {
    let r = Reader(data);
    if r.u32(0) != 1 || r.u32(40) != 0x464D_4520 {
        return None;
    }
    // Frame in 0.01 mm; reference device in pixels and millimetres.
    let frame = Rect::new(r.i32(24) as f64, r.i32(28) as f64, r.i32(32) as f64, r.i32(36) as f64);
    let (dev_px, dev_mm) = ((r.i32(72) as f64, r.i32(76) as f64), (r.i32(80) as f64, r.i32(84) as f64));
    let mm_per_px = (dev_mm.0 / dev_px.0.max(1.0), dev_mm.1 / dev_px.1.max(1.0));
    let pt = 72.0 / 25.4;
    let width = (frame.width() / 100.0 * pt).max(1.0);
    let height = (frame.height() / 100.0 * pt).max(1.0);
    // Device pixels to points in the frame.
    let to_frame = Affine::translate((-frame.x0 / 100.0 * pt, -frame.y0 / 100.0 * pt)) * Affine::scale_non_uniform(mm_per_px.0 * pt, mm_per_px.1 * pt);
    let mut dc = Dc {
        world: Affine::IDENTITY,
        map_mode: 1,
        win_org: (0.0, 0.0),
        win_ext: (1.0, 1.0),
        vp_org: (0.0, 0.0),
        vp_ext: (1.0, 1.0),
        pen: stock(7).unwrap(),
        brush: stock(0).unwrap(),
        font: stock(13).unwrap(),
        text_color: Rgba::BLACK,
        text_align: 0,
        winding: false,
        pos: Point::ZERO,
    };
    let mut saved: Vec<Dc> = Vec::new();
    let mut objects: HashMap<u32, Obj> = HashMap::new();
    let mut ops = Vec::new();
    let mut path: Option<BezPath> = None;
    let mut at = 0usize;
    // Logical units to frame points.
    fn page(dc: &Dc) -> Affine {
        let unit_mm = match dc.map_mode {
            2 => Some(0.1),
            3 => Some(0.01),
            4 => Some(0.254),
            5 => Some(0.0254),
            6 => Some(25.4 / 1440.0),
            _ => None,
        };
        match dc.map_mode {
            7 | 8 => {
                let nz = |v: f64| if v == 0.0 { 1.0 } else { v };
                let (mut sx, mut sy) = (dc.vp_ext.0 / nz(dc.win_ext.0), dc.vp_ext.1 / nz(dc.win_ext.1));
                if dc.map_mode == 7 {
                    let s = sx.abs().min(sy.abs());
                    sx = s * sx.signum();
                    sy = s * sy.signum();
                }
                Affine::translate(dc.vp_org) * Affine::scale_non_uniform(sx, sy) * Affine::translate((-dc.win_org.0, -dc.win_org.1))
            }
            _ => match unit_mm {
                // Fixed units: y up; scaled to device pixels at the end.
                Some(u) => Affine::translate(dc.vp_org) * Affine::scale_non_uniform(u, -u) * Affine::translate((-dc.win_org.0, -dc.win_org.1)),
                None => Affine::translate(dc.vp_org) * Affine::translate((-dc.win_org.0, -dc.win_org.1)),
            },
        }
    }
    let fixed_units = |dc: &Dc| matches!(dc.map_mode, 2..=6);
    while at + 8 <= data.len() {
        let (ty, size) = (r.u32(at), r.u32(at + 4) as usize);
        if size < 8 || at + size > data.len() {
            break;
        }
        let d = at + 8;
        // Logical point to frame points.
        let mm_fix = if fixed_units(&dc) { Affine::scale_non_uniform(1.0 / mm_per_px.0, 1.0 / mm_per_px.1) } else { Affine::IDENTITY };
        let t = to_frame * mm_fix * page(&dc) * dc.world;
        let pen = |dc: &Dc, t: &Affine| -> Option<Stroke> {
            match &dc.pen {
                Obj::Pen { color, width, null: false } => {
                    let scale = (t.as_coeffs()[0].hypot(t.as_coeffs()[1])).max(1e-9);
                    Some(Stroke { paint: Paint::Solid(*color), width: (width * scale).max(0.5), dashes: Vec::new() })
                }
                _ => None,
            }
        };
        let brush = |dc: &Dc| -> Option<Paint> {
            match &dc.brush {
                Obj::Brush { color, null: false } => Some(Paint::Solid(*color)),
                _ => None,
            }
        };
        // Draws (or adds to the open path) `shape` in logical units.
        let emit = |shape: BezPath, fill: bool, stroke: bool, dc: &Dc, ops: &mut Vec<Op>, path: &mut Option<BezPath>| {
            if let Some(p) = path.as_mut() {
                // A segment from the current point continues the figure.
                let end = p.elements().last().and_then(|e| e.end_point());
                let mut els = shape.elements().iter().copied().peekable();
                if let (Some(kurbo::PathEl::MoveTo(m)), Some(e)) = (els.peek().copied(), end) {
                    if (m - e).hypot() < 1e-6 {
                        els.next();
                    }
                }
                p.extend(els);
                return;
            }
            let fill = if fill { brush(dc) } else { None };
            let stroke = if stroke { pen(dc, &t) } else { None };
            if fill.is_some() || stroke.is_some() {
                ops.push(Op::Item(Item::Path { path: t * shape, transform: Affine::IDENTITY, fill, stroke }));
            }
        };
        let points16 = |off: usize, n: usize| -> Vec<Point> { (0..n).map(|i| Point::new(r.i16(off + i * 4) as f64, r.i16(off + i * 4 + 2) as f64)).collect() };
        let points32 = |off: usize, n: usize| -> Vec<Point> { (0..n).map(|i| Point::new(r.i32(off + i * 8) as f64, r.i32(off + i * 8 + 4) as f64)).collect() };
        let rect_at = |off: usize| Rect::new(r.i32(off) as f64, r.i32(off + 4) as f64, r.i32(off + 8) as f64, r.i32(off + 12) as f64);
        match ty {
            9 => dc.win_ext = (r.i32(d) as f64, r.i32(d + 4) as f64),
            10 => dc.win_org = (r.i32(d) as f64, r.i32(d + 4) as f64),
            11 => dc.vp_ext = (r.i32(d) as f64, r.i32(d + 4) as f64),
            12 => dc.vp_org = (r.i32(d) as f64, r.i32(d + 4) as f64),
            17 => dc.map_mode = r.u32(d),
            19 => dc.winding = r.u32(d) == 2,
            22 => dc.text_align = r.u32(d),
            24 => dc.text_color = rgb(r.u32(d)),
            27 => dc.pos = Point::new(r.i32(d) as f64, r.i32(d + 4) as f64),
            33 => saved.push(dc.clone()),
            34 => {
                let n = r.i32(d);
                let k = if n < 0 { (-n) as usize } else { saved.len().saturating_sub(n as usize) };
                for _ in 1..k.max(1) {
                    saved.pop();
                }
                if let Some(s) = saved.pop() {
                    dc = s;
                }
            }
            35 | 36 => {
                let x = Affine::new([r.f32(d) as f64, r.f32(d + 4) as f64, r.f32(d + 8) as f64, r.f32(d + 12) as f64, r.f32(d + 16) as f64, r.f32(d + 20) as f64]);
                dc.world = if ty == 35 {
                    x
                } else {
                    match r.u32(d + 24) {
                        1 => Affine::IDENTITY,
                        2 => dc.world * x,
                        3 => x * dc.world,
                        _ => x,
                    }
                };
            }
            37 => {
                let h = r.u32(d);
                let obj = if h & 0x8000_0000 != 0 { stock(h & 0x7FFF_FFFF) } else { objects.get(&h).cloned() };
                match obj {
                    Some(o @ Obj::Pen { .. }) => dc.pen = o,
                    Some(o @ Obj::Brush { .. }) => dc.brush = o,
                    Some(o @ Obj::Font { .. }) => dc.font = o,
                    None => {}
                }
            }
            38 => {
                let style = r.u32(d + 4);
                objects.insert(r.u32(d), Obj::Pen { color: rgb(r.u32(d + 16)), width: r.i32(d + 8) as f64, null: style & 0xF == 5 });
            }
            95 => {
                let style = r.u32(d + 20);
                objects.insert(r.u32(d), Obj::Pen { color: rgb(r.u32(d + 32)), width: r.u32(d + 24) as f64, null: style & 0xF == 5 || r.u32(d + 28) == 1 });
            }
            39 => {
                objects.insert(r.u32(d), Obj::Brush { color: rgb(r.u32(d + 8)), null: r.u32(d + 4) == 1 });
            }
            93 | 94 => {
                // Pattern brushes: drawn as their average, mid grey.
                objects.insert(r.u32(d), Obj::Brush { color: Rgba { r: 128, g: 128, b: 128, a: 255 }, null: false });
            }
            82 => {
                let face: String = String::from_utf16_lossy(&(0..32).map(|i| u16::from_le_bytes([data.get(d + 32 + i * 2).copied().unwrap_or(0), data.get(d + 33 + i * 2).copied().unwrap_or(0)])).take_while(|&c| c != 0).collect::<Vec<_>>());
                objects.insert(r.u32(d), Obj::Font { height: (r.i32(d + 4) as f64).abs(), bold: r.i32(d + 20) >= 600, italic: data.get(d + 24).copied().unwrap_or(0) != 0, face, angle: r.i32(d + 12) as f64 / 10.0 });
            }
            40 => {
                objects.remove(&r.u32(d));
            }
            42 | 43 | 44 => {
                let rc = rect_at(d);
                let shape = match ty {
                    42 => kurbo::Ellipse::from_rect(rc).to_path(0.1),
                    44 => kurbo::RoundedRect::from_rect(rc, (r.i32(d + 16) as f64 / 2.0).abs()).to_path(0.1),
                    _ => rc.to_path(0.1),
                };
                emit(shape, true, true, &dc, &mut ops, &mut path);
            }
            45..=47 | 55 => {
                // Arc, chord, pie (and arc-to) from the box and two radials.
                let rc = rect_at(d);
                let (s, e) = (Point::new(r.i32(d + 16) as f64, r.i32(d + 20) as f64), Point::new(r.i32(d + 24) as f64, r.i32(d + 28) as f64));
                let c = rc.center();
                let (rx, ry) = (rc.width() / 2.0, rc.height() / 2.0);
                let ang = |p: Point| ((p.y - c.y) / ry.max(1e-9)).atan2((p.x - c.x) / rx.max(1e-9));
                let (a0, mut a1) = (ang(s), ang(e));
                // Counter-clockwise on screen: decreasing angle in y-down.
                while a1 >= a0 {
                    a1 -= 2.0 * PI;
                }
                let arc = kurbo::Arc::new(c, (rx, ry), a0, a1 - a0, 0.0);
                let mut p = BezPath::new();
                let start = Point::new(c.x + rx * a0.cos(), c.y + ry * a0.sin());
                if ty == 55 {
                    p.move_to(dc.pos);
                    p.line_to(start);
                } else if ty == 47 {
                    p.move_to(c);
                    p.line_to(start);
                } else {
                    p.move_to(start);
                }
                p.extend(arc.append_iter(0.1));
                if ty != 45 && ty != 55 {
                    p.close_path();
                }
                dc.pos = Point::new(c.x + rx * a1.cos(), c.y + ry * a1.sin());
                emit(p, ty == 46 || ty == 47, true, &dc, &mut ops, &mut path);
            }
            54 => {
                let to = Point::new(r.i32(d) as f64, r.i32(d + 4) as f64);
                let mut p = BezPath::new();
                p.move_to(dc.pos);
                p.line_to(to);
                dc.pos = to;
                emit(p, false, true, &dc, &mut ops, &mut path);
            }
            2..=6 | 85..=89 => {
                // Polybezier, polygon, polyline, -to variants; 16 or 32 bit.
                let n = r.u32(d + 16) as usize;
                let pts = if ty >= 85 { points16(d + 20, n) } else { points32(d + 20, n) };
                let kind = if ty >= 85 { ty - 83 } else { ty };
                let mut p = BezPath::new();
                let to = matches!(kind, 5 | 6);
                let mut it = pts.iter().copied();
                if to {
                    p.move_to(dc.pos);
                } else if let Some(first) = it.next() {
                    p.move_to(first);
                }
                let rest: Vec<Point> = it.collect();
                match kind {
                    2 | 5 => {
                        for c in rest.chunks(3) {
                            if let [a, b, e] = c {
                                p.curve_to(*a, *b, *e);
                            }
                        }
                    }
                    _ => {
                        for q in &rest {
                            p.line_to(*q);
                        }
                    }
                }
                if kind == 3 {
                    p.close_path();
                }
                if let Some(last) = pts.last() {
                    if to {
                        dc.pos = *last;
                    }
                }
                emit(p, kind == 3, true, &dc, &mut ops, &mut path);
            }
            7 | 8 | 90 | 91 => {
                // Poly-polyline / poly-polygon.
                let polys = r.u32(d + 16) as usize;
                let total = r.u32(d + 20) as usize;
                let counts: Vec<usize> = (0..polys).map(|i| r.u32(d + 24 + i * 4) as usize).collect();
                let off = d + 24 + polys * 4;
                let pts = if ty >= 90 { points16(off, total) } else { points32(off, total) };
                let polygon = ty == 8 || ty == 91;
                let mut p = BezPath::new();
                let mut k = 0;
                for c in counts {
                    for (i, q) in pts.iter().skip(k).take(c).enumerate() {
                        if i == 0 {
                            p.move_to(*q);
                        } else {
                            p.line_to(*q);
                        }
                    }
                    if polygon {
                        p.close_path();
                    }
                    k += c;
                }
                emit(p, polygon, true, &dc, &mut ops, &mut path);
            }
            59 => path = Some(BezPath::new()),
            60 => {}
            61 => {
                if let Some(p) = path.as_mut() {
                    p.close_path();
                }
            }
            62..=64 => {
                if let Some(p) = path.take() {
                    let fill = if ty != 64 { brush(&dc) } else { None };
                    let stroke = if ty != 62 { pen(&dc, &t) } else { None };
                    ops.push(Op::Item(Item::Path { path: t * p, transform: Affine::IDENTITY, fill, stroke }));
                }
            }
            68 => path = None,
            76 | 77 => {
                // Block transfers: with no source bitmap, a fill with the
                // brush; with one, the bitmap.
                let (x, y, w, h) = (r.i32(d + 16) as f64, r.i32(d + 20) as f64, r.i32(d + 24) as f64, r.i32(d + 28) as f64);
                let (cb_bmi, cb_bits) = (r.u32(d + 80) as usize, r.u32(d + 88) as usize);
                let dest = Rect::new(x, y, x + w, y + h);
                // Only operations that paint: pattern copy, source copy,
                // white and black; others (e.g. 0x00AA0029, leave as is)
                // are skipped.
                let rop = r.u32(d + 32);
                let paints = matches!(rop, 0x00F0_0021 | 0x00CC_0020 | 0x00FF_0062 | 0x0000_0042);
                if !paints {
                } else if rop == 0x00FF_0062 || rop == 0x0000_0042 {
                    let c = if rop == 0x00FF_0062 { Rgba::WHITE } else { Rgba::BLACK };
                    ops.push(Op::Item(Item::Path { path: t * dest.to_path(0.1), transform: Affine::IDENTITY, fill: Some(Paint::Solid(c)), stroke: None }));
                } else if cb_bmi == 0 {
                    if let Some(f) = brush(&dc) {
                        ops.push(Op::Item(Item::Path { path: t * dest.to_path(0.1), transform: Affine::IDENTITY, fill: Some(f), stroke: None }));
                    }
                } else if let Some(img) = dib(data, at + r.u32(d + 76) as usize, cb_bmi, at + r.u32(d + 84) as usize, cb_bits) {
                    ops.push(image_op(img, dest, t));
                }
            }
            81 => {
                let (x, y) = (r.i32(d + 16) as f64, r.i32(d + 20) as f64);
                let (cw, ch) = (r.i32(d + 64) as f64, r.i32(d + 68) as f64);
                if let Some(img) = dib(data, at + r.u32(d + 40) as usize, r.u32(d + 44) as usize, at + r.u32(d + 48) as usize, r.u32(d + 52) as usize) {
                    ops.push(image_op(img, Rect::new(x, y, x + cw, y + ch), t));
                }
            }
            83 | 84 => {
                // ExtTextOut: reference point, then the string.
                let emr = d + 28;
                let (rx, ry) = (r.i32(emr) as f64, r.i32(emr + 4) as f64);
                let n = r.u32(emr + 8) as usize;
                let off = at + r.u32(emr + 12) as usize;
                let text = if ty == 84 {
                    String::from_utf16_lossy(&(0..n).map(|i| u16::from_le_bytes([data.get(off + i * 2).copied().unwrap_or(0), data.get(off + i * 2 + 1).copied().unwrap_or(0)])).collect::<Vec<_>>())
                } else {
                    data.get(off..off + n).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
                };
                if let Obj::Font { height, bold, italic, face, angle } = &dc.font {
                    let anchor = t * Point::new(rx, ry);
                    let ys = t.as_coeffs()[2].hypot(t.as_coeffs()[3]);
                    if !text.trim().is_empty() {
                        ops.push(Op::Text(TextOp { text, face: face.clone(), size: (height * ys).max(1.0), bold: *bold, italic: *italic, color: dc.text_color, at: anchor, align: dc.text_align, angle: *angle }));
                    }
                }
            }
            14 => break,
            _ => {}
        }
        at += size;
    }
    Some(Played { width, height, ops })
}

fn image_op((w, h, rgba): (u32, u32, Vec<u8>), dest: Rect, t: Affine) -> Op {
    let pm = present_render::pixmap_from_rgba(w.min(u16::MAX as u32) as u16, h.min(u16::MAX as u32) as u16, &rgba);
    // Destination corners in frame points (an axis-aligned box).
    let d = t.transform_rect_bbox(dest);
    Op::Item(Item::Image { image: std::sync::Arc::new(pm), crop: Rect::new(0.0, 0.0, w as f64, h as f64), dest: d, transform: Affine::IDENTITY, clip: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ty: u32, body: &[u8]) -> Vec<u8> {
        let mut v = ty.to_le_bytes().to_vec();
        v.extend(((body.len() + 8) as u32).to_le_bytes());
        v.extend(body);
        v
    }

    fn le(vals: &[i32]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// A 100 x 100 px device of 100 x 100 mm; frame 0..100 mm.
    fn emf(records: &[Vec<u8>]) -> Vec<u8> {
        let mut header = le(&[0, 0, 100, 100, 0, 0, 10_000, 10_000]);
        header.extend(0x464D_4520u32.to_le_bytes());
        header.extend(le(&[0x10000, 0, 0, 0, 0, 0, 0, 100, 100, 100, 100]));
        let mut out = rec(1, &header);
        for r in records {
            out.extend(r);
        }
        out.extend(rec(14, &le(&[0, 16, 20])));
        out
    }

    #[test]
    fn polygons_take_the_selected_brush_and_no_op_blits_paint_nothing() {
        let data = emf(&[
            rec(39, &le(&[1, 0, 0x00FF_0000, 0])),
            rec(37, &le(&[1])),
            rec(37, &le(&[0x8000_0008u32 as i32])),
            // Triangle (0,0) (100,0) (0,100) as 16-bit points.
            rec(86, &[le(&[0, 0, 100, 100, 3]), [0i16, 0, 100, 0, 0, 100].iter().flat_map(|v| v.to_le_bytes()).collect()].concat()),
            // A 0x00AA0029 ("leave as is") block transfer over everything.
            rec(76, &[le(&[0, 0, 100, 100, 0, 0, 100, 100, 0x00AA_0029]), vec![0; 64]].concat()),
        ]);
        let p = play_emf(&data).expect("an EMF");
        assert!((p.width - 100.0 / 25.4 * 72.0).abs() < 0.01, "100 mm wide");
        assert_eq!(p.ops.len(), 1);
        let Op::Item(Item::Path { path, fill: Some(Paint::Solid(c)), stroke: None, .. }) = &p.ops[0] else { panic!("a filled path") };
        assert_eq!((c.r, c.g, c.b), (0, 0, 255), "COLORREF is 0x00BBGGRR");
        let b = path.bounding_box();
        assert!((b.x1 - p.width).abs() < 0.01 && (b.y1 - p.height).abs() < 0.01, "{b:?}");
        assert!(play_emf(b"not an emf").is_none());
    }
}
