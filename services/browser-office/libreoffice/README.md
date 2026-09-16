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

The cumulative `browser-undo-v28` source series ports generic document behavior:
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
Native CppUnit targets and the WASM link each write a completion marker only
after success, so a failed step resumes from its existing object files instead
of restarting the preceding hour-long work. A root belonging to another source
or patch identity is rejected rather than cleaned implicitly. The output holds
the four raw runtime assets, Brotli serving variants and a receipt binding their
hashes to the exact public source, LibreOffice, patch-series, Emscripten and Qt
identities. Native tests use the source language only; the Korean translations
needed by the browser build are fetched at the exact superproject gitlink with
depth one, avoiding a full translation-repository history on every clean build.
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
