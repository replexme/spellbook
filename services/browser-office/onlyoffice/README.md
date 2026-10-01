# ONLYOFFICE browser comparison patches

These patches are local research candidates. They do not change the production
engine or admit the candidate as supporting the Spellbook document contract.
The comparison objective is a shared observation/edit/save/recovery contract,
original PPTX preservation, useful responsiveness, and verified output quality.

Apply in filename order to `agentbridges-ai/onlyoffice-browser` at
`d15d12b6945be4d8b0f3aa1806120e740d2950ee` (0.3.34, SDK 9.3). Patched local
candidate commits are `1872b4e`, `60b6109`, and `1317f56`. The upstream component and SDK
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
