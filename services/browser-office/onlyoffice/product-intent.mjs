/* SPDX-License-Identifier: MPL-2.0 */
import {
  firstDocumentStateDifference,
  quantizedOutlineDifference,
} from "../../office-session-spike/document-state-evidence.mjs";
import { normalizedSections } from "../slide-sections.mjs";
import { onlyOfficeCropObservation } from "./crop.mjs";
import { onlyOfficeLineStylePatch } from "./line-style.mjs";
import { onlyOfficeExtendedOperations } from "./extended-commands.mjs";
import { simulateOnlyOfficeExtendedIntent } from "./extended-intent.mjs";
import { rebaseOnlyOfficeIntentIdentities } from "./intent-identities.mjs";
import { onlyOfficeDocumentFillCatalog } from "./document-fill-catalog.mjs";

const formatting = {
  font_size: "GetFontSize",
  font_family: "fonts",
  bold: "GetBold",
  italic: "GetItalic",
  underline: "GetUnderline",
  strikethrough: "GetStrikeout",
  font_color: "color",
  set_character_spacing: "characterSpacing",
  set_script_position: "GetVertAlign",
  set_text_language: "GetLanguage",
};
export const onlyOfficeIntentOperations = Object.freeze([
  "move",
  "resize",
  "rotate",
  "flip",
  "z_order",
  "set_reading_order",
  "set_shape_name",
  "set_alt_text",
  "set_object_lock",
  "crop_image",
  "fill_color",
  "fill_opacity",
  "line_opacity",
  "line_color",
  "line_width",
  "set_line_style",
  "paragraph_alignment",
  "rename_slide",
  "move_slide",
  "delete_slide",
  "duplicate_slide",
  "set_sections",
  "set_slide_hidden",
  "set_background",
  "set_speaker_notes",
  "delete_element",
  "replace_text",
  "set_table_cell",
  "set_table_row_height",
  "set_table_column_width",
  "insert_table_rows",
  "insert_table_columns",
  "delete_table_rows",
  "delete_table_columns",
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
    if (
      last &&
      !last.field &&
      !run.field &&
      JSON.stringify(last.style) === JSON.stringify(run.style)
    )
      last.text += run.text;
    else result.push(structuredClone(run));
  }
  return result;
}
// Saved-file readback proves persistence, not that a setter did what was
// requested. This independent semantic gate runs before the save callback.
export function verifyOnlyOfficeProductIntent(before, after, commands, prepared) {
  const left = structuredClone(before),
    right = structuredClone(after);
  delete left.revision;
  delete right.revision;
  // Preflight binds every target to its original native object. Simulate the
  // requested permutations, then undo that permutation in the observed model
  // before comparing all object properties. No names or hashes are guessed.
  const orders = new Map();
  for (const command of commands.filter((c) =>
    ["z_order", "set_reading_order"].includes(c.op),
  )) {
    const id =
      command.op === "set_reading_order"
        ? command.elementIds[0]
        : command.elementId;
    const [slideIndex, originalIndex] = id.split("/").map(Number);
    const slide = left.slides[slideIndex];
    if (!slide || !slide.elements[originalIndex])
      throw Error("onlyoffice_product_intent_target_missing");
    if (command.op === "set_reading_order") {
      const desired = command.elementIds.map((id) => {
        const [s, i] = id.split("/").map(Number);
        if (s !== slideIndex || !slide.elements[i])
          throw Error("onlyoffice_product_intent_mismatch:reading_order");
        return i;
      });
      if (
        desired.length !== slide.elements.length ||
        new Set(desired).size !== desired.length
      )
        throw Error("onlyoffice_product_intent_mismatch:reading_order");
      orders.set(slideIndex, desired);
      continue;
    }
    const order = orders.get(slideIndex) ?? slide.elements.map((_, i) => i);
    const index = order.indexOf(originalIndex);
    const destination = {
      front: order.length - 1,
      back: 0,
      forward: Math.min(index + 1, order.length - 1),
      backward: Math.max(index - 1, 0),
    }[command.position];
    if (destination === undefined)
      throw Error("onlyoffice_product_intent_mismatch:z_order");
    order.splice(index, 1);
    order.splice(destination, 0, originalIndex);
    orders.set(slideIndex, order);
  }
  for (const [slideIndex, order] of orders) {
    const observed = right.slides[slideIndex];
    if (observed.elements.length !== order.length)
      throw Error("onlyoffice_product_intent_mismatch:z_order_count");
    const restore = (values) =>
      order.map((_, original) => values[order.indexOf(original)]);
    const tableOrder = order.filter(
      (i) => left.slides[slideIndex].elements[i].kind === "table",
    );
    observed.narrow.table = left.slides[slideIndex].elements
      .map((e, i) =>
        e.kind === "table"
          ? observed.narrow.table[tableOrder.indexOf(i)]
          : undefined,
      )
      .filter((e) => e !== undefined);
    observed.elements = restore(observed.elements);
    observed.onlyoffice.drawings = restore(observed.onlyoffice.drawings);
    observed.narrow.drawingStyle = restore(observed.narrow.drawingStyle);
    observed.narrow.wordArt = restore(observed.narrow.wordArt);
    rebaseOnlyOfficeIntentIdentities(observed,slideIndex);
  }
  const grouped = new Map();
  for (const [commandIndex, command] of commands.entries()) {
    if (onlyOfficeExtendedOperations.includes(command.op)) {
      const binding=prepared?.[commandIndex];
      if (!binding || Object.entries(command).some(([key,value])=>
        JSON.stringify(binding[key])!==JSON.stringify(value)))
        throw Error("onlyoffice_product_intent_preflight_authority_missing");
      simulateOnlyOfficeExtendedIntent(left,right,[binding],prepared.slice(commandIndex));
      continue;
    }
    if (!onlyOfficeIntentOperations.includes(command.op))
      throw Error("onlyoffice_product_intent_unavailable:" + command.op);
    if (command.op === "set_sections") {
      left.sections = normalizedSections(
        command.sections,
        left.slides.length,
      ).map((section) => ({
        name: section.name,
        guid: section.id,
        startIndex: section.startSlideIndex,
      }));
      continue;
    }
    if (
      ["move_slide", "delete_slide", "duplicate_slide"].includes(command.op)
    ) {
      if (command.op === "duplicate_slide") {
        if (!left.slides[command.slideIndex])
          throw Error("onlyoffice_product_intent_slide_duplicate_invalid");
        for (const section of left.sections ?? [])
          if (section.startIndex >= command.slideIndex + 1)
            section.startIndex++;
        left.slides.splice(
          command.slideIndex + 1,
          0,
          structuredClone(left.slides[command.slideIndex]),
        );
      }
      if (command.op === "delete_slide") {
        left.sections = (left.sections ?? [])
          .filter(
            (section, index, sections) =>
              !(
                section.startIndex === command.slideIndex &&
                (sections[index + 1]?.startIndex ?? left.slides.length) ===
                  command.slideIndex + 1
              ),
          )
          .map((section) => ({
            ...section,
            startIndex:
              section.startIndex > command.slideIndex
                ? section.startIndex - 1
                : section.startIndex,
          }));
      }
      const [moved] =
        command.op === "duplicate_slide"
          ? [null]
          : left.slides.splice(command.slideIndex, 1);
      if (
        command.op === "move_slide" &&
        (!moved ||
          !Number.isSafeInteger(command.targetSlideIndex) ||
          command.targetSlideIndex < 0 ||
          command.targetSlideIndex > left.slides.length)
      )
        throw Error("onlyoffice_product_intent_target_missing");
      if (command.op === "move_slide")
        left.slides.splice(command.targetSlideIndex, 0, moved);
      else if (command.op === "delete_slide" && (!moved || !left.slides.length))
        throw Error("onlyoffice_product_intent_slide_delete_invalid");
      left.slides.forEach((slide, index) => {
        rebaseOnlyOfficeIntentIdentities(slide,index);
      });
      continue;
    }
    if (
      [
        "rename_slide",
        "set_slide_hidden",
        "set_background",
        "set_speaker_notes",
      ].includes(command.op)
    ) {
      const slide = left.slides[command.slideIndex];
      if (!slide) throw Error("onlyoffice_product_intent_target_missing");
      if (command.op === "rename_slide") slide.onlyoffice.name = command.name;
      else if (command.op === "set_slide_hidden")
        slide.onlyoffice.visible = !command.hidden;
      else if (command.op === "set_speaker_notes") {
        const actual = right.slides[command.slideIndex].onlyoffice;
        const normalize = (text) =>
          text?.replace(/\r\n/g, "\n").replace(/\n$/, "");
        if (normalize(actual.notes) !== command.text.replace(/\r\n/g, "\n"))
          throw Error("onlyoffice_product_intent_mismatch:notes");
        const initial = slide.onlyoffice.notesParagraphs?.flatMap(
          (p) => p.runs,
        )[0]?.style;
        if (
          initial &&
          actual.notesParagraphs
            ?.flatMap((p) => p.runs)
            .some((r) => JSON.stringify(r.style) !== JSON.stringify(initial))
        )
          throw Error("onlyoffice_product_intent_mismatch:notes_style_lost");
        const alignment = slide.onlyoffice.notesParagraphs?.[0]?.alignment;
        if (
          alignment != null &&
          actual.notesParagraphs?.some((p) => p.alignment !== alignment)
        )
          throw Error(
            "onlyoffice_product_intent_mismatch:notes_paragraph_style_lost",
          );
        slide.onlyoffice.notes = actual.notes;
        slide.onlyoffice.notesParagraphs = structuredClone(
          actual.notesParagraphs,
        );
      } else {
        const color = rgb(command.color);
        const desired = { R: color.r, G: color.g, B: color.b, A: 255 };
        slide.onlyoffice.background = {
          reference: null,
          solid: { type: 1, id: null, rgb: desired, modifiers: [] },
          transparency: null,
        };
        slide.narrow.background = desired;
      }
      continue;
    }
    if (command.op === "set_reading_order") continue;
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
      rebaseOnlyOfficeIntentIdentities(a,slideIndex);
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
        if (oldDrawing.tableLayout?.authoredFrame) {
          oldDrawing.tableLayout.authoredFrame.offX = command.x;
          oldDrawing.tableLayout.authoredFrame.offY = command.y;
        }
      }
      if (command.op === "resize") {
        geometry.width = command.width;
        geometry.height = command.height;
      }
    }
    if (
      original.kind === "table" &&
      group.some((c) =>
        ["insert_table_columns", "delete_table_columns"].includes(c.op),
      )
    ) {
      const command = group[0],
        layout = oldDrawing.tableLayout,
        observed = newDrawing.tableLayout;
      const insert = command.op === "insert_table_columns";
      for (const key of ["columnWidths", "columnWidthsEmu"]) {
        const grid = layout[key];
        if (!Array.isArray(grid))
          throw Error("onlyoffice_product_intent_column_precision_missing");
        if (insert) {
          const width = grid[Math.min(command.index, grid.length - 1)];
          grid.splice(command.index, 0, ...Array(command.count).fill(width));
        } else grid.splice(command.index, command.count);
      }
      const width = Math.round(
        layout.columnWidthsEmu.reduce((sum, w) => sum + w, 0) / 360,
      );
      geometry.width = layout.computedWidth = layout.authoredFrame.extX = width;
      for (const [i, row] of layout.rowHeights.entries())
        row.computedHeight = observed.rowHeights[i].computedHeight;
    }
    if (
      original.kind === "table" &&
      group.some((c) => c.op === "set_table_column_width")
    ) {
      const columns = oldDrawing.tableLayout.columnWidths;
      const exactColumns = oldDrawing.tableLayout.columnWidthsEmu;
      if (!exactColumns)
        throw Error("onlyoffice_product_intent_column_precision_missing");
      for (const c of group.filter((c) => c.op === "set_table_column_width")) {
        columns[c.index] = c.width;
        exactColumns[c.index] = c.width * 360;
      }
      const width = Math.round(
        exactColumns.reduce((sum, column) => sum + column, 0) / 360,
      );
      geometry.width = width;
      oldDrawing.tableLayout.authoredFrame.extX = width;
      oldDrawing.tableLayout.computedWidth = width;
      for (const [i, row] of oldDrawing.tableLayout.rowHeights.entries())
        row.computedHeight =
          newDrawing.tableLayout.rowHeights[i].computedHeight;
    }
    if (
      original.kind === "table" &&
      group.some((c) =>
        [
          "set_table_cell",
          "set_table_row_height",
          "set_table_column_width",
          "insert_table_rows",
          "insert_table_columns",
          "delete_table_rows",
          "delete_table_columns",
        ].includes(c.op),
      ) &&
      !group.some((c) => c.op === "resize")
    ) {
      // A native table grows to its content's page bounds. Row-height rules
      // and the authored frame remain strict below; only calculated height
      // can follow the requested text reflow.
      if (
        !newDrawing.tableLayout ||
        actual.height !== newDrawing.tableLayout.computedHeight
      )
        throw Error("onlyoffice_product_intent_mismatch:table_layout_height");
      geometry.height = actual.height;
      oldDrawing.tableLayout.computedHeight =
        newDrawing.tableLayout.computedHeight;
      for (const c of group.filter((c) => c.op === "set_table_cell")) {
        const initial = oldDrawing.tableLayout.rowHeights[c.row];
        const observed = newDrawing.tableLayout.rowHeights[c.row];
        if (initial && observed)
          initial.computedHeight = observed.computedHeight;
      }
    }
    const bounds = quantizedOutlineDifference(
      geometry,
      actual,
      "document.slides[" + slideIndex + "].elements[" + index + "]",
    );
    if (bounds)
      throw Error(
        "onlyoffice_product_intent_mismatch:" +
          bounds.path +
          ":" +
          JSON.stringify(bounds),
      );
    for (const key of ["x", "y", "width", "height"]) {
      delete original[key];
      delete actual[key];
    }
    for (const [op, command] of [...final].sort(
      ([a], [b]) => Number(!!formatting[b]) - Number(!!formatting[a]),
    )) {
      if (["insert_table_rows", "delete_table_rows"].includes(op)) {
        const previous = oldDrawing.tableCells.length;
        const expected =
          previous +
          (op === "insert_table_rows" ? command.count : -command.count);
        if (newDrawing.tableCells.length !== expected)
          throw Error("onlyoffice_product_intent_mismatch:table_row_count");
        const tableIndex = a.elements
          .slice(0, index)
          .filter((e) => e.kind === "table").length;
        const oldTable = a.narrow.table[tableIndex],
          newTable = b.narrow.table[tableIndex];
        if (!oldTable || newTable.rows !== expected)
          throw Error("onlyoffice_product_intent_mismatch:table_row_count");
        const arrays = [
          [oldDrawing.tableCells, newDrawing.tableCells],
          [oldDrawing.tableParagraphs, newDrawing.tableParagraphs],
          ...(oldDrawing.tableCellProperties ? [[oldDrawing.tableCellProperties,newDrawing.tableCellProperties]] : []),
          [
            oldDrawing.tableLayout.rowHeights,
            newDrawing.tableLayout.rowHeights,
          ],
          [oldTable.cells, newTable.cells],
        ];
        for (const [original, actual] of arrays) {
          if (op === "delete_table_rows")
            original.splice(command.index, command.count);
          else
            original.splice(
              command.index,
              0,
              ...structuredClone(
                actual.slice(command.index, command.index + command.count),
              ),
            );
        }
        if(oldDrawing.tableCellProperties) {
          const binding = prepared?.find(value => value.op===op && value.elementId===command.elementId);
          if(!binding?.nativeTableRows || Object.entries(command).some(([key,value])=>key!=="slideIndex" && JSON.stringify(binding[key])!==JSON.stringify(value)))
            throw Error("onlyoffice_product_table_row_authority_missing");
          for(const row of binding.nativeTableRows.retained) {
            if(!oldDrawing.tableCellProperties[row.index] || row.properties.length!==oldDrawing.tableCellProperties[row.index].length)
              throw Error("onlyoffice_product_table_row_authority_invalid");
            oldDrawing.tableCellProperties[row.index] = structuredClone(row.properties);
          }
        }
        if (
          op === "insert_table_rows" &&
          newDrawing.tableCells
            .slice(command.index, command.index + command.count)
            .some(
              (row) =>
                row.length !== oldDrawing.tableCells[0].length ||
                row.some(
                  (text) =>
                    // Native cell GetText includes the terminal cell (tab) or row
                    // (CRLF) delimiter even when no authored characters exist.
                    !["", "\t", "\r\n", "\n"].includes(text),
                ),
            )
        )
          throw Error(
            "onlyoffice_product_intent_mismatch:new_table_row_content",
          );
        oldTable.rows = expected;
      } else if (
        ["insert_table_columns", "delete_table_columns"].includes(op)
      ) {
        const gridStarts=oldDrawing.tableCellProperties?.map(row=>row[0]?.column??0);
        const expected =
          oldDrawing.tableCells[0].length +
          (op === "insert_table_columns" ? command.count : -command.count);
        const tableIndex = a.elements
          .slice(0, index)
          .filter((e) => e.kind === "table").length;
        const oldTable = a.narrow.table[tableIndex],
          newTable = b.narrow.table[tableIndex];
        if (
          newDrawing.tableCells.length !== oldDrawing.tableCells.length ||
          newTable.rows !== oldTable.rows
        )
          throw Error("onlyoffice_product_intent_mismatch:table_row_count");
        for (const [oldRows, newRows] of [
          [oldDrawing.tableCells, newDrawing.tableCells],
          [oldDrawing.tableParagraphs, newDrawing.tableParagraphs],
          ...(oldDrawing.tableCellProperties ? [[oldDrawing.tableCellProperties,newDrawing.tableCellProperties]] : []),
          [oldTable.cells, newTable.cells],
        ])
          for (const [r, row] of oldRows.entries()) {
            if (newRows[r]?.length !== expected)
              throw Error(
                "onlyoffice_product_intent_mismatch:table_column_count",
              );
            if (op === "delete_table_columns")
              row.splice(command.index, command.count);
            else
              row.splice(
                command.index,
                0,
                ...structuredClone(
                  newRows[r].slice(
                    command.index,
                    command.index + command.count,
                  ),
                ),
              );
          }
        if(oldDrawing.tableCellProperties)for(const [r,row] of oldDrawing.tableCellProperties.entries()){
          let column=gridStarts[r];for(const cell of row){cell.column=column;column+=cell.gridSpan;}
        }
        if (
          op === "insert_table_columns" &&
          newDrawing.tableCells.some((row) =>
            row
              .slice(command.index, command.index + command.count)
              .some((text) => !["", "\r\n", "\n"].includes(text)),
          )
        )
          throw Error(
            "onlyoffice_product_intent_mismatch:new_table_column_content",
          );
      } else if (op === "set_table_row_height") {
        const heights = new Map(
          group.filter((c) => c.op === op).map((c) => [c.index, c]),
        );
        for (const c of heights.values()) {
          const initial = oldDrawing.tableLayout?.rowHeights[c.index];
          const observed = newDrawing.tableLayout?.rowHeights[c.index];
          if (!initial || !observed || observed.computedHeight !== c.height)
            throw Error(
              "onlyoffice_product_intent_mismatch:table_row_height:" +
                JSON.stringify({ requested: c.height, initial, observed }),
            );
          initial.value = c.height;
          initial.rule = 0;
          initial.computedHeight = c.height;
        }
      } else if (formatting[op]) {
        const property = formatting[op],
          runs = newDrawing.paragraphs.flatMap((p) => p.runs);
        const desired =
          op === "font_size"
            ? command.size * 2
            : op === "font_family"
              ? Array(4).fill(command.family)
              : op === "font_color"
                ? { rgb: rgb(command.color), theme: false, auto: false }
                : op === "set_character_spacing"
                  ? Math.round(command.spacing * 100) / 100
                  : op === "set_script_position"
                    ? command.script === "normal"
                      ? "baseline"
                      : command.script
                    : op === "set_text_language"
                      ? Intl.getCanonicalLocales(command.languageTag)[0]
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
            for (const run of paragraph.runs) {
              delete run.style[property];
              if (op === "set_character_spacing") delete run.style.GetSpacing;
            }
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
      } else if (op === "set_alt_text") {
        for (const key of ["title", "description"])
          if (command[key] != null) original.onlyoffice[key] = command[key];
      } else if (op === "set_object_lock") {
        if (!original.onlyoffice.locks || !actual.onlyoffice.locks)
          throw Error("onlyoffice_product_intent_locks_missing");
        for (const value of group.filter((c) => c.op === "set_object_lock")) {
          if (value.lockPosition != null)
            original.onlyoffice.locks.noMove = value.lockPosition;
          if (value.lockSize != null)
            original.onlyoffice.locks.noResize = value.lockSize;
        }
      } else if (op === "crop_image") {
        original.onlyoffice.crop = onlyOfficeCropObservation({
          l: command.left * 100,
          t: command.top * 100,
          r: (1 - command.right) * 100,
          b: (1 - command.bottom) * 100,
        });
      } else if (op === "paragraph_alignment") {
        if (
          !newDrawing.paragraphs.length ||
          newDrawing.paragraphs.some((p) => p.alignment !== command.alignment)
        )
          throw Error("onlyoffice_product_intent_mismatch:paragraph_alignment");
        for (const drawing of [oldDrawing, newDrawing])
          for (const paragraph of drawing.paragraphs)
            delete paragraph.alignment;
      } else if (op === "set_line_style") {
        if (!oldStyle.line)
          throw Error("onlyoffice_product_intent_line_missing");
        for (const value of group.filter((c) => c.op === "set_line_style"))
          Object.assign(
            oldStyle.line,
            onlyOfficeLineStylePatch(value.lineStyle),
          );
      } else if (op === "line_width") {
        if (
          !newStyle.line ||
          newStyle.line.width !== Math.round(command.size * 36000)
        )
          throw Error("onlyoffice_product_intent_mismatch:line_width");
        delete oldStyle.line.width;
        delete newStyle.line.width;
      } else if (op === "fill_opacity" || op === "line_opacity") {
        const oldFill =
          op === "fill_opacity" ? oldStyle.fillStyle : oldStyle.line?.fillStyle;
        const newFill =
          op === "fill_opacity" ? newStyle.fillStyle : newStyle.line?.fillStyle;
        if (
          !oldFill ||
          !newFill ||
          newFill.opacity !== Math.round(command.opacity * 1000) / 1000
        )
          throw Error("onlyoffice_product_intent_mismatch:" + op);
        oldFill.opacity = newFill.opacity;
        if (op === "fill_opacity" && oldDrawing.fill)
          oldDrawing.fill.opacity = Math.round(command.opacity * 1000) / 1000;
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
          if (newDrawing.fill?.type !== 3 || !newDrawing.fill.color ||
              newDrawing.fill.color.rgb?.R !== desired.r ||
              newDrawing.fill.color.rgb?.G !== desired.g ||
              newDrawing.fill.color.rgb?.B !== desired.b)
            throw Error("onlyoffice_product_intent_mismatch:solid_fill");
          // The requested solid fill replaces the complete previous fill.
          // RGB and native fill kind were checked independently above.
          oldDrawing.fill = structuredClone(newDrawing.fill);
          delete oldStyle.fillStyle;
          delete newStyle.fillStyle;
          delete oldStyle.fill;
          delete newStyle.fill;
        } else {
          if (!oldStyle.line) oldStyle.line = structuredClone(newStyle.line);
          delete oldStyle.line.fillStyle;
          delete newStyle.line.fillStyle;
          delete oldStyle.line.color;
          delete newStyle.line.color;
        }
      } else if (op === "set_table_cell") {
        const cells = new Map(
          group
            .filter((c) => c.op === "set_table_cell")
            .map((c) => [c.row + "/" + c.column, c]),
        );
        for (const value of cells.values()) {
          const { row, column } = value;
          const text = newDrawing.tableCells?.[row]?.[column];
          if (
            text?.replace(/\r\n/g, "\n").replace(/\n$/, "") !==
            value.text.replace(/\r\n/g, "\n")
          )
            throw Error("onlyoffice_product_intent_mismatch:table_cell_text");
          const oldParagraphs = oldDrawing.tableParagraphs[row][column];
          const newParagraphs = newDrawing.tableParagraphs[row][column];
          const style = oldParagraphs.flatMap((p) => p.runs)[0]?.style;
          if (
            style &&
            newParagraphs
              .flatMap((p) => p.runs)
              .some((r) => JSON.stringify(r.style) !== JSON.stringify(style))
          )
            throw Error(
              "onlyoffice_product_intent_mismatch:table_cell_style_lost",
            );
          const alignment = oldParagraphs[0]?.alignment;
          if (
            alignment != null &&
            newParagraphs.some((p) => p.alignment !== alignment)
          )
            throw Error(
              "onlyoffice_product_intent_mismatch:table_cell_paragraph_style_lost",
            );
          oldDrawing.tableCells[row][column] = text;
          oldDrawing.tableParagraphs[row][column] =
            structuredClone(newParagraphs);
          const tableIndex = a.elements
            .slice(0, index)
            .filter((e) => e.kind === "table").length;
          a.narrow.table[tableIndex].cells[row][column].text = text;
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
  if(Object.hasOwn(left,"styleCatalog"))left.styleCatalog=onlyOfficeDocumentFillCatalog(left);
  const difference = firstDocumentStateDifference(left, right, "document");
  if (difference)
    throw Error("onlyoffice_product_unrequested_change:" + difference.path);
}
