//! The engine as the browser workspace uses it: one open document whose
//! slides it draws and whose AI edits it applies, with undo and saving.
//! Commands are the engine's own (`present_pptx::commands::Command`).

use present_engine::{Session, TxError};
use present_pptx::commands::{self, Command};
use present_pptx::render::fonts::FontSet;
use present_pptx::render::{render_slide, Resources};
use present_pptx::{Error, Presentation};
use serde_json::json;
use wasm_bindgen::prelude::*;

/// An error as JSON text `{code, detail, index?}`, so the host can tell a
/// stale version from a refused command.
fn fail(code: &str, detail: impl std::fmt::Display, index: Option<usize>) -> JsError {
    JsError::new(&json!({ "code": code, "detail": detail.to_string(), "index": index }).to_string())
}

fn command_error(e: &Error) -> &'static str {
    match e {
        Error::NotFound(_) => "target_not_found",
        Error::Unsupported(_) => "unsupported_content",
        Error::InvalidCommand(_) => "invalid_command",
        _ => "command_failed",
    }
}

#[wasm_bindgen]
pub struct Workspace {
    resources: Resources,
    session: Option<Session<Presentation>>,
    font_scope: u32,
    requests: u64,
}

#[wasm_bindgen]
impl Workspace {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Workspace {
        Workspace { resources: Resources::new(FontSet::empty()), session: None, font_scope: 0, requests: 0 }
    }

    /// Adds a font (TTF/OTF/TTC bytes), for example from Local Font Access.
    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.resources.fonts.add_bytes(bytes);
    }

    /// Opens a PPTX (with its embedded fonts) and returns its slide count.
    pub fn open(&mut self, pptx: Vec<u8>) -> Result<usize, JsError> {
        let doc = Presentation::open(pptx).map_err(|e| fail("unreadable_document", e, None))?;
        self.resources.fonts.remove_document_fonts(self.font_scope);
        self.font_scope = self.resources.open_document(&doc);
        let count = doc.slide_count();
        self.session = Some(Session::new(doc));
        Ok(count)
    }

    fn session(&self) -> Result<&Session<Presentation>, JsError> {
        self.session.as_ref().ok_or_else(|| fail("document_not_open", "no document open", None))
    }

    fn session_mut(&mut self) -> Result<&mut Session<Presentation>, JsError> {
        self.session.as_mut().ok_or_else(|| fail("document_not_open", "no document open", None))
    }

    /// Version of the open document: 0 when opened, +1 per edit, undo or redo.
    pub fn version(&self) -> Result<f64, JsError> {
        Ok(self.session()?.version() as f64)
    }

    pub fn can_undo(&self) -> Result<bool, JsError> {
        Ok(self.session()?.can_undo())
    }

    /// The whole presentation as JSON (`present_pptx::describe`).
    pub fn describe(&self) -> Result<String, JsError> {
        let v = present_pptx::describe::describe(self.session()?.document()).map_err(|e| fail("unreadable_document", e, None))?;
        Ok(v.to_string())
    }

    /// Applies a JSON array of commands as one undo step, if the document is
    /// still at `expected_version`. Returns the receipt as JSON.
    pub fn apply(&mut self, commands_json: &str, expected_version: f64) -> Result<String, JsError> {
        let list: Vec<Command> = serde_json::from_str(commands_json).map_err(|e| fail("invalid_command", e, None))?;
        self.requests += 1;
        let request = format!("workspace-{}", self.requests);
        let resources = &self.resources;
        let session = self.session.as_mut().ok_or_else(|| fail("document_not_open", "no document open", None))?;
        resources.fonts.set_active_document(self.font_scope);
        let receipt = session.apply(expected_version as u64, &request, &request, &list, |d, c| commands::run_with(d, c, Some(resources))).map_err(|e| match e {
            TxError::StaleVersion { expected, actual } => fail("version_conflict", format!("expected {expected}, document is at {actual}"), None),
            TxError::RequestIdReused { request_id } => fail("transaction_conflict", request_id, None),
            TxError::EmptyBatch => fail("invalid_command", "no commands", None),
            TxError::Command { index, error } => fail(command_error(&error), error, Some(index)),
        })?;
        Ok(serde_json::to_string(&receipt).expect("serializable"))
    }

    /// Reverts the last edit; returns the new version.
    pub fn undo(&mut self, expected_version: f64) -> Result<f64, JsError> {
        let v = self.session_mut()?.undo(expected_version as u64).map_err(|e| match e {
            TxError::StaleVersion { expected, actual } => fail("version_conflict", format!("expected {expected}, document is at {actual}"), None),
            _ => fail("nothing_to_undo", "no edit to undo", None),
        })?;
        Ok(v as f64)
    }

    pub fn redo(&mut self, expected_version: f64) -> Result<f64, JsError> {
        let v = self.session_mut()?.redo(expected_version as u64).map_err(|e| match e {
            TxError::StaleVersion { expected, actual } => fail("version_conflict", format!("expected {expected}, document is at {actual}"), None),
            _ => fail("nothing_to_redo", "no edit to redo", None),
        })?;
        Ok(v as f64)
    }

    /// PNG of slide `index` (1-based) at `scale` pixels per point.
    pub fn render(&self, index: usize, scale: f64) -> Result<Vec<u8>, JsError> {
        let doc = self.session()?.document();
        self.resources.fonts.set_active_document(self.font_scope);
        let slide = render_slide(doc, index, &self.resources).map_err(|e| fail("render_failed", e, None))?;
        Ok(present_render::rasterize(&slide.scene, self.resources.fonts.db(), scale).to_png())
    }

    /// Text lines, fonts and undrawn features of slide `index`, as JSON.
    pub fn layout(&self, index: usize) -> Result<String, JsError> {
        let doc = self.session()?.document();
        self.resources.fonts.set_active_document(self.font_scope);
        let slide = render_slide(doc, index, &self.resources).map_err(|e| fail("render_failed", e, None))?;
        Ok(json!({ "slide": index, "width": slide.scene.width, "height": slide.scene.height, "texts": slide.texts, "frames": slide.frames, "diagnostics": slide.diagnostics }).to_string())
    }

    /// The slide's own text boxes (1-based `index`) whose text overflows the
    /// box or is drawn with a substitute for a missing font, as JSON
    /// `[{shapeId, overflow, substituted}]`: what the AI's layout check needs,
    /// without the line detail of `layout`.
    pub fn text_fit(&self, index: usize) -> Result<String, JsError> {
        use present_pptx::render::fonts::Fidelity;
        let doc = self.session()?.document();
        self.resources.fonts.set_active_document(self.font_scope);
        let slide = render_slide(doc, index, &self.resources).map_err(|e| fail("render_failed", e, None))?;
        let facts: Vec<_> = slide
            .texts
            .iter()
            .filter(|t| t.on_slide)
            .map(|t| (t, t.fonts.iter().any(|f| matches!(f.fidelity, Fidelity::Substituted | Fidelity::MissingGlyph))))
            .filter(|(t, substituted)| t.overflow > 0.0 || *substituted)
            .map(|(t, substituted)| json!({ "shapeId": t.shape_id, "overflow": t.overflow, "substituted": substituted }))
            .collect();
        Ok(serde_json::Value::from(facts).to_string())
    }

    /// The open document as PPTX bytes (untouched parts byte for byte).
    pub fn save(&self) -> Result<Vec<u8>, JsError> {
        self.session()?.document().save().map_err(|e| fail("save_failed", e, None))
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}
