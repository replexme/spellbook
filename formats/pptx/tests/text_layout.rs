//! Embedded fonts, the font a missing East Asian character is drawn in, the
//! text area of preset shapes and vertical text in table cells. Fonts are
//! built here: one square glyph per character, 1 em wide.

use present_pptx::package::Package;
use present_pptx::render::fonts::FontSet;
use present_pptx::render::{render_slide, Resources};
use present_pptx::Presentation;

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn be16(out: &mut Vec<u8>, v: i32) {
    out.extend((v as u16).to_be_bytes());
}

/// A TrueType font named `family` drawing `chars`, whose PANOSE serif style
/// is `serif` (11: sans serif; 0: any).
fn font(family: &str, serif: u8, chars: &str) -> Vec<u8> {
    let mut chars: Vec<char> = chars.chars().collect();
    chars.sort();
    chars.dedup();
    let glyphs = chars.len() + 1;
    let mut tables: Vec<(&[u8; 4], Vec<u8>)> = Vec::new();

    let mut head = Vec::new();
    head.extend(0x0001_0000u32.to_be_bytes());
    head.extend(0x0001_0000u32.to_be_bytes());
    head.extend([0; 4]);
    head.extend(0x5F0F_3CF5u32.to_be_bytes());
    be16(&mut head, 0x000B);
    be16(&mut head, 1000);
    head.extend([0; 16]);
    for v in [0, 0, 900, 700, 0, 8, 2, 1, 0] {
        be16(&mut head, v);
    }
    tables.push((b"head", head));

    let mut hhea = Vec::new();
    hhea.extend(0x0001_0000u32.to_be_bytes());
    for v in [800, -200, 0, 1000, 0, 0, 900, 1, 0, 0, 0, 0, 0, 0, 0] {
        be16(&mut hhea, v);
    }
    be16(&mut hhea, glyphs as i32);
    tables.push((b"hhea", hhea));

    let mut maxp = Vec::new();
    maxp.extend(0x0001_0000u32.to_be_bytes());
    for v in [glyphs as i32, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0] {
        be16(&mut maxp, v);
    }
    tables.push((b"maxp", maxp));

    let mut hmtx = Vec::new();
    for _ in 0..glyphs {
        be16(&mut hmtx, 1000);
        be16(&mut hmtx, 0);
    }
    tables.push((b"hmtx", hmtx));

    // cmap format 4: one segment per character, then the closing segment.
    let mut seg: Vec<(i32, i32)> = chars.iter().enumerate().map(|(i, c)| (*c as i32, i as i32 + 1)).collect();
    seg.push((0xFFFF, 0));
    let n = seg.len() as i32;
    let mut sub = Vec::new();
    for v in [4, 16 + 8 * n, 0, 2 * n, 2, 0, 2 * n - 2] {
        be16(&mut sub, v);
    }
    seg.iter().for_each(|(c, _)| be16(&mut sub, *c));
    be16(&mut sub, 0);
    seg.iter().for_each(|(c, _)| be16(&mut sub, *c));
    seg.iter().for_each(|(c, g)| be16(&mut sub, if *c == 0xFFFF { 1 } else { g - c }));
    seg.iter().for_each(|_| be16(&mut sub, 0));
    let mut cmap = Vec::new();
    for v in [0, 1, 3, 1] {
        be16(&mut cmap, v);
    }
    cmap.extend(12u32.to_be_bytes());
    cmap.extend(sub);
    tables.push((b"cmap", cmap));

    // Glyph 0 empty, then a square per character.
    let mut glyf = Vec::new();
    let mut loca = vec![0u8; 4];
    for _ in 1..glyphs {
        for v in [1, 0, 0, 900, 700, 3, 0] {
            be16(&mut glyf, v);
        }
        glyf.extend([1, 1, 1, 1]);
        for v in [0, 900, 0, -900, 0, 0, 700, 0] {
            be16(&mut glyf, v);
        }
        loca.extend((glyf.len() as u32).to_be_bytes());
    }
    tables.push((b"glyf", glyf));
    tables.push((b"loca", loca));

    let records = [(1, family.to_owned()), (2, "Regular".to_owned()), (4, format!("{family} Regular")), (6, family.replace(' ', ""))];
    let mut name = Vec::new();
    let mut strings = Vec::new();
    for v in [0, records.len() as i32, 6 + 12 * records.len() as i32] {
        be16(&mut name, v);
    }
    for (id, s) in &records {
        let utf16: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        for v in [3, 1, 0x409, *id, utf16.len() as i32, strings.len() as i32] {
            be16(&mut name, v);
        }
        strings.extend(utf16);
    }
    name.extend(strings);
    tables.push((b"name", name));

    let mut os2 = vec![0u8; 96];
    os2[0..2].copy_from_slice(&4u16.to_be_bytes());
    os2[4..6].copy_from_slice(&400u16.to_be_bytes());
    os2[6..8].copy_from_slice(&5u16.to_be_bytes());
    os2[32] = 2;
    os2[33] = serif;
    os2[62..64].copy_from_slice(&0x40u16.to_be_bytes());
    os2[68..70].copy_from_slice(&800u16.to_be_bytes());
    os2[70..72].copy_from_slice(&(-200i16 as u16).to_be_bytes());
    os2[74..76].copy_from_slice(&800u16.to_be_bytes());
    os2[76..78].copy_from_slice(&200u16.to_be_bytes());
    tables.push((b"OS/2", os2));

    let mut post = vec![0u8; 32];
    post[0..4].copy_from_slice(&0x0003_0000u32.to_be_bytes());
    tables.push((b"post", post));

    tables.sort_by_key(|(t, _)| **t);
    let mut out = Vec::new();
    out.extend(0x0001_0000u32.to_be_bytes());
    for v in [tables.len() as i32, 128, 3, tables.len() as i32 * 16 - 128] {
        be16(&mut out, v);
    }
    let mut offset = 12 + 16 * tables.len();
    for (tag, body) in &tables {
        out.extend(*tag);
        out.extend([0; 4]);
        out.extend((offset as u32).to_be_bytes());
        out.extend((body.len() as u32).to_be_bytes());
        offset += body.len().div_ceil(4) * 4;
    }
    for (_, body) in &tables {
        out.extend(body);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    out
}

/// `ttf` in an EOT file without compression.
fn eot(ttf: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; 82];
    let size = (out.len() + ttf.len()) as u32;
    out[0..4].copy_from_slice(&size.to_le_bytes());
    out[4..8].copy_from_slice(&(ttf.len() as u32).to_le_bytes());
    out[8..12].copy_from_slice(&0x0002_0001u32.to_le_bytes());
    out[34..36].copy_from_slice(&0x504Cu16.to_le_bytes());
    out.extend_from_slice(ttf);
    out
}

