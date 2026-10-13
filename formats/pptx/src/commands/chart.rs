//! Chart edits: data, type and format of a chart graphic frame.
//!
//! The chart part's cached values are what PowerPoint draws; the embedded
//! workbook is what its "Edit Data" opens. `set_chart_data` writes both so
//! they agree. Edits touch only the elements they change and keep the rest
//! of the chart part (styles, extensions) as it was.

use serde::Deserialize;
use serde_json::{json, Value};

use super::shape::target;
use crate::package::Package;
use crate::xml::{escape_text, splice, Tree, NS_A, NS_R};
use crate::{read_relationships, rels_part_for, Error, Presentation};

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";

/// Children of `c:ser` in schema order (bar, line and pie series together).
const SER_ORDER: &[&str] = &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker", "explosion", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "smooth", "shape", "extLst"];
/// Children of `c:chart` in schema order.
const CHART_ORDER: &[&str] = &["title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall", "plotArea", "legend", "plotVisOnly", "dispBlanksAs", "showDLblsOverMax", "extLst"];
/// Children of `c:valAx` in schema order.
const VAL_AX_ORDER: &[&str] = &["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title", "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx", "crosses", "crossesAt", "crossBetween", "majorUnit", "minorUnit", "dispUnits", "extLst"];
const GROUPS: &[&str] = &["barChart", "bar3DChart", "lineChart", "line3DChart", "pieChart", "pie3DChart", "doughnutChart", "areaChart", "area3DChart", "scatterChart", "radarChart", "bubbleChart", "stockChart", "surfaceChart", "surface3DChart", "ofPieChart"];

#[derive(Debug, Clone, PartialEq, serde::Serialize, Deserialize)]
pub struct SeriesData {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

/// The chart part of graphic frame `id`.
struct ChartPart {
    name: String,
    src: Vec<u8>,
    tree: Tree,
    /// The root's start tag, to parse fragments with its prefixes.
    root_tag: String,
}

fn chart_part(doc: &Presentation, slide: usize, id: u32) -> Result<ChartPart, Error> {
    let t = target(doc, slide, id)?;
    let tree = &t.tree;
    if tree.node(t.shape).local != "graphicFrame" {
        return Err(Error::InvalidCommand(format!("shape {id} is not a chart")));
    }
    let chart = tree.nodes.iter().enumerate().find(|(_, n)| n.ns.as_deref() == Some(NS_C) && n.local == "chart" && n.start >= tree.node(t.shape).start && n.end <= tree.node(t.shape).end).map(|(i, _)| i).ok_or_else(|| Error::InvalidCommand(format!("shape {id} is not a chart")))?;
    let rid = tree.node(chart).attr_ns(NS_R, "id").ok_or_else(|| Error::Xml("chart without r:id".into()))?;
    let name = read_relationships(doc.package(), &rels_part_for(&t.part), &t.part)?.into_iter().find(|r| r.id == rid).map(|r| r.target).ok_or_else(|| Error::NotFound(format!("chart part {rid}")))?;
    let src = doc.package().read(&name)?.to_vec();
    let tree = Tree::parse(&src)?;
    let root = tree.node(tree.root);
    if root.prefix() != "c:" || tree.nodes.iter().any(|n| n.ns.as_deref() == Some(NS_A) && n.prefix() != "a:") {
        return Err(Error::Unsupported("chart markup without the usual c: and a: prefixes".into()));
    }
    let root_tag = String::from_utf8_lossy(&src[root.start..root.open_end]).into_owned();
    Ok(ChartPart { name, src, tree, root_tag })
}

impl ChartPart {
    fn text(&self, n: usize) -> &str {
        let n = self.tree.node(n);
        std::str::from_utf8(&self.src[n.start..n.end]).unwrap_or("")
    }

    fn plot(&self) -> Result<usize, Error> {
        self.tree.path(self.tree.root, &[(NS_C, "chart"), (NS_C, "plotArea")]).ok_or_else(|| Error::Xml("chart without plotArea".into()))
    }

    /// The chart's only chart group (combination charts are refused).
    fn group(&self) -> Result<usize, Error> {
        let plot = self.plot()?;
        let groups: Vec<usize> = self.tree.node(plot).children.iter().copied().filter(|&c| self.tree.node(c).ns.as_deref() == Some(NS_C) && GROUPS.contains(&self.tree.node(c).local.as_str())).collect();
        match groups.as_slice() {
            [g] => Ok(*g),
            [] => Err(Error::Unsupported("chart without a chart type".into())),
            _ => Err(Error::Unsupported("combination chart (several chart types)".into())),
        }
    }

