/* SPDX-License-Identifier: MPL-2.0 */
// The observation the AI runtime reads (contracts/native-turn-runtime.cjs),
// built from the engine's description of the deck (present_pptx::describe).
// Permission checks, text details and the layout audit follow the browser
// document host of the Spellbook public core (MPL-2.0),
// adapted to this engine's description.

import { PER_PT } from "./commands.mjs";

const hmm = (pt) => Math.round(pt * PER_PT);

export const canonical = (value) => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, order(value[key])]),
    );
  return value;
}

const KIND = (s) => {
  if (s.kind === "grpSp") return "group";
  if (s.kind === "cxnSp") return "connector";
  if (s.kind === "pic") return s.media ? s.media : "image";
  if (s.kind === "graphicFrame") return s.table ? "table" : s.chart ? "chart" : s.smartart ? "smartart" : "object";
  if (s.placeholder) return "placeholder";
  return s.paragraphs ? "text" : "shape";
};

/**
 * The deck as the AI sees it, and a lookup from element ids to the engine's
 * shapes. `describe` is the engine's JSON description.
 */
export function project(describe) {
  const lookup = new Map();
  const animationsBySlide = [];
  const slides = describe.slides.map((slide, slideIndex) => {
    const byShape = new Map();
    const element = (s, id, slideEntry) => {
      const [x, y, w, h] = s.frame ?? [0, 0, 0, 0];
      const e = {
        elementId: id,
        kind: KIND(s),
        objectName: s.name,
        x: hmm(x),
        y: hmm(y),
        width: hmm(w),
        height: hmm(h),
      };
      if (s.rotation) e.rotation = s.rotation;
      if (s.flipH) e.flipH = true;
      if (s.flipV) e.flipV = true;
      if (s.placeholder) e.placeholder = s.placeholder;
      if (s.description) e.altText = s.description;
      if (s.preset) e.geometry = s.preset;
      if (s.paragraphs) e.text = s.paragraphs.join("\n").replaceAll("\u000b", "\n");
      if (s.table) e.table = { rows: s.table.rows, columns: s.table.cols, cells: s.table.cells };
      if (s.chart)
        e.chart = {
          chartType: s.chart.type === "bar" && s.chart.barDirection !== "bar" ? "column" : s.chart.type,
          rowCount: s.chart.categories.length,
          columnCount: s.chart.series.length,
          rowDescriptions: s.chart.categories,
          columnDescriptions: s.chart.series.map((x) => x.name),
          data: s.chart.categories.map((_, i) => s.chart.series.map((x) => x.values[i] ?? null)),
          ...(s.chart.title ? { title: s.chart.title } : {}),
        };
      if (s.smartart) {
        const seen = new Map();
        e.smartartNodes = s.smartart.map((n) => {
          const occurrence = seen.get(n.text) ?? 0;
          seen.set(n.text, occurrence + 1);
          return { text: n.text, occurrence, depth: n.depth };
        });
      }
      lookup.set(id, { elementId: id, slide: slideIndex + 1, shapeId: s.id, element: s, slideEntry });
      byShape.set(s.id, id);
      if (s.children) e.elements = s.children.map((c, i) => element(c, `${id}/${i}`, slideEntry));
      return e;
    };
    const entry = slide;
    const elements = slide.shapes.map((s, i) => element(s, `${slideIndex}/${i}`, entry));
    const animations = (slide.animations ?? []).map((a) => ({
      animationId: `anim-${a.index}`,
      animationIndex: a.index,
      elementId: a.shapeId != null ? byShape.get(a.shapeId) ?? null : null,
      presetId: a.effect ? `${a.class}-${a.effect}` : null,
      class: a.class,
      start: { onClick: "on-click", withPrevious: "with-previous", afterPrevious: "after-previous" }[a.start] ?? a.start,
      duration: a.duration,
      delay: a.delay,
    }));
    animationsBySlide.push(animations);
    const out = {
      slideIndex,
      elements,
      ...(slide.name ? { name: slide.name } : {}),
      ...(slide.hidden ? { hidden: true } : {}),
      ...(slide.layout ? { masterIndex: slide.layout.master, layout: slide.layout.index, layoutName: slide.layout.name } : {}),
      ...(slide.notes?.some((p) => p) ? { notes: slide.notes.join("\n") } : {}),
      ...(slide.comments?.length ? { comments: slide.comments.map((c, i) => ({ commentIndex: i, author: c.author, text: c.text })) } : {}),
      ...(animations.length ? { animations } : {}),
    };
    return out;
  });
  const state = {
    slides,
    masters: describe.masters.map((m) => ({ masterIndex: m.index, name: m.name, layouts: m.layouts.map((l) => ({ layout: l.index, name: l.name })) })),
    sections: describe.sections.map((s) => ({ name: s.name, startSlideIndex: (s.slides[0] ?? 1) - 1 })),
    width: hmm(describe.width ?? 720),
    height: hmm(describe.height ?? 540),
  };
  return { state, lookup };
}

export function assertServiceObservation(observation, request) {
  let expected;
  try {
    expected = JSON.parse(request.expectedSlides);
  } catch {
    throw Error("stale_service_observation");
  }
  if (request.expectedRevision !== observation.revision || canonical(expected) !== canonical(observation.slides)) throw Error("stale_service_observation");
}

