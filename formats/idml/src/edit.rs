//! Edits, as JSON commands addressed by IDML `Self` ids, applied to the package's XML so that
//! everything the edit does not touch stays byte for byte. Boxes are `[x, y, width, height]` in
//! points from the top-left corner of the page the item is on (as [`Idml::describe`] reports).
//!
//! - `{"op": "replace_text", "story": id, "find": text, "replace": text, "all": bool}` replaces
//!   text inside one formatting run, keeping its formatting. Without `all` the text must occur
//!   exactly once.
//! - `{"op": "set_paragraph_text", "story": id, "paragraph": n, "text": text}` replaces a whole
//!   paragraph's text; it takes the formatting of the paragraph's first run.
//! - `{"op": "replace_range", "story": id, "paragraph": n, "start": a, "end": b, "text": text}`
//!   replaces characters `a..b` (counted in Unicode characters, as [`Idml::story_paragraphs`]
//!   reports the paragraph) keeping every run's formatting; inserted text takes the
//!   formatting of the run where it starts.
//! - `{"op": "set_story_text", "story": id, "text": text}` replaces a story's text, `\n`
//!   separating paragraphs; paragraph `i` keeps the formatting of the old paragraph `i`'s first
//!   run, added paragraphs that of the last.
//! - `{"op": "set_box", "item": id, "box": [x, y, w, h]}` moves and resizes a frame or shape
//!   (a `null` keeps that value). Resizing changes the frame's outline; placed images keep
//!   their size and position on the page, as when a frame is resized in InDesign. Groups and
//!   rotated items can only be moved.
//! - `{"op": "delete", "item": id}` removes a page item; a text frame's story is unthreaded
//!   around it and removed with its last frame.

use designcraft_doc::{Content, Item};
use designcraft_geom::{Affine, Point, Rect, Vec2};
use present_package::xml::{Tree, escape_text, splice};
use serde_json::{Value, json};

use crate::{Error, Idml};

impl Idml {
    /// Applies one command; on error the document is unchanged.
    pub fn apply(&mut self, command: &Value) -> Result<Value, Error> {
        let op = command.get("op").and_then(Value::as_str).ok_or_else(|| invalid("missing \"op\""))?;
        // What a creating command made (new ids), returned with the receipt.
        let mut made = Value::Null;
        let parts = match op {
            "replace_text" => {
                let story = str_arg(command, "story")?;
                let find = str_arg(command, "find")?;
                let replace = str_arg(command, "replace")?;
                let all = command.get("all").and_then(Value::as_bool).unwrap_or(false);
                self.replace_text(story, find, replace, all)?
            }
            "set_paragraph_text" => {
                let story = str_arg(command, "story")?;
                let index = command.get("paragraph").and_then(Value::as_u64).ok_or_else(|| invalid("missing \"paragraph\""))? as usize;
                let text = str_arg(command, "text")?;
                self.set_paragraph_text(story, index, text)?
            }
            "replace_range" => {
                let story = str_arg(command, "story")?;
                let index = command.get("paragraph").and_then(Value::as_u64).ok_or_else(|| invalid("missing \"paragraph\""))? as usize;
                let start = command.get("start").and_then(Value::as_u64).ok_or_else(|| invalid("missing \"start\""))? as usize;
                let end = command.get("end").and_then(Value::as_u64).ok_or_else(|| invalid("missing \"end\""))? as usize;
                self.replace_range(story, index, start..end, str_arg(command, "text")?)?
            }
            "set_story_text" => self.set_story_text(str_arg(command, "story")?, str_arg(command, "text")?)?,
            "set_box" => {
                let item = str_arg(command, "item")?;
                let b = command.get("box").and_then(Value::as_array).filter(|b| b.len() == 4).ok_or_else(|| invalid("\"box\" must be [x, y, width, height]"))?;
                let mut target = [None; 4];
                for (slot, v) in target.iter_mut().zip(b) {
                    if !v.is_null() {
                        *slot = Some(v.as_f64().filter(|v| v.is_finite()).ok_or_else(|| invalid("box values must be numbers or null"))?);
                    }
                }
                self.set_box(item, target)?
            }
            "delete" => self.delete_item(str_arg(command, "item")?)?,
            other => {
                let (parts, result) = self.create(other, command)?;
                made = result;
                parts
            }
        };
        let mut changed: Vec<String> = parts.iter().map(|(n, _)| n.clone()).collect();
        // Committed on a copy with the font cover for the text it inserted, so that an error
        // anywhere still leaves this document unchanged.
        let mut next = self.clone();
        next.commit(parts)?;
        let cover = self.cover_inserted_text(&next, &changed)?;
        if !cover.is_empty() {
            for (name, _) in &cover {
                if !changed.contains(name) {
                    changed.push(name.clone());
                }
            }
            next.commit(cover)?;
        }
        *self = next;
        let mut receipt = json!({ "ok": true, "parts": changed });
        if let Value::Object(fields) = made {
            for (k, v) in fields {
                receipt[k] = v;
            }
        }
        Ok(receipt)
    }

