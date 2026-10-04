/* SPDX-License-Identifier: MPL-2.0 */
// PPTX fills have no native named-style dictionary. Expose only uniquely
// named authored drawing fills as document-owned reusable styles. Never
// fabricate a name for an anonymous fill or interpret a name as an object ID.
export function onlyOfficeDocumentFillCatalog(state) {
  const candidates=new Map();
  const visit=drawings=>drawings.forEach(drawing=>{
    const type=drawing.fill?.type,name=drawing.name;
    if([4,5].includes(type)&&typeof name==="string"&&name){
      const key=type+":"+name,items=candidates.get(key)??[];items.push(drawing);candidates.set(key,items);
    }
    if(drawing.groupChildren)visit(drawing.groupChildren);
  });state.slides.forEach(slide=>visit(slide.onlyoffice.drawings));
  const names=type=>[...candidates.entries()].filter(([key,items])=>key.startsWith(type+":")&&items.length===1).map(([,items])=>items[0].name).sort();
  return {fillGradientNames:names(4),fillHatchNames:names(5)};
}