export function assertWorkspacePermission(commands, permission, operations) {
  if (!permission || !["document", "slides", "selection"].includes(permission.mode)) throw Error("outside_edit_permission");
  for (const command of commands) {
    const target = operations[command.op]?.target;
    if (!target) throw Error("unsupported_operation");
    if (permission.mode === "document") continue;
    if (["document", "master"].includes(target)) throw Error("outside_edit_permission");
    const ids = Array.isArray(command.elementIds) ? command.elementIds : typeof command.elementId === "string" ? [command.elementId] : [];
    const slides = ids.length ? ids.map((id) => Number(id.split("/")[0])) : [command.slideIndex];
    if (command.op === "move_slide") {
      const start = Math.min(command.slideIndex, command.targetSlideIndex),
        end = Math.max(command.slideIndex, command.targetSlideIndex);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start > 10000) throw Error("outside_edit_permission");
      for (let i = start; i <= end; i++) slides.push(i);
    }
    if (permission.mode === "slides" && slides.every((slide) => Number.isSafeInteger(slide) && permission.slideIndexes?.includes(slide))) continue;
    if (permission.mode === "selection" && ids.length && ids.every((id) => permission.elementIds?.includes(id))) continue;
    throw Error("outside_edit_permission");
  }
}

/** The element `elementId` of an observation. */
export function elementOf(observation, elementId) {
  if (typeof elementId !== "string" || !/^\d+(?:\/\d+)+$/.test(elementId)) throw Error("invalid_element_id");
  const [slide, ...indexes] = elementId.split("/").map(Number);
  let element = observation.slides[slide];
  for (const index of indexes) element = element?.elements?.[index];
  if (!element || element.elementId !== elementId) throw Error("element_missing");
  return element;
}

/**
 * Paragraph-level text of the text elements of slide `slideIndex`: element
 * offsets count every paragraph's characters plus one newline between
 * paragraphs, as replace_text_range addresses them.
 */
export function textDetails(observation, lookup, slideIndex) {
  const slide = observation.slides[slideIndex];
  if (!slide) throw Error("invalid_detail_slide");
  const elements = [];
  const visit = (list) => {
    for (const e of list) {
      const shape = lookup.get(e.elementId)?.element;
      if (shape?.paragraphs) {
        let offset = 0;
        const paragraphs = shape.paragraphs.map((raw, paragraphIndex) => {
          const text = raw.replaceAll("\u000b", "\n");
          const startOffset = offset;
          offset += text.length + (paragraphIndex + 1 < shape.paragraphs.length ? 1 : 0);
          return { paragraphId: `${e.elementId}:p${paragraphIndex}`, paragraphIndex, startOffset, endOffset: startOffset + text.length, text };
        });
        elements.push({ elementId: e.elementId, text: e.text, paragraphs });
      }
      if (e.elements) visit(e.elements);
    }
  };
  visit(slide.elements);
  return { slideIndex, elements };
}

export function layoutAudit(observation, previous = null) {
  const issues = [];
  for (const slide of observation.slides) {
    const elements = slide.elements;
    for (const element of elements) {
      const identity = { slideIndex: slide.slideIndex, elementId: element.elementId };
      if (element.width <= 0 || element.height <= 0) {
        if (element.kind !== "connector") issues.push({ code: "invalid_size", ...identity });
        continue;
      }
      if (element.x < 0 || element.y < 0 || element.x + element.width > observation.width || element.y + element.height > observation.height)
        issues.push({ code: "out_of_slide_bounds", ...identity, bounds: { x: element.x, y: element.y, width: element.width, height: element.height } });
    }
    for (let i = 0; i < elements.length; i++)
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i],
          b = elements[j],
          pageArea = observation.width * observation.height;
        if ([a, b].some((e) => e.width * e.height >= pageArea * 0.8 || e.geometry === "line" || e.kind === "connector")) continue;
        const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller > 0 && (width * height) / smaller >= 0.2)
          issues.push({ code: "possible_element_overlap", severity: "warning", slideIndex: slide.slideIndex, elementIds: [a.elementId, b.elementId], overlapRatio: Math.round(((width * height) / smaller) * 1000) / 1000 });
      }
  }
  const key = (issue) => JSON.stringify([issue.code, issue.slideIndex, issue.elementId ?? null, issue.elementIds ?? null]);
  const old = new Set((previous?.issues ?? []).map(key));
  const introducedIssues = previous ? issues.filter((issue) => !old.has(key(issue))) : [];
  return {
    issueCount: issues.length,
    issues,
    ...(previous ? { introducedIssueCount: introducedIssues.length, introducedIssues } : {}),
    scope: "authored top-level geometry; the slide image shows text and nested content",
  };
}

/** Slides whose observed content differs, plus slides the commands targeted. */
export function changedSlides(before, after, targeted = []) {
  const globalChange = before.width !== after.width || before.height !== after.height || canonical(before.masters) !== canonical(after.masters);
  const changed = new Set(after.slides.flatMap((slide, i) => (globalChange || canonical(slide) !== canonical(before.slides[i]) ? [i] : [])));
  for (const i of targeted) if (i >= 0 && i < after.slides.length) changed.add(i);
  if (before.slides.length !== after.slides.length && !changed.size && after.slides.length) changed.add(after.slides.length - 1);
  return [...changed].sort((a, b) => a - b);
}
