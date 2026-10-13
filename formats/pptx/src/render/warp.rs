//! WordArt warps (`a:prstTxWarp`): bending laid-out text along the paths of
//! a preset text warp, as measured against PowerPoint for Mac.
//!
//! - Two or more paths (`textPlain`, `textCurveUp`, `textWave1`, ...): the ink
//!   box of the whole text block is stretched between the first (top) and
//!   last (bottom) path, by fraction of each path's length; insets and font
//!   size do not limit it.
//! - One path (`textArchUp`, `textArchDown`, `textCircle`): the text keeps
//!   its size and runs along the path, upright on its outside, placed along
//!   it by the first paragraph's alignment. PowerPoint packs several lines
//!   closer together than their line pitch; that is not reproduced.

use kurbo::{BezPath, ParamCurve, PathEl, Point, Rect, Shape, Vec2};

/// Height above the baseline, per point of the line's size, that runs on a
/// single path (fitted to PowerPoint's arches within 7 px at 144 dpi).
const ON_PATH_RISE: f64 = 0.2;


/// A path flattened to a polyline, measured by length.
struct Track {
    points: Vec<Point>,
    /// Length from the start to each point.
    at: Vec<f64>,
}

impl Track {
    fn new(path: &BezPath) -> Self {
        let mut points: Vec<Point> = Vec::new();
        kurbo::flatten(path.iter(), 0.05, |el| match el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => {
                if points.last() != Some(&p) {
                    points.push(p);
                }
            }
            _ => {}
        });
        let mut at = vec![0.0];
        for w in points.windows(2) {
            at.push(at.last().unwrap() + (w[1] - w[0]).hypot());
        }
        Self { points, at }
    }

    fn length(&self) -> f64 {
        *self.at.last().unwrap_or(&0.0)
    }

    fn reversed(mut self) -> Self {
        self.points.reverse();
        let total = self.length();
        self.at = self.at.iter().rev().map(|a| total - a).collect();
        self
    }

    /// Point and unit direction at length `s`; beyond the ends the track
    /// continues straight.
    fn at(&self, s: f64) -> (Point, Vec2) {
        let n = self.points.len();
        if n < 2 {
            return (self.points.first().copied().unwrap_or(Point::ZERO), Vec2::new(1.0, 0.0));
        }
        let k = match self.at.binary_search_by(|a| a.total_cmp(&s)) {
            Ok(i) => i.min(n - 2),
            Err(i) => i.saturating_sub(1).min(n - 2),
        };
        let (a, b) = (self.points[k], self.points[k + 1]);
        let seg = self.at[k + 1] - self.at[k];
        let dir = if seg > 0.0 { (b - a) / seg } else { Vec2::new(1.0, 0.0) };
        (a + dir * (s - self.at[k]), dir)
    }
}

/// Up for text running along `dir`: a quarter turn to its left (y down).
fn up(dir: Vec2) -> Vec2 {
    Vec2::new(dir.y, -dir.x)
}

/// A warp ready to apply to the text of one box.
pub struct Warp(Kind);

enum Kind {
    Between { top: Track, bottom: Track },
    Along { track: Track, outside_up: bool, align: f64 },
}

impl Warp {
    /// The warp for `paths` (from `geometry::text_warp`) in a `w`×`h` box;
    /// `align` is 0 (left), 0.5 (centre) or 1 (right).
    pub fn new(paths: &[BezPath], w: f64, h: f64, align: f64) -> Option<Self> {
        let mut tracks: Vec<Track> = paths.iter().map(Track::new).filter(|t| t.length() > 0.0).collect();
        // Text reads left to right along every path.
        for t in tracks.iter_mut() {
            let (first, last) = (t.points[0], *t.points.last().unwrap());
            if last.x < first.x - 1e-6 {
                *t = std::mem::replace(t, Track { points: Vec::new(), at: Vec::new() }).reversed();
            }
        }
        match tracks.len() {
            0 => None,
            1 => {
                let mut track = tracks.pop().unwrap();
                // Upright at the middle of the path; the text sits on the
                // side away from the box centre.
                let (_, dir) = track.at(track.length() / 2.0);
                if up(dir).y > 1e-6 {
                    track = track.reversed();
                }
                let (mid, dir) = track.at(track.length() / 2.0);
                let outward = mid - Point::new(w / 2.0, h / 2.0);
                Some(Warp(Kind::Along { outside_up: up(dir).dot(outward) >= 0.0, track, align }))
            }
            _ => {
                let bottom = tracks.pop().unwrap();
                let top = tracks.swap_remove(0);
                let mean = |t: &Track| t.points.iter().map(|p| p.y).sum::<f64>() / t.points.len() as f64;
                Some(Warp(if mean(&top) <= mean(&bottom) { Kind::Between { top, bottom } } else { Kind::Between { top: bottom, bottom: top } }))
            }
        }
    }

