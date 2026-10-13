//! Table commands: cell text and format, row height, column width, rows and
//! columns in and out, merging, and new tables. Rows and columns count
//! from 0. Copied rows, columns and cells keep their formatting but start
//! empty; their co-authoring ids (`a16:rowId`, `a16:colId`) are dropped.

use serde_json::{json, Value};

use super::shape::{commit, parse_color, target, Target};
use super::xmledit::{drawing_prefix, escape_attr, rebuild, start_tag, Change};
use super::{paragraph_edits, EMU_PER_PT};
use crate::xml::{escape_text, splice, Tree, NS_A, NS_P};
use crate::{Error, Presentation};

type Edit = (std::ops::Range<usize>, Vec<u8>);

/// Children of `a:tcPr` in schema order.
const TCPR_ORDER: &[&str] = &["lnL", "lnR", "lnT", "lnB", "lnTlToBr", "lnBlToTr", "cell3D", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "headers", "extLst"];
const FILLS: &[&str] = &["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
const DEFAULT_STYLE: &str = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

/// The table of a graphic frame, as node indexes.
struct Grid {
    frame_ext: usize,
    cols: Vec<usize>,
    rows: Vec<usize>,
    /// `a:tc` nodes per row.
    cells: Vec<Vec<usize>>,
}

/// A merged block: origin row/column and its extent.
#[derive(Debug, Clone, Copy)]
struct Merge {
    row: usize,
    col: usize,
    rows: usize,
    cols: usize,
}

impl Grid {
    fn of(t: &Target) -> Result<Self, Error> {
        if t.tree.node(t.shape).local != "graphicFrame" {
            return Err(Error::InvalidCommand("shape is not a table".into()));
        }
        let tbl = t.tree.path(t.shape, &[(NS_A, "graphic"), (NS_A, "graphicData"), (NS_A, "tbl")]).ok_or_else(|| Error::InvalidCommand("graphic frame is not a table".into()))?;
        let frame_ext = t.tree.path(t.shape, &[(NS_P, "xfrm"), (NS_A, "ext")]).ok_or_else(|| Error::Xml("table frame without size".into()))?;
        let grid = t.tree.child(tbl, NS_A, "tblGrid").ok_or_else(|| Error::Xml("table without tblGrid".into()))?;
        let cols: Vec<usize> = t.tree.children_named(grid, NS_A, "gridCol").collect();
        let rows: Vec<usize> = t.tree.children_named(tbl, NS_A, "tr").collect();
        let cells: Vec<Vec<usize>> = rows.iter().map(|&r| t.tree.children_named(r, NS_A, "tc").collect()).collect();
        if cells.iter().any(|r| r.len() != cols.len()) {
            return Err(Error::Unsupported("table rows do not match its grid".into()));
        }
        Ok(Self { frame_ext, cols, rows, cells })
    }

    fn cell(&self, row: usize, col: usize) -> Result<usize, Error> {
        self.cells.get(row).and_then(|r| r.get(col)).copied().ok_or_else(|| Error::NotFound(format!("cell ({row}, {col}) in a {}x{} table", self.rows.len(), self.cols.len())))
    }

    /// Every merged block of the table.
    fn merges(&self, tree: &Tree) -> Vec<Merge> {
        let mut out = Vec::new();
        for (r, row) in self.cells.iter().enumerate() {
            for (c, &tc) in row.iter().enumerate() {
                let n = tree.node(tc);
                if n.attr("hMerge") == Some("1") || n.attr("vMerge") == Some("1") {
                    continue;
                }
                let span = |k: &str| n.attr(k).and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
                let (rows, cols) = (span("rowSpan"), span("gridSpan"));
                if rows > 1 || cols > 1 {
                    out.push(Merge { row: r, col: c, rows, cols });
                }
            }
        }
        out
    }

    fn emu_attr(tree: &Tree, node: usize, attr: &str) -> i64 {
        tree.node(node).attr(attr).and_then(|v| v.parse().ok()).unwrap_or(0)
    }
}

fn result(op: &str, t: &Target, slide: usize, id: u32) -> Value {
    json!({ "op": op, "part": t.part, "slide": slide, "shapeId": id, "changed": true })
}

/// The frame's `a:ext` with the given width and height.
fn frame_size(t: &Target, g: &Grid, cx: i64, cy: i64) -> Result<Edit, Error> {
    let n = t.tree.node(g.frame_ext);
    let change = Change { attrs: vec![("cx", Some(cx.to_string())), ("cy", Some(cy.to_string()))], ..Default::default() };
    Ok((n.start..n.end, rebuild(&t.src, &t.tree, g.frame_ext, &change)?))
}

/// Element bytes with the listed descendant ranges removed or replaced.
fn element_with(src: &[u8], node: &crate::xml::Node, mut edits: Vec<Edit>) -> Result<Vec<u8>, Error> {
    for e in edits.iter_mut() {
        e.0 = (e.0.start - node.start)..(e.0.end - node.start);
    }
    splice(&src[node.start..node.end], edits).map_err(Error::from)
}

/// A cell's bytes with its text emptied (formatting kept), merge attributes
/// set to `merge`, and its extension list dropped.
fn empty_cell(t: &Target, tc: usize, merge: &[(&str, Option<String>)]) -> Result<Vec<u8>, Error> {
    let tree = &t.tree;
    let n = tree.node(tc);
    let mut edits: Vec<Edit> = vec![(n.start..n.open_end, start_tag(&t.src, tree, tc, merge, false)?)];
    if let Some(body) = tree.child(tc, NS_A, "txBody") {
        edits.extend(paragraph_edits(tree, &t.src, body, &[String::new()])?);
    }
    if let Some(ext) = tree.child(tc, NS_A, "extLst") {
        edits.push((tree.node(ext).start..tree.node(ext).end, Vec::new()));
    }
    if n.is_empty_element() {
        return Err(Error::Xml("empty a:tc".into()));
    }
    edits.sort_by_key(|e| e.0.start);
    element_with(&t.src, n, edits)
}

/// Removes an element's `a:extLst` child (co-authoring ids) from a copy.
fn without_ext(t: &Target, node: usize) -> Result<Vec<u8>, Error> {
    let n = t.tree.node(node);
    let edits: Vec<Edit> = t.tree.child(node, NS_A, "extLst").map(|e| (t.tree.node(e).start..t.tree.node(e).end, Vec::new())).into_iter().collect();
    element_with(&t.src, n, edits)
}

fn merge_attrs(h: bool, v: bool, span: Option<usize>) -> Vec<(&'static str, Option<String>)> {
    vec![
        ("gridSpan", span.filter(|&s| s > 1).map(|s| s.to_string())),
        ("rowSpan", None),
        ("hMerge", h.then(|| "1".to_owned())),
        ("vMerge", v.then(|| "1".to_owned())),
    ]
}

pub fn set_table_cell(doc: &mut Presentation, slide: usize, id: u32, row: usize, col: usize, paragraphs: &[String]) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let tc = g.cell(row, col)?;
    let n = t.tree.node(tc);
    if n.attr("hMerge") == Some("1") || n.attr("vMerge") == Some("1") {
        return Err(Error::InvalidCommand("cell is covered by a merge; write to the merged block's first cell".into()));
    }
    let body = t.tree.child(tc, NS_A, "txBody").ok_or_else(|| Error::Unsupported("cell without text body".into()))?;
    let wanted: Vec<String> = if paragraphs.is_empty() { vec![String::new()] } else { paragraphs.to_vec() };
    let edits = paragraph_edits(&t.tree, &t.src, body, &wanted)?;
    commit(doc, &t, edits)?;
    Ok(result("set_table_cell", &t, slide, id))
}

