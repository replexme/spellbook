//! Command-line access to the PPTX engine for local verification.
//!
//! present-pptx inspect <file.pptx>
//! present-pptx apply <in.pptx> <batch.json> <out.pptx>
//! present-pptx selftest <file.pptx> [out.pptx]
//! present-pptx render <file.pptx> <out-dir> [pixels-per-point]
//! present-pptx render-all <file.pptx> <out-dir> [width-px] [--fonts <dir>]…
//!   slide-1.png, slide-2.png, … each width-px wide (default 1280), one path per line on
//!   stdout. With --fonts only the fonts in those folders are used (the document view's
//!   fallback fonts, so previews match the view); otherwise the installed ones.
//!   `PRESENT_SIMD=scalar` draws without SIMD instructions.
//! present-pptx fonts <file.pptx> [--fonts <dir>]…
//!   For every font the deck names: whether the engine has it (installed, in --fonts or
//!   embedded in the deck) and, where text was drawn with a substitute, which one. JSON.

use std::process::ExitCode;

use present_engine::{Session, TxError};
use present_pptx::commands::{self, Command};
use present_pptx::{Error, Presentation};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    expected_version: u64,
    request_id: String,
    commands: Vec<Command>,
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

fn tx_error(e: TxError<Error>) -> Value {
    match e {
        TxError::StaleVersion { expected, actual } => json!({"kind": "staleVersion", "expected": expected, "actual": actual}),
        TxError::RequestIdReused { request_id } => json!({"kind": "requestIdReused", "requestId": request_id}),
        TxError::Command { index, error } => json!({"kind": "command", "index": index, "error": error}),
        TxError::EmptyBatch => json!({"kind": "emptyBatch"}),
    }
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("read {path}: {e}"))
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().collect();
    let mut font_dirs = Vec::new();
    while let Some(at) = args.iter().position(|a| a == "--fonts") {
        let Some(dir) = args.get(at + 1).cloned() else { return fail("--fonts needs a folder") };
        args.drain(at..at + 2);
        font_dirs.push(std::path::PathBuf::from(dir));
    }
    match args.get(1).map(String::as_str) {
        Some("fonts") if args.len() == 3 => fonts(&args[2], &font_dirs),
        Some("render-all") if args.len() == 4 || args.len() == 5 => render_all(&args[2], &args[3], args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1280.0), &font_dirs),
        Some("inspect") if args.len() == 3 => inspect(&args[2]),
        Some("describe") if args.len() == 3 => match read(&args[2]).and_then(|b| Presentation::open(b).map_err(|e| e.to_string())).and_then(|d| present_pptx::describe::describe(&d).map_err(|e| e.to_string())) {
            Ok(v) => {
                println!("{}", serde_json::to_string_pretty(&v).expect("serializable"));
                ExitCode::SUCCESS
            }
            Err(e) => fail(e),
        },
        Some("apply") if args.len() == 5 => apply(&args[2], &args[3], &args[4]),
        Some("blank") if args.len() == 3 => match std::fs::write(&args[2], present_pptx::blank::blank()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Some("selftest") if args.len() == 3 || args.len() == 4 => selftest(&args[2], args.get(3).map(String::as_str)),
        Some("render") if args.len() == 4 || args.len() == 5 => render(&args[2], &args[3], args.get(4).and_then(|s| s.parse().ok()).unwrap_or(2.0)),
        _ => fail("usage: present-pptx inspect <file> | blank <out> | apply <in> <batch.json> <out> | selftest <file> [out] | render <file> <out-dir> [scale] | render-all <file> <out-dir> [width-px] [--fonts <dir>] | fonts <file> [--fonts <dir>]"),
    }
}

