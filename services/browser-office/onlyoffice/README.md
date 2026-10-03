# ONLYOFFICE browser comparison patches

These patches are local research candidates. They do not change the production
engine or admit the candidate as supporting the Spellbook document contract.
The comparison objective is a shared observation/edit/save/recovery contract,
original PPTX preservation, useful responsiveness, and verified output quality.

Apply in filename order to `agentbridges-ai/onlyoffice-browser` at
`d15d12b6945be4d8b0f3aa1806120e740d2950ee` (0.3.34, SDK 9.3). Patched local
candidate commits are `1872b4e`, `60b6109`, `1317f56`, `ded5281`, `e6165f7`,
`3b6e983`, `d288ebb`, and `98bece7`. The upstream component and SDK
are AGPL-3.0; these patch artifacts retain the upstream licensing context.

- `0001-version-bound-save.patch`: persistence acknowledges an exported native
  snapshot and immutable media references. The runtime alone clears dirty after
  matching that snapshot to the current native export; missing readback keeps
  dirty. Returning to preview cannot remount an older saved file over later
  edits. Native serialization is a conservative fallback, not a complete
  low-cost edit-generation interface or proof about mutable external resources.
- `0002-group-alternate-content.patch`: the pinned slide group decoder delegates
  child reading to the same alternate-content reader used for top-level objects.
  Primary and fallback records consume one child slot. Later siblings survive,
  and unsupported primary objects still select their fallback. Only generated
  SDK assets are patched; their input digest is checked and upstream files stay
  unchanged. Build the runtime first, then `npm run build:lib`, because the full
  runtime build recreates `dist`.
- `0003-native-export-clock-identity.patch`: the 9.3 presentation writer creates
  a fresh modification timestamp on every read. Content identity excludes only
  that known generated core attribute; every other native byte is compared.
  Unknown versions, attributes and malformed records cannot clear dirty. This
  fixes the follow-up real test in which even the latest successful save stayed
  dirty. It does not prove properties that this engine never serializes.
- `0004-smartart-new-node-connection-map.patch`: the native SmartArt layout
  algorithm previously dereferenced a missing source group when a newly added
  semantic node had no presentation relation yet. It now creates that relation
  through the existing native history setters. The generated SDK input must
  match the exact group-patched digest; public upstream files stay unchanged.
  Both an unpatched-input exception and native relation retention are regression
  tested. This fix alone does not construct or validate a complete diagram graph.

- `0005-smartart-generated-connector-path-and-style.patch`: generated open
  connector paths no longer inherit polygon fill. Native path setters retain
  Undo/Redo. New parent/sibling transition presentation points defer their
  unspecified style to the existing routing algorithm, instead of choosing a
  generic node style which makes new organization-chart connectors white.
  Explicitly authored styles and content-node fallbacks remain unchanged.
  Both defects were observed in actual added-node screenshots and saved XML;
  corrected output was reopened and visually reviewed. These are separate from
  the missing relation-map guard in `0004`. The exact pinned input digest is
  checked separately at each generated-asset step.

- `0006-chart-numeric-point-native-recalc.patch`: a numeric cache point changed
  native history but had no recalculation hook. History rebuilding clears the
  earlier drawing map, so the live canvas stayed stale while export/reopen used
  the new data. The point now invokes its owning chart's existing data update
  invalidation when its value changes, including Undo/Redo. Other history types
  and detached points are unaffected. The generated SDK input is digest-bound;
  unit tests, a full runtime/library build and actual visible-canvas history
  replay were verified. This does not make cache-only chart editing complete:
  the embedded workbook must still change in the same native history point.

- `0007-native-field-cache-transaction-and-settled-save-state.patch`: grouped
  edits now record both generated field text and the master/layout rendering
  slide index through native history changes. Undoing text alone left the index
  changed, so cancellation's recalc wrote the wrong cached slide number again.
  Ordinary paint retains upstream no-history behavior. Exact generated input
  and six drawing boundaries are checked; history-type collisions fail closed.
  A clean notification arriving before paint receives one delayed comparison
  against the acknowledged native bytes and media identity. Later changes,
  another acknowledged save, and teardown invalidate that check. Readback
  failures retain dirty state. These changes restore the actual layout-switch
  cancellation's complete native identity and host saved state, without
  rewriting history arrays or excluding generated fields from byte comparison.
  Whole-product permission, existing Redo preservation, and admission remain
  separate gates.

