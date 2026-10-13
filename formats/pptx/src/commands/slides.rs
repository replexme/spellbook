//! Commands on whole slides: insert, duplicate, delete, move and rename.
//! They edit the slide list in `presentation.xml` (and its sections), the
//! package relationships and `[Content_Types].xml`, and add or remove parts.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use super::xmledit::{escape_attr, ns_prefix, start_tag};
use crate::xml::{splice, Tree, NS_A, NS_P, NS_PKG_REL, NS_R};
use crate::{read_relationships, rels_part_for, Error, Presentation};

const CONTENT_TYPES: &str = "[Content_Types].xml";
pub(super) const REL_SLIDE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
pub(super) const REL_LAYOUT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const CT_SLIDE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
pub(super) const NS_P14: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";
/// Children of `p:presentation` before and after `p:sldIdLst`.
const PRESENTATION_ORDER: &[&str] = &["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz"];

/// Relationship types whose targets a copied slide shares with the original.
fn shared(rel_type: &str) -> bool {
    const SHARED: &[&str] = &["/slideLayout", "/slideMaster", "/notesMaster", "/handoutMaster", "/theme", "/image", "/media", "/audio", "/video", "/font", "/customXml", "/commentAuthors"];
    SHARED.iter().any(|s| rel_type.ends_with(s))
}

fn is_comments(rel_type: &str) -> bool {
    rel_type.ends_with("/comments")
}

// ---------------------------------------------------------------- helpers

pub(super) fn read_tree(doc: &Presentation, part: &str) -> Result<(Vec<u8>, Tree), Error> {
    let src = doc.package().read(part)?.to_vec();
    let tree = Tree::parse(&src)?;
    Ok((src, tree))
}

