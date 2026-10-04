/* SPDX-License-Identifier: MPL-2.0 */
// SDK geometry setters silently ignore placeholders with inherited transforms.
// Materialize only the bound targets through native history, retaining their
// current rotation, flips and text autofit before the requested setter runs.
export function materializeOnlyOfficeNativeGeometry(command) {
  if (!['move','resize','rotate','flip','align','distribute','group','duplicate_element','set_connector'].includes(command.op)) return false;
  const editor=window.Asc.editor, model=editor.WordControl.m_oLogicDocument;
  const ids=new Set([command.nativeId,...(command.nativeIds??[])]);
  const targets=[];
  const visit=shapes=>shapes.forEach(shape=>{if(ids.has(shape.Id)&&(!shape.spPr?.xfrm||['offX','offY','extX','extY'].some(key=>!Number.isFinite(shape.spPr.xfrm[key]))))targets.push(shape);if(shape.spTree)visit(shape.spTree);});
  model.Slides.forEach(slide=>visit(slide.cSld.spTree));
  if (!targets.length) return false;
  if (!editor.isGroupActions()) throw Error('onlyoffice_product_transaction_required');
  if (typeof window.AscFormat?.CheckSpPrXfrm!=='function') throw Error('onlyoffice_product_native_geometry_unavailable');
  for (const shape of targets) if (![shape.x,shape.y,shape.extX,shape.extY].every(Number.isFinite)) throw Error('onlyoffice_product_native_geometry_unavailable');
  editor.executeGroupActionsStart();
  try {
    window.AscBuilder.Slide.Api.GetPresentation().CreateNewHistoryPoint();
    for (const shape of targets) {
      const rotation=shape.rot,flipH=shape.flipH,flipV=shape.flipV;
      window.AscFormat.CheckSpPrXfrm(shape,true);
      const transform=shape.spPr.xfrm;
      for (const [key,value] of [['offX',shape.x],['offY',shape.y],['extX',shape.extX],['extY',shape.extY]])
        if (!Number.isFinite(transform[key])) transform['set'+key[0].toUpperCase()+key.slice(1)](value);
      if (transform.rot==null&&Number.isFinite(rotation)) transform.setRot(rotation);
      if (transform.flipH==null&&flipH===true) transform.setFlipH(flipH);
      if (transform.flipV==null&&flipV===true) transform.setFlipV(flipV);
    }
    return true;
  } finally { editor.executeGroupActionsEnd(); }
}