fn inspect(path: &str) -> ExitCode {
    let result = read(path).and_then(|b| Presentation::open(b).map_err(|e| e.to_string())).and_then(|doc| {
        let slides = doc.slides().map_err(|e| e.to_string())?;
        // The main animation sequence of each slide, or the reason it
        // cannot be read.
        let animations: Vec<Value> = (1..=slides.len())
            .map(|n| match commands::animation::slide_animations(&doc, n) {
                Ok(list) => json!(list),
                Err(e) => json!({ "error": e.to_string() }),
            })
            .collect();
        // SmartArt nodes by slide and frame.
        let smartart: Vec<Value> = slides
            .iter()
            .enumerate()
            .map(|(k, s)| {
                let frames: Vec<Value> = s.shapes.iter().filter(|sh| sh.kind == "graphicFrame").filter_map(|sh| commands::smartart::smartart_nodes(&doc, k + 1, sh.id).ok().map(|n| json!({ "shapeId": sh.id, "nodes": n }))).collect();
                json!(frames)
            })
            .collect();
        Ok((slides, animations, smartart))
    });
    match result {
        Ok((slides, animations, smartart)) => {
            println!("{}", serde_json::to_string_pretty(&json!({"slides": slides, "animations": animations, "smartart": smartart})).expect("serializable"));
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

fn apply(input: &str, batch_path: &str, output: &str) -> ExitCode {
    let run = || -> Result<Value, String> {
        let original = read(input)?;
        let batch: Batch = serde_json::from_slice(&read(batch_path)?).map_err(|e| format!("batch: {e}"))?;
        let doc = Presentation::open(original.clone()).map_err(|e| e.to_string())?;
        let mut session = Session::new(doc);
        let fingerprint = sha256(serde_json::to_string(&batch.commands).expect("serializable").as_bytes());
        // Fonts installed here, so text edits also recompute autofit.
        let mut resources = present_pptx::render::Resources::new(present_pptx::render::fonts::FontSet::local());
        resources.open_document(session.document());
        let receipt = session
            .apply(batch.expected_version, &batch.request_id, &fingerprint, &batch.commands, |d, c| commands::run_with(d, c, Some(&resources)))
            .map_err(|e| tx_error(e).to_string())?;
        let saved = session.document().save().map_err(|e| e.to_string())?;
        std::fs::write(output, &saved).map_err(|e| format!("write {output}: {e}"))?;
        Ok(json!({
            "receipt": receipt,
            "modifiedParts": session.document().package().modified_parts(),
            "inputSha256": sha256(&original),
            "outputSha256": sha256(&saved),
        }))
    };
    match run() {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).expect("serializable"));
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

/// Round-trip check on a real file: no-op save, one text edit, reopen,
/// preservation of every untouched part, and rollback of a failing batch.
fn selftest(path: &str, out: Option<&str>) -> ExitCode {
    let run = || -> Result<Value, String> {
        let original = read(path)?;
        let doc = Presentation::open(original.clone()).map_err(|e| e.to_string())?;
        let noop = doc.save().map_err(|e| e.to_string())?;
        if noop != original {
            return Err("no-op save changed the file".into());
        }
        let slides = doc.slides().map_err(|e| e.to_string())?;
        let target = slides.iter().find_map(|s| {
            first_text_shape(&s.shapes).map(|(id, paras)| (s.index, s.part.clone(), id, paras))
        });
        let Some((slide, part, shape_id, mut paragraphs)) = target else {
            return Ok(json!({"file": path, "noopIdentical": true, "edit": "skipped: no text shape"}));
        };
        paragraphs[0] = format!("엔진 저장 검증 & <확인> {}", paragraphs[0]);
        let mut session = Session::new(doc.clone());
        let bad = vec![
            Command::ReplaceText { slide, shape_id, paragraphs: paragraphs.clone() },
            Command::ReplaceText { slide, shape_id: u32::MAX, paragraphs: vec!["x".into()] },
        ];
        let rejected = session.apply(0, "fail", "fail", &bad, commands::run).is_err();
        let rolled_back = session.document().save().map_err(|e| e.to_string())? == original;
        let good = vec![Command::ReplaceText { slide, shape_id, paragraphs: paragraphs.clone() }];
        let receipt = session.apply(0, "edit", "edit", &good, commands::run).map_err(|e| tx_error(e).to_string())?;
        let saved = session.document().save().map_err(|e| e.to_string())?;
        let reopened = Presentation::open(saved.clone()).map_err(|e| format!("reopen: {e}"))?;
        let after = reopened.slide(slide).map_err(|e| e.to_string())?;
        let text_ok = find_shape(&after.shapes, shape_id).and_then(|s| s.paragraphs.clone()) == Some(paragraphs);
        let mut changed_records = Vec::new();
        for name in doc.package().part_names() {
            if doc.package().original_record(name) != reopened.package().original_record(name) {
                changed_records.push(name.to_owned());
            }
        }
        let preserved = changed_records == vec![part.clone()];
        if let Some(out) = out {
            std::fs::write(out, &saved).map_err(|e| format!("write {out}: {e}"))?;
        }
        let ok = rejected && rolled_back && text_ok && preserved;
        Ok(json!({
            "file": path,
            "ok": ok,
            "noopIdentical": true,
            "failingBatchRejected": rejected,
            "failingBatchLeftFileUnchanged": rolled_back,
            "editedSlide": slide,
            "editedShape": shape_id,
            "reopenedTextMatches": text_ok,
            "changedRecords": changed_records,
            "untouchedPartsIdentical": preserved,
            "warnings": receipt.results[0]["warnings"],
            "outputSha256": sha256(&saved),
        }))
    };
    match run() {
        Ok(v) => {
            println!("{}", serde_json::to_string(&v).expect("serializable"));
            if v.get("ok") == Some(&Value::Bool(false)) { ExitCode::FAILURE } else { ExitCode::SUCCESS }
        }
        Err(e) => fail(json!({"file": path, "ok": false, "error": e})),
    }
}

fn first_text_shape(shapes: &[present_pptx::ShapeInfo]) -> Option<(u32, Vec<String>)> {
    shapes.iter().find_map(|s| match &s.paragraphs {
        Some(p) if s.kind == "sp" && p.iter().any(|t| !t.trim().is_empty()) && !p[0].contains('\u{b}') => Some((s.id, p.clone())),
        _ => first_text_shape(&s.children),
    })
}

fn find_shape(shapes: &[present_pptx::ShapeInfo], id: u32) -> Option<&present_pptx::ShapeInfo> {
    shapes.iter().find_map(|s| if s.id == id { Some(s) } else { find_shape(&s.children, id) })
}

/// Draws every slide to `<out-dir>/slide-N.png` and writes `layout.json`
/// with each text box's lines, the fonts used and what was not drawn.
fn fonts(path: &str, font_dirs: &[std::path::PathBuf]) -> ExitCode {
    use present_pptx::render::fonts::{FontSet, Fidelity};
    let run = || -> Result<Value, String> {
        let doc = Presentation::open(read(path)?).map_err(|e| e.to_string())?;
        let set = if font_dirs.is_empty() { FontSet::local() } else { FontSet::from_dirs(font_dirs) };
        let mut resources = present_pptx::render::Resources::new(set);
        resources.open_document(&doc);
        // The substitute each named font was drawn with, as the slides lay out.
        let mut used = std::collections::BTreeMap::<String, String>::new();
        for i in 1..=doc.slide_count() {
            let slide = present_pptx::render::render_slide(&doc, i, &resources).map_err(|e| format!("slide {i}: {e}"))?;
            for f in slide.texts.iter().flat_map(|t| t.fonts.iter()) {
                if matches!(f.fidelity, Fidelity::Substituted) {
                    used.entry(f.requested.clone()).or_insert_with(|| f.used.clone());
                }
            }
        }
        let described = present_pptx::describe::describe(&doc).map_err(|e| e.to_string())?;
        let names: Vec<String> = described["fonts"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
        let families: serde_json::Map<String, Value> = names
            .into_iter()
            .map(|name| {
                let available = resources.fonts.family_face(&name, false, false).is_some();
                let substitute = if available { None } else { used.get(&name).cloned() };
                (name, json!({ "available": available, "substitute": substitute }))
            })
            .collect();
        Ok(json!({ "families": families }))
    };
    match run() {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

fn render_all(path: &str, out_dir: &str, width: f64, font_dirs: &[std::path::PathBuf]) -> ExitCode {
    present_render::set_scalar(std::env::var("PRESENT_SIMD").is_ok_and(|v| v == "scalar"));
    let run = || -> Result<Vec<String>, String> {
        let doc = Presentation::open(read(path)?).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
        let fonts = if font_dirs.is_empty() { present_pptx::render::fonts::FontSet::local() } else { present_pptx::render::fonts::FontSet::from_dirs(font_dirs) };
        let mut resources = present_pptx::render::Resources::new(fonts);
        resources.open_document(&doc);
        let mut paths = Vec::new();
        for i in 1..=doc.slide_count() {
            let rendered = present_pptx::render::render_slide(&doc, i, &resources).map_err(|e| format!("slide {i}: {e}"))?;
            let scale = width / rendered.scene.width.max(1.0);
            let out = format!("{out_dir}/slide-{i}.png");
            std::fs::write(&out, present_render::rasterize(&rendered.scene, resources.fonts.db(), scale).to_png()).map_err(|e| e.to_string())?;
            paths.push(out);
        }
        Ok(paths)
    };
    match run() {
        Ok(paths) => {
            for p in paths {
                println!("{p}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

fn render(path: &str, out_dir: &str, scale: f64) -> ExitCode {
    let run = || -> Result<Value, String> {
        let doc = Presentation::open(read(path)?).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        let mut fonts = present_pptx::render::Resources::new(present_pptx::render::fonts::FontSet::local());
        fonts.open_document(&doc);
        let font_index_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut slides = Vec::new();
        for i in 1..=doc.slide_count() {
            let t0 = std::time::Instant::now();
            let rendered = present_pptx::render::render_slide(&doc, i, &fonts).map_err(|e| format!("slide {i}: {e}"))?;
            let layout_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let raster = present_render::rasterize(&rendered.scene, fonts.fonts.db(), scale);
            let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
            std::fs::write(format!("{out_dir}/slide-{i}.png"), raster.to_png()).map_err(|e| e.to_string())?;
            let count = |f: fn(&present_render::Item) -> bool| rendered.scene.items.iter().filter(|it| f(it)).count();
            let items = json!({
                "paths": count(|it| matches!(it, present_render::Item::Path { .. })),
                "images": count(|it| matches!(it, present_render::Item::Image { .. })),
                "glyphRuns": count(|it| matches!(it, present_render::Item::Glyphs { .. })),
            });
            slides.push(json!({
                "slide": i,
                "items": items,
                "layoutMs": layout_ms,
                "layoutAndRasterMs": total_ms,
                "texts": rendered.texts,
                "diagnostics": rendered.diagnostics,
                "provisional": rendered.provisional,
            }));
        }
        let v = json!({"file": path, "scale": scale, "fontIndexMs": font_index_ms, "slides": slides});
        std::fs::write(format!("{out_dir}/layout.json"), serde_json::to_string_pretty(&v).expect("serializable")).map_err(|e| e.to_string())?;
        Ok(json!({"slides": doc.slide_count(), "out": out_dir, "fontIndexMs": font_index_ms}))
    };
    match run() {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}
