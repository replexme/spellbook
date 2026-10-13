//! Server-side checks of an IDML file, in the shapes the Spellbook document worker stores:
//! a safety scan before the package is read (`DocumentScan`), and the report of what a saved
//! version changed against the version it was edited from (`PackageChangeBudgetReport`). The
//! AI's IDML commands only write stories and spreads (and add or remove them), the designmap
//! that lists them and the swatches in `Resources/Graphic.xml`, so a save that changes
//! anything else is refused.

use present_package::Package;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Error, Idml, MIMETYPE};

/// At most this many parts, and this many bytes in all once decompressed (as declared).
const MAX_PARTS: usize = 10_000;
const MAX_UNCOMPRESSED: u64 = 400 * 1024 * 1024;

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks the package before anything is decompressed: a stored mimetype first, safe part
/// names, and bounded part count and total size.
fn check_package(bytes: &[u8]) -> Result<Package, Error> {
    if !crate::is_idml(bytes) {
        return Err(Error::NotIdml("not an IDML package (the first entry must be the stored mimetype)".into()));
    }
    let package = Package::open(bytes.to_vec())?;
    let names: Vec<&str> = package.part_names().collect();
    if names.len() > MAX_PARTS {
        return Err(Error::Package(format!("{} parts (at most {MAX_PARTS})", names.len())));
    }
    let mut total = 0u64;
    for n in &names {
        if n.starts_with('/') || n.contains('\\') || n.split('/').any(|seg| seg == "..") {
            return Err(Error::Package(format!("unsafe part name {n:?}")));
        }
        total += package.declared_size(n).unwrap_or(0);
    }
    if total > MAX_UNCOMPRESSED {
        return Err(Error::Package(format!("{total} bytes decompressed (at most {MAX_UNCOMPRESSED})")));
    }
    let mime = package.read("mimetype")?;
    if String::from_utf8_lossy(&mime).trim() != MIMETYPE {
        return Err(Error::NotIdml("unexpected mimetype".into()));
    }
    Ok(package)
}

/// The safety scan of an IDML file (`DocumentScan`). Fails when the file is unsafe or cannot
/// be read.
pub fn scan(bytes: &[u8]) -> Result<Value, Error> {
    let package = check_package(bytes)?;
    let names: Vec<String> = package.part_names().map(str::to_string).collect();
    let uncompressed: u64 = names.iter().map(|n| package.declared_size(n).unwrap_or(0)).sum();
    let doc = Idml::open(bytes.to_vec())?;
    let desc = doc.describe();
    let unavailable = desc["items"].as_array().into_iter().flatten().filter(|i| i["image"]["available"] == false).count();
    let mut warnings = Vec::new();
    if unavailable > 0 {
        warnings.push(format!("{unavailable} placed images are linked files outside the package"));
    }
    Ok(json!({
        "contractVersion": "1.0",
        "documentSha256": sha256_hex(bytes),
        "compressedBytes": bytes.len(),
        "uncompressedBytes": uncompressed,
        "entryCount": names.len(),
        "slideCount": doc.page_count(),
        "hasExternalRelationships": false,
        "riskyExternalRelationshipSourceParts": [],
        "warnings": warnings,
    }))
}

fn category(part: &str) -> &'static str {
    match part {
        "designmap.xml" => "designmap",
        "mimetype" => "mimetype",
        p if p.starts_with("Stories/") => "story",
        p if p.starts_with("Spreads/") => "spread",
        p if p.starts_with("MasterSpreads/") => "master_spread",
        p if p.starts_with("Resources/") => "resources",
        p if p.starts_with("META-INF/") => "metadata",
        p if p.starts_with("XML/") => "xml_structure",
        _ => "unknown",
    }
}

/// What `candidate` changed against `baseline` (`PackageChangeBudgetReport`): valid when the
/// candidate is a readable IDML package whose only changes are ones the AI's commands make.
pub fn change_report(baseline: &[u8], candidate: &[u8]) -> Value {
    let mut errors: Vec<String> = Vec::new();
    let mut changes = Vec::new();
    match (check_package(baseline), check_package(candidate)) {
        (Ok(base), Ok(cand)) => {
            let mut names: Vec<String> = base.part_names().chain(cand.part_names()).map(str::to_string).collect();
            names.sort();
            names.dedup();
            for name in names {
                let kind = match (base.contains(&name), cand.contains(&name)) {
                    (true, false) => "removed",
                    (false, true) => "added",
                    _ => match (base.read(&name), cand.read(&name)) {
                        (Ok(a), Ok(b)) if a == b => continue,
                        (Ok(_), Ok(_)) => "modified",
                        _ => {
                            errors.push(format!("{name}: unreadable"));
                            continue;
                        }
                    },
                };
                let cat = category(&name);
                // What the IDML commands write: stories and spreads (edited, added by new frames
                // and pages, removed with them), the designmap that lists them, and the
                // swatches new colours are added to.
                let allowed = matches!((cat, kind), ("story" | "spread", _) | ("designmap", "modified")) || (name == "Resources/Graphic.xml" && kind == "modified");
                if !allowed {
                    errors.push(format!("{name}: {kind} {cat} part is outside what document edits change"));
                }
                changes.push(json!({ "part": name, "category": cat, "changeKind": kind, "inTargetScope": allowed }));
            }
            if let Err(e) = Idml::open(candidate.to_vec()) {
                errors.push(format!("the saved document cannot be read: {e}"));
            }
        }
        (Err(e), _) => errors.push(format!("baseline: {e}")),
        (_, Err(e)) => errors.push(format!("saved document: {e}")),
    }
    json!({
        "contractVersion": "1.0",
        "valid": errors.is_empty(),
        "baselineDocumentSha256": sha256_hex(baseline),
        "candidateDocumentSha256": sha256_hex(candidate),
        "changes": changes,
        "errors": errors,
    })
}
