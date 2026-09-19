import {
  firstDocumentStateDifference,
  quantizedGeometryEquivalent,
  undoDocumentStateEquivalent,
} from "./document-state-evidence.mjs";

function valueSummary(value) {
  if (value === undefined) return "undefined";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return String(value);
  return encoded.length > 240 ? `${encoded.slice(0, 237)}...` : encoded;
}

function stableJson(value) {
  const normalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object")
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, normalize(candidate[key])]),
      );
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

const OBSERVATION_ONLY_FIELDS = new Set([
  "alignedWith",
  "layoutIssues",
  "overlapsWith",
  "propertyStates",
  "stableId",
  "wholeTextFormatting",
]);

function isDirectPropertyState(state) {
  return (
    state === 0 || state === "0" || String(state ?? "").endsWith("DIRECT_VALUE")
  );
}

function deleteNestedProperty(value, path) {
  const parts = path.split(".");
  const parents = [];
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (current === null || typeof current !== "object") return;
    parents.push([current, part]);
    current = current[part];
  }
  if (current === null || typeof current !== "object") return;
  delete current[parts.at(-1)];
  for (let index = parents.length - 1; index >= 0; index--) {
    const [parent, key] = parents[index];
    const child = parent[key];
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    )
      delete parent[key];
    else break;
  }
}

// A save can reorder slides or shapes without changing their authored values.
// Property-state masks must follow a uniquely named object, not the array slot
// it happened to occupy before the save. Unnamed objects retain positional
// comparison; ambiguous named objects are never used to mask changed values.
function authoredArrayEntry(value, authored, index) {
  if (!Array.isArray(authored)) return undefined;
  // An automatic placeholder name is not identity (see
  // withoutTransientEmptyPlaceholderDefaults): a save names the placeholders
  // a new layout created. Such placeholders keep their positions.
  if (isAutomaticEmptyPlaceholder(value))
    return isAutomaticEmptyPlaceholder(authored[index])
      ? authored[index]
      : null;
  const identity =
    typeof value?.objectName === "string" && value.objectName
      ? ["objectName", value.objectName]
      : typeof value?.name === "string" &&
          value.name &&
          typeof value?.slideIndex === "number"
        ? ["name", value.name]
        : null;
  if (identity) {
    const [key, name] = identity;
    const matches = authored.filter((candidate) => candidate?.[key] === name);
    if (matches.length === 1) return matches[0];
    // A duplicated slide keeps its source's name; slides that share a name
    // pair by their index.
    if (key === "name" && matches.length > 1)
      return (
        matches.find(
          (candidate) => candidate?.slideIndex === value.slideIndex,
        ) ?? null
      );
    // A changed or duplicate name is not evidence that the indexed object is
    // the same object. Keep every observed value in the comparison.
    return null;
  }
  return authored[index];
}

/**
 * UNO exposes both authored values and values calculated from a style/theme.
 * Calculated defaults can legitimately resolve to a different raw value after
 * OOXML reload even when rendering and editability are unchanged. Persisted
 * integrity therefore compares only properties authored in the matching live
 * state; operation-specific checks separately prove every requested edit.
 * The live state is deliberately used as the mask for the reopened state:
 * OOXML import can turn an inherited default into a direct UNO value, and
 * independently filtering both sides would mistake that recalculation for a
 * document change.
 */
function withoutComputedPropertyValues(value, authoredBy = value) {
  if (Array.isArray(value)) {
    value.forEach((candidate, index) =>
      withoutComputedPropertyValues(
        candidate,
        authoredArrayEntry(candidate, authoredBy, index),
      ),
    );
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (
    authoredBy?.propertyStates &&
    typeof authoredBy.propertyStates === "object"
  ) {
    for (const [path, state] of Object.entries(authoredBy.propertyStates))
      if (!isDirectPropertyState(state)) deleteNestedProperty(value, path);
  }
  delete value.propertyStates;
  for (const [key, candidate] of Object.entries(value))
    withoutComputedPropertyValues(candidate, authoredBy?.[key]);
  return value;
}

function withoutObservationOnlyFields(value) {
  if (Array.isArray(value)) return value.map(withoutObservationOnlyFields);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OBSERVATION_ONLY_FIELDS.has(key))
        .map(([key, candidate]) => [
          key,
          withoutObservationOnlyFields(candidate),
        ]),
    );
  return value;
}