    fn write(&self, doc: &mut Presentation, edits: Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<bool, Error> {
        let updated = splice(&self.src, edits)?;
        Tree::parse(&updated)?;
        let changed = updated != self.src;
        doc.package_mut().write(&self.name, updated)?;
        Ok(changed)
    }
}

/// Edits that make `parent`'s `c:` children named in `set` the given
/// markup (`None` removes), inserting missing ones in `order`.
fn set_children(tree: &Tree, parent: usize, order: &[&str], set: &[(&str, Option<String>)]) -> Vec<(std::ops::Range<usize>, Vec<u8>)> {
    let rank = |l: &str| order.iter().position(|o| *o == l).unwrap_or(usize::MAX);
    let p = tree.node(parent);
    let kids: Vec<usize> = p.children.iter().copied().filter(|&c| tree.node(c).ns.as_deref() == Some(NS_C)).collect();
    let mut edits = Vec::new();
    for (local, xml) in set {
        let existing: Vec<usize> = kids.iter().copied().filter(|&c| tree.node(c).local == *local).collect();
        match (existing.is_empty(), xml) {
            (false, x) => {
                for (k, &c) in existing.iter().enumerate() {
                    let n = tree.node(c);
                    let bytes = if k == 0 { x.clone().unwrap_or_default().into_bytes() } else { Vec::new() };
                    edits.push((n.start..n.end, bytes));
                }
            }
            (true, Some(x)) => {
                // Before the first later sibling this edit keeps.
                let kept = |c: usize| !set.iter().any(|(l, _)| *l == tree.node(c).local);
                let at = kids.iter().copied().find(|&c| kept(c) && rank(&tree.node(c).local) > rank(local)).map(|c| tree.node(c).start).unwrap_or(if p.open_end == p.end { p.end } else { p.close_start });
                edits.push((at..at, x.clone().into_bytes()));
            }
            (true, None) => {}
        }
    }
    edits
}

/// `xml` (a fragment of the chart part) with `parent`-level edits applied:
/// parses it inside the chart's root tag.
fn edit_fragment(cp: &ChartPart, xml: &str, f: impl Fn(&Tree, &[u8], usize) -> Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<String, Error> {
    let end = "</c:chartSpace>";
    let src = format!("{}{xml}{end}", cp.root_tag);
    let tree = Tree::parse(src.as_bytes())?;
    let top = *tree.node(tree.root).children.first().ok_or_else(|| Error::Xml("empty fragment".into()))?;
    let out = splice(src.as_bytes(), f(&tree, src.as_bytes(), top))?;
    let out = String::from_utf8(out).map_err(|e| Error::Xml(e.to_string()))?;
    Ok(out[cp.root_tag.len()..out.len() - end.len()].to_owned())
}

fn column(k: usize) -> String {
    let mut n = k + 1;
    let mut s = String::new();
    while n > 0 {
        let r = (n - 1) % 26;
        s.insert(0, (b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    s
}

fn quote_sheet(name: &str) -> String {
    if name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        name.to_owned()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

fn str_cache(values: &[&str]) -> String {
    let pts: String = values.iter().enumerate().map(|(i, v)| format!(r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, escape_text(v))).collect();
    format!(r#"<c:strCache><c:ptCount val="{}"/>{pts}</c:strCache>"#, values.len())
}

fn num_text(v: f64) -> String {
    let s = format!("{v}");
    if s.contains('e') {
        format!("{v:E}")
    } else {
        s
    }
}

/// Replaces the chart's categories and series. Series keep their
/// formatting by position; added series copy the last one's, recoloured to
/// their own accent.
pub fn set_chart_data(doc: &mut Presentation, slide: usize, id: u32, categories: &[String], series: &[SeriesData]) -> Result<Value, Error> {
    if series.is_empty() || categories.is_empty() {
        return Err(Error::InvalidCommand("a chart needs at least one category and one series".into()));
    }
    if let Some(s) = series.iter().find(|s| s.values.len() != categories.len()) {
        return Err(Error::InvalidCommand(format!("series {:?} has {} values for {} categories", s.name, s.values.len(), categories.len())));
    }
    if series.iter().flat_map(|s| &s.values).flatten().any(|v| !v.is_finite()) {
        return Err(Error::InvalidCommand("values must be finite numbers or null".into()));
    }
    let cp = chart_part(doc, slide, id)?;
    let t = &cp.tree;
    let group = cp.group()?;
    let old: Vec<usize> = t.children_named(group, NS_C, "ser").collect();
    let last = *old.last().ok_or_else(|| Error::Unsupported("chart without series to copy formatting from".into()))?;
    // The worksheet the series read from.
    let sheet = t
        .nodes
        .iter()
        .enumerate()
        .find(|(_, n)| n.ns.as_deref() == Some(NS_C) && n.local == "f")
        .and_then(|(i, _)| t.text(&cp.src, i).ok())
        .and_then(|f| f.rsplit_once('!').map(|(s, _)| s.trim_matches('\'').replace("''", "'")))
        .unwrap_or_else(|| "Sheet1".to_owned());
    let q = quote_sheet(&sheet);
    let n = categories.len();
    let next_idx = old.iter().filter_map(|&s| t.child(s, NS_C, "idx").and_then(|i| t.node(i).attr("val")).and_then(|v| v.parse::<usize>().ok())).max().map(|m| m + 1).unwrap_or(0);
    let cats: Vec<&str> = categories.iter().map(String::as_str).collect();
    let mut new_xml = String::new();
    for (k, s) in series.iter().enumerate() {
        let (base, fresh) = match old.get(k) {
            Some(&o) => (o, false),
            None => (last, true),
        };
        let col = column(k + 1);
        let tx = format!(r#"<c:tx><c:strRef><c:f>{q}!${col}$1</c:f>{}</c:strRef></c:tx>"#, str_cache(&[&s.name]));
        let cat = format!(r#"<c:cat><c:strRef><c:f>{q}!$A$2:$A${}</c:f>{}</c:strRef></c:cat>"#, n + 1, str_cache(&cats));
        let pts: String = s.values.iter().enumerate().filter_map(|(i, v)| v.map(|v| format!(r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, num_text(v)))).collect();
        let val = format!(r#"<c:val><c:numRef><c:f>{q}!${col}$2:${col}${}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="{n}"/>{pts}</c:numCache></c:numRef></c:val>"#, n + 1);
        let mut set: Vec<(&str, Option<String>)> = vec![("tx", Some(tx)), ("cat", Some(cat)), ("val", Some(val))];
        let idx = if fresh { next_idx + (k - old.len()) } else { k };
        if fresh {
            set.push(("idx", Some(format!(r#"<c:idx val="{idx}"/>"#))));
            set.push(("order", Some(format!(r#"<c:order val="{k}"/>"#))));
            // Point formats belong to the copied series.
            set.push(("dPt", None));
        }
        let xml = edit_fragment(&cp, cp.text(base), |tree, fsrc, ser| {
            let mut e = set_children(tree, ser, SER_ORDER, &set);
            if fresh {
                // Its own accent instead of the copied one.
                for (i, node) in tree.nodes.iter().enumerate() {
                    if node.ns.as_deref() == Some(NS_A) && node.local == "schemeClr" && node.attr("val").is_some_and(|v| v.starts_with("accent")) && node.start > tree.node(ser).start && node.end < tree.node(ser).end {
                        let tag = super::xmledit::start_tag(fsrc, tree, i, &[("val", Some(format!("accent{}", idx % 6 + 1)))], node.open_end == node.end);
                        if let Ok(tag) = tag {
                            e.push((node.start..node.open_end, tag));
                        }
                    }
                }
            }
            // Points beyond the new data lose their formats and labels.
            for d in tree.children_named(ser, NS_C, "dPt") {
                if tree.child(d, NS_C, "idx").and_then(|i| tree.node(i).attr("val")).and_then(|v| v.parse::<usize>().ok()).is_some_and(|i| i >= n) {
                    e.push((tree.node(d).start..tree.node(d).end, Vec::new()));
                }
            }
            e
        })?;
        new_xml.push_str(&xml);
    }
    let mut edits = Vec::new();
    for (k, &o) in old.iter().enumerate() {
        let r = t.node(o).start..t.node(o).end;
        edits.push((r, if k == 0 { new_xml.clone().into_bytes() } else { Vec::new() }));
    }
    let changed = cp.write(doc, edits)?;
    let workbook = update_workbook(doc, &cp.name, &sheet, categories, series)?;
    Ok(json!({ "op": "set_chart_data", "slide": slide, "shapeId": id, "part": cp.name, "changed": changed, "workbook": workbook }))
}

/// A child by local name in the parent's own namespace (workbooks from
/// Office 2007's beta use an older SpreadsheetML namespace).
fn local_child(tree: &Tree, parent: usize, local: &str) -> Option<usize> {
    let ns = tree.node(parent).ns.clone();
    tree.node(parent).children.iter().copied().find(|&c| tree.node(c).local == local && tree.node(c).ns == ns)
}

/// Writes the data into the chart's embedded workbook: the sheet's cells,
/// its dimension and the data table's range and column names.
fn update_workbook(doc: &mut Presentation, chart: &str, sheet: &str, categories: &[String], series: &[SeriesData]) -> Result<&'static str, Error> {
    let rels = read_relationships(doc.package(), &rels_part_for(chart), chart)?;
    let Some(link) = rels.iter().find(|r| r.rel_type.ends_with("/package")) else { return Ok("none") };
    let name = link.target.clone();
    let mut book = Package::open(doc.package().read(&name)?.to_vec())?;
    let wb_rels = read_relationships(&book, "xl/_rels/workbook.xml.rels", "xl/workbook.xml")?;
    let wb_src = book.read("xl/workbook.xml")?.to_vec();
    let wb = Tree::parse(&wb_src)?;
    let rid = wb.nodes.iter().find(|n| n.local == "sheet" && n.attr("name") == Some(sheet)).and_then(|n| n.attr_ns(NS_R, "id")).ok_or_else(|| Error::NotFound(format!("sheet {sheet:?} in the chart's workbook")))?;
    let sheet_part = wb_rels.iter().find(|r| r.id == rid).map(|r| r.target.clone()).ok_or_else(|| Error::NotFound("worksheet part".into()))?;
    let src = book.read(&sheet_part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let data = local_child(&tree, tree.root, "sheetData").ok_or_else(|| Error::Xml("worksheet without sheetData".into()))?;
    let last_col = column(series.len());
    let last_row = categories.len() + 1;
    let cell_str = |r: &str, s: &str| format!(r#"<c r="{r}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, escape_text(s));
    // Header names must be unique for the data table.
    let mut headers: Vec<String> = vec![" ".to_owned()];
    for s in series {
        let mut h = if s.name.trim().is_empty() { "Series".to_owned() } else { s.name.clone() };
        let mut k = 2;
        while headers.iter().any(|x| x.eq_ignore_ascii_case(&h)) {
            h = format!("{}{k}", s.name);
            k += 1;
        }
        headers.push(h);
    }
    let mut rows = format!(r#"<row r="1">{}</row>"#, headers.iter().enumerate().map(|(c, h)| cell_str(&format!("{}1", column(c)), h)).collect::<String>());
    for (i, cat) in categories.iter().enumerate() {
        let r = i + 2;
        let mut row = cell_str(&format!("A{r}"), cat);
        for (k, s) in series.iter().enumerate() {
            if let Some(v) = s.values[i] {
                row.push_str(&format!(r#"<c r="{}{r}"><v>{}</v></c>"#, column(k + 1), num_text(v)));
            }
        }
        rows.push_str(&format!(r#"<row r="{r}">{row}</row>"#));
    }
    let d = tree.node(data);
    let prefix = d.prefix().to_owned();
    let mut edits = vec![(d.start..d.end, format!("<{prefix}sheetData>{rows}</{prefix}sheetData>").into_bytes())];
    if let Some(dim) = local_child(&tree, tree.root, "dimension") {
        let n = tree.node(dim);
        edits.push((n.start..n.end, format!(r#"<{prefix}dimension ref="A1:{last_col}{last_row}"/>"#).into_bytes()));
    }
    book.write(&sheet_part, splice(&src, edits)?)?;
    // The data table over the range.
    let sheet_rels = read_relationships(&book, &rels_part_for(&sheet_part), &sheet_part)?;
    for table in sheet_rels.iter().filter(|r| r.rel_type.ends_with("/table")) {
        let tsrc = book.read(&table.target)?.to_vec();
        let tt = Tree::parse(&tsrc)?;
        let root = tt.node(tt.root);
        let mut edits = vec![(root.start..root.open_end, super::xmledit::start_tag(&tsrc, &tt, tt.root, &[("ref", Some(format!("A1:{last_col}{last_row}")))], false)?)];
        if let Some(af) = local_child(&tt, tt.root, "autoFilter") {
            let n = tt.node(af);
            edits.push((n.start..n.open_end, super::xmledit::start_tag(&tsrc, &tt, af, &[("ref", Some(format!("A1:{last_col}{last_row}")))], n.open_end == n.end)?));
        }
        if let Some(cols) = local_child(&tt, tt.root, "tableColumns") {
            let n = tt.node(cols);
            let list: String = headers.iter().enumerate().map(|(i, h)| format!(r#"<{prefix}tableColumn id="{}" name="{}"/>"#, i + 1, escape_text(h).replace('"', "&quot;"))).collect();
            edits.push((n.start..n.end, format!(r#"<{prefix}tableColumns count="{}">{list}</{prefix}tableColumns>"#, headers.len()).into_bytes()));
        }
        book.write(&table.target, splice(&tsrc, edits)?)?;
    }
    let bytes = book.save()?;
    doc.package_mut().write(&name, bytes)?;
    Ok("updated")
}

/// Series children each chart type allows.
fn allowed(kind: &str) -> &'static [&'static str] {
    match kind {
        "line" => &["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "smooth", "extLst"],
        "pie" | "doughnut" => &["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"],
        _ => &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "shape", "extLst"],
    }
}

/// The colour markup inside a series' fill or line, if any.
fn series_color(tree: &Tree, src: &[u8], ser: usize) -> Option<String> {
    let sp = tree.child(ser, NS_C, "spPr")?;
    let fill = tree.child(sp, NS_A, "solidFill").or_else(|| tree.path(sp, &[(NS_A, "ln"), (NS_A, "solidFill")]))?;
    let n = tree.node(fill);
    std::str::from_utf8(&src[n.open_end..n.close_start]).ok().map(str::to_owned)
}

/// Changes the chart type: `column`, `bar` (horizontal), `line`, `pie` or
/// `doughnut`, with `grouping` `clustered` (default), `stacked` or
/// `percentStacked` for columns, bars and lines. Series keep their data,
/// names and colours; axes are added or removed as the type needs.
pub fn set_chart_type(doc: &mut Presentation, slide: usize, id: u32, kind: &str, grouping: Option<&str>) -> Result<Value, Error> {
    if !matches!(kind, "column" | "bar" | "line" | "pie" | "doughnut") {
        return Err(Error::InvalidCommand(format!("type must be column, bar, line, pie or doughnut, got {kind:?}")));
    }
    let grouping = grouping.unwrap_or("clustered");
    if !matches!(grouping, "clustered" | "stacked" | "percentStacked") {
        return Err(Error::InvalidCommand(format!("grouping must be clustered, stacked or percentStacked, got {grouping:?}")));
    }
    let cp = chart_part(doc, slide, id)?;
    let t = &cp.tree;
    let group = cp.group()?;
    let plot = cp.plot()?;
    let axes: Vec<usize> = t.node(plot).children.iter().copied().filter(|&c| matches!(t.node(c).local.as_str(), "catAx" | "valAx" | "dateAx" | "serAx")).collect();
    let pie = matches!(kind, "pie" | "doughnut");
    // Series, trimmed to what the new type allows, in its own colour form.
    let mut sers = String::new();
    for s in t.children_named(group, NS_C, "ser") {
        let keep = allowed(kind);
        let color = series_color(t, &cp.src, s);
        let xml = edit_fragment(&cp, cp.text(s), |tree, _, ser| {
            let mut set: Vec<(&str, Option<String>)> = tree.node(ser).children.iter().map(|&c| tree.node(c).local.as_str()).filter(|l| !keep.contains(l)).map(|l| (l, None)).collect();
            let sp = match (kind, &color) {
                // A pie's slices take varied colours, which a series fill
                // would override.
                ("pie" | "doughnut", _) => None,
                ("line", Some(c)) => Some(format!(r#"<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill>{c}</a:solidFill><a:round/></a:ln></c:spPr>"#)),
                (_, Some(c)) => Some(format!(r#"<c:spPr><a:solidFill>{c}</a:solidFill></c:spPr>"#)),
                (_, None) => None,
            };
            if sp.is_some() || pie {
                set.push(("spPr", sp));
            }
            if kind == "line" {
                set.push(("marker", Some(r#"<c:marker><c:symbol val="none"/></c:marker>"#.into())));
                set.push(("smooth", Some(r#"<c:smooth val="0"/>"#.into())));
            }
            if matches!(kind, "column" | "bar") {
                set.push(("invertIfNegative", Some(r#"<c:invertIfNegative val="0"/>"#.into())));
            }
            set_children(tree, ser, SER_ORDER, &set)
        })?;
        sers.push_str(&xml);
    }
    let labels = t.child(group, NS_C, "dLbls").map(|d| cp.text(d).to_owned()).unwrap_or_default();
    // Axis ids: the existing ones, or new ones.
    let axis_id = |kinds: &[&str]| axes.iter().copied().find(|&a| kinds.contains(&t.node(a).local.as_str())).and_then(|a| t.child(a, NS_C, "axId")).and_then(|i| t.node(i).attr("val")).map(str::to_owned);
    let (cat_id, val_id) = match (axis_id(&["catAx", "dateAx"]), axis_id(&["valAx"])) {
        (Some(c), Some(v)) => (c, v),
        _ => ("500000001".to_owned(), "500000002".to_owned()),
    };
    let ax_ids = format!(r#"<c:axId val="{cat_id}"/><c:axId val="{val_id}"/>"#);
    let vary = if pie { "1" } else { "0" };
    let new_group = match kind {
        "column" | "bar" => {
            let overlap = if grouping == "clustered" { String::new() } else { r#"<c:overlap val="100"/>"#.into() };
            format!(r#"<c:barChart><c:barDir val="{}"/><c:grouping val="{grouping}"/><c:varyColors val="0"/>{sers}{labels}<c:gapWidth val="150"/>{overlap}{ax_ids}</c:barChart>"#, if kind == "bar" { "bar" } else { "col" })
        }
        "line" => {
            let g = if grouping == "clustered" { "standard" } else { grouping };
            format!(r#"<c:lineChart><c:grouping val="{g}"/><c:varyColors val="0"/>{sers}{labels}<c:marker val="1"/>{ax_ids}</c:lineChart>"#)
        }
        "pie" => format!(r#"<c:pieChart><c:varyColors val="{vary}"/>{sers}{labels}<c:firstSliceAng val="0"/></c:pieChart>"#),
        _ => format!(r#"<c:doughnutChart><c:varyColors val="{vary}"/>{sers}{labels}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>"#),
    };
    let mut edits = vec![(t.node(group).start..t.node(group).end, new_group.into_bytes())];
    let (cat_pos, val_pos) = if kind == "bar" { ("l", "b") } else { ("b", "l") };
    if pie {
        for &a in &axes {
            edits.push((t.node(a).start..t.node(a).end, Vec::new()));
        }
    } else if axes.is_empty() {
        let at = t.node(group).end;
        let xml = format!(
            r#"<c:catAx><c:axId val="{cat_id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="{cat_pos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="{val_id}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="{val_id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="{val_pos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="{cat_id}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>"#
        );
        edits.push((at..at, xml.into_bytes()));
    } else {
        // Axis sides follow the bar direction; axes the new group does not
        // use (the series axis of a 3D chart) go.
        for &a in &axes {
            let aid = t.child(a, NS_C, "axId").and_then(|i| t.node(i).attr("val")).unwrap_or_default();
            if aid != cat_id && aid != val_id {
                edits.push((t.node(a).start..t.node(a).end, Vec::new()));
                continue;
            }
            let pos = if t.node(a).local == "valAx" { val_pos } else { cat_pos };
            if let Some(p) = t.child(a, NS_C, "axPos") {
                let n = t.node(p);
                edits.push((n.start..n.end, format!(r#"<c:axPos val="{pos}"/>"#).into_bytes()));
            }
        }
    }
    let changed = cp.write(doc, edits)?;
    Ok(json!({ "op": "set_chart_type", "slide": slide, "shapeId": id, "part": cp.name, "changed": changed }))
}

/// Chart title (`""` removes it), legend position (`r`, `b`, `t`, `l`,
/// `tr` or `none`), value labels on every series, value gridlines and
/// series colours (`RRGGBB`, by series). Fields left out stay.
#[allow(clippy::too_many_arguments)]
pub fn set_chart_format(doc: &mut Presentation, slide: usize, id: u32, title: Option<&str>, legend: Option<&str>, data_labels: Option<bool>, gridlines: Option<bool>, colors: Option<&[String]>) -> Result<Value, Error> {
    if title.is_none() && legend.is_none() && data_labels.is_none() && gridlines.is_none() && colors.is_none() {
        return Err(Error::InvalidCommand("set at least one of title, legend, dataLabels, gridlines and colors".into()));
    }
    if let Some(l) = legend {
        if !matches!(l, "r" | "b" | "t" | "l" | "tr" | "none") {
            return Err(Error::InvalidCommand(format!("legend must be r, b, t, l, tr or none, got {l:?}")));
        }
    }
    let colors: Vec<String> = colors.unwrap_or(&[]).iter().map(|c| super::shape::parse_color(c)).collect::<Result<_, _>>()?;
    let cp = chart_part(doc, slide, id)?;
    let t = &cp.tree;
    let chart = t.child(t.root, NS_C, "chart").ok_or_else(|| Error::Xml("chartSpace without chart".into()))?;
    let group = cp.group()?;
    let mut edits = Vec::new();
    let mut set: Vec<(&str, Option<String>)> = Vec::new();
    if let Some(text) = title {
        if text.is_empty() {
            set.push(("title", None));
            set.push(("autoTitleDeleted", Some(r#"<c:autoTitleDeleted val="1"/>"#.into())));
        } else {
            let paras: String = text.split('\n').map(|p| format!(r#"<a:p><a:r><a:t>{}</a:t></a:r></a:p>"#, escape_text(p))).collect();
            set.push(("title", Some(format!(r#"<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>{paras}</c:rich></c:tx><c:overlay val="0"/></c:title>"#))));
            set.push(("autoTitleDeleted", Some(r#"<c:autoTitleDeleted val="0"/>"#.into())));
        }
    }
    if let Some(l) = legend {
        if l == "none" {
            set.push(("legend", None));
        } else if let Some(existing) = t.child(chart, NS_C, "legend") {
            match t.child(existing, NS_C, "legendPos") {
                Some(p) => edits.push((t.node(p).start..t.node(p).end, format!(r#"<c:legendPos val="{l}"/>"#).into_bytes())),
                None => {
                    let at = t.node(existing).open_end;
                    edits.push((at..at, format!(r#"<c:legendPos val="{l}"/>"#).into_bytes()));
                }
            }
        } else {
            set.push(("legend", Some(format!(r#"<c:legend><c:legendPos val="{l}"/><c:overlay val="0"/></c:legend>"#))));
        }
    }
    edits.extend(set_children(t, chart, CHART_ORDER, &set));
    let sers: Vec<usize> = t.children_named(group, NS_C, "ser").collect();
    if colors.len() > sers.len() {
        return Err(Error::InvalidCommand(format!("{} colours for {} series", colors.len(), sers.len())));
    }
    let line = matches!(t.node(group).local.as_str(), "lineChart" | "line3DChart");
    for (k, &s) in sers.iter().enumerate() {
        let mut sset: Vec<(&str, Option<String>)> = Vec::new();
        if let Some(on) = data_labels {
            let v = if on { 1 } else { 0 };
            sset.push(("dLbls", Some(format!(r#"<c:dLbls><c:showLegendKey val="0"/><c:showVal val="{v}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>"#))));
        }
        if let Some(c) = colors.get(k) {
            let sp = if line {
                format!(r#"<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:round/></a:ln></c:spPr>"#)
            } else {
                format!(r#"<c:spPr><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></c:spPr>"#)
            };
            sset.push(("spPr", Some(sp)));
        }
        edits.extend(set_children(t, s, SER_ORDER, &sset));
    }
    if let Some(on) = gridlines {
        let plot = cp.plot()?;
        let Some(va) = t.child(plot, NS_C, "valAx") else { return Err(Error::Unsupported("chart without a value axis".into())) };
        let g = if on { t.child(va, NS_C, "majorGridlines").map(|g| cp.text(g).to_owned()).or_else(|| Some("<c:majorGridlines/>".into())) } else { None };
        edits.extend(set_children(t, va, VAL_AX_ORDER, &[("majorGridlines", g)]));
    }
    let changed = cp.write(doc, edits)?;
    Ok(json!({ "op": "set_chart_format", "slide": slide, "shapeId": id, "part": cp.name, "changed": changed }))
}
