//! Tables (`a:tbl` in a graphic frame): grid, merged cells, cell text,
//! cell fills and borders, and the table style the file carries.

use std::sync::Arc;

use kurbo::{Affine, BezPath, Rect, Shape};
use present_render::{Item, Paint, Stroke};

use super::color;
use super::text::{self, BodyProps, RunProps, StyleSource};
use super::{load_part, num, read_xfrm, Ctx, Part, TextBoxInfo};
use crate::xml::{NS_A, NS_P};

const EMU_PER_PT: f64 = 12_700.0;

/// Style sections that apply to a cell, lowest precedence first.
fn sections(flags: &Flags, row: usize, col: usize, rows: usize, cols: usize) -> Vec<&'static str> {
    let mut s = vec!["wholeTbl"];
    if flags.band_col {
        let i = col - usize::from(flags.first_col);
        if !(flags.first_col && col == 0) && !(flags.last_col && col + 1 == cols) {
            s.push(if i % 2 == 0 { "band1V" } else { "band2V" });
        }
    }
    if flags.band_row {
        let i = row.saturating_sub(usize::from(flags.first_row));
        if !(flags.first_row && row == 0) && !(flags.last_row && row + 1 == rows) {
            s.push(if i % 2 == 0 { "band1H" } else { "band2H" });
        }
    }
    if flags.last_col && col + 1 == cols {
        s.push("lastCol");
    }
    if flags.first_col && col == 0 {
        s.push("firstCol");
    }
    if flags.last_row && row + 1 == rows {
        s.push("lastRow");
    }
    if flags.first_row && row == 0 {
        s.push("firstRow");
    }
    s
}

#[derive(Default)]
struct Flags {
    first_row: bool,
    last_row: bool,
    first_col: bool,
    last_col: bool,
    band_row: bool,
    band_col: bool,
}

struct Cell {
    node: usize,
    row: usize,
    col: usize,
    rows: usize,
    cols: usize,
}

impl<'a> Ctx<'a> {
    /// The `a:tblStyle` with `id` in the presentation's table styles part.
    fn table_style(&self, id: &str) -> Option<(Arc<Part>, usize)> {
        let find = |part: Arc<Part>| {
            let t = &part.tree;
            let node = t.children_named(t.root, NS_A, "tblStyle").find(|&s| t.node(s).attr("styleId") == Some(id))?;
            Some((part.clone(), node))
        };
        let in_file = self
            .pres_part
            .rels
            .iter()
            .find(|r| !r.external && r.rel_type.ends_with("/tableStyles"))
            .and_then(|rel| load_part(self.pres, &rel.target).ok())
            .and_then(find);
        // PowerPoint does not always write its default style into the file.
        in_file.or_else(|| {
            let src = include_str!("../../data/defaultTableStyle.xml");
            let tree = crate::xml::Tree::parse(src.as_bytes()).ok()?;
            find(Arc::new(Part { name: "defaultTableStyle.xml".into(), ns: NS_P, src: Arc::new(src.as_bytes().to_vec()), tree, rels: Vec::new() }))
        })
    }

    /// A stroke from an `a:ln`-like element (`a:ln`, `a:lnL`, ...).
    fn stroke_from_ln(&self, part: &Part, ln: usize, ph: Option<present_render::Rgba>) -> Option<Stroke> {
        let t = &part.tree;
        let width = num(t.node(ln).attr("w")).map(|w| w / EMU_PER_PT).unwrap_or(0.75);
        let mut paint = None;
        for &c in &t.node(ln).children {
            match t.node(c).local.as_str() {
                "noFill" => return None,
                "solidFill" => paint = color::read_child(t, c, &self.colors, ph).map(Paint::Solid),
                _ => {}
            }
        }
        paint.map(|paint| Stroke { paint, width, dashes: Vec::new() })
    }

    /// Border stroke from a table style side (`a:left`, `a:insideH`, ...).
    fn style_border(&self, style: &Part, side: usize) -> Option<Stroke> {
        let t = &style.tree;
        if let Some(ln) = t.child(side, NS_A, "ln") {
            return self.stroke_from_ln(style, ln, None);
        }
        let r = t.child(side, NS_A, "lnRef")?;
        let idx = num(t.node(r).attr("idx"))? as usize;
        let ph = color::read_child(t, r, &self.colors, None);
        let l = *self.theme.line_styles.get(idx.checked_sub(1)?)?;
        let theme = self.theme.part.clone();
        self.stroke_from_ln(&theme, l, ph)
    }

