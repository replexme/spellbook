/* SPDX-License-Identifier: MPL-2.0 */
// Read-only, version-pinned candidate observation shared by human and typed trials.
// Missing fields are explicit; this is not the complete production observation contract.
async function snapshot(frame) {
  return frame.evaluate(() => {
    const m = window.Asc.editor.WordControl.m_oLogicDocument;
    const shape = (x) => ({
      text: x.isTable?.()
        ? null
        : (x.getDocContent?.()?.GetText?.({ Numbering: false }) ??
          x.getContentText?.() ??
          null),
      x: x.x,
      y: x.y,
      w: x.extX,
      h: x.extY,
      type: x.isTable?.()
        ? "table"
        : x.isChart?.()
          ? "chart"
          : x.isImage?.()
            ? "image"
            : x.spTree
              ? "group"
              : "shape",
      children: x.spTree?.map(shape) ?? [],
      hidden: x.getCNvProps?.()?.isHidden ?? null,
      ownName: x.getOwnName?.() ?? null,
      textWarp: x.getBodyPr?.()?.prstTxWarp?.preset ?? null,
      crop: x.blipFill?.srcRect
        ? {
            l: x.blipFill.srcRect.l,
            t: x.blipFill.srcRect.t,
            r: x.blipFill.srcRect.r,
            b: x.blipFill.srcRect.b,
          }
        : null,
      diagram: x.getDataModelFromData
        ? {
            points: x
              .getDataModelFromData()
              .ptLst.list.filter((p) => [0, 1, 2].includes(p.type))
              .map((p) => ({
                id: p.modelId,
                type: p.type,
                text: p.t?.content?.GetText?.({ Numbering: false }) ?? null,
              })),
            connections: x
              .getDataModelFromData()
              .cxnLst.list.filter((c) => c.type === 0)
              .map((c) => ({
                src: c.srcId,
                dest: c.destId,
                type: c.type,
                srcOrd: c.srcOrd,
                destOrd: c.destOrd,
              })),
          }
        : null,
    });
    return {
      slides: m.Slides.map((s) => ({ shapes: s.cSld.spTree.map(shape) })),
    };
  });
}
async function extendedFeatures(frame) {
  return frame.evaluate(() => {
    const unavailable = [];
    const read = (o, k, at, ...args) => {
      if (typeof o?.[k] !== "function") {
        unavailable.push(at + "." + k + ":missing");
        return null;
      }
      try {
        return o[k](...args);
      } catch (e) {
        unavailable.push(at + "." + k + ":" + String(e.message).slice(0, 100));
        return null;
      }
    };
    const p = window.AscBuilder?.Slide?.Api?.GetPresentation?.();
    if (!p) return { unavailable: ["presentation-api"], state: null };
    const drawing = (d, at) => {
      if (!d) {
        unavailable.push(at + ":no-public-wrapper");
        return { type: "unavailable-public-wrapper" };
      }
      const type = read(d, "GetClassType", at); // GetName synthesizes transient type/ID names when no name was authored.
      const state = { type, name: d.Drawing?.getOwnName?.() ?? null };
      for (const k of ["GetPosX", "GetPosY", "GetWidth", "GetHeight"]) {
        const v = read(d, k, at);
        state[k] = typeof v === "number" ? v / 36000 : v;
      }
      for (const k of ["GetRotation", "GetFlipH", "GetFlipV"])
        state[k] = read(d, k, at);
      // Public GetContent creates a missing text body; use the existing content only.
      const content = type === "table" ? null : d.Drawing?.getDocContent?.();
      state.text = content?.GetText?.({ Numbering: false }) ?? null;
      // Observe actual character properties; plain text alone cannot distinguish
      // a successful formatting edit from a setter that silently did nothing.
      if (content) {
        const properties = (pr) => {
          const value = {};
          for (const key of [
            "GetBold",
            "GetItalic",
            "GetUnderline",
            "GetStrikeout",
            "GetFontSize",
            "GetVertAlign",
            "GetSpacing",
            "GetCaps",
            "GetSmallCaps",
            "GetDoubleStrikeout",
          ])
            value[key] =
              read(pr, key, at + ".text") ??
              (key === "GetDoubleStrikeout" ? false : null);
          value.fonts = ["ascii", "eastAsia", "hAnsi", "cs"].map(
            (slot) => read(pr, "GetFontFamily", at + ".text", slot) ?? null,
          );
          const nativeColor = pr.TextPr?.Unifill?.fill?.color?.color;
          const color = read(pr, "GetColor", at + ".text");
          // The pinned Word builder's GetColor reads CRGBColor.r/g/b, but
          // the drawing model stores RGBA.R/G/B. Those missing fields are
          // coerced to black. Read the authored RGB from the native fill.
          value.color =
            nativeColor instanceof window.AscFormat.CRGBColor
              ? {
                  rgb: {
                    r: nativeColor.RGBA.R,
                    g: nativeColor.RGBA.G,
                    b: nativeColor.RGBA.B,
                  },
                  theme: false,
                  auto: false,
                }
              : color
                ? {
                    rgb: color.GetRGB(),
                    theme: color.IsThemeColor(),
                    auto: color.IsAutoColor(),
                  }
                : null;
          return value;
        };
        state.paragraphs = d
          .GetDocContent()
          .GetAllParagraphs()
          .map((paragraph) => {
            const runs = [];
            const visit = (element) => {
              if (typeof element?.GetTextPr === "function") {
                const text = element.GetText?.({ Numbering: false }) ?? "";
                if (text && text !== "\r" && text !== "\n") {
                  const style = properties(element.GetTextPr());
                  const last = runs.at(-1);
                  if (
                    last &&
                    JSON.stringify(last.style) === JSON.stringify(style)
                  )
                    last.text += text;
                  else runs.push({ text, style });
                }
              } else if (typeof element?.GetElementsCount === "function") {
                for (let i = 0; i < element.GetElementsCount(); i++)
                  visit(element.GetElement(i));
              }
            };
            for (let i = 0; i < paragraph.GetElementsCount(); i++)
              visit(paragraph.GetElement(i));
            return { text: paragraph.GetText({ Numbering: false }), runs };
          });
      }

      if (d.Table?.Content)
        state.tableCells = d.Table.Content.map((row) =>
          row.Content.map(
            (cell) => cell.Content?.GetText?.({ Numbering: false }) ?? null,
          ),
        );
      if (type === "chart") {
        state.chartType = read(d, "GetChartType", at);
        const series = read(d, "GetAllSeries", at);
        if (Array.isArray(series))
          state.series = series.map((s, i) => ({
            chartType: read(s, "GetChartType", at + ".series" + i),
          }));
        // Version-pinned SDK readback supplements the narrower public series getters.
        const cache = (c) =>
          c
            ? {
                formula: c.f ?? null,
                points: (c.numCache?.pts ?? c.strCache?.pts ?? c.pts ?? []).map(
                  (p) => ({
                    idx: p.idx,
                    val:
                      typeof p.val === "string" &&
                      /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(
                        p.val,
                      )
                        ? Number(p.val)
                        : p.val,
                  }),
                ),
              }
            : null;
        state.cachedSeries =
          d.Chart?.getAllSeries?.()?.map((s) => ({
            idx: s.idx,
            val: cache(s.val?.numRef ?? s.val?.numLit),
            cat: cache(
              s.cat?.strRef ?? s.cat?.numRef ?? s.cat?.strLit ?? s.cat?.numLit,
            ),
            xVal: cache(s.xVal?.numRef ?? s.xVal?.numLit),
            yVal: cache(s.yVal?.numRef ?? s.yVal?.numLit),
          })) ?? null;
      }
      const hyperlink = read(d, "GetHyperlink", at);
      if (hyperlink) {
        state.hyperlink = {
          link: hyperlink.ParaHyperlink?.GetValue?.() ?? null,
          tooltip: read(hyperlink, "GetScreenTipText", at + ".hyperlink"),
        };
      }
      if (d.Drawing?.spTree)
        state.groupChildren = d.Drawing.spTree.map((x, i) =>
          drawing(window.AscBuilder.GetApiDrawing(x), at + ".child" + i),
        );
      return state;
    };
    const slides = read(p, "GetAllSlides", "presentation");
    return {
      unavailable,
      state: {
        width: read(p, "GetWidth", "presentation") / 36000,
        height: read(p, "GetHeight", "presentation") / 36000,
        slides: slides?.map((s, i) => {
          const at = "slide" + i;
          const state = { visible: read(s, "GetVisible", at) };
          // Notes getters can create a missing body; inspect existing notes without writes.
          const noteBody = s.Slide?.notes?.getBodyShape?.();
          state.notes =
            noteBody?.getDocContent?.()?.GetText?.({ Numbering: false }) ??
            null;
          const transition = read(s, "GetSlideShowTransition", at);
          if (transition) {
            state.transition = {};
            for (const k of [
              "GetEntryEffect",
              "GetDuration",
              "GetSpeed",
              "GetAdvanceOnClick",
              "GetAdvanceOnTime",
              "GetAdvanceTime",
            ])
              state.transition[k] = read(transition, k, at + ".transition");
          }
          // GetTimeLine creates timing when absent; avoid mutating during observation.
          const timeline = s.Slide?.timing ? read(s, "GetTimeLine", at) : null;
          if (timeline) {
            const effects = read(timeline, "GetAllEffects", at + ".timeline");
            if (Array.isArray(effects))
              state.effects = effects.map((e, j) => {
                const v = {};
                for (const k of [
                  "GetEffectType",
                  "GetDuration",
                  "GetDelay",
                  "GetRepeatCount",
                  "GetTriggerType",
                ])
                  v[k] = read(e, k, at + ".effect" + j);
                return v;
              });
          }
          const objects = read(s, "GetAllDrawings", at);
          state.drawings = objects?.map((d, j) =>
            drawing(d, at + ".drawing" + j),
          );
          return state;
        }),
      },
    };
  });
}

