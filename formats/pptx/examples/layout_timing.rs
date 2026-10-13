//! Times slide layout twice per slide in one process, to separate first-use
//! costs (font files, preset definitions) from steady-state layout.
//!   cargo run --release -p present-pptx --example layout_timing -- <file.pptx>
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("pptx path");
    let fonts = present_pptx::render::Resources::new(present_pptx::render::fonts::FontSet::local());
    let doc = present_pptx::Presentation::open(std::fs::read(path).expect("read")).expect("open");
    let (mut first, mut warm) = (Vec::new(), Vec::new());
    for i in 1..=doc.slide_count() {
        let t = Instant::now();
        present_pptx::render::render_slide(&doc, i, &fonts).expect("render");
        first.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        present_pptx::render::render_slide(&doc, i, &fonts).expect("render");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if ms > 20.0 {
            let r = present_pptx::render::render_slide(&doc, i, &fonts).expect("render");
            let cells = r.texts.iter().filter(|x| x.name.starts_with("table cell")).count();
            let chars: usize = r.texts.iter().flat_map(|x| x.lines.iter()).map(|l| l.text.chars().count()).sum();
            eprintln!("slow slide {i}: {ms:.1} ms, {} text boxes ({cells} table cells), {chars} chars, {} items", r.texts.len(), r.scene.items.len());
        }
        warm.push(ms);
    }
    let stats = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        (v[v.len() / 2], v[(v.len() * 95 / 100).min(v.len() - 1)], v[v.len() - 1])
    };
    println!("first p50/p95/max {:?}", stats(&mut first));
    println!("warm  p50/p95/max {:?}", stats(&mut warm));
}
