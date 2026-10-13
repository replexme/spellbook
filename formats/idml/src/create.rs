//! Commands that add to a document: pages, text frames, shapes and images, and the look of
//! frames and text. Like the edits in `edit.rs` they are written into the package XML; new
//! page items get fresh `Self` ids and new stories their own part listed in the designmap.
//! Boxes are `[x, y, width, height]` in points from the page's top-left corner; colours are
//! `RRGGBB` (stored as RGB swatches) or `none`.
//!
//! - `{"op": "add_page", "after": n}` adds an empty page after page `n` (`-1`: first), with the
//!   master of page `n`; returns `{"page": index}`.
//! - `{"op": "delete_page", "page": n}` removes a page and everything on it.
//! - `{"op": "add_text_frame", "page": n, "box": [...], "text": text, "name": name?}` adds a
//!   text frame with a new story (`\n` separates paragraphs); returns `{"item", "story"}`.
//! - `{"op": "add_shape", "page": n, "box": [...], "kind": "rectangle"|"oval"|"line",
//!   "fill": colour?, "stroke": colour?, "stroke_weight": pt?, "name": name?}`.
//! - `{"op": "add_image", "page": n, "box": [...], "data": base64, "name": name?}` places a PNG or
//!   JPEG, embedded in the package, fitted inside the box without distortion.
//! - `{"op": "set_fill", "item": id, "color": colour}`,
//!   `{"op": "set_stroke", "item": id, "color": colour?, "weight": pt?}`.
//! - `{"op": "set_text_style", "story": id, "size": pt?, "color": colour?, "bold": bool?,
//!   "italic": bool?, "font": family?, "style": font style?}` applies to the whole story.
//! - `{"op": "set_alignment", "story": id, "alignment": "left"|"center"|"right"|"justify"}`.

use std::collections::BTreeMap;

use designcraft_geom::{Affine, Point};
use present_package::xml::{Tree, escape_text, splice};
use serde_json::{Value, json};

use crate::edit::{affine, attr_edits, check_text, descendants, invalid, num, quick_escape, str_arg};
use crate::{Error, Idml};

const PACKAGING_NS: &str = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";

type Edits = Vec<(std::ops::Range<usize>, Vec<u8>)>;

/// Edits to existing parts and whole new parts, collected for one command.
#[derive(Default)]
struct Changes {
    edits: BTreeMap<String, (Vec<u8>, Edits)>,
    new: Vec<(String, Vec<u8>)>,
}

impl Changes {
    fn edit(&mut self, idml: &Idml, part: &str, range: std::ops::Range<usize>, bytes: Vec<u8>) -> Result<(), Error> {
        if !self.edits.contains_key(part) {
            self.edits.insert(part.to_string(), (idml.package.read(part)?.to_vec(), Vec::new()));
        }
        self.edits.get_mut(part).expect("inserted").1.push((range, bytes));
        Ok(())
    }

    fn extend(&mut self, idml: &Idml, part: &str, edits: Edits) -> Result<(), Error> {
        for (r, b) in edits {
            self.edit(idml, part, r, b)?;
        }
        Ok(())
    }

    fn finish(self) -> Result<Vec<(String, Vec<u8>)>, Error> {
        let mut out = Vec::new();
        for (part, (src, edits)) in self.edits {
            out.push((part, splice(&src, edits)?));
        }
        out.extend(self.new);
        Ok(out)
    }
}

/// A page as the spread XML has it.
struct PageAt {
    spread_part: String,
    /// Page element's start and end in the spread part.
    page_range: std::ops::Range<usize>,
    /// Where page items are added: before the spread's closing tag.
    items_at: usize,
    /// Page's top-left corner in spread coordinates.
    origin: Point,
    width: f64,
    height: f64,
    master: String,
    /// The spread's designmap entry (start..end) when the spread holds this page alone.
    spread_entry: Option<std::ops::Range<usize>>,
}

