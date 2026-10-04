/* SPDX-License-Identifier: MPL-2.0 */
// Canonical commands that extend the initial native product adapter. This is
// trusted frame code, never a JavaScript tool exposed to the model.
export const onlyOfficeExtendedOperations = Object.freeze([
  "insert_slide", "set_slide_size", "set_master_theme", "add_text_box",
  "add_shape", "add_connector", "add_freeform", "add_table", "align",
  "distribute", "group", "text_shadow", "set_shape_fill", "set_shape_effects",
  "text_autofit", "ungroup", "duplicate_element", "set_chart_data",
  "set_chart_type", "set_chart_format", "set_slide_layout", "set_text_box",
  "set_text_case", "set_shape_shadow", "set_object_interaction",
  "replace_text_range", "merge_table_cells", "split_table_cell",
  "set_table_cell_format", "set_slide_transition", "set_slide_metadata",
  "set_animation_timing", "add_animation_effect", "remove_animation_effect",
  "replace_animation_effect", "move_animation_effect", "insert_image",
  "replace_image", "insert_media", "replace_media", "set_smartart_node",
  "add_smartart_node", "delete_smartart_node", "set_fontwork",
  "set_paragraph_format", "set_paragraph_list", "set_connector",
  "add_comment", "edit_comment", "delete_comment",
]);