Local evidence is recorded in the private product delivery report and under
`/private/tmp/present-engine-comparison-20261001/improved-comparison`. User files,
captured document contents, and screenshots must remain outside Git. Run all
browser trials sequentially, headless, on loopback and at low process priority.

Remaining adoption gates include original-part/object binding, independent
PPTX format errors, the complete product command/rollback contract, full save
timing, and visible output review. Passing the candidate's component tests or
same-engine reopening does not satisfy these gates.

## Experimental structural output boundary

`verify-onlyoffice-comparison.mjs --repair-structure` invokes the shared
`repairCandidatePptxStructure` helper in the diagnostic host browser before
capturing its persisted artifact. It records each changed part and repair time.
This does not alter production admission, the component's raw returned File,
or the native snapshot used for dirty-state reconciliation.

The helper keeps all package parts. It removes an extra presentation theme
relationship only when original and candidate master ownership give a unique
answer; ambiguous ownership is rejected. It corrects the known diagram-drawing
MIME only after checking its XML root, orders known chart children without
changing values/content, and removes SmartArt frame child coordinates only for
an identity mapping (zero child offset, equal positive extents). Unknown chart
children and non-identity frame mappings are rejected. No missing content is
invented and no original-part preservation is implied.

Decision-driving format references are the [Microsoft PresentationML package
structure](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document),
[DataLabels schema](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.charts.datalabels?view=openxml-3.0.1),
[graphic-frame transform](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.transform?view=openxml-3.0.1),
and the Open XML SDK chart-style schema. The pinned ONLYOFFICE core
`v9.3.0.140` writer emits the duplicate theme relationship and incorrect diagram
MIME; the repair is an adapter experiment while those native defects remain.
Independent SDK validation, actual repaired-artifact reopen, visual review,
and complete product-contract checks remain required.

`--readback-state <captured-intent.json> --scenarios roundtrip` runs only a
read-only reopen of an existing package and compares it with that file's
captured `edited` projection. It writes no artifact and records zero host
writes. `--readback-slide <index>` selects the page for its screenshot. Kinds,
text and geometry are covered; full style/source bindings are not implied.
Regular edit trials also select the original edited page before the reopened
screenshot, so newly added slides are visually compared on the same page.

## Typed native comparisons

`verify-onlyoffice-typed-comparison.mjs --input <fixture.pptx> --output <private-directory>
--candidate-root <patched-component> --origin <loopback-preview> --typed-case <case>`
runs representative text/table/chart/layout/image/SmartArt/WordArt mutations,
one native Undo and Redo, the actual source-preservation save callback, and a new
editor session reading the saved artifact. It shares the diagnostic component
host and save pipeline with `verify-onlyoffice-comparison.mjs`; the two runners
do not keep parallel callback implementations. Screenshot and package outputs
stay outside Git. These representative cases are not the complete 94-command
product contract, permission/preflight/failure rollback, or server acknowledgement.

Readback includes authored names, image crop and semantic SmartArt text/parent
connections alongside displayed drawing text. `GetName` creates a transient
display name when no name was authored, so `getOwnName` is used for persistent
name comparison. Explicitly requested WordArt names are applied after slide
registration and verified, rather than ignored. Image crop uses the pinned
native `setSrcRect` history path. SmartArt text edits follow the unique native
drawing-to-content-node binding; graph changes include the parent/sibling
transition points and rebuild the derived layout cache. A successful setter,
data-only edit, or public API list cannot substitute for the displayed and
saved state checks.

SmartArt add/delete cases additionally assert the requested parent, normal node
kind, precise node count and retention of every unrelated semantic node. Local
candidate trial requests to external HTTP(S) hosts are blocked and counted.
The runner records the actual generated SDK digest as well as both repository
identities; dirty trial results are never substituted for clean-commit evidence.

