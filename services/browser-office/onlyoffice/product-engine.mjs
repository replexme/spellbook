/* SPDX-License-Identifier: MPL-2.0 */
import {
  onlyOfficeIntentOperations,
  verifyOnlyOfficeProductIntent,
} from "./product-intent.mjs";
import { observeOnlyOfficeCandidate } from "../onlyoffice-observation.mjs";
import { onlyOfficeCharacterSpacingTwips } from "./character-spacing.mjs";
import { onlyOfficeOpacityNative } from "./opacity.mjs";
import { onlyOfficeLineStylePatch } from "./line-style.mjs";
import {
  beginCandidateTransaction,
  finishCandidateTransaction,
} from "./candidate-transaction.mjs";
import { firstDocumentStateDifference } from "../../office-session-spike/document-state-evidence.mjs";

// Commands use the canonical product registry. Native bindings stay private to
// the live session and are rechecked after the entire request's preflight.
export async function observeOnlyOfficeProduct(frame) {
  const projection = await observeOnlyOfficeCandidate(frame);
  if (projection.unavailable.length)
    throw Error(
      "onlyoffice_product_observation_unavailable:" +
        projection.unavailable.join(","),
    );
  // Use the product's hundredth-millimetre geometry once; duplicate SDK
  // millimetre fields must not bypass the common physical-outline budget.
  const element = (shape, id) => {
    const { x, y, w, h, children, ...authored } = shape;
    return {
      elementId: id,
      kind: shape.type,
      text: shape.text,
      x: Math.round(x * 100),
      y: Math.round(y * 100),
      width: Math.round(w * 100),
      height: Math.round(h * 100),
      objectName: shape.ownName,
      onlyoffice: authored,
      elements: children.map((child, index) =>
        element(child, id + "/" + index),
      ),
    };
  };
  const drawing = (value) => {
    const {
      GetPosX,
      GetPosY,
      GetWidth,
      GetHeight,
      groupChildren,
      ...authored
    } = value;
    // OOXML angles are serialized as integer 1/60000 degrees. The pinned
    // SDK can round one unit downward; expose millidegrees consistently.
    if (typeof authored.GetRotation === "number")
      authored.GetRotation = Math.round(authored.GetRotation * 1000) / 1000;
    if (groupChildren) authored.groupChildren = groupChildren.map(drawing);
    return authored;
  };
  const slides = projection.common.slides.map((slide, slideIndex) => ({
    slideIndex,
    elements: slide.shapes.map((shape, index) =>
      element(
        projection.extended.slides[slideIndex].drawings[index]?.hasDynamicFields
          ? {
              ...shape,
              text: projection.extended.slides[slideIndex].drawings[index].text,
            }
          : shape,
        slideIndex + "/" + index,
      ),
    ),
    onlyoffice: {
      ...projection.extended.slides[slideIndex],
      drawings: projection.extended.slides[slideIndex].drawings.map(drawing),
    },
    narrow: projection.narrow[slideIndex],
  }));
  const state = {
    slides,
    masters: projection.extended.masters.map((master) => ({
      ...master,
      drawings: master.drawings.map(drawing),
      layouts: master.layouts.map((layout) => ({
        ...layout,
        drawings: layout.drawings.map(drawing),
      })),
    })),
    sections: projection.extended.sections,
    width: projection.extended.width * 100,
    height: projection.extended.height * 100,
  };
  return {
    ...state,
    revision: Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(state)),
        ),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export function onlyOfficePersistenceState(value) {
  const copy = structuredClone(value);
  delete copy.revision;
  return copy;
}
export function verifyOnlyOfficeProductObservation(expected, actual) {
  const difference = firstDocumentStateDifference(
    onlyOfficePersistenceState(expected),
    onlyOfficePersistenceState(actual),
    "document",
  );
  if (difference)
    throw Error(
      "onlyoffice_product_artifact_mismatch:" +
        difference.path +
        ":" +
        JSON.stringify(difference),
    );
}

// The pinned serializer stores millimetres as truncated integer EMUs. Keyboard
// movement uses view pixels and can leave sub-EMU coordinates in native history.
// Finalize those coordinates in that same history point before approving bytes;
// otherwise exact file recovery can draw a different pixel boundary.
export function finalizeOnlyOfficeNativeGeometry() {
  const model = window.Asc.editor.WordControl.m_oLogicDocument;
  const pending = [];
  const visit = (shape) => {
    const transform = shape.spPr?.xfrm;
    if (transform)
      for (const key of [
        "offX",
        "offY",
        "extX",
        "extY",
        "chOffX",
        "chOffY",
        "chExtX",
        "chExtY",
      ]) {
        const value = transform[key];
        if (!Number.isFinite(value)) continue;
        const scaled = value * 36000;
        if (Math.abs(scaled - Math.round(scaled)) <= 1e-7) continue;
        const wanted = Math.trunc(scaled);
        let serializable = wanted / 36000;
        for (
          let attempt = 0;
          Math.trunc(serializable * 36000) !== wanted && attempt < 8;
          attempt++
        )
          serializable +=
            Math.sign(wanted) *
            Math.max(Math.abs(serializable), 1) *
            Number.EPSILON;
        const setter = transform["set" + key[0].toUpperCase() + key.slice(1)];
        if (
          Math.trunc(serializable * 36000) !== wanted ||
          typeof setter !== "function"
        )
          throw Error("onlyoffice_product_geometry_not_serializable");
        pending.push(() => setter.call(transform, serializable));
      }
    for (const child of shape.spTree ?? []) visit(child);
  };
  for (const slide of model.Slides)
    for (const shape of slide.cSld.spTree) visit(shape);
  if (!pending.length) return false;
  const history = window.AscCommon.History;
  if (!history.Points[history.Index]?.Items.length)
    throw Error("onlyoffice_product_geometry_history_required");
  for (const apply of pending) apply();
  model.Recalculate();
  return true;
}