    /// Where point `p` of text whose ink box is `ink` lands; `reference` is
    /// the height of the text that runs on a single path (see `reference`).
    fn map(&self, ink: Rect, reference: f64, p: Point) -> Point {
        match &self.0 {
            Kind::Between { top, bottom } => {
                let u = if ink.width() > 0.0 { (p.x - ink.x0) / ink.width() } else { 0.0 };
                let v = if ink.height() > 0.0 { (p.y - ink.y0) / ink.height() } else { 0.0 };
                let (t, _) = top.at(u * top.length());
                let (b, _) = bottom.at(u * bottom.length());
                t + (b - t) * v
            }
            Kind::Along { track, align, .. } => {
                let s = (track.length() - ink.width()) * align + (p.x - ink.x0);
                let (q, dir) = track.at(s);
                q + up(dir) * (reference - p.y)
            }
        }
    }

    /// The height of the text that runs on a single path, from the first
    /// and last lines (baseline, size): just above the last baseline when
    /// the text stands outside the path (`textArchUp`), above the first when
    /// it hangs outside it (`textArchDown`).
    pub fn reference(&self, first: (f64, f64), last: (f64, f64)) -> f64 {
        let (baseline, size) = match &self.0 {
            Kind::Along { outside_up: false, .. } => first,
            _ => last,
        };
        baseline - ON_PATH_RISE * size
    }

    /// `path` (in the text box) bent by the warp; `ink` is the ink box of
    /// all of the text. Straight edges are split first so that they bend.
    pub fn apply(&self, ink: Rect, reference: f64, path: &BezPath) -> BezPath {
        let mut out = BezPath::new();
        for el in subdivide(path, 0.5).elements() {
            match *el {
                PathEl::MoveTo(p) => out.move_to(self.map(ink, reference, p)),
                PathEl::LineTo(p) => out.line_to(self.map(ink, reference, p)),
                PathEl::ClosePath => out.close_path(),
                _ => {}
            }
        }
        out
    }
}

/// `path` flattened, with straight segments split into pieces no longer
/// than `step`.
fn subdivide(path: &BezPath, step: f64) -> BezPath {
    let mut out = BezPath::new();
    let mut current = Point::ZERO;
    let mut start = Point::ZERO;
    kurbo::flatten(path.iter(), 0.02, |el| match el {
        PathEl::MoveTo(p) => {
            out.move_to(p);
            (current, start) = (p, p);
        }
        PathEl::LineTo(p) => {
            let line = kurbo::Line::new(current, p);
            let n = (line.length() / step).ceil().max(1.0) as usize;
            for i in 1..=n {
                out.line_to(line.eval(i as f64 / n as f64));
            }
            current = p;
        }
        PathEl::ClosePath => {
            let line = kurbo::Line::new(current, start);
            let n = (line.length() / step).ceil().max(1.0) as usize;
            for i in 1..n {
                out.line_to(line.eval(i as f64 / n as f64));
            }
            out.close_path();
            current = start;
        }
        _ => {}
    });
    out
}

/// The union of the bounding boxes of `paths`.
pub fn ink_box<'a>(paths: impl IntoIterator<Item = &'a BezPath>) -> Option<Rect> {
    paths.into_iter().filter(|p| !p.elements().is_empty()).map(|p| p.bounding_box()).reduce(|a, b| a.union(b))
}
