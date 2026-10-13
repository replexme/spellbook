// Translates the AI's edit commands (contracts/native-edit-capabilities.json:
// 0-based slide indexes, element ids "slide/index[/child]", lengths in 1/100
// mm, colours as integers) into the engine's commands (1-based slides, shape
// ids, points, "RRGGBB"). A command or argument the engine cannot carry out
// is refused with a reason the AI can act on; nothing is approximated.

export const PER_PT = 2540 / 72; // 1/100 mm per point
export const toPt = (v) => (v == null ? v : v / PER_PT);
const mmToPt = (v) => (v == null ? v : (v * 72) / 25.4);
const hex = (v) => (v == null ? null : Math.round(v).toString(16).padStart(6, "0").toUpperCase());
const fraction = (v) => (v == null ? null : v / 100);

export class Refused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}
const refuse = (detail) => {
  throw new Refused("unsupported_by_engine", detail);
};
const need = (ok, detail) => {
  if (!ok) throw new Refused("invalid_command", detail);
};
const given = (v) => v !== null && v !== undefined;

const ANIMATION_EFFECTS = {
  appear: "appear", disappear: "disappear", fade: "fade", "fade-in": "fade", "fade-out": "fade",
  fly: "fly", "fly-in": "fly", "fly-out": "fly", wipe: "wipe", zoom: "zoom", spin: "spin",
  split: "split", wheel: "wheel", "random-bars": "randomBars", float: "float", "float-in": "float",
  "float-out": "float", ascend: "float", descend: "float", "grow-and-shrink": "growShrink",
  "grow-shrink": "growShrink", teeter: "teeter", transparency: "transparency",
};
const ANIMATION_CLASSES = { entrance: "entrance", emphasis: "emphasis", exit: "exit" };

/** Effect and class of an animation preset id ("entrance-wipe"). */
export function animationPreset(presetId) {
  const m = /^(entrance|emphasis|exit)-(.+)$/.exec(presetId ?? "");
  need(m, `presetId ${JSON.stringify(presetId)} is not an animation preset id like "entrance-fade"`);
  const effect = ANIMATION_EFFECTS[m[2]];
  if (!effect) refuse(`animation preset ${presetId}; available: ${Object.keys(ANIMATION_EFFECTS).map((e) => `<class>-${e}`).join(", ")}`);
  return { effect, class: ANIMATION_CLASSES[m[1]] };
}

const START = { "on-click": "onClick", "with-previous": "withPrevious", "after-previous": "afterPrevious" };

const TRANSITIONS = {
  none: { transition: "none" },
  fade: { transition: "fade" },
  "fade-through-black": { transition: "fade" },
  "fade-through-white": { transition: "fade" },
  "wipe-left-to-right": { transition: "wipe", direction: "r" },
  "wipe-top-to-bottom": { transition: "wipe", direction: "d" },
  "push-from-left": { transition: "push", direction: "r" },
  "push-from-top": { transition: "push", direction: "d" },
  "push-from-right": { transition: "push", direction: "l" },
  "push-from-bottom": { transition: "push", direction: "u" },
};

const THEME_SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const NUMBER_SCHEMES = { ".": "arabicPeriod", ")": "arabicParenR" };

/**
 * Engine commands for one AI command. `doc` resolves targets:
 * `doc.element(elementId)` -> {slide, shapeId, element, slideEntry},
 * `doc.slide(slideIndex)` -> slide entry, `doc.slideCount`,
 * `doc.masters`, `doc.nextShapeId(slide)`, `doc.asset(assetId)` ->
 * {base64, mediaType}, `doc.now()` -> ISO time.
 */
