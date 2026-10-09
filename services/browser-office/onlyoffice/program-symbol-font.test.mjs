/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';import test from 'node:test';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createOnlyOfficeProgramSymbolAssets,onlyOfficeProgramSymbolPaths} from './program-symbol-font.mjs';
import {createOnlyOfficeWorkspaceServer} from './workspace-server.mjs';
import {readPublicFontCatalog} from './document-fonts.mjs';
import face from './symbol-font/native-font-info.json' with {type:'json'};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'spellbook-symbol-program-'));
  const manifest={allFonts:'sdkjs/common/AllFonts.js',fontSelection:'server/FileConverter/bin/font_selection.bin',fontSourceMap:'onlyoffice-browser-font-source-map.json',fontLicenses:'font-licenses.json',fonts:[],fontThumbnails:[]};
  const catalog={__all_fonts_js_version__:2,__fonts_files:[],__fonts_infos:[],__fonts_ranges:[1,2,3],g_fonts_selection_bin:'AAAAAA=='};
  const files={'onlyoffice-browser-font-assets.json':JSON.stringify(manifest),'onlyoffice-browser-font-source-map.json':JSON.stringify({fonts:[],visibleFamilies:[],listedFamilies:[]}),'font-licenses.json':JSON.stringify({fonts:[]}),[manifest.allFonts]:Object.entries(catalog).map(([k,v])=>`window[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join('\n'),[manifest.fontSelection]:Buffer.concat([Buffer.alloc(4),Buffer.from('unchanged-fallback-tail')]),'sdk.bundle.js':'host','workspace-source-receipt.json':'declared symbols source','distribution-manifest.json':JSON.stringify({files:[]})};
  for(const [name,bytes] of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);}
  return {root,manifest,catalog,selection:files[manifest.fontSelection]};
}
test('public program face binds identical browser/converter bytes and retains fallback tables and permissions',async()=>{
  const f=await fixture();try{
    const result=await createOnlyOfficeProgramSymbolAssets(f.root),assets=result.assets;
    const manifest=JSON.parse(assets.get('/onlyoffice-browser-font-assets.json')),map=JSON.parse(assets.get('/'+manifest.fontSourceMap));
    const catalog=readPublicFontCatalog(assets.get('/'+manifest.allFonts).toString()),converter=readPublicFontCatalog(assets.get('/server/FileConverter/bin/AllFonts.js').toString());
    assert.equal(manifest.fonts.length,1);assert.equal(sha(assets.get('/'+manifest.fonts[0])),face.fontSha256);assert.deepEqual(catalog.__fonts_infos,converter.__fonts_infos);assert.deepEqual(catalog.__fonts_ranges,f.catalog.__fonts_ranges);assert.deepEqual(converter.__fonts_files,map.fonts.map(row=>row.source));
    const selection=assets.get('/'+manifest.fontSelection);assert.equal(selection.readUInt32LE(0),1);assert.equal(selection.subarray(4+selection.readUInt32LE(4)).toString(),'unchanged-fallback-tail');
    const permissions=JSON.parse(assets.get('/font-licenses.json')).fonts[0];assert.equal(permissions.sha256,face.fontSha256);assert.equal(permissions.license,'OFL-1.1');assert.equal(permissions.modified,true);assert.match(permissions.notice,/SIL OPEN FONT LICENSE/);assert.equal(sha(await readFile(path.join(f.root,manifest.fontSelection))),sha(f.selection));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('served public manifest hashes cover the actual composed catalogs and new font',async()=>{
  const f=await fixture();const server=createOnlyOfficeWorkspaceServer({distributionDirectory:f.root,bundleDirectory:f.root,workspaceOrigin:'http://127.0.0.1:35602',sdkOrigin:'http://127.0.0.1:35616',inspectionOrigin:'http://127.0.0.1:35617',hostOrigins:['https://spellbook.my']});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/public-programs.json');assert.equal(response.status,200);const {hashes}=await response.json();
    for(const pathname of onlyOfficeProgramSymbolPaths){const r=await fetch(base+pathname);assert.equal(r.status,200,pathname);assert.equal(sha(Buffer.from(await r.arrayBuffer())),hashes[pathname],pathname);}
    const permissions=await(await fetch(base+'/font-licenses.json')).json();assert.equal(permissions.fonts[0].modified,true);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(f.root,{recursive:true,force:true});}
});
