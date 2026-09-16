# Document platform architecture

## Product invariant

Spellbook edits the user's real document. It does not replace the file with a generated screenshot or migrate it into a proprietary format. A human and an AI operate on the same versioned, editable document; a candidate must pass structural validation and rendered review before approval.

## Dependency direction

```text
hosted service overlay (private, optional)
                  ↓
web workspace → platform contracts ← AI connector
      ↓                 ↓                 ↓
 WOPI host       format adapter       provider runtime
                        ↓
                 native document file
```

The public platform never imports a hosted module. Hosting adds adapters around public ports; it does not fork document behavior.

## Browser-owned edit sessions

The browser renderer is never allowed to impersonate a WOPI client. WOPI and
browser editing are mutually exclusive modes of the same owned document
session. A browser launch is refused while Collabora holds a WOPI lock; after a
mode switch, the old WOPI capability can no longer read or save the file.

The browser receives an opaque revision made from the current version identity
and SHA-256 digest. Every candidate upload must be same-origin and carry that
revision in `If-Match`. The server locks the session row, rejects a stale base,
stores the candidate as a new child version, and passes it through the existing
package scan, render and preservation validation before advancing the document.
OPFS protects unsaved local work across browser interruption, but it is not the
shared source of truth and cannot bypass server validation or version lineage.

The transport and recovery contracts are implemented and transaction-tested;
selecting the browser engine in the product UI remains blocked on the browser
engine promotion gates described in its pinned runtime manifest.

## Common platform responsibilities

The common layer owns behavior that is true for every document type:

- immutable upload identity and version lineage;
- authentication, document ownership and edit permission;
- local object naming and storage-port contracts;
- job acceptance, idempotent result receipts and callbacks;
- conversation state, model choice and interruption;
- before/after evidence and approval state;
- capability discovery and honest unsupported-state reporting.

It must not encode a slide, paragraph, cell, canvas node or OOXML part as a universal concept.

## Format adapter responsibilities

Each adapter owns its package rules, semantic units, inspection graph, edit commands, renderer and validators. `IDocumentFormatAdapter` is the worker composition seam. The registry in `contracts/document-formats.json` controls whether a format is exposed to users.

The current `pptx` adapter owns:

- ZIP/OOXML safety scanning and relationship checks;
- slide and element inspection, including position, z-order, groups and fonts;
- minimal-part patching and round-trip validation;
- LibreOffice rendering and PowerPoint-oriented compatibility patches;
- the Impress WOPI editor bridge and native editing operations.

The PPTX adapter currently has three independently pinned LibreOffice-derived
builds: the document worker's headless renderer, Collabora Online's live editor,
and the ZetaOffice browser-WASM candidate. They are alternative execution
surfaces for one PPTX product, not three document formats. Their source versions
and ABIs differ, so a format fix must carry the same behavioral regression
across the affected builds rather than copying a binary patch blindly. See the
[Collabora maintenance contract](../../services/office-editor/libreoffice/README.md),
[browser-WASM contract](../../services/browser-office/libreoffice/README.md),
and [renderer contract](../../services/document-worker/libreoffice/README.md).

## Semantic save boundary

An edit is not complete when an Office API reports success or when a ZIP file
exists. Its intended effect must be checked against the persisted PPTX at the
same document revision, while unrelated original content remains protected.
For AI, the target is the authorized command plus its live post-edit readback;
for direct human editing, it is the observed live document state immediately
before save. The path is: target state → edit and Undo → serialize or local
package patch → persisted-semantic check → package-scope/preservation
validation → rendered review → version promotion. Human and AI edits may use
different tools, but must satisfy this same outcome contract.

Localized single edits use a minimal OOXML patch, while compound AI edits and
direct human edits can create full native snapshots. The browser source now
reopens native snapshot bytes in a hidden read-only document and compares the
intended, observable change with the same format-aware normalization used by
the release conformance runner before writing the OPFS checkpoint. Its manual
baseline is the preceding observation from the **same live session**, not a
new import of the old file: even an unedited LibreOffice export can resolve
inherited values differently. The hidden probe never becomes the visible
editor. Package-only section and slide-topology edits use their own saved
identity/order checks. The server separately checks package categories, target
scope and preservation of selected unsupported features.

This source-level boundary is not yet a verified runtime guarantee for every
PPTX property. The new browser snapshot path must pass the immutable candidate
runtime, all operation-family conformance cases, save/reopen, Undo/Redo,
performance and PowerPoint checks. The observation graph also has to cover
each claimed editable semantic family; a byte difference or a changed UNO
revision is never a substitute for persisted intent. For example, paragraph
margins must be compared as effective DrawingML semantics, not merely as a UNO
field that may be remapped into numbering rules on import.

## Current limitation that matters for expansion

The worker boundary and upload registry are format-aware, but the current element graph, edit-command schema, conversation scope and UI still contain slide-specific fields. They are valid PPTX adapter contracts, not the future universal interchange model. Before enabling DOCX, introduce a small format-neutral observation envelope whose payload is validated by an adapter-owned schema. Do not stretch `slides[]` into `pages[]` or `paragraphs[]`.

## Adding a format

A format can move from `planned` to `experimental` only after it has:

1. an adapter implementation and adapter-owned observation/edit schemas;
2. a browser editor route or native editor with stable document identity;
3. package-preserving validation and corrupted-file rejection;
4. public, redistributable fidelity and round-trip fixtures;
5. before/after visual review semantics appropriate to that format;
6. UI language and selection rules that do not leak PPTX concepts;
7. passing release gates without weakening the PPTX path.

DOCX should use sections, paragraphs, runs, tables, headers and anchored/floating objects as its own semantics. The proposed Spellbook format should use pages and layout nodes and must not become an intermediate representation used to rewrite imported Office files.
