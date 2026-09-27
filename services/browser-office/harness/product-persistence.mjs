/* SPDX-License-Identifier: MPL-2.0 */

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
        beforeElement.elementId !== afterElement?.elementId
      )
        return null;
      target = { op: "replace_text", slideIndex, name: beforeElement.name };
      beforeElement.text = afterElement.text;
    }
  }
  return target && JSON.stringify(baseline) === JSON.stringify(edited)
    ? target
    : null;
}
