//! Pictures: insert a new one, or replace the image of an existing one.
//! Image bytes arrive base64-encoded (PNG, JPEG or GIF).

use std::collections::BTreeSet;

use base64::Engine;
use serde_json::{json, Value};

use super::shape::{commit, target};
use super::slides::{add_relationships, ensure_default_type, fresh_name, fresh_rel_id, reachable, relative, update_content_types};
use super::xmledit::{escape_attr, start_tag};
use super::EMU_PER_PT;
use crate::xml::{NS_A, NS_P, NS_R};
use crate::{Error, Presentation};

const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
/// Largest picture accepted (decoded file size).
const MAX_IMAGE_BYTES: usize = 50 << 20;

/// A decoded upload: bytes, extension, content type and pixel size.
struct Upload {
    bytes: Vec<u8>,
    ext: &'static str,
    content_type: &'static str,
    size: (u32, u32),
}

fn decode(data: &str) -> Result<Upload, Error> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| Error::InvalidCommand(format!("image data is not base64: {e}")))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::InvalidCommand("image larger than 50 MB".into()));
    }
    let (ext, content_type) = match bytes.get(..4) {
        Some([0x89, b'P', b'N', b'G']) => ("png", "image/png"),
        Some([0xFF, 0xD8, 0xFF, _]) => ("jpeg", "image/jpeg"),
        Some([b'G', b'I', b'F', b'8']) => ("gif", "image/gif"),
        _ => return Err(Error::InvalidCommand("image must be PNG, JPEG or GIF".into())),
    };
    let size = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| Error::InvalidCommand(e.to_string()))?
        .into_dimensions()
        .map_err(|e| Error::InvalidCommand(format!("unreadable image: {e}")))?;
    Ok(Upload { bytes, ext, content_type, size })
}

/// Stores the image as a new media part and relates it to `slide_part`.
fn store(doc: &mut Presentation, slide_part: &str, up: &Upload) -> Result<String, Error> {
    let name = fresh_name(doc, &format!("ppt/media/image1.{}", up.ext), &BTreeSet::new());
    doc.package_mut().write(&name, up.bytes.clone())?;
    ensure_default_type(doc, up.ext, up.content_type)?;
    let rid = fresh_rel_id(doc, slide_part, &[])?;
    add_relationships(doc, slide_part, &[(rid.clone(), REL_IMAGE.to_owned(), relative(slide_part, &name), false)])?;
    Ok(rid)
}

