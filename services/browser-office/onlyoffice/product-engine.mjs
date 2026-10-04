/* SPDX-License-Identifier: MPL-2.0 */
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
  const slides = projection.common.slides.map((slide, slideIndex) => ({
    slideIndex,
    elements: slide.shapes.map((shape, index) => ({
      elementId: slideIndex + "/" + index,
      kind: shape.type,
      text: shape.text,
      x: shape.x * 100,
      y: shape.y * 100,
      width: shape.w * 100,
      height: shape.h * 100,
      objectName: shape.ownName,
      onlyoffice: shape,
    })),
    onlyoffice: projection.extended.slides[slideIndex],
    narrow: projection.narrow[slideIndex],
  }));
  const state = {
    slides,
    masters: [],
    sections: [],
    width: projection.extended.width,
    height: projection.extended.height,
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

export const onlyOfficeProductOperations = Object.freeze([
  "move",
  "resize",
  "rotate",
  "flip",
  "set_shape_name",
  "fill_color",
  "line_color",
  "delete_element",
  "replace_text",
  "font_size",
  "font_family",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "font_color",
]);

export function createOnlyOfficeProductEngine({
  getFrame,
  open,
  inspect,
  snapshot,
}) {
  return {
    open,
    inspect,
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
              set_alt_text: "SetDescription",
              fill_color: "SetFill",
              line_color: "SetOutLine",
              line_width: "SetOutLine",
              fill_opacity: "SetFill",
              line_opacity: "SetOutLine",
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
              !/^#[\da-f]{6}$/i.test(command.color ?? "")
            )
              throw Error("onlyoffice_product_color_invalid");
            if (
              command.op === "replace_text" &&
              typeof command.text !== "string"
            )
              throw Error("onlyoffice_product_text_invalid");
            return { ...command, nativeId: shape.Id, slideIndex: slide, index };
          });
        },
        { commands, supported: onlyOfficeProductOperations },
      );
    },
    begin: async () => {
      const frame = await getFrame();
      return { frame, checkpoint: await beginCandidateTransaction(frame) };
    },
    finish: async (token, commit) =>
      finishCandidateTransaction(token.frame, token.checkpoint, commit),
    apply: async (command) => {
      const frame = await getFrame();
      const result = await frame.evaluate((command) => {
        const api = window.AscBuilder.Slide.Api,
          p = api.GetPresentation(),
          slide = p.GetSlideByIndex(command.slideIndex);
        const d = slide
          .GetAllDrawings()
          .find((d) => d.Drawing?.Id === command.nativeId);
        if (!d) throw Error("onlyoffice_product_live_binding_changed");
        window.Asc.editor.WordControl.Thumbnails.SelectPage(command.slideIndex);
        p.CreateNewHistoryPoint();
        const color = () =>
          api.CreateRGBColor(
            ...command.color
              .slice(1)
              .match(/../g)
              .map((v) => parseInt(v, 16)),
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
            if (command.axis === "horizontal") return d.SetFlipH(!d.GetFlipH());
            if (command.axis === "vertical") return d.SetFlipV(!d.GetFlipV());
            throw Error("onlyoffice_product_flip_axis_invalid");
          case "set_shape_name":
            return d.SetName(command.name);
          case "fill_color":
            return d.SetFill(fill());
          case "line_color":
            return d.SetOutLine(
              api.CreateStroke(d.Drawing.spPr?.ln?.w ?? 36000, fill()),
            );
          case "delete_element":
            return d.Delete();
          case "replace_text": {
            const c = content();
            c.RemoveAllElements();
            return c.GetElement(0).AddText(command.text);
          }
          case "font_size":
            return content()
              .GetAllParagraphs()
              .forEach((p) => p.SetFontSize(command.size));
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
              .forEach((p) => p.SetStrikeout(command.strikethrough));
          case "font_color":
            return content()
              .GetAllParagraphs()
              .forEach((p) => p.SetColor(color()));
          default:
            throw Error(
              "onlyoffice_product_operation_unavailable:" + command.op,
            );
        }
      }, command);
      if (result === false) throw Error("onlyoffice_product_native_rejected");
      await frame.evaluate((nativeId) => {
        const h = window.AscCommon.History,
          m = window.Asc.editor.WordControl.m_oLogicDocument;
        const target = m.Slides.flatMap((s) => s.cSld.spTree).find(
          (x) => x.Id === nativeId,
        );
        target?.recalculate?.();
        m.Recalculate(h.Get_RecalcData(null, h.getGroupChanges()));
        m.RedrawCurSlide();
        m.Document_UpdateInterfaceState();
      }, command.nativeId);
      return result;
    },
    snapshot,
    undo: async () =>
      (await getFrame()).evaluate(() => window.Asc.editor.Undo()),
    redo: async () =>
      (await getFrame()).evaluate(() => window.Asc.editor.Redo()),
  };
}