    fn replace_text(&self, story: &str, find: &str, replace: &str, all: bool) -> Result<Vec<(String, Vec<u8>)>, Error> {
        if find.is_empty() {
            return Err(invalid("\"find\" is empty"));
        }
        check_text(replace)?;
        let (name, src, tree, root) = self.story_xml(story)?;
        let mut edits = Vec::new();
        let mut count = 0;
        for run in story_runs(&tree, root) {
            let Run::Content(i) = run else { continue };
            let n = tree.node(i);
            if n.is_empty_element() || src[n.open_end..n.close_start].windows(2).any(|w| w == b"<?") {
                continue;
            }
            let text = tree.text(&src, i)?;
            let hits = text.matches(find).count();
            if hits > 0 {
                count += hits;
                edits.push((n.open_end..n.close_start, escape_text(&text.replace(find, replace)).into_bytes()));
            }
        }
        match count {
            0 => return Err(Error::NotFound(format!("{find:?} in story {story} (text split across formatting runs can only be changed with set_paragraph_text)"))),
            1 => {}
            n if !all => return Err(invalid(&format!("{find:?} occurs {n} times in story {story}; pass \"all\": true or a longer \"find\""))),
            _ => {}
        }
        Ok(vec![(name, splice(&src, edits)?)])
    }

    fn set_paragraph_text(&self, story: &str, index: usize, text: &str) -> Result<Vec<(String, Vec<u8>)>, Error> {
        check_text(text)?;
        let (name, src, tree, root) = self.story_xml(story)?;
        let paras = paragraphs_of(&tree, &src, root)?;
        let para = paras.get(index).ok_or_else(|| Error::NotFound(format!("paragraph {index} of story {story}")))?;
        let mut edits = Vec::new();
        set_para_text(&tree, para, text, &mut edits)?;
        Ok(vec![(name, splice(&src, edits)?)])
    }

    fn replace_range(&self, story: &str, index: usize, range: std::ops::Range<usize>, text: &str) -> Result<Vec<(String, Vec<u8>)>, Error> {
        check_text(text)?;
        let (name, src, tree, root) = self.story_xml(story)?;
        let paras = paragraphs_of(&tree, &src, root)?;
        let para = paras.get(index).ok_or_else(|| Error::NotFound(format!("paragraph {index} of story {story}")))?;
        let len: usize = para.pieces.iter().map(|p| p.len).sum();
        if range.start > range.end || range.end > len {
            return Err(invalid(&format!("range {}..{} is outside paragraph {index} ({len} characters)", range.start, range.end)));
        }
        let mut edits = Vec::new();
        if para.pieces.is_empty() {
            set_para_text(&tree, para, text, &mut edits)?;
            return Ok(vec![(name, splice(&src, edits)?)]);
        }
        // The run holding the start (at a boundary, the run that ends there).
        let first = para.pieces.iter().position(|p| range.start < p.start + p.len).unwrap_or(para.pieces.len() - 1);
        for (k, p) in para.pieces.iter().enumerate().skip(first) {
            if k > first && p.start >= range.end {
                break;
            }
            let a = range.start.max(p.start) - p.start;
            let b = range.end.min(p.start + p.len).max(p.start) - p.start;
            if a == b && k != first {
                continue;
            }
            if !p.plain {
                return Err(invalid("the range touches special characters (page numbers, markers); use set_paragraph_text"));
            }
            let chars: Vec<char> = p.text.chars().collect();
            let mut out: String = chars[..a].iter().collect();
            if k == first {
                out.push_str(text);
            }
            out.extend(&chars[b..]);
            edits.push(content_edit(&tree, p.node, &out));
        }
        Ok(vec![(name, splice(&src, edits)?)])
    }