function withoutMergedContinuationFormatting(slides) {
  for (const slide of slides) {
    for (const element of slide.elements ?? []) {
      const rows = element.table?.cellDetails;
      if (!Array.isArray(rows)) continue;
      element.table.cellDetails = rows.map((row) =>
        row.map((cell) => {
          if (cell?.merged !== true) return cell;
          // A merged continuation cell has no independently rendered surface.
          // LibreOffice reconstructs its dormant formatting from the merge
          // anchor when PPTX is reopened, so only its structural marker and
          // non-rendered text identity are stable persisted semantics.
          return {
            row: cell.row,
            column: cell.column,
            text: cell.text,
            merged: true,
            rowSpan: cell.rowSpan,
            columnSpan: cell.columnSpan,
          };
        }),
      );
    }
  }
  return slides;
}

const AUTOMATIC_UNO_PLACEHOLDER_NAME =
  /^unnamed-com\.sun\.star\.presentation\.[A-Za-z0-9]+Shape$/u;
const SERIALIZED_PLACEHOLDER_NAME = /^PlaceHolder [1-9][0-9]*$/u;

/**
 * A newly applied Impress layout creates empty presentation placeholders with
 * transient UNO defaults. OOXML save/reopen gives those same placeholders an
 * automatic package name and resolves inherited text-flow defaults, without
 * changing a rendered pixel. These fields are not stable identity until the
 * placeholder contains text or receives a user-assigned name.
 */
function isAutomaticEmptyPlaceholder(element) {
  if (
    element?.text !== "" ||
    !String(element.kind ?? "").startsWith("com.sun.star.presentation.")
  )
    return false;
  const automaticInMemoryName =
    AUTOMATIC_UNO_PLACEHOLDER_NAME.test(element.name ?? "") &&
    (element.objectName ?? "") === "";
  const automaticSerializedName =
    SERIALIZED_PLACEHOLDER_NAME.test(element.name ?? "") &&
    element.objectName === element.name;
  return automaticInMemoryName || automaticSerializedName;
}

function withoutTransientEmptyPlaceholderDefaults(slides) {
  for (const slide of slides) {
    for (const element of slide.elements ?? []) {
      if (!isAutomaticEmptyPlaceholder(element)) continue;
      if (
        element.presentationObject === true &&
        element.emptyPresentationObject === true &&
        [
          "com.sun.star.presentation.OLE2Shape",
          "com.sun.star.presentation.OutlinerShape",
        ].includes(element.kind)
      )
        element.kind = "com.sun.star.presentation.ContentPlaceholderShape";
      for (const field of [
        "name",
        "objectName",
        "fontFamily",
        "color",
        "textAutoGrowWidth",
        "textWordWrap",
      ])
        delete element[field];
    }
  }
  return slides;
}

function withCanonicalShapeIdentity(slides) {
  for (const slide of slides) {
    for (const element of slide.elements ?? []) {
      if (
        element.geometryType &&
        /^com\.sun\.star\.drawing\.(?:Text|Rectangle|Ellipse|Custom|Line)Shape$/u.test(
          element.kind ?? "",
        )
      )
        element.kind = "com.sun.star.drawing.CustomShape";
      if (
        !element.objectName &&
        /^unnamed-com\.sun\.star\.[A-Za-z0-9.]+Shape$/u.test(element.name ?? "")
      )
        delete element.name;
    }
  }
  return slides;
}

// The Office bridge names an enumerator with its qualified UNO name, the
// browser bridge with the bare member name.
const isNoneStyle = (value) => /(?:^|\.)NONE$/u.test(String(value ?? ""));