/// Fill, borders, vertical alignment and margins of one cell.
#[allow(clippy::too_many_arguments)]
pub fn set_table_cell_format(doc: &mut Presentation, slide: usize, id: u32, row: usize, col: usize, fill: Option<&str>, border_color: Option<&str>, border_width: Option<f64>, anchor: Option<&str>, margins: Option<[f64; 4]>) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let tc = g.cell(row, col)?;
    let a = drawing_prefix(&t.tree)?;
    let mut change = Change { order: TCPR_ORDER, ..Default::default() };
    if let Some(f) = fill {
        change.remove.extend(FILLS);
        let xml = if f == "none" { format!("<{a}noFill/>") } else { format!(r#"<{a}solidFill><{a}srgbClr val="{}"/></{a}solidFill>"#, parse_color(f)?) };
        change.insert.push((if f == "none" { "noFill" } else { "solidFill" }, xml.into_bytes()));
    }
    if border_color.is_some() || border_width.is_some() {
        let w = border_width.unwrap_or(1.0);
        if !(0.0..=1584.0).contains(&w) {
            return Err(Error::InvalidCommand("border width must be 0 to 1584 pt".into()));
        }
        let color = border_color.map(parse_color).transpose()?.unwrap_or_else(|| "000000".into());
        for side in ["lnL", "lnR", "lnT", "lnB"] {
            change.remove.push(side);
            change.insert.push((side, format!(r#"<{a}{side} w="{}"><{a}solidFill><{a}srgbClr val="{color}"/></{a}solidFill></{a}{side}>"#, (w * EMU_PER_PT).round() as i64).into_bytes()));
        }
    }
    if let Some(an) = anchor {
        let v = match an {
            "top" => "t",
            "middle" => "ctr",
            "bottom" => "b",
            other => return Err(Error::InvalidCommand(format!("anchor must be top, middle or bottom, got {other:?}"))),
        };
        change.attrs.push(("anchor", Some(v.to_owned())));
    }
    if let Some(m) = margins {
        if m.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1584.0) {
            return Err(Error::InvalidCommand("margins must be 0 to 1584 pt".into()));
        }
        for (k, v) in ["marL", "marT", "marR", "marB"].iter().zip(m) {
            change.attrs.push((k, Some(((v * EMU_PER_PT).round() as i64).to_string())));
        }
    }
    if change.attrs.is_empty() && change.insert.is_empty() {
        return Err(Error::InvalidCommand("set_table_cell_format needs fill, borders, anchor or margins".into()));
    }
    let edit = match t.tree.child(tc, NS_A, "tcPr") {
        Some(pr) => (t.tree.node(pr).start..t.tree.node(pr).end, rebuild(&t.src, &t.tree, pr, &change)?),
        None => {
            let pr = super::format::new_props(&a, "tcPr", &change);
            (t.tree.node(tc).start..t.tree.node(tc).end, rebuild(&t.src, &t.tree, tc, &Change { insert: vec![("tcPr", pr)], order: &["txBody", "tcPr", "extLst"], ..Default::default() })?)
        }
    };
    commit(doc, &t, vec![edit])?;
    Ok(result("set_table_cell_format", &t, slide, id))
}

pub fn set_table_row_height(doc: &mut Presentation, slide: usize, id: u32, row: usize, height: f64) -> Result<Value, Error> {
    if !(height.is_finite() && height > 0.0 && height <= 4000.0) {
        return Err(Error::InvalidCommand("row height must be above 0 and at most 4000 pt".into()));
    }
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let tr = *g.rows.get(row).ok_or_else(|| Error::NotFound(format!("row {row}")))?;
    let h = (height * EMU_PER_PT).round() as i64;
    let total: i64 = g.rows.iter().enumerate().map(|(k, &r)| if k == row { h } else { Grid::emu_attr(&t.tree, r, "h") }).sum();
    let cx: i64 = g.cols.iter().map(|&c| Grid::emu_attr(&t.tree, c, "w")).sum();
    let n = t.tree.node(tr);
    let edits = vec![(n.start..n.open_end, start_tag(&t.src, &t.tree, tr, &[("h", Some(h.to_string()))], n.is_empty_element())?), frame_size(&t, &g, cx, total)?];
    commit(doc, &t, edits)?;
    Ok(result("set_table_row_height", &t, slide, id))
}

pub fn set_table_column_width(doc: &mut Presentation, slide: usize, id: u32, col: usize, width: f64) -> Result<Value, Error> {
    if !(width.is_finite() && width > 0.0 && width <= 4000.0) {
        return Err(Error::InvalidCommand("column width must be above 0 and at most 4000 pt".into()));
    }
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let gc = *g.cols.get(col).ok_or_else(|| Error::NotFound(format!("column {col}")))?;
    let w = (width * EMU_PER_PT).round() as i64;
    let cx: i64 = g.cols.iter().enumerate().map(|(k, &c)| if k == col { w } else { Grid::emu_attr(&t.tree, c, "w") }).sum();
    let cy: i64 = g.rows.iter().map(|&r| Grid::emu_attr(&t.tree, r, "h")).sum();
    let n = t.tree.node(gc);
    let edits = vec![(n.start..n.open_end, start_tag(&t.src, &t.tree, gc, &[("w", Some(w.to_string()))], n.is_empty_element())?), frame_size(&t, &g, cx, cy)?];
    commit(doc, &t, edits)?;
    Ok(result("set_table_column_width", &t, slide, id))
}

/// Inserts `count` empty rows before row `at` (`at` = row count appends),
/// formatted like the row above (or below, at the top).
pub fn insert_table_rows(doc: &mut Presentation, slide: usize, id: u32, at: usize, count: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    if at > g.rows.len() || count == 0 || count > 1000 {
        return Err(Error::InvalidCommand(format!("insert position 0..={} and a count of 1 to 1000", g.rows.len())));
    }
    let template = if at > 0 { at - 1 } else { 0 };
    let merges = g.merges(&t.tree);
    let mut edits: Vec<Edit> = Vec::new();
    // A merge that the new rows land inside grows by them.
    let inside: Vec<Merge> = merges.iter().copied().filter(|m| m.row < at && at < m.row + m.rows).collect();
    for m in &inside {
        let tc = g.cells[m.row][m.col];
        let n = t.tree.node(tc);
        edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &[("rowSpan", Some((m.rows + count).to_string()))], false)?));
    }
    let tr = t.tree.node(g.rows[template]);
    let mut row_bytes = Vec::new();
    let tr_head = start_tag(&t.src, &t.tree, g.rows[template], &[], false)?;
    row_bytes.extend(tr_head);
    for (c, &tc) in g.cells[template].iter().enumerate() {
        let covering = inside.iter().find(|m| m.col <= c && c < m.col + m.cols);
        let attrs = match covering {
            Some(m) => merge_attrs(c > m.col, true, (c == m.col).then_some(m.cols)),
            None => {
                // Keep a horizontal merge of the template row.
                let n = t.tree.node(tc);
                let span = n.attr("gridSpan").and_then(|v| v.parse::<usize>().ok());
                merge_attrs(n.attr("hMerge") == Some("1"), false, span)
            }
        };
        row_bytes.extend(empty_cell(&t, tc, &attrs)?);
    }
    row_bytes.extend(format!("</{}>", tr.qname).into_bytes());
    let insert_at = if at < g.rows.len() { t.tree.node(g.rows[at]).start } else { t.tree.node(*g.rows.last().expect("non-empty")).end };
    edits.push((insert_at..insert_at, row_bytes.repeat(count)));
    let h = Grid::emu_attr(&t.tree, g.rows[template], "h");
    let cy: i64 = g.rows.iter().map(|&r| Grid::emu_attr(&t.tree, r, "h")).sum::<i64>() + h * count as i64;
    let cx: i64 = g.cols.iter().map(|&c| Grid::emu_attr(&t.tree, c, "w")).sum();
    edits.push(frame_size(&t, &g, cx, cy)?);
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    Ok(result("insert_table_rows", &t, slide, id))
}

