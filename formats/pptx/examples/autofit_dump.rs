//! Dumps, for each autofit case in PowerPoint's edited file, our layout at
//! every candidate setting: line count and line sizes. Used to find the fit
//! rule PowerPoint applies.
//!   cargo run --release -p present-pptx --example autofit_dump -- <cases.json> <edited.pptx>
use present_pptx::render::{fonts::FontSet, measure_shape_text, text, Resources};
use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let doc = present_pptx::Presentation::open(std::fs::read(&args[2]).unwrap()).unwrap();
    let res = Resources::new(FontSet::local());
    let mut out = Vec::new();
    for c in cases.iter().filter(|c| c["deck"] == "autofitcalc" && c["config"] != "sp-font" && !c["name"].as_str().unwrap().contains("-sp/")) {
        let slide = c["slide"].as_u64().unwrap() as usize;
        let m = measure_shape_text(&doc, slide, 2, &res).unwrap().unwrap();
        let mut settings = vec![(1.0, 0.0), (1.0, 0.1), (1.0, 0.2)];
        settings.extend((10..=39).rev().map(|k| (k as f64 * 0.025, 0.2)));
        let rows: Vec<Value> = settings
            .iter()
            .map(|&(s, r)| {
                let body = text::BodyProps { font_scale: s, line_reduction: r, ..m.body.clone() };
                let l = text::layout(&m.paragraphs, &body, m.width, m.height, &res.fonts, &m.theme);
                let raw = text::BodyProps { round_scaled_sizes: false, ..body.clone() };
                let u = text::layout(&m.paragraphs, &raw, m.width, m.height, &res.fonts, &m.theme);
                json!({ "scale": s, "reduction": r, "lines": l.lines.len(), "sizes": l.lines.iter().map(|x| x.size).collect::<Vec<_>>(),
                        "rawLines": u.lines.len(), "rawSizes": u.lines.iter().map(|x| x.size).collect::<Vec<_>>() })
            })
            .collect();
        out.push(json!({ "case": c["name"], "inner": m.height - m.body.insets[1] - m.body.insets[3], "settings": rows }));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
