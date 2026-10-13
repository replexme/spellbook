//! A new, empty presentation to start from: a 16:9 deck with one title slide, a master with
//! title and body styles, the four common layouts (Title Slide, Title and Content, Title Only,
//! Blank) and a plain theme set in Malgun Gothic (맑은 고딕), the Korean Office font. Every part
//! is written here.

use present_package::Package;

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT: &str = "application/vnd.openxmlformats-officedocument";

/// Slide size: 16:9 widescreen (33.867 x 19.05 cm).
const CX: i64 = 12_192_000;
const CY: i64 = 6_858_000;
const FONT: &str = "맑은 고딕";

fn xml(body: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{body}")
}

fn rels(list: &[(&str, &str, &str)]) -> String {
    let mut s = format!("<Relationships xmlns=\"{PKG_REL}\">");
    for (id, kind, target) in list {
        s.push_str(&format!("<Relationship Id=\"{id}\" Type=\"{kind}\" Target=\"{target}\"/>"));
    }
    s.push_str("</Relationships>");
    xml(&s)
}

/// A placeholder shape: `ph` is its `<p:ph>` attributes; `xfrm` its box (EMU) or none to
/// inherit; `body` its text body (empty paragraph by default).
fn placeholder(id: u32, name: &str, ph: &str, xfrm: Option<(i64, i64, i64, i64)>, body_pr: &str, list: &str) -> String {
    let sp_pr = match xfrm {
        Some((x, y, w, h)) => format!("<p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm></p:spPr>"),
        None => "<p:spPr/>".into(),
    };
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr>{sp_pr}<p:txBody>{body_pr}<a:lstStyle>{list}</a:lstStyle><a:p><a:endParaRPr lang=\"ko-KR\"/></a:p></p:txBody></p:sp>"
    )
}

fn tree(shapes: &str) -> String {
    format!(
        "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{shapes}</p:spTree>"
    )
}

/// Paragraph levels 1–9 of a text style: size (hundredths of a point) per level, a bullet or
/// not, and the theme font (`+mj` headings, `+mn` body).
fn levels(sizes: &[u32], bullet: bool, font: &str, color: &str) -> String {
    let mut s = String::new();
    for lvl in 1..=9 {
        let sz = sizes[(lvl - 1).min(sizes.len() - 1)];
        let indent = 228_600 + (lvl as i64 - 1) * 457_200;
        let bullet_xml = if bullet { "<a:buFont typeface=\"Arial\"/><a:buChar char=\"•\"/>" } else { "<a:buNone/>" };
        let mar = if bullet { format!(" marL=\"{indent}\" indent=\"-228600\"") } else { String::new() };
        s.push_str(&format!(
            "<a:lvl{lvl}pPr{mar} algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:lnSpc><a:spcPct val=\"90000\"/></a:lnSpc><a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>{bullet_xml}<a:defRPr sz=\"{sz}\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"{color}\"/></a:solidFill><a:latin typeface=\"{font}-lt\"/><a:ea typeface=\"{font}-ea\"/><a:cs typeface=\"{font}-cs\"/></a:defRPr></a:lvl{lvl}pPr>",
            if bullet { 1000 } else { 0 }
        ));
    }
    s
}

fn master() -> String {
    let shapes = [
        placeholder(2, "Title Placeholder 1", "type=\"title\"", Some((838_200, 365_125, 10_515_600, 1_325_563)), "<a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\" anchor=\"ctr\"><a:normAutofit/></a:bodyPr>", ""),
        placeholder(3, "Text Placeholder 2", "type=\"body\" idx=\"1\"", Some((838_200, 1_825_625, 10_515_600, 4_351_338)), "<a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\" rtlCol=\"0\"><a:normAutofit/></a:bodyPr>", ""),
        placeholder(4, "Date Placeholder 3", "type=\"dt\" sz=\"half\" idx=\"2\"", Some((838_200, 6_356_350, 2_743_200, 365_125)), "<a:bodyPr anchor=\"ctr\"/>", "<a:lvl1pPr algn=\"l\"><a:defRPr sz=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"><a:tint val=\"75000\"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>"),
        placeholder(5, "Footer Placeholder 4", "type=\"ftr\" sz=\"quarter\" idx=\"3\"", Some((4_038_600, 6_356_350, 4_114_800, 365_125)), "<a:bodyPr anchor=\"ctr\"/>", "<a:lvl1pPr algn=\"ctr\"><a:defRPr sz=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"><a:tint val=\"75000\"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>"),
        placeholder(6, "Slide Number Placeholder 5", "type=\"sldNum\" sz=\"quarter\" idx=\"4\"", Some((8_610_600, 6_356_350, 2_743_200, 365_125)), "<a:bodyPr anchor=\"ctr\"/>", "<a:lvl1pPr algn=\"r\"><a:defRPr sz=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"><a:tint val=\"75000\"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>"),
    ]
    .concat();
    let ids: String = (1..=4).map(|i| format!("<p:sldLayoutId id=\"{}\" r:id=\"rId{i}\"/>", 2_147_483_648u64 + i as u64)).collect();
    xml(&format!(
        "<p:sldMaster xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>{}</p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst>{ids}</p:sldLayoutIdLst><p:txStyles><p:titleStyle>{}</p:titleStyle><p:bodyStyle>{}</p:bodyStyle><p:otherStyle>{}</p:otherStyle></p:txStyles></p:sldMaster>",
        tree(&shapes),
        levels(&[4400], false, "+mj", "tx1"),
        levels(&[2800, 2400, 2000, 1800], true, "+mn", "tx1"),
        levels(&[1800], false, "+mn", "tx1"),
    ))
}

