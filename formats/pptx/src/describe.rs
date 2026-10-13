//! A read-only description of the whole presentation in one call: every
//! slide's shapes with their position on the slide, text, tables, charts and
//! SmartArt nodes, and the slide's layout, notes, comments and animations.
//! Lengths are points; slides count from 1; shapes are named by `cNvPr id`.
//! A host that shows the deck and lets an AI address its shapes builds its
//! observation from this.

use kurbo::{Affine, Point};
use serde_json::{json, Value};

use crate::render::{effective_xfrm, read_xfrm};
use crate::xml::{Tree, NS_A, NS_P, NS_R};
use crate::{commands, non_visual, paragraph_texts, read_relationships, rels_part_for, shape_id, Error, Presentation};

const EMU_PER_PT: f64 = 12_700.0;
const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_P14: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const URI_TABLE: &str = "http://schemas.openxmlformats.org/drawingml/2006/table";
const URI_CHART: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const URI_DIAGRAM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const REL_MASTER: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const REL_LAYOUT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_NOTES: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

fn read_tree(doc: &Presentation, part: &str) -> Result<(Vec<u8>, Tree), Error> {
    let src = doc.package().read(part)?.to_vec();
    let tree = Tree::parse(&src)?;
    Ok((src, tree))
}

/// Every font family the document's XML names (`typeface="…"`), sorted;
/// theme references such as `+mn-lt` are left out. A host uses it to load
/// the installed fonts the deck asks for.
fn typefaces(doc: &Presentation) -> Result<Vec<String>, Error> {
    const KEY: &[u8] = b"typeface=\"";
    let names: Vec<String> = doc.package().part_names().filter(|n| n.ends_with(".xml")).map(str::to_owned).collect();
    let mut found = std::collections::BTreeSet::new();
    for name in names {
        let bytes = doc.package().read(&name)?;
        let mut rest: &[u8] = &bytes;
        while let Some(at) = rest.windows(KEY.len()).position(|w| w == KEY) {
            rest = &rest[at + KEY.len()..];
            let Some(end) = rest.iter().position(|&b| b == b'"') else { break };
            if let Ok(face) = std::str::from_utf8(&rest[..end]) {
                let face = quick_xml::escape::unescape(face).unwrap_or(std::borrow::Cow::Borrowed(face));
                if !face.is_empty() && !face.starts_with('+') {
                    found.insert(face.into_owned());
                }
            }
            rest = &rest[end..];
        }
    }
    Ok(found.into_iter().collect())
}

