//! Compares our autofit recomputation with PowerPoint's on the rule fixtures.
//!   cargo run --release -p present-pptx --example autofit_check -- <rules-dir> <powerpoint-results.json>
//! rules-dir holds cases.json and rules-autofitcalc.pptx (make_fixtures.py);
//! the results JSON is read_autofit.py's output for PowerPoint's edited file.
use present_pptx::commands::{run_with, Command};
use present_pptx::render::{fonts::FontSet, Resources};
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = &args[1];
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/cases.json")).unwrap()).unwrap();
    let ppt: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let res = Resources::new(FontSet::local());
    let original = std::fs::read(format!("{dir}/rules-autofitcalc.pptx")).unwrap();
    let (mut same, mut total) = (0, 0);
    for c in cases.iter().filter(|c| c["deck"] == "autofitcalc") {
        let mut doc = present_pptx::Presentation::open(original.clone()).unwrap();
        let slide = c["slide"].as_u64().unwrap() as usize;
        let text = c["text"].as_str().unwrap().replace("\\v", "\u{b}");
        let r = run_with(&mut doc, &Command::ReplaceText { slide, shape_id: 2, paragraphs: vec![text] }, Some(&res)).unwrap();
        let p = ppt.iter().find(|p| p["case"] == c["name"]).unwrap();
        let fit = &r["autofit"];
        let (ours, theirs, ok) = if fit["kind"] == "shrinkTextOnOverflow" {
            let o = (fit["fontScale"].as_f64().unwrap() * 100.0, fit["lineSpacingReduction"].as_f64().unwrap() * 100.0);
            let t = (p["fontScale"].as_f64().unwrap(), p["lnSpcReduction"].as_f64().unwrap());
            (format!("{:.1}%/{:.0}%", o.0, o.1), format!("{:.1}%/{:.0}%", t.0, t.1), (o.0 - t.0).abs() < 0.01 && (o.1 - t.1).abs() < 0.01)
        } else {
            let o = fit["height"].as_f64().unwrap_or(0.0);
            let t = p["heightIn"].as_f64().unwrap() * 72.0;
            (format!("{o:.2}pt"), format!("{t:.2}pt"), (o - t).abs() <= 0.5)
        };
        total += 1;
        same += ok as usize;
        println!("{:28} ours {:>14} powerpoint {:>14} {}", c["name"].as_str().unwrap(), ours, theirs, if ok { "" } else { "DIFF" });
        if !ok && fit["kind"] == "shrinkTextOnOverflow" {
            // Our layout of the edited text at PowerPoint's scale and at ours.
            let edited = present_pptx::Presentation::open(doc.save().unwrap()).unwrap();
            let m = present_pptx::render::measure_shape_text(&edited, slide, 2, &res).unwrap().unwrap();
            let inner = m.height - m.body.insets[1] - m.body.insets[3];
            for s in [p["fontScale"].as_f64().unwrap() / 100.0, fit["fontScale"].as_f64().unwrap()] {
                let body = present_pptx::render::text::BodyProps { font_scale: s, line_reduction: 0.2, ..m.body.clone() };
                let l = present_pptx::render::text::layout(&m.paragraphs, &body, m.width, m.height, &res.fonts, &m.theme);
                println!("    scale {:.3}: {} lines, fit height {:.2} / inner {:.2}, widths {:?}", s, l.lines.len(), l.fit_height, inner, l.lines.iter().map(|x| (x.width * 10.0).round() / 10.0).collect::<Vec<_>>());
            }
        }
    }
    println!("{same}/{total} match (our edit of the original text)");

    // Same comparison on PowerPoint's own saved file: identical runs and
    // language tags, only the autofit computation differs.
    if let Some(edited_path) = args.get(3) {
        let edited = present_pptx::Presentation::open(std::fs::read(edited_path).unwrap()).unwrap();
        let (mut same, mut total) = (0, 0);
        for c in cases.iter().filter(|c| c["deck"] == "autofitcalc" && !c["name"].as_str().unwrap().starts_with("sp")) {
            let slide = c["slide"].as_u64().unwrap() as usize;
            let p = ppt.iter().find(|p| p["case"] == c["name"]).unwrap();
            let m = present_pptx::render::measure_shape_text(&edited, slide, 2, &res).unwrap().unwrap();
            let (s, r) = present_pptx::render::autofit::shrink(&m, &res.fonts);
            let ok = (s * 100.0 - p["fontScale"].as_f64().unwrap()).abs() < 0.01 && (r * 100.0 - p["lnSpcReduction"].as_f64().unwrap()).abs() < 0.01;
            total += 1;
            same += ok as usize;
            if !ok {
                println!("on PowerPoint's file: {:24} ours {:.1}%/{:.0}% powerpoint {}%/{}%", c["name"].as_str().unwrap(), s * 100.0, r * 100.0, p["fontScale"], p["lnSpcReduction"]);
            }
        }
        println!("{same}/{total} match (recomputed on PowerPoint's saved file)");
    }
}