fn layout(name: &str, kind: &str, shapes: &str) -> String {
    xml(&format!(
        "<p:sldLayout xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\" type=\"{kind}\" preserve=\"1\"><p:cSld name=\"{name}\">{}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
        tree(shapes)
    ))
}

fn layouts() -> [(&'static str, String); 4] {
    let title_slide = [
        placeholder(2, "Title 1", "type=\"ctrTitle\"", Some((1_524_000, 1_122_363, 9_144_000, 2_387_600)), "<a:bodyPr anchor=\"b\"/>", "<a:lvl1pPr algn=\"ctr\"><a:defRPr sz=\"6000\"/></a:lvl1pPr>"),
        placeholder(3, "Subtitle 2", "type=\"subTitle\" idx=\"1\"", Some((1_524_000, 3_602_038, 9_144_000, 1_655_762)), "<a:bodyPr/>", "<a:lvl1pPr marL=\"0\" indent=\"0\" algn=\"ctr\"><a:buNone/><a:defRPr sz=\"2400\"/></a:lvl1pPr>"),
    ]
    .concat();
    let title_content = [placeholder(2, "Title 1", "type=\"title\"", None, "<a:bodyPr/>", ""), placeholder(3, "Content Placeholder 2", "idx=\"1\"", None, "<a:bodyPr/>", "")].concat();
    [
        ("Title Slide", layout("Title Slide", "title", &title_slide)),
        ("Title and Content", layout("Title and Content", "obj", &title_content)),
        ("Title Only", layout("Title Only", "titleOnly", &placeholder(2, "Title 1", "type=\"title\"", None, "<a:bodyPr/>", ""))),
        ("Blank", layout("Blank", "blank", "")),
    ]
}

fn theme() -> String {
    let colors = [("dk1", "1F2328"), ("lt1", "FFFFFF"), ("dk2", "33415C"), ("lt2", "F1F3F5"), ("accent1", "1C7ED6"), ("accent2", "F76707"), ("accent3", "2B8A3E"), ("accent4", "AE3EC9"), ("accent5", "F59F00"), ("accent6", "0CA678"), ("hlink", "1971C2"), ("folHlink", "862E9C")];
    let clr: String = colors.iter().map(|(k, v)| format!("<a:{k}><a:srgbClr val=\"{v}\"/></a:{k}>")).collect();
    let font = |kind: &str| format!("<a:{kind}><a:latin typeface=\"{FONT}\"/><a:ea typeface=\"{FONT}\"/><a:cs typeface=\"\"/></a:{kind}>");
    let solid = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
    let fills = format!("{solid}{solid}{solid}");
    let line = |w: u32| format!("<a:ln w=\"{w}\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\">{solid}<a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln>");
    let effects = "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3);
    xml(&format!(
        "<a:theme xmlns:a=\"{A}\" name=\"Spellbook\"><a:themeElements><a:clrScheme name=\"Spellbook\">{clr}</a:clrScheme><a:fontScheme name=\"Spellbook\">{}{}</a:fontScheme><a:fmtScheme name=\"Spellbook\"><a:fillStyleLst>{fills}</a:fillStyleLst><a:lnStyleLst>{}{}{}</a:lnStyleLst><a:effectStyleLst>{effects}</a:effectStyleLst><a:bgFillStyleLst>{fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
        font("majorFont"),
        font("minorFont"),
        line(6350),
        line(12700),
        line(19050),
    ))
}

fn slide() -> String {
    let shapes = [placeholder(2, "제목 1", "type=\"ctrTitle\"", None, "<a:bodyPr/>", ""), placeholder(3, "부제목 2", "type=\"subTitle\" idx=\"1\"", None, "<a:bodyPr/>", "")].concat();
    xml(&format!("<p:sld xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:cSld>{}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>", tree(&shapes)))
}

/// The blank deck's bytes.
pub fn blank() -> Vec<u8> {
    let layouts = layouts();
    let mut ct = format!(
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"{CT}.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"{CT}.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"{CT}.presentationml.slide+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"{CT}.theme+xml\"/><Override PartName=\"/ppt/presProps.xml\" ContentType=\"{CT}.presentationml.presProps+xml\"/><Override PartName=\"/ppt/viewProps.xml\" ContentType=\"{CT}.presentationml.viewProps+xml\"/><Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"{CT}.presentationml.tableStyles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"{CT}.extended-properties+xml\"/>"
    );
    for i in 1..=layouts.len() {
        ct.push_str(&format!("<Override PartName=\"/ppt/slideLayouts/slideLayout{i}.xml\" ContentType=\"{CT}.presentationml.slideLayout+xml\"/>"));
    }
    ct.push_str("</Types>");
    let presentation = xml(&format!(
        "<p:presentation xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\" saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst><p:sldSz cx=\"{CX}\" cy=\"{CY}\"/><p:notesSz cx=\"{CY}\" cy=\"9144000\"/><p:defaultTextStyle>{}</p:defaultTextStyle></p:presentation>",
        levels(&[1800], false, "+mn", "tx1")
    ));
    let mut parts: Vec<(String, String)> = vec![
        ("[Content_Types].xml".into(), xml(&ct)),
        ("_rels/.rels".into(), rels(&[("rId1", &format!("{REL}/officeDocument"), "ppt/presentation.xml"), ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"), ("rId3", &format!("{REL}/extended-properties"), "docProps/app.xml")])),
        ("docProps/core.xml".into(), xml("<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title></dc:title></cp:coreProperties>")),
        ("docProps/app.xml".into(), xml("<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Spellbook</Application><Slides>1</Slides></Properties>")),
        ("ppt/presentation.xml".into(), presentation),
        ("ppt/_rels/presentation.xml.rels".into(), rels(&[("rId1", &format!("{REL}/slideMaster"), "slideMasters/slideMaster1.xml"), ("rId2", &format!("{REL}/slide"), "slides/slide1.xml"), ("rId3", &format!("{REL}/presProps"), "presProps.xml"), ("rId4", &format!("{REL}/viewProps"), "viewProps.xml"), ("rId5", &format!("{REL}/theme"), "theme/theme1.xml"), ("rId6", &format!("{REL}/tableStyles"), "tableStyles.xml")])),
        ("ppt/presProps.xml".into(), xml(&format!("<p:presentationPr xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"/>"))),
        ("ppt/viewProps.xml".into(), xml(&format!("<p:viewPr xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr><p:gridSpacing cx=\"72008\" cy=\"72008\"/></p:viewPr>"))),
        ("ppt/tableStyles.xml".into(), xml(&format!("<a:tblStyleLst xmlns:a=\"{A}\" def=\"{{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}}\"/>"))),
        ("ppt/theme/theme1.xml".into(), theme()),
        ("ppt/slideMasters/slideMaster1.xml".into(), master()),
        ("ppt/slides/slide1.xml".into(), slide()),
        ("ppt/slides/_rels/slide1.xml.rels".into(), rels(&[("rId1", &format!("{REL}/slideLayout"), "../slideLayouts/slideLayout1.xml")])),
    ];
    let master_rels: Vec<(String, String, String)> = (1..=layouts.len())
        .map(|i| (format!("rId{i}"), format!("{REL}/slideLayout"), format!("../slideLayouts/slideLayout{i}.xml")))
        .chain(std::iter::once((format!("rId{}", layouts.len() + 1), format!("{REL}/theme"), "../theme/theme1.xml".to_string())))
        .collect();
    let refs: Vec<(&str, &str, &str)> = master_rels.iter().map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str())).collect();
    parts.push(("ppt/slideMasters/_rels/slideMaster1.xml.rels".into(), rels(&refs)));
    for (i, (_, body)) in layouts.iter().enumerate() {
        parts.push((format!("ppt/slideLayouts/slideLayout{}.xml", i + 1), body.clone()));
        parts.push((format!("ppt/slideLayouts/_rels/slideLayout{}.xml.rels", i + 1), rels(&[("rId1", &format!("{REL}/slideMaster"), "../slideMasters/slideMaster1.xml")])));
    }
    let borrowed: Vec<(&str, &[u8])> = parts.iter().map(|(n, b)| (n.as_str(), b.as_bytes())).collect();
    Package::from_parts(&borrowed).and_then(|p| p.save()).expect("the blank deck's parts are valid")
}
