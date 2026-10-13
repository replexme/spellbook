# Document platform architecture

## Product invariant

Spellbook edits the user's real document. It does not replace the file with a generated screenshot or migrate it into a proprietary format. The person views the document and asks for changes; only the AI edits it, and the person can undo, redo or return to an earlier version. Every AI edit works on the same versioned, editable document, and a candidate must pass structural validation and rendered review before approval.

## Dependency direction

```text
hosted service overlay (private, optional)
                  ↓
web app → platform contracts ← AI connector
   ↓                ↓                 ↓
document view   format modules    provider runtime
   ↓                ↓
document engine (Rust) → native document file
```

The public platform never imports a hosted module. Hosting adds adapters around public ports; it does not fork document behavior.

## Runtime pieces

- **Web app** (`apps/web`): sign-in, uploads, versions, conversations, and the workspace screen. It embeds the document view and sends it save, undo, redo and show-page requests.
- **Document view** (`apps/office`): the page that shows the document inside the workspace. It runs the Rust document engine compiled to WebAssembly in a browser worker, draws the pages, and carries out the AI's observe and edit requests on that same engine. People do not edit in it directly.
- **Document engine** (`engine/`) and **format modules** (`formats/pptx`, `formats/idml`, `formats/package`): file reading and writing, layout, drawing, edit commands and Undo. The same source is built for the browser (WebAssembly) and as the command-line programs `present-pptx` and `present-idml`.
- **Document worker** (`services/document-worker`): checks uploaded files and draws page previews with `present-pptx` and `present-idml`. It does not use LibreOffice.
- **AI connector** (`apps/ai-connector`): runs the user's own Codex or Claude Code subscription for a document turn; its tool calls reach the document view through the web app.

Because the document view and the preview programs build from the same engine source, a format fix is made once in `engine/` or `formats/` and applies to both.

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
- edits that rewrite only the package parts they change;
- drawing slides with the document engine;
- the edit operations the AI may use, declared in `contracts/native-edit-capabilities.json`.

The `idml` adapter follows the same pattern for InDesign documents at the experimental level declared in the registry.

## Current limitation that matters for expansion

The worker boundary and upload registry are format-aware, but the current element graph, edit contract, conversation scope and UI still contain slide-specific fields. They are valid PPTX adapter contracts, not the future universal interchange model. Before enabling DOCX, introduce a small format-neutral observation envelope whose payload is validated by an adapter-owned schema. Do not stretch `slides[]` into `pages[]` or `paragraphs[]`.

## Adding a format

A format can move from `planned` to `experimental` only after it has:

1. an adapter implementation and adapter-owned observation/edit schemas;
2. a document view route with stable document identity;
3. package-preserving validation and corrupted-file rejection;
4. public, redistributable fidelity and round-trip fixtures;
5. before/after visual review semantics appropriate to that format;
6. UI language and selection rules that do not leak PPTX concepts;
7. passing release gates without weakening the PPTX path.

DOCX should use sections, paragraphs, runs, tables, headers and anchored/floating objects as its own semantics. The proposed Spellbook format should use pages and layout nodes and must not become an intermediate representation used to rewrite imported Office files.
