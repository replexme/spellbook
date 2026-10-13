//! Lists a slide's drawing items with their bounds on the slide.
//!   cargo run --release -p present-pptx --example scene_dump -- <file.pptx> <slide>
use kurbo::Shape;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let res = present_pptx::render::Resources::new(present_pptx::render::fonts::FontSet::local());
    let doc = present_pptx::Presentation::open(std::fs::read(&args[1]).expect("read")).expect("open");
    let slide = present_pptx::render::render_slide(&doc, args[2].parse().expect("slide"), &res).expect("render");
    println!("background {:?}", slide.scene.background);
    let px = |scene: &present_render::Scene| {
        let r = present_render::rasterize(scene, res.fonts.db(), 1.0);
        let i = (40 * r.width as usize + 300) * 4;
        r.pixels[i..i + 3].to_vec()
    };
    println!("pixel (300,40) full scene: {:?}", px(&slide.scene));
    let mut no_radial = slide.scene.clone();
    for it in no_radial.items.iter_mut() {
        if let present_render::Item::Path { fill: Some(f @ present_render::Paint::Radial { .. }), .. } = it {
            *f = present_render::Paint::Solid(present_render::Rgba::BLACK);
        }
    }
    println!("pixel (300,40) radial as solid: {:?}", px(&no_radial));
    for (i, it) in slide.scene.items.iter().enumerate() {
        let b = match it {
            present_render::Item::Path { path, transform, .. } => (*transform * path.clone()).bounding_box(),
            present_render::Item::Image { dest, transform, .. } => transform.transform_rect_bbox(*dest),
            _ => continue,
        };
        if b.contains(kurbo::Point::new(300.0, 40.0)) {
            println!("covers (300,40): item {i} {:?}", b);
        }
    }
    let (mut lo, mut hi) = (2usize, slide.scene.items.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        let mut part = slide.scene.clone();
        part.items.truncate(mid);
        if px(&part) == vec![224, 224, 224] { lo = mid + 1 } else { hi = mid }
    }
    println!("first breaking item index: {} -> {:?}", lo - 1, slide.scene.items.get(lo - 1));
    for (i, it) in slide.scene.items.iter().enumerate().take(0) {
        let mut one = slide.scene.clone();
        one.items = vec![it.clone()];
        println!("item {i} alone -> pixel {:?}", px(&one));
        if let present_render::Item::Path { path, .. } = it {
            let els: Vec<_> = path.elements().iter().take(12).collect();
            println!("   elements {} first {:?}", path.elements().len(), els);
        }
    }
    for item in &slide.scene.items {
        match item {
            present_render::Item::Path { path, transform, fill, stroke } => {
                let b = (*transform * path.clone()).bounding_box();
                println!("path {:?} fill {:?} stroke {}", b, fill.as_ref().map(|f| format!("{f:?}").chars().take(60).collect::<String>()), stroke.is_some());
            }
            present_render::Item::Image { dest, transform, .. } => println!("image {:?}", transform.transform_rect_bbox(*dest)),
            present_render::Item::Glyphs { run, transform } => {
                let first = run.glyphs.first().map(|g| *transform * kurbo::Point::new(g.x, g.y));
                println!("glyphs {} size {} color {:?} at {:?}", run.glyphs.len(), run.size, run.color, first);
            }
            present_render::Item::Blurred { sigma, items } => println!("blurred sigma {sigma} items {}", items.len()),
            present_render::Item::Masked { mask, items } => println!("masked mask {} items {}", mask.len(), items.len()),
        }
    }
}
