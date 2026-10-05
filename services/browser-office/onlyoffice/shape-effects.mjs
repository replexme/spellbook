/* SPDX-License-Identifier: MPL-2.0 */
// The pinned SDK serializes these effects but omits their canvas rendering.
// Reuse its native geometry, text, crop and shadow transforms; modify only
// transient drawing surfaces, never the document or its authored history.
export function installOnlyOfficeShapeEffects() {
  const key=Symbol.for("spellbook.onlyoffice.shapeEffects/v1");
  if(window[key])return;
  const f=window.AscFormat;
  if(typeof f?.CShape?.prototype?.draw!=="function")return;
  const surfaces=new WeakMap(),active=new WeakSet(),skipShadow=new WeakSet();
  let sequence=0;
  const fields=["fillStyle","strokeStyle","lineWidth","lineCap","lineJoin","miterLimit","font","textAlign","textBaseline","direction","globalAlpha","globalCompositeOperation","imageSmoothingEnabled"];
  const svg=(name,attrs={})=>{
    const node=document.createElementNS("http://www.w3.org/2000/svg",name);
    for(const [name,value] of Object.entries(attrs))node.setAttribute(name,String(value));
    return node;
  };
  const surface=ctx=>{
    let value=surfaces.get(ctx);
    if(!value){
      const canvas=document.createElement("canvas"),shadow=document.createElement("canvas");
      const root=svg("svg",{width:0,height:0,"aria-hidden":"true"});
      root.style.cssText="position:absolute;width:0;height:0;pointer-events:none";
      const filter=svg("filter",{id:"spellbook-shape-effects-"+(++sequence),filterUnits:"userSpaceOnUse",primitiveUnits:"userSpaceOnUse",x:0,y:0,"color-interpolation-filters":"sRGB"});
      const defs=svg("defs");defs.appendChild(filter);root.appendChild(defs);document.documentElement.appendChild(root);
      value={canvas,shadow,filter};surfaces.set(ctx,value);
    }
    for(const canvas of [value.canvas,value.shadow]){
      if(canvas.width!==ctx.canvas.width||canvas.height!==ctx.canvas.height){canvas.width=ctx.canvas.width;canvas.height=ctx.canvas.height;}
    }
    value.filter.setAttribute("width",ctx.canvas.width);value.filter.setAttribute("height",ctx.canvas.height);
    return value;
  };
  const capture=(graphics,canvas,draw)=>{
    const ctx=graphics.m_oContext,target=canvas.getContext("2d");
    target.setTransform(1,0,0,1,0,0);target.clearRect(0,0,canvas.width,canvas.height);target.setTransform(ctx.getTransform());
    for(const field of fields)target[field]=ctx[field];
    target.filter="none";target.shadowColor="transparent";target.shadowBlur=0;target.shadowOffsetX=0;target.shadowOffsetY=0;
    graphics.m_oContext=target;
    try{return {result:draw(),target};}finally{graphics.m_oContext=ctx;}
  };
  const compose=(ctx,canvas,filter)=>{
    ctx.save();
    try{ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation="source-over";ctx.filter=filter;ctx.drawImage(canvas,0,0);}
    finally{ctx.restore();}
  };
  const originalShadow=f.CGraphicObjectBase?.prototype?.drawShdw;
  if(typeof originalShadow==="function")f.CGraphicObjectBase.prototype.drawShdw=function(...args){
    if(skipShadow.has(this))return;
    return originalShadow.apply(this,args);
  };
  for(const constructor of new Set([f.CShape,f.CImageShape,f.CChartSpace,f.CGraphicFrame,f.CGroupShape].filter(Boolean))){
    const prototype=constructor.prototype,native=prototype.draw;
    if(typeof native!=="function")continue;
    prototype.draw=function(graphics,...args){
      const list=this.spPr?.effectProps?.EffectLst,ctx=graphics?.m_oContext;
      const glow=list?.glow,soft=list?.softEdge?.rad??0,shadow=list?.outerShdw;
      const hasEffects=glow?.rad>0||soft>0||shadow?.blurRad>0;
      if(this.isShadowSp||active.has(this)||!hasEffects||graphics?.animationDrawer)
        return native.call(this,graphics,...args);
      // Native bounds must include the halo so partial redraws and animation
      // textures cannot crop it. Bounds are transient and use millimetres.
      if(graphics?.isBoundsChecker?.()&&graphics.Bounds&&typeof f.CBoundsController==="function"){
        const previous=graphics.Bounds,local=new f.CBoundsController();
        graphics.Bounds=local;
        let result;
        try{result=native.call(this,graphics,...args);}finally{graphics.Bounds=previous;}
        if(local.min_x<=local.max_x&&local.min_y<=local.max_y){
          const margin=Math.max((glow?.rad??0)*1.75,(shadow?.blurRad??0)*1.5)/36000;
          previous.min_x=Math.min(previous.min_x,local.min_x-margin);
          previous.min_y=Math.min(previous.min_y,local.min_y-margin);
          previous.max_x=Math.max(previous.max_x,local.max_x+margin);
          previous.max_y=Math.max(previous.max_y,local.max_y+margin);
        }
        return result;
      }
      if(!ctx?.canvas||!("filter" in ctx)||graphics?.isBoundsChecker?.())
        return native.call(this,graphics,...args);
      if(this.checkNeedRecalculate?.() || graphics.updatedRect && this.bounds && !graphics.updatedRect.isIntersectOther(this.bounds))
        return native.call(this,graphics,...args);
      const buffers=surface(ctx),scale=Math.abs(graphics.m_oCoordTransform?.sx??1);
      const rad=value=>Math.max(0,value??0)/36000*scale;
      active.add(this);
      let captured,clipped=false;
      try{
        const clip=this.getClipRect?.();
        if(clip&&typeof graphics.SaveGrState==="function"&&typeof graphics.AddClipRect==="function"&&typeof graphics.RestoreGrState==="function"){
          graphics.SaveGrState();clipped=true;graphics.AddClipRect(clip.x,clip.y,clip.w,clip.h);
        }
        // The native shadow already owns alignment, skew, rotation, scale and
        // theme color. Capture that exact drawing; only its missing blur is new.
        if(typeof this.drawShdw==="function"){
          if(shadow?.blurRad>0){
            capture(graphics,buffers.shadow,()=>this.drawShdw(graphics));
            compose(ctx,buffers.shadow,"blur("+rad(shadow.blurRad)/2+"px)");
          }else this.drawShdw(graphics);
        }
        skipShadow.add(this);
        try{captured=capture(graphics,buffers.canvas,()=>native.call(this,graphics,...args));}
        finally{skipShadow.delete(this);}
        const filter=buffers.filter;filter.replaceChildren();
        const append=(name,attrs)=>{const node=svg(name,attrs);filter.appendChild(node);return node;};
        let body="SourceGraphic";
        if(soft>0){
          // Erode before blurring: a soft edge fades inward and does not expand
          // the original shape or turn the outside background into a blur.
          const coverage=append("feComponentTransfer",{in:"SourceAlpha",result:"edge-coverage"});
          coverage.appendChild(svg("feFuncA",{type:"linear",slope:255,intercept:0}));
          append("feMorphology",{in:"edge-coverage",operator:"erode",radius:rad(soft)/2,result:"edge-inner"});
          append("feGaussianBlur",{in:"edge-inner",stdDeviation:rad(soft)/2,result:"edge-alpha"});
          append("feComposite",{in:"SourceGraphic",in2:"edge-alpha",operator:"in",result:"soft-body"});
          body="soft-body";
        }
        if(glow?.rad>0){
          const parents=this.getParentObjects?.()??{},color=glow.color?.createDuplicate?.();
          color?.Calculate?.(parents.theme,parents.slide,parents.layout,parents.master,{R:0,G:0,B:0,A:255},this.getColorMap?.());
          const rgba=color?.RGBA??glow.color?.color?.RGBA??{R:0,G:0,B:0,A:255};
          const alpha=color?.RGBA?.A!=null?rgba.A/255:(glow.color?.Mods?.Mods?.find(mod=>mod.name==="alpha")?.val??100000)/100000;
          append("feMorphology",{in:"SourceAlpha",operator:"dilate",radius:rad(glow.rad)/4,result:"glow-wide"});
          append("feGaussianBlur",{in:"glow-wide",stdDeviation:rad(glow.rad)/2,result:"glow-alpha"});
          append("feFlood",{"flood-color":`rgb(${rgba.R},${rgba.G},${rgba.B})`,"flood-opacity":alpha,result:"glow-color"});
          append("feComposite",{in:"glow-color",in2:"glow-alpha",operator:"in",result:"glow-painted"});
          const merge=append("feMerge",{});merge.appendChild(svg("feMergeNode",{in:"glow-painted"}));merge.appendChild(svg("feMergeNode",{in:body}));
        }
        compose(ctx,buffers.canvas,filter.childNodes.length?"url(#"+filter.getAttribute("id")+")":"none");
        for(const field of fields)ctx[field]=captured.target[field];
        ctx.setTransform(captured.target.getTransform());return captured.result;
      }finally{skipShadow.delete(this);active.delete(this);graphics.m_oContext=ctx;if(clipped)graphics.RestoreGrState();}
    };
  }
  window[key]=true;
}