export async function observeOnlyOfficeCandidate(frame) {
  const common = await snapshot(frame),
    extended = await extendedFeatures(frame);
  const narrow = await frame.evaluate(() => {
    const api = window.AscBuilder.Slide.Api,
      p = api.GetPresentation();
    const slides = p.GetAllSlides();
    if (!Array.isArray(slides) || !slides.length)
      throw new Error("candidate_slide_observation_unavailable");
    const color = (f) => {
      const native = f?.fill?.color;
      const c =
        typeof window.AscFormat?.CRGBColor === "function" &&
        native?.color instanceof window.AscFormat.CRGBColor
          ? native.color.RGBA
          : native?.RGBA;
      return c ? { R: c.R, G: c.G, B: c.B, A: c.A } : null;
    };
    return slides.map((s) => {
      const drawings = s.GetAllDrawings();
      return {
        layout: s.Slide.Layout
          ? {
              name: s.Slide.Layout.cSld?.name ?? null,
              type: s.Slide.Layout.type,
            }
          : null,
        background: color(s.Slide.cSld.Bg?.bgPr?.Fill),
        table: drawings
          .filter((d) => d.GetClassType() === "table")
          .map((d) => ({
            rows: d.Table.Content.length,
            cells: d.Table.Content.map((r) =>
              r.Content.map((c) => ({
                text: c.Content.GetText({ Numbering: false }),
                fill: color(c.Pr.Shd?.Unifill),
              })),
            ),
          })),
        drawingStyle: drawings.map((d) => ({
          name: d.Drawing?.getOwnName?.() ?? null,
          fill: color(d.Drawing.spPr?.Fill),
          line: d.Drawing.spPr?.ln
            ? {
                color: color(d.Drawing.spPr.ln.Fill),
                width: d.Drawing.spPr.ln.w ?? null,
                dash: d.Drawing.spPr.ln.prstDash ?? null,
                cap: d.Drawing.spPr.ln.cap ?? null,
              }
            : null,
        })),
        wordArt: drawings.map((d) => ({
          name: d.Drawing?.getOwnName?.() ?? null,
          preset: d.Drawing.txBody?.bodyPr?.prstTxWarp?.preset ?? null,
        })),
      };
    });
  });
  if (
    !extended.state?.slides ||
    extended.state.slides.length !== common.slides.length
  )
    throw new Error("candidate_observation_scope_mismatch");
  return {
    common,
    extended: extended.state,
    narrow,
    unavailable: extended.unavailable,
  };
}
