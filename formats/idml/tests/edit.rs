//! Edits on a small document built with DesignCraft and saved as IDML.

use designcraft_doc::build::NewDocument;
use designcraft_doc::{Document, Item, ParaFormat, Shape, SpreadRef};
use designcraft_geom::{Rect, shapes};
use present_idml::{Error, Idml};
use serde_json::{Value, json};

fn sample() -> Vec<u8> {
    let mut d = Document::new(&NewDocument { facing_pages: false, ..Default::default() });
    let layer = d.layers[0].id;
    d.add_text_frame(SpreadRef::Doc(0), Rect::new(72.0, 72.0, 372.0, 272.0), layer, "Hello world\nSecond paragraph", ParaFormat::default()).unwrap();
    let id = designcraft_doc::ItemId(d.alloc());
    d.insert_item(SpreadRef::Doc(0), Item::new(id, layer, Shape::Rectangle, shapes::rectangle(Rect::new(100.0, 400.0, 200.0, 500.0))), None).unwrap();
    designcraft_idml::export_idml(&d)
}

fn find<'a>(desc: &'a Value, kind: &str) -> &'a Value {
    desc["items"].as_array().unwrap().iter().find(|i| i["kind"] == kind).unwrap()
}

fn paragraphs(doc: &Idml, story: &str) -> Vec<String> {
    let desc = doc.describe();
    let s = desc["stories"].as_array().unwrap().iter().find(|s| s["id"] == story).unwrap();
    s["paragraphs"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_string()).collect()
}

#[test]
fn saves_unchanged_bytes() {
    let bytes = sample();
    assert_eq!(Idml::open(bytes.clone()).unwrap().save().unwrap(), bytes);
}

#[test]
fn describes_pages_frames_and_stories() {
    let doc = Idml::open(sample()).unwrap();
    let desc = doc.describe();
    assert_eq!(desc["pages"].as_array().unwrap().len(), 1);
    let frame = find(&desc, "text");
    assert_eq!(frame["box"], json!([72.0, 72.0, 300.0, 200.0]));
    let story = frame["story"].as_str().unwrap();
    assert_eq!(paragraphs(&doc, story), ["Hello world", "Second paragraph"]);
    assert_eq!(find(&desc, "rectangle")["box"], json!([100.0, 400.0, 100.0, 100.0]));
}

#[test]
fn replaces_text_in_one_story_part() {
    let mut doc = Idml::open(sample()).unwrap();
    let story = find(&doc.describe(), "text")["story"].as_str().unwrap().to_string();
    let r = doc.apply(&json!({"op": "replace_text", "story": story, "find": "world", "replace": "<세계> & co"})).unwrap();
    assert_eq!(r["parts"], json!([format!("Stories/Story_{story}.xml")]));
    assert_eq!(doc.package().modified_parts(), [format!("Stories/Story_{story}.xml")]);
    assert_eq!(paragraphs(&doc, &story), ["Hello <세계> & co", "Second paragraph"]);
    // Saved and reopened, the edit is still there.
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    assert_eq!(paragraphs(&doc, &story)[0], "Hello <세계> & co");
}

#[test]
fn rejects_bad_text_edits_without_changing_anything() {
    let mut doc = Idml::open(sample()).unwrap();
    let story = find(&doc.describe(), "text")["story"].as_str().unwrap().to_string();
    let e = doc.apply(&json!({"op": "replace_text", "story": story, "find": "o", "replace": "0"})).unwrap_err();
    assert!(matches!(e, Error::InvalidCommand(_)), "{e:?}");
    let e = doc.apply(&json!({"op": "set_paragraph_text", "story": story, "paragraph": 0, "text": "a\nb"})).unwrap_err();
    assert!(matches!(e, Error::InvalidCommand(_)), "{e:?}");
    let e = doc.apply(&json!({"op": "set_paragraph_text", "story": story, "paragraph": 5, "text": "x"})).unwrap_err();
    assert!(matches!(e, Error::NotFound(_)), "{e:?}");
    assert!(!doc.package().is_modified());
    doc.apply(&json!({"op": "replace_text", "story": story, "find": "o", "replace": "0", "all": true})).unwrap();
    assert_eq!(paragraphs(&doc, &story), ["Hell0 w0rld", "Sec0nd paragraph"]);
}

#[test]
fn sets_a_paragraph() {
    let mut doc = Idml::open(sample()).unwrap();
    let story = find(&doc.describe(), "text")["story"].as_str().unwrap().to_string();
    doc.apply(&json!({"op": "set_paragraph_text", "story": story, "paragraph": 1, "text": "두 번째 문단"})).unwrap();
    assert_eq!(paragraphs(&doc, &story), ["Hello world", "두 번째 문단"]);
}

#[test]
fn moves_and_resizes() {
    let mut doc = Idml::open(sample()).unwrap();
    let desc = doc.describe();
    let rect = find(&desc, "rectangle")["id"].as_str().unwrap().to_string();
    let frame = find(&desc, "text")["id"].as_str().unwrap().to_string();
    doc.apply(&json!({"op": "set_box", "item": rect, "box": [50, 60, 150, 80]})).unwrap();
    doc.apply(&json!({"op": "set_box", "item": frame, "box": [null, 100, null, null]})).unwrap();
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    let desc = doc.describe();
    assert_eq!(find(&desc, "rectangle")["box"], json!([50.0, 60.0, 150.0, 80.0]));
    assert_eq!(find(&desc, "text")["box"], json!([72.0, 100.0, 300.0, 200.0]));
}

