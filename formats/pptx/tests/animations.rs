use present_pptx::commands::animation::{slide_animations, Start};
use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::xml::Tree;
use present_pptx::Presentation;

const SLIDE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Hi</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#;

fn deck() -> Presentation {
    deck_with(SLIDE)
}

fn deck_with(slide: &str) -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    let root = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
    let pres = r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#;
    let pres_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn run(doc: &mut Presentation, json: &str) -> String {
    let cmd: Command = serde_json::from_str(json).unwrap();
    commands::run(doc, &cmd).unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    Tree::parse(xml.as_bytes()).expect("well-formed after edit");
    xml
}

fn list(doc: &Presentation) -> Vec<(Option<u32>, String, Option<String>, Start, f64, f64)> {
    slide_animations(doc, 1).unwrap().into_iter().map(|a| (a.shape_id, a.class, a.effect, a.start, a.delay, a.duration)).collect()
}

fn assert_unique_ids(xml: &str) {
    let mut ids: Vec<&str> = xml.match_indices("<p:cTn id=\"").map(|(i, _)| &xml[i + 11..i + 11 + xml[i + 11..].find('"').unwrap()]).collect();
    let n = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), n, "duplicate cTn ids: {xml}");
}

#[test]
fn effects_are_added_grouped_and_retimed_as_powerpoint_writes_them() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"fade"}"#);
    // PowerPoint's own markup for a click-started fade, and a build entry
    // because the shape has text.
    assert!(xml.contains(r#" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="#), "{xml}");
    assert!(xml.contains(r#"<p:bldLst><p:bldP spid="2" grpId="0" animBg="1"/></p:bldLst></p:timing></p:sld>"#), "{xml}");
    assert_unique_ids(&xml);
    run(&mut doc, r#"{"op":"add_animation_effect","slide":1,"shapeId":3,"effect":"fly","start":"withPrevious"}"#);
    let xml = run(&mut doc, r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"spin","class":"emphasis","start":"afterPrevious","duration":1}"#);
    assert_eq!(
        list(&doc),
        vec![
            (Some(2), "entrance".into(), Some("fade".into()), Start::OnClick, 0.0, 0.5),
            (Some(3), "entrance".into(), Some("fly".into()), Start::WithPrevious, 0.0, 0.5),
            (Some(2), "emphasis".into(), Some("spin".into()), Start::AfterPrevious, 0.0, 1.0),
        ]
    );
    // The after-previous effect waits for the first time group (0.5 s); no
    // build entry for the shape without text; the second build group of
    // shape 2.
    assert!(xml.contains(r#"<p:cond delay="500"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="#), "{xml}");
    assert!(xml.contains(r#"<p:bldP spid="2" grpId="0" animBg="1"/><p:bldP spid="2" grpId="1" animBg="1"/></p:bldLst>"#), "{xml}");
    assert!(!xml.contains(r#"bldP spid="3""#));

    // Longer fade: the waiting effect moves back with it.
    let xml = run(&mut doc, r#"{"op":"set_animation_timing","slide":1,"index":0,"duration":2,"delay":0.25}"#);
    assert_eq!(list(&doc)[0].4, 0.25);
    assert_eq!(list(&doc)[0].5, 2.0);
    assert!(xml.contains(r#"<p:cond delay="2250"/>"#), "fade ends at 0.25 + 2 s: {xml}");

    // An after-previous effect first: the slide starts it without a click.
    let xml = run(&mut doc, r#"{"op":"move_animation_effect","slide":1,"index":2,"to":0}"#);
    assert!(xml.contains(r#"<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>"#), "{xml}");
    assert_eq!(list(&doc).iter().map(|a| a.2.clone().unwrap()).collect::<Vec<_>>(), ["spin", "fade", "fly"]);

    run(&mut doc, r#"{"op":"replace_animation_effect","slide":1,"index":2,"effect":"wipe","class":"exit"}"#);
    assert_eq!(list(&doc)[2], (Some(3), "exit".into(), Some("wipe".into()), Start::WithPrevious, 0.0, 0.5));

    assert_unique_ids(&String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap());

    // Removing everything leaves the slide as it was.
    for _ in 0..3 {
        run(&mut doc, r#"{"op":"remove_animation_effect","slide":1,"index":0}"#);
    }
    assert_eq!(String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap(), SLIDE);
}

#[test]
fn bad_animation_requests_are_refused() {
    let mut doc = deck();
    for bad in [
        r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"explode"}"#,
        r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"fade","class":"sideways"}"#,
        r#"{"op":"add_animation_effect","slide":1,"shapeId":9,"effect":"fade"}"#,
        r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"fade","start":"later"}"#,
        r#"{"op":"add_animation_effect","slide":1,"shapeId":2,"effect":"fade","duration":0}"#,
        r#"{"op":"remove_animation_effect","slide":1,"index":0}"#,
        r#"{"op":"set_animation_timing","slide":1,"index":0}"#,
    ] {
        let cmd: Command = serde_json::from_str(bad).unwrap();
        assert!(commands::run(&mut doc, &cmd).is_err(), "{bad}");
    }
    // An instant effect has no duration to set.
    run(&mut doc, r#"{"op":"add_animation_effect","slide":1,"shapeId":3,"effect":"appear"}"#);
    for bad in [r#"{"op":"set_animation_timing","slide":1,"index":0,"duration":2}"#, r#"{"op":"add_animation_effect","slide":1,"shapeId":3,"effect":"appear","duration":2}"#] {
        let cmd: Command = serde_json::from_str(bad).unwrap();
        assert!(commands::run(&mut doc, &cmd).is_err(), "{bad}");
    }
    run(&mut doc, r#"{"op":"remove_animation_effect","slide":1,"index":0}"#);
    assert_eq!(String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap(), SLIDE);
}

#[test]
fn an_empty_timing_root_gets_the_main_sequence() {
    // As some real decks carry: a root time node with nothing under it.
    let empty = r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>"#;
    let slide = SLIDE.replace("</p:sld>", &format!("{empty}</p:sld>"));
    let mut doc = deck_with(&slide);
    let xml = run(&mut doc, r#"{"op":"add_animation_effect","slide":1,"shapeId":3,"effect":"fade"}"#);
    assert!(xml.contains(r#"<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="6" dur="indefinite" nodeType="mainSeq">"#), "{xml}");
    assert_eq!(slide_animations(&doc, 1).unwrap().len(), 1);
    assert_unique_ids(&xml);
}
