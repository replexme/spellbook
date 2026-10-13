//! InDesign (IDML) documents: the package is the source of truth and is saved with every
//! untouched part byte for byte; DesignCraft's document model is derived from it to compose and
//! draw pages (with InDesign's measured composition rules, see
//! experiments/indesign-compose) and is rebuilt after every edit.
//!
//! Elements are addressed by their IDML `Self` ids: page items (frames, shapes, groups) and
//! stories keep them across edits and saves.

pub mod check;
pub mod create;
pub mod describe;
pub mod edit;
mod glyphs;
pub mod graph;

use designcraft_doc::Document;
use designcraft_idml::SourceIds;
use present_package::Package;

/// What can go wrong with an IDML document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Not an IDML package, or one DesignCraft cannot read.
    NotIdml(String),
    Package(String),
    Xml(String),
    /// No such page item, story or page.
    NotFound(String),
    /// A command that cannot be applied as given.
    InvalidCommand(String),
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
            present_package::Error::Xml(m) => Error::Xml(m),
            other => Error::Package(other.to_string()),
        }
    }
}

pub(crate) const MIMETYPE: &str = "application/vnd.adobe.indesign-idml-package";

/// An open IDML document.
pub struct Idml {
    package: Package,
    doc: Document,
    ids: SourceIds,
    cache: designcraft_compose::Cache,
}

/// A copy for undo: the package parts are shared, the drawing cache starts empty.
impl Clone for Idml {
    fn clone(&self) -> Self {
        Idml { package: self.package.clone(), doc: self.doc.clone(), ids: self.ids.clone(), cache: designcraft_compose::Cache::new() }
    }
}

/// A new, empty IDML document: `pages` pages of the named size preset ("A4", "Letter", …;
/// DesignCraft's presets), single pages (not facing), in millimetres for metric presets.
pub fn blank(preset: &str, pages: usize) -> Result<Vec<u8>, Error> {
    let mut nd = designcraft_doc::build::NewDocument::from_preset(preset).ok_or_else(|| Error::InvalidCommand(format!("unknown page size {preset:?}")))?;
    nd.facing_pages = false;
    nd.pages = pages.max(1);
    nd.title = "Untitled".into();
    let mut doc = Document::new(&nd);
    // Korean InDesign's defaults (Korean language, CJK paragraph composer), set in a font every
    // InDesign installs that has Hangul. Noto Sans KR, the document view's Korean fallback, is
    // the same design, so pages look alike in both.
    if let Some(basic) = std::sync::Arc::make_mut(&mut doc.styles).paragraph.iter_mut().find(|p| p.name == designcraft_doc::story::BASIC_PARAGRAPH) {
        basic.chars.font_family = Some("Source Han Sans SC".into());
        basic.chars.font_style = Some("Regular".into());
        basic.chars.language = Some("Korean".into());
        basic.para.composer = Some(designcraft_doc::Composer::ParagraphCjk);
    }
    Ok(designcraft_idml::export_idml(&doc))
}

/// Whether `bytes` look like an IDML package (a ZIP whose first, stored entry is its mimetype).
pub fn is_idml(bytes: &[u8]) -> bool {
    designcraft_idml::is_idml(bytes)
}

impl Idml {
    /// Opens an IDML package. Linked files (placed images) are not available; frames that show
    /// them draw as empty frames.
    pub fn open(bytes: Vec<u8>) -> Result<Self, Error> {
        let package = Package::open(bytes)?;
        let mime = package.read("mimetype").map_err(|_| Error::NotIdml("no mimetype part".into()))?;
        if String::from_utf8_lossy(&mime).trim() != MIMETYPE {
            return Err(Error::NotIdml("not an IDML package".into()));
        }
        let (doc, ids) = load(&package)?;
        Ok(Idml { package, doc, ids, cache: designcraft_compose::Cache::new() })
    }

    /// The package, saved: the original bytes when nothing changed, else every untouched part
    /// copied byte for byte.
    pub fn save(&self) -> Result<Vec<u8>, Error> {
        Ok(self.package.save()?)
    }

    pub fn package(&self) -> &Package {
        &self.package
    }

    /// DesignCraft's view of the document (composition and drawing).
    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// IDML `Self` ids of the derived document's page items and stories.
    pub fn source_ids(&self) -> &SourceIds {
        &self.ids
    }

    pub fn page_count(&self) -> usize {
        self.doc.page_count()
    }

    /// Width and height of page `index` in points.
    pub fn page_size(&self, index: usize) -> Option<(f64, f64)> {
        self.doc.spreads.iter().flat_map(|s| &s.pages).nth(index).map(|p| (p.width, p.height))
    }

    /// Names of the fonts the document lists (families and PostScript names, from
    /// `Resources/Fonts.xml`), for loading them from the user's computer.
    pub fn font_names(&self) -> Vec<String> {
        let Ok(src) = self.package.read("Resources/Fonts.xml") else { return Vec::new() };
        let Ok(tree) = present_package::xml::Tree::parse(&src) else { return Vec::new() };
        let mut out: Vec<String> = tree
            .nodes
            .iter()
            .flat_map(|n| match n.local.as_str() {
                "FontFamily" => vec![n.attr("Name")],
                "Font" => vec![n.attr("PostScriptName"), n.attr("FontFamily")],
                _ => vec![],
            })
            .flatten()
            .filter(|s| !s.is_empty() && *s != "$ID/")
            .map(str::to_string)
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Page `index` (0-based, document order) drawn at `scale` pixels per point, as PNG.
    pub fn render_page(&self, index: usize, scale: f64) -> Result<Vec<u8>, Error> {
        self.render_page_with(index, scale, false)
    }

    /// [`Idml::render_page`], with `scalar` rasterizing without SIMD instructions (for a
    /// server whose CPU's SIMD support is not trusted, such as x86 emulated on ARM).
    pub fn render_page_with(&self, index: usize, scale: f64, scalar: bool) -> Result<Vec<u8>, Error> {
        let mut r = designcraft_render::Renderer::new();
        r.threads = 0;
        if scalar {
            r.level = Some(designcraft_render::simd_baseline());
        }
        let img = r
            .render_page(&self.doc, &self.cache, index, scale, false, &designcraft_render::RenderOptions::default())
            .ok_or_else(|| Error::NotFound(format!("page {index}")))?;
        Ok(img.to_png())
    }

    /// Replaces package parts (removing those given no bytes) and rebuilds the derived
    /// document from the result; on failure nothing changes.
    pub(crate) fn commit(&mut self, parts: Vec<(String, Vec<u8>)>) -> Result<(), Error> {
        if parts.is_empty() {
            return Ok(());
        }
        let mut package = self.package.clone();
        for (name, bytes) in parts {
            if bytes.is_empty() {
                package.remove(&name)?;
            } else {
                package.write(&name, bytes)?;
            }
        }
        let (doc, ids) = load(&package)?;
        self.package = package;
        self.doc = doc;
        self.ids = ids;
        self.cache = designcraft_compose::Cache::new();
        Ok(())
    }
}

fn load(package: &Package) -> Result<(Document, SourceIds), Error> {
    let bytes = package.save()?;
    designcraft_idml::import_idml_mapped(&bytes, &|_| None).map_err(|e| Error::NotIdml(e.to_string()))
}