#[test]
fn deleting_the_only_frame_removes_its_story() {
    let mut doc = Idml::open(sample()).unwrap();
    let frame = find(&doc.describe(), "text").clone();
    let story = frame["story"].as_str().unwrap();
    doc.apply(&json!({"op": "delete", "item": frame["id"]})).unwrap();
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    let desc = doc.describe();
    assert_eq!(desc["items"].as_array().unwrap().len(), 1);
    assert!(desc["stories"].as_array().unwrap().is_empty());
    assert!(!doc.package().contains(&format!("Stories/Story_{story}.xml")));
    let map = doc.package().read("designmap.xml").unwrap();
    assert!(!String::from_utf8_lossy(&map).contains(&format!("Story_{story}.xml")));
}

fn formatted() -> (Idml, String) {
    let mut d = Document::new(&NewDocument { facing_pages: false, ..Default::default() });
    let layer = d.layers[0].id;
    let (_, sid) = d.add_text_frame(SpreadRef::Doc(0), Rect::new(72.0, 72.0, 372.0, 272.0), layer, "Big small\nTwo\nThree", ParaFormat::default()).unwrap();
    d.story_mut(sid).unwrap().format_chars(0..3, |f| f.over.size = Some(20.0));
    let doc = Idml::open(designcraft_idml::export_idml(&d)).unwrap();
    let story = find(&doc.describe(), "text")["story"].as_str().unwrap().to_string();
    (doc, story)
}

fn sizes(doc: &Idml) -> Vec<(String, Option<f64>)> {
    let d = doc.document();
    let story = d.stories.values().next().unwrap();
    story.runs().map(|(r, f)| (story.text[r].to_string(), f.over.size)).collect()
}

#[test]
fn replaces_a_range_across_runs_keeping_their_formatting() {
    let (mut doc, story) = formatted();
    assert_eq!(paragraphs(&doc, &story), ["Big small", "Two", "Three"]);
    // "g sm" spans the 20pt run "Big" and the plain run " small".
    doc.apply(&json!({"op": "replace_range", "story": story, "paragraph": 0, "start": 2, "end": 6, "text": "G-"})).unwrap();
    assert_eq!(paragraphs(&doc, &story)[0], "BiG-all");
    let runs = sizes(&doc);
    assert_eq!(runs[0], ("BiG-".to_string(), Some(20.0)));
    assert!(runs[1].0.starts_with("all") && runs[1].1.is_none(), "{runs:?}");
    let e = doc.apply(&json!({"op": "replace_range", "story": story, "paragraph": 0, "start": 5, "end": 99, "text": ""})).unwrap_err();
    assert!(matches!(e, Error::InvalidCommand(_)), "{e:?}");
}

#[test]
fn sets_story_text_with_more_or_fewer_paragraphs() {
    let (mut doc, story) = formatted();
    doc.apply(&json!({"op": "set_story_text", "story": story, "text": "A\nB\nC\nD\n"})).unwrap();
    assert_eq!(paragraphs(&doc, &story), ["A", "B", "C", "D", ""]);
    doc.apply(&json!({"op": "set_story_text", "story": story, "text": "Only"})).unwrap();
    assert_eq!(paragraphs(&doc, &story), ["Only"]);
    // The first paragraph kept its first run's 20pt.
    assert_eq!(sizes(&doc)[0], ("Only".to_string(), Some(20.0)));
    let doc = Idml::open(doc.save().unwrap()).unwrap();
    assert_eq!(paragraphs(&doc, &story), ["Only"]);
}

#[test]
fn inserted_text_the_font_lacks_gets_a_font_that_has_it() {
    let mut doc = Idml::open(sample()).unwrap();
    let story = find(&doc.describe(), "text")["story"].as_str().unwrap().to_string();
    let part = format!("Stories/Story_{story}.xml");
    let before = String::from_utf8(doc.package().read(&part).unwrap().to_vec()).unwrap();
    assert!(!before.contains("Source Han Sans SC"));
    // The sample is set in Source Serif 4, which has no Hangul.
    doc.apply(&json!({"op": "replace_text", "story": story, "find": "world", "replace": "세계 world"})).unwrap();
    let xml = String::from_utf8(doc.package().read(&part).unwrap().to_vec()).unwrap();
    assert_eq!(xml.matches("<AppliedFont type=\"string\">Source Han Sans SC</AppliedFont>").count(), 1, "{xml}");
    assert!(xml.contains("<Content>세계</Content>"), "{xml}");
    // The text reads the same, and the untouched paragraph keeps its font.
    assert_eq!(paragraphs(&doc, &story), ["Hello 세계 world", "Second paragraph"]);
    let reopened = Idml::open(doc.save().unwrap()).unwrap();
    assert_eq!(paragraphs(&reopened, &story), ["Hello 세계 world", "Second paragraph"]);
    // Latin text added later needs nothing.
    doc.apply(&json!({"op": "replace_text", "story": story, "find": "Second", "replace": "Third"})).unwrap();
    let xml = String::from_utf8(doc.package().read(&part).unwrap().to_vec()).unwrap();
    assert_eq!(xml.matches("Source Han Sans SC").count(), 1);
}
