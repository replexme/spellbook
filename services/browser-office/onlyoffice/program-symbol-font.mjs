/* SPDX-License-Identifier: MPL-2.0 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { documentFontSelectionRecord } from './document-font-selection.mjs';
import { readPublicFontCatalog } from './document-fonts.mjs';
import recipe from './symbol-font/font-recipe.json' with { type: 'json' };
import face from './symbol-font/native-font-info.json' with { type: 'json' };

const fontRoot = new URL('./symbol-font/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fontPath = '/fonts/spellbook-symbols-' + face.fontSha256 + '.ttf';
export const onlyOfficeProgramSymbolPaths = Object.freeze([
  '/onlyoffice-browser-font-assets.json', '/sdkjs/common/AllFonts.js',
  '/server/FileConverter/bin/AllFonts.js', '/server/FileConverter/bin/font_selection.bin',
  '/onlyoffice-browser-font-source-map.json', '/font-licenses.json', fontPath,
]);
const serialize = catalog => Object.entries(catalog).map(([key,value]) =>
  `window[${JSON.stringify(key)}] = ${JSON.stringify(value)};`).join('\n');

// One immutable public face augments the same catalogs used by converter and SDK.
// The vendor distribution and its original font package remain separately hashed.
export async function createOnlyOfficeProgramSymbolAssets(distributionDirectory) {
  const read = name => fs.readFile(path.join(distributionDirectory,name));
  const manifest = JSON.parse(await read('onlyoffice-browser-font-assets.json'));
  if (manifest.allFonts !== 'sdkjs/common/AllFonts.js' ||
      manifest.fontSelection !== 'server/FileConverter/bin/font_selection.bin' ||
      manifest.fontSourceMap !== 'onlyoffice-browser-font-source-map.json')
    throw Error('onlyoffice_program_font_catalog_boundary_changed');
  const [font,notice,catalog,map,selection,permissions] = await Promise.all([
    fs.readFile(new URL('SpellbookSymbols-Regular.ttf',fontRoot)),
    fs.readFile(new URL('OFL.txt',fontRoot),'utf8'),
    read(manifest.allFonts).then(bytes => readPublicFontCatalog(bytes.toString())),
    read(manifest.fontSourceMap).then(bytes => JSON.parse(bytes)),
    read(manifest.fontSelection),
    read('font-licenses.json').then(bytes => JSON.parse(bytes)),
  ]);
  if (hash(font) !== face.fontSha256 || recipe.source.license !== 'OFL-1.1' ||
      !notice.includes('SIL OPEN FONT LICENSE') || face.nativeInfo.family_name !== recipe.family)
    throw Error('onlyoffice_program_font_source_binding_invalid');
  if (catalog.__fonts_files.length !== manifest.fonts.length ||
      map.fonts.length !== manifest.fonts.length ||
      permissions.fonts.length !== manifest.fonts.length ||
      catalog.__fonts_infos.some(row => row[0] === recipe.family))
    throw Error('onlyoffice_program_font_base_binding_invalid');
  if (selection.length < 4) throw Error('onlyoffice_program_font_selection_truncated');
  const count = selection.readUInt32LE(0); let end = 4;
  if (count > 10000) throw Error('onlyoffice_program_font_selection_count_invalid');
  for (let i=0;i<count;i++) {
    if (end+4 > selection.length) throw Error('onlyoffice_program_font_selection_truncated');
    const size=selection.readUInt32LE(end);
    if (size<4 || size>selection.length-end) throw Error('onlyoffice_program_font_selection_record_invalid');
    end+=size;
  }
  const source='/working/document-fonts/'+face.fontSha256+'.ttf';
  const built=documentFontSelectionRecord({fontBytes:font,nativeInfo:face.nativeInfo,sourcePath:source});
  const number=Buffer.alloc(4);number.writeUInt32LE(count+1);
  const core=Buffer.concat([number,selection.subarray(4,end),built.record]);
  const index=catalog.__fonts_files.length,file=fontPath.slice(1);
  catalog.__fonts_files.push(path.basename(file));
  catalog.__fonts_infos.push([built.family,index,0,-1,-1,-1,-1,-1,-1]);
  catalog.g_fonts_selection_bin=core.toString('base64');
  manifest.fonts.push(file);
  map.fonts.push({source,file,index,originalIndex:index});
  map.visibleFamilies.push(built.family);map.listedFamilies.push(built.family);
  permissions.fonts.push({file,sha256:face.fontSha256,license:'OFL-1.1',notice,
    source:recipe.source.url,modified:true,upstreamSha256:recipe.source.sha256,
    recipe:'services/browser-office/onlyoffice/symbol-font/font-recipe.json'});
  const assets = new Map([
    [fontPath,font],
    ['/onlyoffice-browser-font-assets.json',Buffer.from(JSON.stringify(manifest))],
    ['/'+manifest.allFonts,Buffer.from(serialize(catalog))],
    ['/server/FileConverter/bin/AllFonts.js',Buffer.from(serialize({...catalog,__fonts_files:map.fonts.map(row=>row.source)}))],
    ['/'+manifest.fontSourceMap,Buffer.from(JSON.stringify(map,null,2))],
    ['/'+manifest.fontSelection,Buffer.concat([core,selection.subarray(end)])],
    ['/font-licenses.json',Buffer.from(JSON.stringify(permissions,null,2))],
  ]);
  const identity=Object.freeze({fontSha256:face.fontSha256,fontFaces:manifest.fonts.length,fontCatalogSha256:hash(assets.get('/'+manifest.fontSourceMap)),
    assetsSha256:hash(Buffer.from(JSON.stringify([...assets].map(([pathname,bytes])=>({pathname,sha256:hash(bytes)})))))});
  return {assets,identity};
}