export const onlyOfficeProductOperations = onlyOfficeIntentOperations;

export function createOnlyOfficeProductEngine({
  getFrame,
  open,
  inspect,
  snapshot,
  bindArtifact,
}) {
  return {
    open,
    inspect,
    persistenceState: onlyOfficePersistenceState,
    verifyIntent: verifyOnlyOfficeProductIntent,
    // Private live-session evidence only. It is not a persisted semantic hash.
    // Empty points, selection and save indices do not represent authored edits.
    changeToken: async () =>
      (await getFrame()).evaluate(() => {
        const history = window.AscCommon.History;
        if (
          !history ||
          !Array.isArray(history.Points) ||
          !Number.isSafeInteger(history.Index)
        )
          throw Error("onlyoffice_product_change_token_unavailable");
        let count = 0,
          last = null;
        for (const point of history.Points.slice(0, history.Index + 1))
          for (const item of point.Items) {
            if (
              !Number.isSafeInteger(item.Binary?.Pos) ||
              !Number.isSafeInteger(item.Binary?.Len)
            )
              throw Error("onlyoffice_product_change_token_unavailable");
            count++;
            last = item.Binary;
          }
        return JSON.stringify([count, last?.Pos ?? null, last?.Len ?? null]);
      }),
    prepareManualCheckpoint: async () =>
      (await getFrame()).evaluate(finalizeOnlyOfficeNativeGeometry),
    observe: async () => observeOnlyOfficeProduct(await getFrame()),
    preflight: async (commands) => {
      const frame = await getFrame();
      const prepared = await frame.evaluate(
        ({ commands, supported }) => {
          const m = window.Asc.editor.WordControl.m_oLogicDocument;
          return commands.map((command) => {
            if (!supported.includes(command.op))
              throw Error(
                "onlyoffice_product_operation_unavailable:" + command.op,
              );
            if (command.op === "set_reading_order") {
              const ids = command.elementIds;
              if (
                !Array.isArray(ids) ||
                ids.length < 2 ||
                ids.length > 256 ||
                new Set(ids).size !== ids.length ||
                ids.some(
                  (id) => typeof id !== "string" || !/^\d+\/\d+$/.test(id),
                )
              )
                throw Error("onlyoffice_product_reading_order_invalid");
              const index = Number(ids[0].split("/")[0]);
              const slide = m.Slides[index];
              if (
                !slide ||
                ids.length !== slide.cSld.spTree.length ||
                ids.some(
                  (id) =>
                    Number(id.split("/")[0]) !== index ||
                    !slide.cSld.spTree[Number(id.split("/")[1])],
                )
              )
                throw Error(
                  "onlyoffice_product_reading_order_requires_all_slide_objects",
                );
              const controller = slide.graphicObjects;
              if (
                typeof controller?.bringToFront !== "function" ||
                typeof controller.resetSelection !== "function" ||
                typeof controller.selectObject !== "function"
              )
                throw Error("onlyoffice_product_reading_order_unavailable");
              if (commands.some((c) => c.op === "delete_element"))
                throw Error(
                  "onlyoffice_product_topology_requires_separate_request",
                );
              return {
                ...command,
                slideIndex: index,
                nativeId: slide.Id,
                nativeIds: ids.map(
                  (id) => slide.cSld.spTree[Number(id.split("/")[1])].Id,
                ),
              };
            }
            if (
              [
                "rename_slide",
                "set_slide_hidden",
                "set_background",
                "set_speaker_notes",
              ].includes(command.op)
            ) {
              const index = command.slideIndex;
              const slide = m.Slides[index];
              if (!Number.isSafeInteger(index) || index < 0 || !slide)
                throw Error("onlyoffice_product_target_missing");
              if (
                command.op === "rename_slide" &&
                (typeof command.name !== "string" ||
                  !command.name.trim() ||
                  command.name.length > 255 ||
                  /[\u0000-\u001f]/.test(command.name))
              )
                throw Error("onlyoffice_product_argument_invalid:name");
              if (
                command.op === "set_slide_hidden" &&
                typeof command.hidden !== "boolean"
              )
                throw Error("onlyoffice_product_argument_invalid:hidden");
              if (
                command.op === "set_background" &&
                (!Number.isSafeInteger(command.color) ||
                  command.color < 0 ||
                  command.color > 0xffffff)
              )
                throw Error("onlyoffice_product_color_invalid");
              if (command.op === "set_speaker_notes") {
                if (
                  typeof command.text !== "string" ||
                  command.text.length > 100000
                )
                  throw Error("onlyoffice_product_argument_invalid:notes");
                if (
                  !slide.notes &&
                  (!m.notesMasters?.[0] ||
                    typeof window.AscCommonSlide?.CreateNotes !== "function")
                )
                  throw Error("onlyoffice_product_notes_master_unavailable");
              }
              return { ...command, nativeId: slide.Id };
            }
            if (
              command.op === "set_shape_name" &&
              (!command.name ||
                m.Slides.some((s) =>
                  s.cSld.spTree.some((x) => x.getOwnName?.() === command.name),
                ))
            )
              throw Error("onlyoffice_product_name_not_unique");
            const parts = command.elementId?.split("/").map(Number);
            if (parts?.length !== 2 || !parts.every(Number.isSafeInteger))
              throw Error("onlyoffice_product_target_invalid");
            const [slide, index] = parts,
              shape = m.Slides[slide]?.cSld.spTree[index];
            if (!shape || slide < 0 || index < 0)
              throw Error("onlyoffice_product_target_missing");
            if (command.op === "z_order") {
              const method = {
                front: "bringToFront",
                forward: "bringForward",
                back: "sendToBack",
                backward: "bringBackward",
              }[command.position];
              const controller = m.Slides[slide]?.graphicObjects;
              if (
                !method ||
                typeof controller?.[method] !== "function" ||
                typeof controller.resetSelection !== "function" ||
                typeof controller.selectObject !== "function"
              )
                throw Error("onlyoffice_product_z_order_unavailable");
              if (commands.some((c) => ["delete_element"].includes(c.op)))
                throw Error(
                  "onlyoffice_product_topology_requires_separate_request",
                );
            }
            if (
              [
                "set_table_cell",
                "set_table_row_height",
                "set_table_column_width",
                "insert_table_rows",
                "delete_table_rows",
              ].includes(command.op) &&
              shape.graphicObject?.Content?.some((row) =>
                row.Content.some(
                  (cell) => cell.Get_GridSpan() !== 1 || cell.GetVMerge() !== 1,
                ),
              )
            )
              throw Error("onlyoffice_product_merged_table_target_unavailable");
            if (
              ["insert_table_rows", "delete_table_rows"].includes(command.op)
            ) {
              const table = shape.graphicObject;
              if (
                !table?.Content ||
                commands.length !== 1 ||
                !Number.isSafeInteger(command.index) ||
                command.index < 0 ||
                !Number.isSafeInteger(command.count) ||
                command.count < 1 ||
                command.count > 100 ||
                (command.op === "insert_table_rows"
                  ? command.index > table.Content.length ||
                    table.Content.length + command.count > 1000
                  : command.index + command.count > table.Content.length ||
                    command.count >= table.Content.length)
              )
                throw Error("onlyoffice_product_table_row_topology_invalid");
            }
            if (command.op === "set_table_column_width") {
              const table = shape.graphicObject;
              if (
                !Number.isSafeInteger(command.index) ||
                command.index < 0 ||
                !table?.TableGrid?.[command.index] ||
                !Number.isSafeInteger(command.width) ||
                command.width < 420 ||
                command.width > 55880 ||
                typeof table.SetTableGrid !== "function" ||
                typeof shape.spPr?.xfrm?.setExtX !== "function"
              )
                throw Error("onlyoffice_product_table_column_width_invalid");
            }
            if (command.op === "set_table_row_height") {
              const row = shape.graphicObject?.Content?.[command.index];
              if (
                !Number.isSafeInteger(command.index) ||
                command.index < 0 ||
                !row ||
                !Number.isSafeInteger(command.height) ||
                command.height < 100 ||
                command.height > 100000 ||
                window.Asc.linerule_AtLeast !== 0
              )
                throw Error("onlyoffice_product_table_row_height_invalid");
            }
            if (command.op === "set_table_cell") {
              const cell =
                shape.graphicObject?.Content?.[command.row]?.Content?.[
                  command.column
                ];
              if (
                !Number.isSafeInteger(command.row) ||
                command.row < 0 ||
                !Number.isSafeInteger(command.column) ||
                command.column < 0 ||
                !cell?.Content
              )
                throw Error("onlyoffice_product_table_cell_target_missing");
              if (
                typeof command.text !== "string" ||
                command.text.length > 100000
              )
                throw Error("onlyoffice_product_argument_invalid:cell_text");
            }
            if (command.op === "set_alt_text") {
              const properties = shape.getCNvProps?.();
              if (
                typeof properties?.setTitle !== "function" ||
                typeof properties?.setDescr !== "function"
              )
                throw Error("onlyoffice_product_target_method_unavailable");
              if (
                [command.title, command.description].every(
                  (value) => value == null,
                )
              )
                throw Error("onlyoffice_product_argument_invalid:alt_text");
              for (const key of ["title", "description"])
                if (
                  command[key] != null &&
                  (typeof command[key] !== "string" ||
                    command[key].length > 10000)
                )
                  throw Error("onlyoffice_product_argument_invalid:" + key);
              return { ...command, slideIndex: slide, nativeId: shape.Id };
            }
            if (command.op === "crop_image") {
              if (!shape.isImage?.() || typeof shape.setSrcRect !== "function")
                throw Error("onlyoffice_product_image_target_unavailable");
              for (const key of ["left", "top", "right", "bottom"])
                if (
                  !Number.isFinite(command[key]) ||
                  command[key] < 0 ||
                  command[key] >= 1
                )
                  throw Error("onlyoffice_product_argument_invalid:" + key);
              if (
                command.left + command.right >= 1 ||
                command.top + command.bottom >= 1
              )
                throw Error("onlyoffice_product_argument_invalid:crop_extent");
            }
            if (command.op === "set_object_lock") {
              if (
                typeof shape.setLockValue !== "function" ||
                typeof shape.getLockValue !== "function"
              )
                throw Error("onlyoffice_product_lock_target_unavailable");
              if (command.lockPosition == null && command.lockSize == null)
                throw Error("onlyoffice_product_argument_invalid:empty_lock");
              for (const key of ["lockPosition", "lockSize"])
                if (command[key] != null && typeof command[key] !== "boolean")
                  throw Error("onlyoffice_product_argument_invalid:" + key);
            }
            const methods = {
              move: "SetPosition",
              resize: "SetSize",
              rotate: "SetRotation",
              flip: "SetFlipH",
              set_shape_name: "SetName",
              fill_color: "SetFill",
              fill_opacity: "SetFill",
              line_opacity: "SetOutLine",
              line_color: "SetOutLine",
              line_width: "SetOutLine",
              set_line_style: "SetOutLine",
              delete_element: "Delete",
            };
            const d =
              window.AscBuilder.GetApiDrawing(shape) ??
              (shape.getObjectType?.() === window.AscDFH.historyitem_type_Cnx
                ? new window.AscBuilder.ApiShape(shape)
                : null);
            if (
              !d ||
              (methods[command.op] &&
                typeof d[methods[command.op]] !== "function")
            )
              throw Error("onlyoffice_product_target_method_unavailable");
            if (
              [
                "replace_text",
                "font_size",
                "font_family",
                "bold",
                "italic",
                "underline",
                "strikethrough",
                "font_color",
                "paragraph_alignment",
                "set_character_spacing",
                "set_script_position",
                "set_text_language",
              ].includes(command.op) &&
              !shape.getDocContent?.()
            )
              throw Error("onlyoffice_product_text_target_unavailable");
            const requireNumber = (key, min = -Infinity, max = Infinity) => {
              if (
                !Number.isFinite(command[key]) ||
                command[key] < min ||
                command[key] > max
              )
                throw Error("onlyoffice_product_argument_invalid:" + key);
            };
            if (command.op === "move") {
              requireNumber("x");
              requireNumber("y");
            }
            if (command.op === "resize") {
              requireNumber("width", 0.01);
              requireNumber("height", 0.01);
            }
            if (command.op === "rotate") requireNumber("degrees");
            if (command.op === "line_width") {
              requireNumber("size", 0, 100);
              if (!shape.spPr?.ln)
                throw Error(
                  "onlyoffice_product_line_width_requires_authored_outline",
                );
            }
            if (
              command.op === "paragraph_alignment" &&
              !["left", "center", "right", "justify"].includes(
                command.alignment,
              )
            )
              throw Error("onlyoffice_product_argument_invalid:alignment");
            if (command.op === "font_size") requireNumber("size", 1, 400);
            if (command.op === "set_text_language") {
              if (typeof command.languageTag !== "string")
                throw Error("onlyoffice_product_argument_invalid:languageTag");
              let tag;
              try {
                tag = Intl.getCanonicalLocales(command.languageTag)[0];
              } catch {
                throw Error("onlyoffice_product_argument_invalid:languageTag");
              }
              const language = window.Asc.g_oLcidNameToIdMap[tag];
              if (
                !Number.isSafeInteger(language) ||
                language < 1 ||
                window.Asc.g_oLcidIdToNameMap[language] !== tag
              )
                throw Error("onlyoffice_product_language_unavailable:" + tag);
              return {
                ...command,
                nativeId: shape.Id,
                slideIndex: slide,
                index,
                nativeLanguageId: language,
              };
            }
            if (["fill_opacity", "line_opacity"].includes(command.op)) {
              const fill =
                command.op === "fill_opacity"
                  ? shape.spPr?.Fill
                  : shape.spPr?.ln?.Fill;
              if (
                !fill?.fill?.color ||
                fill.fill.type !== window.Asc.c_oAscFill.FILL_TYPE_SOLID ||
                typeof fill.createDuplicate !== "function"
              )
                throw Error(
                  "onlyoffice_product_opacity_requires_authored_solid_fill",
                );
            }
            if (command.op === "set_line_style") {
              if (!shape.spPr?.ln)
                throw Error(
                  "onlyoffice_product_line_style_requires_authored_outline",
                );
              if (
                command.nativeLineStyle.dash != null &&
                window.Asc.c_oDashType[command.lineStyle.dash] !==
                  command.nativeLineStyle.dash
              )
                throw Error("onlyoffice_product_line_style_sdk_mismatch");
              const sdk = new window.AscFormat.EndArrow();
              for (const [key, native] of [
                ["startArrow", "headEnd"],
                ["endArrow", "tailEnd"],
              ]) {
                const requested = command.lineStyle[key];
                if (requested == null) continue;
                const wanted = command.nativeLineStyle[native];
                if (
                  wanted === null
                    ? sdk.GetTypeCode(requested.type) !== 0
                    : sdk.GetTypeCode(requested.type) !== wanted.type ||
                      sdk.GetSizeCode(requested.width ?? "med") !== wanted.w ||
                      sdk.GetSizeCode(requested.length ?? "med") !== wanted.len
                )
                  throw Error("onlyoffice_product_line_style_sdk_mismatch");
              }
            }
            if (command.op === "set_character_spacing") {
              requireNumber("spacing", -100, 100);
              if (
                Math.abs(
                  command.spacing * 100 - Math.round(command.spacing * 100),
                ) > 1e-8
              )
                throw Error(
                  "onlyoffice_product_argument_invalid:spacing_precision",
                );
            }
            if (
              command.op === "set_script_position" &&
              !["normal", "superscript", "subscript"].includes(command.script)
            )
              throw Error("onlyoffice_product_argument_invalid:script");
            if (command.op.endsWith("opacity"))
              requireNumber("opacity", 0, 100);
            if (
              ["fill_color", "line_color", "font_color"].includes(command.op) &&
              (!Number.isSafeInteger(command.color) ||
                command.color < 0 ||
                command.color > 0xffffff)
            )
              throw Error("onlyoffice_product_color_invalid");
            if (
              command.op === "replace_text" &&
              typeof command.text !== "string"
            )
              throw Error("onlyoffice_product_text_invalid");
            if (
              ["bold", "italic", "underline", "strikethrough"].includes(
                command.op,
              ) &&
              typeof command[command.op] !== "boolean"
            )
              throw Error("onlyoffice_product_argument_invalid:" + command.op);
            if (
              command.op === "font_family" &&
              (typeof command.family !== "string" || !command.family.trim())
            )
              throw Error("onlyoffice_product_argument_invalid:family");
            if (
              command.op === "flip" &&
              !["horizontal", "vertical"].includes(command.axis)
            )
              throw Error("onlyoffice_product_argument_invalid:axis");
            return { ...command, nativeId: shape.Id, slideIndex: slide, index };
          });
        },
        {
          commands: commands.map((command) =>
            command.op === "set_character_spacing"
              ? {
                  ...command,
                  nativeSpacingTwips: onlyOfficeCharacterSpacingTwips(
                    command.spacing,
                  ),
                }
              : ["fill_opacity", "line_opacity"].includes(command.op)
                ? {
                    ...command,
                    nativeOpacity: onlyOfficeOpacityNative(command.opacity),
                  }
                : command.op === "set_line_style"
                  ? {
                      ...command,
                      nativeLineStyle: onlyOfficeLineStylePatch(
                        command.lineStyle,
                      ),
                    }
                  : command,
          ),
          supported: onlyOfficeProductOperations,
        },
      );
      const text = commands
        .filter((c) =>
          ["replace_text", "set_speaker_notes", "set_table_cell"].includes(
            c.op,
          ),
        )
        .map((c) => c.text)
        .join("\n");
      if (text)
        await frame.evaluate(
          (text) =>
            new Promise((resolve) => {
              const picker = window.AscFonts?.FontPickerByCharacter;
              const loader = window.AscCommon?.g_font_loader;
              if (
                typeof picker?.getFontBySymbol !== "function" ||
                typeof loader?.LoadFonts !== "function"
              )
                throw Error("onlyoffice_product_character_fonts_unavailable");
              // checkText only loads newly discovered character ranges. A range
              // may already be known while its font bytes are still unavailable.
              // Load the registered fallback faces independently of that cache;
              // do not change the document's authored font family.
              const fonts = new Set();
              for (const character of text) {
                const name = picker.getFontBySymbol(character.codePointAt(0));
                if (
                  name &&
                  window.AscFonts.g_map_font_index[name] !== undefined
                )
                  fonts.add(name);
              }
              if (fonts.size) loader.LoadFonts([...fonts], resolve);
              else resolve();
            }),
          text,
        );
      return prepared;
    },
    begin: async () => {
      const frame = await getFrame();
      const checkpoint = await beginCandidateTransaction(frame);
      // SDK group mutations temporarily unlock its UI. Keep it locked across
      // asynchronous observation, file admission and journal writes.
      await frame.evaluate(() => window.Asc.editor.executeGroupActionsEnd());
      return { frame, checkpoint };
    },
    finish: async (token, commit) =>
      finishCandidateTransaction(token.frame, token.checkpoint, commit),
    apply: async (command) => {
      const frame = await getFrame();
      const result = await frame.evaluate((command) => {
        const editor = window.Asc.editor;
        if (!editor.isGroupActions())
          throw Error("onlyoffice_product_transaction_required");
        editor.executeGroupActionsStart();
        try {
          const api = window.AscBuilder.Slide.Api,
            p = api.GetPresentation(),
            slide = p.GetSlideByIndex(command.slideIndex);
          if (command.op === "set_reading_order") {
            if (
              slide?.Slide.Id !== command.nativeId ||
              slide.Slide.cSld.spTree.length !== command.nativeIds.length
            )
              throw Error("onlyoffice_product_live_binding_changed");
            const shapes = command.nativeIds.map((id) =>
              slide.Slide.cSld.spTree.find((s) => s.Id === id),
            );
            if (shapes.some((s) => !s))
              throw Error("onlyoffice_product_live_binding_changed");
            editor.WordControl.GoToPage(command.slideIndex);
            p.CreateNewHistoryPoint();
            const controller = slide.Slide.graphicObjects;
            try {
              for (const shape of shapes) {
                controller.resetSelection();
                controller.selectObject(shape, command.slideIndex);
                controller.bringToFront();
              }
            } finally {
              window.AscCommon.IsChangingDrawingZIndex = false;
            }
            return true;
          }
          const replaceContent = (c, text) => {
            if (!c) throw Error("onlyoffice_product_text_unavailable");
            const first = c.GetAllParagraphs()[0];
            const properties =
              first?.GetElement(0)?.GetTextPr?.() ?? first?.GetTextPr();
            const paragraphProperties = first?.GetParaPr();
            const endProperties = first?.GetTextPr();
            // Keep the existing first paragraph's inheritance and end marker.
            // Replacing the whole content creates new paragraph defaults.
            for (let index = c.GetElementsCount() - 1; index > 0; index--)
              if (!c.RemoveElement(index))
                throw Error("onlyoffice_product_native_rejected");
            first.RemoveAllElements();
            // AddText writes a run: embedded LF is not a document paragraph.
            // Materialize each canonical line as a real native paragraph.
            for (const [index, line] of text
              .replace(/\r\n/g, "\n")
              .split("\n")
              .entries()) {
              const paragraph =
                index === 0 ? c.GetElement(0) : api.CreateParagraph();
              if (index) {
                if (endProperties) paragraph.SetTextPr(endProperties);
                if (paragraphProperties)
                  paragraph.Paragraph.Set_Pr(paragraphProperties.ParaPr.Copy());
              }
              // Existing paragraphs retain their native empty run. Newly
              // created paragraphs have no run until the first AddText call.
              const run = paragraph.GetElement(0);
              if (run && typeof run.AddText === "function") {
                if (properties && !run.SetTextPr(properties))
                  throw Error("onlyoffice_product_native_rejected");
                if (!run.AddText(line))
                  throw Error("onlyoffice_product_native_rejected");
              } else if (index) {
                if (properties && !paragraph.SetTextPr(properties))
                  throw Error("onlyoffice_product_native_rejected");
                if (!paragraph.AddText(line))
                  throw Error("onlyoffice_product_native_rejected");
              } else throw Error("onlyoffice_product_empty_run_unavailable");
              if (index && !c.Push(paragraph))
                throw Error("onlyoffice_product_native_rejected");
            }
            return true;
          };
          if (
            [
              "rename_slide",
              "set_slide_hidden",
              "set_background",
              "set_speaker_notes",
            ].includes(command.op)
          ) {
            if (slide?.Slide.Id !== command.nativeId)
              throw Error("onlyoffice_product_live_binding_changed");
            editor.WordControl.GoToPage(command.slideIndex);
            p.CreateNewHistoryPoint();
            if (command.op === "set_slide_hidden")
              return slide.SetVisible(!command.hidden);
            if (command.op === "set_background")
              return slide.SetBackground(
                api.CreateSolidFill(
                  api.CreateRGBColor(
                    (command.color >>> 16) & 255,
                    (command.color >>> 8) & 255,
                    command.color & 255,
                  ),
                ),
              );
            if (command.op === "set_speaker_notes") {
              let notes = slide.Slide.notes;
              if (!notes) {
                notes = window.AscCommonSlide.CreateNotes();
                notes.setNotesMaster(
                  editor.WordControl.m_oLogicDocument.notesMasters[0],
                );
                notes.setSlide(slide.Slide);
                slide.Slide.setNotes(notes);
              }
              const body = notes.getBodyShape() ?? notes.createBodyShape();
              const wrapper = new window.AscBuilder.ApiShape(body);
              return replaceContent(wrapper.GetDocContent(), command.text);
            }
            slide.Slide.setCSldName(command.name);
            return true;
          }
          if (command.op === "set_alt_text") {
            const shape = slide?.Slide.cSld.spTree.find(
              (shape) => shape.Id === command.nativeId,
            );
            const properties = shape?.getCNvProps?.();
            if (!properties)
              throw Error("onlyoffice_product_live_binding_changed");
            editor.WordControl.GoToPage(command.slideIndex);
            p.CreateNewHistoryPoint();
            if (command.title != null) properties.setTitle(command.title);
            if (command.description != null)
              properties.setDescr(command.description);
            return true;
          }
          const native = slide?.Slide.cSld.spTree.find(
            (shape) => shape.Id === command.nativeId,
          );
          const d =
            native &&
            (window.AscBuilder.GetApiDrawing(native) ??
              (native.getObjectType?.() === window.AscDFH.historyitem_type_Cnx
                ? new window.AscBuilder.ApiShape(native)
                : null));
          if (!d) throw Error("onlyoffice_product_live_binding_changed");
          editor.WordControl.GoToPage(command.slideIndex);
          p.CreateNewHistoryPoint();
          const color = () =>
            api.CreateRGBColor(
              (command.color >>> 16) & 255,
              (command.color >>> 8) & 255,
              command.color & 255,
            );
          const fill = () => api.CreateSolidFill(color());
          const content = () => {
            const c = d.GetDocContent();
            if (!c) throw Error("onlyoffice_product_text_unavailable");
            return c;
          };
          switch (command.op) {
            case "z_order": {
              const controller = slide.Slide.graphicObjects;
              controller.resetSelection();
              controller.selectObject(native, command.slideIndex);
              const method = {
                front: "bringToFront",
                forward: "bringForward",
                back: "sendToBack",
                backward: "bringBackward",
              }[command.position];
              try {
                controller[method]();
              } finally {
                window.AscCommon.IsChangingDrawingZIndex = false;
              }
              return true;
            }
            case "move":
              return d.SetPosition(command.x * 360, command.y * 360);
            case "resize":
              return d.SetSize(command.width * 360, command.height * 360);
            case "rotate":
              return d.SetRotation(command.degrees);
            case "flip":
              if (command.axis === "horizontal")
                return d.SetFlipH(!d.GetFlipH());
              if (command.axis === "vertical") return d.SetFlipV(!d.GetFlipV());
              throw Error("onlyoffice_product_flip_axis_invalid");
            case "set_shape_name":
              return d.SetName(command.name);
            case "fill_color":
              return d.SetFill(fill());
            case "line_color": {
              const stroke = api.CreateStroke(
                d.Drawing.spPr?.ln?.w ?? 36000,
                fill(),
              );
              const original = d.Drawing.spPr?.ln;
              if (original) {
                stroke.Ln = original.createDuplicate();
                stroke.Ln.setFill(fill().UniFill);
              }
              return d.SetOutLine(stroke);
            }
            case "fill_opacity": {
              const original = d.Drawing.spPr.Fill;
              const changed = original.createDuplicate();
              changed.transparent = command.nativeOpacity;
              const wrapper = api.CreateNoFill();
              wrapper.UniFill = changed;
              return d.SetFill(wrapper);
            }
            case "line_opacity": {
              const original = d.Drawing.spPr.ln;
              const stroke = api.CreateStroke(
                original.w ?? 36000,
                api.CreateNoFill(),
              );
              stroke.Ln = original.createDuplicate();
              stroke.Ln.Fill.transparent = command.nativeOpacity;
              return d.SetOutLine(stroke);
            }
            case "set_line_style": {
              const original = d.Drawing.spPr?.ln;
              if (!original)
                throw Error(
                  "onlyoffice_product_line_style_requires_authored_outline",
                );
              const stroke = api.CreateStroke(
                original.w ?? 36000,
                api.CreateNoFill(),
              );
              stroke.Ln = original.createDuplicate();
              for (const [key, value] of Object.entries(
                command.nativeLineStyle,
              )) {
                if (key === "dash") stroke.Ln.setPrstDash(value);
                else {
                  const arrow =
                    value === null ? null : new window.AscFormat.EndArrow();
                  if (arrow) {
                    arrow.setType(value.type);
                    arrow.setW(value.w);
                    arrow.setLen(value.len);
                  }
                  if (key === "headEnd") stroke.Ln.setHeadEnd(arrow);
                  else stroke.Ln.setTailEnd(arrow);
                }
              }
              return d.SetOutLine(stroke);
            }
            case "line_width": {
              const original = d.Drawing.spPr?.ln;
              if (!original)
                throw Error(
                  "onlyoffice_product_line_width_requires_authored_outline",
                );
              const stroke = api.CreateStroke(
                Math.round(command.size * 36000),
                api.CreateNoFill(),
              );
              stroke.Ln = original.createDuplicate();
              stroke.Ln.setW(Math.round(command.size * 36000));
              return d.SetOutLine(stroke);
            }
            case "paragraph_alignment": {
              const paragraphs = content().GetAllParagraphs();
              if (!paragraphs.length)
                throw Error("onlyoffice_product_text_unavailable");
              for (const paragraph of paragraphs)
                if (
                  !paragraph
                    .GetParaPr()
                    .SetJc(
                      command.alignment === "justify"
                        ? "both"
                        : command.alignment,
                    )
                )
                  throw Error("onlyoffice_product_native_rejected");
              return true;
            }
            case "delete_element":
              return d.Delete();
            case "crop_image": {
              const rectangle = new window.AscFormat.CSrcRect();
              rectangle.l = command.left * 100;
              rectangle.t = command.top * 100;
              rectangle.r = (1 - command.right) * 100;
              rectangle.b = (1 - command.bottom) * 100;
              d.Drawing.setSrcRect(rectangle);
              return true;
            }
            case "set_object_lock": {
              if (command.lockPosition != null)
                d.Drawing.setLockValue(
                  window.AscFormat.LOCKS_MASKS.noMove,
                  command.lockPosition,
                );
              if (command.lockSize != null)
                d.Drawing.setLockValue(
                  window.AscFormat.LOCKS_MASKS.noResize,
                  command.lockSize,
                );
              return true;
            }
            case "insert_table_rows": {
              for (let i = 0; i < command.count; i++) {
                const last = d.Table.Content.length;
                const append = command.index === last;
                const cell = d
                  .GetRow(append ? last - 1 : command.index)
                  .GetCell(0);
                if (!d.AddRow(cell, !append))
                  throw Error("onlyoffice_product_native_rejected");
              }
              return true;
            }
            case "delete_table_rows": {
              for (let i = 0; i < command.count; i++) {
                const cell = d.GetRow(command.index).GetCell(0);
                d.RemoveRow(cell);
              }
              return true;
            }
            case "set_table_column_width": {
              const table = d.Table;
              // SetColumnWidth rebuilds the whole grid from subtracted running
              // totals, introducing rounding loss in untouched columns. Keep
              // the authored grid and update only the requested column through
              // the same native history setter used by that implementation.
              const grid = table.TableGrid.slice();
              grid[command.index] = command.width / 100;
              table.SetTableGrid(grid);
              for (const row of table.Content) {
                const cell = row.Content[command.index],
                  preferred = cell.Get_W();
                if (preferred.Type === 1 || preferred.Type === 3) {
                  preferred.Type = 1;
                  preferred.W = command.width / 100;
                  cell.Set_W(preferred);
                }
              }
              d.Drawing.spPr.xfrm.setExtX(
                grid.reduce((sum, width) => sum + width, 0),
              );
              return true;
            }
            case "set_table_row_height": {
              const row = d.GetRow(command.index);
              if (!row) throw Error("onlyoffice_product_live_binding_changed");
              // The public builder subtracts cell insets from a presentation
              // row's height, but the native row and saved a:tr/@h are already
              // the physical grid height. Use the existing native history setter.
              row.Row.Set_Height(
                command.height / 100,
                window.Asc.linerule_AtLeast,
              );
              return true;
            }
            case "set_table_cell": {
              const cell = d.GetRow(command.row)?.GetCell(command.column);
              if (!cell) throw Error("onlyoffice_product_live_binding_changed");
              return replaceContent(cell.GetContent(), command.text);
            }
            case "replace_text":
              return replaceContent(content(), command.text);
            case "font_size":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetFontSize(command.size * 2));
            case "set_character_spacing":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetSpacing(command.nativeSpacingTwips));
            case "set_script_position":
              return content()
                .GetAllParagraphs()
                .forEach((p) =>
                  p.SetVertAlign(
                    command.script === "normal" ? "baseline" : command.script,
                  ),
                );
            case "font_family":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetFontFamily(command.family));
            case "bold":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetBold(command.bold));
            case "italic":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetItalic(command.italic));
            case "underline":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetUnderline(command.underline));
            case "strikethrough":
              return content()
                .GetAllParagraphs()
                .forEach((p) => {
                  p.Paragraph.SetApplyToAll(true);
                  try {
                    p.Paragraph.Add(
                      new window.AscCommonWord.ParaTextPr({
                        Strikeout: command.strikethrough,
                      }),
                    );
                  } finally {
                    p.Paragraph.SetApplyToAll(false);
                  }
                });
            case "font_color": {
              // Presentation export uses the native run fill, whereas the shared
              // paragraph RGB setter can update only the Word-style Color field.
              // Keep the change in the provider's own history-aware setters.
              const setColor = (run) => {
                if (typeof run?.Set_Unifill === "function") {
                  run.Set_Unifill(fill().UniFill);
                  run.Set_Color?.(undefined);
                  run.Set_TextFill?.(undefined);
                }
                run.Content?.forEach(setColor);
              };
              for (const paragraph of content().GetAllParagraphs()) {
                setColor(paragraph.Paragraph.TextPr);
                paragraph.Paragraph.Content.forEach(setColor);
              }
              return true;
            }
            case "set_text_language": {
              const setLanguage = (run) => {
                // Set_Lang replaces EastAsia/Bidi too. Change only the primary
                // PPTX run language through its own native history setter.
                run?.Set_Lang_Val?.(command.nativeLanguageId);
                run?.Content?.forEach(setLanguage);
              };
              for (const paragraph of content().GetAllParagraphs()) {
                setLanguage(paragraph.Paragraph.TextPr);
                paragraph.Paragraph.Content.forEach(setLanguage);
              }
              return true;
            }
            default:
              throw Error(
                "onlyoffice_product_operation_unavailable:" + command.op,
              );
          }
        } finally {
          editor.executeGroupActionsEnd();
        }
      }, command);
      if (result === false) throw Error("onlyoffice_product_native_rejected");
      await frame.evaluate((nativeId) => {
        const h = window.AscCommon.History,
          m = window.Asc.editor.WordControl.m_oLogicDocument;
        const target = m.Slides.flatMap((s) => s.cSld.spTree).find(
          (x) => x.Id === nativeId,
        );
        target?.getDocContent?.()?.Recalc_AllParagraphs_CompiledPr?.();
        if (target?.isTable?.()) {
          for (const row of target.graphicObject.Content)
            for (const cell of row.Content)
              cell.Content.Recalc_AllParagraphs_CompiledPr();
          target.Refresh_RecalcData2();
        }
        target?.recalcText?.();
        target?.recalculate?.();
        m.Recalculate(h.Get_RecalcData(null, h.getGroupChanges()));
        m.RedrawCurSlide();
        m.Document_UpdateInterfaceState();
      }, command.nativeId);
      return true;
    },
    snapshot,
    bindArtifact,
    undo: async () =>
      (await getFrame()).evaluate(() => window.Asc.editor.Undo()),
    redo: async () =>
      (await getFrame()).evaluate(() => window.Asc.editor.Redo()),
  };
}
