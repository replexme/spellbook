// InDesign (IDML) documents in the document view. The engine describes an
// IDML document as pages, page items and stories (present_idml::describe);
// the AI reads it the way it reads a deck: each page is a "slide" and each
// page item an element with an id `page/index` and a box in 1/100 mm. A
// story's text belongs to its first frame; frames it continues into say so.
// Edits are translated into present_idml commands.
import { PER_PT, toPt, Refused } from "./commands.mjs";

const mmToPt = (v) => (v * 72) / 25.4;
const hex = (v) => Math.round(v).toString(16).padStart(6, "0").toUpperCase();

const hmm = (pt) => Math.round(pt * PER_PT);

/** The contract operations an IDML document supports. */
export const IDML_OPERATIONS = [
  "replace_text", "replace_text_range", "move", "resize", "delete_element",
  "insert_slide", "delete_slide", "add_text_box", "add_shape", "insert_image",
  "fill_color", "line_color", "line_width", "font_size", "font_color", "bold", "italic", "font_family", "paragraph_alignment",
];

const KIND = { text: "text", image: "image", group: "group", line: "line", rectangle: "shape", oval: "shape", polygon: "shape" };

/**
 * `raw` is the engine's description. Returns the AI's view (`state`), a
 * lookup from element ids to page items, and `view`: the description shaped
 * like a deck's (`width`, `height`, `slides[].shapes[].frame` in points,
 * `fonts`) for drawing pages and picking items.
 */
export function projectIdml(raw) {
  const stories = new Map(raw.stories.map((s) => [s.id, s]));
  const lookup = new Map();
  const firstFrame = new Map(); // story id -> element id of its first frame
  const pages = raw.pages.map((p) => ({ width: p.width, height: p.height, elements: [], shapes: [] }));
  const stack = []; // [depth] -> { element, view } of the open groups on the current page
  const perPage = pages.map(() => 0);
  for (const item of raw.items) {
    const page = pages[item.page];
    if (!page) continue;
    stack.length = item.depth;
    const parent = item.depth > 0 ? stack[item.depth - 1] : null;
    if (item.depth > 0 && !parent) continue;
    const siblings = parent ? parent.element.elements : page.elements;
    const id = parent ? `${parent.element.elementId}/${siblings.length}` : `${item.page}/${perPage[item.page]++}`;
    const [x, y, w, h] = item.box;
    const element = { elementId: id, kind: KIND[item.kind] ?? "shape", objectName: item.name || item.id, x: hmm(x), y: hmm(y), width: hmm(w), height: hmm(h) };
    const shape = { id: item.id, name: item.name, frame: item.box };
    let story = null;
    if (item.story && stories.has(item.story)) {
      story = stories.get(item.story);
      const first = firstFrame.get(story.id);
      if (first) element.continuedFrom = first;
      else {
        firstFrame.set(story.id, id);
        const paragraphs = story.paragraphs.map((p) => p.text.replaceAll(" ", "\n"));
        element.text = paragraphs.join("\n");
        shape.paragraphs = paragraphs;
      }
      if (story.overset && story.frames[story.frames.length - 1] === item.id) element.oversetText = story.overset;
      if (story.substitutedFonts) element.fontsSubstituted = true;
    }
    if (item.image) element.image = { name: item.image.name, link: item.image.link, available: item.image.available };
    if (item.kind === "group") element.elements = [];
    siblings.push(element);
    if (!parent) page.shapes.push(shape);
    if (item.kind === "group") stack[item.depth] = { element };
    lookup.set(id, { elementId: id, slide: item.page + 1, shapeId: item.id, story: story?.id ?? null, element: shape });
  }
  const first = raw.pages[0] ?? { width: 595, height: 842 };
  const state = {
    documentFormat: "idml",
    slides: pages.map((p, slideIndex) => ({
      slideIndex,
      elements: p.elements,
      ...(p.width !== first.width || p.height !== first.height ? { width: hmm(p.width), height: hmm(p.height) } : {}),
    })),
    masters: [],
    sections: [],
    width: hmm(first.width),
    height: hmm(first.height),
  };
  const view = { format: "idml", width: first.width, height: first.height, slides: pages.map((p) => ({ shapes: p.shapes })), masters: [], sections: [], fonts: raw.fonts ?? [] };
  return { state, lookup, view };
}

/** Overset text (text that does not fit its frames), as layout issues. */
export function oversetIssues(state) {
  const issues = [];
  const visit = (slide, list) => {
    for (const e of list) {
      if (e.oversetText)
        issues.push({
          code: "text_overset",
          slideIndex: slide.slideIndex,
          elementId: e.elementId,
          oversetCharacters: Array.from(e.oversetText).length,
          // Drawn with a substitute font: InDesign, with the document's fonts, may fit the text.
          ...(e.fontsSubstituted ? { severity: "warning", fontsSubstituted: true } : {}),
        });
      if (e.elements) visit(slide, e.elements);
    }
  };
  for (const slide of state.slides) visit(slide, slide.elements);
  return issues;
}

/**
 * Translates one contract command into present_idml commands. `context` is the view's
 * document context (`pageCount`, `paragraphDetail`, `asset`).
 */
