import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  computePatchSeriesSha256,
  patchedSourcePaths,
  valueAtPath,
} from "./libreoffice/upstream.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("./upstream.json", import.meta.url), "utf8"),
);
const fetcher = readFileSync(
  new URL("./fetch-runtime.mjs", import.meta.url),
  "utf8",
);
const toolchainDockerfile = readFileSync(
  new URL("./libreoffice/Dockerfile.toolchain", import.meta.url),
  "utf8",
);
const candidateBuilder = readFileSync(
  new URL("./libreoffice/build-candidate-runtime.sh", import.meta.url),
  "utf8",
);
const genericPptxInvariantsPatch = readFileSync(
  new URL(
    "./libreoffice/patches/0002-generic-pptx-edit-invariants.patch",
    import.meta.url,
  ),
  "utf8",
);
const browserPatchSeries = manifest.sourceCandidate.patches
  .map((relativePatch) =>
    readFileSync(new URL(relativePatch, import.meta.url), "utf8"),
  )
  .join("\n");

test("browser Office runtime is reproducible and remains unapproved by default", () => {
  assert.match(
    valueAtPath("sourceCandidate.patchLevel"),
    /^browser-undo-v[1-9][0-9]*$/u,
  );
  assert.throws(() => valueAtPath("sourceCandidate.unknown"), /Unknown/u);
  assert.equal(manifest.status, "viability_probe_only");
  assert.match(manifest.source.buildCommit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.source.candidateCommit, /^[0-9a-f]{40}$/u);
  assert.notEqual(manifest.source.candidateCommit, manifest.source.buildCommit);
  assert.equal(manifest.sourceCandidate.patchSeriesReady, true);
  assert.equal(manifest.sourceCandidate.buildReady, false);
  assert.equal(manifest.sourceCandidate.nativeSlideStructureReady, false);
  assert.equal(
    computePatchSeriesSha256(),
    manifest.sourceCandidate.patchSeriesSha256,
  );
  assert.deepEqual(manifest.sourceCandidate.invariants, [
    "table-cell-native-undo",
    "page-background-native-undo",
    "slide-real-name-undo",
    "moved-page-object-identity",
    "table-structure-geometry-undo",
    "table-insert-format-inheritance",
    "table-text-cursor-undo",
    "slide-layout-master-preservation",
    "sparse-master-slide-insertion",
    "pptx-slide-name-roundtrip",
    "pptx-text-shadow-roundtrip",
    "native-object-creation-undo",
    "text-layout-cache-invalidation",
    "table-cell-property-uno-undo",
    "pptx-object-lock-roundtrip",
    "object-interaction-uno-undo",
    "pptx-object-interaction-roundtrip",
    "content-placeholder-editability",
    "placeholder-local-property-precedence",
    "non-layout-undo-master-safety",
    "page-property-uno-undo",
    "object-property-uno-undo",
    "browser-property-pptx-roundtrip",
    "shape-text-native-undo",
    "shape-text-property-native-undo",
    "speaker-notes-native-undo",
    "browser-text-pptx-roundtrip",
    "shape-appearance-property-native-undo",
    "text-appearance-property-native-undo",
    "slide-metadata-property-native-undo",
    "line-style-property-native-undo",
    "visible-line-style-pptx-roundtrip",
    "paragraph-format-property-native-undo",
    "document-slide-size-native-undo",
    "master-theme-native-undo",
    "complete-theme-copy-roundtrip",
    "animation-lifecycle-native-undo",
    "advanced-shape-style-native-undo",
    "connector-geometry-native-undo",
    "semantic-diagram-native-undo",
    "equation-source-native-undo",
    "asset-replacement-native-undo",
    "media-content-preserves-playback-native-undo",
    "media-playback-native-undo",
    "reading-order-native-undo",
    "pptx-reading-order-shape-tree-undo",
    "pptx-shape-accessibility-metadata-roundtrip",
    "semantic-asset-native-regression-tests",
  ]);
  assert.deepEqual(manifest.sourceCandidate.requiredCppunitTargets, [
    "CppunitTest_sd_uiimpress",
    "CppunitTest_sd_misc_tests",
  ]);
  assert.equal(manifest.sourceCandidate.focusedCppunitTests.length, 34);
  assert.equal(
    new Set(manifest.sourceCandidate.focusedCppunitTests).size,
    manifest.sourceCandidate.focusedCppunitTests.length,
  );
  for (const testSpec of manifest.sourceCandidate.focusedCppunitTests) {
    assert.match(
      testSpec,
      /^CppunitTest_[A-Za-z0-9_]+:testSpellbook[A-Za-z0-9_]+$/u,
    );
    const [target, testName] = testSpec.split(":");
    assert.ok(manifest.sourceCandidate.requiredCppunitTargets.includes(target));
    assert.match(browserPatchSeries, new RegExp(`\\b${testName}\\b`, "u"));
  }
  assert.match(manifest.toolchain.emscripten.commit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.toolchain.emsdk.commit, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.toolchain.emsdk.version, "3.1.65");
  assert.match(
    manifest.toolchain.builderBaseImage,
    /^node:22\.22\.0-bookworm@sha256:[0-9a-f]{64}$/u,
  );
  assert.match(manifest.toolchain.qt.commit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.toolchain.qt.qtbaseCommit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.javascriptBridge.commit, /^[0-9a-f]{40}$/u);
  assert.equal(
    manifest.javascriptBridge.runtimeAsset.url,
    `https://raw.githubusercontent.com/allotropia/zetajs/${manifest.javascriptBridge.commit}/source/zeta.js`,
  );
  assert.ok(!manifest.runtimeBaseUrl.includes("spellbook"));
  assert.deepEqual(
    manifest.runtimeAssets.map(({ path }) => path),
    ["soffice.js", "soffice.data.js.metadata", "soffice.wasm", "soffice.data"],
  );
  for (const asset of manifest.runtimeAssets) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
  }
  assert.equal(manifest.javascriptBridge.runtimeAsset.storedPath, "zeta.js");
  assert.match(
    manifest.javascriptBridge.runtimeAsset.sha256,
    /^[0-9a-f]{64}$/u,
  );
  assert.ok(manifest.javascriptBridge.runtimeAsset.bytes > 0);
  assert.equal(
    manifest.requiredDocumentHeaders["Cross-Origin-Opener-Policy"],
    "same-origin",
  );
  assert.equal(
    manifest.requiredDocumentHeaders["Cross-Origin-Embedder-Policy"],
    "require-corp",
  );
  assert.equal(
    manifest.requiredDocumentHeaders["Cross-Origin-Resource-Policy"],
    "cross-origin",
  );
  assert.match(fetcher, /does not match the pinned/);
  assert.match(fetcher, /Content-Encoding/);
  assert.match(fetcher, /\.partial/);
  for (const identity of [
    manifest.toolchain.builderBaseImage,
    manifest.toolchain.emsdk.commit,
    manifest.toolchain.emsdk.version,
    manifest.toolchain.emscripten.commit,
    manifest.toolchain.qt.commit,
    manifest.toolchain.qt.qtbaseCommit,
  ])
    assert.ok(
      toolchainDockerfile.includes(identity),
      `Toolchain image omits ${identity}.`,
    );
  assert.match(toolchainDockerfile, /\.\/bootstrap/u);
  assert.match(toolchainDockerfile, /em\+\+ --version/u);
  assert.match(candidateBuilder, /native-tests\.\$expected_patch_sha/u);
  assert.match(candidateBuilder, /wasm\.\$expected_patch_sha/u);
  assert.match(candidateBuilder, /use a new build root/u);
  assert.match(genericPptxInvariantsPatch, /CharShadowed/u);
  assert.doesNotMatch(
    genericPptxInvariantsPatch,
    /WriteTextGlowEffect|rRunInput\.xShapePropSet/u,
  );
});

