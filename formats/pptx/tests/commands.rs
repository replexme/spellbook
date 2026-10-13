use present_engine::Session;
use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::xml::Tree;
use present_pptx::{Error, Presentation};

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#;
const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
const PRESENTATION: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId7"/></p:sldIdLst></p:presentation>"#;
const PRES_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
// Shape 2: explicit position, geometry, fill and outline. Group 5 maps its
// 100 pt child space onto 200 pt (scale 2) at 100 pt; shape 6 sits inside.
// Shape 7: text with a run lacking properties and an empty paragraph.
// Shape 8 is animated, shape 9 is a connector end.
const SLIDE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr></p:sp>
    <p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr>
      <p:sp><p:nvSpPr><p:cNvPr id="6" name="Inner"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="127000"/><a:ext cx="254000" cy="254000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:sp>
    </p:grpSp>
    <p:sp><p:nvSpPr><p:cNvPr id="7" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="1800"><a:latin typeface="Old" panose="0"/></a:rPr><a:t>가</a:t></a:r><a:r><a:t>B</a:t></a:r></a:p><a:p/><a:p><a:pPr marL="0"/><a:r><a:rPr lang="en-US"/><a:t>C</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="8" name="Animated"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="9" name="Anchor"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>
    <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="10" name="Link"/><p:cNvCxnSpPr><a:stCxn id="9" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>
  </p:spTree></p:cSld>
  <p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:set><p:cBhvr><p:cTn id="2"/><p:tgtEl><p:spTgt spid="8"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>
</p:sld>"#;

