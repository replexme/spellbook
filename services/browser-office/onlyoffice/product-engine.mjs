/* SPDX-License-Identifier: MPL-2.0 */
import {
  onlyOfficeIntentOperations,
  verifyOnlyOfficeProductIntent,
} from "./product-intent.mjs";
import { observeOnlyOfficeCandidate } from "../onlyoffice-observation.mjs";
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
      element(shape, slideIndex + "/" + index),
    ),
    onlyoffice: {
      ...projection.extended.slides[slideIndex],
      drawings: projection.extended.slides[slideIndex].drawings.map(drawing),
    },
    narrow: projection.narrow[slideIndex],
  }));
  const state = {
    slides,
    masters: [],
    sections: [],
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
export function verifyOnlyOfficeProductObservation(expected, actual) {
  const strip = (value) => {
    const copy = structuredClone(value);
    delete copy.revision;
    return copy;
  };
  const difference = firstDocumentStateDifference(
    strip(expected),
    strip(actual),
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
    verifyIntent: verifyOnlyOfficeProductIntent,
    observe: async () => observeOnlyOfficeProduct(await getFrame()),
    preflight: async (commands) => {
      const frame = await getFrame();
      return frame.evaluate(
        ({ commands, supported }) => {
          const m = window.Asc.editor.WordControl.m_oLogicDocument;
          return commands.map((command) => {
            if (!supported.includes(command.op))
              throw Error(
                "onlyoffice_product_operation_unavailable:" + command.op,
              );
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
            const methods = {
              move: "SetPosition",
              resize: "SetSize",
              rotate: "SetRotation",
              flip: "SetFlipH",
              set_shape_name: "SetName",
              fill_color: "SetFill",
              line_color: "SetOutLine",
              delete_element: "Delete",
            };
            const d = window.AscBuilder.Slide.Api.GetPresentation()
              .GetSlideByIndex(slide)
              .GetAllDrawings()
              .find((d) => d.Drawing === shape);
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
            if (command.op === "line_width") requireNumber("size", 0);
            if (command.op === "font_size") requireNumber("size", 1, 400);
            if (command.op.endsWith("opacity")) requireNumber("opacity", 0, 1);
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
        { commands, supported: onlyOfficeProductOperations },
      );
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
          const d = slide
            .GetAllDrawings()
            .find((d) => d.Drawing?.Id === command.nativeId);
          if (!d) throw Error("onlyoffice_product_live_binding_changed");
          window.Asc.editor.WordControl.Thumbnails.SelectPage(
            command.slideIndex,
          );
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
            case "delete_element":
              return d.Delete();
            case "replace_text": {
              const c = content(),
                first = c.GetAllParagraphs()[0];
              const properties =
                first?.GetElement(0)?.GetTextPr?.() ?? first?.GetTextPr();
              const paragraphProperties = first?.GetParaPr();
              c.RemoveAllElements();
              const paragraph = c.GetElement(0);
              if (properties) paragraph.SetTextPr(properties);
              if (paragraphProperties)
                paragraph.Paragraph.Set_Pr(paragraphProperties.ParaPr.Copy());
              return paragraph.AddText(command.text);
            }
            case "font_size":
              return content()
                .GetAllParagraphs()
                .forEach((p) => p.SetFontSize(command.size * 2));
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