    fn set_story_text(&self, story: &str, text: &str) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let new: Vec<&str> = text.split('\n').collect();
        for p in &new {
            check_text(p)?;
        }
        let (name, src, tree, root) = self.story_xml(story)?;
        let old = paragraphs_of(&tree, &src, root)?;
        let mut edits = Vec::new();
        for (para, t) in old.iter().zip(&new) {
            set_para_text(&tree, para, t, &mut edits)?;
        }
        if new.len() > old.len() {
            let last = old.last().ok_or_else(|| Error::NotFound(format!("text of story {story}")))?;
            let at = last.end.ok_or_else(|| invalid("the story has no character run to add paragraphs to"))?;
            let mut added = String::new();
            for t in &new[old.len()..] {
                added.push_str("<Br />");
                if !t.is_empty() {
                    added.push_str(&format!("<Content>{}</Content>", escape_text(t)));
                }
            }
            edits.push((at..at, added.into_bytes()));
        } else {
            for (k, para) in old.iter().enumerate().skip(new.len() - 1) {
                if k >= new.len() {
                    for p in &para.pieces {
                        let n = tree.node(p.node);
                        edits.push((n.start..n.end, Vec::new()));
                    }
                }
                if let Some(b) = para.brk {
                    let n = tree.node(b);
                    edits.push((n.start..n.end, Vec::new()));
                }
            }
        }
        Ok(vec![(name, splice(&src, edits)?)])
    }

    /// The text of each paragraph of a story, as the text commands count it: the characters of
    /// its runs, without page numbers and other markers.
    pub fn story_paragraphs(&self, story: &str) -> Result<Vec<String>, Error> {
        let (_, src, tree, root) = self.story_xml(story)?;
        Ok(paragraphs_of(&tree, &src, root)?.into_iter().map(|p| p.pieces.into_iter().map(|x| x.text).collect()).collect())
    }

    fn set_box(&self, id: &str, target: [Option<f64>; 4]) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let at = self.locate(id)?;
        let old = at.bounds;
        let [x, y, w, h] = target;
        let (w, h) = (w.unwrap_or(old.width()), h.unwrap_or(old.height()));
        if w <= 0.0 || h <= 0.0 {
            return Err(invalid("width and height must be positive"));
        }
        let origin = Point::new(x.map_or(old.x0, |x| x + at.page_x), y.unwrap_or(old.y0));
        let resize = (w - old.width()).abs() > 1e-6 || (h - old.height()).abs() > 1e-6;
        let world = at.parent * at.item.xf;

        let (name, src, tree, el) = self.item_xml(id)?;
        let mut edits = Vec::new();
        if resize {
            if matches!(at.item.content, Content::Group { .. }) {
                return Err(invalid("a group can only be moved"));
            }
            let [a, b, c, d, ..] = world.as_coeffs();
            if b.abs() > 1e-9 || c.abs() > 1e-9 || a.abs() < 1e-9 || d.abs() < 1e-9 {
                return Err(invalid("a rotated or skewed item can only be moved"));
            }
            if old.width() < 1e-9 || old.height() < 1e-9 {
                return Err(invalid("an item without width or height can only be moved"));
            }
            // Scale about the old top-left corner, in the item's own coordinates.
            let scale = Affine::translate(old.origin().to_vec2()) * Affine::scale_non_uniform(w / old.width(), h / old.height()) * Affine::translate(-old.origin().to_vec2());
            let inner = world.inverse() * scale * world;
            for p in descendants(&tree, el).filter(|&i| tree.node(i).local == "PathPointType" && in_own_geometry(&tree, el, i)) {
                let n = tree.node(p);
                let mut src_attrs = Vec::new();
                for key in ["Anchor", "LeftDirection", "RightDirection"] {
                    if let Some(v) = n.attr(key) {
                        let pt = point(v).ok_or_else(|| Error::Xml(format!("bad {key} {v:?}")))?;
                        let q = inner * pt;
                        src_attrs.push((key, format!("{} {}", num(q.x), num(q.y))));
                    }
                }
                edits.extend(attr_edits(&src, n.start..n.open_end, &src_attrs)?);
            }
        }
        let shift = origin - old.origin();
        if shift.hypot() > 1e-9 {
            let [a, b, c, d, ..] = at.parent.as_coeffs();
            let local = Affine::new([a, b, c, d, 0.0, 0.0]).inverse() * Point::new(shift.x, shift.y);
            let n = tree.node(el);
            let xf = Affine::translate(Vec2::new(local.x, local.y)) * n.attr("ItemTransform").and_then(affine).unwrap_or(Affine::IDENTITY);
            let s: Vec<String> = xf.as_coeffs().iter().map(|v| num(*v)).collect();
            edits.extend(attr_edits(&src, n.start..n.open_end, &[("ItemTransform", s.join(" "))])?);
        }
        if edits.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![(name, splice(&src, edits)?)])
    }

    fn delete_item(&self, id: &str) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let (name, src, tree, el) = self.item_xml(id)?;
        let n = tree.node(el);
        let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
        let mut spread_edits = vec![(n.start..n.end, Vec::new())];
        if n.local == "TextFrame" {
            let prev = n.attr("PreviousTextFrame").filter(|v| *v != "n").map(str::to_string);
            let next = n.attr("NextTextFrame").filter(|v| *v != "n").map(str::to_string);
            // Rethread around the removed frame (the neighbours may live in other spreads).
            let mut relink = |other: &str, key: &str, value: &str| -> Result<(), Error> {
                let (oname, osrc, otree, oel) = self.item_xml(other)?;
                let on = otree.node(oel);
                let e = attr_edits(&osrc, on.start..on.open_end, &[(key, value.to_string())])?;
                if oname == name {
                    spread_edits.extend(e);
                } else {
                    let base = parts.iter().position(|(p, _)| *p == oname);
                    let bytes = splice(&osrc, e)?;
                    match base {
                        Some(i) => parts[i].1 = bytes,
                        None => parts.push((oname, bytes)),
                    }
                }
                Ok(())
            };
            if let Some(p) = &prev {
                relink(p, "NextTextFrame", next.as_deref().unwrap_or("n"))?;
            }
            if let Some(nx) = &next {
                relink(nx, "PreviousTextFrame", prev.as_deref().unwrap_or("n"))?;
            }
            if prev.is_none()
                && next.is_none()
                && let Some(story) = n.attr("ParentStory")
            {
                parts.extend(self.remove_story(story)?);
            }
        }
        parts.push((name.clone(), splice(&src, spread_edits)?));
        Ok(parts)
    }

    /// Removes a story part and its designmap entry.
    fn remove_story(&self, story: &str) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let (part, ..) = self.story_xml(story)?;
        let map = self.package.read("designmap.xml")?;
        let tree = Tree::parse(&map)?;
        let entry = descendants(&tree, tree.root)
            .find(|&i| tree.node(i).local == "Story" && tree.node(i).attr("src") == Some(part.as_str()))
            .ok_or_else(|| Error::NotFound(format!("designmap entry for {part}")))?;
        let n = tree.node(entry);
        let map = splice(&map, vec![(n.start..n.end, Vec::new())])?;
        // An empty part marks it for removal in `commit`.
        Ok(vec![("designmap.xml".into(), map), (part, Vec::new())])
    }

    pub(crate) fn story_xml(&self, id: &str) -> Result<(String, Vec<u8>, Tree, usize), Error> {
        if !self.ids.stories.contains_key(id) {
            return Err(Error::NotFound(format!("story {id}")));
        }
        self.find_element(id, |n| n.starts_with("Stories/"), |local| local == "Story")
    }

    pub(crate) fn item_xml(&self, id: &str) -> Result<(String, Vec<u8>, Tree, usize), Error> {
        self.find_element(id, |n| n.starts_with("Spreads/") || n.starts_with("MasterSpreads/"), |local| {
            matches!(local, "TextFrame" | "Rectangle" | "Oval" | "Polygon" | "GraphicLine" | "Group")
        })
    }

    fn find_element(&self, id: &str, part: impl Fn(&str) -> bool, kind: impl Fn(&str) -> bool) -> Result<(String, Vec<u8>, Tree, usize), Error> {
        let needle = format!("Self=\"{id}\"");
        for name in self.package.part_names().filter(|n| part(n)) {
            let src = self.package.read(name)?;
            if !src.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                continue;
            }
            let tree = Tree::parse(&src)?;
            let found = descendants(&tree, tree.root).find(|&i| kind(&tree.node(i).local) && tree.node(i).attr("Self") == Some(id));
            if let Some(i) = found {
                return Ok((name.to_string(), src.to_vec(), tree, i));
            }
        }
        Err(Error::NotFound(id.to_string()))
    }

    /// An item's place in the derived document: its box in spread space, the transform of the
    /// groups around it, and the left edge of the page it is on.
    fn locate(&self, id: &str) -> Result<Located<'_>, Error> {
        let not_found = || Error::NotFound(format!("page item {id}"));
        let item_id = *self.ids.items.get(id).ok_or_else(not_found)?;
        let loc = self.doc.find(item_id).ok_or_else(not_found)?;
        let item = self.doc.item_at(&loc).ok_or_else(not_found)?;
        let parent = self.doc.parent_xf(&loc);
        let bounds = parent.transform_rect_bbox(item.bounds());
        let spread = self.doc.spread(loc.spread).ok_or_else(not_found)?;
        let page_x = crate::describe::page_of(&spread.pages, bounds).map_or(0.0, |i| spread.pages[i].x);
        Ok(Located { item, parent, bounds, page_x })
    }
}