/// One slide holding `shapes`, a theme whose minor fonts are `minor`
/// (latin, ea), and `embedded` fonts: (typeface, EOT bytes).
fn deck(shapes: &str, minor: (&str, &str), embedded: &[(&str, Vec<u8>)]) -> Presentation {
    let ct = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>"#;
    let root = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#);
    let fonts: String = embedded.iter().enumerate().map(|(i, (face, _))| format!(r#"<p:embeddedFont><p:font typeface="{face}"/><p:regular r:id="rIdF{i}"/></p:embeddedFont>"#)).collect();
    let pres = format!(r#"<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:embeddedFontLst>{fonts}</p:embeddedFontLst></p:presentation>"#);
    let font_rels: String = (0..embedded.len()).map(|i| format!(r#"<Relationship Id="rIdF{i}" Type="{R}/font" Target="fonts/font{i}.fntdata"/>"#)).collect();
    let pres_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="{R}/slide" Target="slides/slide1.xml"/>{font_rels}</Relationships>"#);
    let slide = format!(r#"<p:sld xmlns:a="{A}" xmlns:p="{P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld></p:sld>"#);
    let slide_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#);
    let layout = format!(r#"<p:sldLayout xmlns:p="{P}"><p:cSld><p:spTree/></p:cSld></p:sldLayout>"#);
    let layout_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#);
    let master = format!(r#"<p:sldMaster xmlns:p="{P}"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/></p:sldMaster>"#);
    let master_rels = format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/theme" Target="../theme/theme1.xml"/></Relationships>"#);
    let theme = format!(
        r#"<a:theme xmlns:a="{A}"><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="{0}"/><a:ea typeface="{1}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="{0}"/><a:ea typeface="{1}"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="x"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>"#,
        minor.0, minor.1
    );
    let names: Vec<String> = (0..embedded.len()).map(|i| format!("ppt/fonts/font{i}.fntdata")).collect();
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", pres.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", pres_rels.as_bytes()),
        ("ppt/slides/slide1.xml", slide.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", slide_rels.as_bytes()),
        ("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels.as_bytes()),
        ("ppt/slideMasters/slideMaster1.xml", master.as_bytes()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels.as_bytes()),
        ("ppt/theme/theme1.xml", theme.as_bytes()),
    ];
    for (name, (_, bytes)) in names.iter().zip(embedded) {
        parts.push((name, bytes));
    }
    Presentation::open(Package::from_parts(&parts).unwrap().save().unwrap()).unwrap()
}

/// A shape of `w`×`h` points with geometry `geom`, holding one run of
/// `text` at 10 pt with `fonts` (`a:latin`/`a:ea` elements).
fn text_shape(geom: &str, w: i64, h: i64, fonts: &str, text: &str) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{}" cy="{}"/></a:xfrm>{geom}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ko-KR" sz="1000">{fonts}</a:rPr><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"#,
        w * 12700,
        h * 12700
    )
}

const RECT: &str = r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#;

/// (requested, used, fidelity) of each font the slide's first text box used.
fn fonts_used(doc: &Presentation, res: &Resources) -> Vec<(String, String, String)> {
    let out = render_slide(doc, 1, res).unwrap();
    let v = serde_json::to_value(&out.texts[0].fonts).unwrap();
    v.as_array().unwrap().iter().map(|f| (f["requested"].as_str().unwrap().into(), f["used"].as_str().unwrap().into(), f["fidelity"].as_str().unwrap().into())).collect()
}

#[test]
fn an_embedded_font_is_drawn_for_its_own_document_only() {
    let shape = text_shape(RECT, 200, 50, r#"<a:latin typeface="문서 글꼴"/>"#, "Ab");
    let with = deck(&shape, ("Base", "Base"), &[("문서 글꼴", eot(&font("Doc Face", 11, "Ab")))]);
    let without = deck(&shape, ("Base", "Base"), &[]);
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Arial", 11, "Ab"));
    let mut res = Resources::new(fonts);
    let scope = res.open_document(&with);
    assert_ne!(scope, 0);
    // Found under the name the document gives it.
    assert_eq!(fonts_used(&with, &res), vec![("문서 글꼴".into(), "Doc Face".into(), "exact".into())]);
    // Another document does not see it.
    assert_eq!(res.open_document(&without), 0);
    assert_eq!(fonts_used(&without, &res)[0].2, "substituted");
    // Switching back finds it again; closing removes it.
    res.fonts.set_active_document(scope);
    assert_eq!(fonts_used(&with, &res)[0].2, "exact");
    res.fonts.remove_document_fonts(scope);
    assert!(res.fonts.family_face("문서 글꼴", false, false).is_none());
}

#[test]
fn an_installed_font_comes_before_the_embedded_copy() {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Same Face", 11, "ab"));
    let scope = fonts.add_document_fonts(vec![("Same Face".into(), font("Same Face", 11, "abc"))]);
    fonts.set_active_document(scope);
    let (face, _) = fonts.family_face("Same Face", false, false).unwrap();
    assert!(face.covers('a') && !face.covers('c'), "the installed copy");
}

#[test]
fn an_east_asian_character_the_font_lacks_follows_the_runs_fonts() {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Latin Sans", 11, "A"));
    fonts.add_bytes(font("Latin Serif", 0, "A"));
    fonts.add_bytes(font("Both Scripts", 11, "A가"));
    fonts.add_bytes(font("Malgun Gothic", 11, "가"));
    fonts.add_bytes(font("Batang", 2, "가"));
    let res = Resources::new(fonts);
    let used = |latin: &str, ea: &str| {
        let doc = deck(&text_shape(RECT, 200, 50, &format!(r#"<a:latin typeface="{latin}"/><a:ea typeface="{ea}"/>"#), "가"), ("Base", "Base"), &[]);
        fonts_used(&doc, &res).into_iter().map(|f| f.1).collect::<Vec<_>>()
    };
    // The run's Latin font, when it has the character.
    assert_eq!(used("Both Scripts", "Latin Sans"), vec!["Both Scripts"]);
    // Else a gothic face for a sans serif font, a serif face otherwise.
    assert_eq!(used("Latin Sans", "Latin Sans"), vec!["Malgun Gothic"]);
    assert_eq!(used("Latin Serif", "Latin Serif"), vec!["Batang"]);
}

#[test]
fn text_stays_inside_the_preset_text_rectangle() {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Box Face", 11, "A "));
    let res = Resources::new(fonts);
    let lines = |geom: &str| {
        let doc = deck(&text_shape(geom, 100, 100, r#"<a:latin typeface="Box Face"/>"#, "AAA AAA"), ("Base", "Base"), &[]);
        render_slide(&doc, 1, &res).unwrap().texts[0].lines.len()
    };
    // 70 pt of text: within the box less its margins (85.6 pt), not within a
    // fully rounded rectangle's text area (56.3 pt).
    assert_eq!(lines(RECT), 1);
    assert_eq!(lines(r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>"#), 2);
}

#[test]
fn vertical_table_cell_text_wraps_at_the_row_height() {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Box Face", 11, "A "));
    let res = Resources::new(fonts);
    let cell = |vert: &str| {
        format!(r#"<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1000"><a:latin typeface="Box Face"/></a:rPr><a:t>AAA AAA</a:t></a:r></a:p></a:txBody><a:tcPr vert="{vert}"/></a:tc>"#)
    };
    let table = format!(
        r#"<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000">{}{}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>"#,
        cell("horz"),
        cell("vert")
    );
    let out = render_slide(&deck(&table, ("Base", "Base"), &[]), 1, &res).unwrap();
    // 70 pt of text: one line across 100 pt; in the vertical cell it runs
    // along the 50 pt row (less margins, 42.8 pt) and wraps, and the row
    // keeps its height (measured, 2026-10-11-vertical-table-cells.md).
    let lines: Vec<usize> = out.texts.iter().map(|t| t.lines.len()).collect();
    assert_eq!(lines, vec![1, 2]);
    assert!(out.texts.iter().all(|t| (t.frame[3] - 50.0).abs() < 0.01));
    let turned = out.scene.items.iter().filter(|i| matches!(i, present_render::Item::Glyphs { transform, .. } if transform.as_coeffs()[0].abs() < 1e-9 && (transform.as_coeffs()[1] - 1.0).abs() < 1e-9)).count();
    assert!(turned > 0, "the vertical cell's glyphs are turned a quarter turn");
}

#[test]
fn text_taller_than_its_box_reports_how_far_it_overflows() {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(font("Arial", 11, "A "));
    let res = Resources::new(fonts);
    let overflow = |text: &str| {
        let doc = deck(&text_shape(RECT, 60, 30, r#"<a:latin typeface="Arial"/>"#, text), ("Arial", "Arial"), &[]);
        let text = &render_slide(&doc, 1, &res).unwrap().texts[0];
        assert!(text.on_slide);
        text.overflow
    };
    // One 10 pt line fits in 30 pt less the 3.6 pt top and bottom insets.
    assert_eq!(overflow("AA"), 0.0);
    // Many wrapped lines run past the bottom.
    let over = overflow(&"AAA ".repeat(30));
    assert!(over > 20.0, "overflow {over}");
}
