//! DrawingML colours: scheme lookup through the colour map and the colour
//! transforms PowerPoint applies (lumMod/lumOff/tint/shade/alpha/satMod).

use std::collections::HashMap;

use present_render::Rgba;

use crate::xml::{Tree, NS_A};

/// Theme colours by scheme name (`dk1`, `accent1`, ...) and the slide's
/// colour map (`bg1` -> `lt1`, `tx1` -> `dk1`, ...).
#[derive(Debug, Clone, Default)]
pub struct ColorContext {
    pub scheme: HashMap<String, Rgba>,
    pub map: HashMap<String, String>,
}

impl ColorContext {
    fn scheme_color(&self, name: &str) -> Option<Rgba> {
        let mapped = self.map.get(name).map(String::as_str).unwrap_or(name);
        self.scheme.get(mapped).copied()
    }
}

fn hex(v: &str) -> Option<Rgba> {
    if v.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(v, 16).ok()?;
    Some(Rgba { r: (n >> 16) as u8, g: (n >> 8) as u8, b: n as u8, a: 255 })
}

fn preset(name: &str) -> Option<Rgba> {
    let v = match name {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "gray" | "grey" => "808080",
        "darkGray" => "A9A9A9",
        "lightGray" => "D3D3D3",
        "orange" => "FFA500",
        _ => return None,
    };
    hex(v)
}

/// Reads the colour element `node` (`a:srgbClr`, `a:schemeClr`, ...).
/// `ph` is the colour substituted for `phClr` (style references).
pub fn read(tree: &Tree, node: usize, ctx: &ColorContext, ph: Option<Rgba>) -> Option<Rgba> {
    let n = tree.node(node);
    if n.ns.as_deref() != Some(NS_A) {
        return None;
    }
    let base = match n.local.as_str() {
        "srgbClr" => hex(n.attr("val")?),
        "sysClr" => n.attr("lastClr").and_then(hex).or_else(|| match n.attr("val") {
            Some("window") => Some(Rgba::WHITE),
            Some("windowText") => Some(Rgba::BLACK),
            _ => None,
        }),
        "schemeClr" => match n.attr("val")? {
            "phClr" => ph,
            name => ctx.scheme_color(name),
        },
        "prstClr" => preset(n.attr("val")?),
        "scrgbClr" => {
            let c = |k: &str| n.attr(k).and_then(|v| v.parse::<f64>().ok()).map(|v| linear_to_srgb(v / 100_000.0));
            Some(Rgba { r: c("r")?, g: c("g")?, b: c("b")?, a: 255 })
        }
        "hslClr" => {
            let h = n.attr("hue")?.parse::<f64>().ok()? / 60_000.0 / 360.0;
            let s = n.attr("sat")?.parse::<f64>().ok()? / 100_000.0;
            let l = n.attr("lum")?.parse::<f64>().ok()? / 100_000.0;
            let (r, g, b) = hsl_to_rgb(h, s, l);
            Some(Rgba { r: to_u8(r), g: to_u8(g), b: to_u8(b), a: 255 })
        }
        _ => None,
    }?;
    Some(apply_transforms(tree, node, base))
}

/// The first colour child of `parent` (e.g. the colour inside `a:solidFill`).
pub fn read_child(tree: &Tree, parent: usize, ctx: &ColorContext, ph: Option<Rgba>) -> Option<Rgba> {
    tree.node(parent).children.iter().find_map(|&c| read(tree, c, ctx, ph))
}

fn to_u8(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn linear_to_srgb(v: f64) -> u8 {
    let v = v.clamp(0.0, 1.0);
    to_u8(if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 })
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.040_45 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-12 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s <= 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0))
}