/// Deletes rows `at .. at + count`. Refused when that would cut a merged
/// block's first row away from the rest of the block.
pub fn delete_table_rows(doc: &mut Presentation, slide: usize, id: u32, at: usize, count: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let end = at.checked_add(count).filter(|&e| count > 0 && e <= g.rows.len()).ok_or_else(|| Error::InvalidCommand("rows out of range".into()))?;
    if end - at == g.rows.len() {
        return Err(Error::InvalidCommand("a table keeps at least one row; delete the table instead".into()));
    }
    let mut edits: Vec<Edit> = Vec::new();
    for m in g.merges(&t.tree).into_iter().filter(|m| m.rows > 1) {
        let last = m.row + m.rows;
        let overlap = last.min(end).saturating_sub(m.row.max(at));
        if overlap == 0 || (m.row >= at && last <= end) {
            continue;
        }
        if m.row >= at {
            return Err(Error::Unsupported("deleting the first row of a merged block; split it first".into()));
        }
        let tc = g.cells[m.row][m.col];
        let n = t.tree.node(tc);
        let rows = m.rows - overlap;
        edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &[("rowSpan", (rows > 1).then(|| rows.to_string()))], false)?));
    }
    let (first, last) = (t.tree.node(g.rows[at]), t.tree.node(g.rows[end - 1]));
    edits.push((first.start..last.end, Vec::new()));
    let cy: i64 = g.rows.iter().enumerate().filter(|(k, _)| *k < at || *k >= end).map(|(_, &r)| Grid::emu_attr(&t.tree, r, "h")).sum();
    let cx: i64 = g.cols.iter().map(|&c| Grid::emu_attr(&t.tree, c, "w")).sum();
    edits.push(frame_size(&t, &g, cx, cy)?);
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    Ok(result("delete_table_rows", &t, slide, id))
}

