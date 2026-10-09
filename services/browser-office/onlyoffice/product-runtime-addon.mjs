/* SPDX-License-Identifier: MPL-2.0 */
import { installOnlyOfficeNativeComplements, bootstrapOnlyOfficeNativeComplements } from "./native-complements.mjs";
import { attachOnlyOfficeResourceHost } from "./product-resources.mjs";
import { installOnlyOfficeDocumentFontCatalog, installOnlyOfficeDocumentFontLoader } from "./document-fonts.mjs";

import { installOnlyOfficeMissingSmartArtLayouts } from "./missing-smartart-layouts.mjs";
import { installOnlyOfficeChart3dDefaults } from "./chart-3d-defaults.mjs";
import { onlyOfficeParagraphFormat } from "./paragraph-format.mjs";

import { installOnlyOfficeShapeEffects } from "./shape-effects.mjs";
// Source-pinned interpreted additions; no rebuild or generated vendor files.
// Hosts must record these served overlays along with the retained distribution.
export function addOnlyOfficeProductBootstrap(html) {
  if(typeof html!=="string"||!html.includes("<head>"))throw Error("onlyoffice_product_bootstrap_html_invalid");
  return html.replace("<head>","<head><script>("+installOnlyOfficeDocumentFontCatalog.toString()+")();"+"("+bootstrapOnlyOfficeNativeComplements.toString()+")("+"function(){("+installOnlyOfficeNativeComplements.toString()+")();("+installOnlyOfficeShapeEffects.toString()+")();});</script>");
}
export function addOnlyOfficeProductSdk(source) {
  return source+"\n;("+installOnlyOfficeDocumentFontLoader.toString()+")();\n"+";("+installOnlyOfficeMissingSmartArtLayouts.toString()+")("+onlyOfficeParagraphFormat.toString()+");\n"+";("+installOnlyOfficeChart3dDefaults.toString()+")();\n";
}
export function addOnlyOfficeProductResourceHost(source) {
  const anchor="G=await Tn(An,r),tr(),cr(`READY`,G.getState())";
  const header="customization:{help:!1,about:!1,hideRightMenu:!0,compactToolbar:!0";
  if(typeof source!=="string"||source.split(anchor).length!==2||source.split(header).length!==2)throw Error("onlyoffice_product_resource_host_source_mismatch");
  // The product host owns the document title. Keep the original native logo,
  // menus and editing controls while avoiding a second title/action row.
  const customized=source.replace(header,header+",compactHeader:!0,toolbarHideFileName:!0");
  return 'import {prepareOnlyOfficeDocumentFonts as __prepareDocumentFonts} from "/document-fonts.bundle.js";\n'+customized.replace(anchor,"await __prepareDocumentFonts(r.buffer),G=await Tn(An,r),("+attachOnlyOfficeResourceHost.toString()+")(G,c),tr(),cr(`READY`,G.getState())");
}
