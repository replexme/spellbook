/* SPDX-License-Identifier: MPL-2.0 */
import { onlyOfficeExtendedOperations } from "./extended-commands.mjs";

// Requests come only from the admitted observation and the canonical schema.
// Missing authored fixtures fail explicitly; setup mutations are never hidden
// inside a measured command or counted as evidence for another operation.
export function onlyOfficeExtendedCommandCase({operation, observation, schema, slideIndex = 0, assets = {}}) {
  if (!onlyOfficeExtendedOperations.includes(operation)) return null;
  const slide = observation.slides[slideIndex];
  if (!slide) throw Error("case_slide_missing");
  const full = slide.onlyoffice.drawings;
  const requireElement = predicate => {
    const index = slide.elements.findIndex((element, i) => predicate(element, full[i]));
    if (index < 0) throw Error("case_authored_fixture_missing:" + operation);
    return {element: slide.elements[index], drawing: full[index]};
  };
  const fields = (name, values) => ({...Object.fromEntries(Object.keys(schema.properties[name].properties).map(key => [key, null])), ...values});
  const command = {...Object.fromEntries(Object.keys(schema.properties).map(key => [key, null])), op: operation};
  const slideOps = new Set(["insert_slide","set_slide_layout","set_slide_transition","set_slide_metadata","add_comment","edit_comment","delete_comment"]);
  const createOps = new Set(["add_text_box","add_shape","add_connector","add_freeform","add_table","insert_image","insert_media"]);
  if (slideOps.has(operation) || createOps.has(operation)) command.slideIndex = slideIndex;
  let selected;
  if (operation.startsWith("set_chart")) selected = requireElement(element => element.kind === "chart");
  else if (["merge_table_cells","split_table_cell","set_table_cell_format"].includes(operation)) selected = requireElement(element => element.kind === "table");
  else if (operation.includes("smartart")) selected = requireElement((element, drawing) => element.onlyoffice.diagram?.points?.length);
  else if (operation === "ungroup") selected = requireElement((element, drawing) => element.kind === "group" && !element.onlyoffice.diagram);
  else if (operation === "set_connector") selected = requireElement((element, drawing) => drawing.type === "connector");
  else if (operation === "replace_image") selected = requireElement((element, drawing) => element.kind === "image" && !drawing.media);
  else if (operation === "replace_media") selected = requireElement((element, drawing) => drawing.media);
  else if (["set_animation_timing","remove_animation_effect","replace_animation_effect","move_animation_effect"].includes(operation)) {
    const effect = slide.onlyoffice.effects?.[0];
    if (!effect?.targetElementId) throw Error("case_authored_animation_missing");
    selected = requireElement(element => element.elementId === effect.targetElementId);
    command.animationId = `${slideIndex}:a0`;
  } else if (!slideOps.has(operation) && !createOps.has(operation) && !["set_slide_size","set_master_theme","align","distribute","group"].includes(operation))
    selected = requireElement((element, drawing) => element.kind === "shape" && drawing.paragraphs?.some(para => para.runs.some(run => run.text)));
  if (selected) command.elementId = selected.element.elementId;
  if (createOps.has(operation)) Object.assign(command, {x: 1000, y: 1000, width: 6000, height: 3000, name: `Canonical ${operation}`});
  const changes = {
    insert_slide: {}, set_slide_size: {width: observation.width + 1000, height: observation.height + 500, scaleContent: false},
    set_master_theme: {masterIndex: 0, theme: {name: "Verified theme", colorSchemeName: "Verified colors", colors: [0,0xffffff,0x222222,0xeeeeee,0x2458ff,0x27b575,0xffdd55,0xff6655,0x9955aa,0x55bbcc,0x0000ff,0x800080], fontSchemeName: "Verified fonts", majorLatin: "Arial",majorAsian: "Arial",majorComplex: "Arial",minorLatin: "Arial",minorAsian: "Arial",minorComplex: "Arial"}},
    add_text_box: {text: "검증용 텍스트\nSecond paragraph"}, add_shape: {geometry: "ellipse", color: 0x27b575},
    add_connector: {connectorKind: "standard", color: 0x2458ff},
    add_freeform: {points: [{x:0,y:0},{x:6000,y:0},{x:3000,y:3000}],closed:true,color:0x2458ff},
    add_table: {cells:[["A","B"],["C","D"]]}, align: {alignment:"right"}, distribute: {axis:"horizontal"}, group: {}, ungroup: {},
    duplicate_element: {name:"Verified duplicate", x:(selected?.element.x??0)+500,y:(selected?.element.y??0)+500},
    text_shadow:{shadow:true,color:0x2458ff,shadowOffsetX:100,shadowOffsetY:150,shadowBlur:75,opacity:70},
    set_shape_shadow:{shadow:true,color:0x2458ff,shadowOffsetX:100,shadowOffsetY:150,shadowBlur:75,opacity:70},
    set_shape_fill:{shapeFill:fields("shapeFill",{type:"solid",color:0x27b575,opacity:60})},
    set_shape_effects:{shapeEffects:fields("shapeEffects",{glowRadius:100,glowColor:0x2458ff,glowOpacity:70,softEdgeRadius:50})},
    text_autofit:{autofit:true},set_text_box:{marginLeft:150,marginRight:150,marginTop:100,marginBottom:100,wordWrap:true,autoGrowHeight:false},
    set_text_case:{textCase:"lowercase"},set_fontwork:{fontwork:{preset:"textWave1"}},
    set_paragraph_format:{paragraphFormat:fields("paragraphFormat",{leftMargin:200,firstLineIndent:50,topMargin:100,bottomMargin:100})},
    set_paragraph_list:{paragraphList:{type:"number",level:0,prefix:"",suffix:".",startWith:2,bulletCharacter:null}},
    set_object_interaction:{interaction:"external_url",url:"https://spellbook.my",description:"Verified link"},
    merge_table_cells:{startRow:0,endRow:1,startColumn:0,endColumn:1},split_table_cell:{row:0,column:0,rows:1,columns:2},
    set_table_cell_format:{row:0,column:0,tableCellFormat:fields("tableCellFormat",{fillColor:0x27b575,fontColor:0xffffff,bold:true})},
    set_chart_type:{chartType:"line"},set_chart_format:{chartFormat:fields("chartFormat",{title:"Verified chart",legendVisible:true,legendPosition:"bottom"})},
    set_slide_transition:{transitionEffect:"wipe-left-to-right",transitionDuration:1.25},
    set_slide_metadata:{slideMetadata:fields("slideMetadata",{backgroundObjectsVisible:false,duration:8,autoAdvance:true})},
    set_animation_timing:{duration:1.5,delay:0.25,start:"after-previous"},add_animation_effect:{presetId:"ooo-entrance-appear",duration:1,delay:0.2,start:"on-click"},
    replace_animation_effect:{presetId:"ooo-entrance-wipe"},remove_animation_effect:{},move_animation_effect:{animationIndex:1},
    add_comment:{text:"검증용 댓글",author:"Spellbook verification",initials:"SV",x:1000,y:1000},edit_comment:{commentIndex:0,text:"수정된 검증 댓글",author:null},delete_comment:{commentIndex:0},
    insert_image:{assetId:assets.image},replace_image:{assetId:assets.image},insert_media:{assetId:assets.media},replace_media:{assetId:assets.media},
  };
  if (["align","distribute","group"].includes(operation)) {
    command.elementIds = slide.elements.filter((element,i) => element.kind === "shape" && !element.onlyoffice.diagram).slice(0,operation === "distribute" ? 3 : 2).map(element => element.elementId);
    if (command.elementIds.length < (operation === "distribute" ? 3 : 2)) throw Error("case_authored_multiple_shapes_missing");
  }
  if (["set_paragraph_format","set_paragraph_list","replace_text_range"].includes(operation)) command.paragraphId = command.elementId + ":p0";
  if (operation === "replace_text_range") {
    const text = selected.drawing.paragraphs[0].runs.map(run => run.text).join("");
    changes[operation] = {startOffset:0,endOffset:Math.min(3,text.length),expectedText:text.slice(0,3),text:"검증"};
  }
  if (operation === "set_chart_data") {
    const series = selected.drawing.cachedSeries, rows = (series?.[0].val ?? series?.[0].yVal)?.count;
    if (!rows || !series.length) throw Error("case_authored_chart_cache_missing");
    changes[operation] = {data:Array.from({length:rows},(_,row) => series.map((_,column) => (row+1)*(column+2)+0.5))};
  }
  if (operation === "set_slide_layout") {
    const binding = slide.onlyoffice.layoutBinding, layouts = observation.masters[binding?.masterIndex]?.layouts;
    if (!layouts || layouts.length < 2) throw Error("case_alternative_layout_missing");
    changes[operation] = {masterIndex:binding.masterIndex,layout:(binding.layoutIndex+1)%layouts.length};
  }
  if (operation.includes("smartart")) {
    const diagram = selected.element.onlyoffice.diagram;
    const point = diagram.points.find(point => [0,1].includes(point.type) && (operation !== "delete_smartart_node" || !diagram.connections.some(edge => edge.type===0 && edge.src===point.id)));
    if (!point) throw Error("case_authored_smartart_node_missing");
    changes[operation] = {smartartNode:{expectedText:operation === "add_smartart_node" ? null : (point.text??"").replace(/\r?\n$/, ""), occurrence:0, text:operation === "delete_smartart_node" ? null : "검증된 노드"}};
  }
  if (operation === "set_connector") changes[operation] = {connector:{kind:"curve",start:{x:1000,y:1000},end:{x:6000,y:4000},startElementId:null,endElementId:null,startGluePoint:null,endGluePoint:null}};
  if (!changes[operation]) throw Error("case_operation_missing:" + operation);
  return Object.assign(command,changes[operation]);
}