impl Idml {
    pub(crate) fn create(&self, op: &str, c: &Value) -> Result<(Vec<(String, Vec<u8>)>, Value), Error> {
        let mut ch = Changes::default();
        let result = match op {
            "add_page" => {
                let after = c.get("after").and_then(Value::as_i64).ok_or_else(|| invalid("missing \"after\""))?;
                self.add_page(&mut ch, after)?
            }
            "delete_page" => {
                let page = index(c, "page")?;
                self.delete_page(&mut ch, page)?;
                json!({})
            }
            "add_text_frame" => {
                let text = c.get("text").and_then(Value::as_str).unwrap_or("");
                self.add_text_frame(&mut ch, index(c, "page")?, boxed(c)?, text, c.get("name").and_then(Value::as_str))?
            }
            "add_shape" => {
                let kind = c.get("kind").and_then(Value::as_str).unwrap_or("rectangle");
                let look = Look {
                    fill: c.get("fill").and_then(Value::as_str).map(str::to_string),
                    stroke: c.get("stroke").and_then(Value::as_str).map(str::to_string),
                    weight: c.get("stroke_weight").and_then(Value::as_f64),
                };
                self.add_shape(&mut ch, index(c, "page")?, boxed(c)?, kind, &look, c.get("name").and_then(Value::as_str))?
            }
            "add_image" => self.add_image(&mut ch, index(c, "page")?, boxed(c)?, str_arg(c, "data")?, c.get("name").and_then(Value::as_str))?,
            "set_fill" => {
                let (part, src, tree, el) = self.item_xml(str_arg(c, "item")?)?;
                let color = self.color_ref(&mut ch, str_arg(c, "color")?)?;
                let n = tree.node(el);
                ch.extend(self, &part, attr_edits(&src, n.start..n.open_end, &[("FillColor", color)])?)?;
                json!({})
            }
            "set_stroke" => {
                let (part, src, tree, el) = self.item_xml(str_arg(c, "item")?)?;
                let mut attrs = Vec::new();
                if let Some(col) = c.get("color").and_then(Value::as_str) {
                    attrs.push(("StrokeColor", self.color_ref(&mut ch, col)?));
                }
                if let Some(w) = c.get("weight").and_then(Value::as_f64) {
                    if !(0.0..=1000.0).contains(&w) {
                        return Err(invalid("stroke weight must be between 0 and 1000 pt"));
                    }
                    attrs.push(("StrokeWeight", num(w)));
                }
                if attrs.is_empty() {
                    return Err(invalid("give \"color\" or \"weight\""));
                }
                let n = tree.node(el);
                ch.extend(self, &part, attr_edits(&src, n.start..n.open_end, &attrs)?)?;
                json!({})
            }
            "set_text_style" => {
                self.set_text_style(&mut ch, str_arg(c, "story")?, c)?;
                json!({})
            }
            "set_alignment" => {
                let j = match str_arg(c, "alignment")? {
                    "left" => "LeftAlign",
                    "center" => "CenterAlign",
                    "right" => "RightAlign",
                    "justify" => "LeftJustified",
                    other => return Err(invalid(&format!("alignment {other:?}"))),
                };
                let (part, src, tree, root) = self.story_xml(str_arg(c, "story")?)?;
                for i in descendants(&tree, root).filter(|&i| tree.node(i).local == "ParagraphStyleRange") {
                    let n = tree.node(i);
                    ch.extend(self, &part, attr_edits(&src, n.start..n.open_end, &[("Justification", j.to_string())])?)?;
                }
                json!({})
            }
            other => return Err(invalid(&format!("unknown op {other:?}"))),
        };
        Ok((ch.finish()?, result))
    }

    // ---------------------------------------------------------------- pages

