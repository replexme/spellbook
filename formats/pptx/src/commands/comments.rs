//! Slide comments in either format PowerPoint writes: classic comments
//! (`p:cmLst`, authors in `commentAuthors.xml`, ids `author:index`) and
//! modern threaded comments (`p188:cmLst`, authors in `authors.xml`, GUID
//! ids). A deck keeps the format it already uses; one without comments
//! gets classic comments.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::Digest;

use super::slides::{add_relationships, fresh_name, fresh_rel_id, read_tree, relative, update_content_types};
use super::xmledit::escape_attr;
use crate::xml::{escape_text, splice, Tree, NS_A};
use crate::{read_relationships, rels_part_for, Error, Presentation};

const REL_CLASSIC: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const REL_CLASSIC_AUTHORS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors";
const REL_MODERN: &str = "http://schemas.microsoft.com/office/2018/10/relationships/comments";
const REL_MODERN_AUTHORS: &str = "http://schemas.microsoft.com/office/2018/10/relationships/authors";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_P188: &str = "http://schemas.microsoft.com/office/powerpoint/2018/8/main";
const CT_CLASSIC: &str = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml";
const CT_CLASSIC_AUTHORS: &str = "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml";

/// A comment as `observe` reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub text: String,
}

fn rel_target(doc: &Presentation, source: &str, ty: &str) -> Result<Option<String>, Error> {
    Ok(read_relationships(doc.package(), &rels_part_for(source), source)?.into_iter().find(|r| r.rel_type == ty).map(|r| r.target))
}

/// Text of a comment element: `p:text` (classic) or the paragraphs of
/// `p188:txBody` (modern).
fn comment_text(tree: &Tree, src: &[u8], cm: usize) -> Result<String, Error> {
    if let Some(t) = tree.child(cm, NS_P, "text") {
        return tree.text(src, t).map_err(Error::from);
    }
    let Some(body) = tree.child(cm, NS_P188, "txBody") else { return Ok(String::new()) };
    Ok(crate::paragraph_texts(tree, src, body)?.join("\n"))
}

/// The slide's comments, in file order.
pub fn slide_comments(doc: &Presentation, slide: usize) -> Result<Vec<Comment>, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let pres = doc.presentation_part().to_owned();
    let mut out = Vec::new();
    for (rel, modern) in [(REL_CLASSIC, false), (REL_MODERN, true)] {
        let Some(list) = rel_target(doc, &part, rel)? else { continue };
        let (src, tree) = read_tree(doc, &list)?;
        let authors_rel = if modern { REL_MODERN_AUTHORS } else { REL_CLASSIC_AUTHORS };
        let authors = match rel_target(doc, &pres, authors_rel)? {
            Some(a) => Some(read_tree(doc, &a)?),
            None => None,
        };
        let author_name = |aid: &str| -> String {
            authors.as_ref().and_then(|(_, at)| at.nodes.iter().find(|n| (n.local == "cmAuthor" || n.local == "author") && n.attr("id") == Some(aid)).and_then(|n| n.attr("name").map(str::to_owned))).unwrap_or_default()
        };
        for (i, n) in tree.nodes.iter().enumerate() {
            if n.local != "cm" || n.parent != Some(tree.root) {
                continue;
            }
            let aid = n.attr("authorId").unwrap_or("");
            let id = if modern { n.attr("id").unwrap_or("").to_owned() } else { format!("{aid}:{}", n.attr("idx").unwrap_or("")) };
            out.push(Comment { id, author: author_name(aid), text: comment_text(&tree, &src, i)? });
        }
    }
    Ok(out)
}

/// A GUID in braces derived from `seed`.
fn guid(seed: &str) -> String {
    let h = sha2::Sha256::digest(seed.as_bytes());
    let x: String = h.iter().take(16).map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

fn check_text(text: &str) -> Result<(), Error> {
    if text.trim().is_empty() || text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(Error::InvalidCommand("comment text must be non-empty, without control characters".into()));
    }
    Ok(())
}

