use present_engine::{Session, TxError};
use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::{Error, Presentation};

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#;
const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
const PRESENTATION: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId7"/></p:sldIdLst></p:presentation>"#;
const PRES_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
// Unusual prefix (`x:`), an unknown extension and a field, to prove they survive.
const SLIDE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:x="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>
      <p:txBody><x:bodyPr><x:normAutofit fontScale="90000"/></x:bodyPr><x:lstStyle/>
        <x:p><x:pPr algn="ctr"/><x:r><x:rPr lang="ko-KR" b="1"/><x:t>제목</x:t></x:r><x:r><x:rPr lang="en-US"/><x:t> one</x:t></x:r><x:endParaRPr lang="ko-KR"/></x:p>
        <x:p><x:fld id="{1}" type="slidenum"><x:t>1</x:t></x:fld></x:p>
      </p:txBody>
    </p:sp>
    <p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="6" name="Inner"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>
        <p:txBody><x:bodyPr/><x:p><x:endParaRPr sz="2000"><x:solidFill><x:srgbClr val="FF0000"/></x:solidFill></x:endParaRPr></x:p></p:txBody></p:sp>
    </p:grpSp>
  </p:spTree></p:cSld>
  <p:extLst><p:ext uri="{UNKNOWN}"><future xmlns="urn:future">keep me</future></p:ext></p:extLst>
</p:sld>"#;
const MEDIA: &[u8] = b"\x89PNG not really";

fn sample() -> Vec<u8> {
    Package::from_parts(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("ppt/presentation.xml", PRESENTATION.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", PRES_RELS.as_bytes()),
        ("ppt/slides/slide1.xml", SLIDE.as_bytes()),
        ("ppt/media/image1.png", MEDIA),
    ])
    .unwrap()
    .save()
    .unwrap()
}

fn replace(slide: usize, shape_id: u32, paragraphs: &[&str]) -> Command {
    Command::ReplaceText { slide, shape_id, paragraphs: paragraphs.iter().map(|s| s.to_string()).collect() }
}

fn slide_xml(bytes: &[u8]) -> String {
    let doc = Presentation::open(bytes.to_vec()).unwrap();
    String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap()
}

#[test]
fn no_op_save_is_byte_identical() {
    let original = sample();
    let doc = Presentation::open(original.clone()).unwrap();
    assert_eq!(doc.save().unwrap(), original);
}

#[test]
fn inspect_lists_shapes_text_and_groups() {
    let doc = Presentation::open(sample()).unwrap();
    let slide = doc.slide(1).unwrap();
    assert_eq!(slide.part, "ppt/slides/slide1.xml");
    assert_eq!(slide.shapes[0].paragraphs.as_deref(), Some(&["제목 one".to_string(), "1".to_string()][..]));
    assert_eq!(slide.shapes[1].kind, "grpSp");
    assert_eq!(slide.shapes[1].children[0].id, 6);
}

