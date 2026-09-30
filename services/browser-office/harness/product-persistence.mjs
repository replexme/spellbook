import {
  intendedDocumentMutationDifferences,
  normalizeDocumentPersistenceState,
} from "../../office-session-spike/persistence-evidence.mjs";

/* SPDX-License-Identifier: MPL-2.0 */

// A save must describe the model revision that was observed. The browser
// engine counts modifications and Undo/Redo events; a changed count makes
// an export stale even when a later semantic comparison looks equivalent.
export function assertNativeSnapshotVersion(expected, before, after) {
  if (
    expected !== null &&
    expected !== undefined &&
    !Number.isSafeInteger(expected)
  )
    throw new Error("browser_native_snapshot_version_invalid");
  if (
    Number.isSafeInteger(expected) &&
    (before !== expected || after !== expected)
  )
    throw new Error("browser_native_document_changed_during_snapshot");
  if (
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    before !== after
  )
    throw new Error("browser_native_document_changed_during_snapshot");
}

// A package-only edit must survive an Office reload before it enters the
// browser journal. Compare authored identity and order, then verify the
// inspector's derived slideCount against the complete saved slide order.
export function persistedSectionsMatch(expected, observed, slideCount) {
  if (!Array.isArray(expected) || !Array.isArray(observed)) return false;
  if (!Number.isSafeInteger(slideCount) || slideCount < 0) return false;
  if (expected.length !== observed.length) return false;
  return expected.every((section, index) => {
    const saved = observed[index];
    return (
      saved &&
      typeof section?.id === "string" &&
      typeof saved.id === "string" &&
      section.id.toUpperCase() === saved.id.toUpperCase() &&
      section.name === saved.name &&
      section.startSlideIndex === saved.startSlideIndex &&
      saved.slideCount ===
        (expected[index + 1]?.startSlideIndex ?? slideCount) -
          section.startSlideIndex
    );
  });
}

// Package topology is the authority for slide identity. A slide-count-only
// readback would accept a move that did not move anything, or a delete that
// removed the wrong slide.
export function persistedSlideTopologyMatches(command, before, after) {
  if (
    !command ||
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.some((id) => typeof id !== "string" || !id) ||
    after.some((id) => typeof id !== "string" || !id) ||
    new Set(before).size !== before.length ||
    new Set(after).size !== after.length
  )
    return false;
  const sourceIndex = command.slideIndex;
  const insertIndex = command.insertIndex;
  let expected;
  switch (command.op) {
    case "add_slide":
    case "duplicate_slide":
      if (
        !Number.isSafeInteger(insertIndex) ||
        insertIndex < 0 ||
        insertIndex > before.length ||
        after.length !== before.length + 1 ||
        before.includes(after[insertIndex])
      )
        return false;
      expected = after.filter((_, index) => index !== insertIndex);
      return (
        expected.length === before.length &&
        expected.every((id, index) => id === before[index])
      );
    case "delete_slide":
      if (
        !Number.isSafeInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= before.length
      )
        return false;
      expected = before.filter((_, index) => index !== sourceIndex);
      break;
    case "move_slide":
      if (
        !Number.isSafeInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= before.length ||
        !Number.isSafeInteger(insertIndex) ||
        insertIndex < 0 ||
        insertIndex >= before.length
      )
        return false;
      expected = before.slice();
      expected.splice(insertIndex, 0, expected.splice(sourceIndex, 1)[0]);
      break;
    default:
      return false;
  }
  return (
    expected.length === after.length &&
    expected.every((id, index) => id === after[index])
  );
}

// Empty paragraphs can switch between direct and inherited UNO spacing while
// retaining exactly the same values. For direct-edit scope, compare those
// values on both sides; independent default masks would turn 0 into absence
// on just one side. Keep the provenance in the original observations for the
// separate save/reopen comparison, where inherited defaults may recalculate.
export function normalizeDirectEditPersistenceState(state) {
  const comparable = structuredClone(state);
  for (const slide of comparable?.slides ?? [])
    for (const element of slide.elements ?? []) {
      if (element.text !== "") continue;
      for (const paragraph of element.paragraphFormats ?? []) {
        if (!paragraph.propertyStates) continue;
        delete paragraph.propertyStates.topMargin;
        delete paragraph.propertyStates.bottomMargin;
      }
    }
  return normalizeDocumentPersistenceState(comparable);
}