/// Inserts `count` empty columns before column `at` (column count appends),
/// as wide and formatted as the column to their left (or right, at the start).
pub fn insert_table_columns(doc: &mut Presentation, slide: usize, id: u32, at: usize, count: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    if at > g.cols.len() || count == 0 || count > 1000 {
        return Err(Error::InvalidCommand(format!("insert position 0..={} and a count of 1 to 1000", g.cols.len())));
    }
    let template = if at > 0 { at - 1 } else { 0 };
    let merges = g.merges(&t.tree);
    let inside: Vec<Merge> = merges.iter().copied().filter(|m| m.col < at && at < m.col + m.cols).collect();
    let mut edits: Vec<Edit> = Vec::new();
    for m in &inside {
        let tc = g.cells[m.row][m.col];
        let n = t.tree.node(tc);
        edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &[("gridSpan", Some((m.cols + count).to_string()))], false)?));
    }
    let col_bytes = without_ext(&t, g.cols[template])?;
    let col_at = if at < g.cols.len() { t.tree.node(g.cols[at]).start } else { t.tree.node(*g.cols.last().expect("non-empty")).end };
    edits.push((col_at..col_at, col_bytes.repeat(count)));
    for (r, row) in g.cells.iter().enumerate() {
        let covering = inside.iter().find(|m| m.row <= r && r < m.row + m.rows);
        let tc = row[template];
        let attrs = match covering {
            Some(m) => merge_attrs(true, r > m.row, None),
            None => {
                let n = t.tree.node(tc);
                merge_attrs(false, n.attr("vMerge") == Some("1"), None)
            }
        };
        let cell = empty_cell(&t, tc, &attrs)?;
        let pos = if at < row.len() { t.tree.node(row[at]).start } else { t.tree.node(*row.last().expect("non-empty")).end };
        edits.push((pos..pos, cell.repeat(count)));
    }
    let w = Grid::emu_attr(&t.tree, g.cols[template], "w");
    let cx: i64 = g.cols.iter().map(|&c| Grid::emu_attr(&t.tree, c, "w")).sum::<i64>() + w * count as i64;
    let cy: i64 = g.rows.iter().map(|&r| Grid::emu_attr(&t.tree, r, "h")).sum();
    edits.push(frame_size(&t, &g, cx, cy)?);
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    Ok(result("insert_table_columns", &t, slide, id))
}

