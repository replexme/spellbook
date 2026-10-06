/* SPDX-License-Identifier: MPL-2.0 */
// ONLYOFFICE's canonical projection contains authored bounding boxes. These
// warnings are geometric evidence; rendered text overflow still needs the
// native slide image and is never certified from boxes alone.
export function onlyOfficeWorkspaceLayout(observation, previous = null) {
  const issues = [];
  for (const slide of observation.slides) {
    const elements = slide.elements;
    for (const element of elements) {
      if (
        ![element.x, element.y, element.width, element.height].every(
          Number.isFinite,
        )
      )
        throw Error("layout_geometry_unavailable");
      const identity = {
        slideIndex: slide.slideIndex,
        elementId: element.elementId,
      };
      if (element.width <= 0 || element.height <= 0)
        issues.push({ code: "invalid_size", ...identity });
      if (
        element.x < 0 ||
        element.y < 0 ||
        element.x + element.width > observation.width ||
        element.y + element.height > observation.height
      )
        issues.push({
          code: "out_of_slide_bounds",
          ...identity,
          bounds: {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
        });
    }
    for (let i = 0; i < elements.length; i++)
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i],
          b = elements[j],
          pageArea = observation.width * observation.height;
        if (
          [a, b].some(
            (e) =>
              e.width * e.height >= pageArea * 0.8 ||
              e.onlyoffice?.geometry?.preset === "line" ||
              e.kind === "connector",
          )
        )
          continue;
        const width = Math.max(
          0,
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
        );
        const height = Math.max(
          0,
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
        );
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller > 0 && (width * height) / smaller >= 0.2)
          issues.push({
            code: "possible_element_overlap",
            severity: "warning",
            slideIndex: slide.slideIndex,
            elementIds: [a.elementId, b.elementId],
            overlapRatio:
              Math.round(((width * height) / smaller) * 1000) / 1000,
          });
      }
  }
  const key = (issue) =>
    JSON.stringify([
      issue.code,
      issue.slideIndex,
      issue.elementId ?? null,
      issue.elementIds ?? null,
    ]);
  const old = new Set((previous?.issues ?? []).map(key));
  const introducedIssues = previous
    ? issues.filter((issue) => !old.has(key(issue)))
    : [];
  return {
    issueCount: issues.length,
    issues,
    ...(previous
      ? { introducedIssueCount: introducedIssues.length, introducedIssues }
      : {}),
    scope:
      "authored top-level geometry; native image review required for text and nested generated content",
  };
}