// A direct text edit can be scoped to its one named slide shape. Other manual
// changes retain the broad human budget because their intended package reach
// cannot be inferred from a text-only observation.
export function directTextPreservationTarget(before, after) {
  if (
    !Array.isArray(before?.slides) ||
    !Array.isArray(after?.slides) ||
    before.slides.length !== after.slides.length
  )
    return null;
  const baseline = structuredClone(before);
  const edited = structuredClone(after);
  let target = null;
  for (
    let slideIndex = 0;
    slideIndex < baseline.slides.length;
    slideIndex += 1
  ) {
    const beforeElements = baseline.slides[slideIndex]?.elements;
    const afterElements = edited.slides[slideIndex]?.elements;
    if (!Array.isArray(beforeElements) || !Array.isArray(afterElements))
      return null;
    if (beforeElements.length !== afterElements.length) return null;
    for (let index = 0; index < beforeElements.length; index += 1) {
      const beforeElement = beforeElements[index];
      const afterElement = afterElements[index];
      if (beforeElement?.text === afterElement?.text) continue;
      if (
        target ||
        typeof beforeElement?.text !== "string" ||
        typeof afterElement?.text !== "string" ||
        typeof beforeElement?.name !== "string" ||
        !beforeElement.name ||
        beforeElement.name !== afterElement?.name ||
        beforeElement.elementId !== afterElement?.elementId ||
        beforeElement.parentElementId !== null ||
        !Number.isSafeInteger(beforeElement.zIndex) ||
        beforeElement.zIndex < 0
      )
        return null;
      target = {
        op: "replace_text",
        slideIndex,
        name: beforeElement.name,
        shapeIndex: beforeElement.zIndex,
      };
      // Filling or clearing a placeholder changes this derived engine flag
      // along with its text. It is not a second authored edit.
      if (
        typeof beforeElement.emptyPresentationObject === "boolean" ||
        typeof afterElement.emptyPresentationObject === "boolean"
      ) {
        if (
          typeof beforeElement.emptyPresentationObject !== "boolean" ||
          typeof afterElement.emptyPresentationObject !== "boolean" ||
          beforeElement.emptyPresentationObject !==
            (beforeElement.text.length === 0) ||
          afterElement.emptyPresentationObject !==
            (afterElement.text.length === 0)
        )
          return null;
        beforeElement.emptyPresentationObject =
          afterElement.emptyPresentationObject;
      }
      if (beforeElement.text.length === 0 && afterElement.text.length > 0) {
        // A placeholder has no text runs to describe until the first input.
        // The engine then materializes its inherited paragraph/run defaults.
        // Reopening the merged file must still match the complete live model.
        beforeElement.paragraphFormats = afterElement.paragraphFormats;
        beforeElement.runFormatting = afterElement.runFormatting;
      }
      beforeElement.text = afterElement.text;
    }
  }
  return target && JSON.stringify(baseline) === JSON.stringify(edited)
    ? target
    : null;
}

