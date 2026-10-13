//! Prints which face the font set picks for a family name.
//!   cargo run --release -p present-pptx --example font_probe -- "<family>" [bold] [italic]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fonts = present_pptx::render::fonts::FontSet::local();
    let (bold, italic) = (args.iter().any(|a| a == "bold"), args.iter().any(|a| a == "italic"));
    match fonts.family_face(&args[1], bold, italic) {
        Some((f, fid)) => println!("{} / {} weight {} italic {} -> {:?}", f.family, f.style, f.weight, f.italic, fid),
        None => println!("not found"),
    }
}