    /// Pages in document order, as the spreads list them.
    fn pages(&self) -> Result<Vec<PageAt>, Error> {
        let map = self.package.read("designmap.xml")?;
        let mtree = Tree::parse(&map)?;
        let mut out = Vec::new();
        for entry in mtree.node(mtree.root).children.iter().copied().filter(|&i| mtree.node(i).is(PACKAGING_NS, "Spread")) {
            let Some(part) = mtree.node(entry).attr("src") else { continue };
            let src = self.package.read(part)?;
            let tree = Tree::parse(&src)?;
            // The part's wrapper (idPkg:Spread) has the same local name as the spread inside it.
            let Some(spread) = descendants(&tree, tree.root).find(|&i| tree.node(i).local == "Spread" && tree.node(i).ns.is_none()) else { continue };
            let pages: Vec<usize> = tree.node(spread).children.iter().copied().filter(|&i| tree.node(i).local == "Page").collect();
            for &p in &pages {
                let n = tree.node(p);
                let gb: Vec<f64> = n.attr("GeometricBounds").unwrap_or("").split_whitespace().filter_map(|v| v.parse().ok()).collect();
                if gb.len() != 4 {
                    return Err(Error::Xml(format!("page without bounds in {part}")));
                }
                let xf = n.attr("ItemTransform").and_then(affine).unwrap_or(Affine::IDENTITY);
                let me = mtree.node(entry);
                out.push(PageAt {
                    spread_part: part.to_string(),
                    page_range: n.start..n.end,
                    items_at: tree.node(spread).close_start,
                    origin: xf * Point::new(gb[1], gb[0]),
                    width: gb[3] - gb[1],
                    height: gb[2] - gb[0],
                    master: n.attr("AppliedMaster").unwrap_or("n").to_string(),
                    spread_entry: (pages.len() == 1).then_some(me.start..me.end),
                });
            }
        }
        Ok(out)
    }

    fn page(&self, index: usize) -> Result<PageAt, Error> {
        self.pages()?.into_iter().nth(index).ok_or_else(|| Error::NotFound(format!("page {index}")))
    }