// Typing may also change an auto-sizing box or materialize inherited text
// formatting. Keep that edit scoped to the same shape instead of widening the
// human save to every slide and master.
export function directTextGeometryPreservationTarget(before, after) {
  if (
    !Array.isArray(before?.slides) ||
    !Array.isArray(after?.slides) ||
    before.slides.length !== after.slides.length
  )
    return null;
  const baseline = structuredClone(before);
  const edited = structuredClone(after);
  let target = null;
  for (
    let slideIndex = 0;
    slideIndex < baseline.slides.length;
    slideIndex += 1
  ) {
    const beforeElements = baseline.slides[slideIndex]?.elements;
    const afterElements = edited.slides[slideIndex]?.elements;
    if (
      !Array.isArray(beforeElements) ||
      !Array.isArray(afterElements) ||
      beforeElements.length !== afterElements.length
    )
      return null;
    for (let index = 0; index < beforeElements.length; index += 1) {
      const beforeElement = beforeElements[index];
      const afterElement = afterElements[index];
      if (beforeElement?.text === afterElement?.text) continue;
      if (
        target ||
        typeof beforeElement?.text !== "string" ||
        typeof afterElement?.text !== "string" ||
        typeof beforeElement?.name !== "string" ||
        !beforeElement.name ||
        beforeElement.name !== afterElement?.name ||
        beforeElement.elementId !== afterElement?.elementId ||
        beforeElement.parentElementId !== null ||
        !Number.isSafeInteger(beforeElement.zIndex) ||
        beforeElement.zIndex < 0
      )
        return null;
      const operations = ["replace_text"];
      if (["x", "y"].some((key) => beforeElement[key] !== afterElement[key]))
        operations.push("move");
      if (
        ["width", "height"].some(
          (key) => beforeElement[key] !== afterElement[key],
        )
      )
        operations.push("resize");
      const formattingChanged = ["paragraphFormats", "runFormatting"].some(
        (key) =>
          JSON.stringify(beforeElement[key]) !==
          JSON.stringify(afterElement[key]),
      );
      if (operations.length === 1 && !formattingChanged) return null;
      for (const key of ["x", "y", "width", "height"])
        if (!Number.isFinite(afterElement[key])) return null;
      target = {
        op: "replace_text",
        operations,
        slideIndex,
        name: beforeElement.name,
        shapeIndex: beforeElement.zIndex,
      };
      for (const key of [
        "text",
        "x",
        "y",
        "width",
        "height",
        "paragraphFormats",
        "runFormatting",
      ])
        beforeElement[key] = structuredClone(afterElement[key]);
      if (
        "emptyPresentationObject" in beforeElement ||
        "emptyPresentationObject" in afterElement
      )
        beforeElement.emptyPresentationObject =
          afterElement.emptyPresentationObject;
    }
  }
  return target && JSON.stringify(baseline) === JSON.stringify(edited)
    ? target
    : null;
}

// A keyboard move changes one shape's position while keeping the document
// structure intact. Give it the same narrow package scope as an AI move so
// an engine export cannot rewrite unrelated slides and shared masters.
export function directMovePreservationTarget(before, after) {
  if (
    !Array.isArray(before?.slides) ||
    !Array.isArray(after?.slides) ||
    before.slides.length !== after.slides.length
  )
    return null;
  const baseline = structuredClone(before);
  const edited = structuredClone(after);
  let target = null;
  let descendants = new Set();
  let translation = null;
  for (
    let slideIndex = 0;
    slideIndex < baseline.slides.length;
    slideIndex += 1
  ) {
    const beforeElements = baseline.slides[slideIndex]?.elements;
    const afterElements = edited.slides[slideIndex]?.elements;
    if (
      !Array.isArray(beforeElements) ||
      !Array.isArray(afterElements) ||
      beforeElements.length !== afterElements.length
    )
      return null;
    for (let index = 0; index < beforeElements.length; index += 1) {
      const beforeElement = beforeElements[index];
      const afterElement = afterElements[index];
      if (
        beforeElement?.x === afterElement?.x &&
        beforeElement?.y === afterElement?.y
      )
        continue;
      if (target && descendants.has(beforeElement.elementId)) {
        if (
          afterElement.elementId !== beforeElement.elementId ||
          afterElement.x - beforeElement.x !== translation.x ||
          afterElement.y - beforeElement.y !== translation.y
        ) return null;
        beforeElement.x = afterElement.x;
        beforeElement.y = afterElement.y;
        continue;
      }
      if (
        target ||
        beforeElement?.parentElementId != null ||
        typeof beforeElement?.name !== "string" ||
        !beforeElement.name ||
        beforeElement.name !== afterElement?.name ||
        beforeElement.elementId !== afterElement?.elementId ||
        !Number.isSafeInteger(beforeElement.zIndex) ||
        beforeElement.zIndex < 0 ||
        !Number.isFinite(afterElement?.x) ||
        !Number.isFinite(afterElement?.y)
      )
        return null;
      target = {
        op: "move",
        slideIndex,
        name: beforeElement.name,
        shapeIndex: beforeElement.zIndex,
      };
      translation = { x: afterElement.x - beforeElement.x, y: afterElement.y - beforeElement.y };
      descendants = new Set([beforeElement.elementId]);
      // The observation enumerates a group before its nested children.
      // Accept only descendants translated by the same vector; formatting,
      // structure and every unrelated object must still compare exactly.
      for (const element of beforeElements)
        if (descendants.has(element.parentElementId)) descendants.add(element.elementId);
      beforeElement.x = afterElement.x;
      beforeElement.y = afterElement.y;
    }
  }
  return target && JSON.stringify(baseline) === JSON.stringify(edited)
    ? target
    : null;
}

