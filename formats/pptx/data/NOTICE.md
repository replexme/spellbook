# presetShapeDefinitions.xml

Unmodified copy of `presetShapeDefinitions.xml` from `OfficeOpenXML-DrawingMLGeometries.zip`
inside ECMA-376 Part 1, 5th edition (December 2016), downloaded on 2026-10-11 from
https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip.
SHA-256: `2f7c868d857c1e3c4b5a6068759fe0e07d77ad58377a6618d1b02ba3507b6939`.

© Ecma International. Ecma's copyright policy
(https://ecma-international.org/policies/by-ipr/ecma-text-copyright-policy/) permits copying
and distributing the standard and preparing derivative works, including implementations in
standard-conformant products that copy its functionality, provided the copyright notice is
included and the content itself is not modified. This file is used, unmodified, as the data
for the preset geometry evaluator in `../src/render/geometry.rs`.

# presetTextWarpDefinitions.xml

Unmodified copy of `presetTextWarpDefinitions.xml` from the same `OfficeOpenXML-DrawingMLGeometries.zip`
(ECMA-376 Part 1, 5th edition, December 2016), under the same Ecma copyright policy.
SHA-256: `89640bd4aeedfa2c578d1d1acc50d569865ebdef315fd4b468087c25e36acada`. It is the data for the
WordArt warps (`a:prstTxWarp`) in `../src/render/geometry.rs` and `../src/render/warp.rs`.

# defaultTableStyle.xml

PowerPoint's default table style, "Medium Style 2 - Accent 1"
(`{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}`), as PowerPoint itself writes it into
`ppt/tableStyles.xml`; copied from a corpus deck saved by PowerPoint. It is used only when a
table references this style and the file does not carry its definition (built-in styles are
not always written).

# animationEffects.xml

The timing markup of each animation effect, as Microsoft PowerPoint for Mac 16.109.1 writes it into
the slides of a saved file (the `p:timing` trees of a test deck authored in PowerPoint), reduced to
one entry per effect by a script. It describes the file format's own markup, so that the engine
writes animations PowerPoint plays and reads back; it carries no PowerPoint program code.

# defaultTableStyle.xml (source)

The same kind of file-format markup: the table style definition PowerPoint writes into the files it
saves. Both are included for interoperability with files PowerPoint reads and writes.
