use base64::Engine;
use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::xml::Tree;
use present_pptx::Presentation;

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn rels(items: &[(&str, &str, &str)]) -> String {
    let body: String = items
        .iter()
        .map(|(id, ty, target)| {
            let ty = if ty.contains('/') { ty.to_string() } else { format!("{REL}/{ty}") };
            format!(r#"<Relationship Id="{id}" Type="{ty}" Target="{target}"/>"#)
        })
        .collect();
    format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>"#)
}

fn deck() -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#;
    let root = rels(&[("rId1", "officeDocument", "ppt/presentation.xml"), ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml")]);
    let core = r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old</dc:title></cp:coreProperties>"#;
    let pres = format!(r#"<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/></p:presentation>"#);
    let pres_rels = rels(&[("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "slide", "slides/slide1.xml"), ("rId3", "slide", "slides/slide2.xml"), ("rId4", "notesMaster", "notesMasters/notesMaster1.xml")]);
    let slide = |extra: &str| format!(r#"<p:sld {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>T</a:t></a:r></a:p></p:txBody></p:sp>{extra}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#);
    let s1 = slide(r#"<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>B</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>"#);
    let s2 = slide("");
    let s_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "image", "../media/image1.png")]);
    let s2_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]);
    let layout = |name: &str, phs: &str| format!(r#"<p:sldLayout {NS}><p:cSld name="{name}"><p:spTree>{phs}</p:spTree></p:cSld></p:sldLayout>"#);
    let ph = |id: u32, attrs: &str, y: u32| format!(r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="x"/><p:cNvSpPr/><p:nvPr><p:ph {attrs}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="{y}"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr></p:sp>"#);
    let l1 = layout("Title and Content", &(ph(2, r#"type="title""#, 0) + &ph(3, r#"idx="1""#, 12700)));
    let l2 = layout("Title Only", &ph(2, r#"type="title""#, 0));
    let l_rels = rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]);
    let master = format!(r#"<p:sldMaster {NS}><p:cSld><p:spTree/></p:cSld></p:sldMaster>"#);
    let m_rels = rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"), ("rId3", "theme", "../theme/theme1.xml")]);
    let theme = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#;
    let notes_master = format!(r#"<p:notesMaster {NS}><p:cSld><p:spTree/></p:cSld></p:notesMaster>"#);
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("docProps/core.xml", core.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", s1.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", s_rels.as_bytes()),
        ("ppt/slides/slide2.xml", s2.as_bytes()),
        ("ppt/slides/_rels/slide2.xml.rels", s2_rels.as_bytes()),
        ("ppt/media/image1.png", PNG),
        ("ppt/slideLayouts/slideLayout1.xml", l1.as_bytes()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", l_rels.as_bytes()),
        ("ppt/slideLayouts/slideLayout2.xml", l2.as_bytes()),
        ("ppt/slideLayouts/_rels/slideLayout2.xml.rels", l_rels.as_bytes()),
        ("ppt/slideMasters/slideMaster1.xml", master.as_bytes()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", m_rels.as_bytes()),
        ("ppt/theme/theme1.xml", theme.as_bytes()),
        ("ppt/notesMasters/notesMaster1.xml", notes_master.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

/// A 2 x 1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7B, 0x40, 0xE8, 0xDD,
    0x00, 0x00, 0x00, 0x0E, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x2C, 0x47, 0x2B, 0xE6, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
    0xAE, 0x42, 0x60, 0x82,
];

fn run(doc: &mut Presentation, json: &str) -> serde_json::Value {
    let c: Command = serde_json::from_str(json).unwrap();
    let r = commands::run(doc, &c).unwrap_or_else(|e| panic!("{json}: {e:?}"));
    *doc = Presentation::open(doc.save().unwrap()).unwrap();
    r
}

fn text(doc: &Presentation, part: &str) -> String {
    let s = String::from_utf8(doc.package().read(part).unwrap().to_vec()).unwrap();
    Tree::parse(s.as_bytes()).expect("well-formed");
    s
}

#[test]
fn pictures_in_and_replaced() {
    let mut doc = deck();
    let data = base64::engine::general_purpose::STANDARD.encode(PNG);
    let r = run(&mut doc, &format!(r#"{{"op":"insert_image","slide":2,"data":"{data}","x":10,"y":20,"width":100,"altText":"그림"}}"#));
    assert_eq!(r["shapeId"], 3);
    let s = text(&doc, "ppt/slides/slide2.xml");
    assert!(s.contains(r#"<a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/>"#), "height follows the 2:1 picture");
    assert!(s.contains(r#"descr="그림""#) && s.contains(r#"<a:blip r:embed="rId2"/>"#));
    assert!(doc.package().contains("ppt/media/image2.png"));
    assert!(text(&doc, "[Content_Types].xml").contains(r#"<Default Extension="png" ContentType="image/png"/>"#));
    // Replacing the only use of image1 removes it.
    run(&mut doc, &format!(r#"{{"op":"replace_image","slide":1,"shapeId":4,"data":"{data}"}}"#));
    let s = text(&doc, "ppt/slides/slide1.xml");
    assert!(s.contains(r#"<a:blip r:embed="rId3"/>"#) && !s.contains("srcRect"));
    assert!(!doc.package().contains("ppt/media/image1.png"));
    assert!(!text(&doc, "ppt/slides/_rels/slide1.xml.rels").contains("image1.png"));
    let bad = serde_json::from_str::<Command>(r#"{"op":"insert_image","slide":1,"data":"aGVsbG8="}"#).unwrap();
    assert!(commands::run(&mut doc, &bad).is_err());
}

#[test]
fn background_transition_size_sections() {
    let mut doc = deck();
    run(&mut doc, r#"{"op":"set_background","slide":1,"color":"112233"}"#);
    assert!(text(&doc, "ppt/slides/slide1.xml").contains(r#"<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>"#));
    run(&mut doc, r#"{"op":"set_background","slide":1}"#);
    assert!(!text(&doc, "ppt/slides/slide1.xml").contains("<p:bg>"));
    run(&mut doc, r#"{"op":"set_slide_transition","slide":1,"transition":"push","direction":"u","speed":"slow"}"#);
    assert!(text(&doc, "ppt/slides/slide1.xml").contains(r#"<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition spd="slow"><p:push dir="u"/></p:transition></p:sld>"#));
    run(&mut doc, r#"{"op":"set_slide_transition","slide":1,"transition":"none"}"#);
    assert!(!text(&doc, "ppt/slides/slide1.xml").contains("transition"));
    run(&mut doc, r#"{"op":"set_slide_size","slide":1,"width":960,"height":540}"#);
    assert!(text(&doc, "ppt/presentation.xml").contains(r#"<p:sldSz cx="12192000" cy="6858000"/>"#));
    run(&mut doc, r#"{"op":"set_sections","slide":1,"sections":[{"name":"앞","slides":[1]},{"name":"뒤","slides":[2]}]}"#);
    let p = text(&doc, "ppt/presentation.xml");
    assert!(p.contains(r#"<p14:section name="앞""#) && p.contains(r#"<p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst>"#));
    let bad = serde_json::from_str::<Command>(r#"{"op":"set_sections","slide":1,"sections":[{"name":"x","slides":[2,1]}]}"#).unwrap();
    assert!(commands::run(&mut doc, &bad).is_err());
    run(&mut doc, r#"{"op":"set_sections","slide":1,"sections":[]}"#);
    assert!(!text(&doc, "ppt/presentation.xml").contains("sectionLst"));
}

#[test]
fn layout_notes_properties_theme_and_links() {
    let mut doc = deck();
    // Title Only has no body placeholder: the body keeps its position.
    let r = run(&mut doc, r#"{"op":"set_slide_layout","slide":1,"layout":"Title Only"}"#);
    assert_eq!(r["keptPositions"], serde_json::json!([3]));
    assert!(text(&doc, "ppt/slides/_rels/slide1.xml.rels").contains(r#"Target="../slideLayouts/slideLayout2.xml""#));
    assert!(text(&doc, "ppt/slides/slide1.xml").contains(r#"<a:off x="0" y="12700"/>"#));
    run(&mut doc, r#"{"op":"set_speaker_notes","slide":2,"paragraphs":["발표 메모","둘째 줄"]}"#);
    let n = text(&doc, "ppt/notesSlides/notesSlide1.xml");
    assert!(n.contains("<a:t>발표 메모</a:t>") && n.contains(r#"<p:ph type="body" idx="1"/>"#));
    assert!(text(&doc, "ppt/notesSlides/_rels/notesSlide1.xml.rels").contains(r#"Target="../slides/slide2.xml""#));
    run(&mut doc, r#"{"op":"set_speaker_notes","slide":2,"paragraphs":["바뀐 메모"]}"#);
    assert!(text(&doc, "ppt/notesSlides/notesSlide1.xml").contains("<a:t>바뀐 메모</a:t>"));
    run(&mut doc, r#"{"op":"set_slide_metadata","slide":1,"title":"새 제목","author":"리플렉스"}"#);
    let c = text(&doc, "docProps/core.xml");
    assert!(c.contains("<dc:title>새 제목</dc:title>") && c.contains("<dc:creator>리플렉스</dc:creator>"));
    run(&mut doc, r#"{"op":"set_master_theme","slide":1,"colors":{"accent1":"FF0000","dk1":"111111"},"headingFont":"Arial","bodyEastAsianFont":"맑은 고딕"}"#);
    let t = text(&doc, "ppt/theme/theme1.xml");
    assert!(t.contains(r#"<a:dk1><a:srgbClr val="111111"/></a:dk1>"#) && t.contains(r#"<a:accent1><a:srgbClr val="FF0000"/></a:accent1>"#));
    assert!(t.contains(r#"<a:majorFont><a:latin typeface="Arial"/>"#) && t.contains(r#"<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="맑은 고딕"/>"#));
    run(&mut doc, r#"{"op":"set_object_interaction","slide":1,"shapeId":2,"action":"slide","targetSlide":2}"#);
    let s = text(&doc, "ppt/slides/slide1.xml");
    assert!(s.contains(r#"<p:cNvPr id="2" name="Title"><a:hlinkClick r:id="rId3" action="ppaction://hlinksldjump"/></p:cNvPr>"#), "{s}");
    run(&mut doc, r#"{"op":"set_object_interaction","slide":1,"shapeId":2,"action":"url","url":"https://example.com"}"#);
    assert!(text(&doc, "ppt/slides/_rels/slide1.xml.rels").contains(r#"Target="https://example.com" TargetMode="External""#));
    run(&mut doc, r#"{"op":"set_object_interaction","slide":1,"shapeId":2,"action":"none"}"#);
    assert!(!text(&doc, "ppt/slides/slide1.xml").contains("hlinkClick"));
}

#[test]
fn comments_are_added_edited_and_deleted() {
    let mut doc = deck();
    let r = run(&mut doc, r#"{"op":"add_comment","slide":1,"text":"이 문장 확인","author":"검토자","created":"2026-10-11T09:00:00.000"}"#);
    assert_eq!(r["commentId"], "0:1");
    let r = run(&mut doc, r#"{"op":"add_comment","slide":1,"text":"두 번째","author":"검토자","x":100,"y":50,"created":"2026-10-11T09:01:00.000"}"#);
    assert_eq!(r["commentId"], "0:2");
    assert!(text(&doc, "ppt/commentAuthors.xml").contains(r#"<p:cmAuthor id="0" name="검토자" initials="검" lastIdx="2" clrIdx="0"/>"#));
    assert!(text(&doc, "ppt/comments/comment1.xml").contains(r#"<p:cm authorId="0" dt="2026-10-11T09:01:00.000" idx="2"><p:pos x="800" y="400"/><p:text>두 번째</p:text></p:cm>"#));
    run(&mut doc, r#"{"op":"edit_comment","slide":1,"commentId":"0:1","text":"고친 메모"}"#);
    let list = present_pptx::commands::comments::slide_comments(&doc, 1).unwrap();
    assert_eq!(list.iter().map(|c| (c.id.as_str(), c.author.as_str(), c.text.as_str())).collect::<Vec<_>>(), [("0:1", "검토자", "고친 메모"), ("0:2", "검토자", "두 번째")]);
    run(&mut doc, r#"{"op":"delete_comment","slide":1,"commentId":"0:1"}"#);
    assert_eq!(present_pptx::commands::comments::slide_comments(&doc, 1).unwrap().len(), 1);
    let missing = serde_json::from_str::<Command>(r#"{"op":"delete_comment","slide":1,"commentId":"9:9"}"#).unwrap();
    assert!(commands::run(&mut doc, &missing).is_err());
}