// A single top-level deletion shifts observation ids and reading order. They
// are derived positions; the remaining authored shapes must agree otherwise.
export function directDeletePreservationTarget(before, after) {
  if (
    !Array.isArray(before?.slides) ||
    !Array.isArray(after?.slides) ||
    before.slides.length !== after.slides.length
  )
    return null;
  for (let slideIndex = 0; slideIndex < before.slides.length; slideIndex += 1) {
    const prior = before.slides[slideIndex]?.elements;
    const live = after.slides[slideIndex]?.elements;
    if (
      !Array.isArray(prior) ||
      !Array.isArray(live) ||
      prior.length !== live.length + 1
    )
      continue;
    for (let index = 0; index < prior.length; index += 1) {
      const removed = prior[index];
      if (
        removed?.parentElementId !== null ||
        !Number.isSafeInteger(removed.zIndex) ||
        removed.zIndex !== index ||
        typeof removed.name !== "string" ||
        !removed.name
      )
        continue;
      const baseline = structuredClone(before);
      const edited = structuredClone(after);
      const slide = baseline.slides[slideIndex];
      slide.elements.splice(index, 1);
      slide.topLevelElementCount =
        edited.slides[slideIndex].topLevelElementCount;
      slide.readingOrder = edited.slides[slideIndex].readingOrder;
      // The accessibility report is recalculated from the remaining shapes.
      // Its entries can disappear or be renumbered when one shape is removed.
      slide.accessibilityIssues = edited.slides[slideIndex].accessibilityIssues;
      for (let retained = 0; retained < live.length; retained += 1) {
        const source = slide.elements[retained];
        const target = live[retained];
        for (const key of ["elementId", "zIndex", "readingOrder"])
          source[key] = target[key];
        if (
          Array.isArray(source.paragraphFormats) &&
          Array.isArray(target.paragraphFormats) &&
          source.paragraphFormats.length === target.paragraphFormats.length
        )
          for (
            let paragraph = 0;
            paragraph < source.paragraphFormats.length;
            paragraph += 1
          )
            source.paragraphFormats[paragraph].paragraphId =
              target.paragraphFormats[paragraph].paragraphId;
      }
      if (JSON.stringify(baseline) === JSON.stringify(edited))
        return {
          op: "delete_element",
          slideIndex,
          name: removed.name,
          shapeIndex: removed.zIndex,
        };
    }
  }
  return null;
}

// The package merge removes exactly one authored shape and keeps every other
// package part byte-identical. Reimporting that slide can recalculate inherited
// fill/effects, so verify deletion identity and the package boundary rather
// than demanding those derived values equal the pre-save engine cache.
export function persistedDirectDeletionMatches(
  before,
  live,
  reopened,
  target,
  report,
) {
  if (
    target?.op !== "delete_element" ||
    report?.changedParts?.length !== 1 ||
    !/^ppt\/slides\/slide[^/]+\.xml$/u.test(report.changedParts[0]) ||
    !Array.isArray(before?.slides) ||
    !Array.isArray(live?.slides) ||
    !Array.isArray(reopened?.slides) ||
    before.slides.length !== live.slides.length ||
    before.slides.length !== reopened.slides.length ||
    !Array.isArray(report.authoredShapeScopes) ||
    !report.authoredShapeScopes.some(
      ([index, names]) =>
        index === target.slideIndex &&
        Array.isArray(names) &&
        names.length === 1 &&
        names[0] === target.name,
    )
  )
    return false;
  const original = before.slides[target.slideIndex]?.elements;
  const edited = live.slides[target.slideIndex]?.elements;
  const saved = reopened.slides[target.slideIndex]?.elements;
  if (
    !Array.isArray(original) ||
    !Array.isArray(edited) ||
    !Array.isArray(saved) ||
    original[target.shapeIndex]?.name !== target.name ||
    original.length !== edited.length + 1 ||
    original.length !== saved.length + 1
  )
    return false;
  const keptNames = original
    .filter((_, index) => index !== target.shapeIndex)
    .map((element) => element.name);
  return keptNames.every(
    (name, index) =>
      name === edited[index]?.name && name === saved[index]?.name,
  );
}