/// Adds a comment by `author` at (`x`, `y`) slide points; returns its id.
pub fn add_comment(doc: &mut Presentation, slide: usize, text: &str, author: &str, x: f64, y: f64, now: &str) -> Result<Value, Error> {
    check_text(text)?;
    if author.trim().is_empty() || author.chars().any(char::is_control) {
        return Err(Error::InvalidCommand("author must be a name".into()));
    }
    let part = doc.slide_part(slide)?.to_owned();
    let pres = doc.presentation_part().to_owned();
    if rel_target(doc, &pres, REL_MODERN_AUTHORS)?.is_some() {
        return add_modern(doc, slide, &part, &pres, text, author, now);
    }
    // Classic: author list (created when missing), then the slide's list.
    let authors = match rel_target(doc, &pres, REL_CLASSIC_AUTHORS)? {
        Some(a) => a,
        None => {
            let name = "ppt/commentAuthors.xml".to_owned();
            let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmAuthorLst xmlns:a="{NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="{NS_P}"></p:cmAuthorLst>"#);
            doc.package_mut().write(&name, xml.into_bytes())?;
            let rid = fresh_rel_id(doc, &pres, &[])?;
            add_relationships(doc, &pres, &[(rid, REL_CLASSIC_AUTHORS.into(), relative(&pres, &name), false)])?;
            update_content_types(doc, &[(name.clone(), CT_CLASSIC_AUTHORS.into())], &BTreeSet::new())?;
            name
        }
    };
    let (asrc, atree) = read_tree(doc, &authors)?;
    let root = atree.node(atree.root);
    let p = root.prefix().to_owned();
    let existing = root.children.iter().copied().find(|&c| atree.node(c).attr("name") == Some(author));
    let (aid, idx, edits) = match existing {
        Some(c) => {
            let n = atree.node(c);
            let aid: u32 = n.attr("id").and_then(|v| v.parse().ok()).unwrap_or(0);
            let idx = n.attr("lastIdx").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) + 1;
            let tag = super::xmledit::start_tag(&asrc, &atree, c, &[("lastIdx", Some(idx.to_string()))], n.is_empty_element())?;
            let end = if n.is_empty_element() { n.end } else { n.open_end };
            (aid, idx, vec![(n.start..end, tag)])
        }
        None => {
            let aid = root.children.iter().filter_map(|&c| atree.node(c).attr("id")?.parse::<u32>().ok()).max().map(|m| m + 1).unwrap_or(0);
            let initials: String = author.split_whitespace().filter_map(|w| w.chars().next()).collect();
            let el = format!(r#"<{p}cmAuthor id="{aid}" name="{}" initials="{}" lastIdx="1" clrIdx="{}"/>"#, escape_attr(author), escape_attr(&initials), aid % 7);
            let at = root.close_start;
            (aid, 1, vec![(at..at, el.into_bytes())])
        }
    };
    let updated = splice(&asrc, edits)?;
    doc.package_mut().write(&authors, updated)?;
    let cm = format!(
        r#"<p:cm authorId="{aid}" dt="{}" idx="{idx}"><p:pos x="{}" y="{}"/><p:text>{}</p:text></p:cm>"#,
        escape_attr(now),
        (x * 8.0).round() as i64,
        (y * 8.0).round() as i64,
        escape_text(text)
    );
    match rel_target(doc, &part, REL_CLASSIC)? {
        Some(list) => {
            let (src, tree) = read_tree(doc, &list)?;
            let root = tree.node(tree.root);
            let cm = if root.prefix() == "p:" { cm } else { cm.replace("<p:", &format!("<{}", root.prefix())).replace("</p:", &format!("</{}", root.prefix())) };
            let updated = if root.is_empty_element() {
                let mut out = src[..root.start].to_vec();
                out.extend(super::xmledit::start_tag(&src, &tree, tree.root, &[], false)?);
                out.extend(cm.into_bytes());
                out.extend(format!("</{}>", root.qname).into_bytes());
                out
            } else {
                splice(&src, vec![(root.close_start..root.close_start, cm.into_bytes())])?
            };
            doc.package_mut().write(&list, updated)?;
        }
        None => {
            let name = fresh_name(doc, "ppt/comments/comment1.xml", &BTreeSet::new());
            let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmLst xmlns:a="{NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="{NS_P}">{cm}</p:cmLst>"#);
            doc.package_mut().write(&name, xml.into_bytes())?;
            let rid = fresh_rel_id(doc, &part, &[])?;
            add_relationships(doc, &part, &[(rid, REL_CLASSIC.into(), relative(&part, &name), false)])?;
            update_content_types(doc, &[(name, CT_CLASSIC.into())], &BTreeSet::new())?;
        }
    }
    Ok(json!({ "op": "add_comment", "slide": slide, "commentId": format!("{aid}:{idx}"), "changed": true }))
}