The native connector changes were checked against the pinned [SmartArtTree
source](https://github.com/ONLYOFFICE/sdkjs/blob/v9.3.0.140/common/SmartArts/SmartArtTree.js).
The reviewed master source still had the same filled path and generic new-node
fallback on 2026-10-02. This source inspection is not a trial of a newer released
SDK; the runtime comparison remains pinned to 9.3.0.140.

The chart-data case checks both the displayed series cache and the actual
embedded XLSX. In this SDK `SetSeriaValues` updates the cache alone. The
diagnostic adapter prepares an owned numeric-cell snapshot, serializes it with
the native spreadsheet writer, and installs it with `setXLSX` in the same
native history point as the series edit. Temporary spreadsheet sessions run
sequentially in the same headless browser and have no persistence callback.
They respect the component's single-editor origin isolation. Preparation time
is recorded separately; this diagnostic path is not production admission or
a chart-edit performance claim.

The shared package boundary binds a renamed workbook to a unique authored
chart frame and its internal `externalData` relationship. For a same-engine
delta consisting only of numeric constant cells, it applies those values to
the author's workbook and retains every other nested part byte for byte.
Worksheet ownership, cell addresses and baseline values must agree. Formula,
style, ambiguous-owner and unknown-content changes cannot take this narrow
merge path. The runner checks the complete saved workbook payload and exact
native workbook restoration on Undo and Redo, in addition to saved-artifact
reopening. A cache-only readback does not satisfy this case.

The diagnostic save host captures source intent, the authored package and its
matching no-edit export before starting a save. It allows one persistence
request at a time; another save is rejected while editing remains available.
Worker replies are dispatched by request ID rather than replacing a shared
message handler. Only a successful persistence callback advances the authored
package and native baseline together. Failed saves keep the accepted baseline.

`--preserve-source --scenarios late-save-ack` exercises this full path: duplicate,
hold persistence, edit again, change the next intent, reject an overlapping save,
release the old acknowledgement, then save the latest revision. It verifies
dirty state, native history and both reopened artifacts. A captured duplicate
source index disambiguates identical slides only after complete native slide
content matches; it cannot authorize a mismatching source. The comparison host
requires its explicit programmatic save boundary and is not production admission
or an implementation of every native toolbar save route.

Chart-data verification also hashes the actual visible slide canvas. Edited
pixels must differ from the original; Undo must restore the original pixels,
and Redo and reopened pixels must match the edited pixels exactly. The local
numeric-point history patch supplies the missing native `Refresh_RecalcData`
hook through the owning chart's existing data invalidation lifecycle. This
fixes apply and history replay without changing workbook contents or adding a
manual redraw to the test. Its generated SDK bytes are digest-bound like the
other candidate patches. The pinned [chart format source](https://github.com/ONLYOFFICE/sdkjs/blob/v9.3.0.140/common/Drawings/Format/ChartFormat.js)
provides `CNumericPoint.setVal` and the parent numeric-cache history lifecycle.
The pinned [native history source](https://github.com/ONLYOFFICE/sdkjs/blob/v9.3.0.140/word/Editor/History.js)
rebuilds drawing recalculation data through the recorded object's hook.

Every typed trial captures all slides before editing, after editing and after
reopening, and requires pixel identity for untargeted slides. This selects and
renders each page rather than treating a lazy thumbnail as evidence of lost
content. First-slide non-chart visual review remains a separate requirement;
these screenshots do not turn representative setters into complete operation
contracts.

The typed diagnostic adapter uses the pinned SDK's native group-action boundary
for commit/cancellation. `--fail-after-apply` injects an exception after the real
mutation and its postconditions, before any save. Success requires restoration
of the complete observed document, every slide's visible pixels, canonical
native bytes and saved-state flags, host ready/dirty/error, native history and
released locks, with zero persistence callbacks. Each typed case inherits
this boundary rather than implementing its own rollback. A rollback error is a
failure and cannot become an expected-failure pass.

This remains diagnostic, not product admission. A pre-existing Redo branch is
refused unless the native provider declares the reviewed group rollback
capability. Patch 0013 connects the provider's existing SaveRedoPoints and
PopRedoPoints to its own group lifecycle, restores saved-state flags on cancel,
and releases retained references on commit or native history clear. The adapter
never rewrites the native history arrays. Unknown/nested group state cannot
cancel someone else's history.
The official [CreateNewHistoryPoint API](https://api.onlyoffice.com/docs/office-api/usage-api/presentation-api/ApiPresentation/Methods/CreateNewHistoryPoint/)
provides a checkpoint, not automatic exception rollback. The pinned
[base group-action implementation](https://github.com/ONLYOFFICE/sdkjs/blob/v9.3.0.140/common/apiBase.js)
and [history cancellation](https://github.com/ONLYOFFICE/sdkjs/blob/v9.3.0.140/word/Editor/History.js)
are the actual native providers. Presentation has no end-group recalc override,
so cancellation's own change list is passed through the same native recalc path
as `Document_Undo`; history arrays are not rewritten by the adapter.

All comparison runners additionally hash the actual generated JavaScript/WASM
code tree before and after the trial, including both SDK halves, the embedded
spreadsheet SDK, converter and diagnostic host component. Git ignores these
outputs, so a clean repository and `sdk-all.js` alone do not establish their
identity. A missing SDK half, a changed file set or a changed code payload
invalidates the trial. Fonts and non-code assets remain explicitly outside
this code identity; it is not an engine-admission or visual-fidelity receipt.

All three comparison runners also require a reviewed complete static distribution
before opening a document. They reuse `distribution-check.mjs` to validate code,
fonts, other assets, source archives and notices against the distribution manifest,
and bind that manifest's SHA-256 to the trial. Final readback revalidates all files;
a missing, altered or newly reviewed replacement distribution invalidates the
trial. This closes the previous gap in which font changes could leave the code
identity unchanged. The generated-code identity remains separate for diagnostics;
neither identity proves visual equivalence or complete source reproducibility.

## Distribution materials and reviewed fonts

Patch `0008-source-bound-distribution-and-reviewed-fonts.patch` follows the seven native candidate patches. It adds the reviewed font pipeline, static legal/source page and source-bound converter release. Candidate commits are `8dae732` (font permissions) and `fe13950` (runtime distribution). The patch omits large converter binaries: `scripts/fetch-license-materials.mjs` obtains and verifies the pinned `v9.3.0+4` release before a build, including the WASM digest in `runtime-source-lock.json`.

The default font generator accepts only SHA-256-bound OFL-1.1 inputs with their source and complete notices. It disables Docker system-font scanning, verifies generated font bytes, emits permissions with the distribution and keeps staging beside the shared output directory. For macOS Colima, use directories under a shared workspace, rather than unshared system temporary directories. The generator removes its image automatically when generation ends or fails, unless another container uses it.

Put generated reviewed fonts at `.temp/licensing/font-assets`, or under `ONLYOFFICE_LICENSE_MATERIALS_DIR/font-assets`. The build downloads and checks pinned source archives for SDKJS, web-apps, x2t and build_tools, then packages local modifications, license/attribution notices and build materials. The shared core CDN pack also carries fonts and legal/source assets. A configured preview font override must pass the same reviewed-font validation.

Verify the assembled static distribution with:

```bash
pnpm browser-office:verify:distribution /path/to/candidate/dist
```

This checks shipped file/source archive hashes, required notices, and individual font permissions; changed or unlisted files fail. It does not certify legal independence of a future private integration or prove byte-identical rebuilding of the whole upstream editor. The manifest keeps `upstreamEditorRebuildVerified: false` explicit. Existing native correctness, original-package preservation, recovery and representative-application gates remain required for an engine switch.

Local validation on 2026-10-03: 283 candidate unit tests, 17 headless format/open/save checks, live legal/source URLs, 18 served reviewed fonts, and the assembled distribution check passed. These results belong to the source-bound converter and reviewed font package; earlier timing and rendering results from the old converter/font package do not establish this candidate's performance or layout equivalence.

## Parent-owned save persistence

Patch `0009-parent-owned-save-persistence.patch` (candidate `fb449e8`) fixes a second persistence owner in the isolated host. Passing the caller's `download` behavior to the internal runtime let that runtime download the file without sending `SAVE_RESULT` to the parent, leaving the public `save()` promise pending even though a file appeared. The isolated runtime now always uses its callback transport; the parent alone chooses callback or download and sends acknowledgement for that artifact.

The regression opens the real nine-slide showcase PPTX, awaits the public save API, reads the actual browser download, and compares filename, size and SHA-256 to the resolved file. It passed with the full 17-case headless save/open suite. The source-bound converter and reviewed fonts remain required; this does not imply full engine-switch admission.

Patch `0010-discard-unused-font-generator-image.patch` (candidate `b37e926`) makes image cleanup part of the font job's `finally` path. Its failure regression verifies both staged-input removal and the unused-image deletion command without starting Docker. The public REUSE annotations retain AGPL for these upstream-derived patches and additionally CC-BY-SA-4.0 for the original GUI icon carried by patch 0008; the repository-wide MPL annotation does not override those components.

## Final distribution owns every CDN pack

Patch `0011-final-distribution-synchronizes-all-runtime-packs.patch` (candidate `d10b1ad`) fixes pack creation preceding the final embedded-editor patch. The previous word pack retained older JavaScript while the main distribution contained the corrected file. The packaging step now uses the existing runtime asset classifier to synchronize every pack from the final distribution, including code and legal/source materials. Reassembling core, word, cell and slide packs passed the same distribution verifier for all 1,741 files and 18 reviewed fonts. This checks distribution consistency rather than proving the editor's complete behavioral contract.

Patch `0012-modified-editor-dated-attribution.patch` (candidate `09b1882`) adds a tracked modification notice with the author, date, upstream origin and trademark attribution. The generated notice and source page read that same file; the editor footer and demo identify the modified software. Original SDK branding remains visible. The rebuilt package passed 283 unit and 17 headless save/open tests, complete distribution verification, live source-link readback and direct screenshot review. The [official licensing and trademark guide](https://www.onlyoffice.com/blog/2026/05/onlyoffice-license-and-trademark-policy) supplies the attribution requirements; the pinned 9.3 SDK's own terms remain the version-specific authority.

The reviewed-font/source-bound candidate at `d10b1ad` additionally passed all 28 requested paired trials (14 per engine), including authored-package preservation, saving and same-engine reopening. Independent Open XML checks found 22 valid outputs and six retaining exactly the original input errors. All 19 representative normal typed cases and 19 injected failures passed at public integration `a9e52bf`, with full distribution identity bound to each trial. Those trials precede the attribution-only wrapper rebuild at `09b1882`; they do not promote that later artifact, the full 94-command ONLYOFFICE product contract or PowerPoint fidelity. Evidence lives in ignored `artifacts/office-audit-20261003/licensed-paired/` and `licensed-typed/`.


Patch `0013-native-group-redo-history.patch` includes candidate `506ce1d` and
`4365552`. The first passed 19 normal, 19 cancellation and 19 pre-existing Redo
cancellation trials on a fixed reviewed distribution. Each retained Redo was
actually executed and undone with whole native-document readback. The second
adds native history-clear ownership cleanup, covered by a fifth provider-method
regression. It still requires fresh runtime validation before treating the later
artifact as verified.

Direct screenshot review then found missing Arabic in the earlier 18-font
package. Korean rendered, while Arabic in the public mixed-script fixture became
boxes. Input-specific generated fallback coverage is now required by both
ONLYOFFICE trial runners, independently of licensing and byte preservation. It
checks DrawingML text coverage and does not prove shaping, layout fidelity or
PowerPoint equivalence. The candidate font input adds unmodified Noto Sans Arabic
Regular and Bold, with full OFL notices and SHA-256-bound sources at
`notofonts/arabic` gh-pages commit `43674fa5a3ad7e1a8e1b9249319b51b1ee68be26`.
The earlier 18-font results remain historical; fresh screenshots and trials are
required for the resulting 20-font package.

### Canonical comparison batch

`../onlyoffice/comparison-plan.mjs` owns the typed diagnostic catalog and its
related product operation names. Input paths and immutable fixture hashes come
from `contracts/native-mutation-conformance.json`; the complete product operation
list comes from the existing conformance planner. WordArt creation deliberately
has no `set_fontwork` claim. Related operations are pointers for the remaining
investigation, not operation admission.

Run the headless batch from a clean committed repository and candidate:

```sh
nice -n 15 node services/browser-office/verify-onlyoffice-batch.mjs \
  --candidate-root /absolute/path/to/reviewed-candidate \
  --origin http://127.0.0.1:38804 \
  --output /absolute/path/to/new-results-directory
```

All registered cases run normally, with failure rollback, and with an existing
Redo branch. The report retains the full product denominator and the operations
without a related diagnostic. Missing, duplicate, failed, mismatched-fixture or
mixed-source/distribution results cannot complete the batch. `--cases` selects
explicit diagnostics and never claims complete product coverage. Even a passing
full diagnostic batch stays `not_admitted`: the canonical product observation,
commands, original preservation, recovery/playback and independent PowerPoint
gates remain separate requirements.

## Reproduced SDK source

`0014-reproducible-preferred-sdk-source.patch` corrects the SDK source lineage.
The shipped SDK includes CryptPad modifications; an unmodified ONLYOFFICE
archive alone does not provide the preferred source of those SDK bytes. The
patch adds the exact `cryptpad/onlyoffice-editor` SDK subtree at
`ca1ddd43c1e2e149607d1c583773c20d85911bec`, its original license, a digest-bound
fetch and a local SDK rebuild using the bundled shrinkwrap and official Grunt
tasks. Six base JavaScript files and the locally patched presentation SDK were
reproduced byte for byte. One locked patch list drives both reproduction and
runtime builds. Rebuild inputs and outputs are checked again at packaging;
stale, missing or changed receipts cannot certify the SDK. Temporary compiler
files are removed after each run.

The rebuilt-source candidate is `e2b58d9`. Its JavaScript/WASM runtime bytes
match the previously tested `4365552` candidate; the source/legal distribution
changes. `sdkJavaScriptRebuildVerified` is scoped to those SDK JS files. Full
modified web-apps, auxiliary WASM, x2t reproduction, product admission and
independent PowerPoint fidelity remain separate unfinished gates.

## Terminal save completion

`0015-public-save-waits-for-native-cleanup.patch` separates artifact persistence (`SAVE_ACK`) from completed native cleanup (`SAVE_COMPLETE`). The parent keeps the pending result until the host has released its save owner after the native runtime finishes. A failed overlapping request cannot clear another request's owner. Persistence failures also finish cleanup before the public promise rejects. The parent library and host use the paired `onlyoffice-browser-host/v2` contract and must be deployed together.

A deterministic headless browser regression holds the saved File's second read after persistence acknowledgement. The old distribution incorrectly resolves `save()` while this cleanup is held. The patched distribution must keep the promise pending, then allow an immediate second save after release. This is a completion-boundary fix, not a retry or timing delay. The source-bound candidate's preceding diagnostic batch had 56/57 successes, including a real SmartArt move/Redo failure when a subsequent save found the native save lock still held. That failure remains preserved as evidence. Fresh runtime validation is required for candidate `15e97cc`; earlier successes are not copied forward.

## Preferred UI source and coherent compressed runtime

Patch `0016-preferred-ui-source-and-coherent-runtime-compression.patch` pins the
modified CryptPad UI, wrapper, separate RequireJS vendor input, licenses and
build recipes at the SDK commit. Its archive excludes upstream fonts. The
readable browser API and shared application hook are included as preferred
adaptation sources; the hook and template element fix are applied to original
source templates before compilation. The UI recipe also verifies and extracts
its preferred SDK dependency for inlined utilities. All 1,185 deployed UI
assets, including compression variants, were reproduced against candidate
`8160301`; six base SDK JS files and the locally patched presentation SDK also
remain exactly reproduced. Build source, archive and output changes invalidate
the packaged receipts. These scoped proofs do not certify auxiliary WASM, x2t,
the entire editor, a hosted integration's license boundary or product admission.

An actual decode comparison found 20 stale compression variants among 279
runtime pairs in the preceding distribution: 19 UI files and the final font
list. Independent file hashes could not detect their semantic mismatch. Final
UI and reviewed font bytes now precede compression, and final split packs share
that same materialized distribution. Every `.br` file must decode exactly to
its listed plain counterpart. The public verifier rejects stale or corrupt
compression and missing counterparts; the preceding candidate is rejected by
this stronger check. A server that sends actual `Content-Encoding: br` responses
is used for fresh browser validation; Vite-only successes are retained as
historical evidence rather than claimed as compression-path verification.

## Cold source builds materialize generated resources

Patch `0017-materialize-cold-build-generated-ui-assets.patch` (candidate
`1bb5c68`) fixes the shared image build order: the common-copy stage preceded
generation of `formats@2.5x.svg`, so warm source trees hid a missing deployable
icon. Newly generated shared images are materialized after all compiler stages
through the existing runtime asset selector. Debug maps stay outside that
selector. A pristine rebuild exactly reproduced all 1,186 deployed UI files,
and all 279 compressed pairs decoded to their plain counterparts. The initial
strict HTTP save test exposed the missing icon even though document saving
succeeded. That failure is preserved; full fresh HTTP runtime validation remains
a separate requirement. The final runtime manifest describes materialized files
and no longer prunes already reviewed fonts or source/legal materials.

## Runtime resource capabilities follow the deployed dictionary profile

Patch `0018-native-dictionary-resource-profile.patch` (candidate `0e4f2cc`)
fixes two strict HTTP failures hidden by fallback HTML: the compact build
retained only `en_US` dictionaries while the native engine still advertised
other dictionary languages, and its hyphenation engine requested
`hyph_en_US.dic` instead of the bundled legacy filename. The runtime selector's
existing dictionary profile now also owns advertised language capabilities.
The source build materializes the engine's requested path from the same exact
dictionary bytes and configures the language provider before constructing the
three main editor APIs. Unsupported document languages are not relabeled.

Preferred-source compilation now owns all selected UI output, including its
compression, while SDK/WASM output is preserved outside that UI boundary. A
fresh source rebuild exactly reproduced 1,186 UI files, and final decoding
verified all 279 compressed pairs. All 18 public save/open browser tests passed
under actual Brotli HTTP delivery, including RTF and terminal cleanup, with no
missing resources. Unit tests: 286; source/compression/dictionary policy tests:
36. Whole-editor source/licensing proof and full-product operation admission
remain unverified. The existing dictionary bytes match a historical upstream
commit whose locale directory omitted individual legal notices; that provenance
and licensing gap is not certified by the resource-path fix.

## Pinned dictionary data retains original notices

Patch `0019-pinned-dictionary-source-and-notices.patch` (candidate `1ffd3f0`)
replaces the historical compact dictionary files whose source directory omitted
individual notices. The selected `en_US` data comes from official
`ONLYOFFICE/dictionaries` commit
`d3223bbb777883db66ac3cd249f71c6ebdc992c7`, tree
`3c779ae7bcdbf5b5c82dba59ef005d5b40e7c9d7`. The source archive is scoped to
that locale and pinned to SHA-256
`c73efc78d1530bf75eb62a5740afe4e3fcc2b6b873c34b855ceb973706a56bf4`.
A fresh Git fetch/archive produced the same hash. The data, SCOWL/hyphenation
README files, WordNet notice and original license file are copied together.
Invalid input retains the previous generated directory; valid replacement
eliminates stale data/compression. Source packaging includes this archive and
its build dependency receipt.

All SDK, UI and WASM bytes remain identical to the preceding `0e4f2cc`
candidate. Dictionary data, notices and source/materialization metadata change.
Final compression readback now follows preferred-source compilation and all
data replacement. UI reproduction still covers 1,186 files and SDK reproduction
still covers six base JS files plus the local presentation SDK. Policy tests:
38; component unit tests: 286; type checking and the full local build pass.
Fresh strict Brotli HTTP runtime tests passed: 18 public save/open tests and
57 selected diagnostic trials, with stable candidate/distribution identities.
Korean and British English document language assignments remain selectable.
The shipped C++ spelling worker accepted a known word and rejected an invalid
word using the new dictionary; the actual native hyphenation WASM also loaded
the new data. Nineteen portable patches plus the pinned converter fetch exactly
replay the whole candidate Git tree. These are scoped tests, not all 94 product
operations or whole-editor source/licensing approval.

A subsequent direct source-package inventory found 269 historical/unselected
dictionary files still included in the wrapper archive. An archive-only build
preflight actually failed because the converter output directory was absent;
the SDK recipe also depended on warm checkout SDK bytes. These packaging/build
input gaps are preserved and require a separate candidate and cold build proof.
Runtime dictionary replacement does not certify every file in the source ZIP.
Auxiliary WASM, x2t, the actual service licensing boundary and full product
admission remain unverified.