    /// Fill from a table style section's `a:tcStyle`.
    fn table_style_fill(&mut self, style: &Part, tc_style: usize, bounds: Rect) -> Option<Paint> {
        let t = &style.tree;
        if let Some(r) = t.child(tc_style, NS_A, "fillRef") {
            let idx = num(t.node(r).attr("idx"))? as usize;
            let ph = color::read_child(t, r, &self.colors, None);
            let f = *self.theme.fill_styles.get(idx.checked_sub(1)?)?;
            let theme = self.theme.part.clone();
            return self.paint_from_fill(&theme, f, ph, bounds, None).ok().flatten();
        }
        let fill = t.child(tc_style, NS_A, "fill")?;
        let f = *t.node(fill).children.first()?;
        self.paint_from_fill(style, f, None, bounds, None).ok().flatten()
    }

    pub(super) fn table(&mut self, part: &Arc<Part>, frame: usize, id: u32, base: Affine) {
        let t = &part.tree;
        let Some(xfrm) = t.child(frame, part.ns, "xfrm").and_then(|x| read_xfrm(t, x)) else { return };
        let Some(tbl) = t.path(frame, &[(NS_A, "graphic"), (NS_A, "graphicData"), (NS_A, "tbl")]) else { return };
        let tbl_pr = t.child(tbl, NS_A, "tblPr");
        let on = |k: &str| tbl_pr.is_some_and(|n| t.node(n).attr(k) == Some("1"));
        let flags = Flags {
            first_row: on("firstRow"),
            last_row: on("lastRow"),
            first_col: on("firstCol"),
            last_col: on("lastCol"),
            band_row: on("bandRow"),
            band_col: on("bandCol"),
        };
        let style = tbl_pr
            .and_then(|n| t.child(n, NS_A, "tableStyleId"))
            .and_then(|n| t.text(&part.src, n).ok())
            .and_then(|sid| {
                let found = self.table_style(sid.trim());
                if found.is_none() {
                    self.diag(Some(id), "table", format!("table style {} is not in the file; drawn without it", sid.trim()));
                }
                found
            });
        let widths: Vec<f64> = t
            .child(tbl, NS_A, "tblGrid")
            .map(|g| t.children_named(g, NS_A, "gridCol").map(|c| num(t.node(c).attr("w")).unwrap_or(0.0) / EMU_PER_PT).collect())
            .unwrap_or_default();
        let rows: Vec<usize> = t.children_named(tbl, NS_A, "tr").collect();
        let (nrows, ncols) = (rows.len(), widths.len());
        if nrows == 0 || ncols == 0 {
            return;
        }
        let mut heights: Vec<f64> = rows.iter().map(|&r| num(t.node(r).attr("h")).unwrap_or(0.0) / EMU_PER_PT).collect();

        // Origin cells (not covered by a merge).
        let mut cells = Vec::new();
        for (ri, &r) in rows.iter().enumerate() {
            for (ci, tc) in t.children_named(r, NS_A, "tc").enumerate().take(ncols) {
                let n = t.node(tc);
                if n.attr("hMerge") == Some("1") || n.attr("vMerge") == Some("1") {
                    continue;
                }
                let span = |k: &str| num(n.attr(k)).map(|v| v.max(1.0) as usize).unwrap_or(1);
                cells.push(Cell { node: tc, row: ri, col: ci, rows: span("rowSpan").min(nrows - ri), cols: span("gridSpan").min(ncols - ci) });
            }
        }

        // Cell text takes the presentation's default text style, then the
        // master's style for text outside placeholders (measured: a cell
        // with no size is drawn at the master's otherStyle 18 pt, not the
        // default text style's 14 pt).
        let mut sources: Vec<StyleSource> = self
            .pres_part
            .tree
            .child(self.pres_part.tree.root, NS_P, "defaultTextStyle")
            .map(|n| StyleSource { part: self.pres_part.clone(), node: n })
            .into_iter()
            .collect();
        if let Some(n) = self.master.tree.path(self.master.tree.root, &[(NS_P, "txStyles"), (NS_P, "otherStyle")]) {
            sources.push(StyleSource { part: self.master.clone(), node: n });
        }

        // Text of each cell, with the style's text formatting and margins.
        struct Laid {
            cell: usize,
            body: BodyProps,
            paragraphs: Vec<text::Paragraph>,
        }
        let mut laid = Vec::new();
        for (k, cell) in cells.iter().enumerate() {
            let tc_pr = t.child(cell.node, NS_A, "tcPr");
            let mut body = BodyProps { insets: [7.2, 3.6, 7.2, 3.6], ..BodyProps::default() };
            if let Some(pr) = tc_pr {
                let n = t.node(pr);
                for (i, key) in ["marL", "marT", "marR", "marB"].iter().enumerate() {
                    if let Some(v) = num(n.attr(key)) {
                        body.insets[i] = v / EMU_PER_PT;
                    }
                }
                if let Some(a) = n.attr("anchor") {
                    body.anchor = a.to_owned();
                }
                if let Some(v) = n.attr("vert") {
                    body.vert = v.to_owned();
                }
            }
            let mut overlay = RunProps::default();
            if let Some((sp, sn)) = &style {
                for sec in sections(&flags, cell.row, cell.col, nrows, ncols) {
                    let Some(tx) = sp.tree.child(*sn, NS_A, sec).and_then(|s| sp.tree.child(s, NS_A, "tcTxStyle")) else { continue };
                    let tn = sp.tree.node(tx);
                    if let Some(b) = tn.attr("b") {
                        overlay.bold = Some(b == "on");
                    }
                    // The style's font (fontRef to the theme, or an explicit
                    // font) wins over the presentation's default text style.
                    if let Some(f) = sp.tree.child(tx, NS_A, "fontRef").and_then(|f| sp.tree.node(f).attr("idx")) {
                        let k = if f == "major" { "mj" } else { "mn" };
                        overlay.latin = Some(format!("+{k}-lt"));
                        overlay.ea = Some(format!("+{k}-ea"));
                    }
                    if let Some(font) = sp.tree.child(tx, NS_A, "font") {
                        let face = |n: &str| sp.tree.child(font, NS_A, n).and_then(|x| sp.tree.node(x).attr("typeface")).filter(|v| !v.is_empty()).map(str::to_owned);
                        overlay.latin = face("latin").or(overlay.latin.take());
                        overlay.ea = face("ea").or(overlay.ea.take());
                    }
                    if let Some(c) = tn.children.iter().find_map(|&c| color::read(&sp.tree, c, &self.colors, None)) {
                        overlay.color = Some(c);
                    } else if let Some(c) = sp.tree.child(tx, NS_A, "fontRef").and_then(|f| color::read_child(&sp.tree, f, &self.colors, None)) {
                        overlay.color = Some(c);
                    }
                }
            }
            let mut cell_sources = sources.clone();
            if let Some(ls) = t.child(cell.node, NS_A, "txBody").and_then(|b| t.child(b, NS_A, "lstStyle")) {
                cell_sources.push(StyleSource { part: part.clone(), node: ls });
            }
            let paragraphs = match t.child(cell.node, NS_A, "txBody") {
                Some(b) => self.paragraphs(part, b, &cell_sources, &overlay),
                None => Vec::new(),
            };
            laid.push(Laid { cell: k, body, paragraphs });
        }

        let col_x: Vec<f64> = std::iter::once(0.0).chain(widths.iter().scan(0.0, |acc, w| { *acc += w; Some(*acc) })).collect();
        let width_of = |c: &Cell| col_x[c.col + c.cols] - col_x[c.col];
        // Rows grow to fit single-row cells' text. Vertical text wraps at the
        // row's height instead (measured: the rows keep their height).
        for l in &laid {
            let c = &cells[l.cell];
            if c.rows != 1 || l.body.vert != "horz" {
                continue;
            }
            let lay = text::layout(&l.paragraphs, &l.body, width_of(c), heights[c.row], self.fonts, &self.theme.fonts);
            let need = lay.content_height + l.body.insets[1] + l.body.insets[3];
            if need > heights[c.row] + 0.01 {
                heights[c.row] = need;
            }
        }
        // Then a merged block that still lacks height grows its last row
        // (measured: single rows first, the rest on the block's last row).
        for l in &laid {
            let c = &cells[l.cell];
            if c.rows < 2 || l.body.vert != "horz" {
                continue;
            }
            let have: f64 = heights[c.row..c.row + c.rows].iter().sum();
            let lay = text::layout(&l.paragraphs, &l.body, width_of(c), have, self.fonts, &self.theme.fonts);
            let need = lay.content_height + l.body.insets[1] + l.body.insets[3];
            if need > have + 0.01 {
                heights[c.row + c.rows - 1] += need - have;
            }
        }
        let row_y: Vec<f64> = std::iter::once(0.0).chain(heights.iter().scan(0.0, |acc, h| { *acc += h; Some(*acc) })).collect();
        let rect_of = |c: &Cell| Rect::new(col_x[c.col], row_y[c.row], col_x[c.col + c.cols], row_y[c.row + c.rows]);
        let transform = base * Affine::translate((xfrm.rect.x0, xfrm.rect.y0));

        // Fills.
        for c in &cells {
            let r = rect_of(c);
            let local = Rect::new(0.0, 0.0, r.width(), r.height());
            let explicit = t.child(c.node, NS_A, "tcPr").and_then(|pr| {
                t.node(pr).children.iter().copied().find(|&f| matches!(t.node(f).local.as_str(), "noFill" | "solidFill" | "gradFill" | "blipFill" | "pattFill"))
            });
            let fill = match explicit {
                Some(f) => self.paint_from_fill(part, f, None, local, Some(id)).ok().flatten(),
                None => style.clone().and_then(|(sp, sn)| {
                    sections(&flags, c.row, c.col, nrows, ncols)
                        .iter()
                        .rev()
                        .find_map(|sec| sp.tree.child(sn, NS_A, sec).and_then(|s| sp.tree.child(s, NS_A, "tcStyle")).filter(|ts| sp.tree.child(*ts, NS_A, "fill").is_some() || sp.tree.child(*ts, NS_A, "fillRef").is_some()))
                        .and_then(|ts| self.table_style_fill(&sp, ts, local))
                }),
            };
            if let Some(fill) = fill {
                self.out.scene.items.push(Item::Path { path: local.to_path(0.1), transform: transform * Affine::translate((r.x0, r.y0)), fill: Some(fill), stroke: None });
            }
        }

        // Text.
        for l in &laid {
            let c = &cells[l.cell];
            let r = rect_of(c);
            let mut body = l.body.clone();
            let (lw, lh, frame, _) = super::turn_vertical(&mut body, r.width(), r.height());
            let mut lay = text::layout(&l.paragraphs, &body, lw, lh, self.fonts, &self.theme.fonts);
            let cell_t = transform * Affine::translate((r.x0, r.y0));
            if body.vert == "eaVert" {
                self.emit_upright(&mut lay, cell_t * frame);
            }
            self.emit_text(&mut lay, cell_t * frame);
            for p in lay.provisional {
                if !self.out.provisional.contains(&p) {
                    self.out.provisional.push(p);
                }
            }
            let origin = cell_t * kurbo::Point::ZERO;
            self.out.texts.push(TextBoxInfo {
                shape_id: id,
                name: format!("table cell r{}c{}", c.row + 1, c.col + 1),
                frame: [origin.x, origin.y, r.width(), r.height()],
                lines: lay.lines,
                fonts: lay.fonts,
                // Rows grow to hold their text.
                overflow: 0.0,
                on_slide: false,
            });
        }

        // Borders: explicit cell lines, else the style's outer or inside lines.
        for c in &cells {
            let r = rect_of(c);
            let tc_pr = t.child(c.node, NS_A, "tcPr");
            let sides = [
                ("lnL", if c.col == 0 { "left" } else { "insideV" }, (r.x0, r.y0), (r.x0, r.y1)),
                ("lnR", if c.col + c.cols == ncols { "right" } else { "insideV" }, (r.x1, r.y0), (r.x1, r.y1)),
                ("lnT", if c.row == 0 { "top" } else { "insideH" }, (r.x0, r.y0), (r.x1, r.y0)),
                ("lnB", if c.row + c.rows == nrows { "bottom" } else { "insideH" }, (r.x0, r.y1), (r.x1, r.y1)),
            ];
            for (own, style_side, a, b) in sides {
                let stroke = match tc_pr.and_then(|pr| t.child(pr, NS_A, own)) {
                    Some(ln) => self.stroke_from_ln(part, ln, None),
                    None => style.clone().and_then(|(sp, sn)| {
                        sections(&flags, c.row, c.col, nrows, ncols)
                            .iter()
                            .rev()
                            .find_map(|sec| sp.tree.path(sn, &[(NS_A, sec), (NS_A, "tcStyle"), (NS_A, "tcBdr"), (NS_A, style_side)]))
                            .and_then(|side| self.style_border(&sp, side))
                    }),
                };
                if let Some(s) = stroke {
                    let mut path = BezPath::new();
                    path.move_to(a);
                    path.line_to(b);
                    self.out.scene.items.push(Item::Path { path, transform, fill: None, stroke: Some(s) });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::xml::{Tree, NS_A};

    #[test]
    fn default_table_style_parses() {
        let src = include_str!("../../data/defaultTableStyle.xml");
        let tree = Tree::parse(src.as_bytes()).unwrap();
        let found = tree.children_named(tree.root, NS_A, "tblStyle").find(|&s| tree.node(s).attr("styleId") == Some("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"));
        assert!(found.is_some());
    }
}
