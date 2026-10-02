# ONLYOFFICE browser comparison patches

These patches are local research candidates. They do not change the production
engine or admit the candidate as supporting the Spellbook document contract.
The comparison objective is a shared observation/edit/save/recovery contract,
original PPTX preservation, useful responsiveness, and verified output quality.

Apply in filename order to `agentbridges-ai/onlyoffice-browser` at
`d15d12b6945be4d8b0f3aa1806120e740d2950ee` (0.3.34, SDK 9.3). Patched local
candidate commits are `1872b4e`, `60b6109`, `1317f56`, `ded5281`, and `e6165f7`. The upstream component and SDK
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
