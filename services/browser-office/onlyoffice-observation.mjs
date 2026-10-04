/* SPDX-License-Identifier: MPL-2.0 */
// Read-only, version-pinned candidate observation shared by human and typed trials.
// Missing fields are explicit; this is not the complete production observation contract.
export async function observeOnlyOfficeCandidate(frame) {
  return frame.evaluate(() => {
    const wrap = (object) => {
      const existing = window.AscBuilder.GetApiDrawing(object);
      if (existing) return existing;
      if (
        object.getObjectType?.() === window.AscDFH?.historyitem_type_Cnx &&
        typeof object.getObjectType === "function"
      )
        return new window.AscBuilder.ApiShape(object);
      throw Error(
        "candidate_native_object_unavailable:" + object.getObjectType?.(),
      );
    };
    const drawingsFor = (slide) => slide.Slide.cSld.spTree.map(wrap);
    const readCommon = () => {
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
        type:
          x.getObjectType?.() === window.AscDFH?.historyitem_type_Cnx &&
          typeof x.getObjectType === "function"
            ? "connector"
            : x.isTable?.()
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
        title: x.getCNvProps?.()?.title ?? "",
        description: x.getCNvProps?.()?.descr ?? "",
        locks:
          typeof x.getLockValue === "function"
            ? Object.fromEntries(
                Object.entries(window.AscFormat.LOCKS_MASKS).map(
                  ([name, mask]) => [name, x.getLockValue(mask)],
                ),
              )
            : null,
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
    };
    const readExtended = () => {
      const unavailable = [];
      const read = (o, k, at, ...args) => {
        if (typeof o?.[k] !== "function") {
          unavailable.push(at + "." + k + ":missing");
          return null;
        }
        try {
          return o[k](...args);
        } catch (e) {
          unavailable.push(
            at + "." + k + ":" + String(e.message).slice(0, 100),
          );
          return null;
        }
      };
      const p = window.AscBuilder?.Slide?.Api?.GetPresentation?.();
      if (!p) return { unavailable: ["presentation-api"], state: null };
      const paragraphs = (doc, at) => {
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
            "GetLanguage",
          ])
            value[key] =
              read(pr, key, at + ".text") ??
              (key === "GetDoubleStrikeout" ? false : null);
          value.fonts = ["ascii", "eastAsia", "hAnsi", "cs"].map(
            (slot) => read(pr, "GetFontFamily", at + ".text", slot) ?? null,
          );
          // GetSpacing rounds to a whole twip and hides lost PPTX hundredths.
          value.characterSpacing =
            typeof pr.TextPr?.Spacing === "number"
              ? Math.round((pr.TextPr.Spacing * 7200) / 25.4) / 100
              : null;
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
        return doc.GetAllParagraphs().map((paragraph, index) => {
          const runs = [];
          const visit = (element) => {
            if (typeof element?.GetTextPr === "function") {
              const field =
                typeof element.Run?.FieldType === "string"
                  ? {
                      type: element.Run.FieldType,
                      guid: element.Run.Guid ?? null,
                    }
                  : null;
              const text = field
                ? `<field:${field.type}>`
                : (element.GetText?.({ Numbering: false }) ?? "");
              if (text && text !== "\r" && text !== "\n") {
                const style = properties(element.GetTextPr());
                const last = runs.at(-1);
                if (
                  last &&
                  !field &&
                  !last.field &&
                  JSON.stringify(last.style) === JSON.stringify(style)
                )
                  last.text += text;
                else runs.push({ text, style, ...(field ? { field } : {}) });
              }
            } else if (typeof element?.GetElementsCount === "function") {
              for (let i = 0; i < element.GetElementsCount(); i++)
                visit(element.GetElement(i));
            }
          };
          for (let i = 0; i < paragraph.GetElementsCount(); i++)
            visit(paragraph.GetElement(i));
          const alignment = read(
            paragraph.GetParaPr?.(),
            "GetJc",
            at + ".paragraph" + index,
          );
          return {
            alignment: alignment === "both" ? "justify" : (alignment ?? null),
            text: runs.some((run) => run.field)
              ? runs.map((run) => run.text).join("") + "\r\n"
              : paragraph.GetText({ Numbering: false }),
            runs,
          };
        });
      };
      const drawing = (d, at) => {
        if (!d) {
          unavailable.push(at + ":no-public-wrapper");
          return { type: "unavailable-public-wrapper" };
        }
        const type =
          d.Drawing?.getObjectType?.() ===
            window.AscDFH?.historyitem_type_Cnx &&
          typeof d.Drawing?.getObjectType === "function"
            ? "connector"
            : read(d, "GetClassType", at); // GetName synthesizes transient type/ID names when no name was authored.
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
          state.paragraphs = paragraphs(d.GetDocContent(), at);
          if (state.paragraphs.some((p) => p.runs.some((r) => r.field))) {
            state.hasDynamicFields = true;
            state.text = state.paragraphs.map((p) => p.text).join("");
          }
        }

        if (d.Table?.Content)
          state.tableCells = d.Table.Content.map((row) =>
            row.Content.map(
              (cell) => cell.Content?.GetText?.({ Numbering: false }) ?? null,
            ),
          );
        if (d.Table?.Content) {
          const bounds = d.Table.Get_PageBounds(0);
          const frame = d.Drawing.spPr?.xfrm;
          state.tableLayout = {
            computedHeight: Math.round((bounds.Bottom - bounds.Top) * 100),
            computedWidth: Math.round((bounds.Right - bounds.Left) * 100),
            columnWidths: d.Table.TableGrid.map((width) =>
              Math.round(width * 100),
            ),
            // Authored grid precision must survive summation before conversion
            // to the product's hundredth-millimetre outline.
            columnWidthsEmu: d.Table.TableGrid.map((width) =>
              Math.round(width * 36000),
            ),
            authoredFrame: Object.fromEntries(
              ["offX", "offY", "extX", "extY"].map((key) => [
                key,
                typeof frame?.[key] === "number"
                  ? Math.round(frame[key] * 100)
                  : null,
              ]),
            ),
            rowHeights: d.Table.Content.map((row, index) => ({
              value: Math.round(row.Get_Height().Value * 100),
              rule: row.Get_Height().HRule,
              computedHeight: Math.round(d.Table.RowsInfo[index].H[0] * 100),
            })),
          };
        }
        if (d.Table?.Content)
          state.tableParagraphs = d.Table.Content.map((row, r) =>
            row.Content.map((cell, c) =>
              paragraphs(
                new window.AscBuilder.ApiTableCell(cell).GetContent(),
                at + ".cell" + r + "/" + c,
              ),
            ),
          );
        if (type === "chart") {
          state.chartType = read(d, "GetChartType", at);
          const nativeSeries = d.Chart?.getAllSeries?.();
          if (!Array.isArray(nativeSeries))
            unavailable.push(at + ".native-series:missing");
          state.series =
            nativeSeries?.map((series, index) => {
              const owner =
                d.Chart?.chart?.plotArea?.charts?.find((chart) =>
                  chart.series?.includes(series),
                ) ?? series.parent;
              const chartType =
                typeof owner?.getChartType === "function"
                  ? owner.getChartType()
                  : owner?.getObjectType?.();
              if (chartType === undefined)
                unavailable.push(at + `.series${index}.native-type:missing`);
              return { chartType: chartType ?? null };
            }) ?? null;
          // Version-pinned SDK readback supplements the narrower public series getters.
          const cache = (c) =>
            c
              ? {
                  formula: c.f ?? null,
                  points: (
                    c.numCache?.pts ??
                    c.strCache?.pts ??
                    c.pts ??
                    []
                  ).map((p) => ({
                    idx: p.idx,
                    val:
                      typeof p.val === "string" &&
                      /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.test(
                        p.val,
                      )
                        ? Number(p.val)
                        : p.val,
                  })),
                }
              : null;
          state.cachedSeries =
            d.Chart?.getAllSeries?.()?.map((s) => ({
              idx: s.idx,
              val: cache(s.val?.numRef ?? s.val?.numLit),
              cat: cache(
                s.cat?.strRef ??
                  s.cat?.numRef ??
                  s.cat?.strLit ??
                  s.cat?.numLit,
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
            drawing(wrap(x), at + ".child" + i),
          );
        return state;
      };
      const slides = read(p, "GetAllSlides", "presentation");
      const model = window.Asc.editor.WordControl.m_oLogicDocument;
      const nativeColor = (c) =>
        c
          ? {
              type: c.color?.type ?? null,
              id: c.color?.id ?? null,
              rgb:
                typeof window.AscFormat?.CRGBColor === "function" &&
                c.color instanceof window.AscFormat.CRGBColor
                  ? {
                      R: c.color.RGBA.R,
                      G: c.color.RGBA.G,
                      B: c.color.RGBA.B,
                      A: c.color.RGBA.A,
                    }
                  : null,
              modifiers:
                c.Mods?.Mods?.map((m) => ({ name: m.name, val: m.val })) ?? [],
            }
          : null;
      const background = (source) =>
        source?.cSld?.Bg
          ? {
              reference: source.cSld.Bg.bgRef
                ? {
                    index: source.cSld.Bg.bgRef.idx,
                    color: nativeColor(source.cSld.Bg.bgRef.Color),
                  }
                : null,
              solid: nativeColor(source.cSld.Bg.bgPr?.Fill?.fill?.color),
              transparency: source.cSld.Bg.bgPr?.Fill?.transparent ?? null,
            }
          : null;
      const fontCollection = (f) =>
        f ? { latin: f.latin, ea: f.ea, cs: f.cs } : null;
      const masters = read(p, "GetAllSlideMasters", "presentation");
      if (!Array.isArray(model.Sections))
        unavailable.push("presentation.sections:missing");
      const design = masters?.map((wrapper, index) => {
        const master = wrapper.Master;
        if (!master) {
          unavailable.push(`master${index}:missing`);
          return null;
        }
        const theme = master.Theme,
          scheme = theme?.themeElements;
        return {
          name: master.cSld?.name ?? null,
          background: background(master),
          drawings: master.cSld.spTree.map((x, i) =>
            drawing(wrap(x), `master${index}.drawing${i}`),
          ),
          theme: theme
            ? {
                name: theme.name,
                colors: {
                  name: scheme?.clrScheme?.name ?? null,
                  values: scheme?.clrScheme?.colors.map(nativeColor) ?? [],
                },
                fonts: {
                  name: scheme?.fontScheme?.name ?? null,
                  major: fontCollection(scheme?.fontScheme?.majorFont),
                  minor: fontCollection(scheme?.fontScheme?.minorFont),
                },
              }
            : null,
          layouts: (master.sldLayoutLst ?? []).map((layout, i) => ({
            name: layout.cSld?.name ?? null,
            type: layout.type,
            background: background(layout),
            drawings: layout.cSld.spTree.map((x, j) =>
              drawing(wrap(x), `master${index}.layout${i}.drawing${j}`),
            ),
          })),
        };
      });
      return {
        unavailable,
        state: {
          masters: design,
          sections:
            model.Sections?.map((s) => ({
              name: s.name,
              startIndex: s.startIndex,
              guid: s.guid,
            })) ?? null,
          width: read(p, "GetWidth", "presentation") / 36000,
          height: read(p, "GetHeight", "presentation") / 36000,
          slides: slides?.map((s, i) => {
            const at = "slide" + i;
            const state = {
              visible: read(s, "GetVisible", at),
              name: s.Slide.cSld.name ?? "",
              background: background(s.Slide),
            };
            // Notes getters can create a missing body; inspect existing notes without writes.
            const noteBody = s.Slide?.notes?.getBodyShape?.();
            state.notes =
              noteBody?.getDocContent?.()?.GetText?.({ Numbering: false }) ??
              null;
            state.notesParagraphs = noteBody
              ? (drawing(
                  new window.AscBuilder.ApiShape(noteBody),
                  at + ".notes",
                ).paragraphs ?? null)
              : null;
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
            const timeline = s.Slide?.timing
              ? read(s, "GetTimeLine", at)
              : null;
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
            const objects = drawingsFor(s);
            state.drawings = objects?.map((d, j) =>
              drawing(d, at + ".drawing" + j),
            );
            return state;
          }),
        },
      };
    };
    const readNarrow = () => {
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
      // Normalize alpha's storage location: the writer emits a color modifier,
      // while the live model can hold UniFill.transparent. Other modifiers stay strict.
      const solidStyle = (fill) => {
        const c = fill?.fill?.color;
        if (!c) return null;
        const mods = c.Mods?.Mods ?? [];
        const alpha =
          fill.transparent != null
            ? (fill.transparent * 100) / 255
            : (mods.find((m) => m.name === "alpha")?.val ?? 100000) / 1000;
        return {
          type: fill.fill.type,
          colorType: c.color?.type ?? null,
          colorId: c.color?.id ?? null,
          modifiers: mods
            .filter((m) => m.name !== "alpha")
            .map((m) => ({ name: m.name, val: m.val })),
          opacity: Math.round(alpha * 1000) / 1000,
        };
      };
      return slides.map((s) => {
        const drawings = drawingsFor(s);
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
            fillStyle: solidStyle(d.Drawing.spPr?.Fill),
            line: d.Drawing.spPr?.ln
              ? {
                  color: color(d.Drawing.spPr.ln.Fill),
                  fillStyle: solidStyle(d.Drawing.spPr.ln.Fill),
                  width: d.Drawing.spPr.ln.w ?? null,
                  dash: d.Drawing.spPr.ln.prstDash ?? null,
                  cap: d.Drawing.spPr.ln.cap ?? null,
                  headEnd: d.Drawing.spPr.ln.headEnd
                    ? {
                        type: d.Drawing.spPr.ln.headEnd.type ?? null,
                        w: d.Drawing.spPr.ln.headEnd.w ?? null,
                        len: d.Drawing.spPr.ln.headEnd.len ?? null,
                      }
                    : null,
                  tailEnd: d.Drawing.spPr.ln.tailEnd
                    ? {
                        type: d.Drawing.spPr.ln.tailEnd.type ?? null,
                        w: d.Drawing.spPr.ln.tailEnd.w ?? null,
                        len: d.Drawing.spPr.ln.tailEnd.len ?? null,
                      }
                    : null,
                }
              : null,
          })),
          wordArt: drawings.map((d) => ({
            name: d.Drawing?.getOwnName?.() ?? null,
            preset: d.Drawing.txBody?.bodyPr?.prstTxWarp?.preset ?? null,
          })),
        };
      });
    };
    const common = readCommon(),
      extended = readExtended(),
      narrow = readNarrow();
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
  });
}