// The same function runs preflight without setters and execution inside the
// already owned native group. Every binding is checked again before execution.
export function executeOnlyOfficeExtendedCommand({command: c, phase, batchSize}) {
  if(c.nativeWorkbookEncoded){
    const encoded=c.nativeWorkbookEncoded;
    if(!Number.isSafeInteger(encoded.byteLength)||encoded.byteLength<1||encoded.byteLength>25_000_000||
      typeof encoded.base64!=="string"||encoded.base64.length!==4*Math.ceil(encoded.byteLength/3)||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.base64))throw Error("onlyoffice_product_chart_workbook_transport_invalid");
    const binary=atob(encoded.base64);
    if(binary.length!==encoded.byteLength)throw Error("onlyoffice_product_chart_workbook_transport_invalid");
    c={...c,nativeWorkbook:Uint8Array.from(binary,ch=>ch.charCodeAt(0))};
  }
  const editor = window.Asc.editor, api = window.AscBuilder.Slide.Api;
  const model = editor.WordControl.m_oLogicDocument, p = api.GetPresentation();
  const f = window.AscFormat, h = window.AscCommon.History;
  const fail = (message) => { throw Error("onlyoffice_product_" + message); };
  const need = (value, message) => { if (!value) fail(message); };
  const fn = (owner, method) => need(typeof owner?.[method] === "function", "native_method_unavailable:" + method);
  const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  const finite = (n, min = -100000, max = 100000) => Number.isFinite(n) && n >= min && n <= max;
  const rgb = (n) => api.CreateRGBColor((n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const solid = (n) => api.CreateSolidFill(rgb(n));
  const wrap = (shape) => window.AscBuilder.GetApiDrawing(shape) ??
    (shape?.getObjectType?.() === window.AscDFH.historyitem_type_Cnx ? new window.AscBuilder.ApiShape(shape) :
      shape?.getObjectType?.() === window.AscDFH.historyitem_type_SmartArtDrawing ? new window.AscBuilder.ApiGroup(shape) : null);
  const resolve = (id) => {
    need(typeof id === "string" && /^\d+(?:\/\d+)+$/.test(id), "target_invalid");
    const [si, ...path] = id.split("/").map(Number);
    let shape = model.Slides[si];
    for (const index of path) shape = (shape?.cSld?.spTree ?? shape?.spTree)?.[index];
    need(shape, "target_missing");
    return {slideIndex: si, shape};
  };
  const catalogFill=()=>{
    const q=c.shapeFill,found=[];
    need(typeof q.catalogName==="string"&&q.catalogName.length>0,"fill_catalog_name_required");
    const visit=(shapes,path)=>shapes.forEach((shape,index)=>{
      const id=path+"/"+index;
      if(shape.getOwnName?.()===q.catalogName&&shape.spPr?.Fill?.fill?.type===(q.type==="gradient"?4:5))found.push({shape,id});
      if(shape.spTree)visit(shape.spTree,id);
    });model.Slides.forEach((slide,index)=>visit(slide.cSld.spTree,String(index)));
    need(found.length===1,"fill_catalog_source_not_unique");return found[0];
  };
  const multi = ["align", "distribute", "group"].includes(c.op);
  const document = ["set_slide_size", "set_master_theme"].includes(c.op);
  const creation = ["add_text_box", "add_shape", "add_connector", "add_freeform", "add_table", "insert_image", "insert_media"].includes(c.op);
  const slideOnly = creation || ["insert_slide", "set_slide_layout", "set_slide_transition", "set_slide_metadata", "add_comment", "edit_comment", "delete_comment"].includes(c.op);
  let targets = [], si = c.slideIndex;
  if (multi) {
    need(Array.isArray(c.elementIds) && c.elementIds.length >= 2 && c.elementIds.length <= 256 && new Set(c.elementIds).size === c.elementIds.length, "targets_invalid");
    targets = c.elementIds.map(resolve); si = targets[0].slideIndex;
    need(targets.every(t => t.slideIndex === si), "targets_must_share_slide");
  } else if (!document && !slideOnly) { targets = [resolve(c.elementId)]; si = targets[0].slideIndex; }
  if (!document) need(integer(si, 0, model.Slides.length - 1), "slide_target_invalid");
  const slide = document ? null : p.GetSlideByIndex(si), source = targets[0]?.shape, d = source && wrap(source);
  const prepared = {...c, nativeSlideIndex: si, nativeId: source?.Id ?? slide?.Slide.Id ?? null,
    nativeIds: targets.map(t => t.shape.Id), nativeSlideIds: model.Slides.map(s => s.Id)};
  if (phase === "apply") {
    need(editor.isGroupActions(), "transaction_required");
    need(c.nativeSlideIds?.length === model.Slides.length && c.nativeSlideIds.every((id, i) => id === model.Slides[i].Id), "live_binding_changed");
    need(c.nativeIds?.length === targets.length && c.nativeIds.every((id, i) => id === targets[i].shape.Id), "live_binding_changed");
  }
  const topology = ["insert_slide", "group", "ungroup", "duplicate_element", "merge_table_cells", "split_table_cell", "add_smartart_node", "delete_smartart_node", "set_slide_layout", "set_slide_size", "set_master_theme"].includes(c.op);
  if (topology) need(batchSize === 1, "topology_requires_separate_request");
  if (creation) {
    need([c.x, c.y, c.width, c.height].every(n => finite(n)) && c.width > 0 && c.height > 0, "geometry_invalid");
    if (c.name != null) need(typeof c.name === "string" && c.name.length > 0 && c.name.length <= 255 && !model.Slides.some(s => s.cSld.spTree.some(x => x.getOwnName?.() === c.name)), "name_not_unique");
  }
  let paragraph = null, paraIndex = null;
  if (["set_paragraph_format", "set_paragraph_list", "replace_text_range"].includes(c.op)) {
    need(typeof c.paragraphId === "string" && c.paragraphId.startsWith(c.elementId + ":p"), "paragraph_target_invalid");
    paraIndex = Number(c.paragraphId.slice((c.elementId + ":p").length));
    const native = source.getDocContent?.();
    need(native && integer(paraIndex, 0, native.Content.length - 1), "paragraph_target_missing");
    paragraph = new window.AscBuilder.ApiParagraph(native.Content[paraIndex]);
    prepared.nativeParagraphId = native.Content[paraIndex].Id;
    if (phase === "apply") need(c.nativeParagraphId === prepared.nativeParagraphId, "live_binding_changed");
  }
  let comment = null, effect = null;
  if(c.op==="add_comment"){
    // Pinned writer truncates millimetres * 22.66; loader divides by 22.66.
    // Choose the nearest serializable coordinate before the native history point.
    prepared.nativeCommentPosition={x:Math.round((c.x??0)*22.66/100)/22.66,y:Math.round((c.y??0)*22.66/100)/22.66};
    if(phase==="apply")need(JSON.stringify(c.nativeCommentPosition)===JSON.stringify(prepared.nativeCommentPosition),"live_binding_changed");
  }
  if (["edit_comment", "delete_comment"].includes(c.op)) {
    comment = slide.Slide.slideComments?.comments?.[c.commentIndex];
    need(comment && integer(c.commentIndex, 0, 9999), "comment_target_missing");
    prepared.nativeCommentId = comment.Id;
    if (phase === "apply") need(c.nativeCommentId === comment.Id, "live_binding_changed");
  }
  if (["set_animation_timing", "remove_animation_effect", "replace_animation_effect", "move_animation_effect"].includes(c.op)) {
    need(slide.Slide.timing, "animation_target_missing");
    const match = typeof c.animationId === "string" && /^\d+:a\d+$/.test(c.animationId) && c.animationId.split(":a").map(Number);
    need(match && match[0] === si, "animation_target_invalid");
    effect = slide.GetTimeLine().GetAllEffects()[match[1]];
    need(effect && effect.GetShape()?.Drawing === source, "animation_target_missing");
    prepared.nativeAnimationId = effect.Effect?.Id ?? effect.Effect?.cTn?.Id;
    prepared.nativeEffectIndex = match[1];
    if (phase === "apply") need(c.nativeAnimationId === prepared.nativeAnimationId, "live_binding_changed");
  }
  if (["add_animation_effect", "replace_animation_effect"].includes(c.op)) {
    // Read the actual pinned sequence catalogue using an unattached wrapper.
    // Calling GetMainSequence on a real slide would create timing in preflight.
    const probe = new slide.constructor({timing:{checkMainSequence:()=>null}});
    const Sequence = probe.GetTimeLine().GetMainSequence().constructor;
    const raw = c.presetId?.replace(/^ooo-/, "");
    const alias = raw?.replace(/-([a-z])/g, (_,ch)=>ch.toUpperCase());
    const type = Sequence.EFFECT_TYPE_MAP?.[raw] ? raw : alias;
    const mapping = Sequence.EFFECT_TYPE_MAP?.[type];
    need(mapping, "animation_preset_unsupported");
    const preset=f.ExecuteNoHistory(()=>new f.CTiming().createEffect(source?.GetId?.()??"",mapping.presetClass,mapping.presetID,mapping.presetSubtype??0,null),null,[]);
    need(Number.isSafeInteger(preset?.cTn?.presetSubtype),"animation_preset_subtype_unavailable");
    prepared.nativePreset = {type, name:Sequence._getEffectTypeName(mapping.presetClass,mapping.presetID),
      presetClass:mapping.presetClass,presetId:mapping.presetID,presetSubtype:preset.cTn.presetSubtype};
    if(phase === "apply")need(JSON.stringify(c.nativePreset)===JSON.stringify(prepared.nativePreset),"live_binding_changed");
  }
  // DrawingML chooses an effect list or an effect graph. Adding a list beside
  // an authored graph would silently discard that graph during export.
  if (["set_shape_shadow","set_shape_effects"].includes(c.op))
    need(!source.spPr?.effectProps?.EffectDag,"authored_effect_graph_edit_unavailable");
  if (c.op==="text_shadow" || c.op==="set_table_cell_format"&&c.tableCellFormat?.textShadow!=null) {
    const visit=node=>{need(!node?.Pr?.spellbookEffects?.EffectDag&&!node?.Value?.spellbookEffects?.EffectDag,"authored_text_effect_graph_edit_unavailable");node?.Content?.forEach(visit);};
    if(source?.isTable?.())source.graphicObject.Content.forEach(row=>row.Content.forEach(cell=>cell.Content.Content.forEach(visit)));
    else source.getDocContent?.()?.Content.forEach(visit);
  }
  const textOps = ["text_shadow", "text_autofit", "set_text_box", "set_text_case", "set_fontwork", "set_paragraph_format", "set_paragraph_list", "replace_text_range"];
  if (textOps.includes(c.op)) need(source.getDocContent?.(), "text_unavailable");
  const content = () => d.GetDocContent();
  const replace = (doc, text) => {
    const first=doc.GetElement(0),paraProperties=first?.Paragraph?.GetDirectParaPr?.()?.Copy();
    let old=first?.GetTextPr?.(),found=false;
    const readStyle=container=>{
      for(let i=0;!found&&i<(container?.GetElementsCount?.()??0);i++){
        const element=container.GetElement(i);
        if(element?.Run&&element.GetText?.({Numbering:false})&&typeof element.GetTextPr==="function"){old=element.GetTextPr();found=true;}
        else readStyle(element);
      }
    };
    readStyle(first);
    doc.RemoveAllElements();
    text.replace(/\r\n/g, "\n").split("\n").forEach((value, i) => {
      const para = i ? api.CreateParagraph() : doc.GetElement(0);
      if(paraProperties)para.Paragraph.SetPr(paraProperties.Copy());
      if (old) para.SetTextPr(old);
      if (value) para.AddText(value);
      if (i) doc.Push(para);
    });
  };
  // Presentation runs have native content history. Word range operations use
  // document selection APIs that the presentation model does not implement.
  const textRuns = para => {
    const result=[];
    const visit=node=>{
      if(node?.Run && typeof node.GetText === "function"){
        const text=node.GetText({Numbering:false});
        if(text && text!=="\r" && text!=="\n" && text!=="\r\n")result.push({run:node.Run,text});
      }else for(let i=0;i<(node?.GetElementsCount?.()??0);i++)visit(node.GetElement(i));
    };visit(para);return result;
  };
  const writeRun = (run,text) => {
    need(!run.FieldType && !run.Content.some(item=>item.IsParaEnd?.()),"text_run_boundary_unavailable");
    run.ClearContent();if(text)run.AddText(text,0);
  };
  const body = () => {
    need(source.txBody && source.txBody.bodyPr, "text_body_unavailable");
    return source.txBody.bodyPr.createDuplicate();
  };
  const effects = () => source.spPr.effectProps?.createDuplicate() ?? new f.CEffectProperties();
  const effectList = (props) => props.EffectLst ?? (props.EffectLst = new f.CEffectLst());
  const makeShadow = (original) => {
    const shadow = original?.createDuplicate() ?? new f.COuterShdw();
    if (c.color != null || !original) shadow.color = rgb(c.color ?? 0).Unicolor;
    const angle = (original?.dir ?? 0) / 60000 * Math.PI / 180;
    const x = c.shadowOffsetX != null ? c.shadowOffsetX * 360 : original ? (original.dist ?? 0) * Math.cos(angle) : 72000;
    const y = c.shadowOffsetY != null ? c.shadowOffsetY * 360 : original ? (original.dist ?? 0) * Math.sin(angle) : 72000;
    if (c.shadowOffsetX != null || c.shadowOffsetY != null || !original) {
      shadow.dist = Math.round(Math.hypot(x, y));
      shadow.dir = ((Math.round(Math.atan2(y, x) * 180 / Math.PI * 60000) % 21600000) + 21600000) % 21600000;
    }
    if (c.shadowBlur != null || !original) shadow.blurRad = Math.round((c.shadowBlur ?? 0) * 360);
    if (c.opacity != null) {
      shadow.color.Mods ??= new f.CColorModifiers();
      shadow.color.Mods.Mods = shadow.color.Mods.Mods.filter(mod => mod.name !== "alpha");
      const mod = new f.CColorMod(); mod.name = "alpha"; mod.val = c.opacity * 1000;
      shadow.color.Mods.Mods.push(mod);
    }
    return shadow;
  };
  const setName = (drawing) => { if (c.name != null) drawing.SetName(c.name); };
  const add = (drawing) => { drawing.SetPosition(c.x * 360, c.y * 360); setName(drawing); slide.AddObject(drawing); drawing.Drawing.recalculate?.(); return true; };
  const chart = () => { need(source?.isChart?.(), "chart_target_required"); return d; };
  const table = () => { need(source?.isTable?.(), "table_target_required"); return d; };
  const tableCell = (rowIndex,column,followMerge=true) => {
    const t=table().Table;need(integer(rowIndex,0,t.Content.length-1)&&integer(column,0,t.TableGrid.length-1),"table_cell_target_invalid");
    for(let r=rowIndex;r>=0;r--){
      const row=t.Content[r];let start=row.Get_Before().GridBefore;
      for(const cell of row.Content){const span=cell.GetGridSpan();if(column>=start&&column<start+span){
        if(followMerge&&cell.GetVMerge()===2)break;
        return new window.AscBuilder.ApiTableCell(cell);
      }start+=span;}
      if(!followMerge)break;
    }
    fail("table_cell_target_missing");
  };
  const mergeCells = () => {
    const t=table().Table;
    need(integer(c.startRow,0,t.Content.length-1)&&integer(c.endRow,c.startRow,t.Content.length-1)&&
      integer(c.startColumn,0,t.TableGrid.length-1)&&integer(c.endColumn,c.startColumn,t.TableGrid.length-1),"table_range_invalid");
    const cells=[];
    for(let r=c.startRow;r<=c.endRow;r++){
      const row=t.Content[r];let start=row.Get_Before().GridBefore,covered=0;
      for(const cell of row.Content){
        const span=cell.GetGridSpan(),end=start+span-1;
        if(end>=c.startColumn&&start<=c.endColumn){
          need(start>=c.startColumn&&end<=c.endColumn,"table_range_cuts_merged_cell");
          const owner=tableCell(r,start).Cell;
          need(owner.Row.Index>=c.startRow,"table_range_cuts_vertical_merge");
          const mergeCount=t.Internal_GetVertMergeCount(owner.Row.Index,start,span);
          need(owner.Row.Index+mergeCount-1<=c.endRow,"table_range_cuts_vertical_merge");
          cells.push(new window.AscBuilder.ApiTableCell(cell));covered+=span;
        }
        start+=span;
      }
      need(covered===c.endColumn-c.startColumn+1,"table_range_missing");
    }
    need(cells.length>1,"table_merge_requires_multiple_cells");
    return cells;
  };
  const pointTarget = () => {
    need(typeof source.getDataModelFromData === "function" && c.smartartNode, "diagram_target_required");
    const dm=source.getDataModelFromData(),nodes=[],visited=new Set(),parents=dm.ptLst.list.filter(point=>point.type===2).map(point=>point.modelId);
    need(parents.length===1,"diagram_root_ambiguous");
    for(let i=0;i<parents.length;i++){
      const edges=dm.cxnLst.list.filter(edge=>edge.type===0&&edge.srcId===parents[i]).sort((a,b)=>(a.srcOrd??0)-(b.srcOrd??0));
      for(const edge of edges){
        const point=dm.ptLst.list.find(point=>point.modelId===edge.destId);
        need(point&&!visited.has(point.modelId)&&visited.size<1000,"diagram_tree_invalid");visited.add(point.modelId);
        if([0,1].includes(point.type))nodes.push(point);parents.push(point.modelId);
      }
    }
    const q = c.smartartNode;
    need(integer(q.occurrence, 0, 999), "diagram_occurrence_invalid");
    if(c.op==="add_smartart_node"){
      need(q.expectedText==null&&typeof q.text==="string","diagram_node_invalid");
      const root=dm.ptLst.list.find(point=>point.type===2);
      const top=dm.cxnLst.list.filter(edge=>edge.type===0&&edge.srcId===root.modelId).sort((a,b)=>(a.srcOrd??0)-(b.srcOrd??0));
      return dm.ptLst.list.find(point=>point.modelId===top.at(-1)?.destId&&point.type===0);
    }
    need(typeof q.expectedText === "string", "diagram_node_invalid");
    return nodes.filter(point => (point.t?.content?.GetText?.({Numbering:false}) ?? "").replace(/\r?\n$/, "") === q.expectedText)[q.occurrence];
  };
  const binding = (method, owner = d) => fn(owner, method);
  switch (c.op) {
    case "insert_slide": fn(api, "CreateSlide"); need(model.Slides.length < 200 && model.notesMasters?.[0] && model.slideMasters?.[0]?.sldLayoutLst?.[0], "slide_creation_unavailable"); if (c.masterIndex != null || c.layout != null) need(integer(c.masterIndex, 0, model.slideMasters.length - 1) && integer(c.layout, 0, model.slideMasters[c.masterIndex].sldLayoutLst.length - 1), "layout_target_invalid"); break;
    case "set_slide_size": need(finite(c.width, 1) && finite(c.height, 1) && typeof c.scaleContent === "boolean", "slide_size_invalid"); fn(p, "SetSizes"); break;
    case "set_master_theme": need(integer(c.masterIndex, 0, model.slideMasters.length - 1) && c.theme && Array.isArray(c.theme.colors) && c.theme.colors.length === 12 && c.theme.colors.every(n => integer(n, 0, 0xffffff)), "theme_target_invalid"); fn(model.slideMasters[c.masterIndex].Theme, "createDuplicate"); fn(api, "CreateThemeColorScheme"); fn(api, "CreateThemeFontScheme"); break;
    case "set_slide_layout": {
      need(integer(c.masterIndex,0,model.slideMasters.length-1),"layout_target_invalid");
      const master=model.slideMasters[c.masterIndex],current=slide.Slide.Layout;
      const layout=c.layout==null?master.getMatchingLayout(current.type,current.matchingName,current.cSld.name,true):master.sldLayoutLst[c.layout];
      need(layout&&(c.layout==null||integer(c.layout,0,master.sldLayoutLst.length-1)),"layout_target_invalid");
      prepared.nativeLayoutId=layout.Id;prepared.nativeLayoutIndex=master.sldLayoutLst.indexOf(layout);
      if(phase==="apply")need(c.nativeLayoutId===layout.Id&&c.nativeLayoutIndex===prepared.nativeLayoutIndex,"live_binding_changed");
      const objects=slide.Slide.cSld.spTree;
      const retained=objects.filter(shape=>!shape.isEmptyPlaceholder());
      prepared.nativeLayoutPlan={removed:objects.flatMap((shape,index)=>shape.isEmptyPlaceholder()?[index]:[]),existing:[],added:[]};
      for(const shape of retained){
        if(!shape.isPlaceholder?.())continue;
        const type=shape.getPlaceholderType(),index=shape.getPlaceholderIndex(),single=shape.getIsSingleBody?.()??false;
        const matching=layout.getMatchingShape(type,index,single,{});
        if(!matching)continue;
        const parent=master.getMatchingShape(type,index,true);
        const candidates=[matching,parent].filter(item=>item?.spPr?.xfrm?.isNotNull());
        const isFrame=shape.isTable?.()||shape.isChart?.()||shape.getDataModelFromData;
        const template=isFrame?candidates.at(-1):candidates[0];
        if(!template)continue;
        const drawing=wrap(template);
        prepared.nativeLayoutPlan.existing.push({index:objects.indexOf(shape),geometry:{x:Math.round(drawing.GetPosX()/360),y:Math.round(drawing.GetPosY()/360),width:Math.round(drawing.GetWidth()/360),height:Math.round(drawing.GetHeight()/360)},
          rotation:Math.round(drawing.GetRotation()*1000)/1000,flipH:drawing.GetFlipH(),flipV:drawing.GetFlipV()});
      }
      layout.cSld.spTree.forEach((shape,index)=>{
        if(!shape.isPlaceholder())return;
        const type=shape.getPlaceholderType(),field=type===f.phType_dt?"dt":type===f.phType_ftr?"ftr":type===f.phType_hdr?"hdr":type===f.phType_sldNum?"sldNum":null;
        if(field&&(!master.hf||master.hf[field]===false))return;
        const matching=slide.Slide.getMatchingShape.call({cSld:{spTree:retained}},type,shape.getPlaceholderIndex(),shape.getIsSingleBody?.()??false);
        if(!matching){prepared.nativeLayoutPlan.added.push(index);retained.push(shape);}
      });
      if(phase==="apply")need(JSON.stringify(c.nativeLayoutPlan)===JSON.stringify(prepared.nativeLayoutPlan),"live_binding_changed");
      fn(slide,"ApplyLayout");break;
    }
    case "add_shape": case "add_text_box": fn(api, "CreateShape"); need(c.op === "add_text_box" ? typeof c.text === "string" : ["rectangle", "ellipse", "line"].includes(c.geometry), "shape_arguments_invalid"); break;
    case "add_connector": need(["standard", "curve", "straight"].includes(c.connectorKind), "connector_kind_invalid"); need(typeof f.CConnectionShape === "function", "connector_unavailable"); break;
    case "add_freeform": need(Array.isArray(c.points) && c.points.length >= 2 && c.points.length <= 1000 && c.points.every(point => point && finite(point.x, 0, c.width) && finite(point.y, 0, c.height)) && typeof c.closed === "boolean", "freeform_points_invalid"); break;
    case "add_table": need(Array.isArray(c.cells) && c.cells.length && c.cells.length <= 1000 && c.cells[0].length && c.cells[0].length <= 256 && c.cells.every(row => row.length === c.cells[0].length && row.every(value => typeof value === "string")), "table_cells_invalid"); fn(api, "CreateTable"); break;
    case "align": need(["left", "right", "center", "top", "bottom", "middle"].includes(c.alignment), "alignment_invalid"); break;
    case "distribute": need(targets.length >= 3 && ["horizontal", "vertical"].includes(c.axis), "distribution_invalid"); break;
    case "group": {
      need(targets.every(target=>!target.shape.group&&target.shape.canGroup?.()),"group_targets_unsupported");
      fn(slide,"GroupDrawings");fn(slide.Slide.graphicObjects,"getBoundsForGroup");
      const bounds=slide.Slide.graphicObjects.getBoundsForGroup(targets.map(target=>target.shape));
      const scale=targets[0].shape.getScaleCoefficient();
      prepared.nativeGroupBounds={x:bounds.l/scale*100,y:bounds.t/scale*100,width:(bounds.r-bounds.l)/scale*100,height:(bounds.b-bounds.t)/scale*100};
      if(phase==="apply")need(JSON.stringify(c.nativeGroupBounds)===JSON.stringify(prepared.nativeGroupBounds),"live_binding_changed");
      break;
    }
    case "ungroup": {
      need(!source.group&&source.spTree?.length&&source.canUnGroup?.()&&!source.getDataModelFromData,"ungroup_target_unsupported");
      binding("Ungroup");
      prepared.nativeUngroupGeometry=source.spTree.map(child=>{
        const x=child.transform.TransformPointX(child.extX/2,child.extY/2),y=child.transform.TransformPointY(child.extX/2,child.extY/2);
        return {x:Math.round((x-child.extX/2)*100),y:Math.round((y-child.extY/2)*100),width:Math.round(child.extX*100),height:Math.round(child.extY*100),
          rotation:Math.round(f.normalizeRotate(child.rot+source.rot)*180/Math.PI*1000)/1000,
          flipH:source.spPr.xfrm.flipH===true?child.spPr.xfrm.flipH!==true:child.spPr.xfrm.flipH===true,
          flipV:source.spPr.xfrm.flipV===true?child.spPr.xfrm.flipV!==true:child.spPr.xfrm.flipV===true};
      });
      if(phase==="apply")need(JSON.stringify(c.nativeUngroupGeometry)===JSON.stringify(prepared.nativeUngroupGeometry),"live_binding_changed");
      break;
    }
    case "duplicate_element": binding("Copy"); need(source.getOwnName?.() == null || c.name == null || c.name !== source.getOwnName(), "name_not_unique"); break;
    case "set_shape_fill": {
      const q=c.shapeFill;need(q&&["none","solid","gradient","hatch"].includes(q.type),"fill_invalid");
      if(q.type==="solid")need(integer(q.color,0,0xffffff),"fill_color_invalid");
      if(q.opacity!=null)need(finite(q.opacity,0,100),"fill_opacity_invalid");
      if(["gradient","hatch"].includes(q.type)){
        const fill=catalogFill();prepared.nativeFillId=fill.shape.Id;prepared.nativeFillSource=fill.id;
        if(phase==="apply")need(c.nativeFillId===fill.shape.Id&&c.nativeFillSource===fill.id,"live_binding_changed");
      }
      break;
    }
    case "text_shadow": need(typeof c.shadow === "boolean", "text_shadow_invalid"); break;
    case "set_shape_shadow": need(typeof c.shadow === "boolean", "shadow_invalid"); break;
    case "set_shape_effects": need(c.shapeEffects && source.spPr, "shape_effects_invalid"); break;
    case "text_autofit": need(typeof c.autofit === "boolean", "autofit_invalid"); need(source.txBody?.bodyPr, "text_body_unavailable"); break;
    case "set_text_box": {
      need(source.txBody?.bodyPr,"text_body_unavailable");
      const wrap=c.wordWrap??(source.getBodyPr().wrap!==f.nTWTNone);
      if(c.autoGrowWidth!=null)need(c.autoGrowWidth===!wrap,"independent_text_width_growth_unavailable");
      for(const key of ["marginLeft","marginRight","marginTop","marginBottom"])if(c[key]!=null)need(finite(c[key],0,100000),"text_margin_invalid");
      break;
    }
    case "set_text_case": need(["none", "uppercase", "lowercase", "title", "small_caps"].includes(c.textCase), "text_case_invalid"); break;
    case "set_fontwork": need(c.fontwork && typeof c.fontwork.preset === "string" && f.CreatePrstTxWarpGeometry(c.fontwork.preset)?.pathLst?.length>0, "fontwork_invalid"); need(source.txBody?.bodyPr, "text_body_unavailable"); break;
    case "set_paragraph_format": need(c.paragraphFormat, "paragraph_format_invalid"); break;
    case "set_paragraph_list": {
      const q=c.paragraphList;need(q&&["none","bullet","number"].includes(q.type)&&integer(q.level,0,8),"paragraph_list_invalid");
      if(q.type==="number")need(integer(q.startWith,1,32767)&&[["(",")"],["",")"],["","."],["",""]].some(([prefix,suffix])=>(q.prefix??"")===prefix&&(q.suffix??"")===suffix),"paragraph_number_format_unavailable");
      if(q.type==="bullet")need(typeof q.bulletCharacter==="string"&&q.bulletCharacter.length>0,"paragraph_bullet_invalid");
      break;
    }
    case "replace_text_range": { const text = paragraph.GetText({Numbering:false}).replace(/\r?\n$/, ""); need(integer(c.startOffset, 0, text.length) && integer(c.endOffset, c.startOffset, text.length) && text.slice(c.startOffset, c.endOffset) === c.expectedText && typeof c.text === "string" && !/[\r\n]/.test(c.text), "text_range_stale"); binding("GetRange", paragraph); break; }
    case "set_object_interaction": binding("SetHyperlink"); if (c.interaction === "external_url") { const url = new URL(c.url); need(["https:", "http:"].includes(url.protocol) && !url.username && !url.password, "hyperlink_invalid"); } if (c.interaction === "internal_slide") need(integer(c.targetSlideIndex, 0, model.Slides.length - 1), "hyperlink_target_invalid"); break;
    case "set_connector": need(source.getObjectType?.() === window.AscDFH.historyitem_type_Cnx && c.connector, "connector_target_required"); for (const key of ["startElementId", "endElementId"]) if (c.connector[key]) need(resolve(c.connector[key]).slideIndex === si, "connector_target_must_share_slide"); break;
    case "set_table_cell_format": { const cell=tableCell(c.row,c.column);need(c.tableCellFormat,"table_cell_target_invalid");if(c.tableCellFormat.characterSpacing!=null)need(Number.isFinite(c.nativeSpacingTwips),"character_spacing_preflight_required");prepared.nativeCellId=cell.Cell.Id;if(phase==="apply")need(c.nativeCellId===cell.Cell.Id,"live_binding_changed");break; }
    case "merge_table_cells": {
      const cells=mergeCells();prepared.nativeCellIds=cells.map(cell=>cell.Cell.Id);
      if(phase==="apply")need(JSON.stringify(c.nativeCellIds)===JSON.stringify(prepared.nativeCellIds),"live_binding_changed");
      binding("MergeCells",table());break;
    }
    case "split_table_cell": {
      const t=table().Table,cell=tableCell(c.row,c.column).Cell;
      need(integer(c.rows,1,20)&&integer(c.columns,1,20),"table_split_invalid");
      const start=cell.Row.GetCellInfo(cell.Index).StartGridCol,span=cell.GetGridSpan();
      const count=t.Internal_GetVertMergeCount(cell.Row.Index,start,span);
      need(count===1||(c.rows<=count&&count%c.rows===0),"table_split_vertical_divisor_invalid");
      const margins=cell.GetMargins(),width=t.TableGrid.slice(start,start+span).reduce((sum,value)=>sum+value,0);
      need(width/c.columns>=(cell.Row.Get_CellSpacing()??0)+margins.Left.W+margins.Right.W,"table_split_cell_too_narrow");
      prepared.nativeCellId=cell.Id;if(phase==="apply")need(c.nativeCellId===cell.Id,"live_binding_changed");
      fn(t,"SplitTableCells");break;
    }
    case "set_chart_data": {
      const t=chart(),series=t.Chart.getAllSeries();
      need(series.length&&[c.data,c.rowDescriptions,c.columnDescriptions].some(value=>value!=null),"chart_data_invalid");
      const rows=(series[0].val??series[0].yVal)?.numRef?.numCache?.getPtCount();
      need(integer(rows,1,100),"chart_values_dimensions_changed");prepared.nativeChartRowCount=rows;
      if(c.data!=null)need(Array.isArray(c.data)&&c.data.length===rows&&c.data.every(row=>Array.isArray(row)&&row.length===series.length&&row.every(value=>value===null||Number.isFinite(value))),"chart_data_invalid");
      need(c.nativeWorkbook instanceof Uint8Array,"chart_workbook_authority_required");
      for(const item of series){
        const cache=(item.val??item.yVal)?.numRef?.numCache;
        need(cache?.getPtCount()===rows,"chart_values_dimensions_changed");
        need(new Set(cache.pts.map(point=>point.idx)).size===cache.pts.length&&cache.pts.every(point=>integer(point.idx,0,rows-1)),"chart_value_indices_invalid");
        for(const method of ["addNumericPoint","removeDPt","getPtByIndex","setPtCount"])fn(cache,method);
      }
      if(c.rowDescriptions!=null){need(Array.isArray(c.rowDescriptions)&&c.rowDescriptions.length===rows&&c.rowDescriptions.every(text=>typeof text==="string"),"chart_labels_invalid");for(const item of series)need(item.cat?.strRef?.strCache?.getPtCount()===rows&&item.cat.strRef.strCache.pts.length===rows,"chart_categories_dimensions_changed");}
      if(c.columnDescriptions!=null){need(Array.isArray(c.columnDescriptions)&&c.columnDescriptions.length===series.length&&c.columnDescriptions.every(text=>typeof text==="string"),"chart_labels_invalid");for(const item of series)need(item.tx?.strRef?.strCache?.pts?.length===1,"chart_name_binding_missing");}
      if(phase==="apply")need(c.nativeChartRowCount===rows,"live_binding_changed");fn(t.Chart,"onDataUpdate");fn(t.Chart,"setXLSX");break;
    }
    case "set_chart_type": {
      const t=chart(),plot=t.Chart.chart.plotArea;
      need(["column","line","area","pie","scatter","radar"].includes(c.chartType),"chart_type_invalid");
      prepared.nativeBuilderChartType={column:"bar",line:"lineNormal",area:"area",pie:"pie",scatter:"scatter",radar:"radar"}[c.chartType];
      prepared.nativeChartType=f.ChartBuilderTypeToInternal(prepared.nativeBuilderChartType);
      const method={column:"switchToBarChart",line:"switchToLineChart",area:"switchToAreaChart",pie:"switchToPieChart",scatter:"switchToScatterChart",radar:"switchToRadar"}[c.chartType];
      fn(plot,method);
      if(["pie","radar"].includes(c.chartType))need(t.Chart.getAllSeries().every(series=>!(series.errBars?.length||series.trendlines?.length)),"chart_type_authored_effects_unavailable");
      if(c.chartType==="scatter")need(t.Chart.getAllSeries().every(series=>(series.xVal??series.cat)?.numRef||(series.xVal??series.cat)?.numLit),"scatter_numeric_x_binding_required");
      prepared.nativeChartAxes=plot.axId.map(axis=>({kind:axis.getObjectType()===window.AscDFH.historyitem_type_CatAx?"category":axis.getObjectType()===window.AscDFH.historyitem_type_ValAx?"value":"other",deleted:axis.bDelete??null,axPos:axis.axPos??null}));
      if(phase==="apply")need(c.nativeChartType===prepared.nativeChartType&&c.nativeBuilderChartType===prepared.nativeBuilderChartType&&JSON.stringify(c.nativeChartAxes)===JSON.stringify(prepared.nativeChartAxes),"live_binding_changed");
      break;
    }
    case "set_chart_format": chart(); need(c.chartFormat, "chart_format_invalid"); break;
    case "set_slide_transition": need(typeof c.transitionEffect === "string" && finite(c.transitionDuration, 0, 60), "transition_invalid"); fn(api, "CreateSlideShowTransition"); break;
    case "set_slide_metadata": {
      const q=c.slideMetadata;need(q&&!(q.autoAdvance===false&&q.duration!=null),"slide_metadata_invalid");
      if(q.dateTimeFixed===true&&q.dateTimeText==null){
        const shape=slide.Slide.getMatchingShape(f.phType_dt,null,false,{})??slide.Slide.Layout.getMatchingShape(f.phType_dt,null,false,{})??slide.Slide.Layout.Master.getMatchingShape(f.phType_dt,null,false,{});
        need(shape,"metadata_date_freeze_unavailable");prepared.nativeDateTimeFreeze=shape.getDocContent?.()?.GetText({Numbering:false});
      }
      if(q.dateTimeFormat!=null)need(typeof c.nativeDateFieldType==="string"&&/^datetime(?:[1-9]|1[0-3])$/.test(c.nativeDateFieldType),"metadata_date_format_unavailable");
      for(const [visible,text,type] of [["footerVisible","footerText",f.phType_ftr],["dateTimeVisible","dateTimeText",f.phType_dt],["pageNumberVisible",null,f.phType_sldNum]]){
        if(q[visible]===true||text&&q[text]!=null||type===f.phType_dt&&(q.dateTimeFixed!=null||q.dateTimeFormat!=null))
          need(slide.Slide.getMatchingShape(type,null,false,{})??slide.Slide.Layout.getMatchingShape(type,null,false,{})??slide.Slide.Layout.Master.getMatchingShape(type,null,false,{}),"metadata_placeholder_missing");
      }
      break;
    }
    case "set_animation_timing": need(finite(c.duration, .001, 60) && finite(c.delay, 0, 60) && ["on-click","with-previous","after-previous"].includes(c.start), "animation_timing_invalid"); binding("SetDuration", effect); break;
    case "add_animation_effect": case "replace_animation_effect": need(typeof c.presetId === "string", "animation_preset_invalid"); break;
    case "remove_animation_effect": binding("Delete", effect); break;
    case "move_animation_effect": need(integer(c.animationIndex, 0, slide.GetTimeLine().GetAllEffects().length - 1), "animation_position_invalid"); binding("MoveTo", effect); break;
    case "insert_image": case "replace_image": case "insert_media": case "replace_media": {
      need(typeof c.assetId === "string" && c.nativeAsset && c.nativeAsset.assetId === c.assetId && typeof c.nativeAsset.url === "string", "asset_authority_required");
      const state=window[Symbol.for("spellbook.onlyoffice.documentAssets/v1")]; need(state?.model===model,"asset_document_changed"); const receipt=state.receipts.get(c.assetId);
      need(receipt && receipt.sha256===c.nativeAsset.sha256 && receipt.url===c.nativeAsset.url && receipt.fileName===c.nativeAsset.fileName, "asset_authority_required");
      need(c.op.endsWith("image") ? receipt.kind === "image" : ["audio","video"].includes(receipt.kind), "asset_kind_invalid");
      if(c.op.startsWith("replace"))need(source.isImage?.(),"image_target_required");
      if(c.op==="replace_image")need(!source.nvPicPr?.nvPr?.unimedia?.media,"image_target_required");
      if(c.op==="replace_media")need(typeof source.nvPicPr?.nvPr?.unimedia?.media==="string"&&source.nvPicPr.nvPr.unimedia.media.length,"media_target_required");
      break;
    }
    case "set_smartart_node": case "add_smartart_node": case "delete_smartart_node": {
      const point=pointTarget(),dm=source.getDataModelFromData();need(point,"diagram_node_missing");prepared.nativePointId=point.modelId;
      if(phase==="apply")need(c.nativePointId===point.modelId,"live_binding_changed");
      if(c.op!=="set_smartart_node"){
        need(source.isCanGenerateSmartArt?.(),"diagram_layout_unsupported");
        if(c.op==="delete_smartart_node")need(!dm.cxnLst.list.some(edge=>edge.type===0&&edge.srcId===point.modelId),"diagram_delete_requires_leaf");
        const edges=dm.cxnLst.list.filter(edge=>edge.type===0&&edge.destId===point.modelId);need(edges.length===1,"diagram_parent_ambiguous");
        const edge=edges[0];prepared.nativeDiagramParent=edge.srcId;prepared.nativeDiagramOrder=Math.max(...dm.cxnLst.list.filter(item=>item.type===0&&item.srcId===edge.srcId).map(item=>item.srcOrd??0))+1;
        if(c.op==="add_smartart_node"){
          need(point.t?.content,"diagram_template_text_missing");
          for(const field of ["parTransId","sibTransId"])need(dm.ptLst.list.some(item=>item.modelId===edge[field]),"diagram_transition_missing");
        }
        if(phase==="apply")need(c.nativeDiagramParent===prepared.nativeDiagramParent&&c.nativeDiagramOrder===prepared.nativeDiagramOrder,"live_binding_changed");
      }
      break;
    }
    case "add_comment": need(typeof c.text === "string" && c.text.length <= 10000 && typeof c.author === "string" && (c.initials == null || typeof c.initials === "string" && c.initials.length <= 100), "comment_invalid"); break;
    case "edit_comment": need(typeof c.text === "string" && c.text.length <= 10000, "comment_invalid"); break;
    case "delete_comment": break;
    default: fail("operation_unavailable:" + c.op);
  }
  if (phase === "preflight") {
    if(prepared.nativeWorkbookEncoded)delete prepared.nativeWorkbook;
    return prepared;
  }
  const mutateDiagramTopology=()=>{
    const target=pointTarget(),data=source.dataModel.createDuplicate(),dm=data.getDataModel();
    const point=dm.ptLst.list.find(item=>item.modelId===target.modelId);
    const nodeKey=shape=>{
      const ids=shape.getSmartArtPointContent?.()?.map(item=>item.point?.modelId).filter(Boolean).sort();
      return ids?.length?JSON.stringify([ids,shape.getSmartArtInfo?.()?.shapePoint?.prSet?.presName??null]):null;
    };
    const oldLeaves=new Map();
    const visit=(shape,callback)=>{callback(shape);shape.spTree?.forEach(child=>visit(child,callback));};
    visit(source,shape=>{const key=nodeKey(shape);if(key){need(!oldLeaves.has(key),"diagram_shape_binding_ambiguous");oldLeaves.set(key,shape);}});
    if(c.op==="add_smartart_node"){
      const edge=dm.cxnLst.list.find(edge=>edge.type===0&&edge.destId===point.modelId),node=point.createDuplicate(),connection=edge.createDuplicate();
      node.setModelId(window.AscCommon.CreateGUID());
      replace(new window.AscBuilder.ApiDocumentContent(node.t.content),c.smartartNode.text);
      connection.setModelId(window.AscCommon.CreateGUID());connection.setDestId(node.modelId);connection.setSrcOrd(c.nativeDiagramOrder);
      for(const [field,setter] of [["parTransId","setParTransId"],["sibTransId","setSibTransId"]]){
        const transition=dm.ptLst.list.find(item=>item.modelId===edge[field]).createDuplicate();transition.setModelId(window.AscCommon.CreateGUID());transition.setCxnId(connection.modelId);
        dm.ptLst.addToLst(dm.ptLst.list.length,transition);connection[setter](transition.modelId);
      }
      dm.ptLst.addToLst(dm.ptLst.list.length,node);dm.cxnLst.addToLst(dm.cxnLst.list.length,connection);
    }else{
      const removed=new Set([point.modelId]);
      for(const edge of dm.cxnLst.list)if(edge.type===0&&edge.destId===point.modelId){if(edge.parTransId)removed.add(edge.parTransId);if(edge.sibTransId)removed.add(edge.sibTransId);}
      for(const edge of dm.cxnLst.list)if(edge.type===1&&removed.has(edge.srcId))removed.add(edge.destId);
      for(let i=dm.cxnLst.list.length-1;i>=0;i--)if(removed.has(dm.cxnLst.list[i].srcId)||removed.has(dm.cxnLst.list[i].destId))dm.cxnLst.removeFromLst(i);
      for(let i=dm.ptLst.list.length-1;i>=0;i--)if(removed.has(dm.ptLst.list[i].modelId))dm.ptLst.removeFromLst(i);
    }
    // The native layout also updates untracked font-fit caches. Generate into
    // an owned drawing and record its replacement in native history so a
    // rejected edit and Undo restore the original drawing exactly.
    const drawing=f.ExecuteNoHistory(()=>source.getDrawing().copy(),null,[]);
    source.removeFromSpTreeByPos(0);source.addToSpTree(0,drawing);source.setDrawing(drawing);
    source.setDataModel(data);source.smartArtTree=null;source.checkDataModel();source.generateDrawingPart();
    const rebound=new Map(),remaining=new Set(oldLeaves.keys());
    visit(source,shape=>{
      const key=nodeKey(shape),prior=oldLeaves.get(key);if(!prior)return;
      need(remaining.delete(key),"diagram_shape_binding_ambiguous");rebound.set(prior.Id,shape.Id);
      if(prior.nvSpPr)shape.setNvSpPr(prior.nvSpPr.createDuplicate());
      if(prior.spPr&&shape.spPr){
        shape.spPr.setFill(prior.spPr.Fill?.createDuplicate()??null);shape.spPr.setLn(prior.spPr.ln?.createDuplicate()??null);
        shape.spPr.setEffectPr(prior.spPr.effectProps?.createDuplicate()??null);
        shape.spPr.xfrm.setFlipH(prior.spPr.xfrm?.flipH??null);shape.spPr.xfrm.setFlipV(prior.spPr.xfrm?.flipV??null);
      }
      if(typeof shape.setStyle==="function")shape.setStyle(prior.style?.createDuplicate()??null);
      if(typeof shape.setLocks==="function"&&typeof prior.locks==="number")shape.setLocks(prior.locks);
      if(shape.txBody&&prior.txBody?.bodyPr)shape.txBody.setBodyPr(prior.txBody.bodyPr.createDuplicate());
    });
    // Preserve references to retained semantic nodes while the native layout
    // regenerates leaf objects. Removing a node may remove its own targets;
    // no other node's connector or animation target can silently disappear.
    need([...remaining].every(key=>c.op==="delete_smartart_node"&&JSON.parse(key)[0].includes(target.modelId)),"diagram_retained_shape_missing");
    const rebind=shape=>{
      const pr=shape.nvSpPr?.nvUniSpPr;
      if(pr&&(rebound.has(pr.stCnxId)||rebound.has(pr.endCnxId))){
        const next=pr.copy();if(rebound.has(next.stCnxId))next.stCnxId=rebound.get(next.stCnxId);if(rebound.has(next.endCnxId))next.endCnxId=rebound.get(next.endCnxId);shape.nvSpPr.setUniSpPr(next);
      }
      shape.spTree?.forEach(rebind);
    };slide.Slide.cSld.spTree.forEach(rebind);
    const seen=new Set(),timing=object=>{
      if(!object||seen.has(object))return;seen.add(object);
      if(rebound.has(object.spid)){fn(object,"setSpid");object.setSpid(rebound.get(object.spid));}
      object.getChildren?.()?.forEach(timing);
    };timing(slide.Slide.timing);
    source.recalcSmartArtConnections();return true;
  };
  editor.executeGroupActionsStart();
  try {
    p.CreateNewHistoryPoint();
    if (slide) editor.WordControl.GoToPage(si);
    switch (c.op) {
      case "insert_slide": {
        const s = api.CreateSlide();
        const layout = c.masterIndex != null ? p.GetAllSlideMasters()[c.masterIndex].GetAllLayouts()[c.layout] : slide.GetLayout();
        need(s.ApplyLayout(layout), "layout_rejected");
        p.AddSlide(s, si + 1);
        for (const section of model.Sections ?? []) if (section.startIndex > si) section.setStartIndex(section.startIndex + 1);
        s.Slide.recalculate(); return true;
      }
      case "set_slide_size": {
        if (c.scaleContent) return p.SetSizes(c.width * 360, c.height * 360);
        // A non-scaling resize records dimensions only. The SDK's normal
        // SlideSize history map scales objects during Redo, so use the dedicated
        // dimensions map and native slide/master/layout size histories together.
        const type = window.AscDFH.historyitem_Spellbook_DimensionsOnly;
        need(Number.isSafeInteger(type), "dimension_history_unavailable");
        const size = model.sldSz.createDuplicate();
        size.setCX(Math.round(c.width * 360)); size.setCY(Math.round(c.height * 360));
        const change = new window.AscDFH.CChangesDrawingsObject(model, type, model.sldSz, size);
        h.Add(change); change.Redo();
        for (const master of model.slideMasters) {
          master.setSlideSize(c.width / 100, c.height / 100);
          master.sldLayoutLst.forEach(layout => layout.setSlideSize(c.width / 100, c.height / 100));
        }
        model.Slides.forEach(item => item.setSlideSize(c.width / 100, c.height / 100));
        return true;
      }
      case "set_master_theme": {
        const master = model.slideMasters[c.masterIndex], t = c.theme;
        const copy = master.Theme.createDuplicate();
        copy.setName(t.name);
        copy.setColorScheme(api.CreateThemeColorScheme(t.colors.map(rgb), t.colorSchemeName).ColorScheme);
        copy.setFontScheme(api.CreateThemeFontScheme(t.majorLatin, t.majorAsian, t.majorComplex,
          t.minorLatin, t.minorAsian, t.minorComplex, t.fontSchemeName).FontScheme);
        master.setTheme(copy);
        return true;
      }
      case "set_slide_layout": return slide.ApplyLayout(p.GetAllSlideMasters()[c.masterIndex].GetAllLayouts()[c.nativeLayoutIndex]);
      case "add_shape": case "add_text_box": {
        const line = c.op === "add_shape" && c.geometry === "line";
        const shape = api.CreateShape(c.op === "add_text_box" ? "rect" : {rectangle:"rect", ellipse:"ellipse",line:"line"}[c.geometry], c.width * 360, c.height * 360,
          line || c.color == null || c.op === "add_text_box" ? api.CreateNoFill() : solid(c.color),
          line ? api.CreateStroke(12700, solid(c.color ?? 0)) : api.CreateStroke(0, api.CreateNoFill()));
        if (c.op === "add_text_box") replace(shape.GetContent(), c.text);
        return add(shape);
      }
      case "add_connector": { const base = api.CreateShape({straight:"line",standard:"bentConnector3",curve:"curvedConnector3"}[c.connectorKind], c.width * 360, c.height * 360, api.CreateNoFill(), api.CreateStroke(12700, solid(c.color ?? 0))); const shape = new f.CConnectionShape(); shape.setSpPr(base.Drawing.spPr.createDuplicate()); shape.spPr.setParent(shape); shape.setNvSpPr(new f.UniNvPr()); shape.setParent(slide.Slide); shape.setBDeleted(false); return add(new window.AscBuilder.ApiShape(shape)); }
      case "add_freeform": { const shape = api.CreateShape("rect", c.width * 360, c.height * 360, c.closed ? solid(c.color ?? 0) : api.CreateNoFill(), api.CreateStroke(12700, solid(c.color ?? 0))); const geometry = new f.Geometry(); geometry.AddPathCommand(0, undefined, c.closed ? "norm" : "none", true, c.width * 360, c.height * 360); c.points.forEach((point, i) => geometry.AddPathCommand(i ? 2 : 1, String(point.x * 360), String(point.y * 360))); if (c.closed) geometry.AddPathCommand(6); shape.Drawing.spPr.setGeometry(geometry); return add(shape); }
      case "add_table": { const t = api.CreateTable(c.cells[0].length, c.cells.length); t.SetSize(c.width * 360, c.height * 360); c.cells.forEach((row, r) => row.forEach((text, col) => replace(t.GetRow(r).GetCell(col).GetContent(), text))); return add(t); }
      case "align": { const xs = targets.map(t => t.shape); const minX = Math.min(...xs.map(x => x.x)), maxX = Math.max(...xs.map(x => x.x + x.extX)), minY = Math.min(...xs.map(x => x.y)), maxY = Math.max(...xs.map(x => x.y + x.extY)); for (const x of xs) { let px = x.x, py = x.y; if (c.alignment === "left") px = minX; if (c.alignment === "right") px = maxX - x.extX; if (c.alignment === "center") px = (minX + maxX - x.extX) / 2; if (c.alignment === "top") py = minY; if (c.alignment === "bottom") py = maxY - x.extY; if (c.alignment === "middle") py = (minY + maxY - x.extY) / 2; wrap(x).SetPosition(Math.round(px * 36000), Math.round(py * 36000)); } return true; }
      case "distribute": { const horizontal = c.axis === "horizontal", pos = horizontal ? "x" : "y", extent = horizontal ? "extX" : "extY"; const xs = targets.map(t => t.shape).sort((a,b) => a[pos] - b[pos]); const gap = (xs.at(-1)[pos] + xs.at(-1)[extent] - xs[0][pos] - xs.reduce((sum,x) => sum + x[extent],0)) / (xs.length - 1); let cursor = xs[0][pos]; xs.forEach(x => { wrap(x).SetPosition(Math.round((horizontal ? cursor : x.x) * 36000), Math.round((horizontal ? x.y : cursor) * 36000)); cursor += x[extent] + gap; }); return true; }
      case "group": need(slide.GroupDrawings(targets.map(t => wrap(t.shape))),"group_rejected");return true;
      case "ungroup": need(d.Ungroup(),"ungroup_rejected");return true;
      case "duplicate_element": { const copy = d.Copy(); if (c.name != null) copy.SetName(c.name); if (c.x != null || c.y != null) copy.SetPosition((c.x ?? source.x * 100) * 360, (c.y ?? source.y * 100) * 360); slide.AddObject(copy); copy.Drawing.recalculate?.(); return true; }
      case "set_shape_fill": { const q = c.shapeFill; let fill; if (q.type === "none") fill = api.CreateNoFill().UniFill; else if (q.type === "solid") fill = solid(q.color).UniFill; else { const target = catalogFill().shape; need(target.Id === c.nativeFillId, "live_binding_changed"); fill = target.spPr.Fill.createDuplicate(); } if (q.opacity != null) fill.transparent = q.opacity * 255 / 100; source.spPr.setFill(fill); return true; }
      case "set_shape_shadow": { const props = effects(), list = effectList(props); list.outerShdw = c.shadow ? makeShadow(list.outerShdw) : null; source.spPr.setEffectPr(props); return true; }
      case "set_shape_effects": { const q = c.shapeEffects, props = effects(), list = effectList(props); if (q.glowRadius != null || q.glowColor != null || q.glowOpacity != null) { const glow = list.glow?.createDuplicate() ?? new f.CGlow(); if (q.glowRadius != null) glow.rad = Math.round(q.glowRadius * 360); if (q.glowColor != null) glow.color = rgb(q.glowColor).Unicolor; if (q.glowOpacity != null) { glow.color.Mods ??= new f.CColorModifiers(); glow.color.Mods.Mods = glow.color.Mods.Mods.filter(m => m.name !== "alpha"); const m = new f.CColorMod(); m.name = "alpha"; m.val = q.glowOpacity * 1000; glow.color.Mods.Mods.push(m); } list.glow = glow; } if (q.softEdgeRadius != null) { list.softEdge = new f.CSoftEdge(); list.softEdge.rad = Math.round(q.softEdgeRadius * 360); } source.spPr.setEffectPr(props); return true; }
      case "text_shadow": {
        const type = window.AscDFH.historyitem_Spellbook_RunEffects;
        need(Number.isSafeInteger(type), "text_shadow_history_unavailable");
        const visit = node => {
          if (node instanceof window.AscWord.Run) {
            const props = node.Pr.spellbookEffects?.createDuplicate() ?? new f.CEffectProperties();
            effectList(props).outerShdw = c.shadow ? makeShadow(effectList(props).outerShdw) : null;
            const change = new window.AscDFH.CChangesDrawingsObjectNoId(node, type, node.Pr.spellbookEffects, props);
            h.Add(change); change.Redo();
          } else node.Content?.forEach(visit);
        };
        source.getDocContent().Content.forEach(visit);
        return true;
      }
      case "text_autofit": case "set_text_box": { const pr = body(); if (c.op === "text_autofit") { pr.textFit = new f.CTextFit(); pr.textFit.type = c.autofit ? f.text_fit_NormAuto : f.text_fit_No; } else { for (const [key, field] of [["marginLeft","lIns"],["marginRight","rIns"],["marginTop","tIns"],["marginBottom","bIns"]]) if (c[key] != null) pr[field] = c[key] / 100; if (c.wordWrap != null) pr.wrap = c.wordWrap ? f.nTWTNone + 1 : f.nTWTNone; if (c.autoGrowHeight != null) { pr.textFit = new f.CTextFit(); pr.textFit.type = c.autoGrowHeight ? f.text_fit_Auto : f.text_fit_No; } if(c.autoGrowWidth!=null)pr.wrap=c.autoGrowWidth?f.nTWTNone:f.nTWTNone+1; } source.txBody.setBodyPr(pr); return true; }
      case "set_fontwork": { const pr = body(); pr.prstTxWarp = f.CreatePrstTxWarpGeometry(c.fontwork.preset); source.txBody.setBodyPr(pr); return true; }
      case "set_text_case": {
        for(const para of content().GetAllParagraphs()){
          para.SetCaps(c.textCase === "uppercase");para.SetSmallCaps(c.textCase === "small_caps");
          if(!["lowercase","title"].includes(c.textCase))continue;
          let inWord=false;
          for(const {run,text} of textRuns(para)){
            const lang=window.Asc.g_oLcidIdToNameMap?.[run.Pr?.Lang?.Val];let result="";
            for(const char of text){const word=/[\p{L}\p{M}\p{N}'’]/u.test(char);result+=c.textCase==="title"&&word&&!inWord?char.toLocaleUpperCase(lang):char.toLocaleLowerCase(lang);inWord=word;}
            if(result!==text)writeRun(run,result);
          }
        }return true;
      }
      case "set_paragraph_format": { const q = c.paragraphFormat, pr = paragraph.GetParaPr(); for (const [key, method] of [["leftMargin","SetIndLeft"],["rightMargin","SetIndRight"],["firstLineIndent","SetIndFirstLine"]]) if (q[key] != null) pr[method](q[key] * 1440 / 2540); if (q.topMargin != null) pr.SetSpacingBefore(q.topMargin * 1440 / 2540); if (q.bottomMargin != null) pr.SetSpacingAfter(q.bottomMargin * 1440 / 2540); if (q.direction != null) { const native = paragraph.Paragraph; if (q.direction === "top-to-bottom") { const b = body(); b.vert = f.nVertTTvert; source.txBody.setBodyPr(b); } else native.SetParagraphBidi(q.direction === "right-to-left"); } return true; }
      case "set_paragraph_list": { const q = c.paragraphList, bullet = new f.CBullet(); bullet.bulletType = new f.CBulletType(); if (q.type === "none") bullet.bulletType.type = f.BULLET_TYPE_BULLET_NONE; else if (q.type === "bullet") { bullet.bulletType.type = f.BULLET_TYPE_BULLET_CHAR; bullet.bulletType.Char = q.bulletCharacter; } else { bullet.bulletType.type = f.BULLET_TYPE_BULLET_AUTONUM; bullet.bulletType.AutoNumType = q.prefix === "(" ? f.numbering_presentationnumfrmt_ArabicParenBoth : q.suffix === ")" ? f.numbering_presentationnumfrmt_ArabicParenR : q.suffix === "." ? f.numbering_presentationnumfrmt_ArabicPeriod : f.numbering_presentationnumfrmt_ArabicPlain; bullet.bulletType.startAt = q.startWith; } paragraph.Paragraph.Set_Bullet(bullet); paragraph.Paragraph.Set_PresentationLevel(q.level); return true; }
      case "replace_text_range": {
        const runs=textRuns(paragraph);need(runs.length,"empty_range_style");
        let cursor=0,inserted=false;
        for(const {run,text} of runs){
          const end=cursor+text.length;let value=text;
          if(end>c.startOffset&&(cursor<c.endOffset||c.startOffset===c.endOffset&&cursor<=c.startOffset)){
            value=text.slice(0,Math.max(0,c.startOffset-cursor));
            if(!inserted){value+=c.text;inserted=true;}
            value+=text.slice(Math.max(0,c.endOffset-cursor));
          }else if(!inserted&&cursor>=c.endOffset){value=c.text+text;inserted=true;}
          if(value!==text)writeRun(run,value);cursor=end;
        }
        if(!inserted)writeRun(runs.at(-1).run,runs.at(-1).text+c.text);
        return true;
      }
      case "set_object_interaction": { if (c.interaction === "none") { source.getCNvProps().setHlinkClick(null); return true; } const link = c.interaction === "external_url" ? c.url : c.interaction === "internal_slide" ? "ppaction://hlinksldjumpslide" + c.targetSlideIndex : "ppaction://hlinkshowjump?jump=" + {next_slide:"nextslide",previous_slide:"previousslide",first_slide:"firstslide",last_slide:"lastslide",end_show:"endshow"}[c.interaction]; need(link, "interaction_invalid"); return d.SetHyperlink(api.CreateHyperlink(link, c.description ?? "")); }
      case "set_connector": { const q = c.connector; const geometry = f.CreateGeometry({straight:"line",standard:"bentConnector3",curve:"curvedConnector3"}[q.kind]); source.spPr.setGeometry(geometry); const x = Math.min(q.start.x,q.end.x), y = Math.min(q.start.y,q.end.y); d.SetPosition(x * 360,y * 360); d.SetSize(Math.abs(q.end.x-q.start.x)*360,Math.abs(q.end.y-q.start.y)*360); d.SetFlipH(q.end.x < q.start.x); d.SetFlipV(q.end.y < q.start.y); const pr = source.nvSpPr.nvUniSpPr.copy(); pr.stCnxId = q.startElementId ? resolve(q.startElementId).shape.Id : null; pr.endCnxId = q.endElementId ? resolve(q.endElementId).shape.Id : null; pr.stCnxIdx = q.startGluePoint; pr.endCnxIdx = q.endGluePoint; source.nvSpPr.setUniSpPr(pr); return true; }
      case "set_table_cell_format": { const cell = tableCell(c.row,c.column), q = c.tableCellFormat; if (q.fillColor != null || q.fillOpacity != null) { const shd=cell.Cell.Pr.Shd?.Copy()??new window.AscCommonWord.CDocumentShd(); shd.Value=window.Asc.c_oAscShdClear; shd.Unifill=q.fillColor!=null?solid(q.fillColor).UniFill:shd.Unifill?.createDuplicate(); need(shd.Unifill,"table_cell_fill_unavailable"); if(q.fillOpacity!=null)shd.Unifill.transparent=q.fillOpacity*255/100; cell.Cell.Set_Shd(shd); } for (const para of cell.GetContent().GetAllParagraphs()) { if (q.fontColor != null) {
          const paint = node => {
            if (typeof node.Set_Unifill === "function") { node.Set_Unifill(solid(q.fontColor).UniFill); node.Set_Color?.(undefined); node.Set_TextFill?.(undefined); }
            node.Content?.forEach(paint);
          };
          paint(para.Paragraph.TextPr); para.Paragraph.Content.forEach(paint);
        } if (q.fontSize != null) para.SetFontSize(q.fontSize * 2); if (q.fontFamily != null) para.SetFontFamily(q.fontFamily); if (q.bold != null) para.SetBold(q.bold); if (q.underline != null) para.SetUnderline(q.underline); if (q.strikethrough != null) para.SetStrikeout(q.strikethrough); if (q.characterSpacing != null) para.SetSpacing(c.nativeSpacingTwips); if (q.paragraphAlignment != null) para.GetParaPr().SetJc(q.paragraphAlignment === "justify" ? "both" : q.paragraphAlignment); if (q.textShadow != null) { const type=window.AscDFH.historyitem_Spellbook_RunEffects; for(const run of para.Paragraph.Content.filter(r=>r instanceof window.AscWord.Run)) { const effects=run.Pr.spellbookEffects?.createDuplicate()??new f.CEffectProperties(); effectList(effects).outerShdw=q.textShadow?makeShadow():null; const change=new window.AscDFH.CChangesDrawingsObjectNoId(run,type,run.Pr.spellbookEffects,effects); h.Add(change); change.Redo(); } } } for (const side of ["Left","Right","Top","Bottom"]) { const margin = q["margin"+side]; if (margin != null) cell["SetCellMargin"+side](margin*1440/2540); const border = q["border"+side]; if (border) cell["SetCellBorder"+side](border.width, solid(border.color)); } return true; }
      case "merge_table_cells": { need(table().MergeCells(mergeCells()), "table_merge_rejected"); return true; }
      case "split_table_cell": { const t = table(), cell = tableCell(c.row,c.column); t.private_PrepareTableForActions(); t.Table.Selection.Use = false; t.Table.CurCell = cell.Cell; need(t.Table.SplitTableCells(c.columns,c.rows,false), "table_split_rejected"); return true; }
      case "set_chart_data": {
        const t=chart();
        t.Chart.getAllSeries().forEach((series,col)=>{
          if(c.data!=null){
            const cache=(series.val??series.yVal).numRef.numCache;
            for(let i=cache.pts.length-1;i>=0;i--)if(c.data[cache.pts[i].idx][col]===null)cache.removeDPt(i);
            c.data.forEach((row,index)=>{
              if(row[col]===null)return;
              const point=cache.getPtByIndex(index);if(point)point.setVal(row[col]);else cache.addNumericPoint(index,row[col]);
            });
            cache.setPtCount(c.nativeChartRowCount);
          }
          if(c.columnDescriptions)need(t.SetSeriaName(c.columnDescriptions[col],series.idx),"chart_name_rejected");
          if(c.rowDescriptions)series.cat.strRef.strCache.pts.forEach(point=>point.setVal(c.rowDescriptions[point.idx]));
        });
        t.Chart.setXLSX(c.nativeWorkbook);t.Chart.onDataUpdate();return true;
      }
      case "set_chart_type": {
        const t=chart(),plot=t.Chart.chart.plotArea,method={column:"switchToBarChart",line:"switchToLineChart",area:"switchToAreaChart",pie:"switchToPieChart",scatter:"switchToScatterChart",radar:"switchToRadar"}[c.chartType];
        const originalAxes=[...plot.axId];
        plot[method](c.nativeChartType);
        // The pinned SDK adds regular axes both in createLineChart and in
        // switchToLineChart. Remove repeated references with native history;
        // retain the first axis, its authored properties and ordering.
        for(const typed of plot.charts){
          const seen=new Set();
          for(let index=0;index<(typed.axId?.length??0);index++){
            const axis=typed.axId[index];
            if(!seen.has(axis)){seen.add(axis);continue;}
            const change=new window.AscDFH.CChangesDrawingsContent(typed,window.AscDFH.historyitem_CommonChart_AddAxId,index,[axis],false);
            h.Add(change);change.Redo();index--;
          }
        }
        // The plot collection was populated from that same duplicate list.
        for(let index=plot.axId.length-1;index>=0;index--)if(plot.axId.indexOf(plot.axId[index])!==index)plot.removeAxisByPos(index);
        for(const axis of plot.axId){
          const kind=axis.getObjectType()===window.AscDFH.historyitem_type_CatAx?"category":axis.getObjectType()===window.AscDFH.historyitem_type_ValAx?"value":"other";
          const prior=originalAxes.find(item=>item.axPos===axis.axPos)??originalAxes.find(item=>
            (item.getObjectType()===window.AscDFH.historyitem_type_CatAx?"category":item.getObjectType()===window.AscDFH.historyitem_type_ValAx?"value":"other")===kind);
          if(!prior||prior===axis)continue;
          axis.setDelete(prior.bDelete??null);
          for(const key of ["majorTickMark","minorTickMark","tickLblPos","crosses","crossesAt"]){
            const method="set"+key[0].toUpperCase()+key.slice(1);fn(axis,method);axis[method](prior[key]??null);
          }
          for(const key of ["scaling","numFmt","majorGridlines","minorGridlines","title","spPr","txPr"]){
            const method="set"+key[0].toUpperCase()+key.slice(1);fn(axis,method);axis[method](prior[key]?.createDuplicate()??null);
          }
        }
        t.Chart.onDataUpdate();return true;
      }
      case "set_chart_format": { const t = chart(), q=c.chartFormat; if(q.title!=null) {const title=t.Chart.chart.title?.tx?.rich?.content;if(title)replace(new window.AscBuilder.ApiDocumentContent(title),q.title);else need(t.SetTitle(q.title,18,false),"chart_title_rejected");} if(q.legendVisible===false) t.SetLegendPos("none"); else if(q.legendPosition!=null||q.legendVisible===true) t.SetLegendPos(q.legendPosition??"right"); const cs=t.Chart.chart; if(q.categoryAxisVisible!=null) cs.plotArea.axId.filter(a=>a.getObjectType()===window.AscDFH.historyitem_type_CatAx).forEach(a=>a.setDelete(!q.categoryAxisVisible)); if(q.valueAxisVisible!=null) cs.plotArea.axId.filter(a=>a.getObjectType()===window.AscDFH.historyitem_type_ValAx).forEach(a=>a.setDelete(!q.valueAxisVisible)); if([q.showValues,q.showCategoryNames,q.showSeriesNames].some(v=>v!=null)) { const old=cs.plotArea.charts[0].dLbls; t.SetShowDataLabels(q.showSeriesNames??old?.showSerName??false,q.showCategoryNames??old?.showCatName??false,q.showValues??old?.showVal??false,old?.showPercent??false); } if(q.seriesColors) t.GetAllSeries().forEach((s,i)=>{if(q.seriesColors[i]!=null) t.SetSeriesFill(solid(q.seriesColors[i]), i, false);}); return true; }
      case "set_slide_transition": { const t=api.CreateSlideShowTransition(); t.Transition=slide.Slide.transition?.createDuplicate()??t.Transition; const map={none:"effectNone",fade:"effectFadeSmoothly","fade-through-black":"effectFade","wipe-left-to-right":"effectWipeRight","wipe-top-to-bottom":"effectWipeDown","push-from-left":"effectPushRight","push-from-top":"effectPushDown","push-from-right":"effectPushLeft","push-from-bottom":"effectPushUp"}; if(c.transitionEffect==="fade-through-white") { t.Transition.TransitionType=window.Asc.c_oAscSlideTransitionTypes.Fade; t.Transition.TransitionOption=window.Asc.c_oAscSlideTransitionParams.Fade_ThroughWhite; need(Number.isFinite(t.Transition.TransitionOption),"white_fade_unavailable"); } else need(t.SetEntryEffect(map[c.transitionEffect]),"transition_rejected"); t.SetDuration(c.transitionDuration*1000); return slide.SetSlideShowTransition(t); }
      case "set_slide_metadata": {
        const q=c.slideMetadata;
        if(q.backgroundObjectsVisible!=null)slide.Slide.setShowMasterSp(q.backgroundObjectsVisible);
        if(q.duration!=null||q.autoAdvance!=null){
          const transition=api.CreateSlideShowTransition();
          transition.Transition=slide.Slide.transition.createDuplicate();
          if(q.duration!=null){transition.SetAdvanceTime(q.duration*1000);transition.SetAdvanceOnTime(true);}
          if(q.autoAdvance!=null)transition.SetAdvanceOnTime(q.autoAdvance);
          need(slide.SetSlideShowTransition(transition),"metadata_transition_rejected");
        }
        const fields=[["footerVisible","footerText",f.phType_ftr],["dateTimeVisible","dateTimeText",f.phType_dt],["pageNumberVisible",null,f.phType_sldNum]];
        for(const [visible,text,type] of fields){
          const date=type===f.phType_dt;
          if(q[visible]==null&&(text==null||q[text]==null)&&!(date&&(q.dateTimeFixed!=null||q.dateTimeFormat!=null)))continue;
          let shape=slide.Slide.getMatchingShape(type,null,false,{});
          const existing=!!shape;
          if(!shape){
            if(q[visible]===false&&(text==null||q[text]==null)&&!date)continue;
            const template=slide.Slide.Layout.getMatchingShape(type,null,false,{})??slide.Slide.Layout.Master.getMatchingShape(type,null,false,{});
            need(template,"metadata_placeholder_missing");shape=template.copy();shape.setParent(slide.Slide);slide.AddObject(wrap(shape));
          }
          // Hidden placeholders retain their authored text/field and format.
          // Deleting them would lose footer/date settings when toggled on again.
          if(q[visible]!=null)shape.getCNvProps().setIsHidden(!q[visible]);
          else if(!existing)shape.getCNvProps().setIsHidden(true);
          const doc=wrap(shape).GetContent();
          if(type===f.phType_ftr){if(q.footerText!=null)replace(doc,q.footerText);continue;}
          const runs=shape.getDocContent().Content.flatMap(paragraph=>paragraph.Content);
          const current=runs.find(run=>typeof run.FieldType==="string");
          if(date&&q.dateTimeFixed!==false&&(q.dateTimeText!=null||q.dateTimeFixed===true)){
            const value=q.dateTimeText??c.nativeDateTimeFreeze;
            need(typeof value==="string","metadata_date_freeze_unavailable");replace(doc,value.replace(/\r?\n$/,"") );continue;
          }
          if(type===f.phType_sldNum&&current?.FieldType==="slidenum")continue;
          if(date&&q.dateTimeFixed==null&&q.dateTimeFormat==null&&current)continue;
          const fieldType=date?(c.nativeDateFieldType??current?.FieldType??"datetime1"):"slidenum";
          need(!date||/^datetime(?:[1-9]|1[0-3])$/.test(fieldType),"metadata_date_format_unavailable");
          const first=doc.GetElement(0),textPr=first?.GetElement(0)?.GetTextPr?.()?.TextPr?.Copy()??first?.GetTextPr?.()?.TextPr?.Copy();
          const paraPr=first?.Paragraph?.GetDirectParaPr?.()?.Copy();
          doc.RemoveAllElements();const paragraph=doc.GetElement(0).Paragraph;
          if(paraPr)paragraph.SetPr(paraPr);
          const field=new window.AscCommonWord.CPresentationField(paragraph);
          field.SetGuid(window.AscCommon.CreateGUID());field.SetFieldType(fieldType);
          if(textPr)field.Set_Pr(textPr);
          paragraph.Internal_Content_Add(0,field);
        }
        return true;
      }
      case "set_animation_timing":
        need(effect.SetDuration(c.duration*1000),"animation_timing_rejected");
        need(effect.SetDelay(c.delay*1000),"animation_timing_rejected");
        need(effect.SetTriggerType({"on-click":"onclick","with-previous":"withprevious","after-previous":"afterprevious"}[c.start]),"animation_timing_rejected");
        return true;
      case "add_animation_effect": {
        const added=slide.GetTimeLine().GetMainSequence().AddEffect(d,c.nativePreset.type,
          {"on-click":"onclick","with-previous":"withprevious","after-previous":"afterprevious"}[c.start]??"onclick");
        need(added,"animation_preset_unsupported");
        if(c.duration!=null)need(added.SetDuration(c.duration*1000),"animation_timing_rejected");
        if(c.delay!=null)need(added.SetDelay(c.delay*1000),"animation_timing_rejected");
        return true;
      }
      case "replace_animation_effect": {
        const timing=effect.Timing,sequences=timing.getEffectsSequences();
        const owner=sequences.find(sequence=>sequence.slice(1).some(item=>item._apiId===effect._apiId));
        need(owner,"animation_target_missing");
        const index=owner.findIndex((item,index)=>index>0&&item._apiId===effect._apiId),original=owner[index];
        const target=effect.GetShape();need(target,"animation_target_missing");
        const replacement=timing.createEffect(target.Drawing.GetId(),c.nativePreset.presetClass,
          c.nativePreset.presetId,c.nativePreset.presetSubtype,null);
        need(replacement,"animation_preset_unsupported");
        const wrapper=new effect.constructor(replacement,timing);
        wrapper.SetDuration(effect.GetDuration());wrapper.SetDelay(effect.GetDelay());
        // These are authored timing fields, not properties of the new preset.
        for(const name of ["accel","afterEffect","autoRev","bldLvl","decel","display","evtFilter","fill","grpId","masterRel","nodePh","nodeType","repeatCount","repeatDur","restart","spd","syncBehavior","tmFilter"]){
          const setter="set"+name[0].toUpperCase()+name.slice(1);
          if(typeof replacement.cTn[setter]==="function")replacement.cTn[setter](original.cTn[name]);
        }
        for(const name of ["endCondLst","endSync","iterate","stCondLst","subTnLst"]){
          const setter="set"+name[0].toUpperCase()+name.slice(1);
          if(original.cTn[name])replacement.cTn[setter](original.cTn[name].createDuplicate({}));
        }
        owner[index]=replacement;timing.buildTree(sequences);
        return true;
      }
      case "remove_animation_effect": return effect.Delete();
      case "move_animation_effect": {
        const seqs = effect.Timing.getEffectsSequences();
        const flattened = seqs.flatMap(seq => seq.slice(1).map(item => ({seq, item})));
        const from = flattened.find(item => item.item._apiId === effect._apiId);
        const to = flattened[c.animationIndex];
        need(from && to, "animation_position_invalid");
        if (from.item === to.item) return true;
        from.seq.splice(from.seq.indexOf(from.item), 1);
        // Moving across trigger sequences must use the destination sequence,
        // rather than treating a global index as a local sequence index.
        const index = to.seq.indexOf(to.item) + (c.animationIndex > c.nativeEffectIndex ? 1 : 0);
        to.seq.splice(index, 0, from.item);
        effect.Timing.buildTree(seqs.filter(seq => seq.length > 1));
        return true;
      }
      case "insert_image": case "insert_media": { const a=c.nativeAsset; let image; if(c.op==="insert_image") image=api.CreateImage(a.url,c.width*360,c.height*360); else { const shape=slide.Slide.graphicObjects.createImage(a.posterUrl,0,0,c.width/100,c.height/100,a.kind==="video"?a.url:null,a.kind==="audio"?a.url:null); const media=shape.nvPicPr.nvPr.unimedia.createDuplicate(); media.media=a.url; shape.nvPicPr.nvPr.setUniMedia(media); image=new window.AscBuilder.ApiImage(shape); } return add(image); }
      case "replace_image": { const fill=source.blipFill.createDuplicate(); fill.setRasterImageId(c.nativeAsset.url); source.setBlipFill(fill); return true; }
      case "replace_media": { const media=source.nvPicPr.nvPr.unimedia?.createDuplicate()??new f.UniMedia(); media.type=c.nativeAsset.kind==="video"?7:8; media.media=c.nativeAsset.url; source.nvPicPr.nvPr.setUniMedia(media); return true; }
      case "set_smartart_node": { const point=pointTarget(), leaves=[]; const visit=x=>{if(x.getSmartArtPointContent?.()?.some(n=>n.point?.modelId===point.modelId))leaves.push(x);x.spTree?.forEach(visit);};visit(source);need(leaves.length===1,"diagram_text_binding_ambiguous");replace(wrap(leaves[0]).GetContent(),c.smartartNode.text);const body=leaves[0].txBody?.bodyPr;
        leaves[0].copyTextInfoFromShapeToPoint(body?{Left:body.lIns,Right:body.rIns,Top:body.tIns,Bottom:body.bIns}:undefined);return true; }
      case "add_smartart_node": case "delete_smartart_node": return mutateDiagramTopology();
      case "add_comment": {
        const data=new window.AscCommon.CCommentData();data.m_sText=c.text;data.m_sUserName=c.author;data.m_sUserId="";data.m_sTime=String(Date.now());data.m_sOOTime=data.m_sTime;data.m_sGuid=window.AscCommon.CreateGUID();
        const comment=new window.AscCommon.CComment(slide.Slide.slideComments,data);comment.setPosition(c.nativeCommentPosition.x,c.nativeCommentPosition.y);
        if(c.initials!=null){const type=window.AscDFH.historyitem_Spellbook_CommentInitials;need(Number.isSafeInteger(type),"comment_initials_history_unavailable");const change=new window.AscDFH.CChangesDrawingsString(comment,type,undefined,c.initials);h.Add(change);change.Redo();}
        slide.Slide.slideComments.addComment(comment);return true;
      }
      case "edit_comment": { const data=comment.Data.createDuplicate();data.m_sText=c.text;if(c.author!=null)data.m_sUserName=c.author;slide.Slide.slideComments.changeComment(comment.Id,data);return true; }
      case "delete_comment": slide.Slide.slideComments.removeComment(comment.Id); return true;
      default: fail("operation_unavailable:"+c.op);
    }
  } finally { editor.executeGroupActionsEnd(); }
}
