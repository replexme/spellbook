//! Native half of the native/WASM parity check: renders every slide of a
//! PPTX with exactly the given font files.
//!
//!   cargo run --release -p present-engine-wasm --example parity -- <out-dir> <file.pptx> <font>...

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (out, pptx, fonts) = (&args[1], &args[2], &args[3..]);
    let mut set = present_pptx::render::fonts::FontSet::empty();
    for f in fonts {
        set.add_bytes(std::fs::read(f).expect("font"));
    }
    let mut set = present_pptx::render::Resources::new(set);
    let doc = present_pptx::Presentation::open(std::fs::read(pptx).expect("pptx")).expect("open");
    // The document's embedded fonts, as the browser engine's open() loads them.
    set.open_document(&doc);
    std::fs::create_dir_all(out).expect("out dir");
    for i in 1..=doc.slide_count() {
        let (png, layout) = present_engine_wasm::render_png(&doc, &set, i, 1.0).expect("render");
        std::fs::write(format!("{out}/slide-{i}.png"), png).expect("png");
        std::fs::write(format!("{out}/slide-{i}.json"), layout).expect("json");
    }
}
