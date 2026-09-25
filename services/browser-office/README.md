# Browser Office runtime

This directory builds and verifies the browser editor: LibreOffice compiled to
WebAssembly, run in the user's browser. The managed Spellbook service serves it
on its own site and has made it the default editor (2026-09-26).

The first real browser probe used the official ZetaOffice Web Office demo and
proved this vertical with a PPTX: load, show an editable Impress canvas, insert
a slide, save, undo the insertion, save again, and reopen both outputs in
Microsoft PowerPoint. The probed binary identifies itself as ZetaOffice 24.2 at
LibreOffice commit `efaf0670b4d055f838a2849becb10f08aa06a257`; it is not the
same source line as Spellbook's current server-side Collabora engine. The
current cumulative browser source candidate is pinned separately in
`upstream.json`; the stock proof identity remains distinct from that patched
source and does not make whole-file OOXML rewriting acceptable.

[`upstream.json`](./upstream.json) pins that exact source identity, ZetaJS
identity, wire bytes, and browser isolation headers. The upstream URL contains
`latest`, so its name is not trusted: every downloaded byte must match the
manifest before it can be hosted.

The candidate source line also pins the Allotropia Emscripten and Qt commits
and a browser-specific patch series. The first admitted patch carries four
generic native invariants already proven on the server engine: table-cell Undo,
page-background Undo, real slide-name Undo, and object identity across slide
moves. Collabora-only JSON command plumbing is intentionally excluded because
ZetaJS calls the shared bounded operation program through UNO directly. See
[`libreoffice/README.md`](./libreoffice/README.md) for the source boundary.

```sh
pnpm browser-office:fetch
pnpm browser-office:serve
pnpm browser-office:verify
pnpm browser-office:verify:powerpoint
```

The command writes ignored runtime artifacts to `runtime/`. The `.wasm` and
`.data` responses are stored as Brotli bytes and must be hosted under their
original request names with the declared `Content-Type`, `Content-Encoding:
br`, CORS, CORP, and immutable cache headers.

The tracked shell now owns the canvas and two distinct workers. ZetaOffice is
the visual interaction engine; `ooxml-worker-source.mjs` applies the slide
structure command family (`add_slide`, `duplicate_slide`, `move_slide`,
`delete_slide`, `rename_slide`, and `set_slide_hidden`) directly to the
original package. The four topology commands share one
relationship-graph implementation: owned dependencies are cloned, reusable
layout/theme/media parts stay shared, and unreachable owned parts are removed.
The two metadata commands modify only the selected slide part and remain safe
when sections or custom shows prevent topology changes.
This separation is mandatory. A stock ZetaOffice `store()` round trip was valid XML
and reopened in PowerPoint, but rewrote untouched slide, layout, master, theme
and font data. Spellbook therefore never promotes that whole-file output as
the authoritative PPTX.

The browser worker also adapts ZetaJS to the same fixed
`spellbookDocumentOperation` program used by the Collabora extension. The
headless browser gate opens a real two-slide PPTX, observes its slide and
element model, navigates from the active slide to a different target through a
ZetaJS UNO adapter, replaces text there through the bounded `replace_text`
command, and verifies native Undo restores the original revision. The adapter
fails closed for every typed transform that has not yet earned browser Undo and
save/reopen evidence; it never reports the Collabora-only
`TransformDocumentStructure` command as a browser capability. This proves that
browser and server engines can share one AI command implementation instead of
accumulating two feature-specific code paths. It does not claim full browser
parity: commands whose contract requires a Spellbook engine patch remain
unavailable on the stock ZetaOffice binary.

The browser-native transform adapter is a fail-closed registry rather than a
second operation program. Its candidate implementation covers slide names,
visibility and transitions plus bounded object metadata, text-box geometry,
shadows, locks, crop and click interactions. It preflights the complete command
list, follows slide navigation without mutating during validation, groups the
write into one native Undo context and rolls the context back on failure. These
operations are advertised to the shared program only when the pinned runtime's
build commit equals the candidate source commit, the patch-series identity is
present and `buildReady` has been promoted. The current stock
binary therefore advertises none of these candidate-only operations.

