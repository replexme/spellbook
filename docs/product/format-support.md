# Format support

This page is the user-facing support truth. “Planned” means architecture only, not an upload promise.

| Format                 | Status                        | Shown in the document view | AI observation/edit/review           | Editable download |
| ---------------------- | ----------------------------- | -------------------------- | ------------------------------------ | ----------------- |
| PowerPoint `.pptx`     | Prerelease under verification | Yes                        | Implemented for supported operations | Implemented       |
| InDesign `.idml`       | Experimental                  | Yes                        | Experimental                         | Experimental      |
| Word `.docx`           | Planned                       | Not exposed                | Not implemented                      | Not exposed       |
| Spellbook `.spellbook` | Planned                       | Not implemented            | Not implemented                      | Not exposed       |

People do not edit documents directly. The document view shows the document; the AI makes the changes; the person can undo, redo or return to an earlier version.

## PPTX prerelease scope

The document engine (`engine/`, `formats/pptx`) reads the PPTX, draws its slides and applies edits. The edit contract `contracts/native-edit-capabilities.json` classifies 93 operations, of which 93 are exposed to the AI tool schema. In a session the model is offered only the operations that the open document's engine reports it supports, and when the engine refuses an edit, the refusal is reported and the last observation stays current.

The file is rejected or marked with warnings when the engine cannot safely promise its behavior. Arbitrary OLE content, external workbooks, macros, file access and network commands are not exposed to the AI. An element visible in the document view is not automatically AI-editable.

## Fidelity language

Local apply, Undo/Redo and save/reopen checks do not establish visual fidelity.

- **Structurally valid** means the edited package opens and only allowed package parts changed.
- **Visually reviewed** means before/after renders were supplied to the review loop and its evidence was internally consistent.
- **PowerPoint-faithful** requires comparison against a PowerPoint reference corpus on supported operating systems. Agreement between two renders by the same engine does not prove it.
- No aggregate pixel score may hide text reflow, missing content, changed pagination/slide count or a broken editable object. Those are hard failures.

The prerelease can be promoted to beta only with published corpus coverage, pass/fail thresholds and a list of known unsupported constructs, plus the operational evidence required by the release gates.
