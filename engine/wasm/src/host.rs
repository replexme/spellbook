//! The engine side of the AI bridge contract (`apps/ai-bridge/src/engine.ts`):
//! one JSON call `{abiVersion: 1, operation, parameters}` in, `{result}` or
//! `{error: {code}}` out.
//!
//! The AI sees `observe`, `apply` and `receipt`. `open`, `save` and `close`
//! are for the host that owns the file.

use std::collections::HashMap;

use base64::Engine as _;
use present_engine::{Session, TxError};
use present_pptx::commands::{self, Command};
use present_pptx::render::{render_slide, Resources};
use present_pptx::{Error, Presentation};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Screenshots are scaled so the slide is this many pixels wide.
const SCREENSHOT_WIDTH: f64 = 1280.0;

struct Document {
    session: Session<Presentation>,
    /// Slide shown by `observe`: the last changed slide, else the first.
    focus: usize,
    receipts: HashMap<String, Value>,
    /// The document's embedded fonts in the shared font set (0: none).
    font_scope: u32,
}

pub struct Host {
    resources: Resources,
    docs: HashMap<String, Document>,
}

fn error(code: &str) -> Value {
    json!({ "error": { "code": code } })
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `slide:3/shape:7` -> (3, 7).
/// `slide:N/shape:ID` or `slide:N`.
fn parse_target(target: &str) -> Option<(usize, Option<u32>)> {
    let (slide, shape) = match target.split_once('/') {
        Some((s, sh)) => (s, Some(sh.strip_prefix("shape:")?.parse().ok()?)),
        None => (target, None),
    };
    Some((slide.strip_prefix("slide:")?.parse().ok()?, shape))
}

/// Converts a bridge command into an engine command: the target supplies
/// the slide and shape, the parameters the rest of the typed command.
pub fn engine_command(c: &Value) -> Result<Command, &'static str> {
    let operation = c.get("operation").and_then(Value::as_str).ok_or("invalid_command")?;
    let target = c.get("targetId").and_then(Value::as_str).ok_or("invalid_command")?;
    let params = c.get("parameters").and_then(Value::as_object).ok_or("invalid_command")?;
    let (slide, shape) = parse_target(target).ok_or("invalid_target")?;
    if params.keys().any(|k| k == "op" || k == "slide" || k == "shapeId") {
        return Err("invalid_command");
    }
    let mut command = params.clone();
    command.insert("op".into(), json!(operation));
    command.insert("slide".into(), json!(slide));
    if let Some(id) = shape {
        command.insert("shapeId".into(), json!(id));
    }
    serde_json::from_value(Value::Object(command)).map_err(|e| if e.to_string().starts_with("unknown variant") { "unsupported_operation" } else { "invalid_command" })
}

impl Host {
    pub fn new(resources: Resources) -> Self {
        Self { resources, docs: HashMap::new() }
    }

    pub fn resources(&self) -> &Resources {
        &self.resources
    }

    pub fn resources_mut(&mut self) -> &mut Resources {
        &mut self.resources
    }

    /// Handles one serialized call.
    pub fn invoke(&mut self, input: &str) -> String {
        let reply = match serde_json::from_str::<Value>(input) {
            Ok(v) if v.get("abiVersion").and_then(Value::as_u64) == Some(1) => {
                let op = v.get("operation").and_then(Value::as_str).unwrap_or("");
                let p = v.get("parameters").cloned().unwrap_or(Value::Null);
                match self.dispatch(op, &p) {
                    Ok(result) => json!({ "result": result }),
                    Err(code) => error(code),
                }
            }
            Ok(_) => error("abi_version"),
            Err(_) => error("invalid_request"),
        };
        reply.to_string()
    }