/// The presentation described (see the module comment).
pub fn describe(doc: &Presentation) -> Result<Value, Error> {
    let pres = doc.presentation_part().to_owned();
    let (psrc, ptree) = read_tree(doc, &pres)?;
    let size = ptree.child(ptree.root, NS_P, "sldSz");
    let dim = |a: &str| size.and_then(|n| ptree.node(n).attr(a)).and_then(|v| v.parse::<f64>().ok()).map(|v| v / EMU_PER_PT);

    // Masters and their layouts, in file order.
    let mut masters = Vec::new();
    let mut layout_index: Vec<(String, usize, usize, String)> = Vec::new();
    for (mi, m) in read_relationships(doc.package(), &rels_part_for(&pres), &pres)?.into_iter().filter(|r| r.rel_type == REL_MASTER).enumerate() {
        let (_, mtree) = read_tree(doc, &m.target)?;
        let mut layouts = Vec::new();
        for (li, l) in read_relationships(doc.package(), &rels_part_for(&m.target), &m.target)?.into_iter().filter(|r| r.rel_type == REL_LAYOUT).enumerate() {
            let (_, ltree) = read_tree(doc, &l.target)?;
            let name = ltree.child(ltree.root, NS_P, "cSld").and_then(|c| ltree.node(c).attr("name")).unwrap_or("").to_owned();
            layout_index.push((l.target.clone(), mi, li, name.clone()));
            layouts.push(json!({ "index": li, "name": name }));
        }
        let name = mtree.child(mtree.root, NS_P, "cSld").and_then(|c| mtree.node(c).attr("name")).unwrap_or("").to_owned();
        masters.push(json!({ "index": mi, "name": name, "layouts": layouts }));
    }

    // Sections (PowerPoint 2010 extension), by slide position.
    let slide_ids: Vec<String> = ptree
        .child(ptree.root, NS_P, "sldIdLst")
        .map(|l| ptree.children_named(l, NS_P, "sldId").filter_map(|s| ptree.node(s).attr("id").map(str::to_owned)).collect())
        .unwrap_or_default();
    let sections: Vec<Value> = ptree
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.is(NS_P14, "section"))
        .map(|(i, n)| {
            let slides: Vec<usize> = ptree
                .path(i, &[(NS_P14, "sldIdLst")])
                .map(|l| ptree.children_named(l, NS_P14, "sldId").filter_map(|s| ptree.node(s).attr("id")).filter_map(|id| slide_ids.iter().position(|x| x == id).map(|p| p + 1)).collect())
                .unwrap_or_default();
            json!({ "name": n.attr("name").unwrap_or(""), "slides": slides })
        })
        .collect();
    let _ = psrc;

    let mut slides = Vec::new();
    for index in 1..=doc.slide_count() {
        let part = doc.slide_part(index)?.to_owned();
        let (src, tree) = read_tree(doc, &part)?;
        let rels = read_relationships(doc.package(), &rels_part_for(&part), &part)?;
        let csld = tree.child(tree.root, NS_P, "cSld");
        let layout = rels.iter().find(|r| r.rel_type == REL_LAYOUT).and_then(|r| layout_index.iter().find(|(p, ..)| *p == r.target));
        let notes = match rels.iter().find(|r| r.rel_type == REL_NOTES) {
            Some(r) => notes_text(doc, &r.target)?,
            None => Vec::new(),
        };
        let shapes = match csld.and_then(|c| tree.child(c, NS_P, "spTree")) {
            Some(sp_tree) => shapes(doc, index, &part, &src, &tree, sp_tree, Affine::IDENTITY, true)?,
            None => Vec::new(),
        };
        // The id the engine gives the next new shape is this plus one.
        let max_shape_id = tree.nodes.iter().filter(|n| n.local == "cNvPr").filter_map(|n| n.attr("id")?.parse::<u32>().ok()).max().unwrap_or(1);
        slides.push(json!({
            "index": index,
            "maxShapeId": max_shape_id,
            "name": csld.and_then(|c| tree.node(c).attr("name")).unwrap_or(""),
            "hidden": tree.node(tree.root).attr("show") == Some("0"),
            "layout": layout.map(|(_, m, l, name)| json!({ "master": m, "index": l, "name": name })),
            "notes": notes,
            "comments": commands::comments::slide_comments(doc, index).unwrap_or_default(),
            "animations": commands::animation::slide_animations(doc, index).unwrap_or_default(),
            "shapes": shapes,
        }));
    }
    Ok(json!({ "width": dim("cx"), "height": dim("cy"), "masters": masters, "sections": sections, "slides": slides, "fonts": typefaces(doc)? }))
}

fn notes_text(doc: &Presentation, part: &str) -> Result<Vec<String>, Error> {
    let (src, tree) = read_tree(doc, part)?;
    for (i, n) in tree.nodes.iter().enumerate() {
        if n.is(NS_P, "sp") && tree.path(i, &[(NS_P, "nvSpPr"), (NS_P, "nvPr"), (NS_P, "ph")]).is_some_and(|ph| tree.node(ph).attr("type") == Some("body")) {
            if let Some(body) = tree.child(i, NS_P, "txBody") {
                return paragraph_texts(&tree, &src, body);
            }
        }
    }
    Ok(Vec::new())
}