export function idmlCommands(c, lookup, context) {
  const need = (ok, detail) => {
    if (!ok) throw new Refused("invalid_command", detail);
  };
  if (!IDML_OPERATIONS.includes(c.op)) throw new Refused("unsupported_by_engine", `operation ${c.op} (InDesign documents support ${IDML_OPERATIONS.join(", ")})`);
  const page = () => {
    need(Number.isSafeInteger(c.slideIndex) && c.slideIndex >= 0 && c.slideIndex < context.pageCount, `slideIndex ${c.slideIndex} outside 0..${context.pageCount - 1}`);
    return c.slideIndex;
  };
  const box = () => {
    need([c.x, c.y, c.width, c.height].every(Number.isFinite) && c.width > 0 && c.height >= 0, "x, y, width and height are required");
    return [toPt(c.x), toPt(c.y), toPt(c.width), toPt(c.height)];
  };
  const name = given(c.name) ? { name: String(c.name) } : {};
  switch (c.op) {
    case "insert_slide":
      return [{ op: "add_page", slide: page() + 1, after: page() }];
    case "delete_slide":
      need(context.pageCount > 1, "the only page cannot be deleted");
      return [{ op: "delete_page", slide: page() + 1, page: page() }];
    case "add_text_box":
      return [{ op: "add_text_frame", slide: page() + 1, page: page(), box: box(), text: String(c.text ?? "").replaceAll("\u000b", "\u2028"), ...name }];
    case "add_shape": {
      const kind = { rectangle: "rectangle", ellipse: "oval", line: "line" }[c.geometry ?? "rectangle"];
      need(kind, `geometry ${c.geometry}`);
      const color = Number.isFinite(c.color) ? hex(c.color) : null;
      return [{ op: "add_shape", slide: page() + 1, page: page(), box: box(), kind, ...(kind === "line" ? { stroke: color ?? "000000" } : color ? { fill: color } : {}), ...name }];
    }
    case "insert_image": {
      const asset = context.asset(c.assetId);
      need(["image/png", "image/jpeg"].includes(asset.mediaType), "InDesign documents take PNG or JPEG images");
      return [{ op: "add_image", slide: page() + 1, page: page(), box: box(), data: asset.base64, ...name }];
    }
  }
  const t = lookup.get(c.elementId);
  if (!t) throw new Refused("invalid_command", `element ${c.elementId} is not in the observation`);
  const story = () => {
    need(t.story, `${c.elementId} has no text`);
    return t.story;
  };
  const textStyle = (fields) => [{ op: "set_text_style", slide: t.slide, story: story(), ...fields }];
  switch (c.op) {
    case "replace_text":
      need(typeof c.text === "string", "text is required");
      return [{ op: "set_story_text", slide: t.slide, story: story(), text: c.text.replaceAll("\u000b", "\u2028") }];
    case "replace_text_range": {
      const m = /:p(\d+)$/.exec(c.paragraphId ?? "");
      need(m && c.paragraphId.startsWith(`${c.elementId}:`), "paragraphId is required");
      const p = Number(m[1]);
      const detail = context.paragraphDetail(c.elementId, p);
      const local = c.startOffset - detail.startOffset,
        localEnd = c.endOffset - detail.startOffset;
      need(Number.isSafeInteger(local) && local >= 0 && localEnd >= local && localEnd <= detail.text.length, "offsets outside the paragraph");
      need(detail.text.slice(local, localEnd) === (c.expectedText ?? ""), "expectedText does not match the paragraph; observe again");
      need(typeof c.text === "string" && !c.text.includes("\n"), "text must not contain a newline");
      const chars = (s) => Array.from(s).length;
      return [{ op: "replace_range", slide: t.slide, story: story(), paragraph: p, start: chars(detail.text.slice(0, local)), end: chars(detail.text.slice(0, localEnd)), text: c.text }];
    }
    case "move":
      need(Number.isFinite(c.x) && Number.isFinite(c.y), "x and y are required");
      return [{ op: "set_box", slide: t.slide, item: t.shapeId, box: [toPt(c.x), toPt(c.y), null, null] }];
    case "resize":
      need(c.width > 0 && c.height > 0, "width and height must be positive");
      return [{ op: "set_box", slide: t.slide, item: t.shapeId, box: [null, null, toPt(c.width), toPt(c.height)] }];
    case "delete_element":
      return [{ op: "delete", slide: t.slide, item: t.shapeId }];
    case "fill_color":
      return [{ op: "set_fill", slide: t.slide, item: t.shapeId, color: Number.isFinite(c.color) ? hex(c.color) : "none" }];
    case "line_color":
      return [{ op: "set_stroke", slide: t.slide, item: t.shapeId, color: Number.isFinite(c.color) ? hex(c.color) : "none" }];
    case "line_width":
      need(Number.isFinite(c.size) && c.size >= 0, "size (mm) is required");
      return [{ op: "set_stroke", slide: t.slide, item: t.shapeId, weight: mmToPt(c.size) }];
    case "font_size":
      need(Number.isFinite(c.size) && c.size > 0, "size (pt) is required");
      return textStyle({ size: c.size });
    case "font_color":
      need(Number.isFinite(c.color), "color is required");
      return textStyle({ color: hex(c.color) });
    case "bold":
    case "italic":
      need(typeof c[c.op] === "boolean", `${c.op} must be true or false`);
      return textStyle({ [c.op]: c[c.op] });
    case "font_family":
      need(typeof c.family === "string" && c.family.trim(), "family is required");
      return textStyle({ font: c.family.trim() });
    case "paragraph_alignment":
      need(["left", "center", "right", "justify"].includes(c.alignment), `alignment ${c.alignment}`);
      return [{ op: "set_alignment", slide: t.slide, story: story(), alignment: c.alignment }];
  }
  throw new Refused("unsupported_by_engine", `operation ${c.op}`);
}

const given = (v) => v !== null && v !== undefined;
