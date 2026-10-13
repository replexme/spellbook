//! Charts (`c:chartSpace`), drawn from the values cached in the chart part
//! with PowerPoint's automatic layout: column and bar (clustered, stacked,
//! 100% stacked; 3D columns drawn flat), line and pie.
//!
//! What a chart leaves unspecified follows Office's classic chart style
//! (`c:style` 2): series in the theme's accent colours, grey (#868686)
//! axis lines and gridlines, 10 pt text in the theme's body font. Layout
//! constants were measured against PowerPoint for Mac
//! (`conformance/results/2026-10-11-charts.md`) and are provisional.

use kurbo::{Affine, BezPath, Point, Rect, Shape};
use present_render::{Item, Paint, Rgba, Stroke};

use super::color;
use super::text::{self, BodyProps, Paragraph, ParaProps, RunProps, TextRun};
use super::{load_part_ns, num, read_xfrm, Ctx, Part};
use crate::xml::{Tree, NS_A, NS_R};
use std::sync::Arc;

pub(super) const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";

/// Classic chart style grey for axes and gridlines.
const GRID_GREY: Rgba = Rgba { r: 0x86, g: 0x86, b: 0x86, a: 255 };
/// Gap between the chart's edge and its contents, points.
const EDGE: f64 = 7.0;
/// Length of tick marks outside an axis, points.
const TICK: f64 = 5.0;

