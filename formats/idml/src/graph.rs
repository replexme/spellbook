//! The document in the Spellbook element-graph contract (`contracts/element-graph.schema.json`
//! of the public core), which the document worker stores for every saved version: pages as
//! slides, top-level page items as elements in EMU, each with the SHA-256 of its XML so that
//! a later version shows which items changed.

use present_package::xml::Tree;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Error, Idml};

const EMU_PER_PT: f64 = 12700.0;

fn emu(pt: f64) -> i64 {
    (pt * EMU_PER_PT).round() as i64
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Idml {
    /// The element graph of the document whose package bytes are `bytes` (their SHA-256 is
    /// the document's identity).
    pub fn element_graph(&self, bytes: &[u8]) -> Result<Value, Error> {
        let desc = self.describe();
        // The XML of every page item, by Self id, for its hash.
        let mut sources: std::collections::HashMap<String, (String, Vec<u8>)> = std::collections::HashMap::new();
        for name in self.package.part_names().filter(|n| n.starts_with("Spreads/")).map(str::to_string).collect::<Vec<_>>() {
            let src = self.package.read(&name)?;
            let tree = Tree::parse(&src)?;
            for n in &tree.nodes {
                if matches!(n.local.as_str(), "TextFrame" | "Rectangle" | "Oval" | "Polygon" | "GraphicLine" | "Group")
                    && let Some(id) = n.attr("Self")
                {
                    sources.insert(id.to_string(), (name.clone(), src[n.start..n.end].to_vec()));
                }
            }
        }
        let stories: std::collections::HashMap<&str, &Value> = desc["stories"].as_array().into_iter().flatten().filter_map(|s| Some((s["id"].as_str()?, s))).collect();
        let pages = desc["pages"].as_array().cloned().unwrap_or_default();
        let mut slides: Vec<Value> = pages
            .iter()
            .map(|p| json!({ "slideIndex": p["index"], "partUri": "", "previewObject": null, "supportGrade": "B", "elements": [], "warnings": [] }))
            .collect();
        let mut seen_story = std::collections::HashSet::new();
        for item in desc["items"].as_array().into_iter().flatten() {
            if item["depth"].as_u64() != Some(0) {
                continue;
            }
            let Some(page) = item["page"].as_u64().map(|p| p as usize) else { continue };
            let Some(slide) = slides.get_mut(page) else { continue };
            let id = item["id"].as_str().unwrap_or("");
            let (part, xml) = sources.get(id).cloned().unwrap_or_default();
            if slide["partUri"] == "" {
                slide["partUri"] = json!(format!("/{part}"));
            }
            let b: Vec<f64> = item["box"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
            let [x, y, w, h] = [b.first(), b.get(1), b.get(2), b.get(3)].map(|v| v.copied().unwrap_or(0.0));
            let elements = slide["elements"].as_array_mut().expect("array");
            let text = item["story"].as_str().filter(|s| seen_story.insert(s.to_string())).and_then(|s| stories.get(s)).map(|s| {
                s["paragraphs"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")
            });
            elements.push(json!({
                "elementId": format!("{page}/{}", elements.len()),
                // Self ids are "u" and a hexadecimal number.
                "shapeId": id.strip_prefix('u').and_then(|h| u32::from_str_radix(h, 16).ok()).filter(|n| *n >= 1).unwrap_or(elements.len() as u32 + 1),
                "kind": match item["kind"].as_str() {
                    Some("image") => "picture",
                    Some("group") => "group",
                    Some("line") => "connector",
                    _ => "shape",
                },
                "name": item["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id),
                "text": text,
                "x": emu(x),
                "y": emu(y),
                "width": emu(w).max(0),
                "height": emu(h).max(0),
                "rotation": 0,
                "zIndex": elements.len(),
                "editable": true,
                "unsupportedReason": null,
                "sourceHash": hex(&Sha256::digest(&xml)),
            }));
        }
        let first = pages.first();
        Ok(json!({
            "contractVersion": "1.0",
            "documentSha256": hex(&Sha256::digest(bytes)),
            "slideWidthEmu": emu(first.and_then(|p| p["width"].as_f64()).unwrap_or(595.0)).max(1),
            "slideHeightEmu": emu(first.and_then(|p| p["height"].as_f64()).unwrap_or(842.0)).max(1),
            "fontInventoryAvailable": false,
            "declaredFonts": desc["fonts"],
            "missingFonts": [],
            "fontSubstitutions": [],
            "rendererName": "Present IDML",
            "rendererVersion": env!("CARGO_PKG_VERSION"),
            "slides": slides,
            "warnings": [],
        }))
    }
}
