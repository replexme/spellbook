# Native vector font boundary

The converter's WMF/EMF SVG text used OS fonts when loaded as an image. The
native editor's admitted font catalog did not control that browser path. In
the 203-input corpus, the actual vector text occurs in two documents: Arial /
Liberation Sans, Calibri / Carlito, and Webdings `n` / `g`. On Linux, those two
Webdings codes appeared as Latin letters rather than the authored symbols.

`installOnlyOfficeDocumentFontCatalog` retains the exact import catalog before
the SDK deletes its temporary globals. Vector image preparation uses this
same public/document-private catalog. An original admitted face has priority;
missing legacy faces map only the reviewed numeric recipe. Actual cmap glyph
coverage is required before browser display. Unsupported coverage fails
explicitly through native error handling and the renderer report.

For simple metafile text with an absolute position for every ASCII or reviewed
symbol character, an isolated instance of the admitted native FreeType WASM
extracts unscaled outlines. SVG definitions reuse each font/glyph path while
each occurrence retains its original position, size, transform and fill.
Complex, implicit, bidi or shaped text retains browser shaping with inline
fonts from the same admitted bytes. It is never replaced by naive per-character
outlines. This closes OS font selection but does not assert browser or OS
rasterization equivalence for every image.

Only local converted blob/SVG data image loading is intercepted. Authored
RasterImageId, source SVG/WMF/EMF, native history and saved PPTX authority stay
unchanged. Image preparation and font loading are deduplicated within the
document. Native outline faces use a separate library, so active editor font
measurement is untouched. On document disposal, pending fetches stop, native
faces/buffers are freed, display URLs are revoked and private caches are
released before the parent context clears its private font buffers.

Regression checks cover original face priority, qualified symbol mapping,
per-character positions, implicit-text fallback, separate outline contours,
native allocation cleanup, private disposal, and unchanged author packages.
Real-document lifecycle verification additionally includes percentage paragraph
spacing: a font-size change must undo to the exact previous visual state.

Use the canonical cohort and full original-source corpus for release admission;
an isolated SVG or successful render is not complete PowerPoint fidelity proof.
