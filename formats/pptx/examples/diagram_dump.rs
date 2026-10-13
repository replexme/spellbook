//! Prints the SmartArt layout tree of a slide: cargo run --example diagram_dump -- <file.pptx> <slide>
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pres = present_pptx::Presentation::open(std::fs::read(&args[1]).expect("read")).expect("open");
    print!("{}", present_pptx::render::diagram::dump(&pres, args[2].parse().expect("slide")));
}
