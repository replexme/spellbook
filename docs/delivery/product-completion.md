# Product completion contract

Updated: 2026-09-16

The delivery objective is one complete product: **a usable PPTX public beta,
a runnable open-core self-host product, and the Replex-managed public service
that consumes the exact same released core**. A partial score is not a delivery
target and is not used to decide what to implement next.

Future DOCX and native page-layout editors are outside this scope. A new format
requires an explicit scope decision; a newly discovered PPTX defect belongs to
the existing PPTX completion contract.

## Completion rule

Spellbook is complete only when one immutable release candidate satisfies all
rows below. Code, a source patch, a successful build, a command name, or a
passing unit test is evidence for its own layer only. None can substitute for
the integrated browser, native PowerPoint, AI, self-host, managed-service,
security, load, rollback, and user-experience evidence.

| Required product outcome                      | Complete only when                                                                                                                                                                                                                                                  | Current verified foundation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Work still required before the completion claim                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open-core and managed-cloud boundary          | A clean clone runs independently; the private service consumes only signed, digest-pinned public artifacts; license, NOTICE, SBOM, upgrade, migration and rollback evidence identify the same release                                                               | Public repository, MPL-2.0 boundary checks, runnable local services and private-cloud ownership boundary exist                                                                                                                                                                                                                                                                                                                                                                                          | Bind the private adapters and deployed service to the final public release; complete release licensing, SBOM, migration and rollback proof                                                                                                                                                                                             |
| PowerPoint-like human editing                 | A user can directly manipulate supported PPTX content with familiar slide pane, ribbon, canvas and properties; Korean IME, keyboard, accessibility, responsive layout, latency and visual review pass                                                               | Slide pane, ribbon, canvas and AI panel exist; browser Office now checkpoints direct native edits into the same PPTX journal used by AI edits                                                                                                                                                                                                                                                                                                                                                           | Complete and runtime-verify direct manipulation and property workflows across the supported PPT feature set; pass Korean IME, accessibility, responsive, latency and screenshot review                                                                                                                                                 |
| Subscription AI collaboration                 | Codex and Claude Code can connect from normal installations, request/change permission, use every admitted editing tool, observe fresh screenshots, repair their own visual regressions, save and Undo; reconnect, upgrades and supported OS packages pass          | Real subscription loops passed read, edit, re-observe, review, save and Undo on packaged macOS arm64; Codex image generation passed; permission modes exist                                                                                                                                                                                                                                                                                                                                             | Finish signed/notarized distribution, normal Finder lifecycle, reconnect/error recovery, upgrades, macOS x64 and Windows; prove the final browser runtime with the complete tool contract                                                                                                                                              |
| PPT feature breadth for people and AI         | Every supported human mutation has a bounded AI equivalent or an explicit format/security exclusion; tables, charts, diagrams, media, animation, masters/themes, text, shapes and slide structure pass readback, Undo/Redo, save/reopen and preservation checks     | The source contract classifies 98 mutations, explicitly excludes the non-PPTX printable flag, and exposes the remaining 97 bounded operations. The previous immutable runtime verified 63; one cumulative server/browser source candidate implements the other 34, including chart formatting, sections, master/theme and slide size, connectors/freeform, richer shape/text/list formatting, comments, animation lifecycle, images/media, semantic SmartArt, Fontwork, 3D, equations and reading order | Compile the final cumulative source candidate once and run all 97 operations through the shared 15-scenario conformance program. Until that exact runtime passes native tests, browser readback, Undo/Redo, save/reopen, change budgets, visual review and PowerPoint validation, the additional 34 remain runtime-validation-required |
| PPTX fidelity and integrity                   | Supported public and real-world corpora have no hard failures; fonts and text wrapping meet the declared threshold; every edit stays within its structural change budget; Windows and macOS PowerPoint reopen the exact artifacts                                   | Public corpus/evaluation harness, font policy, 621-slide no-render-failure run, change-budget validator and macOS PowerPoint topology checks exist                                                                                                                                                                                                                                                                                                                                                      | Run the final engine through corpus regression, text-reflow/font closure, editability/preservation checks and repeatable Windows/macOS PowerPoint matrices; resolve remaining browser text-position drift                                                                                                                              |
| Public infrastructure, performance and safety | Public signup, account deletion, direct object transfer, tenant isolation, backpressure/autoscaling, entitlement, billing, TLS, backups, restore, disk pressure and interrupted jobs pass at planned load and cost                                                  | Local auth/storage, signed WOPI, isolated restore, worker recovery, disk-pressure behavior and browser OPFS crash recovery exist                                                                                                                                                                                                                                                                                                                                                                        | Complete the public identity and storage path, multi-user isolation, load/autoscaling, entitlement/billing, production TLS, restore and interrupted-job exercises                                                                                                                                                                      |
| Release and real user workflow                | Signed public and managed artifacts are deployed; a fresh user completes signup → upload → first editable frame → direct edit → AI permission/edit/review → Undo → save → PowerPoint download on supported platforms; rollback and support procedures are exercised | Public prerelease source and release automation foundations exist                                                                                                                                                                                                                                                                                                                                                                                                                                       | Produce, deploy and verify the single final release candidate end to end; do not call an earlier evidence layer a beta                                                                                                                                                                                                                 |

