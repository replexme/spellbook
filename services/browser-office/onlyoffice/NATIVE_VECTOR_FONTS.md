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

The native converter also leaves each original WMF/EMF beside its SVG in the
document-owned URL map. When an SVG has one unambiguous corresponding original,
`prepareOnlyOfficeNativeMetafile` sends those exact local bytes to the initialized
font/drawing module through `AscFonts.RenderMetafileSvg`. Its EMF+ FillPie parser
now selects the authored inline or object brush and emits native elliptical pie
arcs, including clockwise, counterclockwise and full-circle cases. The font gate
then applies the same catalog/outline rules to the resulting SVG. Geometry-only
SVG output is retained too. No temporary ZIP archive or export edit is needed.

The direct API validates byte-view, size, native format, output size and UTF-8,
and releases its input and encoded buffers in `finally`. Matching originals
must be document-owned local blobs; ambiguous, missing-API or decode failures
are explicit errors. The image loader deduplicates work and aborts owned reads
on disposal. Source names and SHA-256 identities appear in the rendering report,
without publishing media payloads or private font bytes. The preferred-source
patch is `patches/0023-native-metafile-pie-and-owned-render-api.patch`; auxiliary
source packaging and all four independent JS/WASM reproduction pairs must be
verified before selecting those new vendor bytes.

Headless rendering and product lifecycle checks use Chromium's default graphics
path. A controlled two-document native-iframe comparison found that forcing
ANGLE/SwiftShader caused large Mac/Linux vector raster differences despite
identical SVG, fonts and geometry. Removing those forced options reduced the
matrix slide difference from 61,100 pixels to two one-channel rounding pixels
and the EMF slide difference from 2,888 pixels to zero. Whole-corpus verification
and fresh native PowerPoint references remain separate acceptance requirements.