export function engineCommands(c, doc) {
  const el = () => doc.element(c.elementId);
  const at = () => {
    const t = el();
    return { slide: t.slide, shapeId: t.shapeId };
  };
  const slide = () => {
    need(Number.isSafeInteger(c.slideIndex) && c.slideIndex >= 0 && c.slideIndex < doc.slideCount, `slideIndex ${c.slideIndex} outside 0..${doc.slideCount - 1}`);
    return c.slideIndex + 1;
  };
  const layoutName = () => {
    if (!given(c.layout)) return null;
    const master = doc.masters[c.masterIndex ?? 0];
    const layout = master?.layouts?.[c.layout];
    need(layout, `layout ${c.layout} of master ${c.masterIndex ?? 0} not in the observation`);
    return layout.name;
  };
  const named = (cmds, slideNo) => {
    if (!given(c.name)) return cmds;
    return [...cmds, { op: "set_shape_name", slide: slideNo, shapeId: doc.nextShapeId(slideNo), name: c.name }];
  };
  const box = () => ({ x: toPt(c.x), y: toPt(c.y), width: toPt(c.width), height: toPt(c.height) });
  const paragraphOf = (t) => {
    if (!given(c.paragraphId)) return null;
    const m = /:p(\d+)$/.exec(c.paragraphId);
    need(m && c.paragraphId.startsWith(c.elementId + ":"), `paragraphId ${c.paragraphId} does not belong to ${c.elementId}`);
    const p = Number(m[1]);
    need(p < (t.element.paragraphs?.length ?? 0), `paragraph ${p} not in ${c.elementId}`);
    return p;
  };
  const shadow = (enabled) => {
    const dx = toPt(c.shadowOffsetX ?? 0), dy = toPt(c.shadowOffsetY ?? 0);
    return {
      enabled,
      color: hex(c.color),
      opacity: fraction(c.opacity),
      blur: toPt(c.shadowBlur),
      distance: given(c.shadowOffsetX) || given(c.shadowOffsetY) ? Math.hypot(dx, dy) : null,
      angle: given(c.shadowOffsetX) || given(c.shadowOffsetY) ? ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 : null,
    };
  };
  const animation = (t) => {
    const m = /^anim-(\d+)$/.exec(c.animationId ?? "");
    need(m, `animationId ${c.animationId} is not an observed animation id`);
    const index = Number(m[1]);
    need(t.slideEntry.animations?.some((a) => a.index === index), `animation ${c.animationId} not on slide ${t.slide - 1}`);
    return index;
  };
  const smartartIndex = (t) => {
    const n = c.smartartNode;
    need(n && given(n.expectedText), "smartartNode needs the observed expectedText");
    const matches = (t.element.smartart ?? []).filter((x) => x.text === n.expectedText);
    const node = matches[n.occurrence ?? 0];
    need(node, `SmartArt node ${JSON.stringify(n.expectedText)} (occurrence ${n.occurrence}) not found`);
    return node.index;
  };
  const tableOf = (t) => {
    need(t.element.table, `${c.elementId} is not a table`);
    return t.element.table;
  };
  const end = (point, elementId, site) => {
    if (given(elementId)) return { shapeId: doc.element(elementId).shapeId, site: given(site) && site >= 0 ? site : null, x: null, y: null };
    return { shapeId: null, site: null, x: toPt(point.x), y: toPt(point.y) };
  };
  const CONNECTOR = { standard: "bentConnector3", curve: "curvedConnector3", straight: "straightConnector1" };

  switch (c.op) {
    case "insert_slide": {
      const s = slide() + 1;
      const cmds = [{ op: "insert_slide", slide: s, layout: layoutName() }];
      if (given(c.name)) cmds.push({ op: "rename_slide", slide: s, name: c.name });
      return cmds;
    }
    case "duplicate_slide":
      return [{ op: "duplicate_slide", slide: slide() }];
    case "delete_slide":
      need(doc.slideCount > 1, "the only slide cannot be deleted");
      return [{ op: "delete_slide", slide: slide() }];
    case "move_slide":
      need(Number.isSafeInteger(c.targetSlideIndex) && c.targetSlideIndex >= 0 && c.targetSlideIndex < doc.slideCount, `targetSlideIndex ${c.targetSlideIndex} outside 0..${doc.slideCount - 1}`);
      return [{ op: "move_slide", slide: slide(), to: c.targetSlideIndex + 1 }];
    case "set_sections": {
      need(Array.isArray(c.sections), "sections must be a list");
      const list = c.sections;
      need(!list.length || list[0].startSlideIndex === 0, "the first section must start at slide 0");
      return [{
        op: "set_sections",
        slide: 1,
        sections: list.map((s, i) => {
          const endAt = i + 1 < list.length ? list[i + 1].startSlideIndex : doc.slideCount;
          need(endAt > s.startSlideIndex, "startSlideIndex values must increase");
          return { name: s.name, slides: Array.from({ length: endAt - s.startSlideIndex }, (_, k) => s.startSlideIndex + k + 1) };
        }),
      }];
    }
    case "set_slide_size":
      if (c.scaleContent) refuse("set_slide_size with scaleContent: content is not scaled; resize or move shapes separately");
      return [{ op: "set_slide_size", slide: 1, width: toPt(c.width), height: toPt(c.height) }];
    case "set_master_theme": {
      const th = c.theme;
      need(th && Array.isArray(th.colors) && th.colors.length === 12, "theme needs 12 colors");
      return [{
        op: "set_master_theme",
        slide: 1,
        colors: Object.fromEntries(THEME_SLOTS.map((slot, i) => [slot, hex(th.colors[i])])),
        headingFont: th.majorLatin,
        bodyFont: th.minorLatin,
        headingEastAsianFont: th.majorAsian,
        bodyEastAsianFont: th.minorAsian,
      }];
    }
    case "set_speaker_notes":
      return [{ op: "set_speaker_notes", slide: slide(), paragraphs: String(c.text ?? "").split("\n") }];
    case "add_text_box": {
      const s = slide();
      return named([{ op: "add_text_box", slide: s, ...box(), paragraphs: String(c.text ?? "").split("\n"), size: null }], s);
    }
    case "add_shape": {
      const s = slide();
      const preset = { rectangle: "rect", ellipse: "ellipse", line: "line" }[c.geometry ?? "rectangle"];
      need(preset, `geometry ${c.geometry}`);
      const color = hex(c.color);
      return named([{ op: "add_shape", slide: s, preset, ...box(), fill: preset === "line" ? null : color, line: preset === "line" ? color : null, paragraphs: null }], s);
    }
    case "add_connector": {
      const s = slide();
      return named([{
        op: "add_connector",
        slide: s,
        preset: CONNECTOR[c.connectorKind ?? "straight"],
        start: { shapeId: null, site: null, x: toPt(c.x), y: toPt(c.y) },
        end: { shapeId: null, site: null, x: toPt(c.x + c.width), y: toPt(c.y + c.height) },
        color: hex(c.color),
        width: null,
        arrow: null,
      }], s);
    }
    case "add_freeform": {
      const s = slide();
      need(Array.isArray(c.points) && c.points.length >= 2, "points needs at least two points");
      const color = hex(c.color);
      return named([{
        op: "add_freeform",
        slide: s,
        points: c.points.map((p) => [toPt(c.x + p.x), toPt(c.y + p.y)]),
        closed: !!c.closed,
        fill: c.closed ? color : null,
        line: color,
      }], s);
    }
    case "add_table": {
      const s = slide();
      need(Array.isArray(c.cells) && c.cells.length > 0, "cells must list the rows");
      const cols = Math.max(...c.cells.map((r) => r.length));
      need(cols > 0, "cells rows must not be empty");
      return named([{ op: "add_table", slide: s, ...box(), rows: c.cells.length, cols, cells: c.cells.map((r) => [...r, ...Array(cols - r.length).fill("")]) }], s);
    }
    case "align":
    case "distribute":
    case "group":
    case "set_reading_order": {
      need(Array.isArray(c.elementIds) && c.elementIds.length >= (c.op === "set_reading_order" ? 1 : 2), "elementIds needs the shapes");
      const targets = c.elementIds.map((id) => doc.element(id));
      need(targets.every((t) => t.slide === targets[0].slide), "elementIds must be on one slide");
      const ids = targets.map((t) => t.shapeId);
      if (c.op === "align") {
        need(["left", "center", "right", "top", "middle", "bottom"].includes(c.alignment), `alignment ${c.alignment}`);
        return [{ op: "align", slide: targets[0].slide, shapeIds: ids, to: c.alignment, relativeTo: "selection" }];
      }
      if (c.op === "distribute") return [{ op: "distribute", slide: targets[0].slide, shapeIds: ids, direction: c.axis }];
      if (c.op === "group") return [{ op: "group", slide: targets[0].slide, shapeIds: ids }];
      need(targets.every((t) => !t.elementId.split("/")[2]), "set_reading_order takes top-level shapes");
      return [{ op: "set_reading_order", slide: targets[0].slide, order: ids }];
    }
    case "set_connector": {
      const k = c.connector;
      need(k, "connector is required");
      return [{
        op: "set_connector",
        ...at(),
        start: end(k.start, k.startElementId, k.startGluePoint),
        end: end(k.end, k.endElementId, k.endGluePoint),
        preset: CONNECTOR[k.kind] ?? null,
      }];
    }
    case "replace_text":
      need(typeof c.text === "string", "text is required");
      return [{ op: "replace_text", ...at(), paragraphs: c.text.split("\n") }];
    case "move":
      return [{ op: "move", ...at(), x: toPt(c.x), y: toPt(c.y) }];
    case "resize":
      need(c.width > 0 && c.height > 0, "width and height must be positive");
      return [{ op: "resize", ...at(), width: toPt(c.width), height: toPt(c.height) }];
    case "font_size":
      return [{ op: "font_size", ...at(), paragraph: null, size: c.size }];
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
      need(typeof c[c.op] === "boolean", `${c.op} must be true or false`);
      return [{ op: c.op, ...at(), paragraph: null, value: c[c.op] }];
    case "text_shadow":
      return [{ op: "text_shadow", ...at(), paragraph: null, ...shadow(c.shadow !== false) }];
    case "font_family":
      return [{ op: "font_family", ...at(), paragraph: null, family: c.family }];
    case "font_color":
      return [{ op: "font_color", ...at(), paragraph: null, color: hex(c.color) }];
    case "fill_color":
      return [{ op: "fill_color", ...at(), color: hex(c.color) }];
    case "set_shape_fill": {
      const f = c.shapeFill;
      need(f, "shapeFill is required");
      if (f.type === "none") return [{ op: "set_shape_fill", ...at(), fill: "none", color: null, colors: null, angle: null }];
      if (f.type === "solid") {
        const cmds = [{ op: "set_shape_fill", ...at(), fill: "solid", color: hex(f.color ?? 0), colors: null, angle: null }];
        if (given(f.opacity)) cmds.push({ op: "fill_opacity", ...at(), opacity: f.opacity / 100 });
        return cmds;
      }
      return refuse(`shapeFill type ${f.type} from the document catalog; use none or solid`);
    }
    case "set_shape_effects": {
      const e = c.shapeEffects;
      need(e, "shapeEffects is required");
      return [{
        op: "set_shape_effects",
        ...at(),
        glow: given(e.glowRadius) ? { radius: toPt(e.glowRadius), color: hex(e.glowColor), opacity: fraction(e.glowOpacity) } : null,
        softEdge: given(e.softEdgeRadius) ? toPt(e.softEdgeRadius) : null,
        reflection: null,
      }];
    }
    case "line_color":
      return [{ op: "line_color", ...at(), color: hex(c.color) }];
    case "line_width":
      return [{ op: "line_width", ...at(), width: mmToPt(c.size) }];
    case "fill_opacity":
      return [{ op: "fill_opacity", ...at(), opacity: c.opacity / 100 }];
    case "line_opacity":
      return [{ op: "line_opacity", ...at(), opacity: c.opacity / 100 }];
    case "text_autofit":
      return [{ op: "text_autofit", ...at(), mode: c.autofit ? "shrink" : "none" }];
    case "rotate":
      return [{ op: "rotate", ...at(), degrees: c.degrees }];
    case "z_order":
      need(["front", "forward", "backward", "back"].includes(c.position), `position ${c.position}`);
      return [{ op: "z_order", ...at(), action: c.position }];
    case "paragraph_alignment":
      need(["left", "center", "right", "justify"].includes(c.alignment), `alignment ${c.alignment}`);
      return [{ op: "paragraph_alignment", ...at(), paragraph: null, align: c.alignment }];
    case "flip": {
      const t = el();
      if (c.axis === "horizontal") return [{ op: "flip", slide: t.slide, shapeId: t.shapeId, horizontal: !t.element.flipH, vertical: null }];
      if (c.axis === "vertical") return [{ op: "flip", slide: t.slide, shapeId: t.shapeId, horizontal: null, vertical: !t.element.flipV }];
      return need(false, `axis ${c.axis}`);
    }
    case "ungroup":
      return [{ op: "ungroup", ...at() }];
    case "duplicate_element": {
      const t = el();
      const f = t.element.frame ?? [0, 0, 0, 0];
      const dx = given(c.x) ? toPt(c.x) - f[0] : 12;
      const dy = given(c.y) ? toPt(c.y) - f[1] : 12;
      const cmds = [{ op: "duplicate_element", slide: t.slide, shapeId: t.shapeId, dx, dy }];
      if (given(c.name)) cmds.push({ op: "set_shape_name", slide: t.slide, shapeId: doc.nextShapeId(t.slide), name: c.name });
      return cmds;
    }
    case "delete_element":
      return [{ op: "delete_element", ...at() }];
    case "set_chart_data": {
      const t = el();
      const chart = t.element.chart;
      need(chart, `${c.elementId} is not a chart`);
      need(Array.isArray(c.data) && c.data.length, "data is the value table: one row per category, one column per series");
      const columns = Math.max(...c.data.map((r) => r.length));
      const categories = c.rowDescriptions ?? chart.categories;
      need(Array.isArray(categories) && categories.length === c.data.length, "rowDescriptions must name each data row");
      const names = c.columnDescriptions ?? chart.series.map((s) => s.name);
      need(Array.isArray(names) && names.length === columns, "columnDescriptions must name each data column");
      return [{
        op: "set_chart_data",
        slide: t.slide,
        shapeId: t.shapeId,
        categories: categories.map(String),
        series: names.map((name, j) => ({ name: String(name), values: c.data.map((r) => r[j] ?? null) })),
      }];
    }
    case "set_chart_type": {
      const type = { column: "column", line: "line", pie: "pie" }[c.chartType];
      if (!type) refuse(`chart type ${c.chartType}; available: column, line, pie (bar and doughnut through the engine are not exposed here)`);
      return [{ op: "set_chart_type", ...at(), type, grouping: null }];
    }
    case "set_chart_format": {
      const f = c.chartFormat;
      need(f, "chartFormat is required");
      for (const k of ["categoryAxisVisible", "valueAxisVisible", "showCategoryNames", "showSeriesNames"])
        if (given(f[k])) refuse(`chartFormat.${k}`);
      let legend = null;
      if (f.legendVisible === false) legend = "none";
      else if (given(f.legendPosition)) legend = { left: "l", right: "r", top: "t", bottom: "b" }[f.legendPosition];
      else if (f.legendVisible === true) legend = "r";
      return [{
        op: "set_chart_format",
        ...at(),
        title: f.title,
        legend,
        dataLabels: f.showValues,
        gridlines: null,
        colors: f.seriesColors ? f.seriesColors.map(hex) : null,
      }];
    }
    case "set_slide_layout": {
      const name = layoutName();
      need(name, "layout is required");
      return [{ op: "set_slide_layout", slide: slide(), layout: name }];
    }
    case "set_background":
      return [{ op: "set_background", slide: slide(), color: hex(c.color) }];
    case "set_table_cell": {
      const t = el();
      const tb = tableOf(t);
      need(c.row >= 0 && c.row < tb.rows && c.column >= 0 && c.column < tb.cols, `cell ${c.row},${c.column} outside ${tb.rows}x${tb.cols}`);
      return [{ op: "set_table_cell", slide: t.slide, shapeId: t.shapeId, row: c.row, col: c.column, paragraphs: String(c.text ?? "").split("\n") }];
    }
    case "rename_slide":
      return [{ op: "rename_slide", slide: slide(), name: c.name }];
    case "set_slide_hidden":
      return [{ op: "set_slide_hidden", slide: slide(), hidden: !!c.hidden }];
    case "set_alt_text":
      if (c.decorative) refuse("decorative flag; set an empty description instead");
      return [{ op: "set_alt_text", ...at(), text: c.description ?? c.title ?? "" }];
    case "set_shape_name":
      return [{ op: "set_shape_name", ...at(), name: c.name }];
    case "set_text_box": {
      const cmds = [];
      const margins = [c.marginLeft, c.marginTop, c.marginRight, c.marginBottom];
      if (margins.some(given)) need(margins.every(given), "set_text_box needs all four margins when one is given");
      if (margins.some(given) || given(c.wordWrap))
        cmds.push({ op: "set_text_box", ...at(), insets: margins.some(given) ? margins.map(toPt) : null, anchor: null, wrap: given(c.wordWrap) ? c.wordWrap : null, direction: null });
      if (c.autoGrowWidth) refuse("autoGrowWidth; set wordWrap false instead");
      if (given(c.autoGrowHeight)) cmds.push({ op: "text_autofit", ...at(), mode: c.autoGrowHeight ? "resize" : "none" });
      need(cmds.length, "set_text_box changes nothing");
      return cmds;
    }
    case "set_character_spacing":
      return [{ op: "set_character_spacing", ...at(), paragraph: null, spacing: c.spacing }];
    case "set_text_language":
      return [{ op: "set_text_language", ...at(), paragraph: null, language: c.languageTag }];
    case "set_text_case": {
      const kase = { uppercase: "upper", lowercase: "lower", title: "title" }[c.textCase];
      if (!kase) refuse(`textCase ${c.textCase}; available: uppercase, lowercase, title`);
      return [{ op: "set_text_case", ...at(), paragraph: null, case: kase }];
    }
    case "set_script_position":
      return [{ op: "set_script_position", ...at(), paragraph: null, position: c.script, offset: null }];
    case "set_shape_shadow":
      return [{ op: "set_shape_shadow", ...at(), ...shadow(c.shadow !== false) }];
    case "set_object_lock": {
      if (given(c.printable)) refuse("printable (PPTX has no per-shape print flag)");
      const locks = {};
      if (given(c.lockPosition)) locks.noMove = c.lockPosition;
      if (given(c.lockSize)) locks.noResize = c.lockSize;
      need(Object.keys(locks).length, "set_object_lock changes nothing");
      return [{ op: "set_object_lock", ...at(), locks }];
    }
    case "set_line_style": {
      const s = c.lineStyle;
      need(s, "lineStyle is required");
      return [{ op: "set_line_style", ...at(), dash: s.dash ?? null, head: s.startArrow?.type ?? null, tail: s.endArrow?.type ?? null }];
    }
    case "set_object_interaction": {
      const action = { none: "none", external_url: "url", internal_slide: "slide", next_slide: "next", previous_slide: "previous", first_slide: "first", last_slide: "last" }[c.interaction];
      if (!action) refuse(`interaction ${c.interaction}`);
      return [{ op: "set_object_interaction", ...at(), action, url: action === "url" ? c.url : null, targetSlide: action === "slide" ? c.targetSlideIndex + 1 : null }];
    }
    case "replace_text_range": {
      const t = el();
      const p = paragraphOf(t);
      need(p !== null, "paragraphId is required");
      const detail = doc.paragraphDetail(c.elementId, p);
      const local = c.startOffset - detail.startOffset, localEnd = c.endOffset - detail.startOffset;
      need(Number.isSafeInteger(local) && local >= 0 && localEnd >= local && localEnd <= detail.text.length, "offsets outside the paragraph");
      need(detail.text.slice(local, localEnd) === (c.expectedText ?? ""), "expectedText does not match the paragraph; observe again");
      need(!String(c.text).includes("\n"), "text must not contain a newline");
      const chars = (s) => Array.from(s).length;
      return [{ op: "replace_text_range", slide: t.slide, shapeId: t.shapeId, paragraph: p, start: chars(detail.text.slice(0, local)), end: chars(detail.text.slice(0, localEnd)), text: c.text }];
    }
    case "insert_table_rows":
    case "delete_table_rows":
    case "insert_table_columns":
    case "delete_table_columns": {
      const t = el();
      tableOf(t);
      const rows = c.op.endsWith("rows");
      return [{ op: c.op, slide: t.slide, shapeId: t.shapeId, ...(rows ? { row: c.index } : { col: c.index }), count: c.count ?? 1 }];
    }
    case "merge_table_cells": {
      const t = el();
      tableOf(t);
      need(c.endRow >= c.startRow && c.endColumn >= c.startColumn, "end before start");
      return [{ op: "merge_table_cells", slide: t.slide, shapeId: t.shapeId, row: c.startRow, col: c.startColumn, rows: c.endRow - c.startRow + 1, cols: c.endColumn - c.startColumn + 1 }];
    }
    case "split_table_cell": {
      const t = el();
      tableOf(t);
      if ((c.rows ?? 1) > 1 || (c.columns ?? 1) > 1) refuse("splitting a cell into new rows or columns; only merged cells can be split back");
      return [{ op: "split_table_cell", slide: t.slide, shapeId: t.shapeId, row: c.row, col: c.column }];
    }
    case "set_table_row_height":
      return [{ op: "set_table_row_height", ...at(), row: c.index, height: toPt(c.height) }];
    case "set_table_column_width":
      return [{ op: "set_table_column_width", ...at(), col: c.index, width: toPt(c.width) }];
    case "set_table_cell_format": {
      const f = c.tableCellFormat;
      need(f, "tableCellFormat is required");
      for (const k of ["fillOpacity", "fontColor", "fontSize", "fontFamily", "bold", "underline", "strikethrough", "textShadow", "characterSpacing", "paragraphAlignment"])
        if (given(f[k])) refuse(`tableCellFormat.${k} (cell fill, borders and margins are available)`);
      const borders = [f.borderTop, f.borderRight, f.borderBottom, f.borderLeft].filter(given);
      const same = (k) => borders.every((b) => b[k] === borders[0][k]);
      if (borders.length && (borders.length < 4 || !same("color") || !same("width"))) refuse("borders that differ by side (all four sides take one colour and width)");
      const margins = [f.marginLeft, f.marginTop, f.marginRight, f.marginBottom];
      if (margins.some(given)) need(margins.every(given), "give all four cell margins");
      return [{
        op: "set_table_cell_format",
        ...at(),
        row: c.row,
        col: c.column,
        fill: given(f.fillColor) ? hex(f.fillColor) : null,
        borderColor: borders.length ? hex(borders[0].color) : null,
        borderWidth: borders.length && given(borders[0].width) ? mmToPt(borders[0].width / 100) : null,
        anchor: null,
        margins: margins.some(given) ? margins.map(toPt) : null,
      }];
    }
    case "set_slide_transition": {
      const tr = TRANSITIONS[c.transitionEffect];
      need(tr, `transitionEffect ${c.transitionEffect}`);
      const d = c.transitionDuration;
      return [{ op: "set_slide_transition", slide: slide(), transition: tr.transition, speed: given(d) ? (d <= 0.5 ? "fast" : d <= 1 ? "med" : "slow") : null, direction: tr.direction ?? null }];
    }
    case "set_slide_metadata":
      return refuse("slide footer, number, date and auto-advance settings");
    case "set_animation_timing": {
      const t = el();
      return [{ op: "set_animation_timing", slide: t.slide, index: animation(t), start: START[c.start] ?? null, duration: c.duration, delay: c.delay }];
    }
    case "add_animation_effect": {
      const t = el();
      const p = animationPreset(c.presetId);
      return [{ op: "add_animation_effect", slide: t.slide, shapeId: t.shapeId, effect: p.effect, class: p.class, start: START[c.start] ?? null, duration: c.duration, delay: c.delay, index: null }];
    }
    case "remove_animation_effect": {
      const t = el();
      return [{ op: "remove_animation_effect", slide: t.slide, index: animation(t) }];
    }
    case "replace_animation_effect": {
      const t = el();
      const p = animationPreset(c.presetId);
      return [{ op: "replace_animation_effect", slide: t.slide, index: animation(t), effect: p.effect, class: p.class }];
    }
    case "move_animation_effect": {
      const t = el();
      return [{ op: "move_animation_effect", slide: t.slide, index: animation(t), to: c.animationIndex }];
    }
    case "crop_image": {
      // The contract's "rectangle" is DrawingML's "rect"; omitted fractions keep the framing.
      const geometry = c.geometry === "ellipse" ? "ellipse" : c.geometry === "rectangle" ? "rect" : null;
      need(c.geometry == null || geometry, `crop geometry ${c.geometry}`);
      return [{ op: "crop_image", ...at(), left: c.left ?? null, top: c.top ?? null, right: c.right ?? null, bottom: c.bottom ?? null, geometry }];
    }
    case "insert_image": {
      const s = slide();
      const a = doc.asset(c.assetId);
      return named([{ op: "insert_image", slide: s, data: a.base64, x: toPt(c.x), y: toPt(c.y), width: toPt(c.width), height: toPt(c.height), altText: null }], s);
    }
    case "replace_image":
      return [{ op: "replace_image", ...at(), data: doc.asset(c.assetId).base64 }];
    case "insert_media": {
      const s = slide();
      const a = doc.asset(c.assetId);
      return named([{ op: "insert_media", slide: s, data: a.base64, poster: null, x: toPt(c.x), y: toPt(c.y), width: toPt(c.width), height: toPt(c.height) }], s);
    }
    case "replace_media":
      return [{ op: "replace_media", ...at(), data: doc.asset(c.assetId).base64, poster: null }];
    case "set_smartart_node": {
      const t = el();
      return [{ op: "set_smartart_node", slide: t.slide, shapeId: t.shapeId, index: smartartIndex(t), text: c.smartartNode.text ?? "" }];
    }
    case "add_smartart_node": {
      const t = el();
      need(t.element.smartart, `${c.elementId} is not SmartArt`);
      return [{ op: "add_smartart_node", slide: t.slide, shapeId: t.shapeId, parent: null, position: null, text: c.smartartNode?.text ?? "" }];
    }
    case "delete_smartart_node": {
      const t = el();
      return [{ op: "delete_smartart_node", slide: t.slide, shapeId: t.shapeId, index: smartartIndex(t) }];
    }
    case "set_fontwork":
      return [{ op: "set_fontwork", ...at(), preset: c.fontwork?.preset ?? "none", adjust: null }];
    case "set_paragraph_format": {
      const t = el();
      const f = c.paragraphFormat;
      need(f, "paragraphFormat is required");
      if (given(f.rightMargin)) refuse("paragraph right indent");
      if (given(f.direction) && f.direction !== "left-to-right") refuse(`direction ${f.direction}`);
      return [{
        op: "set_paragraph_format",
        slide: t.slide,
        shapeId: t.shapeId,
        paragraph: paragraphOf(t),
        indentLeft: toPt(f.leftMargin),
        indentFirst: toPt(f.firstLineIndent),
        spaceBefore: toPt(f.topMargin),
        spaceAfter: toPt(f.bottomMargin),
        lineSpacing: null,
        lineSpacingPoints: null,
      }];
    }
    case "set_paragraph_list": {
      const t = el();
      const l = c.paragraphList;
      need(l, "paragraphList is required");
      if (l.level) refuse("list levels other than 0");
      if (l.prefix) refuse("number prefixes");
      const scheme = l.type === "number" ? NUMBER_SCHEMES[l.suffix || "."] : null;
      if (l.type === "number" && !scheme) refuse(`number suffix ${JSON.stringify(l.suffix)}; available "." and ")"`);
      return [{ op: "set_paragraph_list", slide: t.slide, shapeId: t.shapeId, paragraph: paragraphOf(t), kind: l.type, bullet: l.type === "bullet" ? l.bulletCharacter ?? "•" : null, scheme, start: l.type === "number" ? l.startWith : null }];
    }
    case "add_comment":
      return [{ op: "add_comment", slide: slide(), text: c.text, author: c.author ?? null, x: toPt(c.x), y: toPt(c.y), created: doc.now() }];
    case "edit_comment":
    case "delete_comment": {
      const s = slide();
      const comment = doc.slide(c.slideIndex).comments?.[c.commentIndex];
      need(comment, `comment ${c.commentIndex} not on slide ${c.slideIndex}`);
      return c.op === "edit_comment"
        ? [{ op: "edit_comment", slide: s, commentId: comment.id, text: c.text }]
        : [{ op: "delete_comment", slide: s, commentId: comment.id }];
    }
    default:
      return refuse(`operation ${c.op}`);
  }
}