/// Modern comments: the author list exists; the slide's list may not.
fn add_modern(doc: &mut Presentation, slide: usize, part: &str, pres: &str, text: &str, author: &str, now: &str) -> Result<Value, Error> {
    let list = match rel_target(doc, part, REL_MODERN)? {
        Some(l) => l,
        None => create_modern_list(doc, slide, part)?,
    };
    let authors = rel_target(doc, pres, REL_MODERN_AUTHORS)?.expect("checked by caller");
    let (asrc, atree) = read_tree(doc, &authors)?;
    let root = atree.node(atree.root);
    let aid = match root.children.iter().copied().find(|&c| atree.node(c).attr("name") == Some(author)) {
        Some(c) => atree.node(c).attr("id").unwrap_or("").to_owned(),
        None => {
            let aid = guid(&format!("author:{author}"));
            let initials: String = author.split_whitespace().filter_map(|w| w.chars().next()).collect();
            let el = format!(r#"<{}author id="{aid}" name="{}" initials="{}" userId="{}" providerId="None"/>"#, root.prefix(), escape_attr(author), escape_attr(&initials), escape_attr(author));
            let updated = splice(&asrc, vec![(root.close_start..root.close_start, el.into_bytes())])?;
            doc.package_mut().write(&authors, updated)?;
            aid
        }
    };
    let (src, tree) = read_tree(doc, &list)?;
    let lr = tree.node(tree.root);
    let pp = lr.prefix().to_owned();
    let marker = slide_marker(doc, slide, part)?;
    let id = guid(&format!("{slide}:{now}:{text}"));
    let paras: String = text.split('\n').map(|l| format!(r#"<a:p><a:r><a:rPr lang="ko-KR" altLang="en-US"/><a:t>{}</a:t></a:r></a:p>"#, escape_text(l))).collect();
    let cm = format!(r#"<{pp}cm id="{id}" authorId="{aid}" created="{}">{marker}<{pp}txBody><a:bodyPr/><a:lstStyle/>{paras}</{pp}txBody></{pp}cm>"#, escape_attr(now));
    let updated = splice(&src, vec![(lr.close_start..lr.close_start, cm.into_bytes())])?;
    doc.package_mut().write(&list, updated)?;
    Ok(json!({ "op": "add_comment", "slide": slide, "commentId": id, "changed": true }))
}

/// The slide's `p14:creationId` and `sldId`, which modern comments use to
/// anchor themselves.
fn slide_ids(doc: &Presentation, slide: usize, part: &str) -> Result<(u32, u32), Error> {
    let (_, tree) = read_tree(doc, part)?;
    let creation = tree
        .nodes
        .iter()
        .find(|n| n.local == "creationId" && n.ns.as_deref() == Some("http://schemas.microsoft.com/office/powerpoint/2010/main"))
        .and_then(|n| n.attr("val")?.parse().ok())
        .ok_or_else(|| Error::Unsupported("slide without a creation id for modern comments".into()))?;
    let sld_id = super::slides::slide_entries(doc)?.get(slide - 1).map(|e| e.0).ok_or_else(|| Error::NotFound(format!("slide {slide}")))?;
    Ok((creation, sld_id))
}

fn slide_marker(doc: &Presentation, slide: usize, part: &str) -> Result<String, Error> {
    let (creation, sld_id) = slide_ids(doc, slide, part)?;
    Ok(format!(r#"<pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk cId="{creation}" sldId="{sld_id}"/></pc:sldMkLst>"#))
}

/// An empty modern comment list for the slide, named as PowerPoint names
/// it and linked from the slide's extension list.
fn create_modern_list(doc: &mut Presentation, slide: usize, part: &str) -> Result<String, Error> {
    let (creation, sld_id) = slide_ids(doc, slide, part)?;
    let name = format!("ppt/comments/modernComment_{sld_id:X}_{creation:X}.xml");
    if doc.package().contains(&name) {
        return Err(Error::Unsupported(format!("{name} exists but is not linked from the slide")));
    }
    let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p188:cmLst xmlns:a="{NS_A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="{NS_P188}"></p188:cmLst>"#);
    doc.package_mut().write(&name, xml.into_bytes())?;
    let rid = fresh_rel_id(doc, part, &[])?;
    add_relationships(doc, part, &[(rid.clone(), REL_MODERN.into(), relative(part, &name), false)])?;
    update_content_types(doc, &[(name.clone(), "application/vnd.ms-powerpoint.comments+xml".into())], &BTreeSet::new())?;
    // The slide points at its comments from its own extension list.
    let (src, tree) = read_tree(doc, part)?;
    let root = tree.node(tree.root);
    let p = root.prefix().to_owned();
    let r = super::xmledit::ns_prefix(&src, &tree, "http://schemas.openxmlformats.org/officeDocument/2006/relationships").unwrap_or_else(|| "r".into());
    let ext = format!(r#"<{p}ext uri="{{6950BFC3-D8DA-4A85-94F7-54DA5524770B}}"><p188:commentRel xmlns:p188="{NS_P188}" {r}:id="{rid}"/></{p}ext>"#);
    let ext_lst = root.children.iter().copied().find(|&c| tree.node(c).local == "extLst" && tree.node(c).ns.as_deref() == Some(NS_P));
    let edit = match ext_lst {
        Some(l) if !tree.node(l).is_empty_element() => (tree.node(l).close_start..tree.node(l).close_start, ext.into_bytes()),
        Some(l) => (tree.node(l).start..tree.node(l).end, format!("<{p}extLst>{ext}</{p}extLst>").into_bytes()),
        None => (root.close_start..root.close_start, format!("<{p}extLst>{ext}</{p}extLst>").into_bytes()),
    };
    let updated = splice(&src, vec![edit])?;
    doc.package_mut().write(part, updated)?;
    Ok(name)
}

/// The comment list part and the comment element for `id` on the slide.
fn find(doc: &Presentation, slide: usize, id: &str) -> Result<(String, Vec<u8>, Tree, usize), Error> {
    let part = doc.slide_part(slide)?.to_owned();
    for rel in [REL_CLASSIC, REL_MODERN] {
        let Some(list) = rel_target(doc, &part, rel)? else { continue };
        let (src, tree) = read_tree(doc, &list)?;
        let found = tree.nodes.iter().enumerate().find(|(_, n)| {
            n.local == "cm" && n.parent == Some(tree.root) && (n.attr("id") == Some(id) || format!("{}:{}", n.attr("authorId").unwrap_or(""), n.attr("idx").unwrap_or("")) == id)
        });
        if let Some((i, _)) = found {
            return Ok((list, src, tree, i));
        }
    }
    Err(Error::NotFound(format!("comment {id} on slide {slide}")))
}

pub fn edit_comment(doc: &mut Presentation, slide: usize, id: &str, text: &str) -> Result<Value, Error> {
    check_text(text)?;
    let (list, src, tree, cm) = find(doc, slide, id)?;
    let edit = if let Some(t) = tree.child(cm, NS_P, "text") {
        let n = tree.node(t);
        (n.start..n.end, format!("<{}>{}</{}>", n.qname, escape_text(text), n.qname).into_bytes())
    } else {
        let body = tree.child(cm, NS_P188, "txBody").ok_or_else(|| Error::Unsupported("comment without text".into()))?;
        let wanted: Vec<String> = text.split('\n').map(str::to_owned).collect();
        let edits = super::paragraph_edits(&tree, &src, body, &wanted)?;
        let updated = splice(&src, edits)?;
        doc.package_mut().write(&list, updated)?;
        return Ok(json!({ "op": "edit_comment", "slide": slide, "commentId": id, "changed": true }));
    };
    let updated = splice(&src, vec![edit])?;
    doc.package_mut().write(&list, updated)?;
    Ok(json!({ "op": "edit_comment", "slide": slide, "commentId": id, "changed": true }))
}

/// Deletes a comment (with its replies, for modern comments).
pub fn delete_comment(doc: &mut Presentation, slide: usize, id: &str) -> Result<Value, Error> {
    let (list, src, tree, cm) = find(doc, slide, id)?;
    let n = tree.node(cm);
    let updated = splice(&src, vec![(n.start..n.end, Vec::new())])?;
    doc.package_mut().write(&list, updated)?;
    Ok(json!({ "op": "delete_comment", "slide": slide, "commentId": id, "changed": true }))
}
