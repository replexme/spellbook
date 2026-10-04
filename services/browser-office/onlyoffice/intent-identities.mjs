/* SPDX-License-Identifier: MPL-2.0 */
// Canonical paths describe the current tree. Reordering/reparenting must move
// references with their retained object; rewriting only elementId would leave
// connector and animation observations pointing at a different object.
export function rebaseOnlyOfficeIntentIdentities(slide, slideIndex) {
  const originalPrefix=String(slide.slideIndex??slideIndex)+"/";
  const paths=new Map();
  const visit=(elements,prefix)=>elements.forEach((element,index)=>{
    const path=prefix+"/"+index;paths.set(element.elementId,path);
    element.elementId=path;visit(element.elements,path);
  });
  visit(slide.elements,String(slideIndex));if(Object.hasOwn(slide,"slideIndex"))slide.slideIndex=slideIndex;
  const drawings=values=>values.forEach(drawing=>{
    if(drawing.connector)for(const key of ["startElementId","endElementId"]){
      const current=drawing.connector[key];
      if(current!=null){if(paths.has(current))drawing.connector[key]=paths.get(current);else if(current.startsWith(originalPrefix))drawing.connector[key]=null;}
    }
    if(drawing.groupChildren)drawings(drawing.groupChildren);
  });
  drawings(slide.onlyoffice.drawings);
  for(const effect of slide.onlyoffice.effects??[])
    if(paths.has(effect.targetElementId))effect.targetElementId=paths.get(effect.targetElementId);
    else if(effect.targetElementId?.startsWith(originalPrefix))effect.targetElementId=null;
}
