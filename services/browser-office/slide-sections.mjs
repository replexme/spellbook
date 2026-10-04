/* SPDX-License-Identifier: MPL-2.0 */
export function validSectionId(value) {
  return /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu.test(
    value,
  );
}

export function validSectionName(value) {
  return (
    typeof value === "string" &&
    [...value].length > 0 &&
    [...value].length <= 255 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function normalizedSections(value, slideCount) {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError("sections must be an array with at most 100 entries.");
  const ids = new Set();
  const names = new Set();
  const sections = value.map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section))
      throw new TypeError(`section ${index} must be an object.`);
    if (
      Object.keys(section).some(
        (key) => !["id", "name", "startSlideIndex"].includes(key),
      ) ||
      !validSectionId(section.id) ||
      !validSectionName(section.name) ||
      !Number.isSafeInteger(section.startSlideIndex) ||
      section.startSlideIndex < 0 ||
      section.startSlideIndex >= slideCount ||
      ids.has(section.id.toUpperCase()) ||
      names.has(section.name)
    )
      throw new Error(`section ${index} is invalid.`);
    ids.add(section.id.toUpperCase());
    names.add(section.name);
    return {
      id: section.id.toUpperCase(),
      name: section.name,
      startSlideIndex: section.startSlideIndex,
    };
  });
  if (
    sections.length &&
    (sections[0].startSlideIndex !== 0 ||
      sections.some(
        (section, index) =>
          index > 0 &&
          section.startSlideIndex <= sections[index - 1].startSlideIndex,
      ))
  )
    throw new Error(
      "Non-empty sections must start at slide 0 and use increasing slide indexes.",
    );
  return sections;
}
