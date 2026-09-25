// A persisted size is derived from two quantized edges. Each edge may move by
// one 1/100 mm model unit while converting OOXML EMUs through Impress, so the
// maximum serialization-only outline drift is two units (0.02 mm). At the
// 1280 px verification export this is roughly a tenth of a pixel; three units
// or any non-geometry difference remains a failure.
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
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const key of keys) {
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
