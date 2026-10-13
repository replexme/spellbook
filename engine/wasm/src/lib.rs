//! Browser entry point. The same functions run natively, so the browser and
//! a server preview draw a slide from the same code, fonts and file.

pub mod host;
pub mod workspace;

use present_pptx::render::fonts::FontSet;
use present_pptx::render::{render_slide, Resources};
use present_pptx::Presentation;
use serde_json::json;
use wasm_bindgen::prelude::*;

/// Draws slide `index` (1-based) at `scale` pixels per point. Returns the PNG
/// and a JSON description of the text lines, fonts and undrawn features.
pub fn render_png(doc: &Presentation, resources: &Resources, index: usize, scale: f64) -> Result<(Vec<u8>, String), String> {
    let slide = render_slide(doc, index, resources).map_err(|e| e.to_string())?;
    let raster = present_render::rasterize(&slide.scene, resources.fonts.db(), scale);
    let layout = json!({
        "slide": index,
        "texts": slide.texts,
        "diagnostics": slide.diagnostics,
        "provisional": slide.provisional,
    });
    Ok((raster.to_png(), layout.to_string()))
}

#[wasm_bindgen]
pub struct Engine {
    host: host::Host,
    doc: Option<Presentation>,
    /// The open document's embedded fonts (0: none).
    font_scope: u32,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { host: host::Host::new(Resources::new(FontSet::empty())), doc: None, font_scope: 0 }
    }

    /// Adds a font (TTF/OTF/TTC bytes), for example from Local Font Access.
    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.host.resources_mut().fonts.add_bytes(bytes);
    }

    /// Opens a PPTX and returns its slide count.
    pub fn open(&mut self, pptx: Vec<u8>) -> Result<usize, JsError> {
        let doc = Presentation::open(pptx).map_err(|e| JsError::new(&e.to_string()))?;
        let count = doc.slide_count();
        let resources = self.host.resources_mut();
        resources.fonts.remove_document_fonts(self.font_scope);
        self.font_scope = resources.open_document(&doc);
        self.doc = Some(doc);
        Ok(count)
    }

    /// PNG of slide `index` (1-based) at `scale` pixels per point.
    pub fn render(&self, index: usize, scale: f64) -> Result<Vec<u8>, JsError> {
        let doc = self.doc.as_ref().ok_or_else(|| JsError::new("no document open"))?;
        self.host.resources().fonts.set_active_document(self.font_scope);
        render_png(doc, self.host.resources(), index, scale).map(|(png, _)| png).map_err(|e| JsError::new(&e))
    }

    /// The AI bridge call: `{abiVersion: 1, operation, parameters}` in,
    /// `{result}` or `{error: {code}}` out (see `host`).
    pub fn invoke(&mut self, input: &str) -> String {
        self.host.invoke(input)
    }

    /// JSON layout of slide `index`: text lines, fonts used, undrawn features.
    pub fn layout(&self, index: usize) -> Result<String, JsError> {
        let doc = self.doc.as_ref().ok_or_else(|| JsError::new("no document open"))?;
        self.host.resources().fonts.set_active_document(self.font_scope);
        render_png(doc, self.host.resources(), index, 1.0).map(|(_, l)| l).map_err(|e| JsError::new(&e))
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
