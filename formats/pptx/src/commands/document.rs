//! Presentation-wide settings: document properties, theme colours and
//! fonts, and click actions on shapes.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::shape::{commit, parse_color, target};
use super::slides::{add_relationships, fresh_rel_id, read_tree, relative, REL_SLIDE};
use super::xmledit::{escape_attr, ns_prefix, rebuild, Change};
use crate::xml::{escape_text, splice, NS_A, NS_R};
use crate::{non_visual, read_relationships, rels_part_for, Error, Presentation};

const NS_CP: &str = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
const REL_CORE: &str = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const REL_HYPERLINK: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/// Document properties (File > Properties): title, subject, author,
/// keywords and description. `None` leaves a value as it is.
pub fn set_document_properties(doc: &mut Presentation, values: &[(&str, Option<&str>)]) -> Result<Value, Error> {
    let core = match read_relationships(doc.package(), "_rels/.rels", "")?.into_iter().find(|r| r.rel_type == REL_CORE) {
        Some(r) => r.target,
        None => create_core_properties(doc)?,
    };
    let (src, tree) = read_tree(doc, &core)?;
    let root = tree.node(tree.root);
    let dc = ns_prefix(&src, &tree, NS_DC);
    let cp = ns_prefix(&src, &tree, NS_CP);
    let mut edits = Vec::new();
    let mut appended = String::new();
    for (key, value) in values {
        let Some(value) = value else { continue };
        if value.chars().any(|c| c.is_control() && c != '\t' && c != '\n') {
            return Err(Error::InvalidCommand(format!("{key} contains control characters")));
        }
        let (ns, prefix, local) = match *key {
            "title" | "subject" | "creator" | "description" => (NS_DC, dc.as_deref(), *key),
            "keywords" => (NS_CP, cp.as_deref(), "keywords"),
            _ => unreachable!("fixed keys"),
        };
        let prefix = prefix.ok_or_else(|| Error::Unsupported(format!("document properties do not declare the {local} namespace")))?;
        let text = escape_text(value);
        match root.children.iter().copied().find(|&c| tree.node(c).is(ns, local)) {
            Some(c) => {
                let n = tree.node(c);
                edits.push((n.start..n.end, format!("<{}>{text}</{}>", n.qname, n.qname).into_bytes()));
            }
            None => appended.push_str(&format!("<{prefix}:{local}>{text}</{prefix}:{local}>")),
        }
    }
    if !appended.is_empty() {
        let at = root.close_start;
        edits.push((at..at, appended.into_bytes()));
    }
    let updated = splice(&src, edits)?;
    let changed = updated != src;
    doc.package_mut().write(&core, updated)?;
    Ok(json!({ "op": "set_slide_metadata", "changed": changed }))
}

/// An empty `docProps/core.xml`, related from the package root.
fn create_core_properties(doc: &mut Presentation) -> Result<String, Error> {
    let name = "docProps/core.xml".to_owned();
    if doc.package().contains(&name) {
        return Err(Error::Unsupported("docProps/core.xml exists but is not related from the package".into()));
    }
    let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="{NS_CP}" xmlns:dc="{NS_DC}" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>"#);
    doc.package_mut().write(&name, xml.into_bytes())?;
    let rid = fresh_rel_id(doc, "", &[])?;
    add_relationships(doc, "", &[(rid, REL_CORE.to_owned(), name.clone(), false)])?;
    super::slides::update_content_types(doc, &[(name.clone(), "application/vnd.openxmlformats-package.core-properties+xml".to_owned())], &Default::default())?;
    Ok(name)
}