/// Deletes columns `at .. at + count`. Refused when that would cut a merged
/// block's first column away from the rest of the block.
pub fn delete_table_columns(doc: &mut Presentation, slide: usize, id: u32, at: usize, count: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let end = at.checked_add(count).filter(|&e| count > 0 && e <= g.cols.len()).ok_or_else(|| Error::InvalidCommand("columns out of range".into()))?;
    if end - at == g.cols.len() {
        return Err(Error::InvalidCommand("a table keeps at least one column; delete the table instead".into()));
    }
    let mut edits: Vec<Edit> = Vec::new();
    for m in g.merges(&t.tree).into_iter().filter(|m| m.cols > 1) {
        let last = m.col + m.cols;
        let overlap = last.min(end).saturating_sub(m.col.max(at));
        if overlap == 0 || (m.col >= at && last <= end) {
            continue;
        }
        if m.col >= at {
            return Err(Error::Unsupported("deleting the first column of a merged block; split it first".into()));
        }
        // The block's first column carries gridSpan in every row it covers.
        for r in m.row..m.row + m.rows {
            let tc = g.cells[r][m.col];
            let n = t.tree.node(tc);
            let cols = m.cols - overlap;
            edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &[("gridSpan", (cols > 1).then(|| cols.to_string()))], false)?));
        }
    }
    let (first, last) = (t.tree.node(g.cols[at]), t.tree.node(g.cols[end - 1]));
    edits.push((first.start..last.end, Vec::new()));
    for row in &g.cells {
        let (a, b) = (t.tree.node(row[at]), t.tree.node(row[end - 1]));
        edits.push((a.start..b.end, Vec::new()));
    }
    let cx: i64 = g.cols.iter().enumerate().filter(|(k, _)| *k < at || *k >= end).map(|(_, &c)| Grid::emu_attr(&t.tree, c, "w")).sum();
    let cy: i64 = g.rows.iter().map(|&r| Grid::emu_attr(&t.tree, r, "h")).sum();
    edits.push(frame_size(&t, &g, cx, cy)?);
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    Ok(result("delete_table_columns", &t, slide, id))
}