#[derive(Clone)]
struct Font {
    size: f64,
    bold: bool,
    color: Rgba,
    latin: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Grouping {
    Clustered,
    Stacked,
    Percent,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Bar { horizontal: bool },
    Line,
    Pie,
}

struct Labels {
    value: bool,
    percent: bool,
    category: bool,
    position: Option<String>,
    font: Font,
    format: Option<String>,
}

struct Series {
    name: String,
    categories: Vec<String>,
    values: Vec<Option<f64>>,
    format: String,
    fill: Option<Paint>,
    /// The fill is the series' own (`c:spPr`), which beats varied colours.
    own_fill: bool,
    line: Option<Stroke>,
    /// Point colours (pie slices, `c:dPt`), by index.
    points: Vec<(usize, Option<Paint>)>,
    labels: Option<Labels>,
}

struct Axis {
    deleted: bool,
    /// Drawn without labels (`tickLblPos` none).
    no_labels: bool,
    gridlines: Option<Stroke>,
    line: Option<Stroke>,
    font: Font,
    format: Option<String>,
    min: Option<f64>,
    max: Option<f64>,
    major: Option<f64>,
    tick_out: bool,
    /// Text, font and its own rotation in degrees (`bodyPr rot`), if any.
    title: Option<(String, Font, Option<f64>)>,
}

struct Chart {
    style: u32,
    kind: Kind,
    grouping: Grouping,
    gap: f64,
    overlap: f64,
    vary: bool,
    flat_3d: bool,
    series: Vec<Series>,
    title: Option<(String, Font)>,
    legend: Option<(String, Font)>,
    cat_axis: Option<Axis>,
    val_axis: Option<Axis>,
    first_angle: f64,
    hole: f64,
    /// Lines joining the stacks of stacked bars (`c:serLines`).
    series_lines: Option<Stroke>,
}

fn val(t: &Tree, n: usize, local: &str) -> Option<String> {
    t.child(n, NS_C, local).and_then(|c| t.node(c).attr("val")).map(str::to_owned)
}

fn flag(t: &Tree, n: usize, local: &str) -> Option<bool> {
    val(t, n, local).map(|v| v == "1" || v == "true")
}

/// Cached points of a `c:strRef`/`c:numRef`/`c:strLit`/`c:numLit` under `n`.
fn cache(t: &Tree, src: &[u8], n: usize) -> (Vec<Option<String>>, Option<String>) {
    let Some(holder) = t.node(n).children.iter().copied().find(|&c| matches!(t.node(c).local.as_str(), "strRef" | "numRef" | "strLit" | "numLit" | "multiLvlStrRef")) else { return (Vec::new(), None) };
    let cache = match t.node(holder).local.as_str() {
        "strRef" => t.child(holder, NS_C, "strCache"),
        "numRef" => t.child(holder, NS_C, "numCache"),
        "multiLvlStrRef" => t.path(holder, &[(NS_C, "multiLvlStrCache"), (NS_C, "lvl")]),
        _ => Some(holder),
    };
    let Some(cache) = cache else { return (Vec::new(), None) };
    let count = val(t, cache, "ptCount").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let mut out = vec![None; count];
    for p in t.children_named(cache, NS_C, "pt") {
        let Some(i) = t.node(p).attr("idx").and_then(|v| v.parse::<usize>().ok()) else { continue };
        let v = t.child(p, NS_C, "v").and_then(|v| t.text(src, v).ok());
        if i >= out.len() {
            out.resize(i + 1, None);
        }
        out[i] = v;
    }
    let format = t.child(cache, NS_C, "formatCode").and_then(|f| t.text(src, f).ok());
    (out, format)
}

/// Formats `v` with an Excel number format (the common ones).
fn format_number(v: f64, format: &str) -> String {
    let f = format.trim();
    if f.is_empty() || f.eq_ignore_ascii_case("general") {
        return general(v);
    }
    let percent = f.contains('%');
    let x = if percent { v * 100.0 } else { v };
    let decimals = f.split('.').nth(1).map(|d| d.chars().take_while(|c| *c == '0' || *c == '#').filter(|c| *c == '0').count()).unwrap_or(0);
    let grouping = f.contains(",");
    // Excel rounds halves away from zero.
    let k = 10f64.powi(decimals as i32);
    let x = (x * k).round() / k;
    let mut s = format!("{:.*}", decimals, x);
    if grouping {
        let (int, frac) = s.split_once('.').map(|(a, b)| (a.to_owned(), format!(".{b}"))).unwrap_or((s.clone(), String::new()));
        let neg = int.starts_with('-');
        let digits: Vec<char> = int.trim_start_matches('-').chars().collect();
        let mut g = String::new();
        for (k, c) in digits.iter().enumerate() {
            if k > 0 && (digits.len() - k) % 3 == 0 {
                g.push(',');
            }
            g.push(*c);
        }
        s = format!("{}{g}{frac}", if neg { "-" } else { "" });
    }
    if percent {
        s.push('%');
    }
    s
}

/// Excel's General format: up to 10 significant digits, no trailing zeros.
fn general(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    let s = format!("{:.10}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_owned();
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

/// Automatic value axis: from 0 (or a nice minimum below negative data) to
/// the data's maximum plus 5% of its range, in the largest of 1, 2, 5 x 10^n
/// steps giving at most 10 intervals... the smallest step that does.
fn auto_scale(lo: f64, hi: f64) -> (f64, f64, f64) {
    let (lo, hi) = (lo.min(0.0), hi.max(0.0));
    let span = (hi - lo).max(1e-12);
    let top = if hi > 0.0 { hi + 0.05 * span } else { 0.0 };
    let bottom = if lo < 0.0 { lo - 0.05 * span } else { 0.0 };
    let range = (top - bottom).max(1e-12);
    let mut exp = (range / 10.0).log10().floor();
    loop {
        for m in [1.0, 2.0, 5.0] {
            let step = m * 10f64.powf(exp);
            let (a, b) = ((bottom / step).floor() * step, (top / step).ceil() * step);
            if ((b - a) / step).round() <= 10.0 {
                return (a, if b == a { a + step } else { b }, step);
            }
        }
        exp += 1.0;
    }
}

impl Ctx<'_> {
    fn chart_font(&self, t: &Tree, node: Option<usize>, base: &Font) -> Font {
        let mut f = base.clone();
        let Some(tx) = node else { return f };
        // The paragraph's default run properties, then the first run's.
        let para = t.child(tx, NS_A, "p");
        let def = para.and_then(|p| t.path(p, &[(NS_A, "pPr"), (NS_A, "defRPr")]));
        let run = para.and_then(|p| t.path(p, &[(NS_A, "r"), (NS_A, "rPr")]));
        for r in [def, run].into_iter().flatten() {
            let n = t.node(r);
            if let Some(s) = num(n.attr("sz")) {
                f.size = s / 100.0;
            }
            if let Some(b) = n.attr("b") {
                f.bold = b == "1" || b == "true";
            }
            if let Some(c) = t.child(r, NS_A, "solidFill").and_then(|s| color::read_child(t, s, &self.colors, None)) {
                f.color = c;
            }
            if let Some(l) = t.child(r, NS_A, "latin").and_then(|l| t.node(l).attr("typeface")) {
                f.latin = Some(l.to_owned());
            }
        }
        f
    }

    fn chart_fill(&self, part: &Part, sp_pr: Option<usize>, bounds: Rect) -> Option<Option<Paint>> {
        let t = &part.tree;
        let sp = sp_pr?;
        let f = t.node(sp).children.iter().copied().find(|&c| matches!(t.node(c).local.as_str(), "noFill" | "solidFill" | "gradFill" | "pattFill"))?;
        Some(self.paint_from_fill(part, f, None, bounds, None).ok().flatten())
    }

    fn chart_line(&self, part: &Part, sp_pr: Option<usize>, default: Option<Stroke>) -> Option<Stroke> {
        let t = &part.tree;
        let Some(ln) = sp_pr.and_then(|s| t.child(s, NS_A, "ln")) else { return default };
        let width = num(t.node(ln).attr("w")).map(|w| w / 12_700.0);
        let fill = t.node(ln).children.iter().copied().find(|&c| matches!(t.node(c).local.as_str(), "noFill" | "solidFill" | "gradFill"));
        match fill {
            Some(f) if t.node(f).local == "noFill" => None,
            Some(f) => self.paint_from_fill(part, f, None, Rect::ZERO, None).ok().flatten().map(|paint| Stroke { paint, width: width.unwrap_or(0.75), dashes: Vec::new() }),
            None => default.map(|mut s| {
                if let Some(w) = width {
                    s.width = w;
                }
                s
            }),
        }
    }

    /// Colour of series (or point) `i` in chart style `style`. The 48 styles
    /// repeat eight colour schemes: greys (measured 61, B3, 81 for the first
    /// three), all six accents, then one accent each (style 4: accent 2),
    /// whose later series darken and lighten it.
    fn series_color(&self, style: u32, i: usize) -> Rgba {
        match style.saturating_sub(1) % 8 {
            0 => {
                const GREYS: [u8; 3] = [0x61, 0xB3, 0x81];
                let g = GREYS[i % 3];
                let g = if i >= 3 { (g as f64 * 0.8).round() as u8 } else { g };
                Rgba { r: g, g, b: g, a: 255 }
            }
            1 => self.accent(i),
            k => {
                let base = self.colors.scheme.get(&format!("accent{}", k - 1)).copied().unwrap_or(Rgba::BLACK);
                match i % 3 {
                    0 => base,
                    1 => shade(base, 0.6),
                    _ => tint(base, 0.6),
                }
            }
        }
    }

    fn accent(&self, i: usize) -> Rgba {
        let name = format!("accent{}", i % 6 + 1);
        let base = self.colors.scheme.get(&name).copied().unwrap_or(Rgba::BLACK);
        // Later rounds darken, then lighten, as Office does.
        match i / 6 {
            0 => base,
            1 => shade(base, 0.6),
            2 => tint(base, 0.6),
            _ => shade(base, 0.8),
        }
    }

    fn parse_chart(&self, part: &Part) -> Option<Chart> {
        let t = &part.tree;
        let src = &part.src;
        let space = t.root;
        let chart = t.child(space, NS_C, "chart")?;
        let plot = t.child(chart, NS_C, "plotArea")?;
        let tx1 = self.colors.scheme.get("dk1").copied().unwrap_or(Rgba::BLACK);
        let base = Font { size: 10.0, bold: false, color: tx1, latin: None };
        let base = self.chart_font(t, t.child(space, NS_C, "txPr"), &base);

        // Chart style: c:style, or the fallback of a c14:style choice.
        let style = t.nodes.iter().position(|n| n.ns.as_deref() == Some(NS_C) && n.local == "style").and_then(|n| t.node(n).attr("val")).and_then(|v| v.parse::<u32>().ok()).unwrap_or(2);
        // Placeholder titles are in the chart's language.
        let korean = val(t, space, "lang").is_some_and(|l| l.starts_with("ko"));
        let (chart_title, axis_title) = if korean { ("차트 제목", "축 제목") } else { ("Chart Title", "Axis Title") };
        let title_of = |ti: usize, big: &Font, fallback: &str| -> (String, Font) {
            let rich = t.path(ti, &[(NS_C, "tx"), (NS_C, "rich")]);
            let text = match rich {
                Some(r) => t.children_named(r, NS_A, "p").map(|p| t.children_named(p, NS_A, "r").filter_map(|r| t.child(r, NS_A, "t").and_then(|x| t.text(src, x).ok())).collect::<String>()).collect::<Vec<_>>().join("\n"),
                None => fallback.to_owned(),
            };
            (text, self.chart_font(t, rich.or_else(|| t.child(ti, NS_C, "txPr")), big))
        };
        let kinds = ["barChart", "bar3DChart", "lineChart", "line3DChart", "pieChart", "pie3DChart", "doughnutChart"];
        let group = t.node(plot).children.iter().copied().find(|&c| kinds.contains(&t.node(c).local.as_str()))?;
        let gl = t.node(group).local.clone();
        let kind = match gl.as_str() {
            "barChart" | "bar3DChart" => Kind::Bar { horizontal: val(t, group, "barDir").as_deref() == Some("bar") },
            "lineChart" | "line3DChart" => Kind::Line,
            _ => Kind::Pie,
        };
        let grouping = match val(t, group, "grouping").as_deref() {
            Some("stacked") => Grouping::Stacked,
            Some("percentStacked") => Grouping::Percent,
            _ => Grouping::Clustered,
        };
        let group_labels = t.child(group, NS_C, "dLbls");
        let mut series = Vec::new();
        for (k, s) in t.children_named(group, NS_C, "ser").enumerate() {
            let idx = val(t, s, "idx").and_then(|v| v.parse::<usize>().ok()).unwrap_or(k);
            let name = t.child(s, NS_C, "tx").map(|tx| cache(t, src, tx).0.into_iter().flatten().collect::<Vec<_>>().join(" ")).unwrap_or_else(|| format!("Series {}", k + 1));
            let categories: Vec<String> = t.child(s, NS_C, "cat").map(|c| cache(t, src, c).0.into_iter().map(|v| v.unwrap_or_default()).collect()).unwrap_or_default();
            let (vals, format) = t.child(s, NS_C, "val").map(|v| cache(t, src, v)).unwrap_or_default();
            let values = vals.into_iter().map(|v| v.and_then(|v| v.parse::<f64>().ok())).collect();
            let sp_pr = t.child(s, NS_C, "spPr");
            let accent = Paint::Solid(self.series_color(style, idx));
            let own = self.chart_fill(part, sp_pr, Rect::ZERO);
            let own_fill = own.is_some();
            let fill = own.unwrap_or(Some(accent.clone()));
            let line = match kind {
                Kind::Line => self.chart_line(part, sp_pr, Some(Stroke { paint: accent.clone(), width: 2.25, dashes: Vec::new() })),
                _ => self.chart_line(part, sp_pr, None),
            };
            let points = t
                .children_named(s, NS_C, "dPt")
                .filter_map(|d| {
                    let i = val(t, d, "idx")?.parse::<usize>().ok()?;
                    Some((i, self.chart_fill(part, t.child(d, NS_C, "spPr"), Rect::ZERO).flatten()))
                })
                .collect();
            let labels = t.child(s, NS_C, "dLbls").or(group_labels).and_then(|d| {
                if flag(t, d, "delete") == Some(true) {
                    return None;
                }
                let l = Labels {
                    value: flag(t, d, "showVal").unwrap_or(false),
                    percent: flag(t, d, "showPercent").unwrap_or(false),
                    category: flag(t, d, "showCatName").unwrap_or(false),
                    position: val(t, d, "dLblPos"),
                    font: self.chart_font(t, t.child(d, NS_C, "txPr"), &base),
                    format: t.child(d, NS_C, "numFmt").filter(|f| t.node(*f).attr("sourceLinked") != Some("1")).and_then(|f| t.node(f).attr("formatCode")).map(str::to_owned),
                };
                (l.value || l.percent || l.category).then_some(l)
            });
            series.push(Series { name, categories, values, format: format.unwrap_or_else(|| "General".into()), fill, own_fill, line, points, labels });
        }
        if series.is_empty() {
            return None;
        }

        let axis = |local: &str| -> Option<Axis> {
            let a = t.child(plot, NS_C, local)?;
            let scaling = t.child(a, NS_C, "scaling");
            let s = |k: &str| scaling.and_then(|sc| val(t, sc, k)).and_then(|v| v.parse::<f64>().ok());
            let grid = t.child(a, NS_C, "majorGridlines").map(|g| self.chart_line(part, t.child(g, NS_C, "spPr"), Some(Stroke { paint: Paint::Solid(GRID_GREY), width: 0.75, dashes: Vec::new() })));
            Some(Axis {
                deleted: flag(t, a, "delete").unwrap_or(false),
                no_labels: val(t, a, "tickLblPos").as_deref() == Some("none"),
                gridlines: grid.flatten(),
                line: self.chart_line(part, t.child(a, NS_C, "spPr"), Some(Stroke { paint: Paint::Solid(GRID_GREY), width: 0.75, dashes: Vec::new() })),
                font: self.chart_font(t, t.child(a, NS_C, "txPr"), &base),
                format: t.child(a, NS_C, "numFmt").filter(|f| t.node(*f).attr("sourceLinked") != Some("1")).and_then(|f| t.node(f).attr("formatCode")).map(str::to_owned),
                min: s("min"),
                max: s("max"),
                major: val(t, a, "majorUnit").and_then(|v| v.parse().ok()),
                tick_out: !matches!(val(t, a, "majorTickMark").as_deref(), Some("none") | Some("in")),
                title: t.child(a, NS_C, "title").map(|ti| {
                    let (text, font) = title_of(ti, &Font { bold: true, ..base.clone() }, axis_title);
                    let body = t.path(ti, &[(NS_C, "tx"), (NS_C, "rich"), (NS_A, "bodyPr")]).or_else(|| t.path(ti, &[(NS_C, "txPr"), (NS_A, "bodyPr")]));
                    let rot = body.and_then(|b| num(t.node(b).attr("rot"))).map(|r| r / 60_000.0);
                    (text, font, rot)
                }),
            })
        };

        let title = t.child(chart, NS_C, "title").filter(|_| flag(t, chart, "autoTitleDeleted") != Some(true)).map(|ti| {
            let big = Font { size: base.size * 1.2, bold: true, ..base.clone() };
            // An automatic title is the only (for a pie, the first) series' name.
            let fallback = if series.len() == 1 || kind == Kind::Pie { series[0].name.clone() } else { chart_title.to_owned() };
            title_of(ti, &big, &fallback)
        });
        let legend = t.child(chart, NS_C, "legend").map(|l| (val(t, l, "legendPos").unwrap_or_else(|| "r".into()), self.chart_font(t, t.child(l, NS_C, "txPr"), &base)));
        Some(Chart {
            style,
            kind,
            grouping,
            gap: val(t, group, "gapWidth").and_then(|v| v.parse().ok()).unwrap_or(150.0) / 100.0,
            overlap: val(t, group, "overlap").and_then(|v| v.parse().ok()).unwrap_or(if grouping == Grouping::Clustered { 0.0 } else { 100.0 }) / 100.0,
            vary: flag(t, group, "varyColors").unwrap_or(matches!(kind, Kind::Pie)),
            flat_3d: gl.contains("3D"),
            series,
            title,
            legend,
            cat_axis: axis("catAx").or_else(|| axis("dateAx")),
            val_axis: axis("valAx"),
            first_angle: val(t, group, "firstSliceAng").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            series_lines: t.child(group, NS_C, "serLines").and_then(|l| self.chart_line(part, t.child(l, NS_C, "spPr"), Some(Stroke { paint: Paint::Solid(Rgba::BLACK), width: 0.75, dashes: Vec::new() }))),
            hole: if gl == "doughnutChart" { val(t, group, "holeSize").and_then(|v| v.parse().ok()).unwrap_or(50.0) / 100.0 } else { 0.0 },
        })
    }

    /// Width and height of `s` (lines split at `\n`) in `font`, and its
    /// layout aligned by `align` (`l`, `ctr`, `r`) within that width.
    fn chart_text(&self, s: &str, font: &Font) -> (f64, f64, text::TextLayout) {
        let (w, h, _) = self.chart_text_aligned(s, font, "l", 10_000.0);
        let (_, _, lay) = self.chart_text_aligned(s, font, "l", w + 1.0);
        (w, h, lay)
    }

    fn chart_text_aligned(&self, s: &str, font: &Font, align: &str, width: f64) -> (f64, f64, text::TextLayout) {
        let run = TextRun {
            text: s.to_owned(),
            props: RunProps { size: Some(font.size), bold: Some(font.bold), color: Some(font.color), latin: Some(font.latin.clone().unwrap_or_else(|| "+mn-lt".into())), ea: Some("+mn-ea".into()), ..Default::default() },
            line_break: false,
        };
        let para = Paragraph { props: ParaProps { align: Some(align.into()), ..Default::default() }, runs: vec![run.clone()], end_props: run.props.clone(), from_text_break: false };
        let paras: Vec<Paragraph> = text::split_text_breaks(para);
        let body = BodyProps { insets: [0.0; 4], wrap: false, ..Default::default() };
        let lay = text::layout(&paras, &body, width, 10_000.0, self.fonts, &self.theme.fonts);
        let w = lay.lines.iter().map(|l| l.width).fold(0.0, f64::max);
        (w, lay.content_height, lay)
    }

    /// Draws `s` with its box's point (`ax`, `ay`) (0 to 1 across the box) at
    /// `at`, turned by `angle` degrees about that point.
    fn chart_label(&mut self, s: &str, font: &Font, at: Point, ax: f64, ay: f64, angle: f64, transform: Affine) {
        let (w, h, _) = self.chart_text(s, font);
        // Several lines align with each other as the label does.
        let align = if ax >= 1.0 { "r" } else if ax > 0.0 { "ctr" } else { "l" };
        let (_, _, mut lay) = self.chart_text_aligned(s, font, align, w + 1.0);
        let place = transform * Affine::translate(at.to_vec2()) * Affine::rotate(angle.to_radians()) * Affine::translate((-(w + 1.0) * ax, -h * ay));
        self.emit_text(&mut lay, place);
    }

    /// Draws the chart of graphic frame `frame`; false when it has no chart
    /// part this can draw.
    pub(super) fn chart(&mut self, part: &Arc<Part>, frame: usize, base: Affine) -> bool {
        let t = &part.tree;
        let Some(xfrm) = t.child(frame, part.ns, "xfrm").and_then(|x| read_xfrm(t, x)) else { return false };
        let Some(c) = t.path(frame, &[(NS_A, "graphic"), (NS_A, "graphicData"), (NS_C, "chart")]) else { return false };
        let Some(target) = t.node(c).attr_ns(NS_R, "id").and_then(|r| part.rels.iter().find(|x| x.id == r)).map(|r| r.target.clone()) else { return false };
        let Ok(chart_part) = load_part_ns(self.pres, &target, NS_C) else { return false };
        let Some(chart) = self.parse_chart(&chart_part) else { return false };
        let (w, h) = (xfrm.rect.width(), xfrm.rect.height());
        let transform = base * xfrm.transform(false);
        let area = Rect::new(0.0, 0.0, w, h);
        // Chart area fill and border (none unless given).
        let space_sp = chart_part.tree.child(chart_part.tree.root, NS_C, "spPr");
        let fill = self.chart_fill(&chart_part, space_sp, area).flatten();
        let border = self.chart_line(&chart_part, space_sp, None);
        if fill.is_some() || border.is_some() {
            self.out.scene.items.push(Item::Path { path: area.to_path(0.1), transform, fill, stroke: border });
        }
        self.provisional("chartLayout");
        if chart.flat_3d {
            self.diag(None, "chart", "3D chart drawn flat");
        }
        let mut inner = area.inset(-EDGE);

        if let Some((title, font)) = chart.title.clone() {
            let (_, th, _) = self.chart_text(&title, &font);
            self.chart_label(&title, &font, Point::new(w / 2.0, inner.y0), 0.5, 0.0, 0.0, transform);
            inner.y0 += th + EDGE;
        }

        // Legend entries: series, or categories for a pie.
        let entries: Vec<(String, Option<Paint>, Option<Stroke>)> = if chart.kind == Kind::Pie || (chart.vary && chart.series.len() == 1) {
            let s = &chart.series[0];
            (0..s.values.len()).map(|i| (s.categories.get(i).cloned().unwrap_or_else(|| (i + 1).to_string()), Some(self.point_paint(&chart, s, 0, i)), None)).collect()
        } else {
            let mut e: Vec<_> = chart.series.iter().map(|s| (s.name.clone(), s.fill.clone(), if chart.kind == Kind::Line { s.line.clone() } else { None })).collect();
            // A side legend of stacked columns lists them top down, as stacked.
            let side = chart.legend.as_ref().is_some_and(|(p, _)| p == "r" || p == "l");
            if side && chart.grouping != Grouping::Clustered && chart.kind == (Kind::Bar { horizontal: false }) {
                e.reverse();
            }
            e
        };
        if let Some((pos, font)) = chart.legend.clone() {
            let key = font.size * 0.55;
            let sizes: Vec<(f64, f64)> = entries.iter().map(|(n, ..)| {
                let (tw, th, _) = self.chart_text(n, &font);
                (tw, th)
            }).collect();
            let line_h = sizes.iter().map(|s| s.1).fold(0.0, f64::max);
            let item_w = |tw: f64| key + font.size * 0.3 + tw;
            match pos.as_str() {
                "b" | "t" => {
                    let total: f64 = sizes.iter().map(|s| item_w(s.0) + font.size * 0.8).sum::<f64>() - font.size * 0.8;
                    let y = if pos == "b" { inner.y1 - line_h } else { inner.y0 };
                    let mut x = (w - total) / 2.0;
                    for ((name, paint, line), (tw, _)) in entries.iter().zip(&sizes) {
                        self.legend_key(Rect::new(x, y + (line_h - key) / 2.0, x + key, y + (line_h + key) / 2.0), paint, line, transform);
                        self.chart_label(name, &font, Point::new(x + key + font.size * 0.3, y), 0.0, 0.0, 0.0, transform);
                        x += item_w(*tw) + font.size * 0.8;
                    }
                    if pos == "b" {
                        inner.y1 -= line_h + EDGE;
                    } else {
                        inner.y0 += line_h + EDGE;
                    }
                }
                _ => {
                    let lw = sizes.iter().map(|s| item_w(s.0)).fold(0.0, f64::max);
                    let total = line_h * entries.len() as f64 * 1.5;
                    let x = if pos == "l" { inner.x0 } else { inner.x1 - lw };
                    let mut y = (inner.y0 + inner.y1 - total) / 2.0 + line_h * 0.25;
                    for (name, paint, line) in &entries {
                        self.legend_key(Rect::new(x, y + (line_h - key) / 2.0, x + key, y + (line_h + key) / 2.0), paint, line, transform);
                        self.chart_label(name, &font, Point::new(x + key + font.size * 0.3, y), 0.0, 0.0, 0.0, transform);
                        y += line_h * 1.5;
                    }
                    if pos == "l" {
                        inner.x0 += lw + EDGE;
                    } else {
                        inner.x1 -= lw + EDGE;
                    }
                }
            }
        }

        match chart.kind {
            Kind::Pie => self.pie(&chart, inner, transform),
            _ => self.axes_chart(&chart, inner, transform),
        }
        true
    }

    fn point_paint(&self, chart: &Chart, s: &Series, si: usize, i: usize) -> Paint {
        if let Some((_, p)) = s.points.iter().find(|(k, _)| *k == i) {
            if let Some(p) = p {
                return p.clone();
            }
        }
        // Measured: a series' own fill colours every point, varied or not.
        if chart.vary && !s.own_fill {
            return Paint::Solid(self.series_color(chart.style, i));
        }
        s.fill.clone().unwrap_or(Paint::Solid(self.series_color(chart.style, si)))
    }

    fn legend_key(&mut self, r: Rect, paint: &Option<Paint>, line: &Option<Stroke>, transform: Affine) {
        match line {
            Some(l) => {
                let mut p = BezPath::new();
                let y = (r.y0 + r.y1) / 2.0;
                p.move_to((r.x0 - r.width() * 0.5, y));
                p.line_to((r.x1 + r.width() * 0.5, y));
                self.out.scene.items.push(Item::Path { path: p, transform, fill: None, stroke: Some(l.clone()) });
            }
            None => self.out.scene.items.push(Item::Path { path: r.to_path(0.1), transform, fill: paint.clone(), stroke: None }),
        }
    }

    fn pie(&mut self, chart: &Chart, inner: Rect, transform: Affine) {
        let s = &chart.series[0];
        let total: f64 = s.values.iter().flatten().filter(|v| **v > 0.0).sum();
        if total <= 0.0 {
            return;
        }
        // Measured: the pie fills about 82% of the shorter side.
        let r = (inner.width().min(inner.height()) / 2.0).max(1.0) * 0.82;
        let c = inner.center();
        let mut angle = chart.first_angle.to_radians() - std::f64::consts::FRAC_PI_2;
        for (i, v) in s.values.iter().enumerate() {
            let Some(v) = v.filter(|v| *v > 0.0) else { continue };
            let sweep = v / total * std::f64::consts::TAU;
            let mut p = BezPath::new();
            p.move_to(c);
            p.line_to((c.x + angle.cos() * r, c.y + angle.sin() * r));
            p.extend(kurbo::Arc::new(c, (r, r), angle, sweep, 0.0).append_iter(0.1));
            p.close_path();
            if chart.hole > 0.0 {
                p.extend(kurbo::Arc::new(c, (r * chart.hole, r * chart.hole), angle + sweep, -sweep, 0.0).append_iter(0.1));
            }
            let fill = self.point_paint(chart, s, 0, i);
            let stroke = s.line.clone();
            self.out.scene.items.push(Item::Path { path: p, transform, fill: Some(fill), stroke });
            if let Some(l) = &s.labels {
                let mid = angle + sweep / 2.0;
                let at = Point::new(c.x + mid.cos() * r * 0.6, c.y + mid.sin() * r * 0.6);
                let mut parts = Vec::new();
                if l.category {
                    parts.push(s.categories.get(i).cloned().unwrap_or_default());
                }
                if l.value {
                    parts.push(format_number(v, l.format.as_deref().unwrap_or(&s.format)));
                }
                if l.percent {
                    parts.push(format_number(v / total, l.format.as_deref().filter(|f| f.contains('%')).unwrap_or("0%")));
                }
                let text = parts.join("\n");
                self.chart_label(&text, &l.font, at, 0.5, 0.5, 0.0, transform);
            }
            angle += sweep;
        }
    }

    fn axes_chart(&mut self, chart: &Chart, inner: Rect, transform: Affine) {
        let horizontal = matches!(chart.kind, Kind::Bar { horizontal: true });
        let n_cat = chart.series.iter().map(|s| s.values.len().max(s.categories.len())).max().unwrap_or(0).max(1);
        let categories: Vec<String> = (0..n_cat).map(|i| chart.series.iter().find_map(|s| s.categories.get(i).cloned()).unwrap_or_else(|| (i + 1).to_string())).collect();
        // Value range.
        let stacked = chart.grouping != Grouping::Clustered && !matches!(chart.kind, Kind::Line if chart.grouping == Grouping::Clustered);
        let (mut lo, mut hi) = (0.0f64, 0.0f64);
        for i in 0..n_cat {
            if chart.grouping == Grouping::Percent {
                hi = 1.0;
                break;
            }
            if stacked {
                let (p, n): (f64, f64) = chart.series.iter().filter_map(|s| s.values.get(i).copied().flatten()).fold((0.0, 0.0), |(p, n), v| if v >= 0.0 { (p + v, n) } else { (p, n + v) });
                hi = hi.max(p);
                lo = lo.min(n);
            } else {
                for s in &chart.series {
                    if let Some(v) = s.values.get(i).copied().flatten() {
                        hi = hi.max(v);
                        lo = lo.min(v);
                    }
                }
            }
        }
        let va = chart.val_axis.as_ref();
        let (mut vmin, mut vmax, mut step) = auto_scale(lo, hi);
        if chart.grouping == Grouping::Percent {
            (vmin, vmax, step) = (0.0, 1.0, 0.1);
        }
        if let Some(a) = va {
            vmin = a.min.unwrap_or(vmin);
            vmax = a.max.unwrap_or(vmax);
            step = a.major.unwrap_or(step);
        }
        let manual_step = va.and_then(|a| a.major).is_some();
        let vformat = va.and_then(|a| a.format.clone()).unwrap_or_else(|| if chart.grouping == Grouping::Percent { "0%".into() } else { chart.series[0].format.clone() });
        let mut ticks: Vec<f64> = (0..=(((vmax - vmin) / step).round() as usize)).map(|k| vmin + k as f64 * step).collect();
        let mut vlabels: Vec<String> = ticks.iter().map(|v| format_number(*v, &vformat)).collect();
        let show_vals = va.map(|a| !a.deleted && !a.no_labels).unwrap_or(false);
        let ca = chart.cat_axis.as_ref();
        let show_cats = ca.map(|a| !a.deleted && !a.no_labels).unwrap_or(false);
        let vfont = va.map(|a| a.font.clone());
        let cfont = ca.map(|a| a.font.clone());

        // Axis titles at the outer edges.
        let mut inner = inner;
        let (vt, ct) = (va.and_then(|a| a.title.clone()).filter(|_| show_vals_axis(va)), ca.and_then(|a| a.title.clone()).filter(|_| show_vals_axis(ca)));
        let (side_title, bottom_title) = if horizontal { (ct, vt) } else { (vt, ct) };
        // A title keeps its own rotation; without one, a side title turns.
        if let Some((text, font, rot)) = side_title {
            let (tw, th, _) = self.chart_text(&text, &font);
            let angle = rot.unwrap_or(-90.0);
            let upright = angle.abs() < 45.0;
            let room = if upright { tw } else { th };
            self.chart_label(&text, &font, Point::new(inner.x0 + room / 2.0, (inner.y0 + inner.y1) / 2.0), 0.5, 0.5, angle, transform);
            inner.x0 += room + font.size * 0.3;
        }
        if let Some((text, font, rot)) = bottom_title {
            let (tw, th, _) = self.chart_text(&text, &font);
            let angle = rot.unwrap_or(0.0);
            let room = if angle.abs() < 45.0 { th } else { tw };
            self.chart_label(&text, &font, Point::new((inner.x0 + inner.x1) / 2.0, inner.y1 - room / 2.0), 0.5, 0.5, angle, transform);
            inner.y1 -= room + font.size * 0.3;
        }
        // Room for the axis labels.
        let mut plot = inner;
        let vtick = if va.map(|a| a.tick_out).unwrap_or(false) { TICK } else { 0.0 };
        let ctick = if ca.map(|a| a.tick_out).unwrap_or(false) { TICK } else { 0.0 };
        let vsize: Vec<(f64, f64)> = if show_vals { vlabels.iter().map(|l| { let (a, b, _) = self.chart_text(l, vfont.as_ref().unwrap()); (a, b) }).collect() } else { Vec::new() };
        let csize: Vec<(f64, f64)> = if show_cats { categories.iter().map(|l| { let (a, b, _) = self.chart_text(l, cfont.as_ref().unwrap()); (a, b) }).collect() } else { Vec::new() };
        let gap = |f: &Option<Font>| f.as_ref().map(|f| f.size * 0.3).unwrap_or(0.0);
        let vmaxw = vsize.iter().map(|s| s.0).fold(0.0, f64::max);
        let vmaxh = vsize.iter().map(|s| s.1).fold(0.0, f64::max);
        let cmaxw = csize.iter().map(|s| s.0).fold(0.0, f64::max);
        let cmaxh = csize.iter().map(|s| s.1).fold(0.0, f64::max);
        // Category labels that do not fit side by side turn 45 degrees.
        let mut rotate = false;
        if !horizontal {
            if show_vals {
                plot.x0 += vmaxw + gap(&vfont) + vtick;
            }
            plot.y0 += vmaxh / 2.0;
            if show_cats {
                let slot = (plot.width()) / n_cat as f64;
                rotate = cmaxw > slot * 0.98;
                let room = if rotate { (cmaxw + cmaxh) * std::f64::consts::FRAC_1_SQRT_2 } else { cmaxh };
                plot.y1 -= room + gap(&cfont) + ctick;
            }
        } else {
            if show_cats {
                plot.x0 += cmaxw + gap(&cfont) + ctick;
            }
            if show_vals {
                plot.y1 -= vmaxh + gap(&vfont) + vtick;
                plot.x1 -= vmaxw / 2.0;
            }
        }
        // Crowded labels widen the step (1, 2, 5 x 10^n), as PowerPoint does
        // on short axes (provisional: label extent plus two font sizes
        // across, 1.2 label heights up).
        if show_vals && !manual_step && chart.grouping != Grouping::Percent {
            let font = vfont.clone().unwrap();
            loop {
                let len = if horizontal { plot.width() } else { plot.height() };
                let need = if horizontal { vmaxw + 2.0 * font.size } else { vmaxh * 1.2 };
                let n = ticks.len().saturating_sub(1).max(1) as f64;
                if len / n >= need || n <= 1.0 {
                    break;
                }
                let exp = step.log10().floor();
                let m = (step / 10f64.powf(exp)).round();
                step = if m < 2.0 { 2.0 } else if m < 5.0 { 5.0 } else { 10.0 } * 10f64.powf(exp);
                vmin = (vmin / step).floor() * step;
                vmax = ((hi.max(0.0) + 0.05 * (hi.max(0.0) - lo.min(0.0))) / step).ceil() * step;
                ticks = (0..=(((vmax - vmin) / step).round() as usize)).map(|k| vmin + k as f64 * step).collect();
                vlabels = ticks.iter().map(|v| format_number(*v, &vformat)).collect();
            }
        }
        let vpos = |v: f64| -> f64 {
            let f = (v - vmin) / (vmax - vmin).max(1e-12);
            if horizontal {
                plot.x0 + f * plot.width()
            } else {
                plot.y1 - f * plot.height()
            }
        };
        let slot = if horizontal { plot.height() } else { plot.width() } / n_cat as f64;
        let cat_start = |i: usize| -> f64 {
            if horizontal {
                // Bar charts list the first category at the bottom.
                plot.y1 - (i + 1) as f64 * slot
            } else {
                plot.x0 + i as f64 * slot
            }
        };

        // Gridlines.
        if let Some(g) = va.and_then(|a| a.gridlines.clone()) {
            for &v in &ticks {
                let p = vpos(v);
                let mut path = BezPath::new();
                if horizontal {
                    path.move_to((p, plot.y0));
                    path.line_to((p, plot.y1));
                } else {
                    path.move_to((plot.x0 - vtick, p));
                    path.line_to((plot.x1, p));
                }
                self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(g.clone()) });
            }
        }

        // Series.
        let n_ser = chart.series.len();
        let mut pos_stack = vec![0.0; n_cat];
        let mut neg_stack = vec![0.0; n_cat];
        let totals: Vec<f64> = (0..n_cat).map(|i| chart.series.iter().filter_map(|s| s.values.get(i).copied().flatten()).map(f64::abs).sum()).collect();
        let mut labels: Vec<(String, Font, Point, f64, f64)> = Vec::new();
        // Stack ends per series and category, for series lines.
        let mut tops: Vec<Vec<Option<Rect>>> = vec![vec![None; n_cat]; n_ser];
        for (si, s) in chart.series.iter().enumerate() {
            match chart.kind {
                Kind::Bar { .. } => {
                    let groups = if chart.grouping == Grouping::Clustered { n_ser as f64 } else { 1.0 };
                    let ov = if chart.grouping == Grouping::Clustered { chart.overlap } else { 1.0 };
                    // Width of one bar: the slot holds the bars (overlapping by
                    // `overlap`) and one gap of `gap` bar widths.
                    let bar = slot / (groups - (groups - 1.0) * ov + chart.gap);
                    for i in 0..n_cat {
                        let Some(v) = s.values.get(i).copied().flatten() else { continue };
                        let v = if chart.grouping == Grouping::Percent { if totals[i] > 0.0 { v / totals[i] } else { 0.0 } } else { v };
                        let (a, b) = if chart.grouping == Grouping::Clustered {
                            (0.0, v)
                        } else if v >= 0.0 {
                            let a = pos_stack[i];
                            pos_stack[i] += v;
                            (a, a + v)
                        } else {
                            let a = neg_stack[i];
                            neg_stack[i] += v;
                            (a, a + v)
                        };
                        let k = if chart.grouping == Grouping::Clustered { si as f64 } else { 0.0 };
                        let off = cat_start(i) + slot * chart.gap / (groups - (groups - 1.0) * ov + chart.gap) / 2.0 + k * bar * (1.0 - ov);
                        let (p0, p1) = (vpos(a.max(vmin).min(vmax)), vpos(b.max(vmin).min(vmax)));
                        let r = if horizontal {
                            // Within a category, the first series is lowest.
                            let y = cat_start(i) + slot - (off - cat_start(i)) - bar;
                            Rect::new(p0.min(p1), y, p0.max(p1), y + bar)
                        } else {
                            Rect::new(off, p0.min(p1), off + bar, p0.max(p1))
                        };
                        let fill = self.point_paint(chart, s, si, i);
                        self.out.scene.items.push(Item::Path { path: r.to_path(0.1), transform, fill: Some(fill), stroke: s.line.clone() });
                        tops[si][i] = Some(r);
                        if let Some(l) = &s.labels {
                            let text = data_label(l, s, i, v, totals[i]);
                            let inside = chart.grouping != Grouping::Clustered || matches!(l.position.as_deref(), Some("ctr") | Some("inEnd") | Some("inBase"));
                            let (at, ax, ay) = match (horizontal, inside) {
                                (false, false) => (Point::new(r.center().x, r.y0 - l.font.size * 0.15), 0.5, 1.0),
                                (false, true) => (r.center(), 0.5, 0.5),
                                (true, false) => (Point::new(r.x1 + l.font.size * 0.15, r.center().y), 0.0, 0.5),
                                (true, true) => (r.center(), 0.5, 0.5),
                            };
                            labels.push((text, l.font.clone(), at, ax, ay));
                        }
                    }
                }
                Kind::Line => {
                    let mut path = BezPath::new();
                    let mut started = false;
                    for i in 0..n_cat {
                        let Some(v) = s.values.get(i).copied().flatten() else {
                            started = false;
                            continue;
                        };
                        let v = if stacked {
                            pos_stack[i] += v;
                            pos_stack[i]
                        } else {
                            v
                        };
                        let p = Point::new(cat_start(i) + slot / 2.0, vpos(v));
                        if started {
                            path.line_to(p);
                        } else {
                            path.move_to(p);
                            started = true;
                        }
                        if let Some(l) = &s.labels {
                            labels.push((data_label(l, s, i, v, totals[i]), l.font.clone(), Point::new(p.x + l.font.size * 0.3, p.y), 0.0, 0.5));
                        }
                    }
                    if let Some(st) = s.line.clone() {
                        self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(st) });
                    }
                }
                Kind::Pie => {}
            }
        }

        if let (Some(line), Kind::Bar { horizontal: false }, false) = (chart.series_lines.clone(), chart.kind, chart.grouping == Grouping::Clustered) {
            let mut path = BezPath::new();
            for row in &tops {
                for w in row.windows(2) {
                    if let [Some(a), Some(b)] = w {
                        path.move_to((a.x1, a.y0));
                        path.line_to((b.x0, b.y0));
                    }
                }
            }
            self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(line) });
        }

        // Axis lines, ticks and labels.
        if let Some(a) = ca {
            if let Some(l) = a.line.clone().filter(|_| !a.deleted) {
                let zero = vpos(0.0f64.max(vmin).min(vmax));
                let mut path = BezPath::new();
                if horizontal {
                    path.move_to((zero, plot.y0));
                    path.line_to((zero, plot.y1));
                } else {
                    path.move_to((plot.x0, zero));
                    path.line_to((plot.x1, zero));
                }
                if a.tick_out {
                    for i in 0..=n_cat {
                        let c = if horizontal { plot.y1 - i as f64 * slot } else { plot.x0 + i as f64 * slot };
                        if horizontal {
                            path.move_to((plot.x0 - TICK, c));
                            path.line_to((plot.x0, c));
                        } else {
                            path.move_to((c, plot.y1));
                            path.line_to((c, plot.y1 + TICK));
                        }
                    }
                }
                self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(l) });
            }
            if show_cats {
                let f = a.font.clone();
                for (i, name) in categories.iter().enumerate() {
                    let c = cat_start(i) + slot / 2.0;
                    if horizontal {
                        self.chart_label(name, &f, Point::new(plot.x0 - ctick - f.size * 0.3, c), 1.0, 0.5, 0.0, transform);
                    } else if rotate {
                        self.chart_label(name, &f, Point::new(c, plot.y1 + ctick + f.size * 0.2), 1.0, 0.0, -45.0, transform);
                    } else {
                        self.chart_label(name, &f, Point::new(c, plot.y1 + ctick + f.size * 0.2), 0.5, 0.0, 0.0, transform);
                    }
                }
            }
        }
        if let Some(a) = va {
            if let Some(l) = a.line.clone().filter(|_| !a.deleted) {
                let mut path = BezPath::new();
                if horizontal {
                    path.move_to((plot.x0, plot.y1));
                    path.line_to((plot.x1, plot.y1));
                } else {
                    path.move_to((plot.x0, plot.y0));
                    path.line_to((plot.x0, plot.y1));
                }
                if a.tick_out {
                    for &v in &ticks {
                        let p = vpos(v);
                        if horizontal {
                            path.move_to((p, plot.y1));
                            path.line_to((p, plot.y1 + TICK));
                        } else {
                            path.move_to((plot.x0 - TICK, p));
                            path.line_to((plot.x0, p));
                        }
                    }
                }
                self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(l) });
            }
            if show_vals {
                let f = a.font.clone();
                for (v, label) in ticks.iter().zip(&vlabels) {
                    let p = vpos(*v);
                    if horizontal {
                        self.chart_label(label, &f, Point::new(p, plot.y1 + vtick + f.size * 0.2), 0.5, 0.0, 0.0, transform);
                    } else {
                        self.chart_label(label, &f, Point::new(plot.x0 - vtick - f.size * 0.3, p), 1.0, 0.5, 0.0, transform);
                    }
                }
            }
        }
        for (text, font, at, ax, ay) in labels {
            self.chart_label(&text, &font, at, ax, ay, 0.0, transform);
        }
    }
}