fn deck() -> Presentation {
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("ppt/presentation.xml", PRESENTATION.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", PRES_RELS.as_bytes()),
        ("ppt/slides/slide1.xml", SLIDE.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn cmd(json: &str) -> Command {
    serde_json::from_str(json).unwrap()
}

/// Runs one command and returns the slide XML, checking it parses.
fn run(doc: &mut Presentation, json: &str) -> String {
    commands::run(doc, &cmd(json)).unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    Tree::parse(xml.as_bytes()).expect("well-formed after edit");
    xml
}

fn shape_xml(xml: &str, id: u32) -> String {
    let start = xml.find(&format!(r#"<p:cNvPr id="{id}""#)).unwrap();
    let open = xml[..start].rfind("<p:sp>").or_else(|| xml[..start].rfind("<p:cxnSp>")).unwrap();
    let end = xml[start..].find("</p:sp>").map(|e| start + e + 7).unwrap();
    xml[open..end].to_owned()
}

#[test]
fn move_resize_rotate_and_flip_edit_only_the_position() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"move","slide":1,"shapeId":2,"x":30,"y":40}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:off x="381000" y="508000"/><a:ext cx="1270000" cy="635000"/>"#));
    let xml = run(&mut doc, r#"{"op":"resize","slide":1,"shapeId":2,"width":50,"height":25}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:off x="381000" y="508000"/><a:ext cx="635000" cy="317500"/>"#));
    let xml = run(&mut doc, r#"{"op":"rotate","slide":1,"shapeId":2,"degrees":-90}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:xfrm rot="16200000">"#));
    let xml = run(&mut doc, r#"{"op":"flip","slide":1,"shapeId":2,"horizontal":true}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:xfrm rot="16200000" flipH="1">"#));
    let xml = run(&mut doc, r#"{"op":"rotate","slide":1,"shapeId":2,"degrees":0}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:xfrm flipH="1">"#));
}

#[test]
fn move_inside_a_scaled_group_converts_slide_points() {
    let mut doc = deck();
    // Group: slide = 100 pt + 2 x child. Slide 140 pt -> child 20 pt.
    let xml = run(&mut doc, r#"{"op":"move","slide":1,"shapeId":6,"x":140,"y":120}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:off x="254000" y="127000"/>"#));
    let xml = run(&mut doc, r#"{"op":"resize","slide":1,"shapeId":6,"width":80,"height":40}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:ext cx="508000" cy="254000"/>"#));
}

#[test]
fn fill_and_outline_follow_schema_order() {
    let mut doc = deck();
    let xml = run(&mut doc, r##"{"op":"fill_color","slide":1,"shapeId":2,"color":"#ff0000"}"##);
    assert!(shape_xml(&xml, 2).contains(r#"</a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="12700">"#));
    let xml = run(&mut doc, r#"{"op":"line_color","slide":1,"shapeId":2,"color":"00FF00"}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:prstDash val="dash"/></a:ln>"#));
    let xml = run(&mut doc, r#"{"op":"line_width","slide":1,"shapeId":2,"width":3}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:ln w="38100">"#));
    // A shape without its own outline gets one after its geometry and fill.
    let xml = run(&mut doc, r#"{"op":"line_width","slide":1,"shapeId":6,"width":2}"#);
    assert!(shape_xml(&xml, 6).contains(r#"</a:prstGeom><a:ln w="25400"/></p:spPr>"#));
}

#[test]
fn character_formats_reach_every_run_and_empty_paragraphs() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"bold","slide":1,"shapeId":7,"value":true}"#);
    let s = shape_xml(&xml, 7);
    assert!(s.contains(r#"<a:rPr lang="ko-KR" sz="1800" b="1">"#));
    assert!(s.contains(r#"<a:r><a:rPr b="1"/><a:t>B</a:t></a:r>"#), "{s}");
    assert!(s.contains(r#"<a:p><a:endParaRPr b="1"/></a:p>"#), "{s}");
    assert!(s.contains(r#"<a:endParaRPr lang="en-US" b="1"/>"#));
    let xml = run(&mut doc, r#"{"op":"font_family","slide":1,"shapeId":7,"paragraph":0,"family":"맑은 고딕"}"#);
    let s = shape_xml(&xml, 7);
    assert!(s.contains(r#"<a:rPr lang="ko-KR" sz="1800" b="1"><a:latin typeface="맑은 고딕"/><a:ea typeface="맑은 고딕"/></a:rPr>"#), "{s}");
    assert!(s.contains(r#"<a:rPr lang="en-US" b="1"/><a:t>C</a:t>"#), "paragraph 2 untouched: {s}");
    let xml = run(&mut doc, r#"{"op":"font_color","slide":1,"shapeId":7,"paragraph":2,"color":"336699"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:rPr lang="en-US" b="1"><a:solidFill><a:srgbClr val="336699"/></a:solidFill></a:rPr><a:t>C</a:t>"#));
    let xml = run(&mut doc, r#"{"op":"font_size","slide":1,"shapeId":7,"paragraph":2,"size":10.5}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:rPr lang="en-US" b="1" sz="1050">"#));
    let xml = run(&mut doc, r#"{"op":"underline","slide":1,"shapeId":7,"paragraph":2,"value":true}"#);
    assert!(shape_xml(&xml, 7).contains(r#"u="sng""#));
    let xml = run(&mut doc, r#"{"op":"strikethrough","slide":1,"shapeId":7,"paragraph":2,"value":false}"#);
    assert!(shape_xml(&xml, 7).contains(r#"strike="noStrike""#));
    let xml = run(&mut doc, r#"{"op":"paragraph_alignment","slide":1,"shapeId":7,"align":"center"}"#);
    let s = shape_xml(&xml, 7);
    assert!(s.contains(r#"<a:p><a:pPr algn="ctr"/><a:r>"#));
    assert!(s.contains(r#"<a:p><a:pPr algn="ctr"/><a:endParaRPr b="1"/></a:p>"#), "{s}");
    assert!(s.contains(r#"<a:pPr marL="0" algn="ctr"/>"#));
}

#[test]
fn names_alt_text_and_hidden_slides() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_shape_name","slide":1,"shapeId":2,"name":"제목 \"A\" & B"}"#);
    assert!(xml.contains(r#"<p:cNvPr id="2" name="제목 &quot;A&quot; &amp; B"/>"#));
    let xml = run(&mut doc, r#"{"op":"set_alt_text","slide":1,"shapeId":2,"text":"빨간 상자"}"#);
    assert!(xml.contains(r#"name="제목 &quot;A&quot; &amp; B" descr="빨간 상자"/>"#));
    let xml = run(&mut doc, r#"{"op":"set_slide_hidden","slide":1,"hidden":true}"#);
    assert!(xml.contains(r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" show="0">"#));
    let xml = run(&mut doc, r#"{"op":"set_slide_hidden","slide":1,"hidden":false}"#);
    assert!(!xml.contains("show="));
}

#[test]
fn delete_is_refused_while_an_animation_or_connector_uses_the_shape() {
    let mut doc = deck();
    for id in [8, 9] {
        let r = commands::run(&mut doc, &cmd(&format!(r#"{{"op":"delete_element","slide":1,"shapeId":{id}}}"#)));
        assert!(matches!(r, Err(Error::Unsupported(_))), "shape {id}: {r:?}");
    }
    let xml = run(&mut doc, r#"{"op":"delete_element","slide":1,"shapeId":2}"#);
    assert!(!xml.contains(r#"name="Box""#));
    assert!(xml.contains(r#"name="Group""#));
}

#[test]
fn invalid_values_are_refused_and_a_batch_undoes_in_one_step() {
    let mut doc = deck();
    for bad in [
        r#"{"op":"fill_color","slide":1,"shapeId":2,"color":"red"}"#,
        r#"{"op":"font_size","slide":1,"shapeId":7,"size":0}"#,
        r#"{"op":"line_width","slide":1,"shapeId":2,"width":-1}"#,
        r#"{"op":"paragraph_alignment","slide":1,"shapeId":7,"align":"middle"}"#,
        r#"{"op":"flip","slide":1,"shapeId":2}"#,
        r#"{"op":"bold","slide":1,"shapeId":7,"paragraph":9,"value":true}"#,
    ] {
        assert!(commands::run(&mut doc, &cmd(bad)).is_err(), "{bad}");
    }
    let original = deck().package().read("ppt/slides/slide1.xml").unwrap().to_vec();
    let mut session = Session::new(deck());
    let batch = vec![
        cmd(r#"{"op":"move","slide":1,"shapeId":2,"x":0,"y":0}"#),
        cmd(r#"{"op":"bold","slide":1,"shapeId":7,"value":true}"#),
        cmd(r#"{"op":"fill_color","slide":1,"shapeId":6,"color":"123456"}"#),
    ];
    session.apply(0, "r1", "f1", &batch, commands::run).unwrap();
    let slide = |s: &Session<Presentation>| s.document().package().read("ppt/slides/slide1.xml").unwrap().to_vec();
    assert_ne!(slide(&session), original);
    session.undo(1).unwrap();
    assert_eq!(slide(&session), original);
}

#[test]
fn stacking_order_moves_whole_elements() {
    let mut doc = deck();
    let ids = |xml: &str| -> Vec<u32> {
        let tree = Tree::parse(xml.as_bytes()).unwrap();
        let sp_tree = tree.nodes.iter().position(|n| n.local == "spTree").unwrap();
        tree.node(sp_tree).children.iter().filter_map(|&c| {
            let n = tree.node(c);
            let nv = n.children.iter().find(|&&x| tree.node(x).local.starts_with("nv"))?;
            tree.node(*tree.node(*nv).children.first()?).attr("id")?.parse().ok()
        }).collect()
    };
    let xml = run(&mut doc, r#"{"op":"z_order","slide":1,"shapeId":2,"action":"front"}"#);
    assert_eq!(ids(&xml), [5, 7, 8, 9, 10, 2]);
    let xml = run(&mut doc, r#"{"op":"z_order","slide":1,"shapeId":2,"action":"backward"}"#);
    assert_eq!(ids(&xml), [5, 7, 8, 9, 2, 10]);
    let xml = run(&mut doc, r#"{"op":"set_reading_order","slide":1,"order":[10,9,8,7,5,2]}"#);
    assert_eq!(ids(&xml), [10, 9, 8, 7, 5, 2]);
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"set_reading_order","slide":1,"order":[10,9]}"#)).is_err());
}

#[test]
fn transparency_line_style_fill_and_shadow() {
    let mut doc = deck();
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"fill_opacity","slide":1,"shapeId":2,"opacity":0.5}"#)).is_err(), "no own fill colour yet");
    run(&mut doc, r#"{"op":"fill_color","slide":1,"shapeId":2,"color":"FF0000"}"#);
    let xml = run(&mut doc, r#"{"op":"fill_opacity","slide":1,"shapeId":2,"opacity":0.25}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:srgbClr val="FF0000"><a:alpha val="25000"/></a:srgbClr>"#));
    let xml = run(&mut doc, r#"{"op":"line_opacity","slide":1,"shapeId":2,"opacity":1}"#);
    assert!(!shape_xml(&xml, 2).contains(r#"<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"><a:alpha"#));
    let xml = run(&mut doc, r#"{"op":"set_line_style","slide":1,"shapeId":2,"dash":"sysDot","tail":"triangle"}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:prstDash val="sysDot"/><a:tailEnd type="triangle"/></a:ln>"#), "{}", shape_xml(&xml, 2));
    let xml = run(&mut doc, r#"{"op":"set_shape_fill","slide":1,"shapeId":6,"fill":"gradient","colors":["FF0000","0000FF"],"angle":0}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>"#));
    let xml = run(&mut doc, r#"{"op":"set_shape_shadow","slide":1,"shapeId":6,"enabled":true}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst></p:spPr>"#));
    let xml = run(&mut doc, r#"{"op":"set_shape_shadow","slide":1,"shapeId":6,"enabled":false}"#);
    assert!(shape_xml(&xml, 6).contains("<a:effectLst/></p:spPr>"));
    let xml = run(&mut doc, r#"{"op":"set_shape_effects","slide":1,"shapeId":6,"glow":{"radius":10,"color":"FF0000"},"softEdge":5}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:effectLst><a:glow rad="127000"><a:srgbClr val="FF0000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:softEdge rad="63500"/></a:effectLst>"#), "{}", shape_xml(&xml, 6));
    let xml = run(&mut doc, r#"{"op":"set_shape_effects","slide":1,"shapeId":6,"reflection":{},"softEdge":0}"#);
    assert!(shape_xml(&xml, 6).contains(r#"<a:effectLst><a:glow rad="127000"><a:srgbClr val="FF0000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dist="0" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>"#), "{}", shape_xml(&xml, 6));
    let xml = run(&mut doc, r#"{"op":"set_shape_effects","slide":1,"shapeId":6,"glow":{"radius":0},"reflection":{"size":0}}"#);
    assert!(shape_xml(&xml, 6).contains("<a:effectLst/></p:spPr>"));
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"set_shape_effects","slide":1,"shapeId":6}"#)).is_err(), "nothing to set");
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"set_shape_effects","slide":1,"shapeId":6,"glow":{"radius":5}}"#)).is_err(), "glow without colour");
    let xml = run(&mut doc, r#"{"op":"set_object_lock","slide":1,"shapeId":2,"locks":{"noMove":true,"noResize":true}}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<p:cNvSpPr><a:spLocks noMove="1" noResize="1"/></p:cNvSpPr>"#));
}

#[test]
fn paragraph_and_text_box_settings() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_paragraph_format","slide":1,"shapeId":7,"paragraph":2,"indentLeft":10,"spaceBefore":6,"lineSpacing":1.5}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:pPr marL="127000"><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr>"#), "{}", shape_xml(&xml, 7));
    let xml = run(&mut doc, r#"{"op":"set_paragraph_list","slide":1,"shapeId":7,"paragraph":0,"kind":"number","scheme":"hangulGanadaPeriod"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:pPr marL="342900" indent="-342900"><a:buAutoNum type="hangulGanadaPeriod"/></a:pPr>"#));
    let xml = run(&mut doc, r#"{"op":"set_text_box","slide":1,"shapeId":7,"insets":[0,0,0,0],"anchor":"middle","wrap":false}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"/>"#));
    let xml = run(&mut doc, r#"{"op":"set_fontwork","slide":1,"shapeId":7,"preset":"textArchUp","adjust":{"adj":10800000}}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"><a:prstTxWarp prst="textArchUp"><a:avLst><a:gd name="adj" fmla="val 10800000"/></a:avLst></a:prstTxWarp></a:bodyPr>"#), "{}", shape_xml(&xml, 7));
    let xml = run(&mut doc, r#"{"op":"set_fontwork","slide":1,"shapeId":7,"preset":"none"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" wrap="none"/>"#));
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"set_fontwork","slide":1,"shapeId":7,"preset":"textSpiral"}"#)).is_err());
    let xml = run(&mut doc, r#"{"op":"text_autofit","slide":1,"shapeId":7,"mode":"shrink"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"anchor="ctr" wrap="none"><a:normAutofit/></a:bodyPr>"#));
    let xml = run(&mut doc, r#"{"op":"set_text_case","slide":1,"shapeId":7,"case":"upper"}"#);
    assert!(shape_xml(&xml, 7).contains("<a:t>C</a:t>"));
    let xml = run(&mut doc, r#"{"op":"set_text_case","slide":1,"shapeId":7,"paragraph":0,"case":"lower"}"#);
    assert!(shape_xml(&xml, 7).contains("<a:t>b</a:t>"));
    let xml = run(&mut doc, r#"{"op":"set_script_position","slide":1,"shapeId":7,"paragraph":2,"position":"superscript"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"baseline="30000""#));
    let xml = run(&mut doc, r#"{"op":"set_character_spacing","slide":1,"shapeId":7,"spacing":-0.5}"#);
    assert!(shape_xml(&xml, 7).contains(r#"spc="-50""#));
    let xml = run(&mut doc, r#"{"op":"text_shadow","slide":1,"shapeId":7,"paragraph":2,"enabled":true,"color":"FF0000"}"#);
    assert!(shape_xml(&xml, 7).contains(r#"<a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="FF0000">"#));
}

#[test]
fn duplicate_add_align_and_distribute() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"duplicate_element","slide":1,"shapeId":5,"dx":10,"dy":0}"#);
    // The group and its child get new ids (11, 12); the copy sits right after the original.
    assert!(xml.contains(r#"<p:cNvPr id="11" name="Group"/>"#) && xml.contains(r#"<p:cNvPr id="12" name="Inner"/>"#));
    assert!(xml.contains(r#"<a:off x="1397000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/>"#), "only the group's own offset moves");
    let r = commands::run(&mut doc, &cmd(r#"{"op":"add_text_box","slide":1,"x":10,"y":20,"width":100,"height":30,"paragraphs":["안녕", ""],"size":20}"#)).unwrap();
    assert_eq!(r["shapeId"], 13);
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    assert!(xml.contains(r#"<p:cNvPr id="13" name="TextBox 12"/><p:cNvSpPr txBox="1"/>"#));
    assert!(xml.contains(r#"<a:r><a:rPr lang="ko-KR" altLang="en-US" sz="2000"/><a:t>안녕</a:t></a:r>"#));
    let xml = run(&mut doc, r#"{"op":"add_shape","slide":1,"preset":"rightArrow","x":0,"y":0,"width":50,"height":20,"fill":"00FF00","paragraphs":["→"]}"#);
    assert!(xml.contains(r#"<a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr><p:style>"#));
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"add_shape","slide":1,"preset":"blob","x":0,"y":0,"width":5,"height":5}"#)).is_err());
    // Shape 2 at (30, 40) after move; shape 7 at (0, 0). Align their left edges.
    run(&mut doc, r#"{"op":"move","slide":1,"shapeId":2,"x":30,"y":40}"#);
    let xml = run(&mut doc, r#"{"op":"align","slide":1,"shapeIds":[2,7],"to":"left"}"#);
    assert!(shape_xml(&xml, 2).contains(r#"<a:off x="0" y="508000"/>"#));
    // Three boxes 100 pt wide at x 0, 50, 400: the middle one moves to 200.
    run(&mut doc, r#"{"op":"move","slide":1,"shapeId":2,"x":50,"y":0}"#);
    run(&mut doc, r#"{"op":"resize","slide":1,"shapeId":2,"width":100,"height":10}"#);
    run(&mut doc, r#"{"op":"resize","slide":1,"shapeId":7,"width":100,"height":10}"#);
    let r = commands::run(&mut doc, &cmd(r#"{"op":"add_shape","slide":1,"preset":"rect","x":400,"y":0,"width":100,"height":10}"#)).unwrap();
    let third = r["shapeId"].as_u64().unwrap();
    let xml = run(&mut doc, &format!(r#"{{"op":"distribute","slide":1,"shapeIds":[7,2,{third}],"direction":"horizontal"}}"#));
    assert!(shape_xml(&xml, 2).contains(r#"<a:off x="2540000" y="0"/>"#), "{}", shape_xml(&xml, 2));
}

#[test]
fn group_ungroup_connect_and_freeform() {
    let mut doc = deck();
    // Ungroup: the scaled group's child comes out where it appeared.
    let xml = run(&mut doc, r#"{"op":"ungroup","slide":1,"shapeId":5}"#);
    assert!(!xml.contains(r#"name="Group""#));
    assert!(shape_xml(&xml, 6).contains(r#"<a:off x="1524000" y="1524000"/><a:ext cx="508000" cy="508000"/>"#), "{}", shape_xml(&xml, 6));
    // Group shapes 2 and 6: one group, box around both, nothing moves.
    let r = commands::run(&mut doc, &cmd(r#"{"op":"group","slide":1,"shapeIds":[6,2]}"#)).unwrap();
    let gid = r["shapeId"].as_u64().unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    assert!(xml.contains(&format!(r#"<p:cNvPr id="{gid}" name="Group {}"/>"#, gid - 1)));
    assert!(xml.contains(r#"<a:off x="127000" y="254000"/><a:ext cx="1905000" cy="1778000"/><a:chOff x="127000" y="254000"/><a:chExt cx="1905000" cy="1778000"/>"#), "{xml}");
    // A straight connector from shape 7 to shape 9 (both at the slide origin area).
    let r = commands::run(&mut doc, &cmd(r#"{"op":"add_connector","slide":1,"start":{"shapeId":7,"site":3},"end":{"x":300,"y":100},"arrow":"triangle","color":"FF0000","width":2}"#)).unwrap();
    let cid = r["shapeId"].as_u64().unwrap() as u32;
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    // Shape 7 is 200 x 50 pt at the origin: site 3 (right middle) is (200, 25).
    assert!(xml.contains(r#"<a:stCxn id="7" idx="3"/></p:cNvCxnSpPr>"#));
    assert!(xml.contains(r#"<a:off x="2540000" y="317500"/><a:ext cx="1270000" cy="952500"/>"#), "{xml}");
    assert!(xml.contains(r#"<a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>"#));
    // Move shape 7 and re-route: the glued end follows.
    run(&mut doc, r#"{"op":"move","slide":1,"shapeId":7,"x":0,"y":200}"#);
    let xml = run(&mut doc, &format!(r#"{{"op":"set_connector","slide":1,"shapeId":{cid}}}"#));
    assert!(xml.contains(r#"<a:stCxn id="7" idx="3"/>"#) && xml.contains(r#"<a:xfrm flipV="1"><a:off x="2540000" y="1270000"/><a:ext cx="1270000" cy="1587500"/>"#), "{xml}");
    let xml = run(&mut doc, r#"{"op":"add_freeform","slide":1,"points":[[10,10],[60,10],[35,50]],"closed":true,"fill":"00FF00"}"#);
    assert!(xml.contains(r#"<a:path w="635000" h="508000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="635000" y="0"/></a:lnTo><a:lnTo><a:pt x="317500" y="508000"/></a:lnTo><a:close/></a:path>"#));
    assert!(commands::run(&mut doc, &cmd(r#"{"op":"group","slide":1,"shapeIds":[2]}"#)).is_err());
}

#[test]
fn media_is_inserted_and_replaced_as_powerpoint_writes_it() {
    use base64::Engine;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let mp4 = b64(b"\0\0\0\x20ftypisom\0\0\x02\0isomiso2mp41");
    let wav = b64(b"RIFF\x24\0\0\0WAVEfmt ");
    let mut doc = deck();
    let r = commands::run(&mut doc, &cmd(&format!(r#"{{"op":"insert_media","slide":1,"data":"{wav}"}}"#))).unwrap();
    assert_eq!(r["kind"], "audio");
    let id = r["shapeId"].as_u64().unwrap() as u32;
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    let pic = &xml[xml.find(&format!(r#"<p:cNvPr id="{id}""#)).unwrap()..];
    assert!(pic.contains(r#"<a:hlinkClick r:id="" action="ppaction://media"/>"#) && pic.contains("<a:audioFile r:link=") && pic.contains("<p14:media xmlns:p14="), "{pic}");
    let rels = String::from_utf8(doc.package().read("ppt/slides/_rels/slide1.xml.rels").unwrap().to_vec()).unwrap();
    assert!(rels.contains("relationships/audio\" Target=\"../media/media1.wav\"") && rels.contains("2007/relationships/media\" Target=\"../media/media1.wav\""), "{rels}");
    let types = String::from_utf8(doc.package().read("[Content_Types].xml").unwrap().to_vec()).unwrap();
    assert!(types.contains(r#"Extension="wav" ContentType="audio/wav""#) && types.contains(r#"Extension="png""#));

    // Replacing with a video turns the link into a video one and drops the
    // sound, which nothing uses any more.
    commands::run(&mut doc, &cmd(&format!(r#"{{"op":"replace_media","slide":1,"shapeId":{id},"data":"{mp4}"}}"#))).unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    assert!(xml.contains("<a:videoFile r:link=") && !xml.contains("audioFile"));
    assert!(!doc.package().contains("ppt/media/media1.wav") && doc.package().contains("ppt/media/media1.mp4"));
    let rels = String::from_utf8(doc.package().read("ppt/slides/_rels/slide1.xml.rels").unwrap().to_vec()).unwrap();
    assert!(!rels.contains("media1.wav"), "{rels}");

    assert!(commands::run(&mut doc, &cmd(r#"{"op":"insert_media","slide":1,"data":"aGVsbG8="}"#)).is_err(), "not media");
    assert!(commands::run(&mut doc, &cmd(&format!(r#"{{"op":"replace_media","slide":1,"shapeId":2,"data":"{mp4}"}}"#))).is_err(), "not a media shape");
}

#[test]
fn blank_deck_opens_and_takes_slides_of_each_layout() {
    let mut doc = Presentation::open(present_pptx::blank::blank()).unwrap();
    assert_eq!(doc.slide_count(), 1);
    let d = present_pptx::describe::describe(&doc).unwrap();
    assert_eq!((d["width"].as_f64(), d["height"].as_f64()), (Some(960.0), Some(540.0)));
    let names: Vec<&str> = d["masters"][0]["layouts"].as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Title Slide", "Title and Content", "Title Only", "Blank"]);
    for layout in names {
        commands::run(&mut doc, &cmd(&format!(r#"{{"op":"insert_slide","slide":2,"layout":"{layout}"}}"#))).unwrap();
    }
    commands::run(&mut doc, &cmd(r#"{"op":"add_text_box","slide":1,"x":72,"y":72,"width":400,"height":60,"paragraphs":["제목입니다"],"size":null}"#)).unwrap();
    let doc = Presentation::open(doc.save().unwrap()).unwrap();
    assert_eq!(doc.slide_count(), 5);
}

#[test]
fn pictures_crop_to_an_ellipse_as_powerpoint_writes_it() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let mut doc = deck();
    let r = commands::run(&mut doc, &cmd(&format!(r#"{{"op":"insert_image","slide":1,"data":"{PNG}","x":10,"y":10,"width":100,"height":100,"altText":null}}"#))).unwrap();
    let id = r["shapeId"].as_u64().unwrap() as u32;
    let pic = |xml: &str| {
        let start = xml.find(&format!(r#"<p:cNvPr id="{id}""#)).unwrap();
        let open = xml[..start].rfind("<p:pic>").unwrap();
        xml[open..open + xml[open..].find("</p:pic>").unwrap()].to_owned()
    };
    // Crop and oval together: srcRect in the fill, ellipse as the outline.
    let xml = run(&mut doc, &format!(r#"{{"op":"crop_image","slide":1,"shapeId":{id},"left":0.1,"top":0,"right":0.1,"bottom":0,"geometry":"ellipse"}}"#));
    let p = pic(&xml);
    assert!(p.contains(r#"<a:srcRect l="10000" r="10000"/>"#) && p.contains(r#"<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>"#) && !p.contains(r#"prst="rect""#), "{p}");
    // Only the outline: the framing stays.
    let p = pic(&run(&mut doc, &format!(r#"{{"op":"crop_image","slide":1,"shapeId":{id},"left":null,"top":null,"right":null,"bottom":null,"geometry":"rect"}}"#)));
    assert!(p.contains(r#"<a:srcRect l="10000" r="10000"/>"#) && p.contains(r#"prst="rect""#) && !p.contains("ellipse"), "{p}");
    // Only the framing: the outline stays.
    let p = pic(&run(&mut doc, &format!(r#"{{"op":"crop_image","slide":1,"shapeId":{id},"left":0,"top":0.2,"right":0,"bottom":0}}"#)));
    assert!(p.contains(r#"<a:srcRect t="20000"/>"#) && p.contains(r#"prst="rect""#), "{p}");
    assert!(commands::run(&mut doc, &cmd(&format!(r#"{{"op":"crop_image","slide":1,"shapeId":{id},"geometry":"star5"}}"#))).is_err());
    assert!(commands::run(&mut doc, &cmd(&format!(r#"{{"op":"crop_image","slide":1,"shapeId":{id}}}"#))).is_err(), "nothing to change");
}
