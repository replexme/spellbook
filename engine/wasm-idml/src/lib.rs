//! The InDesign (IDML) engine for the browser document view, loaded only when an IDML document
//! opens (the PowerPoint engine in `engine/wasm` stays as small as it was). `IdmlWorkspace` has
//! the same methods as the PowerPoint `Workspace`, so the view's worker drives either the same
//! way; commands are `present_idml` commands (JSON objects).

use present_engine::{Session, TxError};
use present_idml::{Error, Idml};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

/// An error as JSON text `{code, detail, index?}`, as the PowerPoint workspace reports them.
fn fail(code: &str, detail: impl std::fmt::Display, index: Option<usize>) -> JsError {
    JsError::new(&json!({ "code": code, "detail": detail.to_string(), "index": index }).to_string())
}

fn command_error(e: &Error) -> &'static str {
    match e {
        Error::NotFound(_) => "target_not_found",
        Error::InvalidCommand(_) => "invalid_command",
        _ => "command_failed",
    }
}

fn history_error(e: TxError<()>, nothing: &str) -> JsError {
    match e {
        TxError::StaleVersion { expected, actual } => fail("version_conflict", format!("expected {expected}, document is at {actual}"), None),
        _ => fail(&format!("nothing_to_{nothing}"), format!("no edit to {nothing}"), None),
    }
}

#[wasm_bindgen]
#[derive(Default)]
pub struct IdmlWorkspace {
    session: Option<Session<Idml>>,
    requests: u64,
}

#[wasm_bindgen]
impl IdmlWorkspace {
    #[wasm_bindgen(constructor)]
    pub fn new() -> IdmlWorkspace {
        IdmlWorkspace::default()
    }

    /// Adds a font (TTF/OTF/TTC bytes): fallback fonts and fonts from Local Font Access.
    pub fn add_font(&mut self, bytes: Vec<u8>) {
        designcraft_fonts::FontDb::global().add_font(bytes);
    }

    /// Opens an IDML package and returns its page count.
    pub fn open(&mut self, bytes: Vec<u8>) -> Result<usize, JsError> {
        let doc = Idml::open(bytes).map_err(|e| fail("unreadable_document", e, None))?;
        let count = doc.page_count();
        self.session = Some(Session::new(doc));
        Ok(count)
    }

    fn session(&self) -> Result<&Session<Idml>, JsError> {
        self.session.as_ref().ok_or_else(|| fail("document_not_open", "no document open", None))
    }

    fn session_mut(&mut self) -> Result<&mut Session<Idml>, JsError> {
        self.session.as_mut().ok_or_else(|| fail("document_not_open", "no document open", None))
    }

    pub fn format(&self) -> String {
        "idml".into()
    }

    /// Version of the open document: 0 when opened, +1 per edit, undo or redo.
    pub fn version(&self) -> Result<f64, JsError> {
        Ok(self.session()?.version() as f64)
    }

    pub fn can_undo(&self) -> Result<bool, JsError> {
        Ok(self.session()?.can_undo())
    }

    /// Pages, page items and stories as JSON (`Idml::describe`).
    pub fn describe(&self) -> Result<String, JsError> {
        Ok(self.session()?.document().describe().to_string())
    }

    /// Applies a JSON array of commands as one undo step, if the document is still at
    /// `expected_version`. Returns the receipt as JSON.
    pub fn apply(&mut self, commands_json: &str, expected_version: f64) -> Result<String, JsError> {
        let list: Vec<Value> = serde_json::from_str(commands_json).map_err(|e| fail("invalid_command", e, None))?;
        self.requests += 1;
        let request = format!("workspace-{}", self.requests);
        let receipt = self.session_mut()?.apply(expected_version as u64, &request, &request, &list, |d, c| d.apply(c)).map_err(|e| match e {
            TxError::StaleVersion { expected, actual } => fail("version_conflict", format!("expected {expected}, document is at {actual}"), None),
            TxError::RequestIdReused { request_id } => fail("transaction_conflict", request_id, None),
            TxError::EmptyBatch => fail("invalid_command", "no commands", None),
            TxError::Command { index, error } => fail(command_error(&error), error, Some(index)),
        })?;
        Ok(serde_json::to_string(&receipt).expect("serializable"))
    }

    /// Reverts the last edit; returns the new version.
    pub fn undo(&mut self, expected_version: f64) -> Result<f64, JsError> {
        Ok(self.session_mut()?.undo(expected_version as u64).map_err(|e| history_error(e, "undo"))? as f64)
    }

    pub fn redo(&mut self, expected_version: f64) -> Result<f64, JsError> {
        Ok(self.session_mut()?.redo(expected_version as u64).map_err(|e| history_error(e, "redo"))? as f64)
    }

    /// PNG of page `index` (1-based, as slides are counted) at `scale` pixels per point.
    pub fn render(&self, index: usize, scale: f64) -> Result<Vec<u8>, JsError> {
        let page = index.checked_sub(1).ok_or_else(|| fail("render_failed", "pages count from 1", None))?;
        self.session()?.document().render_page(page, scale).map_err(|e| fail("render_failed", e, None))
    }

    /// The open document as IDML bytes (untouched parts byte for byte).
    pub fn save(&self) -> Result<Vec<u8>, JsError> {
        self.session()?.document().save().map_err(|e| fail("save_failed", e, None))
    }
}
