use present_pptx::commands::{self, smartart, Command};
use present_pptx::package::Package;
use present_pptx::xml::Tree;
use present_pptx::Presentation;

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// Two top-level nodes (A with child A1, then B), with transitions.
const DATA: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="{D}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt><dgm:pt modelId="{A}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Alpha</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{A1}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Under</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{B}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Beta</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{PA}" type="pres"><dgm:prSet presAssocID="{A}" presName="node"/><dgm:spPr/></dgm:pt><dgm:pt modelId="{PA1}" type="pres"><dgm:prSet presAssocID="{A1}" presName="node"/><dgm:spPr/></dgm:pt><dgm:pt modelId="{TA}" type="parTrans" cxnId="{CA}"><dgm:prSet/><dgm:spPr/></dgm:pt><dgm:pt modelId="{SA}" type="sibTrans" cxnId="{CA}"><dgm:prSet/><dgm:spPr/></dgm:pt></dgm:ptLst><dgm:cxnLst><dgm:cxn modelId="{CA}" srcId="{D}" destId="{A}" srcOrd="0" destOrd="0" parTransId="{TA}" sibTransId="{SA}"/><dgm:cxn modelId="{CA1}" srcId="{A}" destId="{A1}" srcOrd="0" destOrd="0"/><dgm:cxn modelId="{CB}" srcId="{D}" destId="{B}" srcOrd="1" destOrd="0"/><dgm:cxn modelId="{PC}" type="presOf" srcId="{A1}" destId="{PA1}" srcOrd="0" destOrd="0"/></dgm:cxnLst><dgm:extLst><a:ext uri="x"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId7"/></a:ext></dgm:extLst></dgm:dataModel>"#;

const DRAWING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/><dsp:sp modelId="{PA}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr/><dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Alpha</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>"#;

fn deck() -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    let root = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#);
    let pres = format!(r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="{REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#);
    let pres_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="{REL}/slide" Target="slides/slide1.xml"/></Relationships>"#);
    let slide = format!(r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="{REL}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="5080000" cy="3810000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>"#);
    let slide_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="{REL}/diagramData" Target="../diagrams/data1.xml"/><Relationship Id="rId7" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/></Relationships>"#);
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", slide_rels.as_bytes()),
        ("ppt/diagrams/data1.xml", DATA.as_bytes()),
        ("ppt/diagrams/drawing1.xml", DRAWING.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn run(doc: &mut Presentation, json: &str) -> serde_json::Value {
    let cmd: Command = serde_json::from_str(json).unwrap();
    let r = commands::run(doc, &cmd).unwrap();
    for part in ["ppt/diagrams/data1.xml", "ppt/diagrams/drawing1.xml"] {
        Tree::parse(&doc.package().read(part).unwrap()).expect("well-formed");
    }
    r
}

fn part(doc: &Presentation, name: &str) -> String {
    String::from_utf8(doc.package().read(name).unwrap().to_vec()).unwrap()
}

fn texts(doc: &Presentation) -> Vec<(u64, String)> {
    smartart::smartart_nodes(doc, 1, 4).unwrap().into_iter().map(|n| (n["depth"].as_u64().unwrap(), n["text"].as_str().unwrap().to_owned())).collect()
}

#[test]
fn nodes_are_listed_depth_first() {
    let doc = deck();
    assert_eq!(texts(&doc), vec![(1, "Alpha".into()), (2, "Under".into()), (1, "Beta".into())]);
}

#[test]
fn a_text_change_keeps_formatting_and_updates_the_drawing_shape() {
    let mut doc = deck();
    let r = run(&mut doc, r#"{"op":"set_smartart_node","slide":1,"shapeId":4,"index":0,"text":"New\nSecond"}"#);
    assert_eq!(r["drawing"], "updated");
    assert!(part(&doc, "ppt/diagrams/data1.xml").contains(r#"<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>New</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>Second</a:t></a:r></a:p>"#));
    assert!(part(&doc, "ppt/diagrams/drawing1.xml").contains("<a:t>New</a:t>"));
    assert_eq!(texts(&doc)[0].1, "New\nSecond");
}

#[test]
fn adding_and_deleting_nodes_edits_the_data_and_empties_the_drawing() {
    let mut doc = deck();
    let r = run(&mut doc, r#"{"op":"add_smartart_node","slide":1,"shapeId":4,"position":1,"text":"Middle"}"#);
    assert_eq!(r["index"], 2);
    assert_eq!(texts(&doc), vec![(1, "Alpha".into()), (2, "Under".into()), (1, "Middle".into()), (1, "Beta".into())]);
    assert!(part(&doc, "ppt/diagrams/data1.xml").contains(r#"srcId="{D}" destId="{B}" srcOrd="2""#), "Beta moves on");
    assert!(!part(&doc, "ppt/diagrams/drawing1.xml").contains("<dsp:sp "), "laid out again");
    run(&mut doc, r#"{"op":"add_smartart_node","slide":1,"shapeId":4,"parent":2,"text":"Child"}"#);
    assert_eq!(texts(&doc)[3], (2, "Child".into()));

    // Deleting Alpha takes its child, transitions, presentation points and
    // their connections.
    let r = run(&mut doc, r#"{"op":"delete_smartart_node","slide":1,"shapeId":4,"index":0}"#);
    assert_eq!(r["removed"], 2);
    assert_eq!(texts(&doc), vec![(1, "Middle".into()), (2, "Child".into()), (1, "Beta".into())]);
    let data = part(&doc, "ppt/diagrams/data1.xml");
    for gone in ["{A}", "{A1}", "{TA}", "{SA}", "{PA}", "{PA1}", "{PC}"] {
        assert!(!data.contains(&format!("\"{gone}\"")), "{gone} left in {data}");
    }
    assert!(data.contains(r#"srcId="{D}" destId="{B}" srcOrd="1""#), "Beta moves back");
}

#[test]
fn bad_smartart_requests_are_refused() {
    let mut doc = deck();
    for bad in [
        r#"{"op":"set_smartart_node","slide":1,"shapeId":4,"index":9,"text":"x"}"#,
        r#"{"op":"add_smartart_node","slide":1,"shapeId":4,"parent":9,"text":"x"}"#,
        r#"{"op":"add_smartart_node","slide":1,"shapeId":4,"position":5,"text":"x"}"#,
        r#"{"op":"delete_smartart_node","slide":1,"shapeId":4,"index":3}"#,
        r#"{"op":"set_smartart_node","slide":1,"shapeId":1,"index":0,"text":"x"}"#,
    ] {
        let cmd: Command = serde_json::from_str(bad).unwrap();
        assert!(commands::run(&mut doc, &cmd).is_err(), "{bad}");
    }
}