struct Located<'a> {
    item: &'a Item,
    parent: Affine,
    bounds: Rect,
    page_x: f64,
}

/// One paragraph of a story in the XML: its runs' `Content` elements, the `Br` that ends it,
/// and where text can be added at its end (the closing tag of its last character run).
pub(crate) struct Para {
    pub(crate) pieces: Vec<Piece>,
    brk: Option<usize>,
    end: Option<usize>,
}

pub(crate) struct Piece {
    pub(crate) node: usize,
    pub(crate) text: String,
    /// Character offset in the paragraph.
    pub(crate) start: usize,
    pub(crate) len: usize,
    /// Plain text only (no processing instructions such as page numbers).
    pub(crate) plain: bool,
}

pub(crate) fn paragraphs_of(tree: &Tree, src: &[u8], root: usize) -> Result<Vec<Para>, Error> {
    let mut out = Vec::new();
    let mut cur = Para { pieces: Vec::new(), brk: None, end: None };
    let mut offset = 0;
    for run in story_runs(tree, root) {
        match run {
            Run::Content(i) => {
                let (text, plain) = content_text(tree, src, i)?;
                let len = text.chars().count();
                cur.pieces.push(Piece { node: i, text, start: offset, len, plain });
                offset += len;
            }
            Run::Break(i) => {
                cur.brk = Some(i);
                out.push(std::mem::replace(&mut cur, Para { pieces: Vec::new(), brk: None, end: None }));
                offset = 0;
            }
            Run::RunEnd(at) => cur.end = Some(at),
        }
    }
    out.push(cur);
    Ok(out)
}

