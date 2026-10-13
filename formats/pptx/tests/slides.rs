use present_engine::Session;
use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::Presentation;

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn rels(items: &[(&str, &str, &str)]) -> String {
    let body: String = items.iter().map(|(id, ty, target)| format!(r#"<Relationship Id="{id}" Type="{REL}/{ty}" Target="{target}"/>"#)).collect();
    format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>"#)
}

fn slide(text: &str) -> String {
    format!(r#"<p:sld {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#)
}

/// Two slides. Slide 1 has notes, legacy comments and a picture only it uses;
/// both slides share the layout. Sections: A = [256], B = [257].
fn deck() -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/><Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>"#;
    let root = rels(&[("rId1", "officeDocument", "ppt/presentation.xml")]);
    let pres = format!(
        r#"<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:extLst><p:ext uri="{{521415D9-36F7-43E2-AB2F-B90AF26B5E84}}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="A" id="{{1}}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section><p14:section name="B" id="{{2}}"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>"#
    );
    let pres_rels = rels(&[("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "slide", "slides/slide1.xml"), ("rId3", "slide", "slides/slide2.xml")]);
    let s1_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "notesSlide", "../notesSlides/notesSlide1.xml"), ("rId3", "comments", "../comments/comment1.xml"), ("rId4", "image", "../media/image1.png")]);
    let s2_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]);
    let notes = format!(r#"<p:notes {NS}><p:cSld><p:spTree/></p:cSld></p:notes>"#);
    let notes_rels = rels(&[("rId1", "slide", "../slides/slide1.xml")]);
    let comments = format!(r#"<p:cmLst {NS}><p:cm authorId="0" idx="1"><p:text>hi</p:text></p:cm></p:cmLst>"#);
    let layout = format!(r#"<p:sldLayout {NS}><p:cSld name="Title Slide"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Date"/><p:cNvSpPr/><p:nvPr><p:ph type="dt" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="4" name="Sub"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld></p:sldLayout>"#);
    let layout_rels = rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]);
    let master = format!(r#"<p:sldMaster {NS}><p:cSld><p:spTree/></p:cSld></p:sldMaster>"#);
    let master_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]);
    let s1 = slide("one");
    let s2 = slide("two");
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", s1.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", s1_rels.as_bytes()),
        ("ppt/slides/slide2.xml", s2.as_bytes()),
        ("ppt/slides/_rels/slide2.xml.rels", s2_rels.as_bytes()),
        ("ppt/notesSlides/notesSlide1.xml", notes.as_bytes()),
        ("ppt/notesSlides/_rels/notesSlide1.xml.rels", notes_rels.as_bytes()),
        ("ppt/comments/comment1.xml", comments.as_bytes()),
        ("ppt/media/image1.png", b"\x89PNG"),
        ("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels.as_bytes()),
        ("ppt/slideMasters/slideMaster1.xml", master.as_bytes()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn run(doc: &mut Presentation, json: &str) -> serde_json::Value {
    let c: Command = serde_json::from_str(json).unwrap();
    let r = commands::run(doc, &c).unwrap();
    // Every result must survive a save and reopen.
    *doc = Presentation::open(doc.save().unwrap()).unwrap();
    r
}

fn text(doc: &Presentation, part: &str) -> String {
    String::from_utf8(doc.package().read(part).unwrap().to_vec()).unwrap()
}

fn titles(doc: &Presentation) -> Vec<String> {
    doc.slides().unwrap().iter().map(|s| s.shapes.first().and_then(|sh| sh.paragraphs.clone()).map(|p| p.join("/")).unwrap_or_default()).collect()
}

#[test]
fn duplicate_copies_owned_parts_and_shares_the_rest() {
    let mut doc = deck();
    let original_slide1 = text(&doc, "ppt/slides/slide1.xml");
    let r = run(&mut doc, r#"{"op":"duplicate_slide","slide":1}"#);
    assert_eq!(r["newSlide"], 2);
    assert_eq!(titles(&doc), ["one", "one", "two"]);
    assert_eq!(doc.slide_part(2).unwrap(), "ppt/slides/slide3.xml");
    assert_eq!(text(&doc, "ppt/slides/slide3.xml"), original_slide1);
    let copy_rels = text(&doc, "ppt/slides/_rels/slide3.xml.rels");
    assert!(copy_rels.contains(r#"Target="../slideLayouts/slideLayout1.xml""#), "layout shared");
    assert!(copy_rels.contains(r#"Target="../media/image1.png""#), "picture shared");
    assert!(copy_rels.contains(r#"Target="../notesSlides/notesSlide2.xml""#), "notes copied");
    assert!(!copy_rels.contains("comments"), "comments are not copied");
    assert!(text(&doc, "ppt/notesSlides/_rels/notesSlide2.xml.rels").contains(r#"Target="../slides/slide3.xml""#), "copied notes point at the copy");
    let ct = text(&doc, "[Content_Types].xml");
    assert!(ct.contains(r#"PartName="/ppt/slides/slide3.xml""#) && ct.contains(r#"PartName="/ppt/notesSlides/notesSlide2.xml""#));
    let pres = text(&doc, "ppt/presentation.xml");
    assert!(pres.contains(r#"<p:sldId id="256" r:id="rId2"/><p:sldId id="258" r:id="rId4"/><p:sldId id="257" r:id="rId3"/>"#), "{pres}");
    assert!(pres.contains(r#"<p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="258"/></p14:sldIdLst>"#), "{pres}");
    // The original slide's own parts are untouched.
    assert_eq!(text(&doc, "ppt/slides/_rels/slide1.xml.rels"), deck().package().read("ppt/slides/_rels/slide1.xml.rels").unwrap().iter().map(|&b| b as char).collect::<String>());
}

#[test]
fn delete_removes_the_slide_and_what_only_it_used() {
    let mut doc = deck();
    let r = run(&mut doc, r#"{"op":"delete_slide","slide":1}"#);
    assert_eq!(titles(&doc), ["two"]);
    let removed: Vec<String> = serde_json::from_value(r["removedParts"].clone()).unwrap();
    assert_eq!(removed, ["ppt/comments/comment1.xml", "ppt/media/image1.png", "ppt/notesSlides/notesSlide1.xml", "ppt/slides/slide1.xml"]);
    for p in &removed {
        assert!(!doc.package().contains(p), "{p}");
    }
    assert!(doc.package().contains("ppt/slideLayouts/slideLayout1.xml"), "shared layout stays");
    let ct = text(&doc, "[Content_Types].xml");
    assert!(!ct.contains("slide1.xml") && !ct.contains("notesSlide1") && !ct.contains("comment1"));
    let pres = text(&doc, "ppt/presentation.xml");
    assert!(pres.contains(r#"<p14:section name="A" id="{1}"><p14:sldIdLst></p14:sldIdLst></p14:section>"#), "{pres}");
    assert!(!text(&doc, "ppt/_rels/presentation.xml.rels").contains("slide1.xml"));
}

#[test]
fn move_keeps_sections_contiguous() {
    let mut doc = deck();
    run(&mut doc, r#"{"op":"move_slide","slide":2,"to":1}"#);
    assert_eq!(titles(&doc), ["two", "one"]);
    let pres = text(&doc, "ppt/presentation.xml");
    assert!(pres.contains(r#"<p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>"#));
    assert!(pres.contains(r#"<p14:section name="A" id="{1}"><p14:sldIdLst><p14:sldId id="257"/><p14:sldId id="256"/></p14:sldIdLst>"#), "{pres}");
    assert!(pres.contains(r#"<p14:section name="B" id="{2}"><p14:sldIdLst></p14:sldIdLst>"#), "{pres}");
}

#[test]
fn insert_uses_the_layout_placeholders_and_rename_names_it() {
    let mut doc = deck();
    let r = run(&mut doc, r#"{"op":"insert_slide","slide":2,"layout":"Title Slide"}"#);
    assert_eq!(r["part"], "ppt/slides/slide3.xml");
    assert_eq!(doc.slide_count(), 3);
    let s = text(&doc, "ppt/slides/slide3.xml");
    assert!(s.contains(r#"<p:ph type="ctrTitle"/>"#) && s.contains(r#"<p:ph type="subTitle" idx="1"/>"#));
    assert!(!s.contains(r#"type="dt""#), "date/footer/number placeholders are not added");
    assert!(text(&doc, "ppt/slides/_rels/slide3.xml.rels").contains(r#"Target="../slideLayouts/slideLayout1.xml""#));
    assert!(text(&doc, "[Content_Types].xml").contains(r#"PartName="/ppt/slides/slide3.xml""#));
    assert!(commands::run(&mut doc, &serde_json::from_str(r#"{"op":"insert_slide","slide":2,"layout":"Nope"}"#).unwrap()).is_err());
    run(&mut doc, r#"{"op":"rename_slide","slide":2,"name":"새 쪽"}"#);
    assert!(text(&doc, "ppt/slides/slide3.xml").contains(r#"<p:cSld name="새 쪽">"#));
}

#[test]
fn slide_commands_undo_in_one_step() {
    let original = deck().save().unwrap();
    let mut session = Session::new(deck());
    let batch: Vec<Command> = [
        r#"{"op":"duplicate_slide","slide":1}"#,
        r#"{"op":"delete_slide","slide":3}"#,
        r#"{"op":"move_slide","slide":2,"to":1}"#,
        r#"{"op":"insert_slide","slide":1}"#,
    ]
    .iter()
    .map(|j| serde_json::from_str(j).unwrap())
    .collect();
    session.apply(0, "r", "f", &batch, commands::run).unwrap();
    assert_eq!(session.document().slide_count(), 3);
    session.undo(1).unwrap();
    assert_eq!(session.document().save().unwrap(), original, "undo restores the exact file");
}
