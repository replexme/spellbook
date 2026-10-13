//! PPTX adapter. The opened package is the source of truth: parts are kept as
//! original bytes and edits replace only the bytes of the edited elements.

pub mod blank;
pub mod commands;
pub mod describe;
/// The byte-preserving ZIP package (shared with IDML).
pub mod package {
    pub use present_package::*;
}
pub mod render;
/// The span-keeping XML tree (shared with IDML) and the OOXML namespaces.
pub mod xml {
    pub use present_package::xml::*;

    pub const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
    pub const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
    pub const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    pub const NS_PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
}

use std::sync::Arc;

use serde::Serialize;

use package::Package;
use xml::{Tree, NS_A, NS_P, NS_PKG_REL, NS_R};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum Error {
    Package(String),
    Unsupported(String),
    MissingPart(String),
    Xml(String),
    NotFound(String),
    InvalidCommand(String),
    /// An edit touched bytes outside the target element.
    ScopeViolation(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Error {}

impl From<present_package::Error> for Error {
    fn from(e: present_package::Error) -> Self {
        match e {
            present_package::Error::Package(m) => Error::Package(m),
            present_package::Error::Unsupported(m) => Error::Unsupported(m),
            present_package::Error::MissingPart(m) => Error::MissingPart(m),
            present_package::Error::Xml(m) => Error::Xml(m),
        }
    }
}

const REL_OFFICE_DOCUMENT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_OFFICE_DOCUMENT_STRICT: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub rel_type: String,
    /// Resolved part name for internal targets, raw target for external ones.
    pub target: String,
    pub external: bool,
}

/// `ppt/slides/slide1.xml` -> `ppt/slides/_rels/slide1.xml.rels`.
pub fn rels_part_for(part: &str) -> String {
    match part.rfind('/') {
        Some(i) => format!("{}/_rels/{}.rels", &part[..i], &part[i + 1..]),
        None => format!("_rels/{part}.rels"),
    }
}

/// Resolves a relationship target relative to the source part's folder.
pub fn resolve_target(source_part: &str, target: &str) -> String {
    let mut segments: Vec<&str> = if let Some(abs) = target.strip_prefix('/') {
        return normalize(abs.split('/').collect());
    } else {
        match source_part.rfind('/') {
            Some(i) => source_part[..i].split('/').collect(),
            None => Vec::new(),
        }
    };
    segments.extend(target.split('/'));
    normalize(segments)
}

fn normalize(segments: Vec<&str>) -> String {
    let mut out: Vec<&str> = Vec::new();
    for s in segments {
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeInfo {
    /// `cNvPr id`, unique within the slide.
    pub id: u32,
    pub name: String,
    /// Element kind: `sp`, `pic`, `cxnSp`, `graphicFrame`, `grpSp`.
    pub kind: String,
    /// Paragraph texts when the shape has a text body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraphs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ShapeInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideInfo {
    /// 1-based position in the presentation.
    pub index: usize,
    pub part: String,
    pub shapes: Vec<ShapeInfo>,
}

/// An open presentation. Cloning is cheap (parts are shared).
#[derive(Debug, Clone)]
pub struct Presentation {
    package: Package,
    presentation_part: String,
    slide_parts: Arc<Vec<String>>,
}

impl Presentation {
    pub fn open(bytes: Vec<u8>) -> Result<Self, Error> {
        let package = Package::open(bytes)?;
        let root_rels = read_relationships(&package, "_rels/.rels", "")?;
        let presentation_part = root_rels
            .iter()
            .find(|r| r.rel_type == REL_OFFICE_DOCUMENT && !r.external)
            .map(|r| r.target.clone())
            .ok_or_else(|| {
                if root_rels.iter().any(|r| r.rel_type == REL_OFFICE_DOCUMENT_STRICT) {
                    Error::Unsupported("Strict Open XML presentations".into())
                } else {
                    Error::NotFound("presentation part".into())
                }
            })?;
        let slide_parts = slide_list(&package, &presentation_part)?;
        Ok(Self { package, presentation_part, slide_parts: Arc::new(slide_parts) })
    }

    /// Re-reads the slide order after the presentation part changed.
    pub(crate) fn reload_slides(&mut self) -> Result<(), Error> {
        self.slide_parts = Arc::new(slide_list(&self.package, &self.presentation_part)?);
        Ok(())
    }

    pub fn package(&self) -> &Package {
        &self.package
    }

    pub(crate) fn package_mut(&mut self) -> &mut Package {
        &mut self.package
    }

    pub fn presentation_part(&self) -> &str {
        &self.presentation_part
    }

    pub fn slide_count(&self) -> usize {
        self.slide_parts.len()
    }

    /// Part name of a 1-based slide index.
    pub fn slide_part(&self, index: usize) -> Result<&str, Error> {
        index
            .checked_sub(1)
            .and_then(|i| self.slide_parts.get(i))
            .map(|s| s.as_str())
            .ok_or_else(|| Error::NotFound(format!("slide {index} (presentation has {})", self.slide_parts.len())))
    }

    pub fn save(&self) -> Result<Vec<u8>, Error> {
        self.package.save().map_err(Error::from)
    }

    pub fn slides(&self) -> Result<Vec<SlideInfo>, Error> {
        (1..=self.slide_count()).map(|i| self.slide(i)).collect()
    }

    pub fn slide(&self, index: usize) -> Result<SlideInfo, Error> {
        let part = self.slide_part(index)?.to_owned();
        let src = self.package.read(&part)?;
        let tree = Tree::parse(&src)?;
        let sp_tree = tree
            .path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")])
            .ok_or_else(|| Error::NotFound(format!("shape tree in {part}")))?;
        let shapes = shapes_in(&tree, &src, sp_tree)?;
        Ok(SlideInfo { index, part, shapes })
    }
}

const SHAPE_KINDS: [&str; 5] = ["sp", "pic", "cxnSp", "graphicFrame", "grpSp"];

/// Slide part names in presentation order (`p:sldIdLst`).
fn slide_list(package: &Package, presentation_part: &str) -> Result<Vec<String>, Error> {
    let pres_rels = read_relationships(package, &rels_part_for(presentation_part), presentation_part)?;
    let src = package.read(presentation_part)?;
    let tree = Tree::parse(&src)?;
    let mut slide_parts = Vec::new();
    if let Some(list) = tree.child(tree.root, NS_P, "sldIdLst") {
        for id in tree.children_named(list, NS_P, "sldId") {
            let rid = tree.node(id).attr_ns(NS_R, "id").ok_or_else(|| Error::Xml("sldId without r:id".into()))?;
            let rel = pres_rels.iter().find(|r| r.id == rid).ok_or_else(|| Error::NotFound(format!("slide relationship {rid}")))?;
            slide_parts.push(rel.target.clone());
        }
    }
    Ok(slide_parts)
}

/// Non-visual properties element of a shape (`p:nvSpPr`, `p:nvPicPr`, ...).
pub(crate) fn non_visual(tree: &Tree, shape: usize) -> Option<usize> {
    let local = match tree.node(shape).local.as_str() {
        "sp" => "nvSpPr",
        "pic" => "nvPicPr",
        "cxnSp" => "nvCxnSpPr",
        "graphicFrame" => "nvGraphicFramePr",
        "grpSp" => "nvGrpSpPr",
        _ => return None,
    };
    tree.path(shape, &[(NS_P, local), (NS_P, "cNvPr")])
}

pub(crate) fn shape_id(tree: &Tree, shape: usize) -> Option<u32> {
    non_visual(tree, shape).and_then(|n| tree.node(n).attr("id")).and_then(|v| v.parse().ok())
}

fn shapes_in(tree: &Tree, src: &[u8], parent: usize) -> Result<Vec<ShapeInfo>, Error> {
    let mut out = Vec::new();
    for &child in &tree.node(parent).children {
        let node = tree.node(child);
        if node.ns.as_deref() != Some(NS_P) || !SHAPE_KINDS.contains(&node.local.as_str()) {
            continue;
        }
        let cnv = non_visual(tree, child);
        let id = cnv.and_then(|n| tree.node(n).attr("id")).and_then(|v| v.parse().ok()).unwrap_or(0);
        let name = cnv.and_then(|n| tree.node(n).attr("name")).unwrap_or("").to_owned();
        let paragraphs = match tree.child(child, NS_P, "txBody") {
            Some(body) => Some(paragraph_texts(tree, src, body)?),
            None => None,
        };
        let children = if node.local == "grpSp" { shapes_in(tree, src, child)? } else { Vec::new() };
        out.push(ShapeInfo { id, name, kind: node.local.clone(), paragraphs, children });
    }
    Ok(out)
}

/// Visible text of each `a:p` in a text body. Line breaks become `\u{b}`.
pub(crate) fn paragraph_texts(tree: &Tree, src: &[u8], body: usize) -> Result<Vec<String>, Error> {
    tree.children_named(body, NS_A, "p")
        .map(|p| {
            let mut text = String::new();
            for &c in &tree.node(p).children {
                let n = tree.node(c);
                if n.is(NS_A, "r") || n.is(NS_A, "fld") {
                    if let Some(t) = tree.child(c, NS_A, "t") {
                        text.push_str(&tree.text(src, t)?);
                    }
                } else if n.is(NS_A, "br") {
                    text.push('\u{b}');
                }
            }
            Ok(text)
        })
        .collect()
}

pub fn read_relationships(package: &Package, rels_part: &str, source_part: &str) -> Result<Vec<Relationship>, Error> {
    if !package.contains(rels_part) {
        return Ok(Vec::new());
    }
    let src = package.read(rels_part)?;
    let tree = Tree::parse(&src)?;
    Ok(tree
        .children_named(tree.root, NS_PKG_REL, "Relationship")
        .map(|i| {
            let n = tree.node(i);
            let target = n.attr("Target").unwrap_or("").to_owned();
            let external = n.attr("TargetMode") == Some("External");
            Relationship {
                id: n.attr("Id").unwrap_or("").to_owned(),
                rel_type: n.attr("Type").unwrap_or("").to_owned(),
                target: if external { target } else { resolve_target(source_part, &target) },
                external,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_targets() {
        assert_eq!(resolve_target("ppt/presentation.xml", "slides/slide1.xml"), "ppt/slides/slide1.xml");
        assert_eq!(resolve_target("ppt/slides/slide1.xml", "../media/image1.png"), "ppt/media/image1.png");
        assert_eq!(resolve_target("", "ppt/presentation.xml"), "ppt/presentation.xml");
        assert_eq!(resolve_target("ppt/slides/slide1.xml", "/ppt/media/a.png"), "ppt/media/a.png");
        assert_eq!(rels_part_for("ppt/slides/slide1.xml"), "ppt/slides/_rels/slide1.xml.rels");
    }
}
