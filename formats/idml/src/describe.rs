//! A read-only description of the whole document in one call: pages, every page item on them
//! (by IDML `Self` id, with its kind and its box on the page) and every story's text by
//! paragraph, with overset text. Lengths are points; pages count from 0 in document order; boxes
//! are `[x, y, width, height]` from the page's top-left corner. A host that shows the document
//! and lets an AI address its frames builds its observation from this.

use std::collections::HashMap;

use designcraft_doc::{Content, Item, ItemId, Page, Shape, StoryId};
use designcraft_geom::{Affine, Rect};
use serde_json::{Value, json};

use crate::Idml;

impl Idml {
    pub fn describe(&self) -> Value {
        let doc = &self.doc;
        let item_names: HashMap<ItemId, &str> = self.ids.items.iter().map(|(k, v)| (*v, k.as_str())).collect();
        let story_names: HashMap<StoryId, &str> = self.ids.stories.iter().filter(|(k, _)| !k.starts_with('#')).map(|(k, v)| (*v, k.as_str())).collect();

        let mut pages = Vec::new();
        let mut items = Vec::new();
        let mut first_page = 0;
        for spread in &doc.spreads {
            for (i, p) in spread.pages.iter().enumerate() {
                pages.push(json!({ "index": first_page + i, "width": p.width, "height": p.height }));
            }
            for it in &spread.items {
                walk(it, Affine::IDENTITY, &mut |item, bounds, depth| {
                    let local = page_of(&spread.pages, bounds).unwrap_or(0);
                    let page = &spread.pages[local];
                    let mut v = json!({
                        "id": item_names.get(&item.id).copied(),
                        "kind": kind(item),
                        "name": item.name,
                        "page": first_page + local,
                        "box": [round(bounds.x0 - page.x), round(bounds.y0), round(bounds.width()), round(bounds.height())],
                        "depth": depth,
                    });
                    match &item.content {
                        Content::Text(tf) => {
                            v["story"] = json!(story_names.get(&tf.story).copied());
                        }
                        Content::Graphic(g) => {
                            let asset = doc.assets.get(&g.asset);
                            v["image"] = json!({
                                "name": asset.map(|a| a.name.clone()),
                                "link": asset.and_then(|a| a.link.clone()),
                                "available": asset.is_some_and(|a| !a.data.is_empty()),
                            });
                        }
                        _ => {}
                    }
                    items.push(v);
                });
            }
            first_page += spread.pages.len();
        }

        let mut stories = Vec::new();
        for (sid, story) in &doc.stories {
            let Some(id) = story_names.get(sid) else { continue };
            if story.frames.is_empty() {
                continue;
            }
            let composed = designcraft_compose::compose_story(doc, *sid, &Default::default());
            let paragraphs: Vec<Value> = self
                .story_paragraphs(id)
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(i, text)| json!({ "index": i, "text": text }))
                .collect();
            stories.push(json!({
                "id": id,
                "frames": story.frames.iter().filter_map(|f| item_names.get(f).copied()).collect::<Vec<_>>(),
                "paragraphs": paragraphs,
                // Only text that does not fit counts: a story whose last paragraph mark alone falls
                // past its frames is not overset (InDesign reports none).
                "overset": composed.overset_at.map(|at| story.text.get(at..).unwrap_or("").to_string()).filter(|t| !t.trim().is_empty()),
                // Laid out with a substitute for a font this engine does not have: line breaks and
                // overset can differ from InDesign's.
                "substitutedFonts": composed.styles.iter().any(|s| s.missing_font),
            }));
        }
        // In the order their first frames appear.
        let order: HashMap<&str, usize> = items.iter().enumerate().filter_map(|(i, v)| Some((v["story"].as_str()?, i))).rev().collect();
        stories.sort_by_key(|s| s["id"].as_str().and_then(|id| order.get(id)).copied().unwrap_or(usize::MAX));
        json!({ "pages": pages, "items": items, "stories": stories, "fonts": self.font_names() })
    }
}

/// Every page item under `item` (itself first), with its box in spread space and its depth.
fn walk(item: &Item, parent: Affine, f: &mut dyn FnMut(&Item, Rect, usize)) {
    fn go(item: &Item, parent: Affine, depth: usize, f: &mut dyn FnMut(&Item, Rect, usize)) {
        f(item, parent.transform_rect_bbox(item.bounds()), depth);
        if let Content::Group { items } = &item.content {
            for c in items {
                go(c, parent * item.xf, depth + 1, f);
            }
        }
    }
    go(item, parent, 0, f)
}

fn kind(item: &Item) -> &'static str {
    match (&item.content, item.shape) {
        (Content::Group { .. }, _) => "group",
        (Content::Text(_), _) => "text",
        (Content::Graphic(_), _) => "image",
        (_, Shape::Oval) => "oval",
        (_, Shape::GraphicLine) => "line",
        (_, Shape::Polygon | Shape::Path) => "polygon",
        _ => "rectangle",
    }
}

/// The page whose horizontal extent is nearest the centre of `r` (spread space).
pub(crate) fn page_of(pages: &[Page], r: Rect) -> Option<usize> {
    let cx = (r.x0 + r.x1) / 2.0;
    pages.iter().enumerate().min_by(|a, b| distance(cx, a.1.x, a.1.width).total_cmp(&distance(cx, b.1.x, b.1.width))).map(|(i, _)| i)
}

fn distance(x: f64, left: f64, width: f64) -> f64 {
    if x < left {
        left - x
    } else if x > left + width {
        x - left - width
    } else {
        0.0
    }
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
