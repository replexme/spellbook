//! Decodes an embedded font (EOT, MTX compressed or not) to a TrueType file:
//! `eot_decode <in.fntdata> <out.ttf>`.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = &args[..] else {
        eprintln!("usage: eot_decode <in.fntdata> <out.ttf>");
        std::process::exit(2);
    };
    let eot = std::fs::read(input).expect("read input");
    match present_pptx::render::eot::decode(&eot) {
        Ok(ttf) => std::fs::write(output, ttf).expect("write output"),
        Err(e) => {
            eprintln!("{input}: {e}");
            std::process::exit(1);
        }
    }
}
