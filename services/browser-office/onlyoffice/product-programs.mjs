/* SPDX-License-Identifier: MPL-2.0 */
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
// One program route contract is shared by the product server and real-session
// verification. Document fonts themselves are absent from this HTTP map.
export function onlyOfficeDocumentFontPrograms(bundleDirectory=path.join(root,'workspace-dist')){
  return {
    '/document-fonts.bundle.js':path.join(bundleDirectory,'document-fonts.bundle.js'),
    '/document-font-worker.js':path.join(root,'document-font-worker.js'),
    '/document-font-coverage.mjs':path.join(root,'document-font-coverage.mjs'),
    '/document-font-selection.mjs':path.join(root,'document-font-selection.mjs'),
    '/eot/eot-decoder.mjs':path.join(root,'eot/eot-decoder.mjs'),
    '/eot/eot-decoder.wasm':path.join(root,'eot/eot-decoder.wasm'),
  };
}