Slide structure has a separate admission flag. The stock browser binary can
duplicate and move a slide in isolated probes, but deleting a slide and then
observing its shapes traps in WASM with an unaligned atomic access. Reopening
multiple package candidates in the same runtime can likewise end in an
out-of-bounds access. The product bridge therefore rejects all six slide
structure operations before mutation while `nativeSlideStructureReady` is
false; partial success is not advertised as product support. The product
verifier asserts both the rejection and the unchanged document revision. A
future runtime may set this flag only after the full add/duplicate/move/delete/
rename/hide sequence, native observation, Undo/Redo, reload recovery and exact
package save all pass in one browser session.

Browser candidates and their replayable command journal are checkpointed in
OPFS with two alternating slots. Each slot writes the base package and
candidate before a checksummed metadata commit record; recovery ignores a
partial or corrupt newest slot and falls back to the preceding valid
generation. The conformance run reloads the page after all six mutations,
recovers the candidate and Undo history from OPFS, and only then performs the
six-step Undo and reopen checks.

The cumulative candidate implements the complete 97-operation source contract,
including semantic diagrams, equations, image/media insertion and
identity-preserving replacement, media playback, Fontwork, 3D materials,
reading order and animation lifecycle. Media playback settings change in the
editor but LibreOffice's PPTX filter does not save them, so the save check
refuses that edit.

Status on 2026-09-25: Korean, Japanese and Chinese input methods work through a
hidden text field over the canvas (`text-input-bridge.mjs`), and a production
smoke typed Korean, saved it automatically and undid it from the host's top
bar. The product bridge, including OPFS recovery and the slide lifecycle,
passes in Cloud Build. The page sets `SAL_VCL_QT_USE_QFONT` before the engine
starts: LibreOffice's Qt layer otherwise draws text with cairo and never
registers the Korean fonts with Qt, so the menus, context menus and tooltips
drew Korean as boxes. Accessibility checks, public-corpus render
comparison and the PowerPoint platform matrix are not done, so `status` stays
`viability_probe_only`. Browsers that cannot isolate the editor frame are
refused rather than served by the server editor.

For direct human edits and native AI transactions, the browser now keeps the
uploaded package as the file authority. It serializes the edited model, also
exports a model-only no-edit baseline, and applies only their package-part
differences to the uploaded bytes. Regenerated DrawingML field GUIDs do not
count as authored changes. The merged package must reopen to the intended
model state; unresolved relationship remapping fails closed. This path is
source-implemented, not runtime-verified until the candidate product bridge
and original-part preservation check pass.

The Spellbook-owned conformance shell is available at
`http://127.0.0.1:4173/?autorun=1`. It loads the tracked public PPTX fixture,
adds, duplicates, moves, deletes, renames, and hides slides through the OOXML
worker, reopening every candidate in the canvas. It then undoes all six
mutations and reopens the restored original. The page reaches
`body[data-state="complete"]` only when
the slide-count, saved-hash, and lifecycle invariants pass. This is a
development gate, not yet the product editor.

`browser-office:verify` launches a headless local browser, asserts isolation,
slide counts and a strict logical package-change budget, and writes both PPTX
files, a screenshot and machine-readable timing evidence to
`artifacts/browser-office/latest/`. Untouched ZIP parts must retain identical
uncompressed bytes and Undo must restore every original part. It does not
promote the browser runtime; the screenshot and PPTX outputs still need the
same visual and PowerPoint inspection required of the server engine.

`browser-office:verify:powerpoint` follows that browser run with native
PowerPoint reopen/export. It verifies slide counts and pixel-identical identity,
move, delete-round-trip, and Undo mappings across the generated files. Run it
only on a macOS host with PowerPoint and no unrelated presentation open.

Candidate promotion may run from a later integration commit than the expensive
WASM build when intervening commits affect only another engine, product layer
or documentation. That exception is evidence-bound rather than assumed:
promotion compares immutable Git objects for the manifest, toolchain recipe,
build scripts and complete patch directory at the build and integration
revisions. A changed build input fails; a README-only edit does not demand a
new LibreOffice compile. The promotion receipt records both revisions, every
input object and the exact equivalence result.

Upstream references:

- <https://github.com/allotropia/zetajs>
- <https://git.libreoffice.org/core/+/refs/heads/distro/allotropia/zeta-24-2>
- <https://git.libreoffice.org/core/+/refs/heads/master/static/README.wasm.md>
