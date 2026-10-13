//! Making a document from a blank one with the creation commands.

use present_idml::{Idml, blank};
use serde_json::{Value, json};

fn png(w: u32, h: u32) -> String {
    // A minimal PNG header is enough for the size; the engine embeds the bytes as given.
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    b.extend(w.to_be_bytes());
    b.extend(h.to_be_bytes());
    b.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            s.push(if k <= c.len() { T[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

fn items(doc: &Idml) -> Vec<Value> {
    doc.describe()["items"].as_array().unwrap().clone()
}

#[test]
fn blank_documents_use_korean_defaults() {
    let doc = Idml::open(blank("A4", 2).unwrap()).unwrap();
    assert_eq!(doc.page_count(), 2);
    let (w, h) = doc.page_size(0).unwrap();
    assert!((w - 595.28).abs() < 0.01 && (h - 841.89).abs() < 0.01, "{w} x {h}");
    let styles = String::from_utf8(doc.package().read("Resources/Styles.xml").unwrap().to_vec()).unwrap();
    assert!(styles.contains("Source Han Sans SC") && styles.contains("HL Composer J") && styles.contains("$ID/Korean"));
    assert!(blank("Nonsense", 1).is_err());
}

#[test]
fn adds_frames_shapes_and_images() {
    let mut doc = Idml::open(blank("A4", 1).unwrap()).unwrap();
    let r = doc.apply(&json!({"op": "add_text_frame", "page": 0, "box": [50, 60, 300, 80], "text": "제목\n본문", "name": "Title"})).unwrap();
    let story = r["story"].as_str().unwrap().to_string();
    doc.apply(&json!({"op": "add_shape", "page": 0, "box": [50, 200, 100, 50], "kind": "oval", "fill": "FF0000", "stroke": "000000", "stroke_weight": 2})).unwrap();
    doc.apply(&json!({"op": "add_shape", "page": 0, "box": [50, 300, 200, 0], "kind": "line", "stroke": "336699"})).unwrap();
    // A 400 x 200 px image in a 100 x 100 box: fitted to 100 x 50, centred.
    doc.apply(&json!({"op": "add_image", "page": 0, "box": [300, 300, 100, 100], "data": png(400, 200)})).unwrap();
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    let all = items(&doc);
    let kinds: Vec<&str> = all.iter().map(|i| i["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["text", "oval", "line", "image"]);
    assert_eq!(all[0]["box"], json!([50.0, 60.0, 300.0, 80.0]));
    assert_eq!(all[0]["name"], "Title");
    assert_eq!(all[1]["box"], json!([50.0, 200.0, 100.0, 50.0]));
    assert_eq!(doc.story_paragraphs(&story).unwrap(), ["제목", "본문"]);
    // One swatch per colour, written once.
    let graphic = String::from_utf8(doc.package().read("Resources/Graphic.xml").unwrap().to_vec()).unwrap();
    assert_eq!(graphic.matches("Self=\"Color/R=255 G=0 B=0\"").count(), 1);
    let spread = doc.package().part_names().find(|n| n.starts_with("Spreads/")).unwrap().to_string();
    let spread = String::from_utf8(doc.package().read(&spread).unwrap().to_vec()).unwrap();
    assert!(spread.contains("ItemTransform=\"0.25 0 0 0.25 300 325\""), "image fitted and centred");
    assert!(spread.contains("<![CDATA["), "image embedded");
}

#[test]
fn adds_and_deletes_pages() {
    let mut doc = Idml::open(blank("A4", 1).unwrap()).unwrap();
    assert_eq!(doc.apply(&json!({"op": "add_page", "after": 0})).unwrap()["page"], 1);
    doc.apply(&json!({"op": "add_page", "after": -1})).unwrap();
    assert_eq!(doc.page_count(), 3);
    let r = doc.apply(&json!({"op": "add_text_frame", "page": 2, "box": [10, 10, 100, 100], "text": "last"})).unwrap();
    let story = r["story"].as_str().unwrap().to_string();
    assert_eq!(items(&doc)[0]["page"], 2);
    let map = String::from_utf8(doc.package().read("designmap.xml").unwrap().to_vec()).unwrap();
    assert!(map.contains("Length=\"3\""));
    // Deleting the page removes its frame and the story with it.
    doc.apply(&json!({"op": "delete_page", "page": 2})).unwrap();
    assert_eq!(doc.page_count(), 2);
    assert!(items(&doc).is_empty());
    assert!(doc.story_paragraphs(&story).is_err());
    doc.apply(&json!({"op": "delete_page", "page": 0})).unwrap();
    assert!(doc.apply(&json!({"op": "delete_page", "page": 0})).is_err(), "the only page stays");
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn styles_text_and_frames() {
    let mut doc = Idml::open(blank("A4", 1).unwrap()).unwrap();
    let r = doc.apply(&json!({"op": "add_text_frame", "page": 0, "box": [50, 60, 300, 80], "text": "Hello"})).unwrap();
    let (item, story) = (r["item"].as_str().unwrap().to_string(), r["story"].as_str().unwrap().to_string());
    doc.apply(&json!({"op": "set_text_style", "story": story, "size": 24, "color": "123456", "bold": true, "font": "Adobe Myungjo Std"})).unwrap();
    doc.apply(&json!({"op": "set_alignment", "story": story, "alignment": "center"})).unwrap();
    doc.apply(&json!({"op": "set_fill", "item": item, "color": "F1F3F5"})).unwrap();
    doc.apply(&json!({"op": "set_stroke", "item": item, "color": "none", "weight": 0})).unwrap();
    let d = doc.document();
    let s = d.stories.values().next().unwrap();
    let (_, f) = s.runs().next().unwrap();
    assert_eq!(f.over.size, Some(24.0));
    assert_eq!(f.over.font_family.as_deref(), Some("Adobe Myungjo Std"));
    assert_eq!(f.over.font_style.as_deref(), Some("Bold"));
    let xml = String::from_utf8(doc.package().read(&format!("Stories/Story_{story}.xml")).unwrap().to_vec()).unwrap();
    assert!(xml.contains("Justification=\"CenterAlign\""));
    assert!(doc.apply(&json!({"op": "set_alignment", "story": story, "alignment": "diagonal"})).is_err());
    assert!(doc.apply(&json!({"op": "set_fill", "item": item, "color": "red"})).is_err());
}

#[test]
fn korean_in_a_new_document_keeps_its_own_font() {
    let mut doc = Idml::open(blank("A4", 1).unwrap()).unwrap();
    let r = doc.apply(&json!({"op": "add_text_frame", "page": 0, "box": [50, 60, 300, 80], "text": "가을호 특집"})).unwrap();
    let story = r["story"].as_str().unwrap();
    let xml = String::from_utf8(doc.package().read(&format!("Stories/Story_{story}.xml")).unwrap().to_vec()).unwrap();
    // The document's font (Source Han Sans SC) has Hangul: no extra runs.
    assert_eq!(xml.matches("<CharacterStyleRange").count(), 1, "{xml}");
}