    fn dispatch(&mut self, op: &str, p: &Value) -> Result<Value, &'static str> {
        let doc_id = p.get("documentId").and_then(Value::as_str).ok_or("invalid_request")?.to_owned();
        match op {
            "open" => {
                let b64 = p.get("bytesBase64").and_then(Value::as_str).ok_or("invalid_request")?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "invalid_request")?;
                let pres = Presentation::open(bytes).map_err(|_| "unreadable_document")?;
                let slides = pres.slide_count();
                let font_scope = self.resources.open_document(&pres);
                if let Some(old) = self.docs.insert(doc_id.clone(), Document { session: Session::new(pres), focus: 1, receipts: HashMap::new(), font_scope }) {
                    self.resources.fonts.remove_document_fonts(old.font_scope);
                }
                Ok(json!({ "documentId": doc_id, "version": "0", "slides": slides }))
            }
            "close" => {
                if let Some(doc) = self.docs.remove(&doc_id) {
                    self.resources.fonts.remove_document_fonts(doc.font_scope);
                }
                Ok(Value::Null)
            }
            "save" => {
                let doc = self.docs.get(&doc_id).ok_or("unknown_document")?;
                let bytes = doc.session.document().save().map_err(|_| "save_failed")?;
                Ok(json!({
                    "documentId": doc_id,
                    "version": doc.session.version().to_string(),
                    "fileHash": sha256(&bytes),
                    "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }))
            }
            "observe" => self.observe(&doc_id, p.get("slide").and_then(Value::as_u64).map(|s| s as usize)),
            "apply" => self.apply(&doc_id, p),
            "receipt" => {
                let doc = self.docs.get(&doc_id).ok_or("unknown_document")?;
                let tx = p.get("transactionId").and_then(Value::as_str).ok_or("invalid_request")?;
                Ok(doc.receipts.get(tx).cloned().unwrap_or(Value::Null))
            }
            _ => Err("unsupported_operation"),
        }
    }

    fn observe(&self, doc_id: &str, slide: Option<usize>) -> Result<Value, &'static str> {
        let doc = self.docs.get(doc_id).ok_or("unknown_document")?;
        let pres = doc.session.document();
        let version = doc.session.version().to_string();
        let bytes = pres.save().map_err(|_| "save_failed")?;
        let focus = slide.unwrap_or(doc.focus).clamp(1, pres.slide_count().max(1));
        let slides = pres.slides().map_err(|_| "unreadable_document")?;
        let structure: Vec<Value> = slides
            .iter()
            .map(|s| {
                json!({
                    "slide": s.index,
                    "shapes": s.shapes.iter().map(|sh| shape_json(s.index, sh)).collect::<Vec<_>>(),
                })
            })
            .collect();
        self.resources.fonts.set_active_document(doc.font_scope);
        let rendered = render_slide(pres, focus, &self.resources).map_err(|_| "render_failed")?;
        let scale = SCREENSHOT_WIDTH / rendered.scene.width.max(1.0);
        let png = present_render::rasterize(&rendered.scene, self.resources.fonts.db(), scale).to_png();
        let mut diagnostics: Vec<Value> = rendered.diagnostics.iter().map(|d| json!({ "slide": focus, "shapeId": d.shape_id, "kind": d.kind, "detail": d.detail })).collect();
        for t in &rendered.texts {
            for f in t.fonts.iter().filter(|f| !matches!(f.fidelity, present_pptx::render::fonts::Fidelity::Exact)) {
                diagnostics.push(json!({
                    "slide": focus,
                    "shapeId": t.shape_id,
                    "kind": "font",
                    "detail": format!("'{}' drawn with '{}' ({:?}); line breaks may differ from PowerPoint", f.requested, f.used, f.fidelity),
                }));
            }
        }
        for p in &rendered.provisional {
            diagnostics.push(json!({ "slide": focus, "kind": "provisional", "detail": p }));
        }
        // Every shape's box (points, before rotation); text boxes add their lines.
        let bounds: Vec<Value> = rendered
            .frames
            .iter()
            .map(|f| {
                let mut b = json!({ "targetId": format!("slide:{focus}/shape:{}", f.shape_id), "frame": f.frame, "rotation": f.rotation, "lines": [] });
                if let Some(t) = rendered.texts.iter().find(|t| t.shape_id == f.shape_id) {
                    b["lines"] = json!(t.lines);
                }
                b
            })
            .collect();
        let comments = present_pptx::commands::comments::slide_comments(pres, focus).unwrap_or_default();
        let animations = present_pptx::commands::animation::slide_animations(pres, focus).unwrap_or_default();
        let smartart: Vec<Value> = rendered.frames.iter().filter_map(|f| present_pptx::commands::smartart::smartart_nodes(pres, focus, f.shape_id).ok().map(|n| json!({ "targetId": format!("slide:{focus}/shape:{}", f.shape_id), "nodes": n }))).collect();
        Ok(json!({
            "documentId": doc_id,
            "version": version,
            "fileHash": sha256(&bytes),
            "structure": { "slideCount": slides.len(), "focusSlide": focus, "slides": structure, "comments": comments, "animations": animations, "smartart": smartart },
            "selection": Value::Null,
            "bounds": bounds,
            "diagnostics": diagnostics,
            "screenshot": {
                "version": version,
                "imageUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)),
            },
        }))
    }

