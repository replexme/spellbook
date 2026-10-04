/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const flag=(name,fallback)=>{const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1];};
const output=path.resolve(flag("--output","artifacts/onlyoffice-product-case-inputs"));
const root=path.resolve(flag("--fixture-root","artifacts/office-audit-20261004/libreoffice-all94-no-build-v1"));
await fs.mkdir(output,{recursive:false});
const registry=JSON.parse(await fs.readFile("contracts/native-edit-capabilities.json","utf8"));
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const parser=new DOMParser(),serializer=new XMLSerializer();
const p="http://schemas.openxmlformats.org/presentationml/2006/main",a="http://schemas.openxmlformats.org/drawingml/2006/main";
const r="http://schemas.openxmlformats.org/package/2006/relationships";
const o="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const children=node=>Array.from(node.childNodes).filter(node=>node.nodeType===1);
const parse=bytes=>parser.parseFromString(strFromU8(bytes),"application/xml");
const serialize=doc=>strToU8(serializer.serializeToString(doc));
const surfaceBytes=await fs.readFile(path.join(root,"general-native-surface/baseline.pptx"));
const parts=unzipSync(surfaceBytes),slide=parse(parts["ppt/slides/slide1.xml"]);
const tree=slide.getElementsByTagNameNS(p,"spTree")[0];
const shapes=children(tree).filter(node=>node.localName==="sp");
if(shapes.length<2)throw Error("Authored surface needs two existing text shapes");
let nextId=Math.max(...Array.from(slide.getElementsByTagNameNS(p,"cNvPr")).map(node=>Number(node.getAttribute("id"))))+1;
const clone=(shape,name)=>{
  const node=shape.cloneNode(true),properties=node.getElementsByTagNameNS(p,"cNvPr")[0];
  properties.setAttribute("id",String(nextId++));properties.setAttribute("name",name);
  return node;
};
const third=clone(shapes[0],"Authored third shape");
const thirdOffset=third.getElementsByTagNameNS(a,"off")[0];
if(!thirdOffset)throw Error("Authored third shape needs a transform");
thirdOffset.setAttribute("x",String(Number(thirdOffset.getAttribute("x"))+720000));
tree.appendChild(third);
const presentation=parse(parts["ppt/presentation.xml"]),size=presentation.getElementsByTagNameNS(p,"sldSz")[0];
const group=parser.parseFromString(`<p:grpSp xmlns:p="${p}" xmlns:a="${a}"><p:nvGrpSpPr><p:cNvPr id="${nextId++}" name="Authored grouped shapes"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${size.getAttribute("cx")}" cy="${size.getAttribute("cy")}"/><a:chOff x="0" y="0"/><a:chExt cx="${size.getAttribute("cx")}" cy="${size.getAttribute("cy")}"/></a:xfrm></p:grpSpPr></p:grpSp>`,"application/xml").documentElement;
group.appendChild(clone(shapes[0],"Authored grouped first"));group.appendChild(clone(shapes[1],"Authored grouped second"));
tree.appendChild(group);
parts["ppt/slides/slide1.xml"]=serialize(slide);
parts["ppt/comments/comment1.xml"]=strToU8(`<p:cmLst xmlns:p="${p}"><p:cm authorId="1" dt="2026-10-01T00:00:00Z" idx="1"><p:pos x="1200" y="1200"/><p:text>Authored verification comment</p:text></p:cm></p:cmLst>`);
parts["ppt/commentAuthors.xml"]=strToU8(`<p:cmAuthorLst xmlns:p="${p}"><p:cmAuthor id="1" name="Verification author" initials="VA" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`);
const appendRelationship=(part,type,target,id)=>{
  const doc=parts[part]?parse(parts[part]):parser.parseFromString(`<Relationships xmlns="${r}"/>`,"application/xml");
  if(children(doc.documentElement).some(node=>node.getAttribute("Id")===id))throw Error("Authored fixture relationship collision");
  const rel=doc.createElementNS(r,"Relationship");rel.setAttribute("Id",id);rel.setAttribute("Type",o+"/"+type);rel.setAttribute("Target",target);doc.documentElement.appendChild(rel);parts[part]=serialize(doc);
};
appendRelationship("ppt/slides/_rels/slide1.xml.rels","comments","../comments/comment1.xml","rIdAuthoredComments");
appendRelationship("ppt/_rels/presentation.xml.rels","commentAuthors","commentAuthors.xml","rIdAuthoredCommentAuthors");
const types=parse(parts["[Content_Types].xml"]);
for(const [name,type] of [["/ppt/comments/comment1.xml","comments"],["/ppt/commentAuthors.xml","commentAuthors"]]){
  const node=types.createElementNS(types.documentElement.namespaceURI,"Override");node.setAttribute("PartName",name);node.setAttribute("ContentType","application/vnd.openxmlformats-officedocument.presentationml."+type+"+xml");types.documentElement.appendChild(node);
}
parts["[Content_Types].xml"]=serialize(types);
const authoredBytes=zipSync(parts,{level:6}),authoredPath=path.join(output,"authored-native-surface.pptx");
await fs.writeFile(authoredPath,authoredBytes);
// Fixture assets are extracted from the already authored source package, not
// fetched from a network or generated inside the measured native request.
const assetSource=await fs.readFile(path.join(root,"semantic-assets/candidate.pptx"));
const assets=unzipSync(assetSource),imageId="d761e08a-a94c-4d48-afab-8df99f399081",mediaId="95ef77d4-aa68-43cd-9f4b-ce9e751e4cc5";
const resources={};
for(const [assetId,part,mediaType,name] of [[imageId,"ppt/media/image1.png","image/png","owned-image.png"],[mediaId,"ppt/media/media2.wav","audio/wav","owned-audio.wav"]]){
  if(!assets[part])throw Error("Authored fixture asset missing:"+part);
  const target=path.join(output,name);await fs.writeFile(target,assets[part]);
  resources[assetId]={assetId,mediaType,path:target,sourcePart:part,sha256:sha256(assets[part])};
}
const resourceFile=path.join(output,"resources.json");await fs.writeFile(resourceFile,JSON.stringify(resources,null,2));
const cases=Object.entries(registry.mutationModel.operations).map(([operation,contract])=>{
  let input=authoredPath;
  if(["move_slide","delete_slide","duplicate_slide","set_sections"].includes(operation))input=path.resolve("artifacts/office-audit-20261004/native-sections-real24-fixture.pptx");
  else if(contract.family.startsWith("table_"))input=path.join(root,"table-structure/baseline.pptx");
  else if(contract.family==="chart_model")input=path.join(root,"chart-data/baseline.pptx");
  else if(contract.family==="diagram_model")input=path.join(root,"smartart-diagram/baseline.pptx");
  else if(contract.family==="fontwork")input=path.join(root,"fontwork/baseline.pptx");
  else if(operation==="crop_image"||operation==="replace_image")input=path.join(root,"picture-crop/baseline.pptx");
  else if(operation==="replace_media")input=path.join(root,"semantic-assets/candidate.pptx");
  else if(operation==="set_slide_layout"||operation==="set_master_theme")input=path.join(root,"layout-master/baseline.pptx");
  else if(["set_animation_timing","remove_animation_effect","replace_animation_effect","move_animation_effect","set_connector"].includes(operation))input=path.join(root,"animation-timing/baseline.pptx");
  return {operation,input};
});
const manifest={candidateRoot:path.resolve("artifacts/office-audit-20261003/onlyoffice-cold-test-helper-candidate"),resourceFile,imageAssetId:imageId,mediaAssetId:mediaId,
  documentTool:path.resolve("services/document-worker/tools/Spellbook.Document.Tool/bin/Release/net10.0/Spellbook.Document.Tool.dll"),
  documentToolSha256:"08a7400237d1e7c7127e582efe9724d8ce9392f055cc47bf17b323c0ce2bc1af",
  authoredFixture:{path:authoredPath,sourceSha256:sha256(surfaceBytes),sha256:sha256(authoredBytes),added:["third shape","group with two copied children","one comment and author"]},
  assetSourceSha256:sha256(assetSource),cases};
await fs.writeFile(path.join(output,"cases.json"),JSON.stringify(manifest,null,2));
process.stdout.write(path.join(output,"cases.json")+"\n");
