use present_pptx::package::Package;
use present_pptx::render::fonts::FontSet;
use present_pptx::render::{render_slide, Resources};
use present_pptx::Presentation;
use kurbo::Shape;
use present_render::{Item, Paint};

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const THEME_SHADOW: &str = r#"<a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw>"#;

/// One slide holding `shapes` (`p:sp` elements), with a minimal layout,
/// master and theme.
fn deck(shapes: &str) -> Presentation {
    let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    let root = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
    let pres = r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#;
    let pres_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
    let slide = format!(r#"<p:sld xmlns:a="{A}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld></p:sld>"#);
    let slide_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;
    let layout = r#"<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>"#;
    let layout_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;
    let master = r#"<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/></p:sldMaster>"#;
    let master_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;
    // Effect style 2 is PowerPoint's usual soft outer shadow.
    let theme = format!(r#"<a:theme xmlns:a="{A}"><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme><a:fmtScheme name="x"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst>{THEME_SHADOW}</a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>"#);
    let bytes = Package::from_parts(&[
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
    ])
    .unwrap()
    .save()
    .unwrap();
    Presentation::open(bytes).unwrap()
}

fn shape(effects: &str, text: &str) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2F5597"/></a:solidFill>{effects}</p:spPr><p:txBody><a:bodyPr/><a:p>{text}</a:p></p:txBody></p:sp>"#
    )
}

const GLOW: &str = r#"<a:effectLst><a:glow rad="127000"><a:srgbClr val="FF0000"><a:alpha val="60000"/></a:srgbClr></a:glow></a:effectLst>"#;

/// The colour a glow layer paints, if `item` is one: the glow colour seen
/// through a blurred silhouette.
fn glow_colour(item: &Item) -> Option<(u8, u8, u8, u8)> {
    let Item::Masked { mask, items } = item else { return None };
    let ([Item::Blurred { .. }], [Item::Path { fill: Some(Paint::Solid(c)), .. }]) = (mask.as_slice(), items.as_slice()) else { return None };
    Some((c.r, c.g, c.b, c.a))
}

#[test]
fn shape_glow_is_drawn_behind_the_shape_at_its_own_alpha() {
    let doc = deck(&shape(GLOW, ""));
    let out = render_slide(&doc, 1, &Resources::new(FontSet::empty())).unwrap();
    // The glow precedes the shape's fill, and keeps the 60% alpha (an
    // opaque silhouette is the mask, so overlaps cannot compound it).
    assert_eq!(glow_colour(&out.scene.items[0]), Some((255, 0, 0, 153)));
    assert!(matches!(&out.scene.items[1], Item::Path { fill: Some(Paint::Solid(c)), .. } if (c.r, c.g, c.b) == (0x2F, 0x55, 0x97)));
    assert!(out.provisional.contains(&"glow"));
}