/** Operations this host carries out (for the observation's engine facts). */
export const SUPPORTED_OPERATIONS = [
  "insert_slide", "duplicate_slide", "delete_slide", "move_slide", "set_sections", "set_slide_size",
  "set_master_theme", "set_speaker_notes", "add_text_box", "add_shape", "add_connector", "add_freeform",
  "add_table", "align", "distribute", "set_connector", "group", "replace_text", "move", "resize",
  "font_size", "bold", "italic", "underline", "strikethrough", "text_shadow", "font_family", "font_color",
  "fill_color", "set_shape_fill", "set_shape_effects", "line_color", "line_width", "fill_opacity",
  "line_opacity", "text_autofit", "rotate", "z_order", "paragraph_alignment", "flip", "ungroup",
  "duplicate_element", "delete_element", "set_chart_data", "set_chart_type", "set_chart_format",
  "set_slide_layout", "set_background", "set_table_cell", "rename_slide", "set_slide_hidden",
  "set_alt_text", "set_shape_name", "set_text_box", "set_character_spacing", "set_text_language",
  "set_text_case", "set_script_position", "set_shape_shadow", "set_object_lock", "set_line_style",
  "set_object_interaction", "replace_text_range", "insert_table_rows", "delete_table_rows",
  "insert_table_columns", "delete_table_columns", "merge_table_cells", "split_table_cell",
  "set_table_row_height", "set_table_column_width", "set_table_cell_format", "set_slide_transition",
  "set_animation_timing", "add_animation_effect", "remove_animation_effect", "replace_animation_effect",
  "move_animation_effect", "crop_image", "insert_image", "replace_image", "insert_media", "replace_media",
  "set_smartart_node", "add_smartart_node", "delete_smartart_node", "set_fontwork", "set_reading_order",
  "set_paragraph_format", "set_paragraph_list", "add_comment", "edit_comment", "delete_comment",
];
