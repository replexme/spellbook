use present_pptx::commands::{self, Command};
use present_pptx::package::Package;
use present_pptx::render::fonts::FontSet;
use present_pptx::render::{render_slide, Resources};
use present_pptx::xml::Tree;
use present_pptx::Presentation;
use present_render::{Item, Paint};

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const CHART: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:style val="2"/><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Old</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="150"/><c:axId val="11"/><c:axId val="22"/></c:barChart><c:catAx><c:axId val="11"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="22"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="22"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="11"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart><c:externalData r:id="rId1"/></c:chartSpace>"#;

fn workbook() -> Vec<u8> {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    let root = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>"#);
    let wb = format!(r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="{REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#);
    let wb_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#);
    let sheet = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B3"/><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Old</t></is></c></row></sheetData></worksheet>"#;
    let sheet_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/table" Target="../tables/table1.xml"/></Relationships>"#);
    let table = r#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name=" "/><tableColumn id="2" name="Old"/></tableColumns></table>"#;
    Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("xl/workbook.xml", wb.as_bytes()),
        ("xl/_rels/workbook.xml.rels", wb_rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ("xl/worksheets/_rels/sheet1.xml.rels", sheet_rels.as_bytes()),
        ("xl/tables/table1.xml", table.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap()
}

fn deck() -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>"#;
    let root = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#);
    let pres = format!(r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="{REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#);
    let pres_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="{REL}/slide" Target="slides/slide1.xml"/></Relationships>"#);
    let slide = format!(r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="{REL}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="5080000" cy="3810000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>"#);
    let slide_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId9" Type="{REL}/chart" Target="../charts/chart1.xml"/></Relationships>"#);
    let chart_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/package" Target="../embeddings/Book1.xlsx"/></Relationships>"#);
    let layout = r#"<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>"#;
    let layout_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#);
    let master = r#"<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/></p:sldMaster>"#;
    let master_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/theme" Target="../theme/theme1.xml"/></Relationships>"#);
    let theme = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2></a:clrScheme></a:themeElements></a:theme>"#;
    let book = workbook();
    let bytes = Package::from_parts(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", slide_rels.as_bytes()),
        ("ppt/charts/chart1.xml", CHART.as_bytes()),
        ("ppt/charts/_rels/chart1.xml.rels", chart_rels.as_bytes()),
        ("ppt/embeddings/Book1.xlsx", &book),
        ("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels.as_bytes()),
        ("ppt/slideMasters/slideMaster1.xml", master.as_bytes()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels.as_bytes()),
        ("ppt/theme/theme1.xml", theme.as_bytes()),
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn run(doc: &mut Presentation, json: &str) -> String {
    let cmd: Command = serde_json::from_str(json).unwrap();
    commands::run(doc, &cmd).unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/charts/chart1.xml").unwrap().to_vec()).unwrap();
    Tree::parse(xml.as_bytes()).expect("well-formed chart");
    xml
}

/// Filled rectangles drawn in a series colour.
fn bars(doc: &Presentation, rgb: (u8, u8, u8)) -> usize {
    let out = render_slide(doc, 1, &Resources::new(FontSet::empty())).unwrap();
    out.scene.items.iter().filter(|i| matches!(i, Item::Path { fill: Some(Paint::Solid(c)), .. } if (c.r, c.g, c.b) == rgb)).count()
}

#[test]
fn a_chart_is_drawn_from_its_cached_values() {
    let doc = deck();
    // One bar per category plus the legend key, in accent 1.
    assert_eq!(bars(&doc, (0x4F, 0x81, 0xBD)), 3);
}

#[test]
fn chart_data_replaces_the_cache_and_the_workbook() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_chart_data","slide":1,"shapeId":4,"categories":["X","Y","Z"],"series":[{"name":"One","values":[1,2,3]},{"name":"Two","values":[4,null,6]}]}"#);
    assert!(xml.contains(r#"<c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Two</c:v></c:pt></c:strCache></c:strRef></c:tx>"#), "{xml}");
    assert!(xml.contains(r#"<c:f>Sheet1!$C$2:$C$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="2"><c:v>6</c:v></c:pt></c:numCache>"#), "{xml}");
    // The added series copies the first one's look in its own accent.
    assert!(xml.contains(r#"<c:idx val="1"/><c:order val="1"/>"#) && xml.contains(r#"<a:schemeClr val="accent2"/>"#), "{xml}");
    assert_eq!(bars(&doc, (0xC0, 0x50, 0x4D)), 3, "two values and a legend key");
    let book = Package::open(doc.package().read("ppt/embeddings/Book1.xlsx").unwrap().to_vec()).unwrap();
    let sheet = String::from_utf8(book.read("xl/worksheets/sheet1.xml").unwrap().to_vec()).unwrap();
    assert!(sheet.contains(r#"<dimension ref="A1:C4"/>"#) && sheet.contains(r#"<c r="C4"><v>6</v></c>"#) && !sheet.contains(r#"r="C3""#), "{sheet}");
    let table = String::from_utf8(book.read("xl/tables/table1.xml").unwrap().to_vec()).unwrap();
    assert!(table.contains(r#"ref="A1:C4""#) && table.contains(r#"<autoFilter ref="A1:C4"/>"#) && table.contains(r#"<tableColumns count="3"><tableColumn id="1" name=" "/><tableColumn id="2" name="One"/><tableColumn id="3" name="Two"/></tableColumns>"#), "{table}");
    let bad: Command = serde_json::from_str(r#"{"op":"set_chart_data","slide":1,"shapeId":4,"categories":["X"],"series":[{"name":"One","values":[1,2]}]}"#).unwrap();
    assert!(commands::run(&mut doc, &bad).is_err());
}

#[test]
fn chart_type_changes_keep_series_and_fit_axes() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_chart_type","slide":1,"shapeId":4,"type":"pie"}"#);
    assert!(xml.contains(r#"<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>"#), "{xml}");
    assert!(!xml.contains("catAx") && !xml.contains("valAx") && !xml.contains("invertIfNegative") && !xml.contains("<c:spPr>"), "{xml}");
    let xml = run(&mut doc, r#"{"op":"set_chart_type","slide":1,"shapeId":4,"type":"bar","grouping":"stacked"}"#);
    assert!(xml.contains(r#"<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/>"#) && xml.contains(r#"<c:overlap val="100"/><c:axId val="500000001"/><c:axId val="500000002"/></c:barChart><c:catAx><c:axId val="500000001"/>"#), "{xml}");
    assert!(xml.contains(r#"<c:axPos val="l"/>"#), "categories on the left for bars");
    let xml = run(&mut doc, r#"{"op":"set_chart_type","slide":1,"shapeId":4,"type":"line"}"#);
    assert!(xml.contains(r#"<c:lineChart><c:grouping val="standard"/>"#) && xml.contains(r#"<c:marker><c:symbol val="none"/></c:marker>"#) && xml.contains(r#"<c:axPos val="b"/>"#), "{xml}");
}

#[test]
fn chart_format_sets_title_legend_labels_gridlines_and_colours() {
    let mut doc = deck();
    let xml = run(&mut doc, r#"{"op":"set_chart_format","slide":1,"shapeId":4,"title":"Sales","legend":"b","dataLabels":true,"gridlines":false,"colors":["00FF00"]}"#);
    assert!(xml.contains(r#"<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea>"#), "{xml}");
    assert!(xml.contains(r#"<c:legendPos val="b"/>"#) && xml.contains(r#"<c:showVal val="1"/>"#) && !xml.contains("majorGridlines"), "{xml}");
    assert!(xml.contains(r#"<c:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></c:spPr><c:invertIfNegative"#), "{xml}");
    assert_eq!(bars(&doc, (0, 0xFF, 0)), 3);
    let xml = run(&mut doc, r#"{"op":"set_chart_format","slide":1,"shapeId":4,"title":"","legend":"none","gridlines":true}"#);
    assert!(!xml.contains("<c:title>") && xml.contains(r#"<c:autoTitleDeleted val="1"/>"#) && !xml.contains("<c:legend>") && xml.contains("<c:majorGridlines/>"), "{xml}");
}