function withoutInactiveStyleValues(slides, authoredSlides = slides) {
  for (const [slideIndex, slide] of slides.entries()) {
    const authoredSlide = authoredArrayEntry(slide, authoredSlides, slideIndex);
    for (const [elementIndex, element] of (slide.elements ?? []).entries()) {
      const authoredElement = authoredArrayEntry(
        element,
        authoredSlide?.elements,
        elementIndex,
      );
      if (isNoneStyle(authoredElement?.fillStyle)) {
        delete element.fill;
        delete element.fillOpacity;
      }
      if (isNoneStyle(authoredElement?.lineStyle)) {
        for (const field of [
          "lineColor",
          "lineWidth",
          "lineDashName",
          "lineStartName",
          "lineEndName",
          "lineOpacity",
        ])
          delete element[field];
      }
      if (authoredElement && authoredElement.shadow?.enabled !== true) {
        if (element.shadow) element.shadow = { enabled: false };
      }
    }
  }
  return slides;
}

// css.animations constants and EffectNodeType values as observed.
const ANIMATION_NODE_PAR = 1;
const ANIMATION_NODE_SEQ = 2;
const ANIMATION_FILL_DEFAULT = 0;
const ANIMATION_FILL_FREEZE = 2;
const ANIMATION_FILL_HOLD = 3;
const ANIMATION_FILL_AUTO = 5;
const ANIMATION_RESTART_WRITTEN = new Set([1, 2, 3]);
const ANIMATION_RESTART_NEVER = 3;
const EFFECT_NODE_MAIN_SEQUENCE = 4;
const EFFECT_NODE_TIMING_ROOT = 5;

// A Timing value (INDEFINITE or MEDIA) is observed as an event without a
// trigger; a real event has a numeric trigger.
const isObservedTiming = (value) =>
  Boolean(value) && typeof value === "object" && value.trigger === null;

/**
 * LibreOffice rebuilds an edited animation sequence: it clears the main
 * sequence's duration and creates the click and with containers without a
 * fill. Its PPTX save writes what PowerPoint uses instead, and a reopened deck
 * holds those values: dur="indefinite" on the main sequence and on a timing
 * root without a duration, restart="never" on the root, no fill on either,
 * and fill="hold" on a container that FREEZE, DEFAULT or AUTO resolves to
 * (PPTXAnimationExport and AnimationExporter::GetFillMode). Containers are
 * compared in that saved form; effect nodes and their animations are compared
 * as observed, except that FREEZE and HOLD both save as "hold".
 */
function withSavedAnimationContainers(slides) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const effectNodeType = node.semanticNodeType;
    if (effectNodeType === EFFECT_NODE_MAIN_SEQUENCE) {
      node.duration = "indefinite";
      node.fill = ANIMATION_FILL_DEFAULT;
    } else if (effectNodeType === EFFECT_NODE_TIMING_ROOT) {
      if (node.duration === null || isObservedTiming(node.duration))
        node.duration = "indefinite";
      if (!ANIMATION_RESTART_WRITTEN.has(node.restart))
        node.restart = ANIMATION_RESTART_NEVER;
      node.fill = ANIMATION_FILL_DEFAULT;
    } else {
      if (!ANIMATION_RESTART_WRITTEN.has(node.restart)) node.restart = 0;
      if (node.fill === ANIMATION_FILL_FREEZE) node.fill = ANIMATION_FILL_HOLD;
      const container =
        !node.preset?.id &&
        [ANIMATION_NODE_PAR, ANIMATION_NODE_SEQ].includes(node.nodeType);
      if (
        container &&
        [ANIMATION_FILL_DEFAULT, ANIMATION_FILL_AUTO].includes(node.fill) &&
        (node.duration === null || isObservedTiming(node.duration)) &&
        (node.end === null || isObservedTiming(node.end))
      )
        node.fill = ANIMATION_FILL_HOLD;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const slide of slides)
    for (const root of slide.animations?.roots ?? []) visit(root);
  return slides;
}