/// `from` and `to` are part names; the result is `to` relative to `from`'s folder.
pub(super) fn relative(from: &str, to: &str) -> String {
    let from_dir: Vec<&str> = from.rsplit_once('/').map(|(d, _)| d.split('/').collect()).unwrap_or_default();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from_dir.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = vec![".."; from_dir.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

/// A new part name next to `like`: same folder, stem and extension, the
/// next free number (`ppt/slides/slide7.xml`).
pub(super) fn fresh_name(doc: &Presentation, like: &str, taken: &BTreeSet<String>) -> String {
    let (dir, file) = like.rsplit_once('/').unwrap_or(("", like));
    let (stem_num, ext) = file.rsplit_once('.').unwrap_or((file, ""));
    let stem = stem_num.trim_end_matches(|c: char| c.is_ascii_digit());
    let number = |name: &str| -> Option<u64> {
        let (d, f) = name.rsplit_once('/').unwrap_or(("", name));
        let rest = f.strip_prefix(stem)?.strip_suffix(&format!(".{ext}"))?;
        (d == dir).then(|| rest.parse().ok()).flatten()
    };
    let max = doc.package().part_names().chain(taken.iter().map(String::as_str)).filter_map(number).max().unwrap_or(0);
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    format!("{prefix}{stem}{}.{ext}", max + 1)
}

pub(super) fn content_type(doc: &Presentation, part: &str) -> Result<Option<String>, Error> {
    let (_, tree) = read_tree(doc, CONTENT_TYPES)?;
    let root = tree.node(tree.root);
    let over = root.children.iter().map(|&c| tree.node(c)).find(|n| n.local == "Override" && n.attr("PartName").map(|p| p.trim_start_matches('/')) == Some(part));
    if let Some(n) = over {
        return Ok(n.attr("ContentType").map(str::to_owned));
    }
    let ext = part.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    Ok(root.children.iter().map(|&c| tree.node(c)).find(|n| n.local == "Default" && n.attr("Extension").map(str::to_ascii_lowercase) == Some(ext.clone())).and_then(|n| n.attr("ContentType").map(str::to_owned)))
}

/// Adds `Override` entries for new parts and drops those of removed parts.
pub(super) fn update_content_types(doc: &mut Presentation, add: &[(String, String)], remove: &BTreeSet<String>) -> Result<(), Error> {
    let (src, tree) = read_tree(doc, CONTENT_TYPES)?;
    let root = tree.node(tree.root);
    let mut edits = Vec::new();
    for &c in &root.children {
        let n = tree.node(c);
        if n.local == "Override" && n.attr("PartName").is_some_and(|p| remove.contains(p.trim_start_matches('/'))) {
            edits.push((n.start..n.end, Vec::new()));
        }
    }
    if !add.is_empty() {
        let prefix = root.prefix().to_owned();
        let mut bytes = Vec::new();
        for (part, ct) in add {
            bytes.extend(format!(r#"<{prefix}Override PartName="/{}" ContentType="{}"/>"#, escape_attr(part), escape_attr(ct)).into_bytes());
        }
        edits.push((root.close_start..root.close_start, bytes));
    }
    let updated = splice(&src, edits)?;
    doc.package_mut().write(CONTENT_TYPES, updated).map_err(Error::from)
}

/// Makes sure parts with extension `ext` have a content type, adding a
/// `Default` entry when none covers it.
pub(super) fn ensure_default_type(doc: &mut Presentation, ext: &str, ct: &str) -> Result<(), Error> {
    let (src, tree) = read_tree(doc, CONTENT_TYPES)?;
    let root = tree.node(tree.root);
    let has = root.children.iter().any(|&c| tree.node(c).local == "Default" && tree.node(c).attr("Extension").is_some_and(|e| e.eq_ignore_ascii_case(ext)));
    if has {
        return Ok(());
    }
    let prefix = root.prefix().to_owned();
    let at = root.children.iter().map(|&c| tree.node(c)).filter(|n| n.local == "Default").map(|n| n.end).last().unwrap_or(root.open_end);
    let el = format!(r#"<{prefix}Default Extension="{}" ContentType="{}"/>"#, escape_attr(ext), escape_attr(ct));
    let updated = splice(&src, vec![(at..at, el.into_bytes())])?;
    doc.package_mut().write(CONTENT_TYPES, updated).map_err(Error::from)
}

/// Adds relationships to `source`'s rels part (created when missing).
/// `rels` are (id, type, target as written, external).
pub(super) fn add_relationships(doc: &mut Presentation, source: &str, rels: &[(String, String, String, bool)]) -> Result<(), Error> {
    let rels_part = rels_part_for(source);
    let mut bytes = Vec::new();
    for (id, ty, target, external) in rels {
        let mode = if *external { r#" TargetMode="External""# } else { "" };
        bytes.extend(format!(r#"<Relationship Id="{}" Type="{}" Target="{}"{mode}/>"#, escape_attr(id), escape_attr(ty), escape_attr(target)).into_bytes());
    }
    let updated = if doc.package().contains(&rels_part) {
        let (src, tree) = read_tree(doc, &rels_part)?;
        let root = tree.node(tree.root);
        if root.is_empty_element() {
            let mut out = src[..root.start].to_vec();
            out.extend(start_tag(&src, &tree, tree.root, &[], false)?);
            out.extend(&bytes);
            out.extend(format!("</{}>", root.qname).into_bytes());
            out.extend(&src[root.end..]);
            out
        } else {
            splice(&src, vec![(root.close_start..root.close_start, bytes)])?
        }
    } else {
        let mut out = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#
            .to_vec();
        out.extend(bytes);
        out.extend(b"</Relationships>");
        out
    };
    doc.package_mut().write(&rels_part, updated).map_err(Error::from)
}

pub(super) fn remove_relationship(doc: &mut Presentation, source: &str, id: &str) -> Result<(), Error> {
    let rels_part = rels_part_for(source);
    let (src, tree) = read_tree(doc, &rels_part)?;
    let edits: Vec<_> = tree.children_named(tree.root, NS_PKG_REL, "Relationship").filter(|&r| tree.node(r).attr("Id") == Some(id)).map(|r| (tree.node(r).start..tree.node(r).end, Vec::new())).collect();
    if edits.is_empty() {
        return Err(Error::NotFound(format!("relationship {id} of {source}")));
    }
    let updated = splice(&src, edits)?;
    doc.package_mut().write(&rels_part, updated).map_err(Error::from)
}

/// A relationship ID not used by `source` yet.
pub(super) fn fresh_rel_id(doc: &Presentation, source: &str, taken: &[String]) -> Result<String, Error> {
    let used: BTreeSet<String> = read_relationships(doc.package(), &rels_part_for(source), source)?.into_iter().map(|r| r.id).chain(taken.iter().cloned()).collect();
    Ok((1..).map(|n| format!("rId{n}")).find(|id| !used.contains(id)).expect("unbounded"))
}

/// The slide list as (sldId id, r:id, part), in order.
pub(super) fn slide_entries(doc: &Presentation) -> Result<Vec<(u32, String, String)>, Error> {
    let pres = doc.presentation_part().to_owned();
    let (_, tree) = read_tree(doc, &pres)?;
    let rels = read_relationships(doc.package(), &rels_part_for(&pres), &pres)?;
    let Some(list) = tree.child(tree.root, NS_P, "sldIdLst") else { return Ok(Vec::new()) };
    tree.children_named(list, NS_P, "sldId")
        .map(|s| {
            let n = tree.node(s);
            let id = n.attr("id").and_then(|v| v.parse().ok()).ok_or_else(|| Error::Xml("sldId without id".into()))?;
            let rid = n.attr_ns(NS_R, "id").ok_or_else(|| Error::Xml("sldId without r:id".into()))?.to_owned();
            let part = rels.iter().find(|r| r.id == rid).map(|r| r.target.clone()).ok_or_else(|| Error::NotFound(format!("slide relationship {rid}")))?;
            Ok((id, rid, part))
        })
        .collect()
}

/// Rewrites the slide list (`p:sldIdLst`) and the section lists to `order`,
/// a list of (sldId id, r:id). `sections` maps each section's position to its
/// new list of slide ids.
fn write_slide_list(doc: &mut Presentation, order: &[(u32, String)], sections: Option<Vec<Vec<u32>>>) -> Result<(), Error> {
    let pres = doc.presentation_part().to_owned();
    let (src, tree) = read_tree(doc, &pres)?;
    let root = tree.root;
    let p = tree.node(root).prefix().to_owned();
    let r_prefix = ns_prefix(&src, &tree, NS_R).unwrap_or_else(|| "r".to_owned());
    let mut list = String::new();
    for (id, rid) in order {
        list.push_str(&format!(r#"<{p}sldId id="{id}" {r_prefix}:id="{}"/>"#, escape_attr(rid)));
    }
    let new_list = if order.is_empty() { Vec::new() } else { format!("<{p}sldIdLst>{list}</{p}sldIdLst>").into_bytes() };
    let mut edits = Vec::new();
    match tree.child(root, NS_P, "sldIdLst") {
        Some(l) => edits.push((tree.node(l).start..tree.node(l).end, new_list)),
        None if !order.is_empty() => {
            // Insert at its schema position: after the master lists.
            let after = tree.node(root).children.iter().copied().filter(|&c| {
                let n = tree.node(c);
                n.ns.as_deref() == Some(NS_P) && PRESENTATION_ORDER[..3].contains(&n.local.as_str())
            });
            let at = after.last().map(|c| tree.node(c).end).unwrap_or(tree.node(root).open_end);
            edits.push((at..at, new_list));
        }
        None => {}
    }
    if let Some(sections) = sections {
        let section_nodes: Vec<usize> = tree.nodes.iter().enumerate().filter(|(_, n)| n.ns.as_deref() == Some(NS_P14) && n.local == "section").map(|(i, _)| i).collect();
        if section_nodes.len() != sections.len() {
            return Err(Error::Xml("section count changed".into()));
        }
        for (k, &sec) in section_nodes.iter().enumerate() {
            let n = tree.node(sec);
            let p14 = n.prefix().to_owned();
            let ids: String = sections[k].iter().map(|id| format!(r#"<{p14}sldId id="{id}"/>"#)).collect();
            let body = format!("<{p14}sldIdLst>{ids}</{p14}sldIdLst>");
            let change = match tree.child(sec, NS_P14, "sldIdLst") {
                Some(l) => (tree.node(l).start..tree.node(l).end, body.into_bytes()),
                None => {
                    let tag = start_tag(&src, &tree, sec, &[], false)?;
                    let mut b = tag;
                    b.extend(body.into_bytes());
                    if !n.is_empty_element() {
                        b.extend(&src[n.open_end..n.close_start]);
                    }
                    b.extend(format!("</{}>", n.qname).into_bytes());
                    (n.start..n.end, b)
                }
            };
            edits.push(change);
        }
    }
    let updated = splice(&src, edits)?;
    doc.package_mut().write(&pres, updated)?;
    doc.reload_slides()
}

/// Section membership (slide ids per section), if the presentation has sections.
pub(super) fn sections(doc: &Presentation) -> Result<Option<Vec<Vec<u32>>>, Error> {
    let (_, tree) = read_tree(doc, doc.presentation_part())?;
    let secs: Vec<Vec<u32>> = tree
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.ns.as_deref() == Some(NS_P14) && n.local == "section")
        .map(|(i, _)| {
            tree.child(i, NS_P14, "sldIdLst")
                .map(|l| tree.children_named(l, NS_P14, "sldId").filter_map(|s| tree.node(s).attr("id").and_then(|v| v.parse().ok())).collect())
                .unwrap_or_default()
        })
        .collect();
    Ok((!secs.is_empty()).then_some(secs))
}

fn check_slide(doc: &Presentation, slide: usize) -> Result<(), Error> {
    doc.slide_part(slide).map(|_| ())
}

// ---------------------------------------------------------------- commands

/// Every part reachable from the package root through internal relationships.
pub(super) fn reachable(doc: &Presentation) -> Result<BTreeSet<String>, Error> {
    let mut seen = BTreeSet::new();
    let mut stack: Vec<String> = read_relationships(doc.package(), "_rels/.rels", "")?.into_iter().filter(|r| !r.external).map(|r| r.target).collect();
    while let Some(part) = stack.pop() {
        if !doc.package().contains(&part) || !seen.insert(part.clone()) {
            continue;
        }
        for r in read_relationships(doc.package(), &rels_part_for(&part), &part)? {
            if !r.external {
                stack.push(r.target);
            }
        }
    }
    Ok(seen)
}

pub fn delete_slide(doc: &mut Presentation, slide: usize) -> Result<Value, Error> {
    check_slide(doc, slide)?;
    let entries = slide_entries(doc)?;
    let (id, rid, part) = entries[slide - 1].clone();
    // Any other part linking to this slide (a jump link, a custom show)
    // would be left dangling.
    let pres = doc.presentation_part().to_owned();
    for other in doc.package().part_names().filter(|n| n.ends_with(".rels")).map(str::to_owned).collect::<Vec<_>>() {
        let source = other.replace("/_rels/", "/").trim_end_matches(".rels").to_owned();
        let source = if other == "_rels/.rels" { String::new() } else { source };
        if source == pres || source == part {
            continue;
        }
        if read_relationships(doc.package(), &other, &source)?.iter().any(|r| !r.external && r.target == part && r.rel_type == REL_SLIDE) {
            if source.contains("notesSlide") {
                continue;
            }
            return Err(Error::Unsupported(format!("slide {slide} is linked from {source}")));
        }
    }
    let (_, ptree) = read_tree(doc, &pres)?;
    if ptree.child(ptree.root, NS_P, "custShowLst").is_some() {
        return Err(Error::Unsupported("presentations with custom shows".into()));
    }
    let before = reachable(doc)?;
    let order: Vec<(u32, String)> = entries.iter().filter(|e| e.0 != id).map(|e| (e.0, e.1.clone())).collect();
    let secs = sections(doc)?.map(|s| s.into_iter().map(|l| l.into_iter().filter(|&x| x != id).collect()).collect());
    write_slide_list(doc, &order, secs)?;
    remove_relationship(doc, &pres, &rid)?;
    // Drop what only this slide used (its notes, comments, charts, ...).
    let after = reachable(doc)?;
    let gone: BTreeSet<String> = before.difference(&after).cloned().collect();
    for p in &gone {
        doc.package_mut().remove(p)?;
        let rels = rels_part_for(p);
        if doc.package().contains(&rels) {
            doc.package_mut().remove(&rels)?;
        }
    }
    update_content_types(doc, &[], &gone)?;
    Ok(json!({ "op": "delete_slide", "slide": slide, "removedParts": gone, "changed": true }))
}

/// Copies `part` (and what it owns) under new names; returns the new name.
fn copy_part(doc: &mut Presentation, part: &str, mapped: &mut BTreeMap<String, String>, new_types: &mut Vec<(String, String)>) -> Result<String, Error> {
    if let Some(n) = mapped.get(part) {
        return Ok(n.clone());
    }
    let taken: BTreeSet<String> = mapped.values().cloned().collect();
    let new_name = fresh_name(doc, part, &taken);
    mapped.insert(part.to_owned(), new_name.clone());
    let mut bytes = doc.package().read(part)?.to_vec();
    let mut rels = Vec::new();
    let mut dropped = Vec::new();
    for r in read_relationships(doc.package(), &rels_part_for(part), part)? {
        let raw_target = raw_target(doc, part, &r.id)?;
        if r.external || shared(&r.rel_type) {
            rels.push((r.id.clone(), r.rel_type.clone(), raw_target, r.external));
        } else if is_comments(&r.rel_type) {
            dropped.push(r.id.clone());
        } else if let Some(existing) = mapped.get(&r.target).cloned() {
            rels.push((r.id.clone(), r.rel_type.clone(), relative(&new_name, &existing), false));
        } else if doc.package().contains(&r.target) {
            let copy = copy_part(doc, &r.target, mapped, new_types)?;
            rels.push((r.id.clone(), r.rel_type.clone(), relative(&new_name, &copy), false));
        } else {
            // A relationship to a missing part stays as it was.
            rels.push((r.id.clone(), r.rel_type.clone(), raw_target, false));
        }
    }
    if !dropped.is_empty() {
        bytes = without_references(&bytes, &dropped)?;
    }
    doc.package_mut().write(&new_name, bytes)?;
    if !rels.is_empty() {
        add_relationships(doc, &new_name, &rels)?;
    }
    if let Some(ct) = content_type(doc, part)? {
        new_types.push((new_name.clone(), ct));
    }
    Ok(new_name)
}

/// The `Target` attribute of relationship `id` as written.
pub(super) fn raw_target(doc: &Presentation, source: &str, id: &str) -> Result<String, Error> {
    let (_, tree) = read_tree(doc, &rels_part_for(source))?;
    let target = tree.children_named(tree.root, NS_PKG_REL, "Relationship").find(|&r| tree.node(r).attr("Id") == Some(id)).and_then(|r| tree.node(r).attr("Target").map(str::to_owned));
    target.ok_or_else(|| Error::NotFound(format!("relationship {id}")))
}

/// Removes elements that refer to the given relationship IDs (the modern
/// comments reference `p188:commentRel r:id` inside an extension).
fn without_references(src: &[u8], ids: &[String]) -> Result<Vec<u8>, Error> {
    let tree = Tree::parse(src)?;
    let mut edits = Vec::new();
    for (i, n) in tree.nodes.iter().enumerate() {
        if n.attrs.iter().any(|a| a.ns.as_deref() == Some(NS_R) && ids.contains(&a.value)) {
            // Remove the enclosing p:ext when the reference sits in one.
            let mut target = i;
            if let Some(parent) = n.parent.filter(|&p| tree.node(p).local == "ext") {
                target = parent;
            }
            let t = tree.node(target);
            edits.push((t.start..t.end, Vec::new()));
        }
    }
    edits.sort_by_key(|e| e.0.start);
    edits.dedup_by_key(|e| e.0.start);
    splice(src, edits).map_err(Error::from)
}

pub fn duplicate_slide(doc: &mut Presentation, slide: usize) -> Result<Value, Error> {
    check_slide(doc, slide)?;
    let entries = slide_entries(doc)?;
    let (id, _, part) = entries[slide - 1].clone();
    let mut mapped = BTreeMap::new();
    let mut new_types = Vec::new();
    let new_part = copy_part(doc, &part, &mut mapped, &mut new_types)?;
    let pres = doc.presentation_part().to_owned();
    let rid = fresh_rel_id(doc, &pres, &[])?;
    add_relationships(doc, &pres, &[(rid.clone(), REL_SLIDE.to_owned(), relative(&pres, &new_part), false)])?;
    update_content_types(doc, &new_types, &BTreeSet::new())?;
    let new_id = entries.iter().map(|e| e.0).max().unwrap_or(255).max(255) + 1;
    let mut order: Vec<(u32, String)> = entries.iter().map(|e| (e.0, e.1.clone())).collect();
    order.insert(slide, (new_id, rid));
    let secs = sections(doc)?.map(|s| {
        s.into_iter()
            .map(|mut l| {
                if let Some(k) = l.iter().position(|&x| x == id) {
                    l.insert(k + 1, new_id);
                }
                l
            })
            .collect()
    });
    write_slide_list(doc, &order, secs)?;
    Ok(json!({ "op": "duplicate_slide", "slide": slide, "newSlide": slide + 1, "part": new_part, "addedParts": mapped.values().collect::<Vec<_>>(), "changed": true }))
}

pub fn move_slide(doc: &mut Presentation, slide: usize, to: usize) -> Result<Value, Error> {
    check_slide(doc, slide)?;
    check_slide(doc, to)?;
    let entries = slide_entries(doc)?;
    let mut order: Vec<(u32, String)> = entries.iter().map(|e| (e.0, e.1.clone())).collect();
    let moved = order.remove(slide - 1);
    order.insert(to - 1, moved.clone());
    // Sections stay contiguous: the slide joins the section of the slide
    // now before it (or the first section when it moves to the front).
    let secs = sections(doc)?.map(|mut s| {
        for l in s.iter_mut() {
            l.retain(|&x| x != moved.0);
        }
        match to.checked_sub(2).map(|k| order[k].0) {
            Some(prev) => {
                if let Some(l) = s.iter_mut().find(|l| l.contains(&prev)) {
                    let k = l.iter().position(|&x| x == prev).expect("found");
                    l.insert(k + 1, moved.0);
                }
            }
            None => {
                if let Some(l) = s.first_mut() {
                    l.insert(0, moved.0);
                }
            }
        }
        s
    });
    write_slide_list(doc, &order, secs)?;
    Ok(json!({ "op": "move_slide", "slide": slide, "to": to, "changed": slide != to }))
}

/// Layouts of the presentation's masters as (part, name).
pub(super) fn layouts(doc: &Presentation) -> Result<Vec<(String, String)>, Error> {
    let pres = doc.presentation_part().to_owned();
    let mut out = Vec::new();
    for m in read_relationships(doc.package(), &rels_part_for(&pres), &pres)?.into_iter().filter(|r| r.rel_type.ends_with("/slideMaster")) {
        for l in read_relationships(doc.package(), &rels_part_for(&m.target), &m.target)?.into_iter().filter(|r| r.rel_type == REL_LAYOUT) {
            let (_, tree) = read_tree(doc, &l.target)?;
            let name = tree.child(tree.root, NS_P, "cSld").and_then(|c| tree.node(c).attr("name")).unwrap_or("").to_owned();
            out.push((l.target, name));
        }
    }
    Ok(out)
}

/// Inserts an empty slide at position `at` (default: last) using the layout
/// named `layout` (default: the layout of the slide before it).
pub fn insert_slide(doc: &mut Presentation, at: Option<usize>, layout: Option<&str>) -> Result<Value, Error> {
    let count = doc.slide_count();
    let at = at.unwrap_or(count + 1);
    if at == 0 || at > count + 1 {
        return Err(Error::InvalidCommand(format!("position {at} outside 1..={}", count + 1)));
    }
    let all = layouts(doc)?;
    let layout_part = match layout {
        Some(name) => all.iter().find(|(_, n)| n == name).map(|(p, _)| p.clone()).ok_or_else(|| {
            Error::NotFound(format!("layout {name:?}; available: {}", all.iter().map(|(_, n)| format!("{n:?}")).collect::<Vec<_>>().join(", ")))
        })?,
        None => {
            let near = if at > 1 { at - 1 } else { 1 };
            match doc.slide_part(near) {
                Ok(p) => {
                    let p = p.to_owned();
                    read_relationships(doc.package(), &rels_part_for(&p), &p)?.into_iter().find(|r| r.rel_type == REL_LAYOUT).map(|r| r.target)
                }
                Err(_) => None,
            }
            .or_else(|| all.first().map(|(p, _)| p.clone()))
            .ok_or_else(|| Error::NotFound("slide layout".into()))?
        }
    };
    // Empty placeholders for the layout's content placeholders.
    let (_, lt) = read_tree(doc, &layout_part)?;
    let mut shapes = String::new();
    let mut next_id = 2;
    if let Some(tree_node) = lt.path(lt.root, &[(NS_P, "cSld"), (NS_P, "spTree")]) {
        for &c in &lt.node(tree_node).children {
            let Some(ph) = lt.path(c, &[(NS_P, "nvSpPr"), (NS_P, "nvPr"), (NS_P, "ph")]) else { continue };
            let ph_node = lt.node(ph);
            if matches!(ph_node.attr("type"), Some("dt" | "ftr" | "sldNum" | "hdr")) {
                continue;
            }
            let name = lt.path(c, &[(NS_P, "nvSpPr"), (NS_P, "cNvPr")]).and_then(|n| lt.node(n).attr("name")).unwrap_or("");
            let mut attrs = String::new();
            for a in ["type", "orient", "sz", "idx"] {
                if let Some(v) = ph_node.attr(a) {
                    attrs.push_str(&format!(r#" {a}="{}""#, escape_attr(v)));
                }
            }
            shapes.push_str(&format!(
                r#"<p:sp><p:nvSpPr><p:cNvPr id="{next_id}" name="{}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph{attrs}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></p:txBody></p:sp>"#,
                escape_attr(name)
            ));
            next_id += 1;
        }
    }
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
    );
    let like = doc.slide_part(1).map(str::to_owned).unwrap_or_else(|_| "ppt/slides/slide1.xml".to_owned());
    let new_part = fresh_name(doc, &like, &BTreeSet::new());
    doc.package_mut().write(&new_part, xml.into_bytes())?;
    add_relationships(doc, &new_part, &[("rId1".to_owned(), REL_LAYOUT.to_owned(), relative(&new_part, &layout_part), false)])?;
    let pres = doc.presentation_part().to_owned();
    let rid = fresh_rel_id(doc, &pres, &[])?;
    add_relationships(doc, &pres, &[(rid.clone(), REL_SLIDE.to_owned(), relative(&pres, &new_part), false)])?;
    let covered = content_type(doc, &new_part)?.as_deref() == Some(CT_SLIDE);
    update_content_types(doc, &if covered { vec![] } else { vec![(new_part.clone(), CT_SLIDE.to_owned())] }, &BTreeSet::new())?;
    let entries = slide_entries(doc)?;
    let new_id = entries.iter().map(|e| e.0).max().unwrap_or(255).max(255) + 1;
    let mut order: Vec<(u32, String)> = entries.iter().map(|e| (e.0, e.1.clone())).collect();
    order.insert(at - 1, (new_id, rid));
    let secs = sections(doc)?.map(|mut s| {
        let prev = at.checked_sub(2).and_then(|k| entries.get(k)).map(|e| e.0);
        match prev.and_then(|p| s.iter().position(|l| l.contains(&p)).map(|i| (i, p))) {
            Some((i, p)) => {
                let k = s[i].iter().position(|&x| x == p).expect("found");
                s[i].insert(k + 1, new_id);
            }
            None => {
                if let Some(l) = s.first_mut() {
                    l.insert(0, new_id);
                }
            }
        }
        s
    });
    write_slide_list(doc, &order, secs)?;
    Ok(json!({ "op": "insert_slide", "slide": at, "part": new_part, "layout": layout_part, "changed": true }))
}

/// Sets the slide's name (`p:cSld/@name`).
pub fn rename_slide(doc: &mut Presentation, slide: usize, name: &str) -> Result<Value, Error> {
    if name.chars().any(char::is_control) {
        return Err(Error::InvalidCommand("slide name contains control characters".into()));
    }
    let part = doc.slide_part(slide)?.to_owned();
    let (src, tree) = read_tree(doc, &part)?;
    let c_sld = tree.child(tree.root, NS_P, "cSld").ok_or_else(|| Error::Xml("slide without p:cSld".into()))?;
    let n = tree.node(c_sld);
    let tag = start_tag(&src, &tree, c_sld, &[("name", (!name.is_empty()).then(|| name.to_owned()))], n.is_empty_element())?;
    let updated = splice(&src, vec![(n.start..n.open_end, tag)])?;
    let changed = updated != src;
    doc.package_mut().write(&part, updated)?;
    Ok(json!({ "op": "rename_slide", "slide": slide, "changed": changed }))
}

#[cfg(test)]
mod tests {
    use super::relative;

    #[test]
    fn relative_targets() {
        assert_eq!(relative("ppt/presentation.xml", "ppt/slides/slide3.xml"), "slides/slide3.xml");
        assert_eq!(relative("ppt/slides/slide3.xml", "ppt/slideLayouts/slideLayout2.xml"), "../slideLayouts/slideLayout2.xml");
        assert_eq!(relative("ppt/slides/slide3.xml", "ppt/slides/slide4.xml"), "slide4.xml");
        assert_eq!(relative("ppt/notesSlides/notesSlide2.xml", "ppt/slides/slide9.xml"), "../slides/slide9.xml");
    }
}
