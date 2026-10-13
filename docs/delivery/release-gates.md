# Public release gates

The existence of code, a passing unit suite or a successful image build is not a public beta by itself. A release is usable only when every required evidence layer is green.

## How these gates are used

These are binary release blockers, not equal-sized units of engineering work.
They answer whether the product may be called a usable public beta; they do not
calculate implementation progress. A large body of implemented and locally
verified work can sit inside a gate whose final production proof is still
missing, so dividing completed gates by nine produces a misleading percentage.

The governing scope is the
[Product completion contract](./product-completion.md). Build output, commit
count and line count are supporting evidence only; no partial score is used as
a product target.

| Gate                   | Required evidence                                                                          | Current repository state                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 Public boundary     | clean-history extraction, forbidden-pattern scan, license/notice inventory                 | Clean-history extraction published; boundary and REUSE checks passed in public CI run `34597476608`                                                                                                                                                                                                                                                                                                                                 |
| G1 Reproducible setup  | clean-machine setup, pinned dependencies, Compose health checks                            | Earlier clean-clone and Compose evidence covered the removed editors; it must be repeated for the current services (web, document view, document worker, AI connector, PostgreSQL)                                                                                                                                                                                                                                                  |
| G2 Login and isolation | local owner login, secret length, worker network isolation, traversal tests                | Implemented; security review required                                                                                                                                                                                                                                                                                                                                                                                               |
| G3 First document view | upload to the first drawn document view without manual recovery; measured warm/cold timing | Earlier timing was measured on the removed editors and does not apply to the document view; to be measured again                                                                                                                                                                                                                                                                                                                    |
| G4 Edit round trip     | AI edit, save, reopen and download in PowerPoint without corruption                        | Earlier round-trip evidence was for the removed editors; the document view and engine must pass edit, save, reopen and PowerPoint checks again                                                                                                                                                                                                                                                                                      |
| G5 AI loop             | connect, observe, permission request, edit, re-observe, self-review, approve/undo          | Codex and Claude Code subscription loops passed on the removed editors; the same loop must be run again on the document view                                                                                                                                                                                                                                                                                                        |
| G6 Fidelity            | public coverage, hard-failure counts, text reflow and object-preservation thresholds       | Harness and corpus present; release result pending                                                                                                                                                                                                                                                                                                                                                                                  |
| G7 Operations          | backup/restore, restart recovery, disk limits, TLS, vulnerability scan                     | Consistent backup/isolated restore passed; a packaged AI connector process-kill fails stale native turns without replaying a possibly applied edit; the packaged AI connector rejects writes atomically under disk pressure while retaining durable failure receipts. Document worker recovery, disk-pressure behavior and image scanning must be repeated for the rebuilt worker and the document view; deployed TLS proof remains |
| G8 Publication         | public repository, clean clone CI, tagged source release and SBOM                          | Public prerelease source and macOS app packager exist; a tag workflow re-verifies the exact source and produces validated SPDX 2.3 SBOMs for the source and the web, AI connector, document worker and document view images, and publishes them with checksums; Developer ID/notarized binaries and a successful tagged release run remain                                                                                          |

## Hard failures

Regardless of average image score, a case fails when it has missing content, unexpected slide/page count, new text wrapping, clipped text, changed object editability, package corruption, unintended part changes or an unreported unsupported construct.

## Performance evidence

Measure upload acceptance, first preview, first editable frame, save-to-observation and AI turn completion separately. Report p50 and p95 for warm and cold starts and include file size, slide count, font state and renderer version. Do not describe a worker returning HTTP 202 as the document being ready.

The document view must also complete a single-session endurance run of at
least 100 mixed observe, edit, Undo, Redo and save cycles without a hung
request, page error, request failure, revision divergence or collateral
package change. The run must record the exact engine source revision;
reloading the document view between operations does not satisfy this
requirement.

## Publication decision

The first public push may be an explicit prerelease when G0–G2 pass. It must not be called a usable beta until G3–G7 have current runtime evidence. Repository visibility and service deployment are separate decisions.