// Slide indexes are addresses, not authored identity. Inserting/deleting a
// slide shifts the prefixes of object and animation IDs and reading order.
// Normalize ONLY those addresses and engine-generated slide names; keep all
// authored geometry, text, formatting, notes and animation content.
function topologySlideState(slide) {
  const result = structuredClone(slide);
  delete result.name;
  const address = (value) =>
    typeof value === "string"
      ? value.replace(/^\d+\//, "s/").replace(/^\d+:/, "s:")
      : value;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (key === "slideIndex") delete value[key];
      else if (
        [
          "elementId",
          "parentElementId",
          "paragraphId",
          "animationId",
          "targetElementId",
          "startElementId",
          "endElementId",
        ].includes(key)
      )
        value[key] = address(value[key]);
      else if (
        ["readingOrder", "childElementIds"].includes(key) &&
        Array.isArray(value[key])
      )
        value[key] = value[key].map(address);
      else visit(value[key]);
    }
  };
  visit(result);
  return result;
}

// The worker proves retained part bytes and order. Also prove that the live
// retained slides have no second edit, so export noise can never silently
// discard a concurrent authored change. Verify the new slide using the same
// authored-property and quantized-geometry rules as every persisted mutation.
export function persistedDirectSlideTopologyMatches(
  before,
  live,
  reopened,
  report,
) {
  const topology = report?.topology;
  if (
    !report?.topologyAligned ||
    !topology ||
    !["insert", "delete"].includes(topology.kind) ||
    !Number.isSafeInteger(topology.index) ||
    report.topologyExistingContentChanges?.length !== 0 ||
    !Array.isArray(before?.slides) ||
    !Array.isArray(live?.slides) ||
    !Array.isArray(reopened?.slides) ||
    live.slides.length !== reopened.slides.length ||
    Math.abs(before.slides.length - live.slides.length) !== 1
  )
    return false;
  const retainedBefore = before.slides.map(topologySlideState);
  const retainedLive = live.slides.map(topologySlideState);
  const retainedSaved = reopened.slides.map(topologySlideState);
  if (topology.kind === "insert") {
    if (
      live.slides.length !== before.slides.length + 1 ||
      topology.index < 0 ||
      topology.index >= live.slides.length
    )
      return false;
    const inserted = (slide) => ({
      slides: [topologySlideState(slide)],
      masters: [],
    });
    if (
      intendedDocumentMutationDifferences(
        {
          before: { slides: [], masters: [] },
          expected: inserted(live.slides[topology.index]),
          observed: inserted(reopened.slides[topology.index]),
        },
        { limit: 1 },
      ).length
    )
      return false;
    retainedLive.splice(topology.index, 1);
    retainedSaved.splice(topology.index, 1);
  } else {
    if (
      before.slides.length !== live.slides.length + 1 ||
      topology.index < 0 ||
      topology.index >= before.slides.length
    )
      return false;
    retainedBefore.splice(topology.index, 1);
  }
  const normalized = (slides, authoredBy = slides) =>
    normalizeDocumentPersistenceState(
      { slides, masters: [] },
      { authoredBy: { slides: authoredBy, masters: [] } },
    );
  if (
    JSON.stringify(normalized(retainedBefore, retainedLive)) !==
    JSON.stringify(normalized(retainedLive))
  )
    return false;
  // Original parts remain byte-identical. Reimport may recalculate inherited
  // layout defaults, but object identity/content must still match in order.
  const content = (slides) =>
    slides.map((slide) =>
      slide.elements?.map((element) => ({
        kind: element.kind,
        name: element.name,
        text: element.text ?? null,
      })),
    );
  return (
    JSON.stringify(content(retainedBefore)) ===
    JSON.stringify(content(retainedSaved))
  );
}

// A later Office save can advance its revision after the person's edit was
// already checkpointed. Only accept that revision without another product
// version when both the observed document and the reconciled PPTX are equal.
export function isRevisionOnlyNativeSnapshot(
  before,
  after,
  beforeSections,
  afterSections,
  beforeBytes,
  afterBytes,
) {
  return (
    JSON.stringify(before) === JSON.stringify(after) &&
    JSON.stringify(beforeSections ?? null) ===
      JSON.stringify(afterSections ?? null) &&
    beforeBytes instanceof Uint8Array &&
    afterBytes instanceof Uint8Array &&
    beforeBytes.length === afterBytes.length &&
    beforeBytes.every((byte, index) => byte === afterBytes[index])
  );
}