/// Shapes under `parent`, their frames mapped to the slide by `to_slide`.
#[allow(clippy::too_many_arguments)]
fn shapes(doc: &Presentation, index: usize, part: &str, src: &[u8], tree: &Tree, parent: usize, to_slide: Affine, top: bool) -> Result<Vec<Value>, Error> {
    let mut out = Vec::new();
    for &c in &tree.node(parent).children {
        let n = tree.node(c);
        if n.ns.as_deref() != Some(NS_P) || !matches!(n.local.as_str(), "sp" | "pic" | "cxnSp" | "graphicFrame" | "grpSp") {
            continue;
        }
        let Some(id) = shape_id(tree, c) else { continue };
        let cnv = non_visual(tree, c);
        let xfrm_node = match n.local.as_str() {
            "graphicFrame" => tree.child(c, NS_P, "xfrm"),
            "grpSp" => tree.path(c, &[(NS_P, "grpSpPr"), (NS_A, "xfrm")]),
            _ => tree.path(c, &[(NS_P, "spPr"), (NS_A, "xfrm")]),
        };
        let mut xfrm = xfrm_node.and_then(|x| read_xfrm(tree, x));
        if xfrm.is_none() && top {
            // A placeholder without its own position takes its layout's.
            xfrm = effective_xfrm(doc, index, id)?;
        }
        let frame = xfrm.as_ref().map(|x| {
            let a = to_slide * Point::new(x.rect.x0, x.rect.y0);
            let b = to_slide * Point::new(x.rect.x1, x.rect.y1);
            [a.x.min(b.x), a.y.min(b.y), (b.x - a.x).abs(), (b.y - a.y).abs()]
        });
        let nv_pr = tree.node(c).children.iter().find(|&&k| tree.node(k).local.starts_with("nv")).and_then(|nv| tree.child(*nv, NS_P, "nvPr"));
        let placeholder = nv_pr.and_then(|p| tree.child(p, NS_P, "ph")).map(|ph| tree.node(ph).attr("type").unwrap_or("body").to_owned());
        let mut v = json!({
            "id": id,
            "name": cnv.and_then(|k| tree.node(k).attr("name")).unwrap_or(""),
            "description": cnv.and_then(|k| tree.node(k).attr("descr")).unwrap_or(""),
            "kind": n.local,
            "frame": frame,
            "rotation": xfrm.as_ref().map(|x| x.rot).unwrap_or(0.0),
            "flipH": xfrm.as_ref().is_some_and(|x| x.flip_h),
            "flipV": xfrm.as_ref().is_some_and(|x| x.flip_v),
        });
        if let Some(ph) = placeholder {
            v["placeholder"] = json!(ph);
        }
        if let Some(body) = tree.child(c, NS_P, "txBody") {
            v["paragraphs"] = json!(paragraph_texts(tree, src, body)?);
        }
        if n.local == "sp" {
            v["preset"] = json!(tree.path(c, &[(NS_P, "spPr"), (NS_A, "prstGeom")]).and_then(|g| tree.node(g).attr("prst")));
        }
        if n.local == "pic" {
            let media = nv_pr.and_then(|p| tree.node(p).children.iter().find_map(|&k| match tree.node(k).local.as_str() {
                "videoFile" => Some("video"),
                "audioFile" => Some("audio"),
                _ => None,
            }));
            v["media"] = json!(media);
        }
        if n.local == "graphicFrame" {
            if let Some(gd) = tree.path(c, &[(NS_A, "graphic"), (NS_A, "graphicData")]) {
                match tree.node(gd).attr("uri") {
                    Some(URI_TABLE) => v["table"] = table(tree, src, gd)?,
                    Some(URI_CHART) => v["chart"] = chart(doc, part, tree, gd).unwrap_or(Value::Null),
                    Some(URI_DIAGRAM) => v["smartart"] = json!(commands::smartart::smartart_nodes(doc, index, id).unwrap_or_default()),
                    _ => {}
                }
            }
        }
        if n.local == "grpSp" {
            // Child coordinates map onto the group's frame.
            let inner = match xfrm.as_ref().and_then(|x| x.child.map(|ch| (x.rect, ch))) {
                Some((r, ch)) if ch.width() > 0.0 && ch.height() > 0.0 => {
                    to_slide * Affine::translate((r.x0, r.y0)) * Affine::scale_non_uniform(r.width() / ch.width(), r.height() / ch.height()) * Affine::translate((-ch.x0, -ch.y0))
                }
                _ => to_slide,
            };
            v["children"] = json!(shapes(doc, index, part, src, tree, c, inner, false)?);
        }
        out.push(v);
    }
    Ok(out)
}

fn cell_text(tree: &Tree, src: &[u8], tc: usize) -> Result<String, Error> {
    Ok(match tree.child(tc, NS_A, "txBody") {
        Some(b) => paragraph_texts(tree, src, b)?.join("\n"),
        None => String::new(),
    })
}

