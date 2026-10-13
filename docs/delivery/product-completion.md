# Product completion contract

Updated: 2026-10-13

The delivery objective is one complete product: **a usable PPTX public beta,
a runnable open-core self-host product, and the Replex-managed public service
that consumes the exact same released core**. A partial score is not a delivery
target and is not used to decide what to implement next.

Future DOCX and native page-layout formats are outside this scope. A new format
requires an explicit scope decision; a newly discovered PPTX defect belongs to
the existing PPTX completion contract.

## 2026-10-13 engine change

The earlier editors (Collabora Online through WOPI, the browser ONLYOFFICE and
LibreOffice WebAssembly editors, and the LibreOffice renderer) have been
removed. The browser document view runs Spellbook's own Rust document engine,
and the document worker draws previews with the same engine's command-line
programs. Evidence gathered on the removed editors does not count toward the
rows below; each row must be shown again on the current engine.

## Completion rule

Spellbook is complete only when one immutable release candidate satisfies all
rows below. Code, a source patch, a successful build, a command name, or a
passing unit test is evidence for its own layer only. None can substitute for
the integrated browser, native PowerPoint, AI, self-host, managed-service,
security, load, rollback, and user-experience evidence.

| Required product outcome                      | Complete only when                                                                                                                                                                                                                                          | Current verified foundation                                                                                                                                             | Work still required before the completion claim                                                                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open-core and managed-cloud boundary          | A clean clone runs independently; the private service consumes only signed, digest-pinned public artifacts; license, NOTICE, SBOM, upgrade, migration and rollback evidence identify the same release                                                       | Public repository, MPL-2.0 boundary checks and private-cloud ownership boundary exist                                                                                   | Bind the private adapters and deployed service to the final public release; complete release licensing, SBOM, migration and rollback proof                                                                                                        |
| Document view and requests                    | A user can view a supported PPTX, ask the AI for changes, see the result, undo or redo it and return to an earlier version; Korean IME in the request box, keyboard, accessibility, responsive layout, latency and visual review pass                       | The document view draws PPTX and IDML with the Rust engine compiled to WebAssembly and applies AI edits; the web app sends it save, undo, redo and show-page requests   | Runtime-verify the view and request flow across the supported PPTX feature set; pass Korean IME, accessibility, responsive, latency and screenshot review                                                                                         |
| Subscription AI collaboration                 | Codex and Claude Code can connect from normal installations, request/change permission, use every admitted editing tool, observe fresh screenshots, repair their own visual regressions, save and Undo; reconnect, upgrades and supported OS packages pass  | Real subscription loops passed on packaged macOS arm64 with the removed editors                                                                                         | Repeat the loop on the document view; finish signed/notarized distribution, normal Finder lifecycle, reconnect/error recovery, upgrades, macOS x64 and Windows                                                                                    |
| PPT feature breadth for AI                    | Every supported PPTX change has a bounded AI operation or an explicit format/security exclusion; tables, charts, diagrams, media, animation, masters/themes, text, shapes and slide structure pass readback, Undo/Redo, save/reopen and preservation checks | The edit contract classifies 93 operations, all exposed to the AI tool schema; in a session the model is offered only the operations the open document's engine reports | Run every operation on the engine through readback, Undo/Redo, save/reopen, change budgets, visual review and PowerPoint validation                                                                                                               |
| PPTX fidelity and integrity                   | Supported public and real-world corpora have no hard failures; fonts and text wrapping meet the declared threshold; every edit stays within its structural change budget; Windows and macOS PowerPoint reopen the exact artifacts                           | Public corpus/evaluation harness and change-budget validation exist; earlier corpus runs used the removed LibreOffice renderer                                          | Run the engine through corpus regression, text-reflow/font closure, editability/preservation checks and repeatable Windows/macOS PowerPoint matrices                                                                                              |
| Public infrastructure, performance and safety | Public signup, account deletion, direct object transfer, tenant isolation, backpressure/autoscaling, entitlement, billing, TLS, backups, restore, disk pressure and interrupted jobs pass at planned load and cost                                          | Local auth/storage, isolated restore and AI connector disk-pressure behavior exist                                                                                      | Repeat worker recovery and disk-pressure checks on the rebuilt document worker; complete the public identity and storage path, multi-user isolation, load/autoscaling, entitlement/billing, production TLS, restore and interrupted-job exercises |
| Release and real user workflow                | Signed public and managed artifacts are deployed; a fresh user completes signup → upload → first document view → AI permission/edit/review → Undo → save → PowerPoint download on supported platforms; rollback and support procedures are exercised        | Public prerelease source and release automation foundations exist                                                                                                       | Produce, deploy and verify the single final release candidate end to end; do not call an earlier evidence layer a beta                                                                                                                            |

## Execution discipline

- Implement the entire fixed scope; do not optimize for an intermediate score.
- Batch related source changes and use focused local tests while editing.
- Reuse one conformance program for the document view and the preview
  programs. A feature passes only when the same semantic command, permission,
  readback, Undo/Redo, save/reopen and change-budget contract passes on the
  released engine.
- Report concrete completed behavior and concrete failures. Do not translate
  partial evidence into a progress percentage.