/**
 * Captures the persisted slide/master model while using the detailed UNO text
 * enumeration as the source of truth for the requested slide. The compact
 * element text is useful for prompts but can lag a range edit in the same
 * remote transaction; paragraph portions are read directly from the model.
 */
export function persistenceStateFromObservation(observation) {
  const state = {
    slides: structuredClone(observation?.slides ?? []),
    masters: structuredClone(observation?.masters ?? []),
  };
  const detailSlideIndex = observation?.textDetails?.slideIndex;
  if (!Number.isInteger(detailSlideIndex) || !state.slides[detailSlideIndex])
    return state;
  for (const detail of observation.textDetails?.elements ?? []) {
    const element = state.slides[detailSlideIndex].elements?.find(
      (candidate) => candidate.elementId === detail.elementId,
    );
    if (!element || !Array.isArray(detail.paragraphs)) continue;
    element.text = detail.paragraphs
      .map((paragraph) =>
        Array.isArray(paragraph.portions)
          ? paragraph.portions.map((portion) => portion.text ?? "").join("")
          : (paragraph.text ?? ""),
      )
      .join("\n");
  }
  return state;
}

/**
 * Removes serialization order from the document state without removing any
 * user-visible master or theme data. PPTX import/export may reorder master
 * relationships and consequently renumber the UNO masterIndex. It may also
 * materialize title/body placeholders on a LibreOffice master-page projection
 * when a sibling OOXML layout becomes used by a slide. That changes UNO's
 * getCount() even though the persisted slide-layout part, slide relationship,
 * rendered slide and editable slide objects are unchanged. Package change
 * budgets compare the actual master/layout XML, so shapeCount is diagnostic
 * runtime state rather than a persistence invariant here. Slides retain
 * masterName, while every stable semantic master field is compared as a sorted
 * multiset so extra, missing or modified masters still fail the gate.
 */
export function normalizeDocumentPersistenceState(
  state,
  { authoredBy = state } = {},
) {
  const masters = (state?.masters ?? [])
    .map(({ masterIndex: _masterIndex, shapeCount: _shapeCount, ...master }) =>
      withoutObservationOnlyFields(structuredClone(master)),
    )
    .sort((left, right) => {
      const leftIdentity = `${left.name ?? ""}\u0000${left.layout ?? ""}\u0000${stableJson(left)}`;
      const rightIdentity = `${right.name ?? ""}\u0000${right.layout ?? ""}\u0000${stableJson(right)}`;
      return leftIdentity.localeCompare(rightIdentity, "en");
    });
  const slides = withSavedAnimationContainers(
    withoutInactiveStyleValues(
      withCanonicalShapeIdentity(
        withoutTransientEmptyPlaceholderDefaults(
          withoutMergedContinuationFormatting(
            (state?.slides ?? []).map(
              ({ masterIndex: _masterIndex, ...slide }, index) => {
                const { masterIndex: _authoredMasterIndex, ...authoredSlide } =
                  authoredArrayEntry(slide, authoredBy?.slides, index) ?? {};
                const normalized = withoutObservationOnlyFields(
                  withoutComputedPropertyValues(
                    structuredClone(slide),
                    authoredSlide,
                  ),
                );
                if (normalized.transition) {
                  const {
                    effect: _effect,
                    speed: _speed,
                    ...persistedTransition
                  } = normalized.transition;
                  normalized.transition = persistedTransition;
                }
                return normalized;
              },
            ),
          ),
        ),
      ),
      authoredBy?.slides,
    ),
  );
  return { slides, masters };
}

/**
 * The difference that keeps an Undo or Redo from its target state, or null
 * when it reached it. The browser product returns to a saved package by
 * reopening it whenever its native fast path is not exact, and a reopened
 * model can differ from the live model that produced the package in
 * import-normalized details (a substituted font name, an inherited default).
 * A browser history step therefore matches its target as persisted state, the
 * way that save itself was verified; every other runtime must match exactly.
 */
