/* SPDX-License-Identifier: MPL-2.0 */
// Bounded additions to the pinned SDK's existing run-effect and transition
// contracts. The converter already supports run property record 2 (effects)
// and p14:flash; no converter rebuild or alternate document model is used.
export function installOnlyOfficeNativeComplements() {
  const key = Symbol.for("spellbook.onlyoffice.nativeComplements/v1");
  const white = 0x5342;
  const bindWhiteFade = () => {
    const animation = window.Asc.editor?.WordControl?.DemonstrationManager?.Transition;
  if (animation && !animation[Symbol.for("spellbook.onlyoffice.whiteFade/v1")]) {
    const fade = animation._startFade;
    if (typeof fade !== "function") throw Error("onlyoffice_product_white_fade_unavailable");
    animation[Symbol.for("spellbook.onlyoffice.whiteFade/v1")] = true;
    animation._startFade = function() {
      if (this.Param !== white) return fade.call(this);
      const main = (this.DemonstrationObject?.Canvas ?? this.HtmlPage.m_oEditor.HtmlElement).getContext("2d");
      const overlay = this.DemonstrationObject?.Overlay?.getContext("2d") ?? this.HtmlPage.m_oOverlayApi.m_oContext;
      const part = this._getPart();
      const restores = [];
      for (const [ctx, base] of [[main, true], [overlay, false]]) {
        const fill = ctx.fillRect;
        ctx.fillRect = function(...args) {
          const color = this.fillStyle;
          const whitePhase = base ? part > .5 : animation.IsBackward ? part >= .5 : part <= .5;
          if (whitePhase && ["#000000", "rgb(0,0,0)", "rgb(0, 0, 0)"].includes(color)) this.fillStyle = "#ffffff";
          try { return fill.apply(this, args); } finally { this.fillStyle = color; }
        };
        restores.push(() => {ctx.fillRect = fill;});
      }
      this.Param = window.Asc.c_oAscSlideTransitionParams.Fade_Through_Black;
      try { return fade.call(this); }
      finally { this.Param = white; restores.forEach(restore => restore()); }
    };
  }
  };
  if (window[key]) { bindWhiteFade(); return; }
  const common = window.AscCommon, word = window.AscCommonWord;
  const f = window.AscFormat, d = window.AscDFH;
  if (!word?.CTextPr || !window.AscWord?.Run || !common?.CBinaryFileWriter ||
      !common.BinaryPPTYLoader || !window.Asc?.CAscSlideTransition)
    throw Error("onlyoffice_product_native_complements_unavailable");
  if (!Number.isSafeInteger(d?.historyitem_type_ParaRun) || !Number.isSafeInteger(d.historyitem_type_Presentation))
    throw Error("onlyoffice_product_native_complement_history_unavailable");
  const dimensions = d.historyitem_type_Presentation | 65003;
  const commentInitials = d.historyitem_type_Comment | 65004;
  if (!Number.isSafeInteger(d.historyitem_type_Comment) || d.changesFactory[commentInitials] || d.drawingsChangesMap[commentInitials])
    throw Error("onlyoffice_product_comment_initials_history_collision");
  d.historyitem_Spellbook_CommentInitials = commentInitials;
  d.changesFactory[commentInitials] = d.CChangesDrawingsString;
  d.drawingsChangesMap[commentInitials] = (comment, value) => {comment.spellbookInitials=value;};
  const duplicateNativeComment=common.CComment.prototype.createDuplicate;
  common.CComment.prototype.createDuplicate=function(...args) {
    const value=duplicateNativeComment.apply(this,args);
    if(this.spellbookInitials!=null){const change=new d.CChangesDrawingsString(value,commentInitials,undefined,this.spellbookInitials);common.History.Add(change);change.Redo();}
    return value;
  };
  // Initials are authored OOXML comment-author data. The SDK normally derives
  // them again from the name and merges authors with equal names. Retain the
  // imported value and distinguish equal names with different initials without
  // changing the user's visible author name or comment data.
  const slideNamespace=window.AscCommonSlide;
  const loadComments=slideNamespace.fLoadComments;
  slideNamespace.fLoadComments=function(object, authors) {
    const importedRecords=[...(object.writecomments??[])];
    const records=importedRecords.filter(record=>record.WriteParentAuthorId===0||record.WriteParentCommentId===0);
    const result=loadComments.call(this,object,authors);
    const comments=(object.slideComments??object.comments)?.comments??[];
    const authorList=Object.values(authors);
    for(const [index,comment] of comments.entries()) {
      const author=authorList.find(item=>String(item.Id)===String(records[index]?.WriteAuthorId));
      if(author)comment.spellbookInitials=author.Initials;
      const parent=records[index];
      const replies=importedRecords.filter(record=>record.WriteParentAuthorId===parent?.WriteAuthorId&&record.WriteParentCommentId===parent?.WriteCommentId);
      for(const [replyIndex,reply] of (comment.Data.m_aReplies??[]).entries()) {
        const owner=authorList.find(item=>String(item.Id)===String(replies[replyIndex]?.WriteAuthorId));
        if(owner)reply.spellbookInitials=owner.Initials;
      }
    }
    return result;
  };
  const duplicateComment=common.CCommentData.prototype.createDuplicate;
  common.CCommentData.prototype.createDuplicate=function(...args) {
    const value=duplicateComment.apply(this,args);
    if(Object.hasOwn(this,"spellbookInitials"))value.spellbookInitials=this.spellbookInitials;
    if(Object.hasOwn(this,"m_sUserData"))value.m_sUserData=this.m_sUserData;
    return value;
  };
  const calculateComments=slideNamespace.CPresentation.prototype.internalCalculateData;
  slideNamespace.CPresentation.prototype.internalCalculateData=function(comments, written, counts) {
    const aliases=new Map(), originals=new Map();
    const clone=(data, initials) => {
      const value=data.createDuplicate();
      const alias=JSON.stringify([data.m_sUserName,initials??null]);
      aliases.set(alias,{name:data.m_sUserName,initials});
      originals.set(value,data);value.m_sUserName=alias;
      value.m_aReplies=(data.m_aReplies??[]).map(reply=>clone(reply,reply.spellbookInitials));
      return value;
    };
    const prepared=comments.map(comment=>({Data:clone(comment.Data,comment.spellbookInitials),x:comment.x,y:comment.y}));
    const result=calculateComments.call(this,prepared,written,counts);
    for(const entry of written){entry.Data=originals.get(entry.Data)??entry.Data;entry.CalculateAdditionalData();}
    for(const [alias,owner] of aliases) {
      const author=this.CommentAuthors[alias];
      if(author){author.Name=owner.name;if(owner.initials!=null)author.Initials=owner.initials;else author.Calculate();}
    }
    return result;
  };
  if (d.changesFactory[dimensions] || d.drawingsChangesMap[dimensions] || d.drawingContentChanges[dimensions])
    throw Error("onlyoffice_product_native_complement_history_collision");
  d.historyitem_Spellbook_DimensionsOnly = dimensions;
  d.changesFactory[dimensions] = d.CChangesDrawingsObject;
  d.drawingsChangesMap[dimensions] = (model, size) => { model.sldSz = size; };
  const type = d.historyitem_type_ParaRun | 65002;
  if (d.changesFactory[type] || d.drawingsChangesMap[type] || d.drawingContentChanges[type])
    throw Error("onlyoffice_product_native_complement_history_collision");
  d.historyitem_Spellbook_RunEffects = type;
  d.drawingsConstructorsMap[type] = f.CEffectProperties;
  d.changesFactory[type] = d.CChangesDrawingsObjectNoId;
  d.drawingsChangesMap[type] = (run, value) => {
    run.Pr.spellbookEffects = value;
    run.RecalcInfo.TextPr = true;
    run.RecalcInfo.Measure = true;
    run.Paragraph?.Recalc_CompiledPr?.();
    run.Paragraph?.Refresh_RecalcData2?.(0, 0);
  };
  const copy = word.CTextPr.prototype.Copy, merge = word.CTextPr.prototype.Merge;
  word.CTextPr.prototype.Copy = function(...args) {
    const result = copy.apply(this, args);
    if (this.spellbookEffects) result.spellbookEffects = this.spellbookEffects.createDuplicate();
    return result;
  };
  word.CTextPr.prototype.Merge = function(value) {
    const result = merge.call(this, value);
    if (value && Object.hasOwn(value, "spellbookEffects"))
      this.spellbookEffects = value.spellbookEffects?.createDuplicate() ?? null;
    return result;
  };
  const writer = common.CBinaryFileWriter;
  common.CBinaryFileWriter = function(...args) {
    const instance = Reflect.construct(writer, args);
    const write = instance.WriteRunProperties;
    instance.WriteRunProperties = function(pr, ...rest) {
      const result = write.call(this, pr, ...rest);
      if (pr?.spellbookEffects?.EffectLst)
        this.WriteRecord1(2, pr.spellbookEffects.EffectLst, this.WriteEffectLst);
      else if (pr?.spellbookEffects?.EffectDag)
        this.WriteRecord1(2, pr.spellbookEffects.EffectDag, this.WriteEffectDag);
      return result;
    };
    return instance;
  };
  common.CBinaryFileWriter.prototype = writer.prototype;
  const loader = common.BinaryPPTYLoader;
  common.BinaryPPTYLoader = function(...args) {
    const instance = Reflect.construct(loader, args);
    const read = instance.ReadRunProperties;
    let active = false, depth = 0, captured = null;
    for (const name of ["ReadLn", "ReadUniFill", "ReadTextFontTypeface", "ReadHyperlink", "ReadUniColor", "ReadEffectProperties"]) {
      const method = instance[name];
      instance[name] = function(...args) {
        depth++;
        try { return method.apply(this, args); } finally { depth--; }
      };
    }
    instance.ReadRunProperties = function(...args) {
      const stream = this.stream, skip = stream.SkipRecord;
      const prior = {active, depth, captured};
      active = true; depth = 0; captured = null;
      stream.SkipRecord = function(...args) {
        if (active && depth === 0 && this.data[this.cur - 1] === 2) {
          captured = instance.ReadEffectProperties();
          return;
        }
        return skip.apply(this, args);
      };
      try {
        const pr = read.apply(this, args);
        if (captured) pr.spellbookEffects = captured;
        return pr;
      } finally {
        stream.SkipRecord = skip;
        ({active, depth, captured} = prior);
      }
    };
    return instance;
  };
  common.BinaryPPTYLoader.prototype = loader.prototype;
  // The singleton is used by the SDK's clipboard/native-content paths too.
  if (common.pptx_content_writer) common.pptx_content_writer.BinaryFileWriter = new common.CBinaryFileWriter();
  common.pptx_content_writer?.BinaryFileWriter.Init();
  const draw = window.AscWord.Run.prototype.Draw_Elements;
  window.AscWord.Run.prototype.Draw_Elements = function(state) {
    const shadow = this.Get_CompiledPr(false)?.spellbookEffects?.EffectLst?.outerShdw;
    const graphics = state.Graphics, ctx = graphics?.m_oContext;
    if (!shadow || !ctx) return draw.call(this, state);
    const previous = [ctx.shadowColor, ctx.shadowOffsetX, ctx.shadowOffsetY, ctx.shadowBlur];
    const color = shadow.color?.color?.RGBA;
    const alpha = (shadow.color?.Mods?.Mods?.find(m => m.name === "alpha")?.val ?? 100000) / 100000;
    const angle = (shadow.dir ?? 2700000) / 60000 * Math.PI / 180;
    const scale = graphics.m_oCoordTransform?.sx ?? 1;
    ctx.shadowColor = `rgba(${color?.R ?? 0},${color?.G ?? 0},${color?.B ?? 0},${alpha})`;
    ctx.shadowOffsetX = (shadow.dist ?? 38100) / 36000 * Math.cos(angle) * scale;
    ctx.shadowOffsetY = (shadow.dist ?? 38100) / 36000 * Math.sin(angle) * scale;
    ctx.shadowBlur = (shadow.blurRad ?? 0) / 36000 * scale;
    try { return draw.call(this, state); }
    finally { [ctx.shadowColor, ctx.shadowOffsetX, ctx.shadowOffsetY, ctx.shadowBlur] = previous; }
  };
  window.Asc.c_oAscSlideTransitionParams.Fade_ThroughWhite = white;
  const transition = window.Asc.CAscSlideTransition.prototype;
  const parse = transition.parseXmlParameters, xml = transition.fillXmlParams;
  transition.parseXmlParameters = function(tag, names, values) {
    if (tag === "p14:flash") {
      this.TransitionType = window.Asc.c_oAscSlideTransitionTypes.Fade;
      this.TransitionOption = white;
      return true;
    }
    return parse.call(this, tag, names, values);
  };
  transition.fillXmlParams = function(names, values) {
    if (this.TransitionType === window.Asc.c_oAscSlideTransitionTypes.Fade && this.TransitionOption === white)
      return "p14:flash";
    return xml.call(this, names, values);
  };
  bindWhiteFade();
  window[key] = {textRunEffects: true, whiteFade: true};
}

