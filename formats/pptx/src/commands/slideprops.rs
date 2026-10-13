//! Per-slide and presentation settings: background, transition, slide
//! size, sections, layout and speaker notes.

use std::collections::BTreeSet;

use serde_json::{json, Value};
use sha2::Digest;

use super::slides::{add_relationships, fresh_name, fresh_rel_id, layouts, read_tree, relative, slide_entries, update_content_types, NS_P14, REL_LAYOUT, REL_SLIDE};
use super::xmledit::{drawing_prefix, escape_attr, start_tag};
use super::{paragraph_edits, EMU_PER_PT};
use crate::xml::{escape_text, splice, NS_A, NS_P, NS_PKG_REL};
use crate::{read_relationships, rels_part_for, Error, Presentation};

const NS_MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const REL_NOTES: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const REL_NOTES_MASTER: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const CT_NOTES: &str = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const SECTIONS_URI: &str = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}";

fn write(doc: &mut Presentation, part: &str, src: &[u8], edits: Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<bool, Error> {
    let updated = splice(src, edits)?;
    let changed = updated != src;
    doc.package_mut().write(part, updated)?;
    Ok(changed)
}

/// A solid background colour, or `None` to inherit the layout's.
pub fn set_background(doc: &mut Presentation, slide: usize, color: Option<&str>) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let (src, tree) = read_tree(doc, &part)?;
    let c_sld = tree.child(tree.root, NS_P, "cSld").ok_or_else(|| Error::Xml("slide without p:cSld".into()))?;
    let p = tree.node(c_sld).prefix().to_owned();
    let a = drawing_prefix(&tree)?;
    let insert = match color {
        Some(c) => {
            let rgb = super::shape::parse_color(c)?;
            vec![("bg", format!(r#"<{p}bg><{p}bgPr><{a}solidFill><{a}srgbClr val="{rgb}"/></{a}solidFill><{a}effectLst/></{p}bgPr></{p}bg>"#).into_bytes())]
        }
        None => vec![],
    };
    let new_bg = insert.into_iter().next().map(|(_, b)| b).unwrap_or_default();
    let edits = match tree.child(c_sld, NS_P, "bg") {
        Some(bg) => vec![(tree.node(bg).start..tree.node(bg).end, new_bg)],
        None => {
            let at = tree.node(c_sld).open_end;
            vec![(at..at, new_bg)]
        }
    };
    let changed = write(doc, &part, &src, edits)?;
    Ok(json!({ "op": "set_background", "slide": slide, "changed": changed }))
}

/// Slide transition: `none`, `fade`, `push`, `wipe`, `split`, `cover`,
/// `cut`, `dissolve` or `zoom`, with `speed` (`slow`, `med`, `fast`) and,
/// for push/wipe/cover, `direction` (`l`, `r`, `u`, `d`).
pub fn set_slide_transition(doc: &mut Presentation, slide: usize, kind: &str, speed: Option<&str>, direction: Option<&str>) -> Result<Value, Error> {
    const KINDS: &[&str] = &["none", "fade", "push", "wipe", "split", "cover", "cut", "dissolve", "zoom"];
    if !KINDS.contains(&kind) {
        return Err(Error::InvalidCommand(format!("transition {kind:?}; one of {}", KINDS.join(", "))));
    }
    let spd = speed.unwrap_or("med");
    if !matches!(spd, "slow" | "med" | "fast") {
        return Err(Error::InvalidCommand("speed must be slow, med or fast".into()));
    }
    let dir = match direction {
        None => None,
        Some(d @ ("l" | "r" | "u" | "d")) => Some(d),
        Some(other) => return Err(Error::InvalidCommand(format!("direction must be l, r, u or d, got {other:?}"))),
    };
    let part = doc.slide_part(slide)?.to_owned();
    let (src, tree) = read_tree(doc, &part)?;
    let p = tree.node(tree.root).prefix().to_owned();
    let mut edits = Vec::new();
    // Drop the existing transition, including a PowerPoint 2010+ one
    // wrapped in alternate content.
    for &c in &tree.node(tree.root).children {
        let n = tree.node(c);
        let is_transition = n.is(NS_P, "transition") || (n.ns.as_deref() == Some(NS_MC) && n.local == "AlternateContent" && tree.nodes.iter().any(|x| x.local == "transition" && x.start > n.start && x.end < n.end));
        if is_transition {
            edits.push((n.start..n.end, Vec::new()));
        }
    }
    if kind != "none" {
        let effect = match (kind, dir) {
            ("push" | "wipe" | "cover", Some(d)) => format!(r#"<{p}{kind} dir="{d}"/>"#),
            _ => format!("<{p}{kind}/>"),
        };
        let xml = format!(r#"<{p}transition spd="{spd}">{effect}</{p}transition>"#);
        // After cSld and clrMapOvr.
        let after = tree.node(tree.root).children.iter().copied().filter(|&c| matches!(tree.node(c).local.as_str(), "cSld" | "clrMapOvr")).last().ok_or_else(|| Error::Xml("slide without p:cSld".into()))?;
        let at = tree.node(after).end;
        edits.push((at..at, xml.into_bytes()));
    }
    edits.sort_by_key(|e| e.0.start);
    let changed = write(doc, &part, &src, edits)?;
    Ok(json!({ "op": "set_slide_transition", "slide": slide, "changed": changed }))
}

/// Slide size in points. Content is not scaled (PowerPoint's "Don't scale").
pub fn set_slide_size(doc: &mut Presentation, width: f64, height: f64) -> Result<Value, Error> {
    let ok = |v: f64| v.is_finite() && (72.0..=4032.0).contains(&v);
    if !ok(width) || !ok(height) {
        return Err(Error::InvalidCommand("slide width and height must be 72 to 4032 pt (1 to 56 inches)".into()));
    }
    let pres = doc.presentation_part().to_owned();
    let (src, tree) = read_tree(doc, &pres)?;
    let size = tree.child(tree.root, NS_P, "sldSz").ok_or_else(|| Error::Unsupported("presentation without sldSz".into()))?;
    let n = tree.node(size);
    let e = |v: f64| ((v * EMU_PER_PT).round() as i64).to_string();
    let tag = start_tag(&src, &tree, size, &[("cx", Some(e(width))), ("cy", Some(e(height))), ("type", None)], n.is_empty_element())?;
    let end = if n.is_empty_element() { n.end } else { n.open_end };
    let changed = write(doc, &pres, &src, vec![(n.start..end, tag)])?;
    Ok(json!({ "op": "set_slide_size", "changed": changed }))
}

/// A stable section id derived from its position and name.
fn section_guid(k: usize, name: &str) -> String {
    let h = sha2::Sha256::digest(format!("{k}:{name}").as_bytes());
    let x: String = h.iter().take(16).map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

/// Replaces the presentation's sections. Each slide belongs to exactly one
/// section, in slide order. An empty list removes sections.
pub fn set_sections(doc: &mut Presentation, sections: &[(String, Vec<usize>)]) -> Result<Value, Error> {
    let entries = slide_entries(doc)?;
    let flat: Vec<usize> = sections.iter().flat_map(|(_, s)| s.iter().copied()).collect();
    if !sections.is_empty() && flat != (1..=entries.len()).collect::<Vec<_>>() {
        return Err(Error::InvalidCommand(format!("sections must list slides 1..={} in order, each once", entries.len())));
    }
    if sections.iter().any(|(n, _)| n.chars().any(char::is_control)) {
        return Err(Error::InvalidCommand("section names cannot contain control characters".into()));
    }
    let pres = doc.presentation_part().to_owned();
    let (src, tree) = read_tree(doc, &pres)?;
    let p = tree.node(tree.root).prefix().to_owned();
    let list: String = sections
        .iter()
        .enumerate()
        .map(|(k, (name, slides))| {
            let ids: String = slides.iter().map(|&s| format!(r#"<p14:sldId id="{}"/>"#, entries[s - 1].0)).collect();
            format!(r#"<p14:section name="{}" id="{}"><p14:sldIdLst>{ids}</p14:sldIdLst></p14:section>"#, escape_attr(name), section_guid(k, name))
        })
        .collect();
    let ext = format!(r#"<{p}ext uri="{SECTIONS_URI}"><p14:sectionLst xmlns:p14="{NS_P14}">{list}</p14:sectionLst></{p}ext>"#);
    let ext_lst = tree.child(tree.root, NS_P, "extLst");
    let old = ext_lst.and_then(|l| tree.children_named(l, NS_P, "ext").find(|&e| tree.node(e).attr("uri") == Some(SECTIONS_URI)));
    let mut edits = Vec::new();
    match (old, ext_lst, sections.is_empty()) {
        (Some(e), _, true) => edits.push((tree.node(e).start..tree.node(e).end, Vec::new())),
        (Some(e), _, false) => edits.push((tree.node(e).start..tree.node(e).end, ext.into_bytes())),
        (None, _, true) => {}
        (None, Some(l), false) => edits.push((tree.node(l).open_end..tree.node(l).open_end, ext.into_bytes())),
        (None, None, false) => {
            let at = tree.node(tree.root).close_start;
            edits.push((at..at, format!("<{p}extLst>{ext}</{p}extLst>").into_bytes()));
        }
    }
    let changed = write(doc, &pres, &src, edits)?;
    Ok(json!({ "op": "set_sections", "sections": sections.len(), "changed": changed }))
}

/// Switches the slide to the layout named `layout`. Placeholders that the
/// new layout has no match for keep their current position (written into
/// the slide) instead of losing it.
pub fn set_slide_layout(doc: &mut Presentation, slide: usize, layout: &str) -> Result<Value, Error> {
    let all = layouts(doc)?;
    let new_layout = all.iter().find(|(_, n)| n == layout).map(|(p, _)| p.clone()).ok_or_else(|| {
        Error::NotFound(format!("layout {layout:?}; available: {}", all.iter().map(|(_, n)| format!("{n:?}")).collect::<Vec<_>>().join(", ")))
    })?;
    let part = doc.slide_part(slide)?.to_owned();
    // Placeholders of the new layout as (type, idx).
    let (_, lt) = read_tree(doc, &new_layout)?;
    let layout_ph: Vec<(String, Option<String>)> = lt.nodes.iter().filter(|n| n.local == "ph").map(|n| (n.attr("type").unwrap_or("body").to_owned(), n.attr("idx").map(str::to_owned))).collect();
    let (_, st) = read_tree(doc, &part)?;
    let mut keep = Vec::new();
    for (i, n) in st.nodes.iter().enumerate() {
        if n.local != "ph" {
            continue;
        }
        let ty = n.attr("type").unwrap_or("body");
        let idx = n.attr("idx");
        let matched = layout_ph.iter().any(|(t, x)| (idx.is_some() && x.as_deref() == idx) || t == ty || (ty == "title" && t == "ctrTitle") || (ty == "ctrTitle" && t == "title"));
        if matched {
            continue;
        }
        // The shape holding this placeholder.
        let mut at = Some(i);
        while let Some(k) = at {
            if matches!(st.node(k).local.as_str(), "sp" | "pic" | "graphicFrame") && st.node(k).ns.as_deref() == Some(NS_P) {
                break;
            }
            at = st.node(k).parent;
        }
        if let Some(id) = at.and_then(|k| crate::shape_id(&st, k)) {
            keep.push(id);
        }
    }
    for id in &keep {
        if let Ok([x, y, _, _]) = super::shape::slide_frame(doc, slide, *id) {
            super::shape::move_to(doc, slide, *id, x, y)?;
        }
    }
    // Repoint the layout relationship.
    let rels_part = rels_part_for(&part);
    let (src, tree) = read_tree(doc, &rels_part)?;
    let rel = tree.children_named(tree.root, NS_PKG_REL, "Relationship").find(|&r| tree.node(r).attr("Type") == Some(REL_LAYOUT)).ok_or_else(|| Error::Xml("slide without a layout relationship".into()))?;
    let n = tree.node(rel);
    let tag = start_tag(&src, &tree, rel, &[("Target", Some(relative(&part, &new_layout)))], n.is_empty_element())?;
    let end = if n.is_empty_element() { n.end } else { n.open_end };
    write(doc, &rels_part, &src, vec![(n.start..end, tag)])?;
    Ok(json!({ "op": "set_slide_layout", "slide": slide, "layout": new_layout, "keptPositions": keep, "changed": true }))
}

/// Replaces the slide's speaker notes, creating the notes page if needed.
pub fn set_speaker_notes(doc: &mut Presentation, slide: usize, paragraphs: &[String]) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let wanted: Vec<String> = if paragraphs.is_empty() { vec![String::new()] } else { paragraphs.to_vec() };
    let existing = read_relationships(doc.package(), &rels_part_for(&part), &part)?.into_iter().find(|r| r.rel_type == REL_NOTES).map(|r| r.target);
    if let Some(notes) = existing {
        let (src, tree) = read_tree(doc, &notes)?;
        let body = tree
            .nodes
            .iter()
            .position(|n| n.local == "ph" && n.attr("type") == Some("body"))
            .and_then(|ph| {
                let mut at = tree.node(ph).parent;
                while let Some(k) = at {
                    if tree.node(k).is(NS_P, "sp") {
                        return tree.child(k, NS_P, "txBody");
                    }
                    at = tree.node(k).parent;
                }
                None
            })
            .ok_or_else(|| Error::Unsupported("notes page without a notes text placeholder".into()))?;
        let edits = paragraph_edits(&tree, &src, body, &wanted)?;
        let changed = write(doc, &notes, &src, edits)?;
        return Ok(json!({ "op": "set_speaker_notes", "slide": slide, "part": notes, "changed": changed }));
    }
    let pres = doc.presentation_part().to_owned();
    let master = match read_relationships(doc.package(), &rels_part_for(&pres), &pres)?.into_iter().find(|r| r.rel_type == REL_NOTES_MASTER) {
        Some(r) => r.target,
        None => create_notes_master(doc)?,
    };
    for text in &wanted {
        if text.chars().any(|c| c.is_control() && c != '\t' && c != '\u{b}') {
            return Err(Error::InvalidCommand("notes contain control characters".into()));
        }
    }
    let paras: String = wanted
        .iter()
        .map(|t| if t.is_empty() { r#"<a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p>"#.to_owned() } else { format!(r#"<a:p><a:r><a:rPr lang="ko-KR" altLang="en-US"/><a:t>{}</a:t></a:r></a:p>"#, escape_text(t)) })
        .collect();
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="{NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="{NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"#
    );
    let notes = fresh_name(doc, "ppt/notesSlides/notesSlide1.xml", &BTreeSet::new());
    doc.package_mut().write(&notes, xml.into_bytes())?;
    add_relationships(doc, &notes, &[("rId1".into(), REL_NOTES_MASTER.into(), relative(&notes, &master), false), ("rId2".into(), REL_SLIDE.into(), relative(&notes, &part), false)])?;
    let rid = fresh_rel_id(doc, &part, &[])?;
    add_relationships(doc, &part, &[(rid, REL_NOTES.into(), relative(&part, &notes), false)])?;
    update_content_types(doc, &[(notes.clone(), CT_NOTES.into())], &BTreeSet::new())?;
    Ok(json!({ "op": "set_speaker_notes", "slide": slide, "part": notes, "changed": true }))
}

/// A notes master like PowerPoint's default (slide image above, notes text
/// below on a portrait page), with its own copy of the first slide master's
/// theme, registered in the presentation.
fn create_notes_master(doc: &mut Presentation) -> Result<String, Error> {
    const CT_NOTES_MASTER: &str = "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";
    const CT_THEME: &str = "application/vnd.openxmlformats-officedocument.theme+xml";
    let pres = doc.presentation_part().to_owned();
    let pres_rels = read_relationships(doc.package(), &rels_part_for(&pres), &pres)?;
    let slide_master = pres_rels.iter().find(|r| r.rel_type.ends_with("/slideMaster")).map(|r| r.target.clone()).ok_or_else(|| Error::Unsupported("presentation without a slide master".into()))?;
    let theme_src = read_relationships(doc.package(), &rels_part_for(&slide_master), &slide_master)?.into_iter().find(|r| r.rel_type.ends_with("/theme")).map(|r| r.target).ok_or_else(|| Error::Unsupported("slide master without a theme".into()))?;
    let theme_bytes = doc.package().read(&theme_src)?.to_vec();
    let theme = fresh_name(doc, &theme_src, &BTreeSet::new());
    doc.package_mut().write(&theme, theme_bytes)?;
    let (pres_src, pres_tree) = read_tree(doc, &pres)?;
    let notes_size = pres_tree.child(pres_tree.root, NS_P, "notesSz");
    let (w, h) = notes_size
        .and_then(|n| Some((pres_tree.node(n).attr("cx")?.parse::<i64>().ok()?, pres_tree.node(n).attr("cy")?.parse::<i64>().ok()?)))
        .unwrap_or((6858000, 9144000));
    let (iw, ih) = (w * 8 / 10, h * 3 / 10);
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="{NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="{NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{iw}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{iw}" cy="{ih}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:endParaRPr lang="ko-KR"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>"#,
        (w - iw) / 2,
        h / 10,
        h * 4 / 10,
        (w - iw) / 2,
        h * 55 / 100,
    );
    let master = fresh_name(doc, "ppt/notesMasters/notesMaster1.xml", &BTreeSet::new());
    doc.package_mut().write(&master, xml.into_bytes())?;
    add_relationships(doc, &master, &[("rId1".into(), "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme".into(), relative(&master, &theme), false)])?;
    let rid = fresh_rel_id(doc, &pres, &[])?;
    add_relationships(doc, &pres, &[(rid.clone(), REL_NOTES_MASTER.into(), relative(&pres, &master), false)])?;
    update_content_types(doc, &[(master.clone(), CT_NOTES_MASTER.into()), (theme.clone(), CT_THEME.into())], &BTreeSet::new())?;
    // The notes master list goes right after the slide master list.
    let p = pres_tree.node(pres_tree.root).prefix().to_owned();
    let r = super::xmledit::ns_prefix(&pres_src, &pres_tree, "http://schemas.openxmlformats.org/officeDocument/2006/relationships").unwrap_or_else(|| "r".into());
    let after = pres_tree.child(pres_tree.root, NS_P, "sldMasterIdLst").ok_or_else(|| Error::Xml("presentation without sldMasterIdLst".into()))?;
    let at = pres_tree.node(after).end;
    let list = format!(r#"<{p}notesMasterIdLst><{p}notesMasterId {r}:id="{rid}"/></{p}notesMasterIdLst>"#);
    let mut edits = vec![(at..at, list.into_bytes())];
    if notes_size.is_none() {
        let size = pres_tree.child(pres_tree.root, NS_P, "sldSz").ok_or_else(|| Error::Xml("presentation without sldSz".into()))?;
        let at = pres_tree.node(size).end;
        edits.push((at..at, format!(r#"<{p}notesSz cx="{w}" cy="{h}"/>"#).into_bytes()));
    }
    let updated = splice(&pres_src, edits)?;
    doc.package_mut().write(&pres, updated)?;
    Ok(master)
}
