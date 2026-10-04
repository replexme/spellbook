/* SPDX-License-Identifier: MPL-2.0 */
// Save ownership comes from the admitted canonical request and its BEFORE
// observation. It never comes from the edited export or transient native IDs.
export function onlyOfficeSourceTargets(before, commands, prepared) {
  if (!Array.isArray(commands)) return null;
  const target = id => {
    if (typeof id !== "string" || !/^\d+(?:\/\d+)+$/.test(id))
      throw Error("onlyoffice_product_source_target_invalid");
    const [slideIndex, shapeIndex, ...path] = id.split("/").map(Number);
    let element = before.slides[slideIndex]?.elements[shapeIndex];
    for (const index of path) element = element?.elements[index];
    if (!element) throw Error("onlyoffice_product_source_target_missing");
    return {slideIndex, shapeIndex, elementPath:[shapeIndex,...path],
      name:before.slides[slideIndex].elements[shapeIndex].objectName??""};
  };
  return commands.flatMap((command,commandIndex) => {
    // Private native resources may contain bytes/URLs. Those are not part of
    // the canonical source declaration and must not escape to the save host.
    const canonical = Object.fromEntries(Object.entries(command).filter(([key]) =>
      !key.startsWith("native") && !["index","slideIndex"].includes(key)));
    if(["set_master_theme","set_slide_layout"].includes(command.op)){
      const master=before.masters[command.masterIndex];
      if(!master)throw Error("onlyoffice_product_source_master_missing");
      const layout=command.layout??prepared?.[commandIndex]?.nativeLayoutIndex;
      if(command.op==="set_slide_layout"&&!Number.isSafeInteger(layout))throw Error("onlyoffice_product_source_layout_binding_missing");
      return [{...canonical,sourceMasterCount:before.masters.length,sourceLayoutCount:master.layouts.length,
        ...(command.op==="set_slide_layout"?{slideIndex:command.slideIndex,layout}:{})}];
    }
    if (command.elementIds) return command.elementIds.map(id => ({
      ...canonical,...target(id),
    }));
    if (command.elementId) return [{...canonical,...target(command.elementId),
      ...(command.index != null ? {index:command.index} : {}),
    }];
    const slideIndex = command.slideIndex;
    if (slideIndex != null && (!Number.isSafeInteger(slideIndex) || !before.slides[slideIndex]))
      throw Error("onlyoffice_product_source_slide_missing");
    if(command.op==="set_slide_metadata") {
      const q=command.slideMetadata, ownedKinds=[];
      if(q.footerVisible!=null||q.footerText!=null)ownedKinds.push("footer");
      if([q.dateTimeVisible,q.dateTimeFixed,q.dateTimeText,q.dateTimeFormat].some(value=>value!=null))ownedKinds.push("dateTime");
      if(q.pageNumberVisible!=null)ownedKinds.push("pageNumber");
      const slide=before.slides[slideIndex],shapeNames=[];
      const binding=slide.onlyoffice.layoutBinding,master=before.masters[binding.masterIndex],layout=master.layouts[binding.layoutIndex];
      for(const kind of ownedKinds){
        const existing=slide.onlyoffice.drawings.flatMap((drawing,index)=>drawing.placeholder?.kind===kind?[slide.elements[index].objectName??""]:[]);
        if(existing.length){shapeNames.push(...existing);continue;}
        const visible={footer:"footerVisible",dateTime:"dateTimeVisible",pageNumber:"pageNumberVisible"}[kind];
        const text=kind==="footer"?q.footerText:kind==="dateTime"?q.dateTimeText:null;
        if(q[visible]===false&&text==null&&!(kind==="dateTime"&&(q.dateTimeFixed!=null||q.dateTimeFormat!=null)))continue;
        const template=layout.drawings.find(drawing=>drawing.placeholder?.kind===kind)??master.drawings.find(drawing=>drawing.placeholder?.kind===kind);
        if(!template)throw Error("onlyoffice_product_metadata_source_template_missing");
        shapeNames.push(template.name??"");
      }
      if(shapeNames.some(name=>!name))throw Error("onlyoffice_product_metadata_owner_unnamed");
      return [{...canonical,slideIndex,shapeNames}];
    }
    return [{...canonical,...(slideIndex != null ? {slideIndex} : {})}];
  });
}