    fn add_page(&self, ch: &mut Changes, after: i64) -> Result<Value, Error> {
        let pages = self.pages()?;
        if pages.is_empty() {
            return Err(Error::NotFound("a page to copy".into()));
        }
        if after < -1 || after >= pages.len() as i64 {
            return Err(invalid(&format!("after must be between -1 and {}", pages.len() - 1)));
        }
        let model = &pages[after.max(0) as usize];
        let [spread_id, page_id] = self.fresh_ids()?;
        let dom = self.dom_version()?;
        // A spread holding one page like the model, centred on the spread origin as InDesign
        // lays out single pages.
        let (w, h) = (model.width, model.height);
        let spread = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<idPkg:Spread xmlns:idPkg=\"{PACKAGING_NS}\" DOMVersion=\"{dom}\">\n\t<Spread Self=\"{spread_id}\" ShowMasterItems=\"true\" PageCount=\"1\" BindingLocation=\"0\" AllowPageShuffle=\"true\" ItemTransform=\"1 0 0 1 0 0\">\n\t\t<Page Self=\"{page_id}\" Name=\"{}\" AppliedMaster=\"{}\" OverrideList=\"\" GeometricBounds=\"0 0 {} {}\" ItemTransform=\"1 0 0 1 {} {}\"/>\n\t</Spread>\n</idPkg:Spread>\n",
            (after + 2),
            quick_escape(&model.master),
            num(h),
            num(w),
            num(-w / 2.0),
            num(-h / 2.0),
        );
        let part = format!("Spreads/Spread_{spread_id}.xml");
        ch.new.push((part.clone(), spread.into_bytes()));
        // Its designmap entry goes before the first spread, or after the spread of page `after`.
        let map = self.package.read("designmap.xml")?;
        let mtree = Tree::parse(&map)?;
        let entry_of = |part: &str| mtree.node(mtree.root).children.iter().copied().find(|&i| mtree.node(i).is(PACKAGING_NS, "Spread") && mtree.node(i).attr("src") == Some(part));
        let at = if after < 0 {
            entry_of(&pages[0].spread_part).map(|i| mtree.node(i).start)
        } else {
            entry_of(&pages[after as usize].spread_part).map(|i| mtree.node(i).end)
        }
        .ok_or_else(|| Error::Xml("designmap does not list the page's spread".into()))?;
        let entry = if after < 0 { format!("<idPkg:Spread src=\"{part}\"/>\n\t") } else { format!("\n\t<idPkg:Spread src=\"{part}\"/>") };
        ch.edit(self, "designmap.xml", at..at, entry.into_bytes())?;
        self.section_length(ch, &mtree, &map, 1)?;
        Ok(json!({ "page": after + 1 }))
    }

    fn delete_page(&self, ch: &mut Changes, index: usize) -> Result<(), Error> {
        let pages = self.pages()?;
        if pages.len() < 2 {
            return Err(invalid("the only page cannot be deleted"));
        }
        let page = pages.get(index).ok_or_else(|| Error::NotFound(format!("page {index}")))?;
        let map = self.package.read("designmap.xml")?;
        let mtree = Tree::parse(&map)?;
        // Items on the page, and stories that have no frame left.
        let desc = self.describe();
        let on_page: Vec<String> =
            desc["items"].as_array().into_iter().flatten().filter(|i| i["page"].as_u64() == Some(index as u64) && i["depth"].as_u64() == Some(0)).filter_map(|i| i["id"].as_str().map(str::to_string)).collect();
        let mut removed_stories = Vec::new();
        for s in desc["stories"].as_array().into_iter().flatten() {
            let frames: Vec<&str> = s["frames"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            if !frames.is_empty() && frames.iter().all(|f| on_page.iter().any(|o| o == f))
                && let Some(id) = s["id"].as_str()
            {
                removed_stories.push(id.to_string());
            }
        }
        if let Some(entry) = page.spread_entry.clone() {
            ch.new.push((page.spread_part.clone(), Vec::new()));
            ch.edit(self, "designmap.xml", entry, Vec::new())?;
        } else {
            ch.edit(self, &page.spread_part, page.page_range.clone(), Vec::new())?;
            for id in &on_page {
                let (part, _, tree, el) = self.item_xml(id)?;
                let n = tree.node(el);
                ch.edit(self, &part, n.start..n.end, Vec::new())?;
            }
        }
        for story in removed_stories {
            let (part, ..) = self.story_xml(&story)?;
            if let Some(e) = descendants(&mtree, mtree.root).find(|&i| mtree.node(i).local == "Story" && mtree.node(i).attr("src") == Some(part.as_str())) {
                let n = mtree.node(e);
                ch.edit(self, "designmap.xml", n.start..n.end, Vec::new())?;
            }
            ch.new.push((part, Vec::new()));
        }
        self.section_length(ch, &mtree, &map, -1)?;
        Ok(())
    }

    /// Keeps a one-section document's page count right.
    fn section_length(&self, ch: &mut Changes, mtree: &Tree, map: &[u8], delta: i64) -> Result<(), Error> {
        let sections: Vec<usize> = mtree.node(mtree.root).children.iter().copied().filter(|&i| mtree.node(i).local == "Section").collect();
        if let [only] = sections[..] {
            let n = mtree.node(only);
            if let Some(len) = n.attr("Length").and_then(|v| v.parse::<i64>().ok()) {
                ch.extend(self, "designmap.xml", attr_edits(map, n.start..n.open_end, &[("Length", (len + delta).max(1).to_string())])?)?;
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- page items

    fn add_text_frame(&self, ch: &mut Changes, page: usize, b: [f64; 4], text: &str, name: Option<&str>) -> Result<Value, Error> {
        for p in text.split('\n') {
            check_text(p)?;
        }
        let at = self.page(page)?;
        let [frame_id, story_id] = self.fresh_ids()?;
        let layer = self.layer()?;
        let el = format!(
            "<TextFrame Self=\"{frame_id}\" ParentStory=\"{story_id}\" PreviousTextFrame=\"n\" NextTextFrame=\"n\" ContentType=\"TextType\" Visible=\"true\" Name=\"{}\" ItemLayer=\"{layer}\" Locked=\"false\" AppliedObjectStyle=\"ObjectStyle/$ID/[Normal Text Frame]\" ItemTransform=\"{}\">{}<TextFramePreference TextColumnCount=\"1\"/></TextFrame>\n\t",
            quick_escape(name.unwrap_or("$ID/")),
            item_transform(&at),
            geometry(b, Outline::Rectangle),
        );
        ch.edit(self, &at.spread_part, at.items_at..at.items_at, el.into_bytes())?;
        let dom = self.dom_version()?;
        let mut body = String::new();
        for (i, p) in text.split('\n').enumerate() {
            if i > 0 {
                body.push_str("<Br/>");
            }
            if !p.is_empty() {
                body.push_str(&format!("<Content>{}</Content>", escape_text(p)));
            }
        }
        let story = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<idPkg:Story xmlns:idPkg=\"{PACKAGING_NS}\" DOMVersion=\"{dom}\">\n\t<Story Self=\"{story_id}\" AppliedTOCStyle=\"n\" TrackChanges=\"false\" StoryTitle=\"$ID/\" AppliedNamedGrid=\"n\">\n\t\t<StoryPreference OpticalMarginAlignment=\"false\" OpticalMarginSize=\"12\" FrameType=\"TextFrameType\" StoryOrientation=\"Horizontal\" StoryDirection=\"LeftToRightDirection\"/>\n\t\t<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/$ID/NormalParagraphStyle\"><CharacterStyleRange AppliedCharacterStyle=\"CharacterStyle/$ID/[No character style]\">{body}</CharacterStyleRange></ParagraphStyleRange>\n\t</Story>\n</idPkg:Story>\n"
        );
        let part = format!("Stories/Story_{story_id}.xml");
        ch.new.push((part.clone(), story.into_bytes()));
        self.list_story(ch, &part)?;
        Ok(json!({ "item": frame_id, "story": story_id }))
    }

    fn add_shape(&self, ch: &mut Changes, page: usize, b: [f64; 4], kind: &str, look: &Look, name: Option<&str>) -> Result<Value, Error> {
        let tag = match kind {
            "rectangle" => "Rectangle",
            "oval" => "Oval",
            "line" => "GraphicLine",
            other => return Err(invalid(&format!("kind {other:?} (rectangle, oval or line)"))),
        };
        let at = self.page(page)?;
        let [id] = self.fresh_ids()?;
        let layer = self.layer()?;
        let mut attrs = format!("Self=\"{id}\" ContentType=\"Unassigned\" Visible=\"true\" Name=\"{}\" ItemLayer=\"{layer}\" Locked=\"false\" ItemTransform=\"{}\"", quick_escape(name.unwrap_or("$ID/")), item_transform(&at));
        let fill = match &look.fill {
            Some(c) => Some(self.color_ref(ch, c)?),
            None if tag == "GraphicLine" => None,
            None => Some("Swatch/None".to_string()),
        };
        if let Some(f) = fill {
            attrs.push_str(&format!(" FillColor=\"{}\"", quick_escape(&f)));
        }
        if let Some(c) = &look.stroke {
            attrs.push_str(&format!(" StrokeColor=\"{}\"", quick_escape(&self.color_ref(ch, c)?)));
        } else if tag == "GraphicLine" {
            attrs.push_str(" StrokeColor=\"Color/Black\"");
        }
        attrs.push_str(&format!(" StrokeWeight=\"{}\"", num(look.weight.unwrap_or(if look.stroke.is_some() || tag == "GraphicLine" { 1.0 } else { 0.0 }))));
        let outline = match tag {
            "Oval" => Outline::Oval,
            "GraphicLine" => Outline::Line,
            _ => Outline::Rectangle,
        };
        let el = format!("<{tag} {attrs}>{}</{tag}>\n\t", geometry(b, outline));
        ch.edit(self, &at.spread_part, at.items_at..at.items_at, el.into_bytes())?;
        Ok(json!({ "item": id }))
    }

    fn add_image(&self, ch: &mut Changes, page: usize, b: [f64; 4], data: &str, name: Option<&str>) -> Result<Value, Error> {
        let bytes = base64_decode(data).ok_or_else(|| invalid("data must be base64"))?;
        let (format, pw, ph) = image_size(&bytes).ok_or_else(|| invalid("data must be a PNG or JPEG image"))?;
        let at = self.page(page)?;
        let [frame_id, image_id, link_id] = self.fresh_ids()?;
        let layer = self.layer()?;
        // Image size at 72 pixels per inch, scaled to fit inside the box and centred.
        let (iw, ih) = (pw as f64, ph as f64);
        let s = (b[2] / iw).min(b[3] / ih);
        let (dx, dy) = (b[0] + (b[2] - iw * s) / 2.0, b[1] + (b[3] - ih * s) / 2.0);
        let image = format!(
            "<Image Self=\"{image_id}\" ItemTransform=\"{} 0 0 {} {} {}\"><Properties><Contents><![CDATA[{}]]></Contents><GraphicBounds Left=\"0\" Top=\"0\" Right=\"{}\" Bottom=\"{}\"/></Properties><Link Self=\"{link_id}\" AssetURL=\"$ID/\" AssetID=\"$ID/\" LinkResourceURI=\"file:{}\" LinkResourceFormat=\"$ID/{format}\" StoredState=\"Embedded\" LinkClassID=\"35906\" LinkClientID=\"257\" LinkResourceModified=\"false\" LinkObjectModified=\"false\" ShowInUI=\"true\" CanEmbed=\"true\" CanUnembed=\"true\" CanPackage=\"true\" ImportPolicy=\"NoAutoImport\" ExportPolicy=\"NoAutoExport\"/></Image>",
            num(s),
            num(s),
            num(dx),
            num(dy),
            base64_encode(&bytes),
            num(iw),
            num(ih),
            quick_escape(name.unwrap_or("image")),
        );
        let el = format!(
            "<Rectangle Self=\"{frame_id}\" ContentType=\"GraphicType\" Visible=\"true\" Name=\"{}\" ItemLayer=\"{layer}\" Locked=\"false\" FillColor=\"Swatch/None\" StrokeWeight=\"0\" ItemTransform=\"{}\">{}{image}</Rectangle>\n\t",
            quick_escape(name.unwrap_or("$ID/")),
            item_transform(&at),
            geometry(b, Outline::Rectangle),
        );
        ch.edit(self, &at.spread_part, at.items_at..at.items_at, el.into_bytes())?;
        Ok(json!({ "item": frame_id }))
    }

    // ---------------------------------------------------------------- text

    fn set_text_style(&self, ch: &mut Changes, story: &str, c: &Value) -> Result<(), Error> {
        let (part, src, tree, root) = self.story_xml(story)?;
        let mut attrs: Vec<(&str, String)> = Vec::new();
        if let Some(size) = c.get("size").and_then(Value::as_f64) {
            if !(0.1..=1296.0).contains(&size) {
                return Err(invalid("size must be between 0.1 and 1296 pt"));
            }
            attrs.push(("PointSize", num(size)));
        }
        if let Some(col) = c.get("color").and_then(Value::as_str) {
            attrs.push(("FillColor", self.color_ref(ch, col)?));
        }
        let bold = c.get("bold").and_then(Value::as_bool);
        let italic = c.get("italic").and_then(Value::as_bool);
        let font = c.get("font").and_then(Value::as_str);
        // A font style by its own name ("M", "Light"), for families whose styles are not
        // Regular/Bold/Italic.
        if let Some(style) = c.get("style").and_then(Value::as_str) {
            attrs.push(("FontStyle", style.to_string()));
        }
        if attrs.is_empty() && bold.is_none() && italic.is_none() && font.is_none() {
            return Err(invalid("give size, color, bold, italic, font or style"));
        }
        for i in descendants(&tree, root).filter(|&i| tree.node(i).local == "CharacterStyleRange") {
            let n = tree.node(i);
            let mut a = attrs.clone();
            if bold.is_some() || italic.is_some() {
                // InDesign names styles by family; these are the common ones.
                let was = n.attr("FontStyle").unwrap_or("Regular");
                let b = bold.unwrap_or(was.contains("Bold"));
                let it = italic.unwrap_or(was.contains("Italic"));
                a.push(("FontStyle", match (b, it) { (true, true) => "Bold Italic", (true, false) => "Bold", (false, true) => "Italic", _ => "Regular" }.to_string()));
            }
            ch.extend(self, &part, attr_edits(&src, n.start..n.open_end, &a)?)?;
            if let Some(family) = font {
                // The font is a property element: replace the run's own or add one.
                let prop = format!("<AppliedFont type=\"string\">{}</AppliedFont>", escape_text(family));
                let props = n.children.iter().copied().find(|&k| tree.node(k).local == "Properties");
                match props {
                    Some(p) => {
                        let pn = tree.node(p);
                        match pn.children.iter().copied().find(|&k| tree.node(k).local == "AppliedFont") {
                            Some(f) => {
                                let fnode = tree.node(f);
                                ch.edit(self, &part, fnode.start..fnode.end, prop.into_bytes())?;
                            }
                            None if pn.is_empty_element() => ch.edit(self, &part, pn.start..pn.end, format!("<Properties>{prop}</Properties>").into_bytes())?,
                            None => ch.edit(self, &part, pn.open_end..pn.open_end, prop.into_bytes())?,
                        }
                    }
                    None if n.is_empty_element() => {}
                    None => ch.edit(self, &part, n.open_end..n.open_end, format!("<Properties>{prop}</Properties>").into_bytes())?,
                }
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- resources

    /// A swatch reference for `RRGGBB` (added to the document's colours when new) or `none`.
    fn color_ref(&self, ch: &mut Changes, color: &str) -> Result<String, Error> {
        if color.eq_ignore_ascii_case("none") {
            return Ok("Swatch/None".into());
        }
        let hex = color.trim_start_matches('#');
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid(&format!("colour {color:?} (RRGGBB or none)")));
        }
        let v = u32::from_str_radix(hex, 16).expect("checked");
        let (r, g, b) = (v >> 16, (v >> 8) & 255, v & 255);
        let name = format!("R={r} G={g} B={b}");
        let self_id = format!("Color/{name}");
        let src = self.package.read("Resources/Graphic.xml")?;
        let tree = Tree::parse(&src)?;
        let colors: Vec<usize> = descendants(&tree, tree.root).filter(|&i| tree.node(i).local == "Color").collect();
        let pending = ch.edits.get("Resources/Graphic.xml").is_some_and(|(_, e)| e.iter().any(|(_, b)| String::from_utf8_lossy(b).contains(&format!("Self=\"{self_id}\""))));
        if !pending && !colors.iter().any(|&i| tree.node(i).attr("Self") == Some(self_id.as_str())) {
            let at = colors.last().map(|&i| tree.node(i).end).unwrap_or(tree.node(tree.root).close_start);
            let el = format!(
                "\n\t<Color Self=\"{self_id}\" Model=\"Process\" Space=\"RGB\" ColorValue=\"{r} {g} {b}\" ColorOverride=\"Normal\" AlternateSpace=\"NoAlternateColor\" AlternateColorValue=\"\" Name=\"{name}\" ColorEditable=\"true\" ColorRemovable=\"true\" Visible=\"true\" SwatchCreatorID=\"7937\"/>"
            );
            ch.edit(self, "Resources/Graphic.xml", at..at, el.into_bytes())?;
        }
        Ok(self_id)
    }

    /// Lists a new story part in the designmap, after the other stories.
    fn list_story(&self, ch: &mut Changes, part: &str) -> Result<(), Error> {
        let map = self.package.read("designmap.xml")?;
        let tree = Tree::parse(&map)?;
        let kids = &tree.node(tree.root).children;
        let last = kids.iter().copied().filter(|&i| tree.node(i).is(PACKAGING_NS, "Story") || tree.node(i).is(PACKAGING_NS, "BackingStory")).last();
        let at = match last {
            Some(i) => tree.node(i).end,
            None => kids.iter().copied().filter(|&i| tree.node(i).is(PACKAGING_NS, "Spread")).last().map(|i| tree.node(i).end).unwrap_or(tree.node(tree.root).close_start),
        };
        ch.edit(self, "designmap.xml", at..at, format!("\n\t<idPkg:Story src=\"{part}\"/>").into_bytes())
    }

    fn dom_version(&self) -> Result<String, Error> {
        let map = self.package.read("designmap.xml")?;
        let tree = Tree::parse(&map)?;
        Ok(tree.node(tree.root).attr("DOMVersion").unwrap_or("16.0").to_string())
    }

    /// The active layer (or the first one).
    fn layer(&self) -> Result<String, Error> {
        let map = self.package.read("designmap.xml")?;
        let tree = Tree::parse(&map)?;
        let root = tree.node(tree.root);
        let first = root.children.iter().copied().find(|&i| tree.node(i).local == "Layer").and_then(|i| tree.node(i).attr("Self"));
        root.attr("ActiveLayer").or(first).map(str::to_string).ok_or_else(|| Error::Xml("no layer".into()))
    }

    /// `n` unused `Self` ids (`u` and a hexadecimal number above every one in the package).
    fn fresh_ids<const N: usize>(&self) -> Result<[String; N], Error> {
        let mut max = 0u64;
        for name in self.package.part_names().filter(|n| n.ends_with(".xml")).map(str::to_string).collect::<Vec<_>>() {
            let src = self.package.read(&name)?;
            let mut rest: &[u8] = &src;
            while let Some(at) = find(rest, b"Self=\"u") {
                let digits: Vec<u8> = rest[at + 7..].iter().copied().take_while(|c| c.is_ascii_hexdigit()).collect();
                if let Ok(v) = u64::from_str_radix(&String::from_utf8_lossy(&digits), 16) {
                    max = max.max(v);
                }
                rest = &rest[at + 7..];
            }
        }
        Ok(std::array::from_fn(|i| format!("u{:x}", max + 1 + i as u64)))
    }
}

struct Look {
    fill: Option<String>,
    stroke: Option<String>,
    weight: Option<f64>,
}

/// A new item's transform: from page coordinates (origin at the page's top-left) to the spread.
fn item_transform(at: &PageAt) -> String {
    format!("1 0 0 1 {} {}", num(at.origin.x), num(at.origin.y))
}

#[derive(Clone, Copy, PartialEq)]
enum Outline {
    Rectangle,
    Oval,
    Line,
}

/// Path geometry for a box: its rectangle, the ellipse inside it, or (a line) from its top-left
/// to its bottom-right corner.
fn geometry(b: [f64; 4], outline: Outline) -> String {
    let [x, y, w, h] = b;
    // Each point: anchor, left (incoming) and right (outgoing) direction handles.
    let points: Vec<[(f64, f64); 3]> = match outline {
        Outline::Line => vec![[(x, y); 3], [(x + w, y + h); 3]],
        Outline::Rectangle => [(x, y), (x, y + h), (x + w, y + h), (x + w, y)].map(|p| [p; 3]).to_vec(),
        Outline::Oval => {
            // Four arcs, drawn counter-clockwise from the top as InDesign stores ovals.
            const K: f64 = 0.552_284_749_8;
            let (cx, cy, rx, ry) = (x + w / 2.0, y + h / 2.0, w / 2.0, h / 2.0);
            vec![
                [(cx, y), (cx + K * rx, y), (cx - K * rx, y)],
                [(x, cy), (x, cy - K * ry), (x, cy + K * ry)],
                [(cx, y + h), (cx - K * rx, y + h), (cx + K * rx, y + h)],
                [(x + w, cy), (x + w, cy + K * ry), (x + w, cy - K * ry)],
            ]
        }
    };
    let mut s = format!("<Properties><PathGeometry><GeometryPathType PathOpen=\"{}\"><PathPointArray>", outline == Outline::Line);
    let pt = |(px, py): (f64, f64)| format!("{} {}", num(px), num(py));
    for [a, l, r] in points {
        s.push_str(&format!("<PathPointType Anchor=\"{}\" LeftDirection=\"{}\" RightDirection=\"{}\"/>", pt(a), pt(l), pt(r)));
    }
    s.push_str("</PathPointArray></GeometryPathType></PathGeometry></Properties>");
    s
}

fn index(c: &Value, key: &str) -> Result<usize, Error> {
    c.get(key).and_then(Value::as_u64).map(|v| v as usize).ok_or_else(|| invalid(&format!("missing \"{key}\"")))
}

fn boxed(c: &Value) -> Result<[f64; 4], Error> {
    let b: Vec<f64> = c.get("box").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_f64).collect();
    match b[..] {
        [x, y, w, h] if w > 0.0 && h >= 0.0 && x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite() => Ok([x, y, w, h]),
        _ => Err(invalid("\"box\" must be [x, y, width, height] with a positive width")),
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Format name and pixel size of a PNG or JPEG.
fn image_size(b: &[u8]) -> Option<(&'static str, u32, u32)> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.len() > 24 {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return (w > 0 && h > 0).then_some(("PNG", w, h));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                return None;
            }
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            // Start-of-frame markers (not DHT C4, JPG C8, DAC CC).
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return (w > 0 && h > 0).then_some(("JPEG", w, h));
            }
            i += 2 + len;
        }
    }
    None
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let s = clean.strip_prefix(b"data:").map_or(&clean[..], |r| r.iter().position(|&c| c == b',').map_or(r, |p| &r[p + 1..]));
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0;
    for &c in s {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        buf = buf << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}
