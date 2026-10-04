/* SPDX-License-Identifier: MPL-2.0 */
import { firstDocumentStateDifference } from "../../office-session-spike/document-state-evidence.mjs";
import { rebaseOnlyOfficeIntentIdentities } from "./intent-identities.mjs";
import { onlyOfficeParagraphFormat } from "./paragraph-format.mjs";

const copy = value => structuredClone(value);
const need = (condition, path) => { if (!condition) throw Error("onlyoffice_product_intent_mismatch:" + path); };
const same = (expected, actual, path) => {
  const difference = firstDocumentStateDifference(expected, actual, path);
  if (difference) throw Error("onlyoffice_product_intent_mismatch:" + difference.path);
};
// SmartArt's native layout derives font fitting and default padding. Keep
// authored font overrides and explicit semantic-node insets exact; admit only
// these derived values from the separately reopened native layout.
function diagramTextDerivations(before,after,points){
  const owners=(before.diagramPointIds??[]).map(id=>points.find(point=>point.id===id)).filter(Boolean);
  if(!owners.length)return;
  for(const inset of ["lIns","rIns","tIns","bIns"])
    if(owners.every(point=>point.textBodyInsets?.[inset]==null)&&before.bodyProperties&&after.bodyProperties)
      before.bodyProperties[inset]=after.bodyProperties[inset];
  if(owners.some(point=>point.customText===true))return;
  before.paragraphs?.forEach((para,pi)=>{
    const observed=after.paragraphs?.[pi];if(!observed)return;
    for(const [group,keys] of [["indent",["Left","FirstLine"]],["spacing",["Before","After","Line","LineRule"]]])
      for(const key of keys)if(owners.every(point=>point.paragraphOverrides?.[pi]?.[group]?.[key]==null)&&para.format?.[group]&&observed.format?.[group])
        para.format[group][key]=observed.format[group][key];
    para.runs.forEach((run,ri)=>{
      const actual=observed.runs?.[ri]?.style;
      if(actual&&Number.isFinite(actual.GetFontSize)&&actual.GetFontSize>0)run.style.GetFontSize=actual.GetFontSize;
    });
  });
}
const color = rgb => ({type:1,id:null,rgb:{R:(rgb>>>16)&255,G:(rgb>>>8)&255,B:rgb&255,A:255},modifiers:[]});
const emptyEffects = () => ({outerShadow:null,glow:null,softEdge:null,blur:null,reflection:null,innerShadow:null,presetShadow:null,fillOverlay:null});
const shadow = (command, original) => {
  const angle=(original?.dir??0)/60000*Math.PI/180;
  const x=command.shadowOffsetX!=null?command.shadowOffsetX*360:original?(original.dist??0)*Math.cos(angle):72000;
  const y=command.shadowOffsetY!=null?command.shadowOffsetY*360:original?(original.dist??0)*Math.sin(angle):72000;
  const result=original?copy(original):{blurRad:0,dist:Math.round(Math.hypot(x,y)),
    dir:((Math.round(Math.atan2(y,x)*180/Math.PI*60000)%21600000)+21600000)%21600000,
    sx:null,sy:null,kx:null,ky:null,algn:null,rotWithShape:null,color:color(command.color??0)};
  if(command.color!=null)result.color=color(command.color);
  if(command.shadowBlur!=null)result.blurRad=Math.round(command.shadowBlur*360);
  if(command.shadowOffsetX!=null||command.shadowOffsetY!=null){result.dist=Math.round(Math.hypot(x,y));result.dir=((Math.round(Math.atan2(y,x)*180/Math.PI*60000)%21600000)+21600000)%21600000;}
  if(command.opacity!=null){result.color.modifiers=result.color.modifiers.filter(mod=>mod.name!=="alpha");result.color.modifiers.push({name:"alpha",val:command.opacity*1000});}
  return result;
};
function target(state,id) {
  const [si,...path]=id.split("/").map(Number), slide=state.slides[si];
  need(slide,"slide_target");
  let elements=slide.elements, drawings=slide.onlyoffice.drawings, element,drawing;
  for(const index of path){element=elements?.[index];drawing=drawings?.[index];need(element&&drawing,"element_target");elements=element.elements;drawings=drawing.groupChildren;}
  return {slide,element,drawing,index:path[0],style: path.length===1?slide.narrow.drawingStyle[path[0]]:null};
}
function updateText(element,drawing) {
  drawing.text=drawing.paragraphs.map(para=>para.text).join("");
  element.text=drawing.text;element.onlyoffice.text=drawing.text;
}
function mergeRuns(runs) {
  const result=[];
  for(const run of runs){const previous=result.at(-1);if(previous&&!previous.field&&!run.field&&JSON.stringify(previous.style)===JSON.stringify(run.style))previous.text+=run.text;else result.push(copy(run));}
  return result;
}
function resizeElement(state,id,x,y,width,height) {
  const {element}=target(state,id);
  if(x!=null)element.x=Math.round(x);if(y!=null)element.y=Math.round(y);
  if(width!=null)element.width=Math.round(width);if(height!=null)element.height=Math.round(height);
}
function projectedCell(drawing,row,column) {
  for(let r=row;r>=0;r--){
    const cells=drawing.tableCellProperties?.[r];need(cells,"table_cell_target");
    const index=cells.findIndex(cell=>column>=cell.column&&column<cell.column+cell.gridSpan);
    need(index>=0,"table_cell_grid_target");
    if(cells[index].verticalMerge===2)continue;
    return {row:r,column:index,cell:cells[index]};
  }
  need(false,"table_cell_merge_owner");
}
// Simulate authored values from the canonical command, not from the observed
// result. Derived layout fields are removed only after their source inputs have
// been checked. The initial adapter then compares every remaining property.
export function simulateOnlyOfficeExtendedIntent(left,right,commands,remainingCommands=commands) {
  for(const c of commands){
    if(c.op==="group"){
      const selected=c.elementIds.map(id=>target(left,id)).sort((a,b)=>a.index-b.index),slide=selected[0].slide;
      const actual=right.slides[slide.slideIndex],count=slide.elements.length-selected.length;
      need(actual.elements.length===count+1,"group_element_count");
      const group=copy(actual.elements[count]),drawing=copy(actual.onlyoffice.drawings[count]),bounds=c.nativeGroupBounds;
      need(group.kind==="group"&&group.elements.length===selected.length&&drawing.groupChildren?.length===selected.length,"group_children_count");
      need(bounds,"group_bound_source");
      // A newly allocated container must not overwrite an old object's
      // reference when its final positional ID happens to reuse that slot.
      group.elementId="new-group";
      same(Object.fromEntries(Object.entries(bounds).map(([key,value])=>[key,Math.round(value)])),
        {x:group.x,y:group.y,width:group.width,height:group.height},"group_geometry");
      group.elements=selected.map(({element})=>{
        const child=copy(element);child.x=Math.round(child.x-bounds.x);child.y=Math.round(child.y-bounds.y);return child;
      });
      drawing.groupChildren=selected.map(item=>copy(item.drawing));
      const selectedIndexes=new Set(selected.map(item=>item.index));let tableIndex=0;
      slide.narrow.table=slide.elements.flatMap((element,index)=>{
        if(element.kind!=="table")return [];
        const table=slide.narrow.table[tableIndex++];return selectedIndexes.has(index)?[]:[table];
      });
      for(const item of [...selected].reverse()){
        slide.elements.splice(item.index,1);slide.onlyoffice.drawings.splice(item.index,1);
        slide.narrow.drawingStyle.splice(item.index,1);slide.narrow.wordArt.splice(item.index,1);
      }
      // The native group is appended in slide order. Its container properties
      // are new defaults; every retained child remains independently expected.
      slide.elements.push(group);slide.onlyoffice.drawings.push(drawing);
      slide.narrow.drawingStyle.push(copy(actual.narrow.drawingStyle[count]));
      slide.narrow.wordArt.push(copy(actual.narrow.wordArt[count]));
      rebaseOnlyOfficeIntentIdentities(slide,slide.slideIndex);
      continue;
    }
    if(c.op==="ungroup"){
      const a=target(left,c.elementId),slide=a.slide,actual=right.slides[slide.slideIndex],children=copy(a.element.elements),drawings=copy(a.drawing.groupChildren);
      need(children.length&&c.nativeUngroupGeometry?.length===children.length&&actual.elements.length===slide.elements.length-1+children.length,"ungroup_count");
      children.forEach((child,index)=>{
        const geometry=c.nativeUngroupGeometry[index];
        for(const key of ["x","y","width","height"])child[key]=geometry[key];
        drawings[index].GetRotation=geometry.rotation;drawings[index].GetFlipH=geometry.flipH;drawings[index].GetFlipV=geometry.flipV;
        if(drawings[index].fill?.type===6&&a.drawing.fill)drawings[index].fill=copy(a.drawing.fill);
      });
      slide.elements.splice(a.index,1,...children);slide.onlyoffice.drawings.splice(a.index,1,...drawings);
      // These narrower root-level summaries duplicate authored properties
      // already checked in each child's complete drawing observation.
      slide.narrow.drawingStyle.splice(a.index,1,...copy(actual.narrow.drawingStyle.slice(a.index,a.index+children.length)));
      slide.narrow.wordArt.splice(a.index,1,...copy(actual.narrow.wordArt.slice(a.index,a.index+children.length)));
      const originalTables=slide.narrow.table;let retainedTable=0;
      slide.narrow.table=slide.elements.flatMap((element,index)=>{
        if(element.kind!=="table")return [];
        if(index>=a.index&&index<a.index+children.length){
          const tableIndex=slide.elements.slice(0,index).filter(item=>item.kind==="table").length;
          return [copy(actual.narrow.table[tableIndex])];
        }
        return [originalTables[retainedTable++]];
      });
      rebaseOnlyOfficeIntentIdentities(slide,slide.slideIndex);
      continue;
    }
    if(c.op==="set_slide_layout"){
      const slide=left.slides[c.slideIndex],actual=right.slides[c.slideIndex],plan=c.nativeLayoutPlan;
      need(plan,"slide_layout_plan_required");
      same({masterIndex:c.masterIndex,layoutIndex:c.nativeLayoutIndex},actual.onlyoffice.layoutBinding,"slide_layout_binding");
      const layout=left.masters[c.masterIndex].layouts[c.nativeLayoutIndex],removed=new Set(plan.removed);
      plan.existing.forEach(({index,geometry,rotation,flipH,flipV})=>{
        need(!removed.has(index)&&slide.elements[index],"slide_layout_existing_owner");
        Object.assign(slide.elements[index],geometry);Object.assign(slide.onlyoffice.drawings[index],{GetRotation:rotation,GetFlipH:flipH,GetFlipV:flipV});
      });
      let tableIndex=0;slide.narrow.table=slide.elements.flatMap((element,index)=>{
        if(element.kind!=="table")return [];const table=slide.narrow.table[tableIndex++];return removed.has(index)?[]:[table];
      });
      for(const index of [...removed].sort((a,b)=>b-a)){
        slide.elements.splice(index,1);slide.onlyoffice.drawings.splice(index,1);slide.narrow.drawingStyle.splice(index,1);slide.narrow.wordArt.splice(index,1);
      }
      need(actual.elements.length===slide.elements.length+plan.added.length,"slide_layout_element_count");
      for(const templateIndex of plan.added){
        const template=layout.drawings[templateIndex],index=slide.elements.length,drawing=actual.onlyoffice.drawings[index],element=actual.elements[index];
        need(template?.placeholder&&drawing,"slide_layout_new_placeholder");
        same(template.placeholder,drawing.placeholder,"slide_layout_placeholder_identity");
        same(template.geometryBounds,{x:element.x,y:element.y,width:element.width,height:element.height},"slide_layout_placeholder_geometry");
        need(drawing.name===template.name&&drawing.type===template.type,"slide_layout_placeholder_style_owner");
        const authoredTemplate=copy(template),authoredDrawing=copy(drawing);
        for(const value of [authoredTemplate,authoredDrawing])for(const key of ["geometryBounds","bodyProperties","paragraphs","text","hasDynamicFields"])delete value[key];
        same(authoredTemplate,authoredDrawing,"slide_layout_placeholder_preservation");
        if(template.placeholder.kind==="other")need(!drawing.paragraphs?.some(para=>para.runs.length),"slide_layout_empty_placeholder");
        const created=copy(element);created.elementId="new-layout-placeholder-"+templateIndex;
        slide.elements.push(created);slide.onlyoffice.drawings.push(copy(drawing));
        slide.narrow.drawingStyle.push(copy(actual.narrow.drawingStyle[index]));slide.narrow.wordArt.push(copy(actual.narrow.wordArt[index]));
      }
      slide.onlyoffice.layoutBinding={masterIndex:c.masterIndex,layoutIndex:c.nativeLayoutIndex};
      slide.narrow.layout={name:layout.name,type:layout.type};
      rebaseOnlyOfficeIntentIdentities(slide,slide.slideIndex);
      continue;
    }
    if(c.op==="insert_slide"){
      const index=c.slideIndex+1,source=left.slides[c.slideIndex],added=right.slides[index];
      need(right.slides.length===left.slides.length+1&&added,"insert_slide_count");
      const binding=c.masterIndex!=null?{masterIndex:c.masterIndex,layoutIndex:c.layout}:source.onlyoffice.layoutBinding;
      same(binding,added.onlyoffice.layoutBinding,"insert_slide_layout");
      const master=left.masters[binding.masterIndex],layout=master.layouts[binding.layoutIndex];
      const visible=layout.drawings.filter(drawing=>{
        if(!drawing.placeholder)return false;
        const field={dateTime:"dt",footer:"ftr",header:"hdr",pageNumber:"sldNum"}[drawing.placeholder.kind];
        return !field||master.headerFooter&&master.headerFooter[field]!==false;
      });
      need(added.elements.length===visible.length,"insert_slide_placeholders");
      visible.forEach((template,i)=>{
        const drawing=added.onlyoffice.drawings[i],element=added.elements[i];
        same(template.placeholder,drawing.placeholder,"insert_slide_placeholder_identity");
        same(template.geometryBounds,{x:element.x,y:element.y,width:element.width,height:element.height},"insert_slide_placeholder_geometry");
        if(template.placeholder.kind==="other")need(!drawing.paragraphs?.some(para=>para.runs.some(run=>run.text)),"insert_slide_empty_placeholder");
      });
      need(added.onlyoffice.visible===true&&added.onlyoffice.comments.length===0&&!(added.onlyoffice.effects?.length),"insert_slide_defaults");
      left.slides.splice(index,0,copy(added));
      for(const section of left.sections??[])if(section.startIndex>=index)section.startIndex++;
      left.slides.forEach((slide,i)=>rebaseOnlyOfficeIntentIdentities(slide,i));
      continue;
    }
    if (["add_text_box","add_shape","add_connector","add_freeform","add_table","insert_image","insert_media"].includes(c.op)) {
      const original=left.slides[c.slideIndex],actual=right.slides[c.slideIndex];
      const index=original.elements.length;
      const count=remainingCommands.filter(command=>["add_text_box","add_shape","add_connector","add_freeform","add_table","insert_image","insert_media"].includes(command.op)&&command.slideIndex===c.slideIndex).length;
      need(actual.elements.length===index+count&&actual.onlyoffice.drawings.length===index+count,"creation_count");
      const element=actual.elements[index],drawing=actual.onlyoffice.drawings[index];
      need(element.x===Math.round(c.x)&&element.y===Math.round(c.y)&&element.width===Math.round(c.width),"creation_geometry");
      if(c.op!=="add_table")need(element.height===Math.round(c.height),"creation_height");
      if(c.name!=null)need(element.objectName===c.name&&drawing.name===c.name,"creation_name");
      if(c.op==="add_text_box")need(drawing.text===c.text.replace(/\r\n/g,"\n").split("\n").map(line=>line+"\r\n").join(""),"creation_text");
      if(c.op==="add_shape"){
        need(drawing.geometry?.preset==={rectangle:"rect",ellipse:"ellipse",line:"line"}[c.geometry],"creation_shape");
        const paint=c.geometry==="line"?actual.narrow.drawingStyle[index].line?.color:drawing.fill?.color?.rgb;
        need(paint?.R===(c.color>>>16&255)&&paint.G===(c.color>>>8&255)&&paint.B===(c.color&255),"creation_color");
      }
      if(c.op==="add_connector")need(drawing.type==="connector"&&drawing.connector?.preset==={straight:"line",standard:"bentConnector3",curve:"curvedConnector3"}[c.connectorKind],"creation_connector");
      if(c.op==="add_freeform"){
        const paths=drawing.geometry?.paths;need(paths?.length===1,"freeform_path_count");
        const path=paths[0];need(Number(path.pathW)===c.width*360&&Number(path.pathH)===c.height*360&&path.commands.length===c.points.length+(c.closed?1:0),"freeform_path");
        c.points.forEach((point,i)=>{const command=path.commands[i];need(command.id===(i?1:0)&&Number(command.X??command.x)===point.x*360&&Number(command.Y??command.y)===point.y*360,"freeform_point");});
        if(c.closed)need(path.commands.at(-1).id===5,"freeform_closed");
      }
      if(c.op==="add_table"){
        need(drawing.type==="table"&&drawing.tableCells.length===c.cells.length,"creation_table_rows");
        c.cells.forEach((row,r)=>{need(drawing.tableCells[r].length===row.length,"creation_table_columns");row.forEach((text,col)=>need(drawing.tableParagraphs[r][col].map(para=>para.runs.map(run=>run.text).join("")).join("\n")===text.replace(/\r\n/g,"\n"),"creation_table_text"));});
        need(element.height===drawing.tableLayout.computedHeight,"creation_table_height");
      }
      if(c.op==="insert_image"||c.op==="insert_media"){
        need(c.nativeAsset&&drawing.imagePath===(c.op==="insert_image"?"sha256:"+c.nativeAsset.sha256:"sha256:"+c.nativeAsset.posterSha256),"creation_asset");
        if(c.op==="insert_media")same({type:c.nativeAsset.kind==="video"?7:8,media:"sha256:"+c.nativeAsset.sha256},drawing.media,"creation_media");
      }
      // Newly created default properties have no author-owned predecessor.
      // Admit them only after checking every requested input; all existing
      // elements and every other slide remain in the final strict comparison.
      original.elements.push(copy(element));original.onlyoffice.drawings.push(copy(drawing));
      original.narrow.drawingStyle.push(copy(actual.narrow.drawingStyle[index]));
      original.narrow.wordArt.push(copy(actual.narrow.wordArt[index]));
      if(c.op==="add_table")original.narrow.table.push(copy(actual.narrow.table.at(-1)));
      continue;
    }
    if(c.op==="set_slide_size") {
      const ratioX=c.width/left.width,ratioY=c.height/left.height;
      left.width=Math.round(c.width);left.height=Math.round(c.height);
      if(c.scaleContent){
        const visit=(elements)=>elements.forEach(element=>{element.x=Math.round(element.x*ratioX);element.y=Math.round(element.y*ratioY);element.width=Math.round(element.width*ratioX);element.height=Math.round(element.height*ratioY);visit(element.elements);});
        left.slides.forEach(slide=>visit(slide.elements));
        // Master/layout drawings use native dimensions, retained in this
        // projection as public API millimetres before geometry normalization.
        const scaleDrawing=draw=>{for(const [key,ratio] of [["x",ratioX],["width",ratioX],["y",ratioY],["height",ratioY]])if(draw.geometryBounds?.[key]!=null)draw.geometryBounds[key]=Math.round(draw.geometryBounds[key]*ratio);draw.groupChildren?.forEach(scaleDrawing);};
        left.masters.forEach(master=>{master.drawings.forEach(scaleDrawing);master.layouts.forEach(layout=>layout.drawings.forEach(scaleDrawing));});
      }
      continue;
    }
    if(c.op==="duplicate_element"){
      const source=target(left,c.elementId),actual=right.slides[source.slide.slideIndex],index=source.slide.elements.length;
      need(actual.elements.length===index+1,"duplicate_count");
      const expectedElement=copy(source.element),expectedDrawing=copy(source.drawing);
      const renumber=(element,prefix)=>{element.elementId=prefix;element.elements.forEach((child,i)=>renumber(child,prefix+"/"+i));};
      renumber(expectedElement,source.slide.slideIndex+"/"+index);
      if(c.x!=null)expectedElement.x=Math.round(c.x);if(c.y!=null)expectedElement.y=Math.round(c.y);
      if(c.name!=null){expectedElement.objectName=c.name;expectedElement.onlyoffice.ownName=c.name;expectedDrawing.name=c.name;}
      same(expectedElement,actual.elements[index],"duplicated_element");
      same(expectedDrawing,actual.onlyoffice.drawings[index],"duplicated_drawing");
      source.slide.elements.push(expectedElement);source.slide.onlyoffice.drawings.push(expectedDrawing);
      const style=copy(source.style),wordArt=copy(source.slide.narrow.wordArt[source.index]);
      if(c.name!=null){style.name=c.name;wordArt.name=c.name;}
      source.slide.narrow.drawingStyle.push(style);source.slide.narrow.wordArt.push(wordArt);
      if(source.element.kind==="table"){
        const ti=source.slide.elements.slice(0,source.index).filter(e=>e.kind==="table").length;
        source.slide.narrow.table.push(copy(source.slide.narrow.table[ti]));
      }
      continue;
    }
    if(c.op==="set_master_theme") {
      const t=c.theme, master=left.masters[c.masterIndex];need(master?.theme,"theme_target");
      master.theme.name=t.name;master.theme.colors={name:t.colorSchemeName,values:t.colors.map(color)};
      master.theme.fonts={name:t.fontSchemeName,major:{latin:t.majorLatin,ea:t.majorAsian,cs:t.majorComplex},minor:{latin:t.minorLatin,ea:t.minorAsian,cs:t.minorComplex}};
      continue;
    }
    if(c.op==="set_slide_metadata"){
      const q=c.slideMetadata,slide=left.slides[c.slideIndex],actual=right.slides[c.slideIndex];
      if(q.backgroundObjectsVisible!=null)slide.onlyoffice.backgroundObjectsVisible=q.backgroundObjectsVisible;
      if(q.duration!=null){need(slide.onlyoffice.transition,"metadata_transition_target");slide.onlyoffice.transition.GetAdvanceTime=q.duration*1000;slide.onlyoffice.transition.GetAdvanceOnTime=true;}
      if(q.autoAdvance!=null)slide.onlyoffice.transition.GetAdvanceOnTime=q.autoAdvance;
      const binding=slide.onlyoffice.layoutBinding,master=left.masters[binding.masterIndex],layout=master.layouts[binding.layoutIndex];
      for(const [kind,visible,text] of [["footer","footerVisible","footerText"],["dateTime","dateTimeVisible","dateTimeText"],["pageNumber","pageNumberVisible",null]]){
        if(q[visible]==null&&(text==null||q[text]==null)&&!(kind==="dateTime"&&(q.dateTimeFixed!=null||q.dateTimeFormat!=null)))continue;
        let index=slide.onlyoffice.drawings.findIndex(drawing=>drawing.placeholder?.kind===kind);
        const actualIndex=actual.onlyoffice.drawings.findIndex(drawing=>drawing.placeholder?.kind===kind);
        if(index<0&&actualIndex<0&&q[visible]===false)continue;
        need(actualIndex>=0,"metadata_placeholder_target");
        const observed=actual.onlyoffice.drawings[actualIndex],observedElement=actual.elements[actualIndex],created=index<0;
        if(created){
          const template=layout.drawings.find(drawing=>drawing.placeholder?.kind===kind)??master.drawings.find(drawing=>drawing.placeholder?.kind===kind);
          need(template,"metadata_placeholder_template");same(template.placeholder,observed.placeholder,"metadata_placeholder_identity");
          same(template.geometryBounds,{x:observedElement.x,y:observedElement.y,width:observedElement.width,height:observedElement.height},"metadata_placeholder_geometry");
          need(observed.name===template.name&&observed.type===template.type,"metadata_placeholder_style_owner");
          index=slide.elements.length;need(actualIndex===index,"metadata_placeholder_position");
          const expected=copy(template);delete expected.geometryBounds;
          slide.onlyoffice.drawings.push(expected);slide.elements.push(copy(observedElement));
          slide.narrow.drawingStyle.push(copy(actual.narrow.drawingStyle[actualIndex]));slide.narrow.wordArt.push(copy(actual.narrow.wordArt[actualIndex]));
        }else need(index===actualIndex,"metadata_placeholder_position");
        const element=slide.elements[index],drawing=slide.onlyoffice.drawings[index];
        if(q[visible]!=null)element.onlyoffice.hidden=!q[visible];else if(created)element.onlyoffice.hidden=true;
        need(element.onlyoffice.hidden===observedElement.onlyoffice.hidden,"metadata_visibility");
        const fixed=kind==="footer"?q.footerText:kind==="dateTime"&&q.dateTimeFixed!==false&&(q.dateTimeText!=null||q.dateTimeFixed===true)?q.dateTimeText??c.nativeDateTimeFreeze:null;
        if(fixed!=null){
          const wanted=fixed.replace(/\r\n/g,"\n").replace(/\n$/,"");
          need(observed.paragraphs.map(para=>para.runs.map(run=>run.text).join("")).join("\n")===wanted,"metadata_text");
          const firstStyle=drawing.paragraphs?.flatMap(para=>para.runs)[0]?.style;
          if(firstStyle)observed.paragraphs.forEach(para=>para.runs.forEach(run=>same(firstStyle,run.style,"metadata_text_style")));
          const firstPara=drawing.paragraphs?.[0];
          if(firstPara)observed.paragraphs.forEach(para=>{same(firstPara.format,para.format,"metadata_paragraph_format");need(firstPara.alignment===para.alignment,"metadata_paragraph_alignment");});
          drawing.paragraphs=copy(observed.paragraphs);drawing.text=observed.text;delete drawing.hasDynamicFields;
          element.text=observedElement.text;element.onlyoffice.text=observedElement.onlyoffice.text;
        }else if(kind==="pageNumber"||kind==="dateTime"&&(q.dateTimeFixed===false||q.dateTimeFormat!=null)){
          const oldField=drawing.paragraphs?.flatMap(para=>para.runs).find(run=>run.field)?.field;
          const desired=kind==="pageNumber"?"slidenum":c.nativeDateFieldType??oldField?.type??"datetime1";
          if(kind==="pageNumber"&&oldField?.type===desired)continue;
          const runs=observed.paragraphs?.flatMap(para=>para.runs)??[];
          need(runs.length===1&&runs[0].field?.type===desired&&typeof runs[0].field.guid==="string"&&runs[0].field.guid.length>=32,"metadata_dynamic_field");
          const oldStyle=drawing.paragraphs?.flatMap(para=>para.runs)[0]?.style;
          if(oldStyle)same(oldStyle,runs[0].style,"metadata_dynamic_field_style");
          if(drawing.paragraphs?.[0]){same(drawing.paragraphs[0].format,observed.paragraphs[0].format,"metadata_dynamic_paragraph");need(drawing.paragraphs[0].alignment===observed.paragraphs[0].alignment,"metadata_dynamic_alignment");}
          drawing.paragraphs=copy(observed.paragraphs);drawing.text=observed.text;drawing.hasDynamicFields=true;
          element.text=observedElement.text;element.onlyoffice.text=observedElement.onlyoffice.text;
        }
      }
      continue;
    }
    if(["align","distribute"].includes(c.op)) {
      const items=c.elementIds.map(id=>({id,...target(left,id).element}));
      if(c.op==="align"){
        const x=Math.min(...items.map(e=>e.x)),rightEdge=Math.max(...items.map(e=>e.x+e.width)),y=Math.min(...items.map(e=>e.y)),bottom=Math.max(...items.map(e=>e.y+e.height));
        items.forEach(e=>resizeElement(left,e.id,{left:x,right:rightEdge-e.width,center:(x+rightEdge-e.width)/2}[c.alignment],{top:y,bottom:bottom-e.height,middle:(y+bottom-e.height)/2}[c.alignment]));
      }else{
        const horizontal=c.axis==="horizontal",pos=horizontal?"x":"y",extent=horizontal?"width":"height";
        items.sort((a,b)=>a[pos]-b[pos]);const gap=(items.at(-1)[pos]+items.at(-1)[extent]-items[0][pos]-items.reduce((sum,e)=>sum+e[extent],0))/(items.length-1);let cursor=items[0][pos];
        items.forEach(e=>{resizeElement(left,e.id,horizontal?cursor:null,horizontal?null:cursor);cursor+=e[extent]+gap;});
      }
      continue;
    }
    if(["add_comment","edit_comment","delete_comment"].includes(c.op)){
      const old=left.slides[c.slideIndex].onlyoffice.comments,actual=right.slides[c.slideIndex].onlyoffice.comments;
      if(c.op==="delete_comment")old.splice(c.commentIndex,1);
      else if(c.op==="edit_comment"){need(old[c.commentIndex],"comment_target");old[c.commentIndex].text=c.text;if(c.author!=null)old[c.commentIndex].author=c.author;}
      else{
        const count=remainingCommands.filter(command=>command.op==="add_comment"&&command.slideIndex===c.slideIndex).length;
        need(actual.length===old.length+count,"comment_count");const added=actual[old.length];
        need(added.text===c.text&&added.author===c.author&&added.x===Math.round(c.nativeCommentPosition.x*100)&&added.y===Math.round(c.nativeCommentPosition.y*100)&&added.solved===false&&added.replies.length===0,"new_comment");
        need(added.initials===(c.initials??c.author.split(" ").filter(Boolean).map(word=>word.slice(0,1)).join("")),"comment_initials");
        need(typeof added.time==="string"&&/^\d+$/.test(added.time),"comment_time");old.push(copy(added));
      }
      continue;
    }
    if(c.op==="set_slide_transition"){
      const desired={none:"effectNone",fade:"effectFadeSmoothly","fade-through-black":"effectFade","fade-through-white":"effectFlashbulb","wipe-left-to-right":"effectWipeRight","wipe-top-to-bottom":"effectWipeDown","push-from-left":"effectPushRight","push-from-top":"effectPushDown","push-from-right":"effectPushLeft","push-from-bottom":"effectPushUp"}[c.transitionEffect];
      const a=left.slides[c.slideIndex].onlyoffice.transition,b=right.slides[c.slideIndex].onlyoffice.transition;
      need(b?.GetEntryEffect===desired&&b.GetDuration===c.transitionDuration*1000,"slide_transition");
      need(a,"slide_transition_observation");a.GetEntryEffect=desired;a.GetDuration=c.transitionDuration*1000;
      // Speed is a derived duration bucket, not a second authored setting.
      delete a.GetSpeed;delete b.GetSpeed;
      continue;
    }
    if(["set_animation_timing","remove_animation_effect","move_animation_effect"].includes(c.op)){
      const index=Number(c.animationId.split(":a")[1]),slide=left.slides[Number(c.animationId.split(":a")[0])].onlyoffice;
      need(slide.effects?.[index],"animation_target");
      if(c.op==="remove_animation_effect")slide.effects.splice(index,1);
      else if(c.op==="move_animation_effect"){const [effect]=slide.effects.splice(index,1);slide.effects.splice(c.animationIndex,0,effect);}
      else{Object.assign(slide.effects[index],{GetDuration:c.duration*1000,GetDelay:c.delay*1000,GetTriggerType:{"on-click":"onclick","with-previous":"withprevious","after-previous":"afterprevious"}[c.start]});slide.effects[index].timeProperties.nodeType={"on-click":2,"with-previous":7,"after-previous":0}[c.start];}
      continue;
    }
    if(["add_animation_effect","replace_animation_effect"].includes(c.op)){
      const si=c.slideIndex??Number(c.elementId.split("/")[0]),a=left.slides[si].onlyoffice,b=right.slides[si].onlyoffice;
      need(c.nativePreset,"animation_catalogue_authority");
      const expected={presetClass:c.nativePreset.presetClass,presetID:c.nativePreset.presetId,presetSubtype:c.nativePreset.presetSubtype};
      if(c.op==="replace_animation_effect"){
        const index=Number(c.animationId.split(":a")[1]);need(a.effects?.[index],"animation_target");
        a.effects[index].GetEffectType=c.nativePreset.name;a.effects[index].preset=expected;
      }else{
        const count=remainingCommands.filter(command=>command.op==="add_animation_effect"&&(command.slideIndex??Number(command.elementId.split("/")[0]))===si).length;
        need((b.effects?.length??0)===(a.effects?.length??0)+count,"animation_count");
        const added=b.effects[a.effects?.length??0];same(expected,added.preset,"animation_preset");
        need(added.targetElementId===c.elementId&&added.GetEffectType===c.nativePreset.name,"animation_target");
        if(c.duration!=null)need(added.GetDuration===c.duration*1000,"animation_duration");
        if(c.delay!=null)need(added.GetDelay===c.delay*1000,"animation_delay");
        need(added.GetTriggerType===({"on-click":"onclick","with-previous":"withprevious","after-previous":"afterprevious"}[c.start]??"onclick"),"animation_start");
        a.effects??=[];a.effects.push(copy(added));
      }
      continue;
    }
    const a=target(left,c.elementId),b=target(right,c.elementId),old=a.drawing,observed=b.drawing;
    if(c.op==="set_shape_fill"){
      const q=c.shapeFill;
      old.fill=q.type==="none"?{type:2,opacity:q.opacity??100,color:null,gradient:null,pattern:null}:
        q.type==="solid"?{type:3,opacity:q.opacity??100,color:color(q.color),gradient:null,pattern:null}:copy(c.nativeFillDescriptor);
      need(old.fill,"document_fill_catalog_binding");
      if(q.opacity!=null)old.fill.opacity=q.opacity;
      if(a.style){
        same(old.fill,observed.fill,"shape_fill");
        a.style.fill=copy(b.style.fill);a.style.fillStyle=copy(b.style.fillStyle);
      }
    }else if(c.op==="replace_image") {
      need(c.nativeAsset?.kind==="image","image_authority");old.imagePath="sha256:"+c.nativeAsset.sha256;
    }else if(c.op==="replace_media"){
      need(["audio","video"].includes(c.nativeAsset?.kind),"media_authority");
      old.media={type:c.nativeAsset.kind==="video"?7:8,media:"sha256:"+c.nativeAsset.sha256};
    }else if(c.op==="add_smartart_node"||c.op==="delete_smartart_node"){
      const diagram=a.element.onlyoffice.diagram,actual=b.element.onlyoffice.diagram,q=c.smartartNode;
      need(diagram&&actual,"diagram_target");
      const point=diagram.points.find(point=>point.id===c.nativePointId);need(point,"diagram_node_binding");
      let addedId=null;
      if(c.op==="add_smartart_node"){
        const added=actual.points.filter(point=>!diagram.points.some(old=>old.id===point.id));
        need(added.length===1&&added[0].type===0&&typeof added[0].id==="string"&&added[0].id.length>=32,"diagram_added_node_identity");
        addedId=added[0].id;
        const text=q.text.replace(/\r\n/g,"\n").split("\n").map(line=>line+"\r\n").join("");
        diagram.points.push({...copy(point),id:addedId,type:0,text,...(point.paragraphOverrides?{paragraphOverrides:q.text.replace(/\r\n/g,"\n").split("\n").map(()=>copy(point.paragraphOverrides[0]))}:{})});
        diagram.connections.push({src:c.nativeDiagramParent,dest:addedId,type:0,srcOrd:c.nativeDiagramOrder,destOrd:diagram.connections.find(edge=>edge.dest===point.id)?.destOrd??0});
      }else{
        need((point.text??"").replace(/\r?\n$/,"")===q.expectedText&&!diagram.connections.some(edge=>edge.src===point.id),"diagram_delete_node_binding");
        diagram.points=diagram.points.filter(item=>item.id!==point.id);diagram.connections=diagram.connections.filter(edge=>edge.dest!==point.id);
        const parents=new Set(diagram.connections.filter(edge=>edge.type===0).map(edge=>edge.src));
        for(const parent of parents)diagram.connections.filter(edge=>edge.type===0&&edge.src===parent).sort((a,b)=>a.srcOrd-b.srcOrd).forEach((edge,index)=>{edge.srcOrd=index;});
      }
      same(diagram,actual,"diagram_semantic_preservation");
      const leaves=(elements,drawings,result=[])=>{
        elements.forEach((element,index)=>{const drawing=drawings[index];
          if(drawing.diagramPointIds?.length)result.push({element,drawing});
          if(element.elements?.length)leaves(element.elements,drawing.groupChildren??[],result);
        });return result;
      };
      const beforeLeaves=leaves(a.element.elements,old.groupChildren??[]),afterLeaves=leaves(b.element.elements,observed.groupChildren??[]);
      const retainedIdentities=new Map();
      for(const node of diagram.points.filter(node=>[0,1].includes(node.type))){
        const rendered=afterLeaves.filter(leaf=>leaf.drawing.diagramPointIds.includes(node.id)&&leaf.drawing.paragraphs?.some(para=>para.runs.length));
        need(rendered.length===1,"diagram_rendered_node_binding");
        need(rendered[0].drawing.paragraphs.map(para=>para.runs.map(run=>run.text).join("")).join("\n")===(node.text??"").replace(/\r\n/g,"\n").replace(/\n$/, ""),"diagram_rendered_node_text");
        const sourceId=node.id===addedId?point.id:node.id,previous=beforeLeaves.filter(leaf=>leaf.drawing.diagramPointIds.includes(sourceId)&&leaf.drawing.paragraphs?.some(para=>para.runs.length));
        need(previous.length===1,"diagram_prior_node_binding");
        if(node.id!==addedId){
          const before=previous[0],after=rendered[0];diagramTextDerivations(before.drawing,after.drawing,diagram.points);
          for(const key of ["objectName","kind"])same(before.element[key],after.element[key],"diagram_retained_node_"+key);
          for(const key of ["hidden","ownName","title","description","locks","textWarp","crop"])same(before.element.onlyoffice[key],after.element.onlyoffice[key],"diagram_retained_node_"+key);
          for(const key of ["fill","effects","bodyProperties","hyperlink","GetFlipH","GetFlipV"])same(before.drawing[key],after.drawing[key],"diagram_retained_node_"+key);
        }
        // The layout regenerates geometry and may fit font sizes. Retain the
        // existing text's family, paint and emphasis in its semantic node.
        const priorStyles=previous[0].drawing.paragraphs.flatMap(para=>para.runs.map(run=>run.style));
        rendered[0].drawing.paragraphs.forEach(para=>para.runs.forEach(run=>{
          const style=copy(run.style);if(node.customText!==true)delete style.GetFontSize;
          need(priorStyles.some(previous=>{const wanted=copy(previous);if(node.customText!==true)delete wanted.GetFontSize;return !firstDocumentStateDifference(wanted,style,"diagram.node.style");}),"diagram_retained_node_style");
        }));
        if(node.id!==addedId)retainedIdentities.set(rendered[0].element.elementId,previous[0].element.elementId);
      }
      a.element.elements=copy(b.element.elements);old.groupChildren=copy(observed.groupChildren);
      const identities=elements=>elements.forEach(element=>{
        if(retainedIdentities.has(element.elementId))element.elementId=retainedIdentities.get(element.elementId);
        else if(!element.elements.length)element.elementId="new-diagram-"+element.elementId;
        identities(element.elements);
      });identities(a.element.elements);
      rebaseOnlyOfficeIntentIdentities(a.slide,a.slide.slideIndex);
    }else if(c.op==="set_smartart_node"){
      const diagram=a.element.onlyoffice.diagram,q=c.smartartNode;
      need(diagram,"diagram_target");
      const point=diagram.points.filter(point=>point.type===0&&(point.text??"").replace(/\r?\n$/,"")===q.expectedText)[q.occurrence];
      need(point,"diagram_node_target");if(point.paragraphOverrides)point.paragraphOverrides=q.text.replace(/\r\n/g,"\n").split("\n").map(()=>copy(point.paragraphOverrides[0]));point.text=q.text.replace(/\r\n/g,"\n").split("\n").map(line=>line+"\r\n").join("");
      const leaves=[];
      const visit=(elements,drawings)=>elements.forEach((element,i)=>{const drawing=drawings[i];if(drawing.diagramPointIds?.includes(point.id))leaves.push({element,drawing});if(element.elements?.length)visit(element.elements,drawing.groupChildren??[]);});
      visit(a.element.elements,old.groupChildren??[]);need(leaves.length===1,"diagram_node_binding");
      const leaf=leaves[0],observedLeaves=[];
      const read=(elements,drawings)=>elements.forEach((element,i)=>{const drawing=drawings[i];if(drawing.diagramPointIds?.includes(point.id))observedLeaves.push({element,drawing});if(element.elements?.length)read(element.elements,drawing.groupChildren??[]);});
      read(b.element.elements,observed.groupChildren??[]);need(observedLeaves.length===1,"diagram_node_binding");
      const derive=(before,after)=>{diagramTextDerivations(before,after,diagram.points);before.groupChildren?.forEach((child,index)=>derive(child,after.groupChildren[index]));};
      derive(old,observed);
      const styles=leaf.drawing.paragraphs?.flatMap(para=>para.runs.map(run=>run.style))??[];need(styles.length,"diagram_node_text_style");
      const wanted=q.text.replace(/\r\n/g,"\n").split("\n");
      const actualParagraphs=observedLeaves[0].drawing.paragraphs;need(actualParagraphs?.length===wanted.length,"diagram_node_paragraphs");
      actualParagraphs.forEach((para,i)=>{need(para.runs.map(run=>run.text).join("")===wanted[i],"diagram_node_text");para.runs.forEach(run=>same(styles[0],run.style,"diagram_node_style"));});
      leaf.drawing.paragraphs=copy(actualParagraphs);updateText(leaf.element,leaf.drawing);
    }else if(c.op==="set_chart_data"){
      need(old.cachedSeries?.length&&(c.data==null||old.cachedSeries.length===c.data[0].length),"chart_series_dimensions");
      old.cachedSeries.forEach((series,col)=>{
        const values=series.val??series.yVal;need(values?.count===c.nativeChartRowCount,"chart_value_dimensions");
        if(c.data!=null){
          values.points=values.points.filter(point=>c.data[point.idx][col]!==null);
          values.points.forEach(point=>{need(Number.isSafeInteger(point.idx)&&point.idx>=0&&point.idx<c.data.length,"chart_value_index");point.val=c.data[point.idx][col];});
          c.data.forEach((row,index)=>{if(row[col]!==null&&!values.points.some(point=>point.idx===index))values.points.push({idx:index,formatCode:null,val:row[col]});});
        }
        if(c.rowDescriptions){need(series.cat?.points.length===c.rowDescriptions.length,"chart_category_dimensions");series.cat.points.forEach(point=>{need(Number.isSafeInteger(point.idx)&&point.idx>=0&&point.idx<c.rowDescriptions.length,"chart_category_index");point.val=c.rowDescriptions[point.idx];});}
        if(c.columnDescriptions){need(series.name?.points.length===1,"chart_name_binding");series.name.points[0].val=c.columnDescriptions[col];}
      });
    }else if(c.op==="set_chart_type"){
      old.chartType=c.nativeBuilderChartType;old.series.forEach(series=>series.chartType=c.nativeChartType);
      old.cachedSeries.forEach(series=>{
        if(c.chartType==="scatter"){
          series.xVal=series.xVal??series.cat;series.yVal=series.yVal??series.val;series.cat=null;series.val=null;
        }else{
          series.cat=series.cat??series.xVal;series.val=series.val??series.yVal;series.xVal=null;series.yVal=null;
        }
      });
      const axes=observed.chartFormat.axes;
      if(c.chartType==="pie")need(!axes.length,"pie_axis_count");
      else need(axes.length===2&&axes.filter(axis=>axis.kind==="value").length===(c.chartType==="scatter"?2:1)&&axes.filter(axis=>axis.kind==="category").length===(c.chartType==="scatter"?0:1),"chart_axis_roles");
      axes.forEach(axis=>{
        const prior=old.chartFormat.axes.find(item=>item.authored?.axPos===axis.authored?.axPos)??old.chartFormat.axes.find(item=>item.kind===axis.kind);
        if(prior){
          need(axis.deleted===prior.deleted,"chart_axis_visibility_preservation");
          same(prior.authored,axis.authored,"chart_axis_authored_preservation");
        }
      });
      old.chartFormat.axes=copy(axes);
    }else if(c.op==="set_chart_format"){
      const q=c.chartFormat,format=old.chartFormat;need(format,"chart_format_target");
      if(q.title!=null)format.title=q.title+"\r\n";
      if(q.legendVisible===false)format.legend=null;
      else if(q.legendVisible===true||q.legendPosition!=null)format.legend={position:{left:1,top:2,right:3,bottom:4}[q.legendPosition??"right"]};
      if(q.categoryAxisVisible!=null)format.axes.filter(axis=>axis.kind==="category").forEach(axis=>axis.deleted=!q.categoryAxisVisible);
      if(q.valueAxisVisible!=null)format.axes.filter(axis=>axis.kind==="value").forEach(axis=>axis.deleted=!q.valueAxisVisible);
      if([q.showValues,q.showCategoryNames,q.showSeriesNames].some(value=>value!=null)){
        format.dataLabels??={showSerName:false,showCatName:false,showVal:false,showPercent:false};
        for(const [key,field] of [["showValues","showVal"],["showCategoryNames","showCatName"],["showSeriesNames","showSerName"]])if(q[key]!=null)format.dataLabels[field]=q[key];
      }
      if(q.seriesColors)format.seriesColors=q.seriesColors.map(color);
    }else if(c.op==="merge_table_cells"){
      need(old.tableCellProperties&&old.tableParagraphs,"table_merge_target");
      const ti=a.slide.elements.slice(0,a.index).filter(element=>element.kind==="table").length;
      const narrow=a.style?a.slide.narrow.table[ti]:null,rows=old.tableCellProperties;
      const selected=[],firstColumns=[];
      for(let r=c.startRow;r<=c.endRow;r++){
        const indices=rows[r].flatMap((cell,col)=>cell.column>=c.startColumn&&cell.column+cell.gridSpan-1<=c.endColumn?[col]:[]);
        need(indices.length&&rows[r][indices[0]].column===c.startColumn,"table_merge_rectangle");
        firstColumns.push(indices[0]);indices.forEach(col=>selected.push({row:r,col}));
      }
      let content=[];
      for(const {row,col} of selected){
        if(content.length===1&&!content[0].runs.length)content=[];
        content.push(...copy(old.tableParagraphs[row][col]));
      }
      // Plan the physical row/cell topology using logical grid columns before
      // reading any result. A vertical continuation keeps a fresh empty body;
      // the authored paragraphs themselves move intact into the owner.
      for(let r=c.startRow;r<=c.endRow;r++){
        const first=firstColumns[r-c.startRow],selectedColumns=selected.filter(item=>item.row===r).map(item=>item.col);
        rows[r][first].gridSpan=c.endColumn-c.startColumn+1;
        if(r!==c.startRow)rows[r][first].verticalMerge=2;
        for(const col of selectedColumns.slice(1).reverse()){
          rows[r].splice(col,1);old.tableParagraphs[r].splice(col,1);old.tableCells[r].splice(col,1);narrow?.cells[r].splice(col,1);
        }
        if(r===c.startRow)old.tableParagraphs[r][first]=content;
        else old.tableParagraphs[r][first]=null;
      }
      const retained=[];
      rows.forEach((cells,r)=>{if(!cells.every(cell=>cell.verticalMerge===2))retained.push(r);});
      need(observed.tableCellProperties.length===retained.length,"table_merge_row_count");
      old.tableCellProperties=retained.map(r=>rows[r]);
      old.tableParagraphs=retained.map(r=>old.tableParagraphs[r]);
      old.tableCells=retained.map(r=>old.tableCells[r]);
      const oldHeights=old.tableLayout.rowHeights;old.tableLayout.rowHeights=retained.map(r=>oldHeights[r]);
      if(narrow){narrow.cells=retained.map(r=>narrow.cells[r]);narrow.rows=retained.length;}
      retained.forEach((sourceRow,r)=>{
        old.tableParagraphs[r].forEach((paras,col)=>{
          if(paras===null){
            const empty=observed.tableParagraphs[r][col];
            need(empty?.length===1&&!empty[0].runs.length,"table_merge_continuation_empty");
            old.tableParagraphs[r][col]=copy(empty);
          }
          old.tableCells[r][col]=old.tableParagraphs[r][col].map(para=>para.text.replace(/(?:\r\n|\r|\n|\t)$/, "\r\n")).join("");
          if(narrow)narrow.cells[r][col].text=old.tableCells[r][col];
        });
        if(sourceRow>=c.startRow&&sourceRow<=c.endRow){
          old.tableLayout.rowHeights[r]=copy(observed.tableLayout.rowHeights[r]);
        }else old.tableLayout.rowHeights[r].computedHeight=observed.tableLayout.rowHeights[r].computedHeight;
      });
      need(b.element.height===observed.tableLayout.computedHeight,"table_merge_reflow_height");
      a.element.height=b.element.height;old.tableLayout.computedHeight=observed.tableLayout.computedHeight;
    }else if(c.op==="split_table_cell"){
      const resolved=projectedCell(old,c.row,c.column),ownerRow=resolved.row,ownerCol=resolved.column,owner=resolved.cell;
      const ti=a.slide.elements.slice(0,a.index).filter(element=>element.kind==="table").length;
      const narrow=a.style?a.slide.narrow.table[ti]:null;
      const widths=old.tableLayout.columnWidthsEmu,boundaries=[0];widths.forEach(width=>boundaries.push(boundaries.at(-1)+width));
      const start=boundaries[owner.column],end=boundaries[owner.column+owner.gridSpan];
      let rowCount=1;
      while(ownerRow+rowCount<old.tableCellProperties.length){
        const cell=old.tableCellProperties[ownerRow+rowCount].find(cell=>cell.column===owner.column);
        if(cell?.verticalMerge!==2||cell.gridSpan!==owner.gridSpan)break;rowCount++;
      }
      need(rowCount===1||rowCount%c.rows===0&&c.rows<=rowCount,"table_split_vertical_dimensions");
      const splitBoundaries=Array.from({length:c.columns+1},(_,i)=>start+(end-start)*i/c.columns);
      const grid=[...boundaries];
      for(const value of splitBoundaries.slice(1,-1))if(!grid.some(edge=>Math.abs(edge-value)<36))grid.push(value);
      grid.sort((a,b)=>a-b);
      const gridIndex=value=>{const index=grid.findIndex(edge=>Math.abs(edge-value)<36);need(index>=0,"table_split_grid_binding");return index;};
      old.tableCellProperties.forEach(row=>row.forEach(cell=>{
        const from=gridIndex(boundaries[cell.column]),to=gridIndex(boundaries[cell.column+cell.gridSpan]);cell.column=from;cell.gridSpan=to-from;
      }));
      if(rowCount===1&&c.rows>1){
        for(let i=1;i<c.rows;i++){
          const props=copy(old.tableCellProperties[ownerRow]);props.forEach((cell,col)=>{if(col!==ownerCol)cell.verticalMerge=2;});
          old.tableCellProperties.splice(ownerRow+i,0,props);
          old.tableParagraphs.splice(ownerRow+i,0,props.map(()=>null));old.tableCells.splice(ownerRow+i,0,props.map(()=>""));
          old.tableLayout.rowHeights.splice(ownerRow+i,0,copy(old.tableLayout.rowHeights[ownerRow]));
          if(narrow)narrow.cells.splice(ownerRow+i,0,copy(narrow.cells[ownerRow]));
        }
        rowCount=c.rows;
      }
      for(let i=0;i<rowCount;i++){
        const r=ownerRow+i,col=old.tableCellProperties[r].findIndex(cell=>cell.column===gridIndex(start));need(col>=0,"table_split_cell_binding");
        const sourceProps=copy(old.tableCellProperties[r][col]),sourceContent=old.tableParagraphs[r][col],sourceNarrow=narrow?copy(narrow.cells[r][col]):null;
        const props=splitBoundaries.slice(0,-1).map((value,index)=>({...copy(sourceProps),column:gridIndex(value),gridSpan:gridIndex(splitBoundaries[index+1])-gridIndex(value),verticalMerge:i%(rowCount/c.rows)===0?1:2}));
        old.tableCellProperties[r].splice(col,1,...props);
        old.tableParagraphs[r].splice(col,1,...props.map((_,index)=>index===0?sourceContent:null));
        old.tableCells[r].splice(col,1,...props.map(()=>""));
        if(narrow)narrow.cells[r].splice(col,1,...props.map(()=>copy(sourceNarrow)));
      }
      need(observed.tableCellProperties.length===old.tableCellProperties.length,"table_split_row_count");
      old.tableParagraphs.forEach((row,r)=>row.forEach((paras,col)=>{
        if(paras===null){
          const empty=observed.tableParagraphs[r][col];need(empty?.length===1&&!empty[0].runs.length,"table_split_empty_cell");old.tableParagraphs[r][col]=copy(empty);
        }
        old.tableCells[r][col]=old.tableParagraphs[r][col].map(para=>para.text.replace(/(?:\r\n|\r|\n|\t)$/, "\r\n")).join("");if(narrow)narrow.cells[r][col].text=old.tableCells[r][col];
      }));
      if(narrow)narrow.rows=old.tableCellProperties.length;
      old.tableLayout.columnWidthsEmu=grid.slice(1).map((edge,i)=>Math.round(edge-grid[i]));
      old.tableLayout.columnWidths=grid.slice(1).map((edge,i)=>Math.round((edge-grid[i])/360));
      old.tableLayout.rowHeights.forEach((height,r)=>{
        if(r>=ownerRow&&r<ownerRow+rowCount)old.tableLayout.rowHeights[r]=copy(observed.tableLayout.rowHeights[r]);else height.computedHeight=observed.tableLayout.rowHeights[r].computedHeight;
      });
      need(b.element.height===observed.tableLayout.computedHeight,"table_split_reflow_height");a.element.height=b.element.height;old.tableLayout.computedHeight=observed.tableLayout.computedHeight;
    }else if(c.op==="set_table_cell_format"){
      const q=c.tableCellFormat,resolved=projectedCell(old,c.row,c.column),{row,column,cell}=resolved;
      const paragraphs=old.tableParagraphs?.[row]?.[column];
      need(cell&&paragraphs,"table_cell_format_target");
      if(q.fillColor!=null)cell.fill={type:3,opacity:100,color:color(q.fillColor),gradient:null,pattern:null};
      if(q.fillOpacity!=null){need(cell.fill,"table_cell_fill_target");cell.fill.opacity=Math.round(q.fillOpacity*1000)/1000;}
      for(const side of ["Left","Right","Top","Bottom"]){
        const margin=q["margin"+side],border=q["border"+side];
        if(margin!=null)cell.margins[side]=margin/100;
        if(border){need(observed.tableCellProperties[row][column].borders[side]?.size===border.width,"table_cell_border_width");const wanted=color(border.color);same(wanted,observed.tableCellProperties[row][column].borders[side].fill?.color,"table_cell_border_color");cell.borders[side]=copy(observed.tableCellProperties[row][column].borders[side]);}
      }
      for(const para of paragraphs){
        if(q.paragraphAlignment!=null)para.alignment=q.paragraphAlignment;
        for(const run of para.runs){
          const style=run.style;
          for(const [key,field] of [["bold","GetBold"],["underline","GetUnderline"],["strikethrough","GetStrikeout"]])if(q[key]!=null)style[field]=q[key];
          if(q.fontSize!=null)style.GetFontSize=q.fontSize*2;
          if(q.fontFamily!=null)style.fonts=Array(4).fill(q.fontFamily);
          if(q.fontColor!=null)style.color={rgb:{r:q.fontColor>>>16&255,g:q.fontColor>>>8&255,b:q.fontColor&255},theme:false,auto:false};
          if(q.characterSpacing!=null){style.GetSpacing=Math.round(q.characterSpacing*20);style.characterSpacing=Math.round(q.characterSpacing*100)/100;}
          if(q.textShadow!=null){style.effects??=emptyEffects();style.effects.outerShadow=q.textShadow?shadow({},style.effects.outerShadow):null;}
        }
        para.runs=mergeRuns(para.runs);
      }
      const ti=a.slide.elements.slice(0,a.index).filter(element=>element.kind==="table").length;
      if(q.fillColor!=null&&a.style)a.slide.narrow.table[ti].cells[row][column].fill={R:q.fillColor>>>16&255,G:q.fillColor>>>8&255,B:q.fillColor&255,A:255};
      need(b.element.height===observed.tableLayout.computedHeight,"table_cell_reflow_height");
      a.element.height=b.element.height;old.tableLayout.computedHeight=observed.tableLayout.computedHeight;
      for(let r=row;r<=c.row;r++)old.tableLayout.rowHeights[r].computedHeight=observed.tableLayout.rowHeights[r].computedHeight;
    }else if(c.op==="set_connector"){
      const q=c.connector;
      old.connector={preset:{straight:"line",standard:"bentConnector3",curve:"curvedConnector3"}[q.kind],startElementId:q.startElementId??null,endElementId:q.endElementId??null,startGluePoint:q.startGluePoint??null,endGluePoint:q.endGluePoint??null};
      old.geometry.preset=old.connector.preset;old.geometry.adjustments=q.kind==="straight"?{}:{adj1:50000};old.geometry.paths=null;
      old.GetFlipH=q.end.x<q.start.x;old.GetFlipV=q.end.y<q.start.y;
      a.element.x=Math.min(q.start.x,q.end.x);a.element.y=Math.min(q.start.y,q.end.y);a.element.width=Math.abs(q.end.x-q.start.x);a.element.height=Math.abs(q.end.y-q.start.y);
    }else if(c.op==="text_autofit"||c.op==="set_text_box") {
      need(old.bodyProperties,"text_body");
      const pr=old.bodyProperties;
      if(c.op==="text_autofit")pr.textFit={type:c.autofit?2:0,fontScale:null,lnSpcReduction:null};
      else{
        for(const [key,field] of [["marginLeft","lIns"],["marginRight","rIns"],["marginTop","tIns"],["marginBottom","bIns"]])if(c[key]!=null)pr[field]=c[key]/100;
        if(c.wordWrap!=null)pr.wrap=c.wordWrap?1:0;
        if(c.autoGrowHeight!=null)pr.textFit={type:c.autoGrowHeight?1:0,fontScale:null,lnSpcReduction:null};
        if(c.autoGrowWidth!=null)pr.wrap=c.autoGrowWidth?0:1;
        // With no wrapping, native text layout determines width. Shape
        // autofit determines height; both are persisted by the same native
        // geometry/history path after these exact body inputs are checked.
        if(pr.wrap===0||pr.textFit?.type===1){
          a.element.x=b.element.x;a.element.y=b.element.y;
          if(pr.wrap===0)a.element.width=b.element.width;
          if(pr.textFit?.type===1)a.element.height=b.element.height;
        }
      }
    }else if(c.op==="set_fontwork"){
      old.bodyProperties.warp=c.fontwork.preset;a.element.onlyoffice.textWarp=c.fontwork.preset;
      if(a.style)a.slide.narrow.wordArt[a.index].preset=c.fontwork.preset;
    }else if(c.op==="set_shape_shadow"){
      old.effects??=emptyEffects();old.effects.outerShadow=c.shadow?shadow(c,old.effects.outerShadow):null;
    }else if(c.op==="text_shadow"){
      need(old.paragraphs?.length,"text_shadow_target");
      old.paragraphs.forEach(para=>{para.runs.forEach(run=>{run.style.effects??=emptyEffects();run.style.effects.outerShadow=c.shadow?shadow(c,run.style.effects.outerShadow):null;});para.runs=mergeRuns(para.runs);});
    }else if(c.op==="set_shape_effects"){
      const q=c.shapeEffects;old.effects??=emptyEffects();const props=old.effects;
      if(q.glowRadius!=null||q.glowColor!=null||q.glowOpacity!=null){props.glow??={radius:null,color:color(0)};if(q.glowRadius!=null)props.glow.radius=Math.round(q.glowRadius*360);if(q.glowColor!=null)props.glow.color=color(q.glowColor);if(q.glowOpacity!=null){props.glow.color.modifiers=props.glow.color.modifiers.filter(m=>m.name!=="alpha");props.glow.color.modifiers.push({name:"alpha",val:q.glowOpacity*1000});}}
      if(q.softEdgeRadius!=null)props.softEdge=Math.round(q.softEdgeRadius*360);
    }else if(c.op==="set_object_interaction"){
      const link=c.interaction==="external_url"?c.url:c.interaction==="internal_slide"?"ppaction://hlinksldjumpslide"+c.targetSlideIndex:"ppaction://hlinkshowjump?jump="+{next_slide:"nextslide",previous_slide:"previousslide",first_slide:"firstslide",last_slide:"lastslide",end_show:"endshow"}[c.interaction];
      if(c.interaction==="none")delete old.hyperlink;else old.hyperlink={link,tooltip:c.description??""};
    }else if(c.op==="set_paragraph_format"){
      const index=Number(c.paragraphId.slice((c.elementId+":p").length)),format=old.paragraphs[index]?.format,q=c.paragraphFormat;need(format,"paragraph_target");
      const native=onlyOfficeParagraphFormat(q);
      for(const [key,field] of [["leftMargin","Left"],["rightMargin","Right"],["firstLineIndent","FirstLine"]])if(q[key]!=null){format.indent??={Left:null,Right:null,FirstLine:null};format.indent[field]=Math.round(native.indent[field]*36000)/36000;}
      for(const [key,field] of [["topMargin","Before"],["bottomMargin","After"]])if(q[key]!=null){format.spacing??={Before:null,After:null,Line:null,LineRule:null};format.spacing[field]=Math.round(native.spacing[field]*36000)/36000;}
      if(q.direction==="top-to-bottom")old.bodyProperties.vert=3;else if(q.direction!=null)format.bidi=q.direction==="right-to-left";
    }else if(c.op==="set_paragraph_list"){
      const index=Number(c.paragraphId.slice((c.elementId+":p").length)),format=old.paragraphs[index]?.format,q=c.paragraphList;need(format,"paragraph_target");
      format.level=q.level;format.list={type:{none:0,bullet:1,number:2}[q.type],Char:q.type==="bullet"?q.bulletCharacter:null,AutoNumType:q.type==="number"?(q.prefix==="("?10:q.suffix===")"?11:q.suffix==="."?12:13):null,startAt:q.type==="number"?q.startWith:null};
    }else if(c.op==="set_text_case"){
      let inWord=false;
      old.paragraphs.forEach(para=>{
        inWord=false;
        para.runs.forEach(run=>{run.style.GetCaps=c.textCase==="uppercase";run.style.GetSmallCaps=c.textCase==="small_caps";
          if(["lowercase","title"].includes(c.textCase))run.text=[...run.text].map(char=>{const word=/[\p{L}\p{M}\p{N}'’]/u.test(char),value=c.textCase==="title"&&word&&!inWord?char.toLocaleUpperCase(run.style.GetLanguage??undefined):char.toLocaleLowerCase(run.style.GetLanguage??undefined);inWord=word;return value;}).join("");});
        para.runs=mergeRuns(para.runs);para.text=para.runs.map(run=>run.text).join("")+"\r\n";
      });updateText(a.element,old);
    }else if(c.op==="replace_text_range"){
      const index=Number(c.paragraphId.slice((c.elementId+":p").length)),para=old.paragraphs[index];need(para,"paragraph_target");
      const text=para.runs.map(run=>run.text).join("");need(text.slice(c.startOffset,c.endOffset)===c.expectedText,"text_range_stale");
      let cursor=0,inserted=false;const runs=[];
      for(const run of para.runs){const end=cursor+run.text.length;
        if(end<=c.startOffset||cursor>=c.endOffset&&!(c.startOffset===c.endOffset&&cursor<=c.startOffset&&end>c.startOffset)){if(!inserted&&cursor>=c.endOffset){runs.push({...copy(run),text:c.text});inserted=true;}runs.push(copy(run));}
        else{const prefix=run.text.slice(0,Math.max(0,c.startOffset-cursor)),suffix=run.text.slice(Math.max(0,c.endOffset-cursor));if(prefix)runs.push({...copy(run),text:prefix});if(!inserted){runs.push({...copy(run),text:c.text});inserted=true;}if(suffix)runs.push({...copy(run),text:suffix});}cursor=end;
      }
      if(!inserted){need(para.runs.length,"empty_range_style");runs.push({...copy(para.runs.at(-1)),text:c.text});}
      para.runs=mergeRuns(runs.filter(run=>run.text));para.text=text.slice(0,c.startOffset)+c.text+text.slice(c.endOffset)+"\r\n";updateText(a.element,old);
    }else{
      throw Error("onlyoffice_product_intent_unavailable:"+c.op);
    }
    // Layout is recalculated from the exact verified inputs above. Authorial
    // geometry remains subject to the same common physical-outline budget.
    // The outer intent verifier compares the complete final state once all
    // commands have been simulated, including later commands on this element.
  }
  return {left,right};
}
