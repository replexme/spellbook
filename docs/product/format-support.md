# Format support

This page is the user-facing support truth. “Planned” means architecture only, not an upload promise.

| Format                 | Status                        | Direct browser editing | AI observation/edit/review           | Editable download |
| ---------------------- | ----------------------------- | ---------------------- | ------------------------------------ | ----------------- |
| PowerPoint `.pptx`     | Prerelease under verification | Impress (browser WASM / WOPI)   | Implemented for supported operations | Implemented       |
| Word `.docx`           | Planned                       | Not exposed            | Not implemented                      | Not exposed       |
| Spellbook `.spellbook` | Planned                       | Not implemented        | Not implemented                      | Not exposed       |

## PPTX prerelease scope

The engine currently inspects text boxes, shapes, pictures, connectors, groups and graphic frames; records geometry, z-order, text, fonts and support warnings; and supports the operations declared in `contracts/native-edit-capabilities.json` and `contracts/edit-target-capabilities.json`.

The native mutation model classifies 98 operations, of which 94 bounded operations are exposed to the AI tool schema. Registry status: 63 runtime-verified; 31 engine candidates (`undo-v31`). These are existing registry classifications and have not been promoted by the new local runs. All 94 have passed local browser execution across 13 object families, including native Undo/Redo, scoped package-change checks and save/reopen. These checks establish the tested local behavior; they do not establish PowerPoint fidelity or release readiness.

Four operations are not exposed. Three are excluded because PPTX cannot keep their result: the per-shape printable flag has no PresentationML equivalent, LibreOffice 3-D material properties apply only to LibreOffice 3-D scene objects, and Office Math equations import as fallback pictures in the pinned engine. Authored PowerPoint 3-D effects and equation fallback pictures remain preserved. Media playback configuration is outside the product scope; media source bytes and geometry must still persist.

The verified browser candidate is `browser-undo-v35`. Its build retains media support and can insert and replace audio/video. WordArt editing changes the PowerPoint transform preset (`a:prstTxWarp`), which LibreOffice stores as the matching Fontwork shape type. Execution is bound to the current document permission and admitted engine patch level. Source implementation, local runtime verification and release verification remain separate states.

Changing letter case writes what PowerPoint writes. PPTX keeps only “all caps” and “small caps” as a character effect, so lowercase and word capitals change the letters themselves, the way PowerPoint's own Change Case does, and keep each run's formatting. A text language is kept on the run it was set on, in the locale of that run's script, which is the one PPTX stores and reads back.

Setting a slide duration also enables automatic advance. PPTX stores that active interval as the transition's [`advTm` value in milliseconds](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.transition?view=openxml-3.0.1); a manual-advance slide does not retain a separate inactive duration through save and reopen.

The file is rejected or marked with warnings when the engine cannot safely promise its behavior. The bounded candidate edits semantic SmartArt nodes, internal chart data and formatting, media content and selected renderer effects without exposing arbitrary OLE, external workbooks, macros, file access or network commands. These candidates still require corpus evidence before they can be called faithful. An element visible in the browser editor is not automatically AI-editable.

## Fidelity language

The current browser corpus includes a SmartArt import with overlapping labels and missing connector lines before any edit. Local apply, Undo/Redo and save/reopen checks do not establish visual fidelity. Direct movement of the tested imported SmartArt now passes save/reopen while keeping the original diagram parts and all other package parts unchanged. The import display defects remain. A different or unobserved object structure still causes the edit to be refused; local preservation does not establish visual fidelity.

- **Structurally valid** means the edited package opens and only allowed package parts changed.
- **Visually reviewed** means before/after renders were supplied to the review loop and its evidence was internally consistent.
- **PowerPoint-faithful** requires comparison against a PowerPoint reference corpus on supported operating systems. LibreOffice-to-LibreOffice similarity does not prove it.
- No aggregate pixel score may hide text reflow, missing content, changed pagination/slide count or a broken editable object. Those are hard failures.

The prerelease can be promoted to beta only with published corpus coverage, pass/fail thresholds and a list of known unsupported constructs, plus the operational evidence required by the release gates.