/// A `Content` element's text, without processing instructions; and whether it had none.
fn content_text(tree: &Tree, src: &[u8], i: usize) -> Result<(String, bool), Error> {
    let n = tree.node(i);
    if n.is_empty_element() {
        return Ok((String::new(), true));
    }
    let raw = std::str::from_utf8(&src[n.open_end..n.close_start]).map_err(|e| Error::Xml(e.to_string()))?;
    if !raw.contains("<?") {
        return Ok((tree.text(src, i)?, true));
    }
    let mut kept = String::new();
    let mut rest = raw;
    while let Some(at) = rest.find("<?") {
        kept.push_str(&rest[..at]);
        rest = rest[at..].find("?>").map_or("", |e| &rest[at + e + 2..]);
    }
    kept.push_str(rest);
    let kept = kept.replace("\r\n", "\n").replace('\r', "\n");
    let text = quick_xml::escape::unescape(&kept).map_err(|e| Error::Xml(e.to_string()))?.into_owned();
    Ok((text, false))
}

/// The edit that sets a `Content` element's text.
fn content_edit(tree: &Tree, i: usize, text: &str) -> (std::ops::Range<usize>, Vec<u8>) {
    let n = tree.node(i);
    let escaped = escape_text(text);
    if n.is_empty_element() {
        (n.start..n.end, format!("<{q}>{escaped}</{q}>", q = n.qname).into_bytes())
    } else {
        (n.open_end..n.close_start, escaped.into_bytes())
    }
}