#[test]
fn text_glow_is_drawn_under_the_glyphs() {
    let run = format!(r#"<a:r><a:rPr lang="en-US" sz="4000">{GLOW}<a:latin typeface="Source Sans 3"/></a:rPr><a:t>Glow</a:t></a:r>"#);
    let doc = deck(&shape("", &run));
    let mut fonts = FontSet::empty();
    fonts.add_bytes(include_bytes!("../../../engine/vendor/designcraft-fonts/assets/fonts/SourceSans3-Regular.ttf").to_vec());
    let out = render_slide(&doc, 1, &Resources::new(fonts)).unwrap();
    let glow = out.scene.items.iter().position(|i| glow_colour(i) == Some((255, 0, 0, 153))).expect("a text glow layer");
    let glyphs = out.scene.items.iter().position(|i| matches!(i, Item::Glyphs { .. })).expect("glyphs");
    assert!(glow < glyphs, "glow under the text");
}

#[test]
fn soft_edge_and_reflection_draw_the_shape_through_a_mask() {
    let soft = r#"<a:effectLst><a:softEdge rad="152400"/></a:effectLst>"#;
    let out = render_slide(&deck(&shape(soft, "")), 1, &Resources::new(FontSet::empty())).unwrap();
    assert!(matches!(out.scene.items.as_slice(), [Item::Masked { .. }]), "the shape is drawn only through its faded outline");

    let reflection = r#"<a:effectLst><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>"#;
    let out = render_slide(&deck(&shape(reflection, "")), 1, &Resources::new(FontSet::empty())).unwrap();
    assert_eq!(out.scene.items.len(), 2, "the shape and its reflection");
    assert!(out.scene.items.iter().any(|i| matches!(i, Item::Masked { .. })));
}

#[test]
fn effects_command_keeps_the_theme_style_effects_and_is_drawn() {
    // A shape whose shadow comes from theme effect style 2.
    let styled = shape("", "").replace("</p:spPr>", r#"</p:spPr><p:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"/></p:style>"#);
    let mut doc = deck(&styled);
    let cmd: present_pptx::commands::Command = serde_json::from_str(r#"{"op":"set_shape_effects","slide":1,"shapeId":2,"glow":{"radius":10,"color":"FF0000"}}"#).unwrap();
    present_pptx::commands::run(&mut doc, &cmd).unwrap();
    let xml = String::from_utf8(doc.package().read("ppt/slides/slide1.xml").unwrap().to_vec()).unwrap();
    // The shape's own list replaces the style's, so the shadow is carried over.
    assert!(xml.contains(&format!(r#"<a:effectLst><a:glow rad="127000"><a:srgbClr val="FF0000"><a:alpha val="60000"/></a:srgbClr></a:glow>{THEME_SHADOW}</a:effectLst></p:spPr>"#)), "{xml}");
    let out = render_slide(&doc, 1, &Resources::new(FontSet::empty())).unwrap();
    assert!(out.scene.items.iter().any(|i| glow_colour(i) == Some((255, 0, 0, 153))));
}

fn source_sans() -> FontSet {
    let mut fonts = FontSet::empty();
    fonts.add_bytes(include_bytes!("../../../engine/vendor/designcraft-fonts/assets/fonts/SourceSans3-Regular.ttf").to_vec());
    fonts
}

#[test]
fn plain_warp_stretches_the_text_ink_over_the_whole_box() {
    // Box 100,100 - 300,200 pt; insets do not limit a warp.
    let text = r#"<a:r><a:rPr lang="en-US" sz="1800"><a:latin typeface="Source Sans 3"/></a:rPr><a:t>Warp</a:t></a:r>"#;
    let sp = shape("", text).replace("<p:txBody><a:bodyPr/>", r#"<p:txBody><a:bodyPr><a:prstTxWarp prst="textPlain"><a:avLst/></a:prstTxWarp></a:bodyPr>"#);
    let out = render_slide(&deck(&sp), 1, &Resources::new(source_sans())).unwrap();
    let ink = out.scene.items.iter().skip(1).filter_map(|i| match i {
        Item::Path { path, transform, .. } => Some((*transform * path.clone()).bounding_box()),
        _ => None,
    }).reduce(|a, b| a.union(b)).expect("warped glyphs as paths");
    for (got, want) in [(ink.x0, 100.0), (ink.y0, 100.0), (ink.x1, 300.0), (ink.y1, 200.0)] {
        assert!((got - want).abs() < 0.5, "{ink:?}");
    }
    assert!(out.provisional.contains(&"textWarp"));
}

#[test]
fn text_in_a_scaled_group_keeps_its_size_and_wraps_in_the_drawn_box() {
    // The group draws its 400 x 200 pt child space at half size.
    let text = r#"<a:r><a:rPr lang="en-US" sz="1800"><a:latin typeface="Source Sans 3"/></a:rPr><a:t>Hg</a:t></a:r>"#;
    let group = format!(
        r#"<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="5080000" cy="2540000"/></a:xfrm></p:grpSpPr>{}</p:grpSp>"#,
        shape("", text).replace(r#"<a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/>"#, r#"<a:off x="0" y="0"/><a:ext cx="5080000" cy="2540000"/>"#)
    );
    let out = render_slide(&deck(&group), 1, &Resources::new(source_sans())).unwrap();
    let frame = out.texts[0].frame;
    assert_eq!([frame[2], frame[3]], [200.0, 100.0], "laid out in the box as drawn");
    let size = out.scene.items.iter().find_map(|i| match i {
        Item::Glyphs { run, transform } => Some(run.size * transform.as_coeffs()[0]),
        _ => None,
    });
    assert_eq!(size, Some(18.0), "drawn at its own size");
}

#[test]
fn colour_emoji_draw_their_bitmaps_in_the_emoji_font() {
    // Needs a colour emoji font on this machine (macOS: Apple Color Emoji).
    let fonts = FontSet::local();
    if fonts.family_face("Apple Color Emoji", false, false).is_none() {
        return;
    }
    let text = r#"<a:r><a:rPr lang="en-US" sz="4000"><a:latin typeface="Arial"/></a:rPr><a:t>✅ ok</a:t></a:r>"#;
    let doc = deck(&shape("", text).replace(r#"<a:solidFill><a:srgbClr val="2F5597"/></a:solidFill>"#, ""));
    let out = render_slide(&doc, 1, &Resources::new(fonts)).unwrap();
    let res = Resources::new(FontSet::local());
    let raster = present_render::rasterize(&out.scene, res.fonts.db(), 1.0);
    // Apple's check mark is green; plain text and a missing-glyph box are not.
    let green = raster.pixels.chunks(4).filter(|p| p[1] > 150 && p[0] < 140 && p[2] < 140).count();
    assert!(green > 50, "{green} green pixels");
}
