# Format support

This page is the user-facing support truth. “Planned” means architecture only, not an upload promise.

| Format                 | Status                        | Direct browser editing | AI observation/edit/review           | Editable download |
| ---------------------- | ----------------------------- | ---------------------- | ------------------------------------ | ----------------- |
| PowerPoint `.pptx`     | Prerelease under verification | Impress through WOPI   | Implemented for supported operations | Implemented       |
| Word `.docx`           | Planned                       | Not exposed            | Not implemented                      | Not exposed       |
| Spellbook `.spellbook` | Planned                       | Not implemented        | Not implemented                      | Not exposed       |

## PPTX prerelease scope

The engine currently inspects text boxes, shapes, pictures, connectors, groups and graphic frames; records geometry, z-order, text, fonts and support warnings; and supports the operations declared in `contracts/native-edit-capabilities.json` and `contracts/edit-target-capabilities.json`.

The native mutation model currently classifies 98 operations, of which 97 bounded operations are exposed to the AI tool schema; the per-shape printable flag is excluded because PPTX cannot preserve it. 63 have passed the live runtime path through native Undo/Redo, save/reopen, scoped package-change checks and PowerPoint reopening. The other 34 are implemented against the cumulative `undo-v30` engine candidate and require final runtime validation; the matching `browser-undo-v29` source candidate covers sections, chart formatting, document design, connectors/freeform, shape and text formatting, comments, animation lifecycle, images/media, SmartArt, Fontwork, 3D, equations and reading order. Those 34 are not release-verified until the one final compiled candidate passes the shared 15-scenario runtime suite and the downstream visual and PowerPoint checks. Every execution is rebound to the current document permission and live engine patch level. “Implemented in source,” “available to the model” and “release-verified for autonomous execution” remain separate states.

Setting a slide duration also enables automatic advance. PPTX stores that active interval as the transition's [`advTm` value in milliseconds](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.transition?view=openxml-3.0.1); a manual-advance slide does not retain a separate inactive duration through save and reopen.

The file is rejected or marked with warnings when the engine cannot safely promise its behavior. The bounded candidate edits semantic SmartArt nodes, internal chart data and formatting, embedded Math equations, media playback and selected renderer effects without exposing arbitrary OLE, external workbooks, macros, file access or network commands. These candidates still require corpus evidence before they can be called faithful. An element visible in the browser editor is not automatically AI-editable.

## Fidelity language

- **Structurally valid** means the edited package opens and only allowed package parts changed.
- **Visually reviewed** means before/after renders were supplied to the review loop and its evidence was internally consistent.
- **PowerPoint-faithful** requires comparison against a PowerPoint reference corpus on supported operating systems. LibreOffice-to-LibreOffice similarity does not prove it.
- No aggregate pixel score may hide text reflow, missing content, changed pagination/slide count or a broken editable object. Those are hard failures.

The prerelease can be promoted to beta only with published corpus coverage, pass/fail thresholds and a list of known unsupported constructs, plus the operational evidence required by the release gates.