    fn apply(&mut self, doc_id: &str, p: &Value) -> Result<Value, &'static str> {
        let resources = &self.resources;
        let doc = self.docs.get_mut(doc_id).ok_or("unknown_document")?;
        resources.fonts.set_active_document(doc.font_scope);
        let tx = p.get("transactionId").and_then(Value::as_str).ok_or("invalid_request")?.to_owned();
        let expected: u64 = p.get("expectedVersion").and_then(Value::as_str).and_then(|v| v.parse().ok()).ok_or("version_conflict")?;
        let raw = p.get("commands").and_then(Value::as_array).ok_or("invalid_commands")?;
        let cmds: Vec<Command> = raw.iter().map(engine_command).collect::<Result<_, _>>()?;
        let fingerprint = sha256(serde_json::to_string(&cmds).map_err(|_| "invalid_commands")?.as_bytes());
        // Text edits recompute autofit with the same fonts the screen uses.
        let receipt = doc.session.apply(expected, &tx, &fingerprint, &cmds, |d, c| commands::run_with(d, c, Some(resources))).map_err(|e| match e {
            TxError::StaleVersion { .. } => "version_conflict",
            TxError::RequestIdReused { .. } => "transaction_conflict",
            TxError::EmptyBatch => "invalid_commands",
            TxError::Command { error: Error::NotFound(_), .. } => "target_not_found",
            TxError::Command { error: Error::Unsupported(_), .. } => "unsupported_content",
            TxError::Command { .. } => "command_failed",
        })?;
        if let Some(stored) = doc.receipts.get(&tx) {
            return Ok(stored.clone());
        }
        let targets: Vec<String> = raw.iter().filter_map(|c| c.get("targetId").and_then(Value::as_str).map(str::to_owned)).collect();
        let mut pages: Vec<String> = cmds.iter().map(|c| format!("slide:{}", c.slide())).collect();
        pages.dedup();
        if let Some(c) = cmds.last() {
            doc.focus = c.slide();
        }
        let mut warnings: Vec<Value> = receipt.results.iter().flat_map(|r| r["warnings"].as_array().cloned().unwrap_or_default()).collect();
        warnings.extend(receipt.results.iter().filter(|r| !r["autofit"].is_null()).map(|r| json!({ "kind": "autofit", "targetShape": r["shapeId"], "result": r["autofit"] })));
        // Lines of the changed shapes after the edit, so the AI can check the
        // result without a full observation.
        let mut scene = Vec::new();
        for c in &cmds {
            let (slide, Some(shape_id)) = (c.slide(), c.shape_id()) else { continue };
            if let Ok(r) = render_slide(doc.session.document(), slide, resources) {
                if let Some(t) = r.texts.iter().find(|t| t.shape_id == shape_id) {
                    scene.push(json!({ "targetId": format!("slide:{slide}/shape:{shape_id}"), "frame": t.frame, "lines": t.lines, "fonts": t.fonts }));
                }
            }
        }
        let value = json!({
            "documentId": doc_id,
            "transactionId": tx,
            "version": receipt.version.to_string(),
            "changedObjects": targets,
            "changedPages": pages,
            "scene": scene,
            "diagnosticDelta": warnings,
            "saveable": true,
        });
        doc.receipts.insert(tx, value.clone());
        Ok(value)
    }
}

