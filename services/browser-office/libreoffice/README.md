# Browser LibreOffice source line

The browser runtime and the server Collabora runtime are two builds of
LibreOffice with different upstream ABIs. They share product invariants and the
JavaScript operation program, but they do not share binary patches blindly.

`../upstream.json` pins the exact ZetaOffice source commit, Emscripten fork,
Qt superproject and QtBase commit. The ordered patch series in `patches/` is
rebased against that exact browser source. `patchSeriesReady` means only that
the complete series applies without fuzz. It does not mean the WASM binary has
been built or promoted; `buildReady` remains false until the complete command,
Undo, save/reopen, visual and PowerPoint evidence is attached to one immutable
browser build.

The cumulative `browser-undo-v29` source series ports generic document behavior:
table structure, formatting and Undo; page and object identity; master-safe
layout support; sparse-master insertion; object-creation Undo; text-layout
invalidation; slide names and text shadows; object locks; object interactions;
editable placeholder inheritance; and native Undo for public UNO page and
object property writes. It also routes rotation, line color, line width and
fill/line transparency through bounded UNO property writes because the
equivalent stock WASM edit/Undo sequence can stop without a completion
response. Text size, family, weight, posture, underline, strikeout, color and
paragraph alignment likewise share one bounded text-property transaction
instead of mixing property writes with UI dispatch commands. The page/object
tests cover one-step Undo/Redo and PPTX save/reopen for slide names, visibility,
transition state, slide metadata, text margins, paragraph formatting, line
dash/arrow styles, shadows and object locks. The first `browser-undo-v20`
native candidate ran 18 focused regressions and failed seven; `0016` corrects
the observed export, text-cache, animation, media and headless-test boundaries.
Patch `0017` verifies that a named dash also changes the visible line-style
mode and checks dash and marker geometry, not LibreOffice-only palette names,
after PPTX save/reopen. The `browser-undo-v23` candidate compiled but failed
two focused native tests. Patch `0020` bounds the one-unit character-spacing
conversion and removes an invalid empty line-dash name from test setup.
The `browser-undo-v24` build failed one focused marker test: the test registered
`PointSequence` values that the native marker table silently discarded. Patch
`0021` supplies the `PolyPolygonBezierCoords` geometry used by both the table
and shape line properties, and checks the same type after PPTX reload.
The `browser-undo-v25` build failed on fixed slide-date visibility in the same
round-trip test. Source inspection found the fixed-date placeholder import path
does not restore page metadata. Patch `0022` restores it, matching the server
engine's fixed-date rule. Patch `0023` preserves automatic slide timing in
milliseconds even when no visual transition effect is selected.
Patch `0024` adds the missing DrawingML right-margin export and asserts the
saved `marL`/`marR` attributes separately from UNO's post-import fields,
which may represent list indentation in numbering rules. This source fix is
not a compiled or runtime-verified release.
The `browser-undo-v27` source series compiled, then failed one native
round-trip assertion: a fixed-date placeholder returned the default inactive
`DateTimeFormat` after PPTX reload. OOXML stores a fixed date as literal text,
without a live-date format field. `browser-undo-v28` keeps the edit and Undo
assertion for that property, but treats only the fixed text and visibility as
portable after reload. The revised source series still requires a native test
pass; it is not promoted.
The `browser-undo-v28` Cloud Build reached all focused native tests and failed
one saved-OOXML assertion: a paragraph with nondefault margins still skipped
the entire DrawingML paragraph-properties element before the right-margin
writer ran. Patch `0025` extends that generic emission condition to paragraph
spacing, indents, direction and direct tab stops, and tests a paragraph with
only a right margin. `browser-undo-v29` passed all 18 focused native tests.
Its first WASM build could not open a PPTX: the upstream WASM default enables
Calc and Writer but strips Impress/Draw, so its package omitted the Impress UI
assets. The build now explicitly requests `calc writer impress`, checks the
configured module state, and refuses a receipt or admission when the produced
package lacks those assets. A corrected browser product run is still required.
The `browser-undo-v30` source series adds five fixes found by that product
run. Patch `0026` keeps a slide's visual transition when it also advances
automatically: the automatic-advance branch had marked the whole transition as
read, so the effect was dropped on reload. Patch `0027` sets an existing
animation effect's duration, delay and start mode as one native Undo step.
Patch `0028` makes attribute Undo and Redo on a text object restore the saved
object items exactly; applying the saved set first copied the other state's
first-paragraph attributes back into the object, so undoing a shadow applied
to the selected object left it at object level. Patch `0029` writes semantic
SmartArt edits to the saved data model: export previously wrote the data
captured at import, so node text, added nodes and removed nodes were lost on
reload. Only changes made since the first edit are applied, an unedited or
fully undone diagram is written as imported, and the stale cached drawing is
not written. Patch `0030` exposes the WordArt shape type as a read-only shape
property because the browser bridge cannot read custom-shape geometry. Patch
`0031` raises the WASM main-thread stack from 128 KiB to 8 MiB and other
thread stacks from 64 KiB to 1 MiB: UNO scripts run on the proxied main
thread, and loading, exporting and observing documents there overflowed the
stack into its thread-local data, so a session aborted after about a dozen
native edits. The first v30 build passed 21 of 22 focused native tests; the
SmartArt test exposed a unoxml clone that belongs to no document, fixed by
moving the node instead. The second v30 build passed all 22 and 8 of the 12
browser scenarios.
The `browser-undo-v31` source series fixes what the other four found. Patch
`0032` writes a SmartArt frame with the shape's own id, name and alternative
text: export numbered the frame by its diagram, which gave the first diagram
id 1 (the shape tree's own id) and the name "Diagram1" and dropped its
alternative text. Patch `0033` duplicates an object inside the engine with
one native Undo action, because the browser runtime has no system clipboard
and Copy and Paste inserted nothing. Patch `0034` gives a PPTX paragraph
without `marR` no right margin; inserting a paragraph copied the previous
paragraph's attributes, so its right margin carried over on import. Patch
`0035` makes replacing an animation effect scale the new preset's animations
to the kept duration; the effect had kept its stored duration while playing
at the preset's own timing.
Patch `0036` keeps the alignment of a shape without text: import holds an
empty paragraph's alignment on the shape, and export now writes it from there
instead of from the empty paragraph, which does not carry the shape's own
attributes, so every empty PowerPoint shape lost its centring on save. Patch
`0037` exposes every custom shape's type as a read-only shape property, which
the browser needs to observe a shape's geometry at all. Patch `0038` saves a
connector with the exact size between its end points; the box was built from
the closed rectangle between them, so every save grew the connector by one
unit each way.
Patch `0039` adds the write-only shape properties `SpellbookFreeformPolygon`
and `SpellbookFreeformPolyline`, which give a custom shape the freeform
geometry PPTX import creates for `a:custGeom`: a freeform built as a
LibreOffice polygon reopened as a different object, and the browser bridge
cannot write custom-shape geometry itself. Patch `0040` writes a table cell's
top and bottom margins to `a:tcPr`, where import reads them; only the left and
right margins were written, so the others changed on reopen.
The browser-native adapter now accepts the complete
97-operation typed mutation contract and persists both its commands and direct
human edits as native PPTX snapshots. The cumulative patch also preserves
object identity while replacing image or media content and adds semantic
SmartArt and Math mutation, media playback, Fontwork, 3D material and
reading-order history. Patch `0013` verifies the PPTX/PowerPoint rule directly:
portable reading order follows shape-tree/z-order, survives one native Undo
boundary and persists through save/reopen. Patch `0016` also makes live shape
effects authoritative over imported effect metadata and exports effects for
the basic shape families, not only custom/text shapes. The clean native and integrated browser runs remain the
admission evidence. `nativeSlideStructureReady` is
independent of `buildReady`: a compiled runtime must also survive the product
bridge's full slide lifecycle, observation, Undo/Redo, recovery and exact-save
checks before it can claim safe native structure editing. Collabora transport
handlers remain deliberately absent.

The focused native regressions create and reload the presentation model through
`XLoadable` without a desktop frame. This keeps document-model, Undo and OOXML
checks independent of the pinned headless build's unrelated `ViewTabBar`
lifecycle; the real canvas and controller remain covered by the subsequent
browser product-bridge endurance run.

The browser's native-snapshot admission uses the same model-only principle:
load the serialized PPTX through `XLoadable` in a separate UNO document model,
observe its saved semantics, then dispose it without replacing the visible
editor frame. A stock-WASM probe reopened both an untouched and an edited
one-slide file in about 0.7 seconds while retaining the live revision. That
probe does **not** establish safe Undo afterward: the older stock runtime
still aborted during repeated product Undo. The pinned candidate's product
bridge and endurance run must prove the combined reopen-and-Undo sequence.

Verify every source edit before starting the expensive build:

```sh
pnpm browser-office:engine:verify -- --source /absolute/path/to/libreoffice-core
```

Build the admitted series from the pinned Linux, Emscripten and Qt toolchain:

```sh
docker buildx build \
  --platform=linux/amd64 \
  --file services/browser-office/libreoffice/Dockerfile.toolchain \
  --tag spellbook-browser-office-toolchain:v8 \
  --load .

docker run --rm --user=1000:1000 \
  --volume "$PWD:/workspace:ro" \
  --volume "/absolute/build-root:/build" \
  --volume "/absolute/output:/output" \
  --env SPELLBOOK_SOURCE_REVISION="$(git rev-parse HEAD)" \
  --env SPELLBOOK_BROWSER_BUILD_ROOT=/build \
  --env SPELLBOOK_BROWSER_OUTPUT_DIR=/output \
  spellbook-browser-office-toolchain:v8 \
  /workspace/services/browser-office/libreoffice/build-candidate-runtime.sh
```

The build root is deliberately external and keyed by the patch-series hash.
It must be a persistent disk, not Cloud Build's disposable `/workspace`:
Cloud Build removes that directory after a failed job, so retries there repeat
the full native compile. Keep the build root, tarballs and compiler cache on a
stoppable build VM; copy the cache into a new patch-level root when the source
series changes, and stop the VM when no build is running.
Native CppUnit targets and the WASM link each write a completion marker only
after success, so a failed step resumes from its existing object files instead
of restarting the preceding hour-long work. A root belonging to another source
or patch identity is rejected rather than cleaned implicitly. The WASM module
configuration has its own marker; changing it reconfigures the preserved build
tree and reuses its compiled objects rather than treating the prior stripped
runtime as complete. An unchanged configuration does not rerun configure.
LibreOffice's recursive build can refresh the packaged filesystem after the
browser executable is linked. The finalization pass completes `scp2`,
`static` and `desktop` in that order only when the linked executable and
package disagree; an already consistent pair is reused without relinking.
The receipt then checks that every
packaged file's parent directory is created by the executable JavaScript;
only a passing receipt marks finalization complete. Output assembly reads the
linked executable from `instdir/program` and the data from the static package
target, not from an earlier installation staging copy. The output holds
the four raw runtime assets, Brotli serving variants and a receipt binding their
hashes to the exact public source, LibreOffice, patch-series, Emscripten and Qt
identities and the required `calc writer impress` module set. Native tests use
the source language only; the Korean translations
needed by the browser build are fetched at the exact superproject gitlink with
depth one, avoiding a full translation-repository history on every clean build.
The preserved build root caches Brotli output by raw SHA-256. Before reuse,
the cached stream is decompressed and compared byte-for-byte with the current
raw artifact; changed bytes fall back to compression.
Building does not set `buildReady`; promotion still requires the integrated
product, endurance, fidelity and PowerPoint gates.

Run the candidate through the real product bridge without changing the tracked
promotion manifest:

```sh
pnpm browser-office:prepare
node services/browser-office/verify-product-bridge.mjs \
  --candidate-runtime /absolute/output \
  --endurance-cycles 100 \
  --output artifacts/browser-office/candidate-v8

pnpm browser-office:verify:native-conformance -- \
  --candidate-runtime /absolute/output \
  --output artifacts/browser-office/candidate-v8-native

pnpm browser-office:verify:candidate-powerpoint -- \
  --browser-evidence artifacts/browser-office/candidate-v8 \
  --native-conformance artifacts/browser-office/candidate-v8-native/conformance-report.json

pnpm browser-office:promote:candidate -- \
  --candidate-runtime /absolute/output \
  --browser-report artifacts/browser-office/candidate-v8/result.json \
  --native-conformance artifacts/browser-office/candidate-v8-native/conformance-report.json \
  --powerpoint-report /absolute/candidate-powerpoint-run/result.json \
  --output artifacts/browser-office/candidate-v8/promotion-receipt.json
```

This verifier accepts only the four raw artifacts whose byte lengths and
SHA-256 digests match `build-receipt.json`. It also requires the receipt's
LibreOffice commit, patch-series digest and complete toolchain identity to
match `upstream.json`. The resulting in-memory `buildReady` identity exists
only in that verification server; the tracked manifest remains fail-closed
until all promotion evidence passes. The product bridge keeps one browser and
document session alive for 100 edit/history/save cycles, while the native
conformance command reuses the same 15 scenario programs and fixtures that
exercise all 97 typed operations in the browser.
Each scenario requires apply readback, Undo/Redo, save/reopen and its declared
OOXML change budget; a command name advertised by the adapter is not evidence.
The endurance loop performs edit, observation, Undo, restored-state
observation, Redo, observation, final Undo and save acknowledgement; periodic
exact-byte checks prove that the final Undo restored the original package.
The PowerPoint follow-up refuses a partial browser report, re-hashes the saved
PPTX, runs the Open XML SDK validator, opens both source and candidate in native
Microsoft PowerPoint, checks their slide counts, extracts the saved text from
PowerPoint's PDF and requires a visible but bounded pixel delta. It does not
treat a ZIP-level validation as proof that PowerPoint can consume the
candidate.
The final command writes `verified_not_published` evidence only when the raw
runtime, browser report and PowerPoint report all identify the same build
receipt and saved PPTX. Publishing the bytes and changing the tracked
`buildReady` flag are separate release actions, so a partially verified build
cannot become the default through this script.

General document fixes must be represented in both LibreOffice source lines or
explicitly proven unnecessary on one line. Collabora-only transport commands
are not copied into ZetaOffice: the browser calls the same bounded operation
program directly through ZetaJS and UNO.
