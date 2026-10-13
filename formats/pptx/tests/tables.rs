use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::xml::Tree;
use present_pptx::Presentation;

const CT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
const ROOT: &str = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
const PRES: &str = r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#;
const PRES_RELS: &str = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;

fn cell(text: &str) -> String {
    let p = if text.is_empty() { r#"<a:p><a:endParaRPr lang="ko-KR"/></a:p>"#.to_owned() } else { format!(r#"<a:p><a:r><a:rPr lang="ko-KR" b="1"/><a:t>{text}</a:t></a:r></a:p>"#) };
    format!(r#"<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>{p}</a:txBody><a:tcPr/></a:tc>"#)
}

/// A 3 x 3 table (shape 4, 100 pt columns, 20 pt rows) and a text box (shape 5).
fn deck() -> Presentation {
    let rows: String = (0..3)
        .map(|r| {
            let cells: String = (0..3).map(|c| cell(&format!("r{r}c{c}"))).collect();
            format!(r#"<a:tr h="254000">{cells}<a:extLst><a:ext uri="{{0D108BD9-81ED-4DB2-BD59-A6C34878D82A}}"><a16:rowId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="{r}"/></a:ext></a:extLst></a:tr>"#)
        })
        .collect();
    let grid: String = (0..3).map(|c| format!(r#"<a:gridCol w="1270000"><a:extLst><a:ext uri="{{9D8B030D-6E8A-4147-A177-3AD203B41FA5}}"><a16:colId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="{c}"/></a:ext></a:extLst></a:gridCol>"#)).collect();
    let slide = format!(
        r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="3810000" cy="762000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>{grid}</a:tblGrid>{rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:nvSpPr><p:cNvPr id="5" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Hello </a:t></a:r><a:r><a:rPr i="1"/><a:t>big</a:t></a:r><a:br/><a:r><a:rPr/><a:t> world</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
    );
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", CT.as_bytes()),
        ("_rels/.rels", ROOT.as_bytes()),
        ("ppt/presentation.xml", PRES.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", PRES_RELS.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn run(doc: &mut Presentation, json: &str) -> String {
    let c: Command = serde_json::from_str(json).unwrap();
    commands::run(doc, &c).unwrap_or_else(|e| panic!("{json}: {e:?}"));
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    Tree::parse(xml.as_bytes()).expect("well-formed");
    xml
}

fn fails(doc: &mut Presentation, json: &str) {
    let c: Command = serde_json::from_str(json).unwrap();
    assert!(commands::run(doc, &c).is_err(), "{json} should fail");
}

/// Texts and merge attributes per row: "text" or "text[attrs]".
fn grid(xml: &str) -> Vec<Vec<String>> {
    let tree = Tree::parse(xml.as_bytes()).unwrap();
    let tbl = tree.nodes.iter().position(|n| n.local == "tbl").unwrap();
    tree.children_named(tbl, "http://schemas.openxmlformats.org/drawingml/2006/main", "tr")
        .map(|tr| {
            tree.children_named(tr, "http://schemas.openxmlformats.org/drawingml/2006/main", "tc")
                .map(|tc| {
                    let n = tree.node(tc);
                    let text: String = tree.nodes.iter().filter(|x| x.local == "t" && x.start > n.start && x.end < n.end).map(|x| String::from_utf8_lossy(&xml.as_bytes()[x.open_end..x.close_start]).into_owned()).collect::<Vec<_>>().join("|");
                    let attrs: Vec<String> = ["gridSpan", "rowSpan", "hMerge", "vMerge"].iter().filter_map(|k| n.attr(k).map(|v| format!("{k}={v}"))).collect();
                    if attrs.is_empty() { text } else { format!("{text}[{}]", attrs.join(",")) }
                })
                .collect()
        })
        .collect()
}

#[test]
fn cell_text_format_and_sizes() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_table_cell","slide":1,"shapeId":4,"row":1,"col":2,"paragraphs":["새 값"]}"#);
    assert_eq!(grid(&xml)[1][2], "새 값");
    assert!(xml.contains(r#"<a:r><a:rPr lang="ko-KR" b="1"/><a:t>새 값</a:t></a:r>"#), "keeps the cell's run formatting");
    let xml = run(&mut doc, r#"{"op":"set_table_cell_format","slide":1,"shapeId":4,"row":0,"col":0,"fill":"FFEE00","borderColor":"FF0000","borderWidth":2,"anchor":"middle"}"#);
    assert!(xml.contains(r#"<a:tcPr anchor="ctr"><a:lnL w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnL><a:lnR w="25400">"#));
    assert!(xml.contains(r#"</a:lnB><a:solidFill><a:srgbClr val="FFEE00"/></a:solidFill></a:tcPr>"#));
    let xml = run(&mut doc, r#"{"op":"set_table_row_height","slide":1,"shapeId":4,"row":2,"height":40}"#);
    assert!(xml.contains(r#"<a:tr h="508000">"#) && xml.contains(r#"<a:ext cx="3810000" cy="1016000"/>"#));
    let xml = run(&mut doc, r#"{"op":"set_table_column_width","slide":1,"shapeId":4,"col":0,"width":50}"#);
    assert!(xml.contains(r#"<a:gridCol w="635000">"#) && xml.contains(r#"<a:ext cx="3175000" cy="1016000"/>"#));
}

#[test]
fn rows_and_columns_in_and_out() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"insert_table_rows","slide":1,"shapeId":4,"row":1,"count":2}"#);
    let g = grid(&xml);
    assert_eq!(g.len(), 5);
    assert_eq!(g[1], ["", "", ""]);
    assert_eq!(g[3], ["r1c0", "r1c1", "r1c2"]);
    assert_eq!(xml.matches("a16:rowId").count(), 3, "copied rows carry no co-authoring ids");
    assert!(xml.contains(r#"<a:p><a:endParaRPr lang="ko-KR" b="1"/></a:p>"#), "new cells keep the text formatting");
    let xml = run(&mut doc, r#"{"op":"delete_table_rows","slide":1,"shapeId":4,"row":1,"count":2}"#);
    assert_eq!(grid(&xml).len(), 3);
    let xml = run(&mut doc, r#"{"op":"insert_table_columns","slide":1,"shapeId":4,"col":3}"#);
    let g = grid(&xml);
    assert_eq!(g[0], ["r0c0", "r0c1", "r0c2", ""]);
    assert!(xml.contains(r#"<a:ext cx="5080000""#));
    let xml = run(&mut doc, r#"{"op":"delete_table_columns","slide":1,"shapeId":4,"col":0,"count":2}"#);
    assert_eq!(grid(&xml)[2], ["r2c2", ""]);
    fails(&mut doc, r#"{"op":"delete_table_columns","slide":1,"shapeId":4,"col":0,"count":2}"#);
}

#[test]
fn merging_moves_text_and_keeps_blocks_whole() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"merge_table_cells","slide":1,"shapeId":4,"row":0,"col":0,"rows":2,"cols":2}"#);
    let g = grid(&xml);
    assert_eq!(g[0][0], "r0c0|r0c1|r1c0|r1c1[gridSpan=2,rowSpan=2]");
    assert_eq!(g[0][1], "[hMerge=1]");
    assert_eq!(g[1][0], "[gridSpan=2,vMerge=1]");
    assert_eq!(g[1][1], "[hMerge=1,vMerge=1]");
    fails(&mut doc, r#"{"op":"merge_table_cells","slide":1,"shapeId":4,"row":1,"col":1,"rows":2,"cols":2}"#);
    fails(&mut doc, r#"{"op":"set_table_cell","slide":1,"shapeId":4,"row":1,"col":1,"paragraphs":["x"]}"#);
    // A row inserted inside the block grows it.
    let xml = run(&mut doc, r#"{"op":"insert_table_rows","slide":1,"shapeId":4,"row":1}"#);
    let g = grid(&xml);
    assert_eq!(g[0][0], "r0c0|r0c1|r1c0|r1c1[gridSpan=2,rowSpan=3]");
    assert_eq!(g[1], ["[gridSpan=2,vMerge=1]", "[hMerge=1,vMerge=1]", ""]);
    fails(&mut doc, r#"{"op":"delete_table_rows","slide":1,"shapeId":4,"row":0}"#);
    let xml = run(&mut doc, r#"{"op":"delete_table_rows","slide":1,"shapeId":4,"row":1}"#);
    assert_eq!(grid(&xml)[0][0], "r0c0|r0c1|r1c0|r1c1[gridSpan=2,rowSpan=2]");
    let xml = run(&mut doc, r#"{"op":"split_table_cell","slide":1,"shapeId":4,"row":0,"col":0}"#);
    assert!(grid(&xml).iter().flatten().all(|c| !c.contains('[')));
}

#[test]
fn new_table_and_text_range() {
    let mut doc = deck();
    let r = commands::run(&mut doc, &serde_json::from_str(r#"{"op":"add_table","slide":1,"x":10,"y":200,"width":300,"height":60,"rows":2,"cols":3,"cells":[["가","나"],["","","다"]]}"#).unwrap()).unwrap();
    assert_eq!(r["shapeId"], 6);
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    assert!(xml.contains(r#"<a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>"#));
    assert!(xml.contains(r#"<a:gridCol w="1270000"/><a:gridCol w="1270000"/><a:gridCol w="1270000"/>"#));
    let reopened = Presentation::open(doc.save().unwrap()).unwrap();
    assert_eq!(reopened.slide(1).unwrap().shapes.len(), 3);
    // "Hello big\v world": replace "big" + break + " " with "small ".
    let xml = run(&mut doc, r#"{"op":"replace_text_range","slide":1,"shapeId":5,"paragraph":0,"start":6,"end":11,"text":"small "}"#);
    assert!(xml.contains(r#"<a:r><a:rPr b="1"/><a:t>Hello </a:t></a:r><a:r><a:rPr i="1"/><a:t>small </a:t></a:r><a:r><a:rPr/><a:t>world</a:t></a:r>"#), "{xml}");
    let xml = run(&mut doc, r#"{"op":"replace_text_range","slide":1,"shapeId":5,"paragraph":0,"start":0,"end":0,"text":"Oh "}"#);
    assert!(xml.contains(r#"<a:t>Oh Hello </a:t>"#));
    fails(&mut doc, r#"{"op":"replace_text_range","slide":1,"shapeId":5,"paragraph":0,"start":5,"end":99,"text":"x"}"#);
}