test("browser LibreOffice patches name their complete source surface", () => {
  const paths = manifest.sourceCandidate.patches.flatMap((relativePatch) =>
    patchedSourcePaths(
      readFileSync(new URL(relativePatch, import.meta.url), "utf8"),
    ),
  );
  assert.deepEqual([...new Set(paths)].sort(), [
    "docmodel/source/theme/Theme.cxx",
    "include/oox/drawingml/shape.hxx",
    "include/oox/drawingml/shapepropertymap.hxx",
    "include/oox/export/drawingml.hxx",
    "include/oox/export/shapes.hxx",
    "include/oox/ppt/comments.hxx",
    "include/oox/ppt/slidetransitioncontext.hxx",
    "include/svx/sdr/contact/viewcontactofsdrmediaobj.hxx",
    "include/svx/svdotable.hxx",
    "oox/inc/drawingml/textcharacterproperties.hxx",
    "oox/source/drawingml/connectorshapecontext.cxx",
    "oox/source/drawingml/graphicshapecontext.cxx",
    "oox/source/drawingml/lineproperties.cxx",
    "oox/source/drawingml/shape.cxx",
    "oox/source/drawingml/shapecontext.cxx",
    "oox/source/drawingml/shapegroupcontext.cxx",
    "oox/source/drawingml/textcharacterproperties.cxx",
    "oox/source/drawingml/textcharacterpropertiescontext.cxx",
    "oox/source/drawingml/textparagraph.cxx",
    "oox/source/drawingml/textparagraphproperties.cxx",
    "oox/source/drawingml/textrun.cxx",
    "oox/source/export/drawingml.cxx",
    "oox/source/export/shapes.cxx",
    "oox/source/ppt/comments.cxx",
    "oox/source/ppt/pptgraphicshapecontext.cxx",
    "oox/source/ppt/pptshape.cxx",
    "oox/source/ppt/presentationfragmenthandler.cxx",
    "oox/source/ppt/slidetransition.cxx",
    "oox/source/ppt/slidetransitioncontext.cxx",
    "oox/source/token/properties.txt",
    "sd/inc/drawdoc.hxx",
    "sd/inc/sdpage.hxx",
    "sd/qa/unit/misc-tests.cxx",
    "sd/qa/unit/sdmodeltestbase.hxx",
    "sd/qa/unit/uiimpress.cxx",
    "sd/source/core/CustomAnimationEffect.cxx",
    "sd/source/core/drawdoc2.cxx",
    "sd/source/core/sdpage.cxx",
    "sd/source/filter/eppt/epptooxml.hxx",
    "sd/source/filter/eppt/pptx-epptooxml.cxx",
    "sd/source/ui/inc/unmodpg.hxx",
    "sd/source/ui/unoidl/unoobj.cxx",
    "sd/source/ui/unoidl/unopage.cxx",
    "sd/source/ui/view/drviews7.cxx",
    "sd/source/ui/view/unmodpg.cxx",
    "solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk",
    "svx/source/inc/cell.hxx",
    "svx/source/sdr/contact/viewcontactofsdrmediaobj.cxx",
    "svx/source/sdr/contact/viewobjectcontactofsdrmediaobj.cxx",
    "svx/source/svdraw/svdmodel.cxx",
    "svx/source/svdraw/svdundo.cxx",
    "svx/source/table/cell.cxx",
    "svx/source/table/svdotable.cxx",
    "svx/source/table/tablecolumn.cxx",
    "svx/source/table/tablemodel.cxx",
    "svx/source/table/tablerow.cxx",
    "svx/source/table/tableundo.cxx",
    "svx/source/unodraw/unoshtxt.cxx",
  ]);
});