/// Edits giving a paragraph `text` in the formatting of its first run.
fn set_para_text(tree: &Tree, para: &Para, text: &str, edits: &mut Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<(), Error> {
    match para.pieces.split_first() {
        Some((first, rest)) => {
            edits.push(content_edit(tree, first.node, text));
            for p in rest {
                let n = tree.node(p.node);
                edits.push((n.start..n.end, Vec::new()));
            }
        }
        None if text.is_empty() => {}
        None => {
            let at = para.brk.map(|b| tree.node(b).start).or(para.end).ok_or_else(|| invalid("the paragraph has no character run to hold text"))?;
            edits.push((at..at, format!("<Content>{}</Content>", escape_text(text)).into_bytes()));
        }
    }
    Ok(())
}

/// A story's text runs and paragraph breaks in order, as DesignCraft reads them: tables,
/// footnotes, notes and anchored objects carry their own text and are skipped.
enum Run {
    Content(usize),
    Break(usize),
    /// The end of a character run (byte offset of its closing tag).
    RunEnd(usize),
}

fn story_runs(tree: &Tree, root: usize) -> Vec<Run> {
    fn go(tree: &Tree, i: usize, page_break: bool, out: &mut Vec<Run>) {
        for &c in &tree.node(i).children {
            let n = tree.node(c);
            match n.local.as_str() {
                "Content" => out.push(Run::Content(c)),
                "Br" if !page_break => out.push(Run::Break(c)),
                "Br" => {}
                "CharacterStyleRange" => {
                    let brk = n.attr("ParagraphBreakType").is_some_and(|t| t != "Anywhere");
                    go(tree, c, brk, out);
                    if !n.is_empty_element() {
                        out.push(Run::RunEnd(n.close_start));
                    }
                }
                "Table" | "Footnote" | "Note" | "Properties" | "TextFrame" | "StoryPreference" | "InCopyExportOption" | "TextVariableInstance"
                | "Rectangle" | "Oval" | "Polygon" | "GraphicLine" | "Group" | "HyperlinkTextDestination" | "ParagraphDestination"
                | "PageReference" | "CrossReferenceSource" => {}
                _ => go(tree, c, page_break, out),
            }
        }
    }
    let mut out = Vec::new();
    go(tree, root, false, &mut out);
    out
}

pub(crate) fn descendants(tree: &Tree, root: usize) -> impl Iterator<Item = usize> + '_ {
    let mut stack = vec![root];
    std::iter::from_fn(move || {
        let i = stack.pop()?;
        stack.extend(tree.node(i).children.iter().rev());
        Some(i)
    })
}