/// Merges the block of `rows` x `cols` cells from (`row`, `col`). Text of
/// the other cells moves into the first cell as further paragraphs.
pub fn merge_table_cells(doc: &mut Presentation, slide: usize, id: u32, row: usize, col: usize, rows: usize, cols: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    if rows == 0 || cols == 0 || rows * cols < 2 || row + rows > g.rows.len() || col + cols > g.cols.len() {
        return Err(Error::InvalidCommand("merge block must be at least two cells inside the table".into()));
    }
    let blocked = |r: usize, c: usize| {
        let n = t.tree.node(g.cells[r][c]);
        let span = |k: &str| n.attr(k).and_then(|v| v.parse::<usize>().ok()).unwrap_or(1) > 1;
        let covered = |k: &str| n.attr(k) == Some("1");
        span("gridSpan") || span("rowSpan") || covered("hMerge") || covered("vMerge")
    };
    if (row..row + rows).any(|r| (col..col + cols).any(|c| blocked(r, c))) {
        return Err(Error::Unsupported("block overlaps merged cells; split them first".into()));
    }
    let mut edits: Vec<Edit> = Vec::new();
    let mut moved = Vec::new();
    for r in row..row + rows {
        for c in col..col + cols {
            let tc = g.cells[r][c];
            let n = t.tree.node(tc);
            if r == row && c == col {
                let attrs = [("gridSpan", (cols > 1).then(|| cols.to_string())), ("rowSpan", (rows > 1).then(|| rows.to_string()))];
                edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &attrs, false)?));
                continue;
            }
            // Non-empty paragraphs move to the first cell.
            if let Some(body) = t.tree.child(tc, NS_A, "txBody") {
                let texts = crate::paragraph_texts(&t.tree, &t.src, body)?;
                for (p, text) in t.tree.children_named(body, NS_A, "p").zip(texts) {
                    if !text.is_empty() {
                        moved.extend_from_slice(&t.src[t.tree.node(p).start..t.tree.node(p).end]);
                    }
                }
            }
            let attrs = merge_attrs(c > col, r > row, (c == col && r > row).then_some(cols));
            edits.push((n.start..n.end, empty_cell(&t, tc, &attrs)?));
        }
    }
    if !moved.is_empty() {
        let origin = g.cells[row][col];
        let body = t.tree.child(origin, NS_A, "txBody").ok_or_else(|| Error::Unsupported("cell without text body".into()))?;
        let last_p = t.tree.children_named(body, NS_A, "p").last().ok_or_else(|| Error::Xml("cell text without a paragraph".into()))?;
        let at = t.tree.node(last_p).end;
        edits.push((at..at, moved));
    }
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    Ok(result("merge_table_cells", &t, slide, id))
}

