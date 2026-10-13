# Multi-format product roadmap

## Product direction

Spellbook is a document workspace, not a PPTX utility that later renames slides to pages. PPTX is the first complete vertical. DOCX and a native page-layout document join the same product only by implementing their own editing, observation, command and validation contracts.

The layers intentionally shared across formats are identity, ownership, immutable originals, version lineage, session capabilities, AI-provider connection, conversation events, approval, audit and recovery. The semantic unit is never shared by force: a slide, a paragraph and a page-layout frame are different objects.

## Delivery order

### 0. Freeze the PPTX baseline

Keep the current live PPTX path and its public corpus reproducible. Close the remaining PowerPoint-reference, complex round-trip and operational gates before using PPTX behavior as a platform contract.

### 1. Finish the format-neutral envelope

Move the remaining slide-specific fields out of common document, job, storage and conversation envelopes. Keep the PPTX element graph and commands as adapter-owned payloads validated by PPTX schemas. Add adapter conformance tests for open, observe, apply, undo, save, validate and close.

### 2. Add DOCX as an independent vertical

Add a DOCX module to the document engine with a DOCX scanner, WordprocessingML observation graph, paragraph/style/table/header/footer/footnote commands, Word reference corpus and DOCX-specific failure messages.

### 3. Add the native page-layout format

Define pages and spreads, master pages, text and image frames, grids, linked assets, overflow, bleed and output settings in a native schema and editor. This format may import Office or publishing assets, but it must never become the intermediate representation used to rewrite an uploaded PPTX or DOCX.

### 4. Add publishing outputs and importers separately

Screen PDF, print PDF/PDF-X, page images, IDML import and EPUB are separate capabilities with separate preflight and compatibility evidence. An export renderer does not automatically become an editable input format. INDD direct editing is not promised.

## Promotion rule

A format moves from `planned` to `experimental`, `beta` or `stable` only when the machine-readable registry, UI, adapter, public fixtures, live edit/save/download path and representative native-application checks all agree. Adding an extension or MIME type to upload validation is never enough.
