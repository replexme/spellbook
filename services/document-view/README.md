# Document view

The page the web app embeds to show a document and carry out the AI's edits. It runs the
document engine (`engine/`, `formats/`) as WebAssembly in the browser; people do not edit in
it directly. Source: [`apps/office`](../../apps/office). This folder only builds and serves it.

- `SPELLBOOK_APP_ORIGIN` (build argument): the web app's origin. The view answers only that
  origin and only that origin may frame it.
- The web app finds it through `SPELLBOOK_BROWSER_OFFICE_URL` (the view's public address).
- Check it without the web app: `node apps/office/check.mjs <playwright-core dir> <site dir> <deck.pptx|file.idml> <out dir>`
  runs the view's protocol (open, observe, edits, undo, save) in headless Chrome.
