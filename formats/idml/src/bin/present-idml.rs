//! present-idml describe <file.idml>
//! present-idml render <file.idml> <page> <out.png> [scale]
//! present-idml apply <file.idml> <out.idml> <commands.json>   (a command or an array of them)
//! present-idml roundtrip <file.idml>                          (opens and saves; exits 1 if the bytes differ)
//! present-idml graph <file.idml>                              (the Spellbook element graph, JSON)
//! present-idml render-all <file.idml> <out-dir> [width-px]    (page-1.png, page-2.png, … each width-px wide
//!                                                              (default 1280); prints their paths)
//! present-idml blank <out.idml> [preset] [pages]              (a new empty document, default A4, 1 page)
//! present-idml scan <file.idml>                               (safety scan, JSON; exits 1 if unsafe)
//! present-idml validate <baseline.idml> <saved.idml>          (what the save changed, JSON)
//!
//! `PRESENT_SIMD=scalar` makes render-all rasterize without SIMD instructions.
//! `--fonts <dir>` (any position, repeatable) adds the font files in a folder, for example
//! InDesign's own `Resources/Required/fonts`, ahead of the installed ones.

use present_idml::Idml;

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    while let Some(at) = args.iter().position(|a| a == "--fonts") {
        let dir = args.get(at + 1).ok_or("--fonts needs a folder")?.clone();
        args.drain(at..at + 2);
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "otf" | "ttf" | "ttc" | "otc")) {
                designcraft_fonts::FontDb::global().add_font(std::fs::read(&path)?);
            }
        }
    }
    let usage = "usage: present-idml describe|render|render-all|apply|roundtrip|graph|scan|validate <file.idml> …";
    let (cmd, file) = (args.first().ok_or(usage)?, args.get(1).ok_or(usage)?);
    if cmd == "blank" {
        // present-idml blank <out.idml> [preset] [pages]
        let pages: usize = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(1);
        std::fs::write(file, present_idml::blank(args.get(2).map_or("A4", String::as_str), pages)?)?;
        return Ok(());
    }
    let bytes = std::fs::read(file)?;
    // These two check the files before (or instead of) opening them.
    match cmd.as_str() {
        "scan" => {
            println!("{}", present_idml::check::scan(&bytes)?);
            return Ok(());
        }
        "validate" => {
            let saved = std::fs::read(args.get(2).ok_or(usage)?)?;
            println!("{}", present_idml::check::change_report(&bytes, &saved));
            return Ok(());
        }
        _ => {}
    }
    let mut doc = Idml::open(bytes.clone())?;
    match cmd.as_str() {
        "describe" => println!("{}", serde_json::to_string_pretty(&doc.describe())?),
        "render" => {
            let page: usize = args.get(2).ok_or(usage)?.parse()?;
            let scale: f64 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(2.0);
            std::fs::write(args.get(3).ok_or(usage)?, doc.render_page(page, scale)?)?;
        }
        "apply" => {
            let commands: serde_json::Value = serde_json::from_slice(&std::fs::read(args.get(3).ok_or(usage)?)?)?;
            let list = match commands {
                serde_json::Value::Array(v) => v,
                one => vec![one],
            };
            for c in &list {
                println!("{}", doc.apply(c)?);
            }
            std::fs::write(args.get(2).ok_or(usage)?, doc.save()?)?;
        }
        "graph" => println!("{}", serde_json::to_string(&doc.element_graph(&bytes)?)?),
        "render-all" => {
            // PRESENT_SIMD=scalar draws without SIMD instructions.
            let scalar = std::env::var("PRESENT_SIMD").is_ok_and(|v| v == "scalar");
            let dir = std::path::PathBuf::from(args.get(2).ok_or(usage)?);
            let width: f64 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(1280.0);
            std::fs::create_dir_all(&dir)?;
            for page in 0..doc.page_count() {
                let path = dir.join(format!("page-{}.png", page + 1));
                let (w, _) = doc.page_size(page).ok_or("page size")?;
                std::fs::write(&path, doc.render_page_with(page, width / w.max(1.0), scalar)?)?;
                println!("{}", path.display());
            }
        }
        "roundtrip" => {
            if doc.save()? != bytes {
                return Err("saved bytes differ".into());
            }
            println!("identical ({} bytes)", bytes.len());
        }
        _ => return Err(usage.into()),
    }
    Ok(())
}