test("browser presentation undo uses the pinned document undo ABI", () => {
  assert.match(
    browserPatchSeries,
    /GetDocSh\(\)->GetUndoManager\(\)->AddUndoAction/u,
  );
  assert.doesNotMatch(
    browserPatchSeries,
    /->AddUndo\(std::make_unique<(?:ObjectInteractionUndoAction|PageVisibilityUndoAction|PageNameUndoAction|PageMetadataUndoAction|PageThemeUndoAction|ObjectNavigationUndoAction|EquationSourceUndoAction|GraphicContentUndoAction|MediaContentUndoAction|sd::UndoTransition|sd::UndoAnimation)/u,
  );
  assert.doesNotMatch(browserPatchSeries, /std::optional<avmedia::MediaItem>/u);
  assert.match(
    genericPptxInvariantsPatch,
    /GetSdrUndoFactory\(\)\.CreateUndoNewObject/u,
  );
  assert.match(
    browserPatchSeries,
    /pDrawDocument->GetDocSh\(\)->GetUndoManager\(\)/u,
  );
  assert.doesNotMatch(browserPatchSeries, /pDrawDocument->GetUndoManager\(\)/u);
  assert.doesNotMatch(browserPatchSeries, /a(?:Dash|Marker)Names\.empty\(\)/u);
  assert.doesNotMatch(browserPatchSeries, /Graphic\(a(?:Old|New)Bitmap\)/u);
  assert.match(
    browserPatchSeries,
    /static_cast<SdrObject\*>\(pOriginal\.get\(\)\)/u,
  );
});