fn table(tree: &Tree, src: &[u8], gd: usize) -> Result<Value, Error> {
    let Some(tbl) = tree.child(gd, NS_A, "tbl") else { return Ok(Value::Null) };
    let cols = tree.child(tbl, NS_A, "tblGrid").map(|g| tree.children_named(g, NS_A, "gridCol").count()).unwrap_or(0);
    let mut cells = Vec::new();
    let mut heights = Vec::new();
    for tr in tree.children_named(tbl, NS_A, "tr") {
        heights.push(tree.node(tr).attr("h").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / EMU_PER_PT);
        let mut row = Vec::new();
        for tc in tree.children_named(tr, NS_A, "tc") {
            row.push(cell_text(tree, src, tc)?);
        }
        cells.push(row);
    }
    let widths: Vec<f64> = tree
        .child(tbl, NS_A, "tblGrid")
        .map(|g| tree.children_named(g, NS_A, "gridCol").map(|c| tree.node(c).attr("w").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / EMU_PER_PT).collect())
        .unwrap_or_default();
    Ok(json!({ "rows": cells.len(), "cols": cols, "cells": cells, "rowHeights": heights, "columnWidths": widths }))
}

/// Chart type, categories and series (cached values), or `None` when the
/// chart part cannot be read.
fn chart(doc: &Presentation, part: &str, tree: &Tree, gd: usize) -> Option<Value> {
    let rid = tree.child(gd, NS_C, "chart").and_then(|c| tree.node(c).attr_ns(NS_R, "id"))?;
    let rels = read_relationships(doc.package(), &rels_part_for(part), part).ok()?;
    let target = rels.into_iter().find(|r| r.id == rid)?.target;
    let (src, t) = read_tree(doc, &target).ok()?;
    let plot = t.path(t.root, &[(NS_C, "chart"), (NS_C, "plotArea")])?;
    let group = t.node(plot).children.iter().copied().find(|&c| t.node(c).local.ends_with("Chart"))?;
    let kind = t.node(group).local.trim_end_matches("Chart").to_owned();
    let cache = |n: usize| -> Vec<String> {
        let mut pts: Vec<(usize, String)> = t
            .nodes
            .iter()
            .enumerate()
            .filter(|(i, x)| x.is(NS_C, "pt") && ancestor(&t, *i, n))
            .map(|(i, x)| (x.attr("idx").and_then(|v| v.parse().ok()).unwrap_or(0), t.child(i, NS_C, "v").and_then(|v| t.text(&src, v).ok()).unwrap_or_default()))
            .collect();
        pts.sort_by_key(|p| p.0);
        pts.into_iter().map(|p| p.1).collect()
    };
    let mut categories = Vec::new();
    let series: Vec<Value> = t
        .children_named(group, NS_C, "ser")
        .map(|s| {
            if categories.is_empty() {
                if let Some(cat) = t.child(s, NS_C, "cat") {
                    categories = cache(cat);
                }
            }
            let name = t.child(s, NS_C, "tx").map(|x| cache(x).join("")).unwrap_or_default();
            let values: Vec<Option<f64>> = t.child(s, NS_C, "val").map(|v| cache(v).iter().map(|x| x.parse().ok()).collect()).unwrap_or_default();
            json!({ "name": name, "values": values })
        })
        .collect();
    let bar_dir = t.child(group, NS_C, "barDir").and_then(|b| t.node(b).attr("val")).map(str::to_owned);
    let grouping = t.child(group, NS_C, "grouping").and_then(|b| t.node(b).attr("val")).map(str::to_owned);
    let title = t.path(t.root, &[(NS_C, "chart"), (NS_C, "title")]).map(|ti| {
        t.nodes.iter().enumerate().filter(|(i, x)| x.is(NS_A, "t") && ancestor(&t, *i, ti)).filter_map(|(i, _)| t.text(&src, i).ok()).collect::<String>()
    });
    Some(json!({ "type": kind, "barDirection": bar_dir, "grouping": grouping, "title": title, "categories": categories, "series": series }))
}

/// Whether `node` lies under `above`.
fn ancestor(t: &Tree, node: usize, above: usize) -> bool {
    let mut n = node;
    while let Some(p) = t.node(n).parent {
        if p == above {
            return true;
        }
        n = p;
    }
    false
}