#[test]
fn replace_text_changes_only_the_target_paragraph() {
    let original = sample();
    let mut doc = Presentation::open(original.clone()).unwrap();
    let result = commands::run(&mut doc, &replace(1, 2, &["새 제목 & <특수>", "1"])).unwrap();
    assert_eq!(result["warnings"][0], "stored text shrink (normAutofit fontScale/lnSpcReduction) was not recomputed");
    let saved = doc.save().unwrap();
    let before = slide_xml(&original);
    let after = slide_xml(&saved);
    let old_p = r#"<x:p><x:pPr algn="ctr"/><x:r><x:rPr lang="ko-KR" b="1"/><x:t>제목</x:t></x:r><x:r><x:rPr lang="en-US"/><x:t> one</x:t></x:r><x:endParaRPr lang="ko-KR"/></x:p>"#;
    let new_p = r#"<x:p><x:pPr algn="ctr"/><x:r><x:rPr lang="ko-KR" b="1"/><x:t>새 제목 &amp; &lt;특수&gt;</x:t></x:r><x:endParaRPr lang="ko-KR"/></x:p>"#;
    assert_eq!(after, before.replace(old_p, new_p), "only the first paragraph may change");
    // The field paragraph and the unknown extension are untouched.
    assert!(after.contains(r#"<x:fld id="{1}" type="slidenum"><x:t>1</x:t></x:fld>"#));
    assert!(after.contains("<future xmlns=\"urn:future\">keep me</future>"));
    // Every other part keeps its exact stored bytes.
    let reopened = Presentation::open(saved).unwrap();
    for name in ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/media/image1.png"] {
        assert_eq!(reopened.package().original_record(name), Presentation::open(original.clone()).unwrap().package().original_record(name), "{name}");
    }
    assert_eq!(reopened.slide(1).unwrap().shapes[0].paragraphs.as_deref(), Some(&["새 제목 & <특수>".to_string(), "1".to_string()][..]));
}

#[test]
fn typing_into_empty_paragraph_uses_end_paragraph_formatting() {
    let mut doc = Presentation::open(sample()).unwrap();
    commands::run(&mut doc, &replace(1, 6, &["안쪽"])).unwrap();
    let xml = slide_xml(&doc.save().unwrap());
    assert!(xml.contains(r#"<x:p><x:r><x:rPr sz="2000"><x:solidFill><x:srgbClr val="FF0000"/></x:solidFill></x:rPr><x:t>안쪽</x:t></x:r><x:endParaRPr sz="2000">"#), "{xml}");
}

#[test]
fn paragraphs_can_be_added_and_removed() {
    let mut doc = Presentation::open(sample()).unwrap();
    commands::run(&mut doc, &replace(1, 2, &["a", "1", "c"])).unwrap();
    let texts = |d: &Presentation| d.slide(1).unwrap().shapes[0].paragraphs.clone().unwrap();
    assert_eq!(texts(&doc), vec!["a", "1", "c"]);
    commands::run(&mut doc, &replace(1, 2, &["only"])).unwrap();
    assert_eq!(texts(&doc), vec!["only"]);
    let reopened = Presentation::open(doc.save().unwrap()).unwrap();
    assert_eq!(texts(&reopened), vec!["only"]);
}

#[test]
fn undo_restores_identical_file() {
    let original = sample();
    let mut session = Session::new(Presentation::open(original.clone()).unwrap());
    session.apply(0, "r", "f", &[replace(1, 6, &["x"])], commands::run).unwrap();
    assert_ne!(session.document().save().unwrap(), original);
    session.undo(1).unwrap();
    assert_eq!(session.document().save().unwrap(), original);
}

#[test]
fn failing_batch_rolls_back_and_stale_write_is_refused() {
    let original = sample();
    let mut session = Session::new(Presentation::open(original.clone()).unwrap());
    let err = session.apply(0, "r1", "f1", &[replace(1, 2, &["ok", "1"]), replace(1, 99, &["x"])], commands::run).unwrap_err();
    assert!(matches!(err, TxError::Command { index: 1, error: Error::NotFound(_) }));
    assert_eq!(session.document().save().unwrap(), original);
    session.apply(0, "r2", "f2", &[replace(1, 2, &["ok", "1"])], commands::run).unwrap();
    let stale = session.apply(0, "r3", "f3", &[replace(1, 2, &["late", "1"])], commands::run).unwrap_err();
    assert!(matches!(stale, TxError::StaleVersion { expected: 0, actual: 1 }));
}

#[test]
fn unsupported_paragraph_content_is_refused_not_dropped() {
    let slide = SLIDE.replace("<x:p><x:fld", "<x:p><mc:AlternateContent xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\"/><x:fld");
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("ppt/presentation.xml", PRESENTATION.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", PRES_RELS.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    let mut doc = Presentation::open(bytes).unwrap();
    let err = commands::run(&mut doc, &replace(1, 2, &["제목 one", "changed"])).unwrap_err();
    assert!(matches!(err, Error::Unsupported(_)), "{err:?}");
    assert!(!doc.package().is_modified());
}

#[test]
fn newline_is_refused_and_vertical_tab_is_a_line_break() {
    let mut doc = Presentation::open(sample()).unwrap();
    let err = commands::run(&mut doc, &replace(1, 2, &["a\nb", "1"])).unwrap_err();
    assert!(matches!(err, Error::InvalidCommand(_)));
    commands::run(&mut doc, &replace(1, 2, &["위\u{b}아래", "1"])).unwrap();
    let xml = slide_xml(&doc.save().unwrap());
    assert!(xml.contains(r#"<x:t>위</x:t></x:r><x:br><x:rPr lang="ko-KR" b="1"/></x:br><x:r><x:rPr lang="ko-KR" b="1"/><x:t>아래</x:t></x:r>"#), "{xml}");
    let reopened = Presentation::open(doc.save().unwrap()).unwrap();
    assert_eq!(reopened.slide(1).unwrap().shapes[0].paragraphs.as_ref().unwrap()[0], "위\u{b}아래");
}