export function historyStateDifference(expected, actual) {
  if (undoDocumentStateEquivalent(expected, actual)) return null;
  if (actual?.engine?.engineImage !== "browser-wasm")
    return (
      firstDocumentStateDifference(
        { slides: expected?.slides, masters: expected?.masters },
        { slides: actual?.slides, masters: actual?.masters },
      ) ?? {
        path: "revision",
        expected: expected?.revision,
        actual: actual?.revision,
      }
    );
  const target = persistenceStateFromObservation(expected);
  return (
    formatCanonicalDifferences(
      normalizeDocumentPersistenceState(target),
      normalizeDocumentPersistenceState(
        persistenceStateFromObservation(actual),
        { authoredBy: target },
      ),
      { limit: 1 },
    )[0] ?? null
  );
}

export function historyStateEquivalent(expected, actual) {
  return historyStateDifference(expected, actual) === null;
}

export function firstPersistenceDifference(expected, observed, path = "$") {
  if (Object.is(expected, observed)) return null;
  if (Array.isArray(expected) || Array.isArray(observed)) {
    if (!Array.isArray(expected) || !Array.isArray(observed))
      return { path, expected, observed };
    if (expected.length !== observed.length)
      return {
        path: `${path}.length`,
        expected: expected.length,
        observed: observed.length,
      };
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstPersistenceDifference(
        expected[index],
        observed[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const observedObject = observed !== null && typeof observed === "object";
  if (expectedObject || observedObject) {
    if (!expectedObject || !observedObject) return { path, expected, observed };
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(observed)]),
    ].sort();
    for (const key of keys) {
      const difference = firstPersistenceDifference(
        expected[key],
        observed[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }
  return { path, expected, observed };
}

export function assertExactPersistence(observed, expected, message) {
  const difference = firstPersistenceDifference(expected, observed);
  if (!difference) return;
  throw new Error(
    `${message} First difference at ${difference.path}: expected ${valueSummary(difference.expected)}, observed ${valueSummary(difference.observed)}.`,
  );
}

function persistenceKind(value) {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "value";
}

function isAnimationTreeTime(path) {
  return (
    path.includes(".animations.roots[") &&
    /\.(?:begin|duration|end|offset)$/.test(path)
  );
}

function ooxmlAnimationTime(seconds) {
  // ECMA-376 serializes these timing attributes as integer milliseconds.
  // LibreOffice's exporter truncates the double when it writes that integer.
  return Math.trunc(seconds * 1_000 + Number.EPSILON) / 1_000;
}

// PPTX stores character spacing (a:rPr/@spc) in 1/100 pt and Impress stores
// CharKerning in 1/100 mm. LibreOffice truncates in both directions, so one
// save/reopen cycle can move the value by one 1/100 mm unit (~0.03 pt), below
// PowerPoint's 0.1 pt spacing precision. A larger change remains a failure.
function characterSpacingEquivalent(expected, observed) {
  const mm100 = (points) => Math.round((points * 2540) / 72);
  return Math.abs(mm100(expected) - mm100(observed)) <= 1;
}

function isFormatCanonicalEquivalent(expected, observed, path) {
  const numeric =
    typeof expected === "number" &&
    typeof observed === "number" &&
    Number.isFinite(expected) &&
    Number.isFinite(observed);
  if (!numeric) return false;
  if (
    /(?:^|\.)(?:slides|masters)\[\d+\]\.(?:width|height)$/.test(path) ||
    /\.elements\[\d+\]\.(?:x|y|width|height)$/.test(path) ||
    /\.table\.(?:rowHeights|columnWidths)\[\d+\]$/.test(path)
  )
    return quantizedGeometryEquivalent(expected, observed);
  if (/(?:^|\.)(?:characterSpacing|spacing)$/.test(path))
    return characterSpacingEquivalent(expected, observed);
  // PPTX stores a comment's position in master units (1/576 inch, 4.4
  // hundredths of a millimetre): the nearest one lies within half of that,
  // and the observation rounds to whole hundredths.
  if (/\.comments\[\d+\]\.(?:x|y)$/.test(path))
    return Math.abs(expected - observed) <= 3;
  return (
    isAnimationTreeTime(path) &&
    Object.is(ooxmlAnimationTime(expected), observed)
  );
}

/**
 * Exact comparison that accepts only the documented format quantization
 * (geometry, animation times and character spacing). Reopen probes that check
 * a subset of the document use this instead of raw JSON equality.
 */
export function formatCanonicalDifferences(
  expected,
  observed,
  { path = "$", limit = 20 } = {},
) {
  const differences = [];
  collectExactDifferences(
    expected,
    observed,
    path,
    "format-canonical",
    differences,
    limit,
    true,
  );
  return differences;
}

function intendedDifference(expected, observed, path) {
  if (isFormatCanonicalEquivalent(expected, observed, path)) return null;
  const difference = firstPersistenceDifference(expected, observed, path);
  return difference ? { ...difference, invariant: "intended-change" } : null;
}

function collectExactDifferences(
  expected,
  observed,
  path,
  invariant,
  differences,
  limit,
  allowFormatCanonicalization,
) {
  if (differences.length >= limit || Object.is(expected, observed)) return;
  if (
    allowFormatCanonicalization &&
    isFormatCanonicalEquivalent(expected, observed, path)
  )
    return;
  if (Array.isArray(expected) || Array.isArray(observed)) {
    if (!Array.isArray(expected) || !Array.isArray(observed)) {
      differences.push({ path, expected, observed, invariant });
      return;
    }
    if (expected.length !== observed.length)
      differences.push({
        path: `${path}.length`,
        expected: expected.length,
        observed: observed.length,
        invariant,
      });
    const length = Math.min(expected.length, observed.length);
    for (
      let index = 0;
      index < length && differences.length < limit;
      index += 1
    )
      collectExactDifferences(
        expected[index],
        observed[index],
        `${path}[${index}]`,
        invariant,
        differences,
        limit,
        allowFormatCanonicalization,
      );
    return;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const observedObject = observed !== null && typeof observed === "object";
  if (expectedObject || observedObject) {
    if (!expectedObject || !observedObject) {
      differences.push({ path, expected, observed, invariant });
      return;
    }
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(observed)]),
    ].sort();
    for (const key of keys) {
      if (differences.length >= limit) break;
      collectExactDifferences(
        expected[key],
        observed[key],
        `${path}.${key}`,
        invariant,
        differences,
        limit,
        allowFormatCanonicalization,
      );
    }
    return;
  }
  differences.push({ path, expected, observed, invariant });
}

function collectPersistenceDeltaDifferences(
  before,
  expected,
  baseline,
  observed,
  path,
  differences,
  limit,
) {
  if (differences.length >= limit) return;
  if (!firstPersistenceDifference(before, expected)) {
    // The preserved candidate keeps the author's original XML for untouched
    // objects, while the no-op baseline is the engine's own re-export. Both
    // reopen through the same importer, so only the documented format
    // quantization (not any other value) may differ here.
    collectExactDifferences(
      baseline,
      observed,
      path,
      "unchanged-after-normalization",
      differences,
      limit,
      true,
    );
    return;
  }
  if (!firstPersistenceDifference(expected, observed)) return;

  const beforeKind = persistenceKind(before);
  const expectedKind = persistenceKind(expected);
  const baselineKind = persistenceKind(baseline);
  const observedKind = persistenceKind(observed);
  if (
    beforeKind !== expectedKind ||
    baselineKind !== observedKind ||
    expectedKind !== observedKind
  ) {
    collectExactDifferences(
      expected,
      observed,
      path,
      "intended-change",
      differences,
      limit,
      true,
    );
    return;
  }

  if (expectedKind === "array") {
    if (
      before.length !== expected.length ||
      baseline.length !== observed.length ||
      expected.length !== observed.length
    ) {
      collectExactDifferences(
        expected,
        observed,
        path,
        "intended-change",
        differences,
        limit,
        true,
      );
      return;
    }
    for (let index = 0; index < expected.length; index += 1)
      collectPersistenceDeltaDifferences(
        before[index],
        expected[index],
        baseline[index],
        observed[index],
        `${path}[${index}]`,
        differences,
        limit,
      );
    return;
  }

  if (expectedKind === "object") {
    const keys = [
      ...new Set([
        ...Object.keys(before),
        ...Object.keys(expected),
        ...Object.keys(baseline),
        ...Object.keys(observed),
      ]),
    ].sort();
    for (const key of keys)
      collectPersistenceDeltaDifferences(
        before[key],
        expected[key],
        baseline[key],
        observed[key],
        `${path}.${key}`,
        differences,
        limit,
      );
    return;
  }

  collectExactDifferences(
    expected,
    observed,
    path,
    "intended-change",
    differences,
    limit,
    true,
  );
}

export function persistenceDeltaDifferences(
  { before, expected, baseline, observed },
  { limit = 200 } = {},
) {
  const differences = [];
  collectPersistenceDeltaDifferences(
    before,
    expected,
    baseline,
    observed,
    "$",
    differences,
    limit,
  );
  return differences;
}

/**
 * Compares a mutated save against a no-op save of the same source document.
 *
 * LibreOffice may canonicalize imported OOXML even when the user makes no
 * change. For every subtree that the mutation left alone, the no-op save is
 * therefore the correct expected value. Only subtrees changed in memory must
 * match the post-mutation state directly.
 */
export function firstPersistenceDeltaDifference(
  before,
  expected,
  baseline,
  observed,
  path = "$",
) {
  if (!firstPersistenceDifference(before, expected)) {
    const difference = firstPersistenceDifference(baseline, observed, path);
    return difference
      ? { ...difference, invariant: "unchanged-after-normalization" }
      : null;
  }

  if (!firstPersistenceDifference(expected, observed)) return null;

  const beforeKind = persistenceKind(before);
  const expectedKind = persistenceKind(expected);
  const baselineKind = persistenceKind(baseline);
  const observedKind = persistenceKind(observed);
  if (
    beforeKind !== expectedKind ||
    baselineKind !== observedKind ||
    expectedKind !== observedKind
  )
    return intendedDifference(expected, observed, path);

  if (expectedKind === "array") {
    if (
      before.length !== expected.length ||
      baseline.length !== observed.length ||
      expected.length !== observed.length
    )
      return intendedDifference(expected, observed, path);
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstPersistenceDeltaDifference(
        before[index],
        expected[index],
        baseline[index],
        observed[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }

  if (expectedKind === "object") {
    const keys = [
      ...new Set([
        ...Object.keys(before),
        ...Object.keys(expected),
        ...Object.keys(baseline),
        ...Object.keys(observed),
      ]),
    ].sort();
    for (const key of keys) {
      const difference = firstPersistenceDeltaDifference(
        before[key],
        expected[key],
        baseline[key],
        observed[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }

  return intendedDifference(expected, observed, path);
}

export function assertPersistenceDelta(
  { before, expected, baseline, observed },
  message,
) {
  const differences = persistenceDeltaDifferences({
    before,
    expected,
    baseline,
    observed,
  });
  const difference = differences[0];
  if (!difference) return;
  const expectation =
    difference.invariant === "unchanged-after-normalization"
      ? "the no-op saved baseline"
      : "the intended edited state";
  throw new Error(
    `${message} ${differences.length} difference(s); ${difference.invariant} failed at ${difference.path}: expected ${expectation} ${valueSummary(difference.expected)}, observed ${valueSummary(difference.observed)}.`,
  );
}

export function documentPersistenceDeltaDifferences(report, observed, options) {
  const before = report?.persistenceBefore;
  const expected = report?.persistenceExpected;
  const baseline = report?.persistenceBaseline;
  if (
    !before?.slides ||
    !before?.masters ||
    !expected?.slides ||
    !expected?.masters ||
    !baseline?.slides ||
    !baseline?.masters ||
    !observed?.slides ||
    !observed?.masters
  )
    throw new Error(
      "Persistence evidence requires before, expected, no-op baseline and reopened slide/master states.",
    );
  return persistenceDeltaDifferences(
    {
      before: normalizeDocumentPersistenceState(before),
      expected: normalizeDocumentPersistenceState(expected),
      baseline: normalizeDocumentPersistenceState(baseline, {
        authoredBy: before,
      }),
      observed: normalizeDocumentPersistenceState(observed, {
        authoredBy: expected,
      }),
    },
    options,
  );
}

/**
 * Product save admission has no no-op export of the user's current in-memory
 * session. Compare only the fields that the edit actually changed, using the
 * same canonical PPTX semantics as the release conformance runner. Unchanged
 * fields remain the package-preservation validator's responsibility.
 */
export function intendedDocumentMutationDifferences(
  { before, expected, observed },
  options,
) {
  if (
    !Array.isArray(before?.slides) ||
    !Array.isArray(before?.masters) ||
    !Array.isArray(expected?.slides) ||
    !Array.isArray(expected?.masters) ||
    !Array.isArray(observed?.slides) ||
    !Array.isArray(observed?.masters)
  )
    throw new Error(
      "Persisted mutation evidence requires before, expected and reopened slide/master states.",
    );
  const normalizedBefore = normalizeDocumentPersistenceState(before);
  const normalizedExpected = normalizeDocumentPersistenceState(expected);
  const normalizedObserved = normalizeDocumentPersistenceState(observed, {
    authoredBy: expected,
  });
  const sectionsChanged =
    Array.isArray(before.sections) &&
    Array.isArray(expected.sections) &&
    Boolean(firstPersistenceDifference(before.sections, expected.sections));
  if (
    !firstPersistenceDifference(normalizedBefore, normalizedExpected) &&
    !sectionsChanged
  )
    throw new Error(
      "Persisted mutation evidence has no observable intended change.",
    );
  if (sectionsChanged && !Array.isArray(observed.sections))
    throw new Error("Reopened PPTX has no section observation.");
  const differences = persistenceDeltaDifferences(
    {
      before: normalizedBefore,
      expected: normalizedExpected,
      baseline: normalizedObserved,
      observed: normalizedObserved,
    },
    options,
  );
  if (
    sectionsChanged &&
    firstPersistenceDifference(expected.sections, observed.sections)
  ) {
    collectExactDifferences(
      expected.sections,
      observed.sections,
      "$.sections",
      "intended-change",
      differences,
      options?.limit ?? 200,
      false,
    );
  }
  return differences;
}

export function assertDocumentPersistenceDelta(report, observed, message) {
  const before = report?.persistenceBefore;
  const expected = report?.persistenceExpected;
  const baseline = report?.persistenceBaseline;
  if (
    !before?.slides ||
    !before?.masters ||
    !expected?.slides ||
    !expected?.masters ||
    !baseline?.slides ||
    !baseline?.masters ||
    !observed?.slides ||
    !observed?.masters
  )
    throw new Error(
      "Persistence evidence requires before, expected, no-op baseline and reopened slide/master states.",
    );
  const differences = documentPersistenceDeltaDifferences(report, observed);
  if (!differences.length) return;
  const difference = differences[0];
  const expectation =
    difference.invariant === "unchanged-after-normalization"
      ? "the no-op saved baseline"
      : "the intended edited state";
  throw new Error(
    `${message} ${differences.length} difference(s); ${difference.invariant} failed at ${difference.path}: expected ${expectation} ${valueSummary(difference.expected)}, observed ${valueSummary(difference.observed)}.`,
  );
}