/// Inserts a picture. Without a size it is placed at its size at 96 dpi,
/// shrunk to fit the slide; without a position it is centred.
#[allow(clippy::too_many_arguments)]
pub fn insert_image(doc: &mut Presentation, slide: usize, data: &str, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64>, alt_text: Option<&str>) -> Result<Value, Error> {
    let up = decode(data)?;
    let (sw, sh) = super::create::slide_size(doc)?;
    let (pw, ph) = (up.size.0 as f64 * 0.75, up.size.1 as f64 * 0.75);
    let (w, h) = match (width, height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, w * ph / pw.max(1e-9)),
        (None, Some(h)) => (h * pw / ph.max(1e-9), h),
        (None, None) => {
            let k = (sw * 0.9 / pw).min(sh * 0.9 / ph).min(1.0);
            (pw * k, ph * k)
        }
    };
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return Err(Error::InvalidCommand("picture size must be positive".into()));
    }
    let (x, y) = (x.unwrap_or((sw - w) / 2.0), y.unwrap_or((sh - h) / 2.0));
    let part = doc.slide_part(slide)?.to_owned();
    let rid = store(doc, &part, &up)?;
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let descr = alt_text.map(|d| format!(r#" descr="{}""#, escape_attr(d))).unwrap_or_default();
    let id = super::create::append_shape(doc, slide, |id, p, a| {
        format!(
            r#"<{p}pic><{p}nvPicPr><{p}cNvPr id="{id}" name="Picture {}"{descr}/><{p}cNvPicPr><{a}picLocks noChangeAspect="1"/></{p}cNvPicPr><{p}nvPr/></{p}nvPicPr><{p}blipFill><{a}blip r:embed="{rid}"/><{a}stretch><{a}fillRect/></{a}stretch></{p}blipFill><{p}spPr><{a}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm><{a}prstGeom prst="rect"><{a}avLst/></{a}prstGeom></{p}spPr></{p}pic>"#,
            id - 1,
            e(x),
            e(y),
            e(w),
            e(h)
        )
    })?;
    Ok(json!({ "op": "insert_image", "slide": slide, "shapeId": id, "changed": true }))
}

/// Replaces a picture's image, keeping its frame, effects and name; the
/// crop is cleared, as PowerPoint's Change Picture does. A media part no
/// longer used anywhere is removed.
pub fn replace_image(doc: &mut Presentation, slide: usize, id: u32, data: &str) -> Result<Value, Error> {
    let up = decode(data)?;
    let before = reachable(doc)?;
    let part = doc.slide_part(slide)?.to_owned();
    let rid = store(doc, &part, &up)?;
    let t = target(doc, slide, id)?;
    let fill = match t.tree.node(t.shape).local.as_str() {
        "pic" => t.tree.child(t.shape, NS_P, "blipFill"),
        _ => t.tree.path(t.shape, &[(NS_P, "spPr"), (NS_A, "blipFill")]),
    }
    .ok_or_else(|| Error::InvalidCommand("shape has no picture".into()))?;
    let blip = t.tree.child(fill, NS_A, "blip").ok_or_else(|| Error::Xml("picture without a:blip".into()))?;
    let r = super::xmledit::ns_prefix(&t.src, &t.tree, NS_R).unwrap_or_else(|| "r".into());
    let mut edits = Vec::new();
    let b = t.tree.node(blip);
    let old_rid = b.attr_ns(NS_R, "embed").map(str::to_owned);
    // Rewrite r:embed (and drop r:link) on the blip's start tag.
    let embed = format!("{r}:embed");
    let link = format!("{r}:link");
    edits.push((b.start..b.open_end, start_tag(&t.src, &t.tree, blip, &[(embed.as_str(), Some(rid.clone())), (link.as_str(), None)], b.is_empty_element())?));
    if let Some(rect) = t.tree.child(fill, NS_A, "srcRect") {
        edits.push((t.tree.node(rect).start..t.tree.node(rect).end, Vec::new()));
    }
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    // Drop the old image's relationship if nothing on the slide still uses
    // it, then any media that nothing reaches any more.
    if let Some(old) = old_rid {
        let (_, tree) = super::slides::read_tree(doc, &part)?;
        let used = tree.nodes.iter().any(|n| n.attrs.iter().any(|a| a.ns.as_deref() == Some(NS_R) && a.value == old));
        if !used {
            super::slides::remove_relationship(doc, &part, &old)?;
        }
    }
    let after = reachable(doc)?;
    let gone: BTreeSet<String> = before.difference(&after).cloned().collect();
    for p in &gone {
        doc.package_mut().remove(p)?;
    }
    update_content_types(doc, &[], &gone)?;
    Ok(json!({ "op": "replace_image", "slide": slide, "shapeId": id, "changed": true }))
}

const REL_VIDEO: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video";
const REL_AUDIO: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio";
const REL_MEDIA: &str = "http://schemas.microsoft.com/office/2007/relationships/media";
/// Largest video or sound accepted (decoded file size).
const MAX_MEDIA_BYTES: usize = 500 << 20;

/// A decoded video or sound: bytes, extension, content type, and whether it
/// is a video.
struct MediaUpload {
    bytes: Vec<u8>,
    ext: &'static str,
    content_type: &'static str,
    video: bool,
}

/// Recognizes MP4/M4V/MOV video and M4A/MP3/WAV sound by their bytes.
fn decode_media(data: &str) -> Result<MediaUpload, Error> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| Error::InvalidCommand(format!("media data is not base64: {e}")))?;
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(Error::InvalidCommand("media larger than 500 MB".into()));
    }
    let (ext, content_type, video) = if bytes.get(4..8) == Some(b"ftyp") {
        match bytes.get(8..12) {
            Some(b"qt  ") => ("mov", "video/quicktime", true),
            Some(b"M4A ") => ("m4a", "audio/mp4", false),
            Some(b"M4V ") | Some(b"M4VH") | Some(b"M4VP") => ("m4v", "video/x-m4v", true),
            _ => ("mp4", "video/mp4", true),
        }
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        ("wav", "audio/wav", false)
    } else if bytes.starts_with(b"ID3") || matches!(bytes.get(..2), Some([0xFF, b]) if b & 0xE0 == 0xE0) {
        ("mp3", "audio/mpeg", false)
    } else {
        return Err(Error::InvalidCommand("media must be MP4, M4V or MOV video, or M4A, MP3 or WAV sound".into()));
    };
    Ok(MediaUpload { bytes, ext, content_type, video })
}

