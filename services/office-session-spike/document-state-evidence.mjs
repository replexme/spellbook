// A model coordinate may quantize by two 1/100 mm units (0.02 mm).
// Complete shape bounds enforce that limit on each physical edge; standalone
// slide/table sizes keep the same scalar limit. Non-geometry values stay exact.
const GEOMETRY_QUANTIZATION = 2;

export function quantizedGeometryEquivalent(expected, actual) {
  return (
    typeof expected === "number" &&
    typeof actual === "number" &&
    Number.isFinite(expected) &&
    Number.isFinite(actual) &&
    Math.abs(expected - actual) <= GEOMETRY_QUANTIZATION
  );
}

// Compare the physical outline, not position and extent independently: a
// two-unit shift plus a two-unit wider box must not admit a four-unit edge
// change. Opposite edges may each quantize by two units, making their derived
// width differ by four while the entire outline remains within the limit.
export function quantizedOutlineDifference(expected, actual, path) {
  if (
    !/(?:^|\.)elements\[\d+\]$|\.layoutIssues\[\d+\]\.bounds$/.test(path) ||
    ![expected, actual].every(
      (box) =>
        box &&
        ["x", "y", "width", "height"].every((key) => Number.isFinite(box[key])),
    )
  )
    return undefined;
  for (const [edge, field, extent] of [
    ["left", "x", null],
    ["top", "y", null],
    ["right", "x", "width"],
    ["bottom", "y", "height"],
  ]) {
    const before = expected[field] + (extent ? expected[extent] : 0);
    const after = actual[field] + (extent ? actual[extent] : 0);
    if (!quantizedGeometryEquivalent(before, after))
      return {
        path: `${path}.bounds.${edge}`,
        expected: before,
        actual: after,
      };
  }
  return null;
}

function isQuantizedGeometryPath(path) {
  return (
    /(?:^|\.)(?:slides|masters)\[\d+\]\.(?:width|height)$/.test(path) ||
    /\.elements\[\d+\]\.(?:x|y|width|height)$/.test(path) ||
    /\.layoutIssues\[\d+\]\.bounds\.(?:x|y|width|height)$/.test(path) ||
    /\.table\.(?:rowHeights|columnWidths)\[\d+\]$/.test(path)
  );
}

/**
 * Finds the first user-visible document-state difference. LibreOffice stores
 * slide, master, shape and table geometry in hundredths of a millimetre, and some native
 * model round trips quantize the two edges of a calculated extent by at most
 * two units. That 0.02 mm is below a verification pixel and is treated as the
 * same outline; every structural,
 * textual and formatting value remains exact.
 */
export function firstDocumentStateDifference(
  expected,
  actual,
  path = "slides",
) {
  if (Object.is(expected, actual)) return null;
  if (
    isQuantizedGeometryPath(path) &&
    quantizedGeometryEquivalent(expected, actual)
  )
    return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  )
    return { path, expected, actual };
  const outline = quantizedOutlineDifference(expected, actual, path);
  if (outline) return outline;
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const key of keys) {
    if (outline === null && ["x", "y", "width", "height"].includes(key))
      continue;
    const childPath = Array.isArray(expected)
      ? `${path}[${key}]`
      : `${path}.${key}`;
    const difference = firstDocumentStateDifference(
      expected[key],
      actual[key],
      childPath,
    );
    if (difference) return difference;
  }
  return null;
}

export function documentStatesEquivalent(expected, actual) {
  return firstDocumentStateDifference(expected, actual) === null;
}

/**
 * The observed slides and masters as the native revision covers them. A
 * master's shape count is diagnostic (import and export may materialize an
 * empty layout placeholder without changing authored content) and an
 * element's stableId is a live UNO handle, not authored identity.
 */
export function revisionDocumentState({ slides, masters }) {
  return {
    slides: slides?.map(({ elements, ...slide }) => ({
      ...slide,
      elements: elements?.map(({ stableId: _stableId, ...element }) => element),
    })),
    masters: masters?.map(({ shapeCount: _shapeCount, ...master }) => master),
  };
}

// The native revision includes authored masters and sections but intentionally
// excludes the diagnostic master shapeCount and transient UNO object handles.
// Keep slide state exact for Undo/Redo while using that revision for the rest.
export function undoDocumentStateEquivalent(expected, actual) {
  return (
    typeof expected?.revision === "string" &&
    expected.revision === actual?.revision &&
    documentStatesEquivalent(expected.slides, actual.slides)
  );
}
