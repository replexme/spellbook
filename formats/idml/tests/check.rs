//! The worker-side checks: safety scan, element graph and the change report of a save.

use designcraft_doc::build::NewDocument;
use designcraft_doc::{Document, ParaFormat, SpreadRef};
use designcraft_geom::Rect;
use present_idml::{Idml, check};
use serde_json::json;

fn sample() -> Vec<u8> {
    let mut d = Document::new(&NewDocument { facing_pages: false, ..Default::default() });
    let layer = d.layers[0].id;
    d.add_text_frame(SpreadRef::Doc(0), Rect::new(72.0, 72.0, 372.0, 272.0), layer, "Hello world", ParaFormat::default()).unwrap();
    designcraft_idml::export_idml(&d)
}

fn edited(bytes: &[u8]) -> Vec<u8> {
    let mut doc = Idml::open(bytes.to_vec()).unwrap();
    let story = doc.describe()["stories"][0]["id"].as_str().unwrap().to_string();
    doc.apply(&json!({"op": "replace_text", "story": story, "find": "world", "replace": "there"})).unwrap();
    doc.save().unwrap()
}

/// `bytes` with part `name` replaced (the package keeps every other part byte for byte).
fn with_part(bytes: &[u8], name: &str, data: &[u8]) -> Vec<u8> {
    let mut p = present_package::Package::open(bytes.to_vec()).unwrap();
    p.write(name, data.to_vec()).unwrap();
    p.save().unwrap()
}

#[test]
fn scans_a_package() {
    let bytes = sample();
    let s = check::scan(&bytes).unwrap();
    assert_eq!(s["slideCount"], 1);
    assert_eq!(s["documentSha256"], check::sha256_hex(&bytes));
    assert!(s["entryCount"].as_u64().unwrap() > 3);
}

#[test]
fn refuses_unsafe_part_names_and_other_files() {
    let bytes = with_part(&sample(), "../escape.xml", b"<x/>");
    assert!(check::scan(&bytes).is_err());
    assert!(check::scan(b"PK\x03\x04 not really").is_err());
}

#[test]
fn reports_a_story_edit_as_valid() {
    let base = sample();
    let saved = edited(&base);
    let r = check::change_report(&base, &saved);
    assert_eq!(r["valid"], true, "{r}");
    assert_eq!(r["candidateDocumentSha256"], check::sha256_hex(&saved));
    let changes = r["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["category"], "story");
}

#[test]
fn refuses_changes_outside_stories_and_spreads() {
    let base = sample();
    let saved = with_part(&edited(&base), "Resources/Styles.xml", b"<idPkg:Styles xmlns:idPkg=\"http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging\"/>");
    let r = check::change_report(&base, &saved);
    assert_eq!(r["valid"], false);
    assert!(r["errors"].as_array().unwrap().iter().any(|e| e.as_str().unwrap().starts_with("Resources/Styles.xml")), "{r}");
}

#[test]
fn element_graph_numbers_pages_and_hashes_items() {
    let bytes = sample();
    let doc = Idml::open(bytes.clone()).unwrap();
    let g = doc.element_graph(&bytes).unwrap();
    assert_eq!(g["documentSha256"], check::sha256_hex(&bytes));
    assert_eq!(g["slides"][0]["slideIndex"], 0);
    let e = &g["slides"][0]["elements"][0];
    assert_eq!(e["elementId"], "0/0");
    assert_eq!(e["text"], "Hello world");
    assert_eq!(e["x"], 72 * 12700);
    // Editing the story leaves the frame's XML, and so its hash, unchanged.
    let saved = edited(&bytes);
    let g2 = Idml::open(saved.clone()).unwrap().element_graph(&saved).unwrap();
    assert_eq!(g2["slides"][0]["elements"][0]["sourceHash"], e["sourceHash"]);
    assert_eq!(g2["slides"][0]["elements"][0]["text"], "Hello there");
}

#[test]
fn accepts_what_creation_commands_write() {
    let base = present_idml::blank("A4", 1).unwrap();
    let mut doc = Idml::open(base.clone()).unwrap();
    doc.apply(&json!({"op": "add_text_frame", "page": 0, "box": [10, 10, 100, 50], "text": "new"})).unwrap();
    doc.apply(&json!({"op": "add_shape", "page": 0, "box": [10, 100, 50, 50], "kind": "rectangle", "fill": "1C7ED6"})).unwrap();
    doc.apply(&json!({"op": "add_page", "after": 0})).unwrap();
    let saved = doc.save().unwrap();
    let r = check::change_report(&base, &saved);
    assert_eq!(r["valid"], true, "{r}");
    let kinds: Vec<String> = r["changes"].as_array().unwrap().iter().map(|c| format!("{}:{}", c["category"].as_str().unwrap(), c["changeKind"].as_str().unwrap())).collect();
    assert!(kinds.contains(&"story:added".to_string()) && kinds.contains(&"spread:added".to_string()) && kinds.contains(&"resources:modified".to_string()), "{kinds:?}");
}