/// Whether path point `p` belongs to `el`'s own outline rather than a nested item's.
fn in_own_geometry(tree: &Tree, el: usize, p: usize) -> bool {
    let mut at = tree.node(p).parent;
    while let Some(i) = at {
        if i == el {
            return true;
        }
        if matches!(tree.node(i).local.as_str(), "TextFrame" | "Rectangle" | "Oval" | "Polygon" | "GraphicLine" | "Group" | "Image" | "EPS" | "PDF" | "ImportedPage") {
            return false;
        }
        at = tree.node(i).parent;
    }
    false
}

/// Edits that set attributes in the start tag spanning `tag` (adding any that are missing).
pub(crate) fn attr_edits(src: &[u8], tag: std::ops::Range<usize>, attrs: &[(&str, String)]) -> Result<Vec<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    let text = std::str::from_utf8(&src[tag.clone()]).map_err(|e| Error::Xml(e.to_string()))?;
    let mut edits = Vec::new();
    let mut added = String::new();
    for (key, value) in attrs {
        let value = quick_escape(value);
        match find_attr(text, key) {
            Some(r) => edits.push((tag.start + r.start..tag.start + r.end, value.into_bytes())),
            None => added.push_str(&format!(" {key}=\"{value}\"")),
        }
    }
    if !added.is_empty() {
        let name_end = text.find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(text.len());
        edits.push((tag.start + name_end..tag.start + name_end, added.into_bytes()));
    }
    Ok(edits)
}

/// The byte range of attribute `key`'s value (inside its quotes) in a start tag.
fn find_attr(tag: &str, key: &str) -> Option<std::ops::Range<usize>> {
    let bytes = tag.as_bytes();
    let mut from = 0;
    while let Some(off) = tag[from..].find(key) {
        let at = from + off;
        from = at + key.len();
        if at == 0 || !bytes[at - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = &tag[from..];
        let eq = rest.len() - rest.trim_start().len();
        let rest2 = &rest[eq..];
        if !rest2.starts_with('=') {
            continue;
        }
        let after_eq = &rest2[1..];
        let ws = after_eq.len() - after_eq.trim_start().len();
        let q = after_eq[ws..].chars().next()?;
        if q != '"' && q != '\'' {
            return None;
        }
        let start = from + eq + 1 + ws + 1;
        let end = start + tag[start..].find(q)?;
        return Some(start..end);
    }
    None
}

pub(crate) fn quick_escape(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;")
}

pub(crate) fn check_text(text: &str) -> Result<(), Error> {
    if text.contains(['\n', '\r', '\u{2029}']) {
        return Err(invalid("text cannot contain paragraph breaks; use \\u2028 for a line break"));
    }
    Ok(())
}

pub(crate) fn point(s: &str) -> Option<Point> {
    let v: Vec<f64> = s.split_whitespace().map(str::parse).collect::<Result<_, _>>().ok()?;
    (v.len() == 2).then(|| Point::new(v[0], v[1]))
}

pub(crate) fn affine(s: &str) -> Option<Affine> {
    let v: Vec<f64> = s.split_whitespace().map(str::parse).collect::<Result<_, _>>().ok()?;
    (v.len() == 6).then(|| Affine::new([v[0], v[1], v[2], v[3], v[4], v[5]]))
}

/// A number in its shortest exact decimal form (no exponent), as InDesign writes them.
pub(crate) fn num(v: f64) -> String {
    if v.abs() < 1e-9 { "0".into() } else { format!("{v}") }
}

pub(crate) fn str_arg<'a>(command: &'a Value, key: &str) -> Result<&'a str, Error> {
    command.get(key).and_then(Value::as_str).ok_or_else(|| invalid(&format!("missing \"{key}\"")))
}

pub(crate) fn invalid(m: &str) -> Error {
    Error::InvalidCommand(m.to_string())
}