fn show_vals_axis(a: Option<&Axis>) -> bool {
    a.is_some_and(|a| !a.deleted)
}

fn data_label(l: &Labels, s: &Series, i: usize, v: f64, total: f64) -> String {
    let mut parts = Vec::new();
    if l.category {
        parts.push(s.categories.get(i).cloned().unwrap_or_default());
    }
    if l.value {
        parts.push(format_number(v, l.format.as_deref().unwrap_or(&s.format)));
    }
    if l.percent && total > 0.0 {
        parts.push(format_number(v / total, "0%"));
    }
    parts.join(", ")
}

fn shade(c: Rgba, k: f64) -> Rgba {
    Rgba { r: (c.r as f64 * k).round() as u8, g: (c.g as f64 * k).round() as u8, b: (c.b as f64 * k).round() as u8, a: c.a }
}

fn tint(c: Rgba, k: f64) -> Rgba {
    let t = |v: u8| (v as f64 + (255.0 - v as f64) * (1.0 - k)).round() as u8;
    Rgba { r: t(c.r), g: t(c.g), b: t(c.b), a: c.a }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_value_axes_match_powerpoint() {
        // Measured: data maxima 16.5, 5, 0.29 and 0.34 give these axes.
        assert_eq!(auto_scale(0.0, 16.5), (0.0, 18.0, 2.0));
        assert_eq!(auto_scale(0.0, 5.0), (0.0, 6.0, 1.0));
        let (a, b, s) = auto_scale(0.0, 0.29);
        assert_eq!((a, (b * 100.0).round() / 100.0, (s * 100.0).round() / 100.0), (0.0, 0.35, 0.05));
        let (_, b, _) = auto_scale(0.0, 0.34);
        assert_eq!((b * 100.0).round() / 100.0, 0.4);
    }

    #[test]
    fn number_formats() {
        assert_eq!(format_number(0.29, "0%"), "29%");
        assert_eq!(format_number(0.15, "General"), "0.15");
        assert_eq!(format_number(1234.5, "#,##0"), "1,235");
        assert_eq!(format_number(2.0, "0.0"), "2.0");
    }
}
