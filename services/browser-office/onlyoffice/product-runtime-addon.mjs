/* SPDX-License-Identifier: MPL-2.0 */
import { installOnlyOfficeNativeComplements, bootstrapOnlyOfficeNativeComplements } from "./native-complements.mjs";
import { attachOnlyOfficeResourceHost } from "./product-resources.mjs";

// Source-pinned interpreted additions; no rebuild or generated vendor files.
// Hosts must record these served overlays along with the retained distribution.
export function addOnlyOfficeProductBootstrap(html) {
  if(typeof html!=="string"||!html.includes("<head>"))throw Error("onlyoffice_product_bootstrap_html_invalid");
  return html.replace("<head>","<head><script>"+"("+bootstrapOnlyOfficeNativeComplements.toString()+")("+installOnlyOfficeNativeComplements.toString()+");</script>");
}
export function addOnlyOfficeProductResourceHost(source) {
  const anchor="G=await Tn(An,r),tr(),cr(`READY`,G.getState())";
  if(typeof source!=="string"||source.split(anchor).length!==2)throw Error("onlyoffice_product_resource_host_source_mismatch");
  return source.replace(anchor,"G=await Tn(An,r),("+attachOnlyOfficeResourceHost.toString()+")(G),tr(),cr(`READY`,G.getState())");
}