fn shape_json(slide: usize, s: &present_pptx::ShapeInfo) -> Value {
    json!({
        "targetId": format!("slide:{slide}/shape:{}", s.id),
        "name": s.name,
        "kind": s.kind,
        "paragraphs": s.paragraphs,
        "children": s.children.iter().map(|c| shape_json(slide, c)).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use present_pptx::package::Package;
    use present_pptx::render::fonts::FontSet;

    fn deck() -> Vec<u8> {
        let ct = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#;
        let root = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
        let pres = r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#;
        let pres_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
        let slide = r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"/><a:t>old</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#;
        let slide_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;
        let layout = r#"<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>"#;
        let layout_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;
        let master = r#"<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1"/></p:sldMaster>"#;
        let master_rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;
        let theme = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme></a:themeElements></a:theme>"#;
        Package::from_parts(&[
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
        .unwrap()
    }

    fn call(host: &mut Host, op: &str, params: Value) -> Value {
        serde_json::from_str(&host.invoke(&json!({ "abiVersion": 1, "operation": op, "parameters": params }).to_string())).unwrap()
    }

    fn apply(host: &mut Host, expected: &str, tx: &str, text: &str) -> Value {
        call(host, "apply", json!({
            "documentId": "d", "expectedVersion": expected, "transactionId": tx,
            "executionGeneration": "g", "permissionRevision": "p",
            "commands": [{ "operation": "replace_text", "targetId": "slide:1/shape:2", "parameters": { "paragraphs": [text] } }],
        }))
    }

    #[test]
    fn observe_reports_frames_and_shape_commands_move_them() {
        let mut host = Host::new(Resources::new(FontSet::empty()));
        call(&mut host, "open", json!({ "documentId": "d", "bytesBase64": base64::engine::general_purpose::STANDARD.encode(deck()) }));
        let s = &call(&mut host, "observe", json!({ "documentId": "d" }))["result"];
        assert_eq!(s["bounds"][0]["frame"], json!([72.0, 72.0, 288.0, 72.0]));
        let r = call(&mut host, "apply", json!({
            "documentId": "d", "expectedVersion": "0", "transactionId": "m",
            "commands": [
                { "operation": "move", "targetId": "slide:1/shape:2", "parameters": { "x": 100, "y": 50 } },
                { "operation": "fill_color", "targetId": "slide:1/shape:2", "parameters": { "color": "FF0000" } },
                { "operation": "set_slide_hidden", "targetId": "slide:1", "parameters": { "hidden": true } },
            ],
        }));
        assert_eq!(r["result"]["version"], "1", "{r}");
        let s = &call(&mut host, "observe", json!({ "documentId": "d" }))["result"];
        assert_eq!(s["bounds"][0]["frame"], json!([100.0, 50.0, 288.0, 72.0]));
        // Unknown operations and parameters that try to change the target are refused.
        let bad = |op: &str, params: Value| {
            let mut h = Host::new(Resources::new(FontSet::empty()));
            call(&mut h, "open", json!({ "documentId": "d", "bytesBase64": base64::engine::general_purpose::STANDARD.encode(deck()) }));
            call(&mut h, "apply", json!({ "documentId": "d", "expectedVersion": "0", "transactionId": "x",
                "commands": [{ "operation": op, "targetId": "slide:1/shape:2", "parameters": params }] }))["error"]["code"].clone()
        };
        assert_eq!(bad("teleport", json!({})), "unsupported_operation");
        assert_eq!(bad("move", json!({ "x": 1, "y": 2, "shapeId": 9 })), "invalid_command");
        assert_eq!(bad("move", json!({ "x": "far" })), "invalid_command");
    }

    #[test]
    fn observe_apply_receipt_round_trip() {
        let mut host = Host::new(Resources::new(FontSet::empty()));
        let original = deck();
        let opened = call(&mut host, "open", json!({ "documentId": "d", "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&original) }));
        assert_eq!(opened["result"]["version"], "0");

        let s = &call(&mut host, "observe", json!({ "documentId": "d" }))["result"];
        assert_eq!(s["version"], "0");
        assert_eq!(s["fileHash"], sha256(&original), "an unchanged document hashes to the original file");
        assert_eq!(s["screenshot"]["version"], "0");
        assert!(s["screenshot"]["imageUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(s["structure"]["slides"][0]["shapes"][0]["targetId"], "slide:1/shape:2");

        let r = &apply(&mut host, "0", "t1", "new")["result"];
        assert_eq!(r["version"], "1");
        assert_eq!(r["changedObjects"][0], "slide:1/shape:2");
        assert_eq!(r["changedPages"][0], "slide:1");
        assert_eq!(r["scene"][0]["lines"][0]["text"], "new");

        // Same transaction again: same receipt, not applied twice.
        assert_eq!(apply(&mut host, "0", "t1", "new")["result"], *r);
        // A write based on an old version is refused.
        assert_eq!(apply(&mut host, "0", "t2", "late")["error"]["code"], "version_conflict");
        // The stored receipt can be read back.
        assert_eq!(call(&mut host, "receipt", json!({ "documentId": "d", "transactionId": "t1" }))["result"], *r);
        assert_eq!(call(&mut host, "receipt", json!({ "documentId": "d", "transactionId": "nope" }))["result"], Value::Null);

        let saved = &call(&mut host, "save", json!({ "documentId": "d" }))["result"];
        let bytes = base64::engine::general_purpose::STANDARD.decode(saved["bytesBase64"].as_str().unwrap()).unwrap();
        let reopened = Presentation::open(bytes).unwrap();
        assert_eq!(reopened.slide(1).unwrap().shapes[0].paragraphs.as_deref(), Some(&["new".to_string()][..]));
    }

    #[test]
    fn failed_batch_changes_nothing_and_unknown_operations_are_refused() {
        let mut host = Host::new(Resources::new(FontSet::empty()));
        call(&mut host, "open", json!({ "documentId": "d", "bytesBase64": base64::engine::general_purpose::STANDARD.encode(deck()) }));
        let bad = call(&mut host, "apply", json!({
            "documentId": "d", "expectedVersion": "0", "transactionId": "t",
            "commands": [
                { "operation": "replace_text", "targetId": "slide:1/shape:2", "parameters": { "paragraphs": ["x"] } },
                { "operation": "replace_text", "targetId": "slide:1/shape:99", "parameters": { "paragraphs": ["y"] } },
            ],
        }));
        assert_eq!(bad["error"]["code"], "target_not_found");
        assert_eq!(call(&mut host, "observe", json!({ "documentId": "d" }))["result"]["version"], "0");
        let unknown = call(&mut host, "apply", json!({
            "documentId": "d", "expectedVersion": "0", "transactionId": "u",
            "commands": [{ "operation": "delete_everything", "targetId": "slide:1/shape:2", "parameters": {} }],
        }));
        assert_eq!(unknown["error"]["code"], "unsupported_operation");
        assert_eq!(serde_json::from_str::<Value>(&host.invoke(r#"{"abiVersion":2}"#)).unwrap()["error"]["code"], "abi_version");
    }
}
