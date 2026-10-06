/* SPDX-License-Identifier: MPL-2.0 */
const canonical = (value) => JSON.stringify(order(value));
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

export function assertServiceObservation(observation, request) {
  let expected;
  try {
    expected = JSON.parse(request.expectedSlides);
  } catch {
    throw Error("stale_service_observation");
  }
  if (
    request.expectedRevision !== observation.revision ||
    canonical(expected) !== canonical(observation.slides)
  )
    throw Error("stale_service_observation");
}

export function assertWorkspacePermission(commands, permission, operations) {
  if (
    !permission ||
    !["document", "slides", "selection"].includes(permission.mode)
  )
    throw Error("outside_edit_permission");
  for (const command of commands) {
    const target = operations[command.op]?.target;
    if (!target) throw Error("unsupported_operation");
    if (permission.mode === "document") continue;
    if (["document", "master"].includes(target))
      throw Error("outside_edit_permission");
    const ids = Array.isArray(command.elementIds)
      ? command.elementIds
      : typeof command.elementId === "string"
        ? [command.elementId]
        : [];
    const slides = ids.length
      ? ids.map((id) => Number(id.split("/")[0]))
      : [command.slideIndex];
    if (command.op === "move_slide") {
      const start = Math.min(command.slideIndex, command.targetSlideIndex),
        end = Math.max(command.slideIndex, command.targetSlideIndex);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end - start > 10000
      )
        throw Error("outside_edit_permission");
      for (let i = start; i <= end; i++) slides.push(i);
    }
    if (
      permission.mode === "slides" &&
      slides.every(
        (slide) =>
          Number.isSafeInteger(slide) &&
          permission.slideIndexes?.includes(slide),
      )
    )
      continue;
    if (
      permission.mode === "selection" &&
      ids.length &&
      ids.every((id) => permission.elementIds?.includes(id))
    )
      continue;
    throw Error("outside_edit_permission");
  }
}

export function onlyOfficeElement(observation, elementId) {
  if (typeof elementId !== "string" || !/^\d+(?:\/\d+)+$/.test(elementId))
    throw Error("invalid_element_id");
  const [slide, ...indexes] = elementId.split("/").map(Number);
  let element = observation.slides[slide];
  for (const index of indexes) element = element?.elements?.[index];
  if (!element || element.elementId !== elementId)
    throw Error("element_missing");
  return element;
}

export function onlyOfficeTextDetails(observation, request) {
  if (
    !Number.isSafeInteger(request.slideIndex) ||
    !observation.slides[request.slideIndex] ||
    !Array.isArray(request.expectedElements)
  )
    throw Error("invalid_detail_slide");
  const elements = request.expectedElements.map((expected) => {
    if (
      Number(expected?.elementId?.split("/")[0]) !== request.slideIndex ||
      typeof expected.text !== "string"
    )
      throw Error("invalid_detail_element");
    const element = onlyOfficeElement(observation, expected.elementId);
    if (element.text !== expected.text) throw Error("stale_detail_element");
    const [slideIndex, ...path] = element.elementId.split("/").map(Number);
    let drawings = observation.slides[slideIndex].onlyoffice?.drawings,
      drawing;
    for (const index of path) {
      drawing = drawings?.[index];
      drawings = drawing?.groupChildren;
    }
    if (!Array.isArray(drawing?.paragraphs))
      throw Error("unavailable_detail_element");
    let offset = 0;
    const paragraphs = drawing.paragraphs.map((paragraph, paragraphIndex) => {
      const startOffset = offset;
      const portions = paragraph.runs.map((run, portionIndex) => {
        const startOffset = offset;
        offset += run.text.length;
        const style = run.style ?? {},
          rgb = style.color?.rgb;
        const color =
          rgb && [rgb.r, rgb.g, rgb.b].every(Number.isFinite)
            ? (rgb.r << 16) | (rgb.g << 8) | rgb.b
            : null;
        return {
          ...style,
          fontFamily:
            typeof style.fonts?.[0] === "string" ? style.fonts[0] : null,
          fontSize:
            typeof style.GetFontSize === "number"
              ? style.GetFontSize / 2
              : null,
          bold: style.GetBold,
          italic: style.GetItalic,
          underline: style.GetUnderline,
          strikethrough: style.GetStrikeout,
          color,
          characterSpacing: style.characterSpacing,
          rangeId: `${element.elementId}:p${paragraphIndex}:r${portionIndex}`,
          portionIndex,
          startOffset,
          endOffset: offset,
          text: run.text,
          ...(run.field ? { field: run.field } : {}),
        };
      });
      // The SDK paragraph terminator is transport syntax. The canonical text
      // range addresses authored characters and one paragraph newline.
      const text = paragraph.text.replace(/\r\n$/, "\n");
      offset = startOffset + text.length;
      return {
        ...paragraph.format,
        paragraphId: `${element.elementId}:p${paragraphIndex}`,
        paragraphIndex,
        startOffset,
        endOffset: offset,
        text,
        alignment: paragraph.alignment,
        portions,
      };
    });
    return { elementId: element.elementId, text: element.text, paragraphs };
  });
  return { slideIndex: request.slideIndex, elements };
}

export async function undoOnlyOfficeTurn(session, request) {
  const { steps, expectedRevision, targetRevision } = request;
  if (
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 50 ||
    typeof expectedRevision !== "string" ||
    typeof targetRevision !== "string"
  )
    throw Error("invalid_undo_request");
  const before = await session.observe();
  if (before.revision !== expectedRevision)
    throw Error("document_changed_since_turn");
  if (session.status().undo < steps) throw Error("undo_history_missing");
  let undone = 0;
  try {
    for (; undone < steps; undone++)
      if (!(await session.undo())) throw Error("undo_history_missing");
    const after = await session.observe();
    if (after.revision !== targetRevision) throw Error("undo_result_mismatch");
    return {
      ...after,
      undone,
      changedSlideIndexes: [],
      images: [],
      visualEvidenceComplete: true,
    };
  } catch (error) {
    try {
      while (undone > 0) {
        if (!(await session.redo())) throw Error("redo_history_missing");
        undone--;
      }
      if ((await session.observe()).revision !== before.revision)
        throw Error("undo_restore_revision_mismatch");
    } catch (restoreError) {
      throw Error("undo_result_mismatch_not_restored", { cause: restoreError });
    }
    throw error;
  }
}