/// A plain poster: a dark frame with a play triangle for a video, a
/// speaker on a light square for a sound.
fn default_poster(video: bool) -> Vec<u8> {
    let (w, h) = if video { (640u32, 360u32) } else { (128, 128) };
    let mut img = image::RgbaImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let (fx, fy) = (x as f64 / w as f64, y as f64 / h as f64);
        *p = if video {
            // Play triangle in the middle.
            let inside = fx > 0.43 && fx < 0.6 && (fy - 0.5).abs() < (0.6 - fx) * (w as f64 / h as f64) * 0.55;
            if inside { image::Rgba([240, 240, 240, 255]) } else { image::Rgba([32, 32, 32, 255]) }
        } else {
            // Speaker: a box and a cone.
            let body = fx > 0.25 && fx < 0.42 && fy > 0.38 && fy < 0.62;
            let cone = fx >= 0.42 && fx < 0.68 && (fy - 0.5).abs() < 0.12 + (fx - 0.42) * 0.9;
            if body || cone { image::Rgba([64, 64, 64, 255]) } else { image::Rgba([224, 224, 224, 255]) }
        };
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).expect("png encodes");
    out
}

/// Stores media bytes as a new part, related to `slide_part` both as the
/// video/audio link and as the embedded media; returns (link id, media id).
fn store_media(doc: &mut Presentation, slide_part: &str, m: &MediaUpload) -> Result<(String, String), Error> {
    let name = fresh_name(doc, &format!("ppt/media/media1.{}", m.ext), &BTreeSet::new());
    doc.package_mut().write(&name, m.bytes.clone())?;
    ensure_default_type(doc, m.ext, m.content_type)?;
    let link = fresh_rel_id(doc, slide_part, &[])?;
    let embed = fresh_rel_id(doc, slide_part, std::slice::from_ref(&link))?;
    let target = relative(slide_part, &name);
    add_relationships(doc, slide_part, &[(link.clone(), if m.video { REL_VIDEO } else { REL_AUDIO }.to_owned(), target.clone(), false), (embed.clone(), REL_MEDIA.to_owned(), target, false)])?;
    Ok((link, embed))
}

fn poster_upload(poster: Option<&str>, video: bool) -> Result<Upload, Error> {
    match poster {
        Some(p) => decode(p),
        None => {
            let bytes = default_poster(video);
            let size = if video { (640, 360) } else { (128, 128) };
            Ok(Upload { bytes, ext: "png", content_type: "image/png", size })
        }
    }
}

/// Inserts a video or sound as PowerPoint does: a picture (the poster, by
/// default a plain play or speaker image) that plays the embedded file on
/// click. Default size 320 x 180 pt for a video, 48 x 48 pt for a sound,
/// centred.
#[allow(clippy::too_many_arguments)]
pub fn insert_media(doc: &mut Presentation, slide: usize, data: &str, poster: Option<&str>, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64>) -> Result<Value, Error> {
    let m = decode_media(data)?;
    let pu = poster_upload(poster, m.video)?;
    let (sw, sh) = super::create::slide_size(doc)?;
    let (dw, dh) = if m.video { (320.0, 180.0) } else { (48.0, 48.0) };
    let (w, h) = (width.unwrap_or(dw), height.unwrap_or(dh));
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return Err(Error::InvalidCommand("media size must be positive".into()));
    }
    let (x, y) = (x.unwrap_or((sw - w) / 2.0), y.unwrap_or((sh - h) / 2.0));
    let part = doc.slide_part(slide)?.to_owned();
    let (link, embed) = store_media(doc, &part, &m)?;
    let poster_rid = store(doc, &part, &pu)?;
    let e = |v: f64| (v * EMU_PER_PT).round() as i64;
    let file = if m.video { "videoFile" } else { "audioFile" };
    let id = super::create::append_shape(doc, slide, |id, p, a| {
        format!(
            r#"<{p}pic><{p}nvPicPr><{p}cNvPr id="{id}" name="Media {}"><{a}hlinkClick r:id="" action="ppaction://media"/></{p}cNvPr><{p}cNvPicPr><{a}picLocks noChangeAspect="1"/></{p}cNvPicPr><{p}nvPr><{a}{file} r:link="{link}"/><{p}extLst><{p}ext uri="{{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="{embed}"/></{p}ext></{p}extLst></{p}nvPr></{p}nvPicPr><{p}blipFill><{a}blip r:embed="{poster_rid}"/><{a}stretch><{a}fillRect/></{a}stretch></{p}blipFill><{p}spPr><{a}xfrm><{a}off x="{}" y="{}"/><{a}ext cx="{}" cy="{}"/></{a}xfrm><{a}prstGeom prst="rect"><{a}avLst/></{a}prstGeom></{p}spPr></{p}pic>"#,
            id - 1,
            e(x),
            e(y),
            e(w),
            e(h)
        )
    })?;
    Ok(json!({ "op": "insert_media", "slide": slide, "shapeId": id, "kind": if m.video { "video" } else { "audio" }, "changed": true }))
}