/// Applies child transforms in document order.
fn apply_transforms(tree: &Tree, node: usize, base: Rgba) -> Rgba {
    let (mut r, mut g, mut b) = (base.r as f64 / 255.0, base.g as f64 / 255.0, base.b as f64 / 255.0);
    let mut a = base.a as f64 / 255.0;
    for &c in &tree.node(node).children {
        let t = tree.node(c);
        let Some(v) = t.attr("val").and_then(|v| v.parse::<f64>().ok()).map(|v| v / 100_000.0) else { continue };
        match t.local.as_str() {
            "alpha" => a = v,
            "alphaMod" => a *= v,
            "lumMod" | "lumOff" | "satMod" | "satOff" | "hueOff" | "hueMod" => {
                let (mut h, mut s, mut l) = rgb_to_hsl(r, g, b);
                match t.local.as_str() {
                    "lumMod" => l *= v,
                    "lumOff" => l += v,
                    "satMod" => s *= v,
                    "satOff" => s += v,
                    "hueOff" => h = (h + v * 100_000.0 / 60_000.0 / 360.0).rem_euclid(1.0),
                    _ => h = (h * v).rem_euclid(1.0),
                }
                (r, g, b) = hsl_to_rgb(h, s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
            }
            // Tint and shade work in linear light, as Office does.
            "tint" => {
                let f = |c: f64| {
                    let lin = srgb_to_linear(c);
                    let lin = lin * v + (1.0 - v);
                    linear_to_srgb(lin) as f64 / 255.0
                };
                (r, g, b) = (f(r), f(g), f(b));
            }
            "shade" => {
                let f = |c: f64| linear_to_srgb(srgb_to_linear(c) * v) as f64 / 255.0;
                (r, g, b) = (f(r), f(g), f(b));
            }
            _ => {}
        }
    }
    Rgba { r: to_u8(r), g: to_u8(g), b: to_u8(b), a: to_u8(a) }
}

/// Reads `a:clrScheme` children into scheme colours.
pub fn read_scheme(tree: &Tree, scheme: usize) -> HashMap<String, Rgba> {
    let empty = ColorContext::default();
    tree.node(scheme)
        .children
        .iter()
        .filter_map(|&c| {
            let name = tree.node(c).local.clone();
            read_child(tree, c, &empty, None).map(|col| (name, col))
        })
        .collect()
}

/// Reads a `p:clrMap` / `a:overrideClrMapping` element.
pub fn read_map(tree: &Tree, map: usize) -> HashMap<String, String> {
    tree.node(map).attrs.iter().filter(|a| a.ns.is_none()).map(|a| (a.local.clone(), a.value.clone())).collect()
}

/// Whether `tree` node is DrawingML namespace colour container we understand.
pub fn is_a(tree: &Tree, node: usize, local: &str) -> bool {
    tree.node(node).is(NS_A, local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color(xml: &str) -> Rgba {
        let src = format!(r#"<a:solidFill xmlns:a="{NS_A}">{xml}</a:solidFill>"#);
        let tree = Tree::parse(src.as_bytes()).unwrap();
        let mut ctx = ColorContext::default();
        ctx.scheme.insert("accent1".into(), Rgba { r: 0x44, g: 0x72, b: 0xC4, a: 255 });
        ctx.scheme.insert("lt1".into(), Rgba::WHITE);
        ctx.map.insert("bg1".into(), "lt1".into());
        read_child(&tree, tree.root, &ctx, None).unwrap()
    }

    #[test]
    fn scheme_colors_go_through_the_map() {
        assert_eq!(color(r#"<a:schemeClr val="bg1"/>"#), Rgba::WHITE);
    }

    #[test]
    fn lum_mod_darkens_like_office() {
        // PowerPoint's "Accent 1, darker 25%" of 4472C4 is 2F5597.
        let c = color(r#"<a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr>"#);
        assert!((c.r as i32 - 0x2F).abs() <= 1 && (c.g as i32 - 0x55).abs() <= 1 && (c.b as i32 - 0x97).abs() <= 1, "{c:?}");
        // "lighter 40%" (lumMod 60%, lumOff 40%) is 8FAADC; "lighter 60%" is B4C7E7.
        let c = color(r#"<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>"#);
        assert!((c.r as i32 - 0x8F).abs() <= 1 && (c.g as i32 - 0xAA).abs() <= 1 && (c.b as i32 - 0xDC).abs() <= 1, "{c:?}");
        let c = color(r#"<a:schemeClr val="accent1"><a:lumMod val="40000"/><a:lumOff val="60000"/></a:schemeClr>"#);
        assert!((c.r as i32 - 0xB4).abs() <= 1 && (c.g as i32 - 0xC7).abs() <= 1 && (c.b as i32 - 0xE7).abs() <= 1, "{c:?}");
    }

    #[test]
    fn alpha_is_kept() {
        assert_eq!(color(r#"<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>"#).a, 128);
    }
}

fn to_linear(c: u8) -> f32 {
    let v = c as f32 / 255.0;
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn from_linear(v: f32) -> u8 {
    let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Gradient stops in position order with stops added in between, so a
/// renderer that blends in sRGB follows PowerPoint, which blends gradient
/// colours in linear light (measured: red to blue passes (186, 44, 189), not
/// (128, 0, 128); conformance/results/2026-10-11-edit-commands-2.md).
pub fn linear_light_stops(mut stops: Vec<(f32, Rgba)>) -> Vec<(f32, Rgba)> {
    const STEPS: usize = 8;
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = Vec::with_capacity(stops.len() * STEPS);
    for w in stops.windows(2) {
        let ((p0, c0), (p1, c1)) = (w[0], w[1]);
        for k in 0..STEPS {
            let f = k as f32 / STEPS as f32;
            let mix = |a: u8, b: u8| from_linear(to_linear(a) + (to_linear(b) - to_linear(a)) * f);
            let alpha = (c0.a as f32 + (c1.a as f32 - c0.a as f32) * f).round() as u8;
            out.push((p0 + (p1 - p0) * f, Rgba { r: mix(c0.r, c1.r), g: mix(c0.g, c1.g), b: mix(c0.b, c1.b), a: alpha }));
        }
    }
    out.extend(stops.last().copied());
    out
}