// Install this trusted hook before the editor frame loads the SDK. Deferring
// until the first presentation loader constructor ensures all SDK classes are
// registered, while still preceding the original document's first import.
export function bootstrapOnlyOfficeNativeComplements(install) {
  if (typeof install !== "function") throw Error("onlyoffice_product_bootstrap_invalid");
  const key = Symbol.for("spellbook.onlyoffice.nativeComplementsBootstrap/v1");
  if (window[key]) return;
  window[key] = true;
  const attach = (common) => {
    let loader = common.BinaryPPTYLoader;
    const descriptor = Object.getOwnPropertyDescriptor(common, "BinaryPPTYLoader");
    if (descriptor && !descriptor.configurable) throw Error("onlyoffice_product_bootstrap_unavailable");
    Object.defineProperty(common, "BinaryPPTYLoader", {
      configurable: true, enumerable: true,
      set(value) { loader = value; },
      get() {
        if (!loader) return loader;
        function BootstrapLoader(...args) {
          // The SDK also constructs loaders while registering its API classes.
          // Keep the hook through those early constructors; run/text/comment
          // classes must exist before installing, but still before file import.
          if (!window.AscCommonWord?.CTextPr || !window.AscWord?.Run ||
              !common.CBinaryFileWriter || !window.Asc?.CAscSlideTransition ||
              !window.AscCommonSlide?.CPresentation || !window.AscCommonSlide?.fLoadComments)
            return Reflect.construct(loader,args);
          Object.defineProperty(common, "BinaryPPTYLoader", {configurable:true, enumerable:true, writable:true, value:loader});
          install();
          return Reflect.construct(common.BinaryPPTYLoader, args);
        }
        BootstrapLoader.prototype = loader.prototype;
        return BootstrapLoader;
      },
    });
  };
  if (window.AscCommon) attach(window.AscCommon);
  else {
    let common;
    Object.defineProperty(window, "AscCommon", {
      configurable:true, enumerable:true,
      get() { return common; },
      set(value) {
        common = value;
        if (value) {
          Object.defineProperty(window, "AscCommon", {configurable:true, enumerable:true, writable:true, value});
          attach(value);
        }
      },
    });
  }
}
