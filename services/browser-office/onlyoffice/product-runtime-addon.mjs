/* SPDX-License-Identifier: MPL-2.0 */
import { installOnlyOfficeNativeComplements, bootstrapOnlyOfficeNativeComplements } from "./native-complements.mjs";
import { attachOnlyOfficeResourceHost } from "./product-resources.mjs";
import { installOnlyOfficeDocumentFontCatalog, installOnlyOfficeDocumentFontLoader } from "./document-fonts.mjs";
import { installOnlyOfficePercentParagraphSpacing } from "./percent-paragraph-spacing.mjs";
import { installOnlyOfficeVectorImageFonts, bindOnlyOfficeSvgFonts } from "./vector-image-fonts.mjs";
import { createSfntGlyphLookup } from "./sfnt-glyph-lookup.mjs";
import { sfntTables } from "./document-font-selection.mjs";
import {createOnlyOfficeVectorGlyphOutliner} from "./vector-glyph-outlines.mjs";
import {prepareOnlyOfficeNativeMetafile} from "./native-metafile-images.mjs";

import { installOnlyOfficeMissingSmartArtLayouts } from "./missing-smartart-layouts.mjs";
import { installOnlyOfficeChart3dDefaults } from "./chart-3d-defaults.mjs";
import { installOnlyOfficeLegacySymbolBullets } from "./legacy-symbol-bullets.mjs";
import symbolRecipe from "./symbol-font/font-recipe.json" with { type: "json" };
import { onlyOfficeParagraphFormat } from "./paragraph-format.mjs";

import { installOnlyOfficeShapeEffects } from "./shape-effects.mjs";
// Source-pinned interpreted additions; no rebuild or generated vendor files.
// Hosts must record these served overlays along with the retained distribution.
export function addOnlyOfficeProductBootstrap(html) {
  if(typeof html!=="string"||!html.includes("<head>"))throw Error("onlyoffice_product_bootstrap_html_invalid");
  return html.replace("<head>","<head><script>("+installOnlyOfficeDocumentFontCatalog.toString()+")();"+"("+bootstrapOnlyOfficeNativeComplements.toString()+")("+"function(){("+installOnlyOfficeNativeComplements.toString()+")();("+installOnlyOfficeShapeEffects.toString()+")();});</script>");
}
export function addOnlyOfficeProductSdk(source) {
  return source+"\n;("+installOnlyOfficeDocumentFontLoader.toString()+")();\n"+";("+installOnlyOfficeMissingSmartArtLayouts.toString()+")("+onlyOfficeParagraphFormat.toString()+");\n"+";("+installOnlyOfficeChart3dDefaults.toString()+")();\n"+";("+installOnlyOfficeLegacySymbolBullets.toString()+")("+JSON.stringify(symbolRecipe.glyphs)+");\n"+
    ";("+installOnlyOfficePercentParagraphSpacing.toString()+")();\n"+
    ";("+installOnlyOfficeVectorImageFonts.toString()+")("+JSON.stringify(symbolRecipe.glyphs)+",("+bindOnlyOfficeSvgFonts.toString()+"),("+createSfntGlyphLookup.toString()+"),("+sfntTables.toString()+"),("+createOnlyOfficeVectorGlyphOutliner.toString()+"),("+prepareOnlyOfficeNativeMetafile.toString()+"));\n";
}
export function addOnlyOfficeProductResourceHost(source) {
  const anchor="G=await Tn(An,r),tr(),cr(`READY`,G.getState())";
  const header="customization:{help:!1,about:!1,hideRightMenu:!0,compactToolbar:!0";
  if(typeof source!=="string"||source.split(anchor).length!==2||source.split(header).length!==2)throw Error("onlyoffice_product_resource_host_source_mismatch");
  // The product host owns the document title. Keep the original native logo,
  // menus and editing controls while avoiding a second title/action row.
  const customized=source.replace(header,header+",compactHeader:!0,toolbarHideFileName:!0");
  return 'import {prepareOnlyOfficeDocumentFonts as __prepareDocumentFonts,preparePptxRenderInput as __prepareRenderInput} from "/document-fonts.bundle.js";\n'+customized.replace(anchor,"await __prepareDocumentFonts(r.buffer),G=await Tn(An,{...r,buffer:await __prepareRenderInput(r.buffer,n.spellbookRenderResources)}),("+attachOnlyOfficeResourceHost.toString()+")(G,c),tr(),cr(`READY`,G.getState())");
}

export function addOnlyOfficeProductApi(source) {
  const anchor="source: a";
  if(typeof source!=="string"||source.split(anchor).length!==2)throw Error("onlyoffice_product_api_source_mismatch");
  return source.replace(anchor,"source: {...a,spellbookRenderResources:e.spellbookRenderResources??null}");
}