## Execution discipline

- Implement the entire fixed scope; do not optimize for an intermediate score.
- Batch related source changes and use focused local tests while editing. Run an
  expensive LibreOffice build only after the source batch is complete.
- Keep the LibreOffice source line, toolchain, build outputs and promotion
  evidence separately cached. Never rebuild an already-proven stage because a
  web-only file changed.
- Reuse one conformance program across the server and browser engines. A
  feature passes only when the same semantic command, permission, readback,
  Undo/Redo, save/reopen and change-budget contract passes on the released
  runtime.
- Report concrete completed behavior and concrete failures. Do not translate
  partial evidence into a progress percentage.

## Evidence that exists but is not completion

The initial public extraction contained 261 files and 47,613 inserted lines;
subsequent work added application, engine, contract, distribution and
verification code. The current browser path can preserve generic native edits
as real PPTX snapshots, recover them from OPFS, and expose the complete
97-operation source contract to a receipt-bound candidate runtime. The shared
15-scenario conformance runner covers 24 mutation families and binds 32 native
regression tests to the same immutable server and browser source candidates.
The browser source now separates the server-acknowledged PPTX base and its
unsaved recovery journal from session Undo/Redo history, including Undo after
Save. Direct human edits now enter that same session history as coalesced,
reversible checkpoints instead of discarding prior AI Undo entries. These
source changes still need the candidate browser product run.

The advanced browser edit path still adopts LibreOffice's whole-PPTX export as
a native snapshot. The stock runtime has rewritten unrelated original OOXML
parts on a no-op save, so a same-engine baseline comparison alone cannot prove
the original file was preserved. The product bridge now compares the native
snapshot directly with the uploaded PPTX and release admission rejects
collateral part changes. A passing result, or a scoped preservation mechanism
that passes this check, is still required before the original-file promise is
verified for advanced edits.

These facts explain what has been built. They do not claim that the final
runtime, full remaining feature breadth, deployment or public user workflow has
passed.

The 2026-09-16 Collabora `r19` candidate compiled and ran 131 native tests;
one failed on fixed slide-date visibility. The `undo-v28` candidate corrected
that import path, compiled and ran the same 131 tests, then failed because a
12.5-second slide duration returned as the 1-second default after PPTX reload.
The exporter skipped timing-only slides and used whole-second timing where it
did emit `advTm`. The `undo-v30` source series includes the fixed-date repair,
the actual reopened-marker UNO type, and a shared millisecond-accurate slide
timing import/export rule. It applies cleanly to the pinned source but has not
passed native tests. The browser `browser-undo-v23` candidate compiled but
failed two focused tests:
character spacing differed by one 1/100 mm unit across its UNO/Undo path, and
the test attempted to clear `LineDashName` with an invalid empty name. The
`browser-undo-v24` compiled and advanced through those tests, then failed one
marker test because its setup supplied `PointSequence` where the native marker
table and shape line properties consume `PolyPolygonBezierCoords`. The
`browser-undo-v25` compiled but failed on fixed slide-date visibility during
the same native round-trip test. The `browser-undo-v27` source series restores
the fixed-date page metadata and ports the same millisecond timing rule as the
server engine. It compiled but then failed on an invalid PPTX round-trip test
expectation: fixed dates are literal text and do not serialize an inactive
live-date format choice. The `browser-undo-v28` source series keeps the native
Undo check for that choice while checking only portable fixed-date properties
after reload. Its Cloud Build failed one native test because the DrawingML
exporter skipped paragraph properties when margins were the only formatting
that required them. `browser-undo-v29` corrects that shared emission condition
and adds a right-margin-only regression, but has not passed native tests.
The current local browser editor passed real open/edit/save/download and
compact-screen canvas/access tests, but the older standalone conformance
runtime aborts during its third document reopen. Neither current source
candidate has deployment or final user-workflow proof.
