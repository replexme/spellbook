//! Shared edit session: one history for human and AI edits.
//!
//! A batch of commands is applied to a copy of the document and committed only
//! if every command succeeds, so a failure never leaves partial changes. Each
//! committed batch is one undo step. Writes carry the version they were based
//! on and are rejected when the document has moved on. A request ID that was
//! already committed returns the stored receipt instead of applying twice.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

/// Number of committed request IDs remembered for duplicate detection.
const RECEIPT_CAPACITY: usize = 1024;
/// Number of undo steps kept.
const UNDO_CAPACITY: usize = 1000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    pub base_version: u64,
    pub version: u64,
    /// One result per command, in order.
    pub results: Vec<Value>,
    /// True when this receipt was returned for a repeated request.
    pub replayed: bool,
}

#[derive(Debug, PartialEq)]
pub enum TxError<E> {
    /// The caller observed `expected` but the document is at `actual`.
    StaleVersion { expected: u64, actual: u64 },
    /// The request ID was already used for a different batch.
    RequestIdReused { request_id: String },
    /// Command `index` failed; nothing was committed.
    Command { index: usize, error: E },
    EmptyBatch,
}

struct Stored {
    fingerprint: String,
    receipt: Receipt,
}

pub struct Session<D: Clone> {
    doc: D,
    version: u64,
    undo: VecDeque<D>,
    redo: Vec<D>,
    receipts: HashMap<String, Stored>,
    receipt_order: VecDeque<String>,
}

impl<D: Clone> Session<D> {
    pub fn new(doc: D) -> Self {
        Self {
            doc,
            version: 0,
            undo: VecDeque::new(),
            redo: Vec::new(),
            receipts: HashMap::new(),
            receipt_order: VecDeque::new(),
        }
    }

    pub fn document(&self) -> &D {
        &self.doc
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Applies `commands` atomically. `fingerprint` identifies the batch
    /// content so that a reused request ID with different content is refused.
    pub fn apply<C, E>(
        &mut self,
        expected_version: u64,
        request_id: &str,
        fingerprint: &str,
        commands: &[C],
        run: impl Fn(&mut D, &C) -> Result<Value, E>,
    ) -> Result<Receipt, TxError<E>> {
        if let Some(stored) = self.receipts.get(request_id) {
            if stored.fingerprint != fingerprint {
                return Err(TxError::RequestIdReused { request_id: request_id.to_owned() });
            }
            return Ok(Receipt { replayed: true, ..stored.receipt.clone() });
        }
        if expected_version != self.version {
            return Err(TxError::StaleVersion { expected: expected_version, actual: self.version });
        }
        if commands.is_empty() {
            return Err(TxError::EmptyBatch);
        }
        let mut draft = self.doc.clone();
        let mut results = Vec::with_capacity(commands.len());
        for (index, command) in commands.iter().enumerate() {
            results.push(run(&mut draft, command).map_err(|error| TxError::Command { index, error })?);
        }
        let previous = std::mem::replace(&mut self.doc, draft);
        self.push_undo(previous);
        self.redo.clear();
        let base_version = self.version;
        self.version += 1;
        let receipt = Receipt {
            request_id: request_id.to_owned(),
            base_version,
            version: self.version,
            results,
            replayed: false,
        };
        self.remember(request_id, fingerprint, receipt.clone());
        Ok(receipt)
    }

    /// Reverts the last committed batch. Returns the new version.
    pub fn undo(&mut self, expected_version: u64) -> Result<u64, TxError<()>> {
        self.check_version(expected_version)?;
        let previous = self.undo.pop_back().ok_or(TxError::EmptyBatch)?;
        let current = std::mem::replace(&mut self.doc, previous);
        self.redo.push(current);
        self.version += 1;
        Ok(self.version)
    }

    pub fn redo(&mut self, expected_version: u64) -> Result<u64, TxError<()>> {
        self.check_version(expected_version)?;
        let next = self.redo.pop().ok_or(TxError::EmptyBatch)?;
        let current = std::mem::replace(&mut self.doc, next);
        self.push_undo(current);
        self.version += 1;
        Ok(self.version)
    }

    fn check_version(&self, expected: u64) -> Result<(), TxError<()>> {
        if expected != self.version {
            return Err(TxError::StaleVersion { expected, actual: self.version });
        }
        Ok(())
    }

    fn push_undo(&mut self, doc: D) {
        if self.undo.len() == UNDO_CAPACITY {
            self.undo.pop_front();
        }
        self.undo.push_back(doc);
    }

    fn remember(&mut self, request_id: &str, fingerprint: &str, receipt: Receipt) {
        if self.receipt_order.len() == RECEIPT_CAPACITY {
            if let Some(oldest) = self.receipt_order.pop_front() {
                self.receipts.remove(&oldest);
            }
        }
        self.receipt_order.push_back(request_id.to_owned());
        self.receipts.insert(
            request_id.to_owned(),
            Stored { fingerprint: fingerprint.to_owned(), receipt },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn add(doc: &mut Vec<i32>, n: &i32) -> Result<Value, String> {
        if *n < 0 {
            return Err(format!("negative {n}"));
        }
        doc.push(*n);
        Ok(json!(doc.len()))
    }

    #[test]
    fn failed_batch_leaves_document_unchanged() {
        let mut s = Session::new(vec![]);
        let err = s.apply(0, "r1", "f", &[1, -1], add).unwrap_err();
        assert_eq!(err, TxError::Command { index: 1, error: "negative -1".into() });
        assert!(s.document().is_empty());
        assert_eq!(s.version(), 0);
        assert!(!s.can_undo());
    }

    #[test]
    fn batch_is_one_undo_step() {
        let mut s = Session::new(vec![]);
        let r = s.apply(0, "r1", "f", &[1, 2, 3], add).unwrap();
        assert_eq!((r.base_version, r.version), (0, 1));
        assert_eq!(s.document(), &vec![1, 2, 3]);
        let v = s.undo(1).unwrap();
        assert!(s.document().is_empty());
        s.redo(v).unwrap();
        assert_eq!(s.document(), &vec![1, 2, 3]);
        assert_eq!(s.version(), 3);
    }

    #[test]
    fn stale_write_is_rejected() {
        let mut s = Session::new(vec![]);
        s.apply(0, "r1", "f1", &[1], add).unwrap();
        let err = s.apply(0, "r2", "f2", &[2], add).unwrap_err();
        assert_eq!(err, TxError::StaleVersion { expected: 0, actual: 1 });
        assert_eq!(s.document(), &vec![1]);
        assert_eq!(s.undo(0), Err(TxError::StaleVersion { expected: 0, actual: 1 }));
    }

    #[test]
    fn repeated_request_is_not_applied_twice() {
        let mut s = Session::new(vec![]);
        let first = s.apply(0, "r1", "f", &[7], add).unwrap();
        // A retry carries the version it originally observed.
        let again = s.apply(0, "r1", "f", &[7], add).unwrap();
        assert!(again.replayed);
        assert_eq!(again.version, first.version);
        assert_eq!(s.document(), &vec![7]);
        let reused = s.apply(1, "r1", "other", &[8], add).unwrap_err();
        assert_eq!(reused, TxError::RequestIdReused { request_id: "r1".into() });
    }

    #[test]
    fn new_commit_clears_redo() {
        let mut s = Session::new(vec![]);
        s.apply(0, "r1", "f", &[1], add).unwrap();
        s.undo(1).unwrap();
        s.apply(2, "r2", "f", &[2], add).unwrap();
        assert!(!s.can_redo());
        assert_eq!(s.document(), &vec![2]);
    }
}