/// Replaces the video or sound of a media shape (and, when given, its
/// poster), keeping its frame and name. The old file goes when nothing else
/// uses it.
pub fn replace_media(doc: &mut Presentation, slide: usize, id: u32, data: &str, poster: Option<&str>) -> Result<Value, Error> {
    let m = decode_media(data)?;
    let t = target(doc, slide, id)?;
    let nv_pr = t.tree.path(t.shape, &[(NS_P, "nvPicPr"), (NS_P, "nvPr")]).ok_or_else(|| Error::InvalidCommand(format!("shape {id} is not a video or sound")))?;
    let file = t.tree.node(nv_pr).children.iter().copied().find(|&c| t.tree.node(c).ns.as_deref() == Some(NS_A) && matches!(t.tree.node(c).local.as_str(), "videoFile" | "audioFile")).ok_or_else(|| Error::InvalidCommand(format!("shape {id} is not a video or sound")))?;
    let media = t.tree.nodes.iter().enumerate().find(|(_, n)| n.local == "media" && n.start > t.tree.node(nv_pr).start && n.end < t.tree.node(nv_pr).end).map(|(i, _)| i);
    let before = reachable(doc)?;
    let part = t.part.clone();
    let (link, embed) = store_media(doc, &part, &m)?;
    let poster_rid = match poster {
        Some(p) => Some(store(doc, &part, &decode(p)?)?),
        None => None,
    };
    let t = target(doc, slide, id)?;
    let r = super::xmledit::ns_prefix(&t.src, &t.tree, NS_R).unwrap_or_else(|| "r".into());
    let a = super::xmledit::drawing_prefix(&t.tree)?;
    let mut edits = Vec::new();
    let mut old = Vec::new();
    // The link element: video or sound as the new file is.
    let fnode = t.tree.node(file);
    old.extend(fnode.attr_ns(NS_R, "link").map(str::to_owned));
    let local = if m.video { "videoFile" } else { "audioFile" };
    edits.push((fnode.start..fnode.end, format!(r#"<{a}{local} {r}:link="{link}"/>"#).into_bytes()));
    if let Some(mi) = media {
        let n = t.tree.node(mi);
        old.extend(n.attr_ns(NS_R, "embed").map(str::to_owned));
        let embed_name = format!("{r}:embed");
        edits.push((n.start..n.open_end, start_tag(&t.src, &t.tree, mi, &[(embed_name.as_str(), Some(embed.clone()))], n.open_end == n.end)?));
    }
    if let Some(prid) = &poster_rid {
        let blip = t.tree.path(t.shape, &[(NS_P, "blipFill"), (NS_A, "blip")]).ok_or_else(|| Error::Xml("media without a poster".into()))?;
        let b = t.tree.node(blip);
        old.extend(b.attr_ns(NS_R, "embed").map(str::to_owned));
        let embed_name = format!("{r}:embed");
        edits.push((b.start..b.open_end, start_tag(&t.src, &t.tree, blip, &[(embed_name.as_str(), Some(prid.clone()))], b.is_empty_element())?));
    }
    edits.sort_by_key(|e| e.0.start);
    commit(doc, &t, edits)?;
    let (_, tree) = super::slides::read_tree(doc, &part)?;
    for rid in old {
        let used = tree.nodes.iter().any(|n| n.attrs.iter().any(|x| x.ns.as_deref() == Some(NS_R) && x.value == rid));
        if !used {
            super::slides::remove_relationship(doc, &part, &rid)?;
        }
    }
    let after = reachable(doc)?;
    let gone: BTreeSet<String> = before.difference(&after).cloned().collect();
    for p in &gone {
        doc.package_mut().remove(p)?;
    }
    update_content_types(doc, &[], &gone)?;
    Ok(json!({ "op": "replace_media", "slide": slide, "shapeId": id, "kind": if m.video { "video" } else { "audio" }, "changed": true }))
}