/// Theme colours (`accent1`..`accent6`, `dk1`, `lt1`, `dk2`, `lt2`,
/// `hlink`, `folHlink` as RRGGBB) and heading/body fonts, in every theme
/// the slide masters use.
pub fn set_master_theme(doc: &mut Presentation, colors: &BTreeMap<String, String>, fonts: &[(&str, &str, Option<&str>)]) -> Result<Value, Error> {
    const SLOTS: &[&str] = &["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
    if let Some(bad) = colors.keys().find(|k| !SLOTS.contains(&k.as_str())) {
        return Err(Error::InvalidCommand(format!("colour slot {bad:?}; one of {}", SLOTS.join(", "))));
    }
    let rgb: BTreeMap<&str, String> = colors.iter().map(|(k, v)| parse_color(v).map(|c| (k.as_str(), c))).collect::<Result<_, _>>()?;
    for (_, _, f) in fonts {
        if f.is_some_and(|f| f.trim().is_empty() || f.chars().any(char::is_control)) {
            return Err(Error::InvalidCommand("font names must be names".into()));
        }
    }
    let pres = doc.presentation_part().to_owned();
    let mut themes = Vec::new();
    for m in read_relationships(doc.package(), &rels_part_for(&pres), &pres)?.into_iter().filter(|r| r.rel_type.ends_with("/slideMaster")) {
        for t in read_relationships(doc.package(), &rels_part_for(&m.target), &m.target)?.into_iter().filter(|r| r.rel_type.ends_with("/theme")) {
            if !themes.contains(&t.target) {
                themes.push(t.target);
            }
        }
    }
    for theme in &themes {
        let (src, tree) = read_tree(doc, theme)?;
        let a = super::xmledit::drawing_prefix(&tree)?;
        let mut edits = Vec::new();
        if let Some(scheme) = tree.nodes.iter().position(|n| n.is(NS_A, "clrScheme")) {
            for &slot in &tree.node(scheme).children {
                let n = tree.node(slot);
                if let Some(c) = rgb.get(n.local.as_str()) {
                    edits.push((n.start..n.end, format!(r#"<{}><{a}srgbClr val="{c}"/></{}>"#, n.qname, n.qname).into_bytes()));
                }
            }
        }
        for (group, script, face) in fonts {
            let Some(face) = face else { continue };
            let Some(g) = tree.nodes.iter().position(|n| n.is(NS_A, group)) else { continue };
            if let Some(el) = tree.child(g, NS_A, script) {
                edits.push((tree.node(el).start..tree.node(el).end, rebuild(&src, &tree, el, &Change { attrs: vec![("typeface", Some(face.to_string())), ("panose", None), ("pitchFamily", None), ("charset", None)], ..Default::default() })?));
            }
        }
        let updated = splice(&src, edits)?;
        doc.package_mut().write(theme, updated)?;
    }
    Ok(json!({ "op": "set_master_theme", "themes": themes, "changed": true }))
}

/// What clicking the shape does in a slide show: `none`, open `url`, jump to
/// `slide` (with `targetSlide`), or `next`, `previous`, `first`, `last`.
pub fn set_object_interaction(doc: &mut Presentation, slide: usize, id: u32, action: &str, url: Option<&str>, target_slide: Option<usize>) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    // Relationship (if any) and action attribute.
    let (rel, ppaction): (Option<(String, String, bool)>, Option<&str>) = match action {
        "none" => (None, None),
        "url" => {
            let u = url.ok_or_else(|| Error::InvalidCommand("url action needs url".into()))?;
            if !(u.starts_with("http://") || u.starts_with("https://") || u.starts_with("mailto:")) {
                return Err(Error::InvalidCommand("url must start with http://, https:// or mailto:".into()));
            }
            (Some((REL_HYPERLINK.to_owned(), u.to_owned(), true)), None)
        }
        "slide" => {
            let n = target_slide.ok_or_else(|| Error::InvalidCommand("slide action needs targetSlide".into()))?;
            let to = doc.slide_part(n)?.to_owned();
            (Some((REL_SLIDE.to_owned(), relative(&part, &to), false)), Some("ppaction://hlinksldjump"))
        }
        "next" => (None, Some("ppaction://hlinkshowjump?jump=nextslide")),
        "previous" => (None, Some("ppaction://hlinkshowjump?jump=previousslide")),
        "first" => (None, Some("ppaction://hlinkshowjump?jump=firstslide")),
        "last" => (None, Some("ppaction://hlinkshowjump?jump=lastslide")),
        other => return Err(Error::InvalidCommand(format!("action must be none, url, slide, next, previous, first or last, got {other:?}"))),
    };
    let rid = match rel {
        Some((ty, target, external)) => {
            let rid = fresh_rel_id(doc, &part, &[])?;
            add_relationships(doc, &part, &[(rid.clone(), ty, target, external)])?;
            Some(rid)
        }
        None => None,
    };
    let t = target(doc, slide, id)?;
    let cnv = non_visual(&t.tree, t.shape).ok_or_else(|| Error::Unsupported("shape without non-visual properties".into()))?;
    let a = super::xmledit::drawing_prefix(&t.tree)?;
    let r = ns_prefix(&t.src, &t.tree, NS_R).unwrap_or_else(|| "r".into());
    let insert = if action == "none" {
        vec![]
    } else {
        let act = ppaction.map(|p| format!(r#" action="{}""#, escape_attr(p))).unwrap_or_default();
        vec![("hlinkClick", format!(r#"<{a}hlinkClick {r}:id="{}"{act}/>"#, rid.unwrap_or_default()).into_bytes())]
    };
    let change = Change { remove: vec!["hlinkClick"], insert, order: &["hlinkClick", "hlinkHover", "extLst"], ..Default::default() };
    let n = t.tree.node(cnv);
    let changed = commit(doc, &t, vec![(n.start..n.end, rebuild(&t.src, &t.tree, cnv, &change)?)])?;
    Ok(json!({ "op": "set_object_interaction", "slide": slide, "shapeId": id, "changed": changed }))
}