/// Undoes the merge whose first cell is (`row`, `col`); the covered cells
/// become separate empty cells.
pub fn split_table_cell(doc: &mut Presentation, slide: usize, id: u32, row: usize, col: usize) -> Result<Value, Error> {
    let t = target(doc, slide, id)?;
    let g = Grid::of(&t)?;
    let m = g.merges(&t.tree).into_iter().find(|m| m.row == row && m.col == col).ok_or_else(|| Error::InvalidCommand(format!("cell ({row}, {col}) is not the first cell of a merged block")))?;
    let mut edits = Vec::new();
    for r in m.row..m.row + m.rows {
        for c in m.col..m.col + m.cols {
            let tc = g.cells[r][c];
            let n = t.tree.node(tc);
            let attrs = [("gridSpan", None), ("rowSpan", None), ("hMerge", None), ("vMerge", None)];
            edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, tc, &attrs, false)?));
        }
    }
    commit(doc, &t, edits)?;
    Ok(result("split_table_cell", &t, slide, id))
}

/// A new table in PowerPoint's default style (Medium Style 2, Accent 1,
/// header row and banded rows), with optional cell texts by row.
#[allow(clippy::too_many_arguments)]
pub fn add_table(doc: &mut Presentation, slide: usize, x: f64, y: f64, width: f64, height: f64, rows: usize, cols: usize, cells: &[Vec<String>]) -> Result<Value, Error> {
    if !(1..=200).contains(&rows) || !(1..=100).contains(&cols) {
        return Err(Error::InvalidCommand("1 to 200 rows and 1 to 100 columns".into()));
    }
    if [x, y, width, height].iter().any(|v| !v.is_finite()) || width <= 0.0 || height <= 0.0 {
        return Err(Error::InvalidCommand("position and positive size in points".into()));
    }
    for text in cells.iter().flatten() {
        if text.chars().any(|c| c.is_control() && c != '\t') {
            return Err(Error::InvalidCommand("cell text contains control characters".into()));
        }
    }
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let (cw, rh) = (e(width / cols as f64), e(height / rows as f64));
    let id = super::create::append_shape(doc, slide, |id, p, a| {
        let grid: String = (0..cols).map(|_| format!(r#"<{a}gridCol w="{cw}"/>"#)).collect();
        let mut body = String::new();
        for r in 0..rows {
            body.push_str(&format!(r#"<{a}tr h="{rh}">"#));
            for c in 0..cols {
                let text = cells.get(r).and_then(|row| row.get(c)).map(String::as_str).unwrap_or("");
                let para = if text.is_empty() {
                    format!(r#"<{a}p><{a}endParaRPr lang="ko-KR" altLang="en-US"/></{a}p>"#)
                } else {
                    format!(r#"<{a}p><{a}r><{a}rPr lang="ko-KR" altLang="en-US"/><{a}t>{}</{a}t></{a}r></{a}p>"#, escape_text(text))
                };
                body.push_str(&format!("<{a}tc><{a}txBody><{a}bodyPr/><{a}lstStyle/>{para}</{a}txBody><{a}tcPr/></{a}tc>"));
            }
            body.push_str(&format!("</{a}tr>"));
        }
        format!(
            r#"<{p}graphicFrame><{p}nvGraphicFramePr><{p}cNvPr id="{id}" name="Table {}"/><{p}cNvGraphicFramePr><{a}graphicFrameLocks noGrp="1"/></{p}cNvGraphicFramePr><{p}nvPr/></{p}nvGraphicFramePr><{p}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{p}xfrm><{a}graphic><{a}graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><{a}tbl><{a}tblPr firstRow="1" bandRow="1"><{a}tableStyleId>{}</{a}tableStyleId></{a}tblPr><{a}tblGrid>{grid}</{a}tblGrid>{body}</{a}tbl></{a}graphicData></{a}graphic></{p}graphicFrame>"#,
            id - 1,
            e(x),
            e(y),
            cw * cols as i64,
            rh * rows as i64,
            escape_attr(DEFAULT_STYLE)
        )
    })?;
    Ok(json!({ "op": "add_table", "slide": slide, "shapeId": id, "changed": true }))
}
