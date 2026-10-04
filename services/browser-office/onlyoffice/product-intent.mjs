/* SPDX-License-Identifier: MPL-2.0 */
import {
  firstDocumentStateDifference,
  quantizedOutlineDifference,
} from "../../office-session-spike/document-state-evidence.mjs";

const formatting = {
  font_size: "GetFontSize",
  font_family: "fonts",
  bold: "GetBold",
  italic: "GetItalic",
  underline: "GetUnderline",
  strikethrough: "GetStrikeout",
  font_color: "color",
};
export const onlyOfficeIntentOperations = Object.freeze([
  "move",
  "resize",
  "rotate",
  "flip",
  "set_shape_name",
  "fill_color",
  "line_color",
  "delete_element",
  "replace_text",
  ...Object.keys(formatting),
]);
const rgb = (color) => ({
  r: (color >>> 16) & 255,
  g: (color >>> 8) & 255,
  b: color & 255,
});
function mergeRuns(runs) {
  const result = [];
  for (const run of runs) {
    const last = result.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(run.style))
      last.text += run.text;
    else result.push(structuredClone(run));
  }
  return result;
}
// Saved-file readback proves persistence, not that a setter did what was
// requested. This independent semantic gate runs before the save callback.
export function verifyOnlyOfficeProductIntent(before, after, commands) {
  const left = structuredClone(before),
    right = structuredClone(after);
  delete left.revision;
  delete right.revision;
  const grouped = new Map();
  for (const command of commands) {
    if (!onlyOfficeIntentOperations.includes(command.op))
      throw Error("onlyoffice_product_intent_unavailable:" + command.op);
    const group = grouped.get(command.elementId) ?? [];
    group.push(command);
    grouped.set(command.elementId, group);
  }
  for (const [id, group] of grouped) {
    const [slideIndex, index] = id.split("/").map(Number),
      a = left.slides[slideIndex],
      b = right.slides[slideIndex];
    const original = a.elements[index],
      actual = b.elements[index];
    if (group.some((c) => c.op === "delete_element")) {
      if (group.length !== 1)
        throw Error("onlyoffice_product_delete_requires_separate_request");
      a.elements.splice(index, 1);
      a.onlyoffice.drawings.splice(index, 1);
      a.narrow.drawingStyle.splice(index, 1);
      a.narrow.wordArt.splice(index, 1);
      if (original.kind === "table")
        a.narrow.table.splice(
          a.elements.slice(0, index).filter((e) => e.kind === "table").length,
          1,
        );
      const renumber = (elements, prefix) =>
        elements.forEach((element, i) => {
          element.elementId = prefix + "/" + i;
          renumber(element.elements, element.elementId);
        });
      renumber(a.elements, String(slideIndex));
      continue;
    }
    if (!actual) throw Error("onlyoffice_product_intent_target_missing");
    const oldDrawing = a.onlyoffice.drawings[index],
      newDrawing = b.onlyoffice.drawings[index],
      oldStyle = a.narrow.drawingStyle[index],
      newStyle = b.narrow.drawingStyle[index];
    const final = new Map(group.map((c) => [c.op, c]));
    const geometry = { ...original };
    for (const command of group) {
      if (command.op === "move") {
        geometry.x = command.x;
        geometry.y = command.y;
      }
      if (command.op === "resize") {
        geometry.width = command.width;
        geometry.height = command.height;
      }
    }
    const bounds = quantizedOutlineDifference(
      geometry,
      actual,
      "document.slides[" + slideIndex + "].elements[" + index + "]",
    );
    if (bounds)
      throw Error("onlyoffice_product_intent_mismatch:" + bounds.path);
    for (const key of ["x", "y", "width", "height"]) {
      delete original[key];
      delete actual[key];
    }
    for (const [op, command] of [...final].sort(
      ([a], [b]) => Number(!!formatting[b]) - Number(!!formatting[a]),
    )) {
      if (formatting[op]) {
        const property = formatting[op],
          runs = newDrawing.paragraphs.flatMap((p) => p.runs);
        const desired =
          op === "font_size"
            ? command.size * 2
            : op === "font_family"
              ? Array(4).fill(command.family)
              : op === "font_color"
                ? { rgb: rgb(command.color), theme: false, auto: false }
                : command[op];
        if (
          !runs.length ||
          runs.some(
            (run) =>
              JSON.stringify(run.style[property]) !== JSON.stringify(desired),
          )
        )
          throw Error("onlyoffice_product_intent_mismatch:" + op);
        for (const drawing of [oldDrawing, newDrawing])
          for (const paragraph of drawing.paragraphs) {
            for (const run of paragraph.runs) delete run.style[property];
            paragraph.runs = mergeRuns(paragraph.runs);
          }
      } else if (op === "rotate") {
        const expected = ((command.degrees % 360) + 360) % 360,
          observed = newDrawing.GetRotation;
        if (
          Math.min(
            Math.abs(expected - observed),
            360 - Math.abs(expected - observed),
          ) > 0.001
        )
          throw Error("onlyoffice_product_intent_mismatch:rotation");
        delete oldDrawing.GetRotation;
        delete newDrawing.GetRotation;
      } else if (op === "flip") {
        const flips = group.filter((c) => c.op === "flip");
        for (const [axis, key] of [
          ["horizontal", "GetFlipH"],
          ["vertical", "GetFlipV"],
        ])
          if (flips.some((c) => c.axis === axis)) {
            const expected =
              flips.filter((c) => c.axis === axis).length % 2
                ? !oldDrawing[key]
                : oldDrawing[key];
            if (newDrawing[key] !== expected)
              throw Error("onlyoffice_product_intent_mismatch:flip");
            delete oldDrawing[key];
            delete newDrawing[key];
          }
      } else if (op === "set_shape_name") {
        if (actual.objectName !== command.name)
          throw Error("onlyoffice_product_intent_mismatch:name");
        for (const [element, drawing, style, wordArt] of [
          [original, oldDrawing, oldStyle, a.narrow.wordArt[index]],
          [actual, newDrawing, newStyle, b.narrow.wordArt[index]],
        ]) {
          delete element.objectName;
          delete element.onlyoffice.ownName;
          delete drawing.name;
          delete style.name;
          delete wordArt.name;
        }
      } else if (op === "fill_color" || op === "line_color") {
        const oldColor =
            op === "fill_color" ? oldStyle.fill : oldStyle.line?.color,
          newColor = op === "fill_color" ? newStyle.fill : newStyle.line?.color,
          desired = rgb(command.color);
        if (
          !newColor ||
          newColor.R !== desired.r ||
          newColor.G !== desired.g ||
          newColor.B !== desired.b
        )
          throw Error("onlyoffice_product_intent_mismatch:" + op);
        if (op === "fill_color") {
          delete oldStyle.fill;
          delete newStyle.fill;
        } else {
          if (!oldStyle.line) oldStyle.line = structuredClone(newStyle.line);
          delete oldStyle.line.color;
          delete newStyle.line.color;
        }
      } else if (op === "replace_text") {
        if (
          actual.text.replace(/\r\n/g, "\n").replace(/\n$/, "") !==
          command.text.replace(/\r\n/g, "\n")
        )
          throw Error("onlyoffice_product_intent_mismatch:text");
        const initial = oldDrawing.paragraphs.flatMap((p) => p.runs)[0]?.style;
        if (
          initial &&
          newDrawing.paragraphs
            .flatMap((p) => p.runs)
            .some((r) => JSON.stringify(r.style) !== JSON.stringify(initial))
        )
          throw Error("onlyoffice_product_intent_mismatch:text_style_lost");
        for (const [element, drawing] of [
          [original, oldDrawing],
          [actual, newDrawing],
        ]) {
          delete element.text;
          delete element.onlyoffice.text;
          delete drawing.text;
          delete drawing.paragraphs;
        }
      }
    }
  }
  const difference = firstDocumentStateDifference(left, right, "document");
  if (difference)
    throw Error("onlyoffice_product_unrequested_change:" + difference.path);
}
