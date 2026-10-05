/* SPDX-License-Identifier: MPL-2.0 */

import { validSectionId, validSectionName, normalizedSections } from "./slide-sections.mjs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  classifyNativePackagePart,
  nativePreservationBudget,
  humanEditPreservationBudget,
  slideShapeTargets,
  directShapeIndexOperations,
} from "./native-preservation-policy.mjs";

const presentationNamespace =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const powerpoint2010Namespace =
  "http://schemas.microsoft.com/office/powerpoint/2010/main";
const drawingNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const chartNamespace = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const relationshipAttributeNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationshipNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypeNamespace =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const extendedPropertiesNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const markupCompatibilityNamespace =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
const diagramDrawingNamespace =
  "http://schemas.microsoft.com/office/drawing/2008/diagram";
const slideContentType =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const maximumInputBytes = 64 * 1024 * 1024;
const maximumExpandedBytes = 512 * 1024 * 1024;
const maximumEntries = 10_000;
const deterministicZipModifiedAt = new Date("2000-01-01T00:00:00.000Z");
const emuPerHundredthMillimeter = 360;
const presentationPath = "ppt/presentation.xml";
const presentationRelationshipsPath = "ppt/_rels/presentation.xml.rels";
const contentTypesPath = "[Content_Types].xml";
const topologyOperations = new Set([
  "add_slide",
  "duplicate_slide",
  "delete_slide",
  "move_slide",
]);
const documentStructureOperations = new Set(["set_sections"]);
const slideMetadataOperations = new Set(["rename_slide", "set_slide_hidden"]);
const geometryOperations = new Set(["move", "resize", "rotate"]);
const shapeAppearanceOperations = new Set([
  "fill_color",
  "line_color",
  "line_width",
  "fill_opacity",
  "line_opacity",
]);
const textAppearanceOperations = new Set([
  "font_size",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "font_family",
  "font_color",
  "paragraph_alignment",
]);
// Operations that only add a shape or swap the content of one picture/media
// object. The engine can still rewrite untouched shapes while exporting (for
// example dropping an empty text box's paragraph alignment), so every other
// relationship-free shape is restored from the author's original XML. The
// replaced object keeps its r:embed/r:link reference and is never restored.
const additiveShapeOperations = new Set([
  "add_shape",
  "add_text_box",
  "add_table",
  "add_connector",
  "add_freeform",
  "duplicate_element",
  "insert_image",
  "insert_media",
  "replace_image",
  "replace_media",
]);
const elementOperations = new Set([
  "replace_text",
  ...geometryOperations,
  ...shapeAppearanceOperations,
  ...textAppearanceOperations,
]);
const browserOperations = new Set([
  ...topologyOperations,
  ...documentStructureOperations,
  ...slideMetadataOperations,
  ...elementOperations,
]);
const sharedDependencyKinds = new Set([
  "slideLayout",
  "slideMaster",
  "notesMaster",
  "theme",
  "image",
  "audio",
  "video",
  "slide",
]);

function samePartBytes(left, right) {
  if (!left || !right) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

// Slide-number fields contain generated display text, not an authored note.
// Impress can switch between its default label and the computed number when
// a hidden document is inspected or an Undo/Redo redraw occurs. Apply the
// same rule to slide, layout/master and notes parts; keep field type,
// formatting and all ordinary text significant.
function normalizeGeneratedPlaceholderDisplay(document, part, canonical) {
  if (
    !/^ppt\/(slides|slideMasters|slideLayouts|notesSlides|notesMasters)\/[^/]+\.xml$/u.test(
      part,
    )
  )
    return;
  const master = canonical && part.startsWith("ppt/slideMasters/");
  const defaults = {
    dt: ["<날짜/시간>", "<date/time>"],
    ftr: ["<바닥글>", "<footer>"],
    sldNum: ["<숫자>", "<number>"],
  };
  for (const shape of document.getElementsByTagNameNS(
    presentationNamespace,
    "sp",
  )) {
    const type = shape
      .getElementsByTagNameNS(presentationNamespace, "ph")[0]
      ?.getAttribute("type");
    const labels = defaults[type];
    if (!labels) continue;
    for (const text of shape.getElementsByTagNameNS(drawingNamespace, "t")) {
      const value = text.textContent;
      const defaultLabel = !value.trim() || labels.includes(value);
      const slideNumberField =
        type === "sldNum" &&
        text.parentNode?.namespaceURI === drawingNamespace &&
        text.parentNode?.localName === "fld" &&
        text.parentNode?.getAttribute("type") === "slidenum";
      if (
        (master && defaultLabel) ||
        (slideNumberField && (defaultLabel || /^\d+$/u.test(value)))
      )
        text.textContent = `__office_placeholder_${type}__`;
    }
  }
}

function sameEngineExportPart(part, left, right, canonical = false) {
  if (samePartBytes(left, right)) return true;
  if (left && right && /^ppt\/embeddings\/[^/]+\.xlsx$/u.test(part)) {
    // Workbook ZIP timestamps and compression are packaging, not cell edits.
    // Compare every entry name and payload; no workbook XML is normalized.
    try {
      const leftSize = inspectZipPackage(left).expandedBytes;
      const rightSize = inspectZipPackage(right).expandedBytes;
      if (leftSize + rightSize > maximumInputBytes) return false;
      const before = unzipSync(left);
      const after = unzipSync(right);
      const names = Object.keys(before);
      return (
        names.length === Object.keys(after).length &&
        names.every((name) => samePartBytes(before[name], after[name]))
      );
    } catch {
      // Unknown or invalid embedded content stays a significant byte change.
      return false;
    }
  }
  if (!left || !right || !part.endsWith(".xml")) return false;
  const normalized = (bytes) => {
    const document = parseXml({ [part]: bytes }, part);
    if (part === "docProps/app.xml")
      for (const totalTime of document.getElementsByTagNameNS(
        extendedPropertiesNamespace,
        "TotalTime",
      ))
        totalTime.textContent = "__office_save_duration__";
    let fieldIndex = 0;
    for (const field of document.getElementsByTagNameNS(
      drawingNamespace,
      "fld",
    ))
      field.setAttribute("id", `__office_field_${++fieldIndex}__`);
    // The engine numbers shapes across the deck in save order, so an edit
    // elsewhere renumbers this part's shapes. Number them, and the references
    // to them, by position instead.
    const shapeIds = new Map();
    for (const properties of document.getElementsByTagNameNS(
      presentationNamespace,
      "cNvPr",
    )) {
      const id = properties.getAttribute("id");
      if (!shapeIds.has(id))
        shapeIds.set(id, `__office_shape_${shapeIds.size + 1}__`);
      properties.setAttribute("id", shapeIds.get(id));
    }
    for (const { element, attribute } of shapeReferences(document)) {
      const id = shapeIds.get(element.getAttribute(attribute));
      if (id) element.setAttribute(attribute, id);
    }
    // Each save draws new random chart axis ids, which only pair a chart
    // with its axes, and a new PowerPoint modification id for a table or
    // chart frame.
    const axisIds = new Map();
    for (const name of ["axId", "crossAx"])
      for (const axis of document.getElementsByTagNameNS(
        chartNamespace,
        name,
      )) {
        const id = axis.getAttribute("val");
        if (!axisIds.has(id))
          axisIds.set(id, `__office_axis_${axisIds.size + 1}__`);
        axis.setAttribute("val", axisIds.get(id));
      }
    for (const modification of document.getElementsByTagNameNS(
      powerpoint2010Namespace,
      "modId",
    ))
      modification.setAttribute("val", "__office_modification__");
    normalizeGeneratedPlaceholderDisplay(document, part, canonical);
    if (canonical) {
      const tree = (node) => {
        if (node.nodeType === 9) return tree(node.documentElement);
        if (node.nodeType !== 1) return [node.nodeType, node.nodeValue];
        const hasElements = [...node.childNodes].some(child => child.nodeType === 1);
        return [node.namespaceURI ?? "", node.localName,
          [...node.attributes].filter(a => a.namespaceURI !== "http://www.w3.org/2000/xmlns/")
            .map(a => [a.namespaceURI ?? "", a.localName, a.value])
            .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          [...node.childNodes].filter(child => !(hasElements && child.nodeType === 3 && !child.nodeValue.trim())).map(tree)];
      };
      return strToU8(JSON.stringify(tree(document)));
    }
    return serializeXml(document);
  };
  return samePartBytes(normalized(left), normalized(right));
}

// Compare two exports of the same live model, before any preservation budget
// can discard changes. A semantic observation covers only supported fields;
// it cannot establish that an otherwise changed export is a no-op.
export function nativeExportDifferences(baselineBytes, candidateBytes) {
  for (const bytes of [baselineBytes, candidateBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumInputBytes)
      throw new TypeError("Native snapshot inputs must be bounded PPTX bytes.");
    inspectZipPackage(bytes);
  }
  const baseline = unzipSync(baselineBytes);
  const candidate = unzipSync(candidateBytes);
  const normalizeCoreSaveTime = (part, bytes) => {
    if (part !== "docProps/core.xml" || !bytes) return bytes;
    const document = parseXml({ [part]: bytes }, part);
    for (const modified of document.getElementsByTagNameNS(
      "http://purl.org/dc/terms/",
      "modified",
    ))
      modified.textContent = "__office_save_time__";
    return serializeXml(document);
  };
  return [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
    .filter(
      (part) =>
        !sameEngineExportPart(
          part,
          normalizeCoreSaveTime(part, baseline[part]),
          normalizeCoreSaveTime(part, candidate[part]),
          true,
        ),
    )
    .sort();
}

const xmlElementChildren = (node) =>
  [...node.childNodes].filter((child) => child.nodeType === 1);
const xmlElementKey = (node) => `${node.namespaceURI ?? ""}|${node.localName}`;
const xmlHasText = (node) =>
  [...node.childNodes].some(
    (child) =>
      (child.nodeType === 3 || child.nodeType === 4) &&
      child.nodeValue.trim() !== "",
  );
// The engine generates a new field GUID on every save, and numbers shapes
// across the deck in save order.
const volatileXmlAttribute = (element, attribute) =>
  !attribute.namespaceURI &&
  attribute.localName === "id" &&
  ((element.namespaceURI === drawingNamespace && element.localName === "fld") ||
    (element.namespaceURI === presentationNamespace &&
      element.localName === "cNvPr"));
function comparableXml(node) {
  const copy = node.cloneNode(true);
  for (const element of [copy, ...copy.getElementsByTagName("*")])
    for (const attribute of [...element.attributes])
      if (volatileXmlAttribute(element, attribute))
        element.removeAttribute(attribute.name);
  return new XMLSerializer().serializeToString(copy);
}
function occurrenceKeys(nodes) {
  const seen = new Map();
  return nodes.map((node) => {
    const key = xmlElementKey(node);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return `${key}#${index}`;
  });
}
function countByName(nodes) {
  const counts = new Map();
  for (const node of nodes)
    counts.set(xmlElementKey(node), (counts.get(xmlElementKey(node)) ?? 0) + 1);
  return counts;
}

// Three-way merge of one element: `source` is the author's XML, `baseline`
// and `edited` are the engine's saves before and after the command. The
// engine rewrites everything it saves (inherited text settings become
// explicit, fonts get their Microsoft names, sizes pass through 1/100 mm), so
// wherever its two saves agree the author's XML is kept, and only attributes
// and children the command changed are taken from the edited save. Returns
// null when the children cannot be matched by name and position, for example
// when the command changed the number of paragraphs; the caller then takes
// the engine's element whole.
function mergeElementThreeWay(document, source, baseline, edited) {
  if (comparableXml(baseline) === comparableXml(edited))
    return importOoxmlSubtree(document, source, true);
  if (
    xmlElementKey(source) !== xmlElementKey(baseline) ||
    xmlElementKey(baseline) !== xmlElementKey(edited) ||
    xmlHasText(source) ||
    xmlHasText(baseline) ||
    xmlHasText(edited)
  )
    return null;
  const sourceChildren = xmlElementChildren(source);
  const baselineChildren = xmlElementChildren(baseline);
  const editedChildren = xmlElementChildren(edited);
  const sourceCounts = countByName(sourceChildren);
  const baselineCounts = countByName(baselineChildren);
  const editedCounts = countByName(editedChildren);
  for (const name of new Set([
    ...baselineCounts.keys(),
    ...editedCounts.keys(),
  ])) {
    const before = baselineCounts.get(name) ?? 0;
    const after = editedCounts.get(name) ?? 0;
    const authored = sourceCounts.get(name) ?? 0;
    if (before && after && before !== after) return null;
    if (authored && before && authored !== before) return null;
    if (authored && !before && after && authored !== after) return null;
  }

  const merged = importOoxmlSubtree(document, source, false);
  const attributes = new Map();
  for (const element of [baseline, edited])
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!volatileXmlAttribute(element, attribute))
        attributes.set(
          `${attribute.namespaceURI ?? ""}|${attribute.localName}`,
          attribute,
        );
    }
  for (const attribute of attributes.values()) {
    const namespace = attribute.namespaceURI || null;
    const before = baseline.hasAttributeNS(namespace, attribute.localName)
      ? baseline.getAttributeNS(namespace, attribute.localName)
      : null;
    const after = edited.hasAttributeNS(namespace, attribute.localName)
      ? edited.getAttributeNS(namespace, attribute.localName)
      : null;
    if (before === after) continue;
    if (after === null)
      merged.removeAttributeNS(namespace, attribute.localName);
    else merged.setAttributeNS(namespace, attribute.name, after);
  }

  const sourceKeys = occurrenceKeys(sourceChildren);
  const baselineByKey = new Map(
    occurrenceKeys(baselineChildren).map((key, index) => [
      key,
      baselineChildren[index],
    ]),
  );
  const editedKeys = occurrenceKeys(editedChildren);
  const editedByKey = new Map(
    editedKeys.map((key, index) => [key, editedChildren[index]]),
  );
  const sourceKeySet = new Set(sourceKeys);
  // The author and the engine can express one choice (a color, a fill, an
  // autofit mode) with different elements. Keeping the author's element
  // beside one the edit introduced would leave two choices, so such an
  // element is taken from the engine whole.
  if (
    sourceKeys.some(
      (key) => !baselineByKey.has(key) && !editedByKey.has(key),
    ) &&
    editedKeys.some(
      (key, index) =>
        !sourceKeySet.has(key) &&
        (!baselineByKey.has(key) ||
          comparableXml(baselineByKey.get(key)) !==
            comparableXml(editedChildren[index])),
    )
  )
    return null;
  const output = [];
  for (const [index, key] of sourceKeys.entries()) {
    const authored = sourceChildren[index];
    const before = baselineByKey.get(key);
    const after = editedByKey.get(key);
    // The engine never writes this child (for example an empty a:lstStyle).
    if (!before && !after)
      output.push({ key, node: importOoxmlSubtree(document, authored, true) });
    else if (!after) continue;
    else if (!before)
      output.push({ key, node: importOoxmlSubtree(document, after, true) });
    else
      output.push({
        key,
        node:
          mergeElementThreeWay(document, authored, before, after) ??
          importOoxmlSubtree(document, after, true),
      });
  }
  for (const [index, key] of editedKeys.entries()) {
    if (sourceKeySet.has(key)) continue;
    const before = baselineByKey.get(key);
    const after = editedChildren[index];
    // A child only the engine writes, unchanged by the command: the author's
    // XML never had it, so it stays absent.
    if (before && comparableXml(before) === comparableXml(after)) continue;
    // Keep the engine's order: after the nearest earlier sibling already
    // placed, otherwise before the nearest later one.
    let position = -1;
    for (let earlier = index - 1; earlier >= 0 && position < 0; earlier -= 1) {
      const at = output.findIndex((entry) => entry.key === editedKeys[earlier]);
      if (at >= 0) position = at + 1;
    }
    for (
      let later = index + 1;
      later < editedKeys.length && position < 0;
      later += 1
    ) {
      const at = output.findIndex((entry) => entry.key === editedKeys[later]);
      if (at >= 0) position = at;
    }
    output.splice(position < 0 ? output.length : position, 0, {
      key,
      node: importOoxmlSubtree(document, after, true),
    });
  }
  for (const { node } of output) merged.appendChild(node);
  return merged;
}

// Impress rounds an imported shape's original position on its first export.
// A direct keyboard move must apply the exported delta to the author's
// coordinates, otherwise the rounding offset is added to the saved shape.
function applyAuthoredGeometryDelta(
  merged,
  source,
  baseline,
  edited,
  operations,
  geometrySources = null,
) {
  const transform = (shape) => {
    const frame = optionalDirectXmlChild(shape, presentationNamespace, "xfrm");
    if (frame) return frame;
    const properties = optionalDirectXmlChild(shape, presentationNamespace,
      shape.localName === "grpSp" ? "grpSpPr" : "spPr");
    return properties && optionalDirectXmlChild(properties, drawingNamespace, "xfrm");
  };
  const transforms = [merged, source, baseline, edited].map(transform);
  if (geometrySources) {
    const { part, entries } = geometrySources;
    for (const [index, shape] of [source, baseline, edited].entries()) {
      if (transforms[index + 1] || !shapePlaceholder(shape)) continue;
      try {
        transforms[index + 1] = effectiveShapeTransform({ entries: entries[index] }, part, shape);
      } catch {
        // An absent or ambiguous layout/master is not a geometry baseline.
        return false;
      }
    }
  }
  if (!transforms[0] && transforms[1]) {
    const properties = optionalDirectXmlChild(merged, presentationNamespace,
      merged.localName === "grpSp" ? "grpSpPr" : "spPr");
    if (!properties) return false;
    transforms[0] = importOoxmlSubtree(merged.ownerDocument, transforms[1], true);
    properties.insertBefore(transforms[0], properties.firstChild);
  }
  if (!transforms[1] && transforms[2]) {
    // A placeholder can inherit its entire transform from the layout.
    // A compound edit may already have materialized its edited transform in
    // the merge. In either case its authored baseline is the effective
    // inherited geometry; no layout or master may be rewritten.
    if (!transforms[0]) {
      const properties = optionalDirectXmlChild(merged, presentationNamespace,
        merged.localName === "grpSp" ? "grpSpPr" : "spPr");
      if (!properties) return false;
      transforms[0] = importOoxmlSubtree(merged.ownerDocument, transforms[2], true);
      properties.insertBefore(transforms[0], properties.firstChild);
    }
    transforms[1] = transforms[2];
  }
  if (transforms.some((node) => !node)) return false;
  for (const [tag, attributes] of [
    ["off", operations.includes("move") ? ["x", "y"] : []],
    ["ext", operations.includes("resize") ? ["cx", "cy"] : []],
  ]) {
    if (!attributes.length) continue;
    const nodes = transforms.map((node) =>
      optionalDirectXmlChild(node, drawingNamespace, tag),
    );
    if (nodes.some((node) => !node)) return false;
    for (const attribute of attributes) {
      if (nodes.some((node) => !node.hasAttribute(attribute))) return false;
      const values = nodes.map((node) => Number(node.getAttribute(attribute)));
      if (values.some((value) => !Number.isSafeInteger(value))) return false;
      const result = values[1] + values[3] - values[2];
      if (!Number.isSafeInteger(result) || (tag === "ext" && result <= 0))
        return false;
      nodes[0].setAttribute(attribute, String(result));
    }
  }
  return true;
}

// Impress rewrites extended document properties on export. Apply only the
// fields that differ between its two saves to the author's original XML.
// TotalTime is save duration, already excluded by sameEngineExportPart.
function mergeExtendedProperties(originalBytes, noEditBytes, editedBytes) {
  const part = "docProps/app.xml";
  const original = parseXml({ [part]: originalBytes }, part);
  const noEdit = parseXml({ [part]: noEditBytes }, part);
  const edited = parseXml({ [part]: editedBytes }, part);
  for (const document of [original, noEdit, edited])
    if (
      document.documentElement.namespaceURI !== extendedPropertiesNamespace ||
      document.documentElement.localName !== "Properties"
    )
      throw new Error("Native snapshot has invalid extended properties.");
  const childrenByName = (document) => {
    const children = new Map();
    for (const child of xmlElementChildren(document.documentElement)) {
      const key = xmlElementKey(child);
      if (children.has(key))
        throw new Error("Native snapshot has duplicate extended properties.");
      children.set(key, child);
    }
    return children;
  };
  const authored = childrenByName(original);
  const baseline = childrenByName(noEdit);
  const changed = childrenByName(edited);
  let patched = false;
  for (const key of new Set([...baseline.keys(), ...changed.keys()])) {
    const before = baseline.get(key);
    const after = changed.get(key);
    if (
      key === `${extendedPropertiesNamespace}|TotalTime` ||
      (before && after && comparableXml(before) === comparableXml(after))
    )
      continue;
    const source = authored.get(key);
    if (after) {
      const replacement = importOoxmlSubtree(original, after, true);
      if (source) original.documentElement.replaceChild(replacement, source);
      else original.documentElement.appendChild(replacement);
    } else if (source) original.documentElement.removeChild(source);
    patched = true;
  }
  return patched ? serializeXml(original) : originalBytes;
}

function hasRelationshipReference(node) {
  for (const element of [node, ...node.getElementsByTagName("*")])
    for (let index = 0; index < element.attributes.length; index += 1)
      if (
        element.attributes.item(index).namespaceURI ===
        relationshipAttributeNamespace
      )
        return true;
  return false;
}

function preserveUnaffectedSlideShapes(
  part,
  originalBytes,
  noEditBytes,
  editedBytes,
  sourceOperations,
  targetNames = null,
  targetIndexes = null,
  geometrySources = null,
) {
  if (
    !/^ppt\/slides\/slide[^/]+\.xml$/u.test(part) ||
    !originalBytes ||
    !noEditBytes ||
    !editedBytes ||
    (samePartBytes(originalBytes, noEditBytes) && targetIndexes === null)
  )
    return null;
  const documents = [originalBytes, noEditBytes, editedBytes].map((bytes) =>
    parseXml({ [part]: bytes }, part),
  );
  const [authored, normalized, changed] = documents.map(topLevelSlideShapes);
  if (
    !authored ||
    !normalized ||
    !changed ||
    authored.length !== normalized.length
  )
    return null;
  const identity = (node) => {
    const properties = node.getElementsByTagNameNS(
      presentationNamespace,
      "cNvPr",
    )[0];
    return properties
      ? {
          id: properties.getAttribute("id"),
          name: properties.getAttribute("name"),
        }
      : null;
  };
  const shapeText = (node) => {
    try {
      return readShapeText(node);
    } catch {
      return null;
    }
  };
  // Impress can rename a placeholder on the first unedited export. Pair a
  // direct text target by its unique placeholder identity at the same slide
  // position. For a renamed ordinary shape, unique prior text is still the
  // only safe fallback; an empty ordinary shape has no such identity.
  const placeholderKey = (node) => {
    const properties = optionalDirectXmlChild(
      node,
      presentationNamespace,
      "nvSpPr",
    );
    const nonVisual =
      properties &&
      optionalDirectXmlChild(properties, presentationNamespace, "nvPr");
    const placeholder =
      nonVisual &&
      optionalDirectXmlChild(nonVisual, presentationNamespace, "ph");
    return placeholder
      ? JSON.stringify(
          ["type", "idx", "sz", "orient"].map((name) =>
            placeholder.getAttribute(name),
          ),
        )
      : null;
  };
  const uniquelyPairedRenamedTarget = (source, baseline, index) => {
    if (targetIndexes === null || !targetIndexes.has(index)) return false;
    const key = placeholderKey(source);
    if (key !== null && key === placeholderKey(baseline)) {
      const matches = (nodes) =>
        nodes.filter(
          (node) =>
            node.localName === source.localName && placeholderKey(node) === key,
        ).length;
      return matches(authored) === 1 && matches(normalized) === 1;
    }
    const text = shapeText(source);
    if (!text || text !== shapeText(baseline)) return false;
    const matches = (nodes) =>
      nodes.filter(
        (node) =>
          node.localName === source.localName && shapeText(node) === text,
      ).length;
    return matches(authored) === 1 && matches(normalized) === 1;
  };
  const editedById = new Map(changed.map((node) => [identity(node)?.id, node]));
  const uniqueByName = (nodes) => {
    const byName = new Map();
    for (const node of nodes) {
      const name = identity(node)?.name;
      if (name) byName.set(name, byName.has(name) ? null : node);
    }
    return byName;
  };
  const editedByName = uniqueByName(changed);
  const baselineByName = uniqueByName(normalized);
  // The engine numbers shapes across the deck in save order, so a save after
  // an edit that added a layout or a shape earlier in that order renumbers
  // unchanged shapes. A name unique in both saves still pairs them.
  const editedCounterpart = (baseline) => {
    const { id, name } = identity(baseline);
    const byId = editedById.get(id);
    const candidate =
      byId && identity(byId)?.name === name
        ? byId
        : baselineByName.get(name) === baseline
          ? editedByName.get(name)
          : null;
    return candidate?.localName === baseline.localName ? candidate : null;
  };
  const additiveOnly =
    sourceOperations.length > 0 &&
    sourceOperations.every((operation) =>
      additiveShapeOperations.has(operation),
    );
  // A shape the command did not name keeps its authored XML even when the
  // engine's save rewrote it (for example dropping an empty paragraph's
  // alignment): the contract confines the command to its targets.
  const untargeted = (source, index) =>
    targetIndexes !== null
      ? !targetIndexes.has(index)
      : targetNames !== null &&
        !targetNames.has(identity(source)?.name??"");
  const replacements = [];
  // Every author shape matched to its engine counterpart, replaced or not;
  // the ids of both saves are mapped through these pairs.
  const pairs = [];
  for (let index = 0; index < authored.length; index += 1) {
    const source = authored[index];
    const baseline = normalized[index];
    const sourceIdentity = identity(source);
    const baselineIdentity = identity(baseline);
    if (
      !sourceIdentity?.id ||
      !baselineIdentity?.id ||
      source.localName !== baseline.localName ||
      (sourceIdentity.name !== baselineIdentity.name &&
        !uniquelyPairedRenamedTarget(source, baseline, index))
    )
      continue;
    const editedShape = editedCounterpart(baseline);
    if (!editedShape) continue;
    pairs.push({
      index,
      source,
      baseline,
      editedShape,
      sourceId: sourceIdentity.id,
      baselineId: baselineIdentity.id,
      editedId: identity(editedShape).id,
      finalId: identity(editedShape).id,
    });
  }
  if (
    targetIndexes !== null &&
    [...targetIndexes].some(
      (index) => !pairs.some((pair) => pair.index === index),
    )
  )
    return null;
  if (targetIndexes !== null && sourceOperations.length > 0 &&
      sourceOperations.every(operation => directShapeIndexOperations.includes(operation) && operation !== "delete_element")) {
    // These commands cannot retarget package relationships. Build their small
    // semantic delta on the authored slide, keeping even unresolved external
    // pictures and unknown relationship-bearing subtrees in one ID space.
    for (const pair of pairs.filter(pair => targetIndexes.has(pair.index))) {
      const { source, baseline, editedShape } = pair;
      const prior = source.cloneNode(true);
      if (hasRelationshipReference(source)) {
        if (!geometrySources) return null;
        const related = relationshipsPath(part);
        if (!remapPartRelationshipIds(part, serializeXml(source),
            geometrySources.entries[1][related], geometrySources.entries[0][related],
            [geometrySources.entries[1], geometrySources.entries[0]])) return null;
      }
      if (sourceOperations.includes("replace_text")) {
        try {
          const text = readShapeText(editedShape);
          replaceNativeShapeText(source, text);
          if (readShapeText(source) !== text) return null;
        } catch { return null; }
        const properties = [source, baseline, editedShape].map(shape =>
          optionalDirectXmlChild(shape, presentationNamespace, "spPr"));
        if (!properties.every(Boolean)) return null;
        const merged = mergeElementThreeWay(documents[0], ...properties);
        if (!merged) return null;
        source.replaceChild(merged, properties[0]);
      }
      if (sourceOperations.some(operation => ["move", "resize"].includes(operation)) &&
          !applyAuthoredGeometryDelta(source, prior, baseline, editedShape,
            sourceOperations, geometrySources)) return null;
    }
    return serializeXml(documents[0]);
  }
  // An engine element as the author would name it: its references to other
  // shapes in the author's ids, and without its own engine-numbered id.
  const asAuthored = (node, ids) => {
    const copy = node.cloneNode(true);
    for (const { element, attribute } of shapeReferences(copy)) {
      const id = ids.get(element.getAttribute(attribute));
      if (id !== undefined) element.setAttribute(attribute, id);
    }
    return comparableXml(copy);
  };
  const baselineInAuthorIds = new Map(
    pairs.map((pair) => [pair.baselineId, pair.sourceId]),
  );
  const editedInAuthorIds = new Map(
    pairs.map((pair) => [pair.editedId, pair.sourceId]),
  );
  for (const pair of pairs) {
    let { source, baseline } = pair;
    const { editedShape, index } = pair;
    const topologyRequests = geometrySources?.targets?.filter(target =>
      ["insert_table_rows", "delete_table_rows", "insert_table_columns", "delete_table_columns"].includes(target.op) &&
      Number.isSafeInteger(target.index) && Number.isSafeInteger(target.count) &&
      target.shapeIndex === index);
    if (hasRelationshipReference(source)) {
      if (!topologyRequests?.length) continue;
      // Merge authored and both native rows in one relationship ID space.
      // The package-level remapper then retains the authored .rels as usual.
      const related = relationshipsPath(part);
      const entries = geometrySources.entries;
      const aligned = [source, baseline].map((node, i) => remapPartRelationshipIds(
        part, serializeXml(node), entries[2][related], entries[i][related],
        [entries[2], entries[i]]));
      if (aligned.some(bytes => !bytes))
        throw new Error("Native table rows cannot preserve authored relationships in " + part);
      [source, baseline] = aligned.map(bytes => parseXml({ [part]: bytes }, part).documentElement);
    }
    if (
      additiveOnly ||
      untargeted(source, index) ||
      asAuthored(editedShape, editedInAuthorIds) ===
        asAuthored(baseline, baselineInAuthorIds)
    ) {
      replacements.push({
        pair,
        editedShape,
        restored: true,
        node: importOoxmlSubtree(documents[2], source, true),
      });
      continue;
    }
    // Preserve authored properties wherever the two native exports agree.
    const merged = topologyRequests?.length
      ? (topologyRequests[0].op.endsWith("columns") ? mergeNativeTableColumns : mergeNativeTableRows)(documents[2], source, baseline, editedShape, topologyRequests)
      : mergeElementThreeWay(documents[2], source, baseline, editedShape);
    if (topologyRequests?.length && !merged)
      throw new Error("Native table row topology cannot preserve authored rows in " + part);
    if (merged)
      replacements.push({ pair, editedShape, restored: false, node: merged });
  }
  if (!replacements.length) return null;
  // A merged shape mixes both saves, so the space of any shape id it names
  // is unknown.
  if (
    replacements.some(
      ({ restored, node }) => !restored && shapeReferences(node).length,
    )
  )
    return null;
  for (const replacement of replacements)
    replacement.pair.finalId = identity(replacement.node).id;
  const replacing = new Set(replacements.map(({ editedShape }) => editedShape));
  const remainingIds = new Set(
    changed
      .filter((node) => !replacing.has(node))
      .map((node) => identity(node)?.id),
  );
  if (replacements.some(({ pair }) => remainingIds.has(pair.finalId)))
    return null;

  // The slide's animations keep the author's XML when the engine's saves
  // before and after the command animate the same shapes the same way.
  const [authoredTiming, baselineTiming, editedTiming] =
    documents.map(slideTimingNode);
  const inAuthorIds = (node, ids) => {
    if (!node) return "";
    const copy = node.cloneNode(true);
    for (const { element, attribute } of shapeReferences(copy)) {
      const id = ids.get(element.getAttribute(attribute));
      if (id === undefined) return null;
      element.setAttribute(attribute, id);
    }
    return new XMLSerializer().serializeToString(copy);
  };
  const baselineAnimations = inAuthorIds(
    baselineTiming,
    new Map(pairs.map((pair) => [pair.baselineId, pair.sourceId])),
  );
  const restoreTiming =
    authoredTiming !== null &&
    !hasRelationshipReference(authoredTiming) &&
    baselineAnimations !== null &&
    baselineAnimations ===
      inAuthorIds(
        editedTiming,
        new Map(pairs.map((pair) => [pair.editedId, pair.sourceId])),
      );

  const descendantIds = (node) =>
    [...node.getElementsByTagNameNS(presentationNamespace, "cNvPr")]
      .slice(1)
      .map((properties) => properties.getAttribute("id"));
  const replacedEngineIds = new Set(
    replacements.flatMap(({ editedShape }) => descendantIds(editedShape)),
  );
  // Only a restored shape is known to keep the author's ids inside it.
  const restoredAuthorIds = new Set(
    replacements
      .filter(({ restored }) => restored)
      .flatMap(({ node }) => descendantIds(node)),
  );
  const authorOrigin = new Set(
    replacements.filter(({ restored }) => restored).map(({ node }) => node),
  );
  for (const { editedShape, node } of replacements)
    editedShape.parentNode.replaceChild(node, editedShape);
  if (restoreTiming) {
    const timing = importOoxmlSubtree(documents[2], authoredTiming, true);
    if (editedTiming)
      editedTiming.parentNode.replaceChild(timing, editedTiming);
    else insertSlideTiming(documents[2], timing);
    authorOrigin.add(timing);
  }

  // Shape ids named by animations and connectors follow the shapes: an
  // author reference to a shape the engine kept takes the engine's id, an
  // engine reference to a restored shape the author's.
  const engineToFinal = new Map(
    pairs.map((pair) => [pair.editedId, pair.finalId]),
  );
  const authorToFinal = new Map(
    pairs.map((pair) => [pair.sourceId, pair.finalId]),
  );
  const fromAuthor = (element) => {
    for (let node = element; node; node = node.parentNode)
      if (authorOrigin.has(node)) return true;
    return false;
  };
  for (const { element, attribute } of shapeReferences(documents[2])) {
    const id = element.getAttribute(attribute);
    if (fromAuthor(element)) {
      if (authorToFinal.has(id))
        element.setAttribute(attribute, authorToFinal.get(id));
      else if (!restoredAuthorIds.has(id)) return null;
    } else if (engineToFinal.has(id))
      element.setAttribute(attribute, engineToFinal.get(id));
    else if (replacedEngineIds.has(id)) return null;
  }
  const finalIds = [
    ...documents[2].getElementsByTagNameNS(presentationNamespace, "cNvPr"),
  ].map((properties) => properties.getAttribute("id"));
  const knownIds = new Set(finalIds);
  if (
    knownIds.size !== finalIds.length ||
    shapeReferences(documents[2]).some(
      ({ element, attribute }) =>
        !knownIds.has(element.getAttribute(attribute)),
    )
  )
    return null;
  return serializeXml(documents[2]);
}

// Row coordinates come from the validated native request, never from a guess
// at repeated or empty cell text. Existing rows keep their authored XML; only
// genuinely new rows come from the native editor's selected-row defaults.
function mergeNativeTableRows(document, source, baseline, edited, requests) {
  const originals = [source, baseline, edited];
  const tables = originals.map(shape => [...shape.getElementsByTagNameNS(drawingNamespace, "tbl")]);
  if (tables.some(t => t.length !== 1)) return null;
  const rows = tables.map(t => xmlElementChildren(t[0]).filter(c =>
    c.namespaceURI === drawingNamespace && c.localName === "tr"));
  if (rows[0].length !== rows[1].length) return null;
  const order = rows[0].map((_, i) => i);
  for (const request of requests) {
    if (request.count < 1 || request.count > 100 || request.index < 0 || request.index > order.length) return null;
    if (request.op === "insert_table_rows")
      order.splice(request.index, 0, ...Array(request.count).fill(null));
    else {
      if (request.index + request.count > order.length || request.count >= order.length) return null;
      order.splice(request.index, request.count);
    }
  }
  if (order.length !== rows[2].length) return null;
  const copies = originals.map(shape => shape.cloneNode(true));
  for (const shape of copies) {
    const table = shape.getElementsByTagNameNS(drawingNamespace, "tbl")[0];
    for (const row of xmlElementChildren(table).filter(c =>
      c.namespaceURI === drawingNamespace && c.localName === "tr")) table.removeChild(row);
  }
  const merged = mergeElementThreeWay(document, ...copies);
  if (!merged) return null;
  const table = merged.getElementsByTagNameNS(drawingNamespace, "tbl")[0];
  const successor = xmlElementChildren(table).find(c =>
    c.namespaceURI === drawingNamespace && c.localName === "extLst");
  for (const [index, original] of order.entries()) {
    const row = original === null
      ? importOoxmlSubtree(document, rows[2][index], true)
      : mergeElementThreeWay(document, rows[0][original], rows[1][original], rows[2][index]);
    if (!row) return null;
    table.insertBefore(row, successor ?? null);
  }
  return merged;
}

// Column coordinates likewise identify retained grid entries and cells without
// comparing their text. Row-level authored properties stay in the three-way
// merge, and only new cells inherit native insertion defaults.
function mergeNativeTableColumns(document, source, baseline, edited, requests) {
  const inputs = [source, baseline, edited];
  const child = (node, name) => xmlElementChildren(node).filter(c => c.namespaceURI === drawingNamespace && c.localName === name);
  const tables = inputs.map(shape => [...shape.getElementsByTagNameNS(drawingNamespace, "tbl")]);
  if (tables.some(t => t.length !== 1)) return null;
  const grids = tables.map(t => child(t[0], "tblGrid"));
  if (grids.some(g => g.length !== 1)) return null;
  const columns = grids.map(g => child(g[0],"gridCol"));
  const rows = tables.map(t => child(t[0],"tr"));
  if (rows.some(r => r.length !== rows[0].length) || columns[0].length !== columns[1].length) return null;
  const order = columns[0].map((_,index) => index);
  for (const request of requests) {
    if (request.count < 1 || request.count > 100 || request.index < 0 || request.index > order.length) return null;
    if (request.op === "insert_table_columns") order.splice(request.index,0,...Array(request.count).fill(null));
    else if (request.op === "delete_table_columns" && request.index + request.count <= order.length && request.count < order.length)
      order.splice(request.index,request.count);
    else return null;
  }
  if (order.length !== columns[2].length || order.length > 256) return null;
  const cells = rows.map(rs => rs.map(r => child(r,"tc")));
  if (cells.some((rs,i) => rs.some(row => row.length !== columns[i].length))) return null;
  const copies = inputs.map(shape => shape.cloneNode(true));
  for (const copy of copies) {
    const table = copy.getElementsByTagNameNS(drawingNamespace,"tbl")[0];
    const grid = child(table,"tblGrid")[0];
    for (const col of child(grid,"gridCol")) grid.removeChild(col);
    for (const row of child(table,"tr")) for (const cell of child(row,"tc")) row.removeChild(cell);
  }
  const merged = mergeElementThreeWay(document,...copies);
  if (!merged) return null;
  const table = merged.getElementsByTagNameNS(drawingNamespace,"tbl")[0];
  const grid = child(table,"tblGrid")[0], mergedRows = child(table,"tr");
  const append = (parent,node) => parent.insertBefore(node, child(parent,"extLst")[0] ?? null);
  // A topology request owns added/deleted columns, not retained widths or
  // cells. Native cumulative-grid subtraction can perturb those widths even
  // after its history setter has kept the exact authored TableGrid.
  for (const [index,original] of order.entries()) {
    const col = original === null ? importOoxmlSubtree(document,columns[2][index],true)
      : importOoxmlSubtree(document,columns[0][original],true);
    if (!col) return null;
    append(grid,col);
    for (const [r,row] of mergedRows.entries()) {
      const cell = original === null ? importOoxmlSubtree(document,cells[2][r][index],true)
        : importOoxmlSubtree(document,cells[0][r][original],true);
      if (!cell) return null;
      append(row,cell);
    }
  }
  return merged;
}

function removeDirectShapeFromOriginal(
  part,
  originalBytes,
  noEditBytes,
  editedBytes,
  index,
  name,
) {
  if (!originalBytes || !noEditBytes || !editedBytes) return null;
  const documents = [originalBytes, noEditBytes, editedBytes].map((bytes) =>
    parseXml({ [part]: bytes }, part),
  );
  const [authored, baseline, edited] = documents.map(topLevelSlideShapes);
  if (
    !authored ||
    !baseline ||
    !edited ||
    authored.length !== baseline.length ||
    baseline.length !== edited.length + 1 ||
    index < 0 ||
    index >= baseline.length
  )
    return null;
  const identity = (node) => {
    const properties = node.getElementsByTagNameNS(
      presentationNamespace,
      "cNvPr",
    )[0];
    return (
      properties && {
        id: properties.getAttribute("id"),
        name: properties.getAttribute("name"),
      }
    );
  };
  const removed = authored[index];
  const removedId = identity(removed)?.id;
  if (
    !removedId ||
    identity(removed)?.name !== name ||
    removed.localName !== baseline[index].localName ||
    shapeReferences(documents[0]).some(
      ({ element, attribute }) => element.getAttribute(attribute) === removedId,
    )
  )
    return null;
  const retained = baseline.filter((_, shapeIndex) => shapeIndex !== index);
  const uniqueText = (node, collection) => {
    try {
      const text = readShapeText(node);
      return text &&
        collection.filter((candidate) => {
          try {
            return readShapeText(candidate) === text;
          } catch {
            return false;
          }
        }).length === 1
        ? text
        : null;
    } catch {
      return null;
    }
  };
  const unnamedFingerprint = (node) => {
    const copy = node.cloneNode(true);
    for (const properties of copy.getElementsByTagNameNS(presentationNamespace, "cNvPr"))
      properties.removeAttribute("name");
    return comparableXml(copy);
  };
  const uniqueUnchangedShape = (before, after) => {
    const fingerprint = unnamedFingerprint(before);
    return fingerprint === unnamedFingerprint(after) &&
      baseline.filter(node => unnamedFingerprint(node) === fingerprint).length === 1 &&
      edited.filter(node => unnamedFingerprint(node) === fingerprint).length === 1;
  };
  if (
    retained.some(
      (node, shapeIndex) =>
        node.localName !== edited[shapeIndex].localName ||
        (identity(node)?.name !== identity(edited[shapeIndex])?.name &&
          (!uniqueText(node, baseline) ||
            uniqueText(node, baseline) !==
            uniqueText(edited[shapeIndex], edited)) &&
          !uniqueUnchangedShape(node, edited[shapeIndex])),
    )
  )
    return null;
  // Deleting a drawing does not grant authority to delete its assets. Keep
  // authored relationships and dependencies, including any shared consumers.
  removed.parentNode.removeChild(removed);
  return serializeXml(documents[0]);
}

function topLevelSlideShapes(document) {
  const commonSlide = directXmlChild(
    document.documentElement,
    presentationNamespace,
    "cSld",
  );
  const tree =
    commonSlide && directXmlChild(commonSlide, presentationNamespace, "spTree");
  if (!tree) return null;
  return [...tree.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === presentationNamespace &&
      ["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(node.localName),
  );
}

// Attributes through which a slide names its shapes by id: animation and
// build targets, and the shapes a connector joins.
const shapeReferenceAttributes = [
  [presentationNamespace, "spTgt", "spid"],
  [presentationNamespace, "inkTgt", "spid"],
  [presentationNamespace, "bldP", "spid"],
  [presentationNamespace, "bldDgm", "spid"],
  [presentationNamespace, "bldOleChart", "spid"],
  [presentationNamespace, "bldGraphic", "spid"],
  [drawingNamespace, "stCxn", "id"],
  [drawingNamespace, "endCxn", "id"],
];

function shapeReferences(root) {
  return shapeReferenceAttributes.flatMap(([namespace, name, attribute]) =>
    [...root.getElementsByTagNameNS(namespace, name)]
      .filter((element) => element.hasAttribute(attribute))
      .map((element) => ({ element, attribute })),
  );
}

// A slide's animations sit directly under p:sld, either as p:timing or
// wrapped in mc:AlternateContent.
function slideTimingNode(document) {
  for (const child of [...document.documentElement.childNodes]) {
    if (child.nodeType !== 1) continue;
    if (
      child.namespaceURI === presentationNamespace &&
      child.localName === "timing"
    )
      return child;
    if (
      child.namespaceURI === markupCompatibilityNamespace &&
      child.localName === "AlternateContent" &&
      child.getElementsByTagNameNS(presentationNamespace, "timing").length
    )
      return child;
  }
  return null;
}

function insertSlideTiming(document, node) {
  const root = document.documentElement;
  const following = [...root.childNodes].find(
    (child) =>
      child.nodeType === 1 &&
      child.namespaceURI === presentationNamespace &&
      child.localName === "extLst",
  );
  if (following) root.insertBefore(node, following);
  else root.appendChild(node);
}

// A slide transition sits directly under p:sld, either as p:transition or
// wrapped in mc:AlternateContent for PowerPoint 2010 attributes.
function slideTransitionNode(document) {
  for (const child of [...document.documentElement.childNodes]) {
    if (child.nodeType !== 1) continue;
    if (
      child.namespaceURI === presentationNamespace &&
      child.localName === "transition"
    )
      return child;
    if (
      child.namespaceURI === markupCompatibilityNamespace &&
      child.localName === "AlternateContent" &&
      child.getElementsByTagNameNS(presentationNamespace, "transition").length
    )
      return child;
  }
  return null;
}

function transitionElements(node) {
  if (!node) return [];
  return node.namespaceURI === presentationNamespace &&
    node.localName === "transition"
    ? [node]
    : [...node.getElementsByTagNameNS(presentationNamespace, "transition")];
}

function relationshipIdentity(sourcePart, relationship) {
  return `${relationship.getAttribute("Type")}\u0000${
    relationship.getAttribute("TargetMode") === "External"
      ? `external:${relationship.getAttribute("Target")}`
      : resolvePart(sourcePart, relationship.getAttribute("Target"))
  }`;
}

// An author's node copied into a part whose .rels came from the engine still
// names the author's relationship ids, which the engine may have renumbered or
// dropped. Rewrite each r:* reference to the merged relationship with the same
// type and target, adding the author's relationship when it is missing. A
// reference whose internal target is not in the merged package is refused.
function relationshipAdopter(part, original, merged) {
  const relationshipPath = relationshipsPath(part);
  const document = merged[relationshipPath]
    ? parseXml(merged, relationshipPath)
    : null;
  const authored = new Map(
    original[relationshipPath]
      ? relationshipElements(parseXml(original, relationshipPath)).map(
          (relationship) => [relationship.getAttribute("Id"), relationship],
        )
      : [],
  );
  const merge = new Map(
    document
      ? relationshipElements(document).map((relationship) => [
          relationshipIdentity(part, relationship),
          relationship.getAttribute("Id"),
        ])
      : [],
  );
  let changed = false;
  return {
    adopt(node) {
      for (const element of [node, ...node.getElementsByTagName("*")])
        for (let index = 0; index < element.attributes.length; index += 1) {
          const attribute = element.attributes.item(index);
          // An empty id refers to no part (PowerPoint's media hyperlink).
          if (
            attribute.namespaceURI !== relationshipAttributeNamespace ||
            !attribute.value
          )
            continue;
          const relationship = authored.get(attribute.value);
          if (!relationship || !document) return false;
          if (
            relationship.getAttribute("TargetMode") !== "External" &&
            !merged[resolvePart(part, relationship.getAttribute("Target"))]
          )
            return false;
          const identity = relationshipIdentity(part, relationship);
          let id = merge.get(identity);
          if (!id) {
            const copy = importOoxmlSubtree(document, relationship, true);
            id = nextRelationshipId(document);
            copy.setAttribute("Id", id);
            document.documentElement.appendChild(copy);
            merge.set(identity, id);
            changed = true;
          }
          attribute.value = id;
        }
      return true;
    },
    relationships: () => (changed ? serializeXml(document) : null),
  };
}

function insertSlideTransition(document, node) {
  const root = document.documentElement;
  const following = [...root.childNodes].find(
    (child) =>
      child.nodeType === 1 &&
      child.namespaceURI === presentationNamespace &&
      ["timing", "extLst"].includes(child.localName),
  );
  if (following) root.insertBefore(node, following);
  else root.appendChild(node);
}

// LibreOffice rewrites the slide transition on every export: even an unedited
// save drops the transition sound and PowerPoint 2010 attributes. Apply the
// same three-way rule as other parts: when the no-edit and edited exports
// agree, the author's original transition stays; when the edit changed it,
// keep the edit but carry the author's sound over if the engine dropped it.
// Runs after every part is merged so the sound's media part and the slide's
// final relationships are known.
function mergeSlideTransition(part, original, noEdit, merged) {
  if (
    !/^ppt\/slides\/slide[^/]+\.xml$/u.test(part) ||
    !original[part] ||
    !noEdit[part] ||
    !merged[part]
  )
    return null;
  const authored = slideTransitionNode(parseXml(original, part));
  if (!authored) return null;
  const baseline = slideTransitionNode(parseXml(noEdit, part));
  const selected = parseXml(merged, part);
  const edited = slideTransitionNode(selected);
  const serialized = (node) =>
    node ? new XMLSerializer().serializeToString(node) : null;
  const adopter = relationshipAdopter(part, original, merged);
  if (serialized(baseline) === serialized(edited)) {
    if (serialized(edited) === serialized(authored)) return null;
    const restored = importOoxmlSubtree(selected, authored, true);
    if (!adopter.adopt(restored)) return null;
    if (edited) selected.documentElement.replaceChild(restored, edited);
    else insertSlideTransition(selected, restored);
    return {
      slide: serializeXml(selected),
      relationships: adopter.relationships(),
    };
  }
  const sound = authored.getElementsByTagNameNS(
    presentationNamespace,
    "sndAc",
  )[0];
  const targets = transitionElements(edited);
  if (
    !sound ||
    !targets.length ||
    targets.some(
      (transition) =>
        transition.getElementsByTagNameNS(presentationNamespace, "sndAc")
          .length,
    )
  )
    return null;
  for (const transition of targets) {
    const extension = [...transition.childNodes].find(
      (child) =>
        child.nodeType === 1 &&
        child.namespaceURI === presentationNamespace &&
        child.localName === "extLst",
    );
    const copy = importOoxmlSubtree(selected, sound, true);
    if (!adopter.adopt(copy)) return null;
    if (extension) transition.insertBefore(copy, extension);
    else transition.appendChild(copy);
  }
  return {
    slide: serializeXml(selected),
    relationships: adopter.relationships(),
  };
}

function repairChangedTableCellInsets(
  part,
  originalBytes,
  noEditBytes,
  editedBytes,
  sourceOperations,
) {
  if (
    !/^ppt\/slides\/slide[^/]+\.xml$/u.test(part) ||
    !sourceOperations.includes("set_table_cell_format") ||
    !originalBytes ||
    !noEditBytes ||
    !editedBytes
  )
    return null;
  const original = parseXml({ [part]: originalBytes }, part);
  const baseline = parseXml({ [part]: noEditBytes }, part);
  const edited = parseXml({ [part]: editedBytes }, part);
  const cells = (document) => [
    ...document.getElementsByTagNameNS(drawingNamespace, "tc"),
  ];
  const authored = cells(original);
  const before = cells(baseline);
  const after = cells(edited);
  if (
    !before.length ||
    authored.length !== before.length ||
    before.length !== after.length
  )
    return null;
  const child = (parent, localName) =>
    parent &&
    [...parent.childNodes].find(
      (node) =>
        node.nodeType === 1 &&
        node.namespaceURI === drawingNamespace &&
        node.localName === localName,
    );
  let changed = false;
  for (let index = 0; index < before.length; index += 1) {
    const beforeBody = child(child(before[index], "txBody"), "bodyPr");
    const afterBody = child(child(after[index], "txBody"), "bodyPr");
    const authoredProperties = child(authored[index], "tcPr");
    const cellProperties = child(after[index], "tcPr");
    if (!beforeBody || !afterBody || !cellProperties) continue;
    for (const [textAttribute, cellAttribute] of [
      ["tIns", "marT"],
      ["bIns", "marB"],
    ]) {
      const previous = beforeBody.getAttribute(textAttribute);
      const requested = afterBody.getAttribute(textAttribute);
      const authored = authoredProperties?.getAttribute(cellAttribute);
      const value = previous === requested ? authored : requested;
      if (
        value === null ||
        !/^\d+$/u.test(value) ||
        cellProperties.getAttribute(cellAttribute) === value
      )
        continue;
      // Impress writes edited insets to a:bodyPr, but imports them from
      // a:tcPr. Carry an edited value across, or retain the author's prior
      // explicit value when a later edit touches another cell property.
      cellProperties.setAttribute(cellAttribute, value);
      changed = true;
    }
  }
  return changed ? serializeXml(edited) : null;
}

// LibreOffice renumbers a part's relationship ids on export even when their
// targets are unchanged. When the edited part keeps the engine's .rels but the
// author's .rels are retained, rewrite each r:* reference to the author's id
// with the same relationship type and resolved target. Returns null when a
// reference has no unique counterpart, so the caller refuses the candidate.
export function remapPartRelationshipIds(
  part,
  bytes,
  originalRels,
  engineRels,
  imageSources = null,
) {
  if (!bytes || !originalRels || !engineRels || !part.endsWith(".xml"))
    return null;
  const relationshipPath = relationshipsPath(part);
  const keyed = (relsBytes) =>
    relationshipElements(
      parseXml({ [relationshipPath]: relsBytes }, relationshipPath),
    ).map((relationship) => ({
      id: relationship.getAttribute("Id"),
      key: relationshipIdentity(part, relationship),
      relationship,
    }));
  const engineRelationships = keyed(engineRels);
  const originals = keyed(originalRels);
  const engineById = new Map(
    engineRelationships.map((item) => [item.id, item]),
  );
  const originalByKey = new Map();
  for (const { id, key } of originals)
    originalByKey.set(key, originalByKey.has(key) ? null : id);
  let imageTypes = null;
  const imageResource = (relationship, entries, types) => {
    if (
      relationship.getAttribute("Type") !==
        `${relationshipAttributeNamespace}/image` ||
      relationship.getAttribute("TargetMode") === "External"
    )
      return null;
    const target = resolvePart(part, relationship.getAttribute("Target"));
    const contentType = declaredContentType(types, target);
    if (
      !["image/png", "image/jpeg"].includes(contentType) ||
      !entries[target]?.length
    )
      return null;
    return { bytes: entries[target], contentType };
  };
  const equivalentImageId = (item) => {
    if (
      !imageSources ||
      !item ||
      item.relationship.getAttribute("Type") !==
        `${relationshipAttributeNamespace}/image` ||
      item.relationship.getAttribute("TargetMode") === "External"
    )
      return null;
    imageTypes ??= imageSources.map((entries) =>
      contentTypeDeclarations(parseXml(entries, contentTypesPath)),
    );
    const source = imageResource(
      item.relationship,
      imageSources[1],
      imageTypes[1],
    );
    if (!source) return null;
    // A filename is not content identity. Only a unique internal PNG/JPEG
    // with the same declared type and exact bytes can bridge a renamed part.
    const matches = originals.filter((candidate) => {
      const destination = imageResource(
        candidate.relationship,
        imageSources[0],
        imageTypes[0],
      );
      return (
        destination?.contentType === source.contentType &&
        samePartBytes(destination.bytes, source.bytes)
      );
    });
    return matches.length === 1 ? matches[0].id : null;
  };
  const document = parseXml({ [part]: bytes }, part);
  let changed = false;
  for (const element of [
    document.documentElement,
    ...document.getElementsByTagName("*"),
  ])
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (
        attribute.namespaceURI !== relationshipAttributeNamespace ||
        !attribute.value
      )
        continue;
      const item = engineById.get(attribute.value);
      const originalId =
        item && originalByKey.has(item.key)
          ? originalByKey.get(item.key)
          : equivalentImageId(item);
      if (!originalId) return null;
      if (originalId !== attribute.value) {
        attribute.value = originalId;
        changed = true;
      }
    }
  return changed ? serializeXml(document) : bytes;
}

// A presentation chart's cache and its embedded workbook are two views of the
// same authored data. Prepare one owned workbook snapshot for the adapter to
// install through native history together with the cache mutation.
export function prepareChartSeriesWorkbookMutation(
  input,
  { slideIndex, shapeName, seriesIndex, seriesPosition, values, allowNoop = false },
) {
  const preserveValues=values==null&&allowNoop;
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > maximumInputBytes ||
    !Number.isInteger(slideIndex) ||
    slideIndex < 0 ||
    typeof shapeName !== "string" ||
    !shapeName ||
    (seriesPosition==null?(!Number.isInteger(seriesIndex)||seriesIndex<0):(!Number.isInteger(seriesPosition)||seriesPosition<0))||
    !preserveValues&&(!Array.isArray(values)||!values.length||values.length>maximumEntries||
      Array.from(values).some((value)=>value!==null&&!Number.isFinite(value)))
  )
    throw new Error("Invalid bounded chart data mutation.");
  inspectZipPackage(input);
  const entries = unzipSync(input),
    slide = orderedSlidePaths(entries)[slideIndex];
  if (!slide) throw new Error("Chart source slide is missing.");
  const frames = [
    ...parseXml(entries, slide).getElementsByTagNameNS(
      presentationNamespace,
      "graphicFrame",
    ),
  ].filter((frame) =>
    [...frame.getElementsByTagNameNS(presentationNamespace, "cNvPr")].some(
      (node) => node.getAttribute("name") === shapeName,
    ),
  );
  if (frames.length !== 1) throw new Error("Chart source frame is not unique.");
  const charts = [...frames[0].getElementsByTagNameNS(chartNamespace, "chart")];
  if (charts.length !== 1)
    throw new Error("Chart source frame has no unique chart.");
  const resolveReference = (owner, id, type) => {
    const rels = relationshipsPath(owner);
    if (!entries[rels]) throw new Error("Chart data relationship is missing.");
    const matches = relationshipElements(parseXml(entries, rels)).filter(
      (node) =>
        node.getAttribute("Id") === id &&
        node.getAttribute("Type") ===
          `${relationshipAttributeNamespace}/${type}` &&
        node.getAttribute("TargetMode") !== "External",
    );
    if (matches.length !== 1)
      throw new Error("Chart data relationship is not uniquely internal.");
    const part = resolvePart(owner, matches[0].getAttribute("Target"));
    if (!entries[part])
      throw new Error("Chart data relationship target is missing.");
    return part;
  };
  const chartPart = resolveReference(
    slide,
    charts[0].getAttributeNS(relationshipAttributeNamespace, "id"),
    "chart",
  );
  const chart = parseXml(entries, chartPart);
  const allSeries = [
    ...chart.getElementsByTagNameNS(chartNamespace, "ser"),
  ];
  const series=seriesPosition==null?allSeries.filter(
    (node) =>
      optionalDirectXmlChild(node, chartNamespace, "idx")?.getAttribute(
        "val",
      ) === String(seriesIndex),
  ):(allSeries[seriesPosition]?[allSeries[seriesPosition]]:[]);
  if (series.length !== 1) throw new Error("Chart series is not unique.");
  const valueContainer=optionalDirectXmlChild(series[0],chartNamespace,"val")??optionalDirectXmlChild(series[0],chartNamespace,"yVal");
  if(!valueContainer)throw Error("Chart series has no owned numeric value range.");
  const reference = directXmlChild(
    valueContainer,
    chartNamespace,
    "numRef",
  );
  const formula = directXmlChild(reference, chartNamespace, "f").textContent;
  const range =
    /^(?:'((?:[^']|'')+)'|([^!'\[\]]+))!\$?([A-Z]+)\$?([1-9]\d*)(?::\$?([A-Z]+)\$?([1-9]\d*))?$/u.exec(
      formula,
    );
  if (!range)
    throw new Error("Chart data needs one bounded internal cell range.");
  const sheetName = range[1]?.replaceAll("''", "'") ?? range[2];
  const column = (text) =>
    [...text].reduce(
      (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
      0,
    );
  const [c1, r1, c2, r2] = [
    column(range[3]),
    Number(range[4]),
    column(range[5]??range[3]),
    Number(range[6]??range[4]),
  ];
  const rangeLength=(c2-c1+1)*(r2-r1+1);
  if(!Number.isSafeInteger(rangeLength)||rangeLength<1||rangeLength>maximumEntries)
    throw Error("Chart data range exceeds the adapter limit.");
  if(preserveValues)values=Array(rangeLength).fill(null);
  if (
    c1 > 16384 ||
    c2 > 16384 ||
    r1 > 1048576 ||
    r2 > 1048576 ||
    c2 < c1 ||
    r2 < r1 ||
    (c1 !== c2 && r1 !== r2) ||
    (c2 - c1 + 1) * (r2 - r1 + 1) !== values.length
  )
    throw new Error("Chart data range and values differ.");
  const cache = directXmlChild(reference, chartNamespace, "numCache");
  const points = [...cache.getElementsByTagNameNS(chartNamespace, "pt")];
  if (
    Number(directXmlChild(cache,chartNamespace,"ptCount").getAttribute("val"))!==values.length||
    new Set(points.map((point) => point.getAttribute("idx"))).size !==
      points.length||points.some(point=>!/^\d+$/u.test(point.getAttribute("idx"))||Number(point.getAttribute("idx"))>=values.length)
  )
    throw new Error(
      "Chart data cache must cover the complete requested range.",
    );
  const previousValues = values.map((_, index) => {
    const point = points.find(
      (point) => point.getAttribute("idx") === String(index),
    );
    const text =
      point && directXmlChild(point, chartNamespace, "v").textContent;
    if (!point||text?.trim()==="")return null;
    if (!text?.trim() || !Number.isFinite(Number(text)))
      throw new Error("Chart data cache value is not numeric.");
    return Number(text);
  });
  if(preserveValues)values=previousValues.slice();
  const external = [
    ...chart.getElementsByTagNameNS(chartNamespace, "externalData"),
  ];
  if (external.length !== 1)
    throw new Error("Chart data has no unique embedded workbook.");
  const workbookPart = resolveReference(
    chartPart,
    external[0].getAttributeNS(relationshipAttributeNamespace, "id"),
    "package",
  );
  if (!/^ppt\/embeddings\/[^/]+\.xlsx$/u.test(workbookPart))
    throw new Error("Chart data workbook is not an internal XLSX.");
  const workbookBytes = entries[workbookPart];
  if (inspectZipPackage(workbookBytes).expandedBytes > maximumInputBytes)
    throw new Error("Chart workbook exceeds the adapter limit.");
  const workbook = unzipSync(workbookBytes),
    workbookDocument = parseXml(workbook, "xl/workbook.xml");
  const spreadsheetNamespace = workbookDocument.documentElement.namespaceURI;
  if (
    ![
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "http://schemas.openxmlformats.org/spreadsheetml/2006/7/main",
      "http://purl.oclc.org/ooxml/spreadsheetml/main",
    ].includes(spreadsheetNamespace)
  )
    throw new Error("Chart workbook namespace is not supported.");
  const sheets = [
    ...workbookDocument.getElementsByTagNameNS(spreadsheetNamespace, "sheet"),
  ].filter((node) => node.getAttribute("name") === sheetName);
  if (sheets.length !== 1)
    throw new Error("Chart worksheet name is not unique.");
  const sheetId =
    sheets[0].getAttributeNS(relationshipAttributeNamespace, "id") ||
    sheets[0].getAttributeNS(
      "http://purl.oclc.org/ooxml/officeDocument/relationships",
      "id",
    );
  const sheetRelations = relationshipElements(
    parseXml(workbook, "xl/_rels/workbook.xml.rels"),
  ).filter(
    (node) =>
      node.getAttribute("Id") === sheetId &&
      [
        `${relationshipAttributeNamespace}/worksheet`,
        "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
      ].includes(node.getAttribute("Type")) &&
      node.getAttribute("TargetMode") !== "External",
  );
  if (sheetRelations.length !== 1)
    throw new Error("Chart worksheet relationship is not unique.");
  const worksheetPart = resolvePart(
    "xl/workbook.xml",
    sheetRelations[0].getAttribute("Target"),
  );
  const worksheet = parseXml(workbook, worksheetPart),
    cells = [...worksheet.getElementsByTagNameNS(spreadsheetNamespace, "c")];
  const columnName = (value) => {
    let text = "";
    for (; value; value = Math.floor((value - 1) / 26))
      text = String.fromCharCode(65 + ((value - 1) % 26)) + text;
    return text;
  };
  const changedCells = [];
  const ownedCells = [];
  for (const [index, value] of values.entries()) {
    const address = `${columnName(c1 + (r1 === r2 ? index : 0))}${r1 + (c1 === c2 ? index : 0)}`;
    ownedCells.push(address);
    const matches = cells.filter((cell) => cell.getAttribute("r") === address);
    if (
      matches.length !== 1 ||
      ![null, "", "n"].includes(matches[0].getAttribute("t")) ||
      optionalDirectXmlChild(matches[0], spreadsheetNamespace, "f")
    )
      throw new Error(
        "Chart target cell must be one authored numeric constant.",
      );
    const node = optionalDirectXmlChild(matches[0], spreadsheetNamespace, "v"),
      previous = node?.textContent.trim()?Number(node.textContent):null;
    if (
      previous!==null&&!Number.isFinite(previous)||
      (previous===null)!==(previousValues[index]===null)||
      previous!==null&&Math.abs(previous - previousValues[index]) >
        1e-12 * Math.max(1, Math.abs(previous), Math.abs(previousValues[index]))
    )
      throw new Error(
        "Chart cache and authored workbook disagree before mutation.",
      );
    if (value !== previousValues[index]) {
      if(value===null){if(node)matches[0].removeChild(node);}
      else {
        const valueNode=node??worksheet.createElementNS(spreadsheetNamespace,"v");valueNode.textContent=String(value);
        if(!node)matches[0].appendChild(valueNode);
      }
      changedCells.push({ address, previous, value });
    }
  }
  if (!changedCells.length && !allowNoop)
    throw new Error("Chart data mutation changed no cell.");
  workbook[worksheetPart] = serializeXml(worksheet);
  const bytes = zipSync(workbook, {
    level: 6,
    mtime: deterministicZipModifiedAt,
  });
  return {
    bytes,
    chartPart,
    workbookPart,
    worksheetPart,
    sheetName,
    previousValues,
    values,
    changedCells,
    ownedCells,
  };
}

// Prepare the entire canonical data matrix and its labels against the owned
// workbook. This extends the same single-series authority; it never invents a
// spreadsheet from chart caches or replaces unrelated workbook parts.
export function prepareChartWorkbookMutation(input, request) {
  const {slideIndex, shapeName, rowDescriptions, columnDescriptions} = request;
  let {data}=request;
  if(data==null){
    if(rowDescriptions==null&&columnDescriptions==null)throw Error("Chart data request changes no data or labels.");
    const first=prepareChartSeriesWorkbookMutation(input,{slideIndex,shapeName,seriesPosition:0,allowNoop:true});
    const chart=parseXml(unzipSync(input),first.chartPart),series=[...chart.getElementsByTagNameNS(chartNamespace,"ser")];
    const columns=series.map((_,seriesPosition)=>prepareChartSeriesWorkbookMutation(input,{slideIndex,shapeName,seriesPosition,allowNoop:true}).values);
    if(columns.some(values=>values.length!==columns[0].length))throw Error("Chart series do not share one row count.");
    data=columns[0].map((_,row)=>columns.map(values=>values[row]));
  }
  if (!Array.isArray(data) || !data.length || !Array.isArray(data[0]) || !data[0].length ||
      data.some(row => !Array.isArray(row) || row.length !== data[0].length || row.some(value => value!==null&&!Number.isFinite(value))) ||
      (rowDescriptions != null && (rowDescriptions.length !== data.length || rowDescriptions.some(text => typeof text !== "string"))) ||
      (columnDescriptions != null && (columnDescriptions.length !== data[0].length || columnDescriptions.some(text => typeof text !== "string"))))
    throw Error("Chart matrix and label dimensions differ.");
  let source = input, prepared;
  const changedCells = [], ownedNumericCells = new Set();
  for (let seriesIndex=0;seriesIndex<data[0].length;seriesIndex++) {
    prepared = prepareChartSeriesWorkbookMutation(source, {slideIndex,shapeName,seriesPosition:seriesIndex,values:data.map(row=>row[seriesIndex]),allowNoop:true});
    changedCells.push(...prepared.changedCells);
    for (const address of prepared.ownedCells) {
      if (ownedNumericCells.has(address)) throw Error("Chart series overlap in their owned numeric cells.");
      ownedNumericCells.add(address);
    }
    const entries = unzipSync(source); entries[prepared.workbookPart] = prepared.bytes;
    source = zipSync(entries, {level:6,mtime:deterministicZipModifiedAt});
  }
  const sourceEntries=unzipSync(source), chart=parseXml(sourceEntries,prepared.chartPart);
  const series=[...chart.getElementsByTagNameNS(chartNamespace,"ser")];
  if (series.length!==data[0].length) throw Error("Chart matrix does not cover every authored series.");
  const workbook=unzipSync(prepared.bytes), worksheet=parseXml(workbook,prepared.worksheetPart);
  const namespace=worksheet.documentElement.namespaceURI;
  const cells=[...worksheet.getElementsByTagNameNS(namespace,"c")];
  const labelWrites=new Map();
  const writeLabels=(reference,values) => {
    if (!values) return;
    if (!reference) throw Error("Requested chart labels have no owned worksheet reference.");
    const formula=directXmlChild(reference,chartNamespace,"f").textContent;
    const range=/^(?:'((?:[^']|'')+)'|([^!'\[\]]+))!\$?([A-Z]+)\$?([1-9]\d*)(?::\$?([A-Z]+)\$?([1-9]\d*))?$/u.exec(formula);
    if (!range || (range[1]?.replaceAll("''", "'")??range[2])!==prepared.sheetName)
      throw Error("Chart labels require one owned worksheet range.");
    const col=text=>[...text].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);
    const c1=col(range[3]),r1=Number(range[4]),c2=col(range[5]??range[3]),r2=Number(range[6]??range[4]);
    if ((c1!==c2&&r1!==r2) || c2<c1 || r2<r1 || (c2-c1+1)*(r2-r1+1)!==values.length)
      throw Error("Chart label range and values differ.");
    const columnName=n=>{let text="";for(;n;n=Math.floor((n-1)/26))text=String.fromCharCode(65+(n-1)%26)+text;return text;};
    values.forEach((text,index)=>{
      const address=columnName(c1+(r1===r2?index:0))+(r1+(c1===c2?index:0));
      if(labelWrites.has(address)&&labelWrites.get(address)!==text)throw Error("Chart labels overlap with different requested values.");
      labelWrites.set(address,text);
    });
  };
  for (const [index,item] of series.entries()) {
    const category=optionalDirectXmlChild(item,chartNamespace,"cat");
    if(rowDescriptions)writeLabels(category&&optionalDirectXmlChild(category,chartNamespace,"strRef"),rowDescriptions);
    const name=optionalDirectXmlChild(item,chartNamespace,"tx");
    if(columnDescriptions)writeLabels(name&&optionalDirectXmlChild(name,chartNamespace,"strRef"),[columnDescriptions[index]]);
  }
  for (const [address,text] of labelWrites) {
    if (ownedNumericCells.has(address)) throw Error("Chart labels overlap with an owned numeric value.");
    const matches=cells.filter(cell=>cell.getAttribute("r")===address);
    if(matches.length!==1 || optionalDirectXmlChild(matches[0],namespace,"f"))throw Error("Chart label target must be one owned constant cell.");
    const cell=matches[0];cell.setAttribute("t","inlineStr");
    for(const child of [...cell.childNodes])if(child.nodeType===1&&["v","is"].includes(child.localName))cell.removeChild(child);
    const inline=worksheet.createElementNS(namespace,"is"),value=worksheet.createElementNS(namespace,"t");
    if(/^\s|\s$/u.test(text))value.setAttribute("xml:space","preserve");
    value.textContent=text;inline.appendChild(value);cell.appendChild(inline);
  }
  workbook[prepared.worksheetPart]=serializeXml(worksheet);
  return {...prepared,bytes:zipSync(workbook,{level:6,mtime:deterministicZipModifiedAt}),
    originalWorkbookBytes:unzipSync(input)[prepared.workbookPart],changedCells,
    labelWrites:[...labelWrites].map(([address,text])=>({address,text}))};
}

// A SmartArt drawing part is PowerPoint's cached rendering of the diagram
// data, which PowerPoint shows instead of laying the diagram out again. When an
// edit replaced a slide's diagram data and the engine's own export carries no
// drawing, the author's cached drawing would keep showing the old content, so
// it is removed with its relationship and the data part's pointer to it.
function dropStaleDiagramDrawings(merged, edited, changedParts) {
  const patched = [];
  for (const relationshipsPart of Object.keys(merged)) {
    if (!/^ppt\/slides\/_rels\/slide[^/]+\.xml\.rels$/u.test(relationshipsPart))
      continue;
    const sourcePart = relationshipsPart.replace(
      /\/_rels\/([^/]+)\.rels$/u,
      "/$1",
    );
    const document = parseXml(merged, relationshipsPart);
    const relationships = relationshipElements(document);
    const target = (relationship) =>
      resolvePart(sourcePart, relationship.getAttribute("Target"));
    const changedData = relationships
      .filter(
        (relationship) =>
          relationship.getAttribute("Type")?.endsWith("/diagramData") &&
          changedParts.includes(target(relationship)),
      )
      .map(target);
    if (!changedData.length) continue;
    const removedIds = [];
    for (const relationship of relationships) {
      if (!relationship.getAttribute("Type")?.endsWith("/diagramDrawing"))
        continue;
      const drawing = target(relationship);
      if (edited[drawing]) continue;
      relationship.parentNode.removeChild(relationship);
      delete merged[drawing];
      removedIds.push(relationship.getAttribute("Id"));
    }
    if (!removedIds.length) continue;
    merged[relationshipsPart] = serializeXml(document);
    patched.push(relationshipsPart);
    for (const dataPart of changedData) {
      const bytes = merged[dataPart]
        ? withoutDiagramDrawingReferences(merged, dataPart, removedIds)
        : null;
      if (!bytes) continue;
      merged[dataPart] = bytes;
      patched.push(dataPart);
    }
  }
  return patched;
}

// dsp:dataModelExt names the slide relationship of the cached drawing. Once
// that relationship is gone the pointer would dangle, or name an unrelated
// relationship that later reuses the id.
function withoutDiagramDrawingReferences(entries, part, relationshipIds) {
  const document = parseXml(entries, part);
  let changed = false;
  for (const reference of [
    ...document.getElementsByTagNameNS(diagramDrawingNamespace, "dataModelExt"),
  ]) {
    if (!relationshipIds.includes(reference.getAttribute("relId"))) continue;
    let node = reference;
    // Remove the emptied a:ext and dgm:extLst wrappers with the pointer.
    while (
      node.parentNode?.nodeType === 1 &&
      node.parentNode !== document.documentElement &&
      [...node.parentNode.childNodes].filter((child) => child.nodeType === 1)
        .length === 1
    )
      node = node.parentNode;
    node.parentNode.removeChild(node);
    changed = true;
  }
  return changed ? serializeXml(document) : null;
}

// Every r:* reference in a changed part, or in a part whose .rels changed,
// must still name a relationship. PowerPoint repairs or refuses a package
// with a dangling reference. An empty r:id is PowerPoint's own spelling for
// an action with no target, such as "next slide".
function assertChangedReferencesResolve(merged, changedParts) {
  const parts = new Set(
    changedParts
      .map((part) =>
        part.endsWith(".rels")
          ? part.replace(/_rels\/([^/]*)\.rels$/u, "$1")
          : part,
      )
      .filter((part) => part.endsWith(".xml") && merged[part]),
  );
  for (const part of parts) {
    const relationshipPath = relationshipsPath(part);
    const identifiers = new Set(
      merged[relationshipPath]
        ? relationshipElements(parseXml(merged, relationshipPath)).map(
            (relationship) => relationship.getAttribute("Id"),
          )
        : [],
    );
    for (const element of parseXml(merged, part).getElementsByTagName("*"))
      for (let index = 0; index < element.attributes.length; index += 1) {
        const attribute = element.attributes.item(index);
        if (
          attribute.namespaceURI === relationshipAttributeNamespace &&
          attribute.value &&
          !identifiers.has(attribute.value)
        )
          throw new Error(
            `Preserved native snapshot has a dangling relationship reference in ${part}: ${attribute.value}.`,
          );
      }
  }
}

// The engine names slide and notes slide parts after their order in the deck;
// the author's names follow any order once slides were added, duplicated or
// moved. Give the engine's parts the author's names for the same positions,
// so that every comparison meets one slide under one name.
function alignEngineSlideParts(original, engine, targetPaths = null) {
  const authored = targetPaths ?? orderedSlidePaths(original);
  const saved = orderedSlidePaths(engine);
  if (
    !authored.length ||
    authored.length !== saved.length ||
    authored.some(
      (part) => !part || (targetPaths === null && !original[part]),
    ) ||
    saved.some((part) => !part || !engine[part])
  )
    return engine;
  const notesOf = (entries, slide) =>
    entries[relationshipsPath(slide)]
      ? (relationshipsOfType(entries, slide, "notesSlide")[0]?.target ?? null)
      : null;
  const renames = new Map();
  for (const [index, part] of saved.entries())
    if (part !== authored[index]) renames.set(part, authored[index]);
  const authoredNotes = new Set(
    authored.map((slide) => notesOf(original, slide)).filter(Boolean),
  );
  const taken = new Set([...Object.keys(original), ...Object.keys(engine)]);
  for (const [index, slide] of saved.entries()) {
    const engineNotes = notesOf(engine, slide);
    if (!engineNotes) continue;
    const authorNotes = notesOf(original, authored[index]);
    if (authorNotes) {
      if (authorNotes !== engineNotes) renames.set(engineNotes, authorNotes);
      continue;
    }
    // Notes the edit added keep the engine's name unless another slide's
    // notes have it in the author's package.
    if (!authoredNotes.has(engineNotes)) continue;
    let ordinal = 1;
    while (taken.has(`ppt/notesSlides/notesSlide${ordinal}.xml`)) ordinal += 1;
    const destination = `ppt/notesSlides/notesSlide${ordinal}.xml`;
    taken.add(destination);
    renames.set(engineNotes, destination);
  }
  return renameEnginePackageParts(engine, renames);
}

// Source-bound identity belongs to the chart's authored frame and externalData
// role, not to the filename chosen by an exporter. Only unique named frames
// which retain the same chart part can bind a renamed existing XLSX resource.
function chartWorkbookRenames(original, baseline) {
  const workbookNames = (entries) =>
    Object.keys(entries).filter((part) =>
      /^ppt\/embeddings\/[^/]+\.xlsx$/u.test(part),
    );
  if (!workbookNames(original).length || !workbookNames(baseline).length)
    return new Map();
  const bindings = (entries) => {
    const result = new Map();
    for (const slide of orderedSlidePaths(entries)) {
      const document = parseXml(entries, slide);
      for (const frame of document.getElementsByTagNameNS(
        presentationNamespace,
        "graphicFrame",
      )) {
        const names = [
          ...frame.getElementsByTagNameNS(presentationNamespace, "cNvPr"),
        ];
        const charts = [
          ...frame.getElementsByTagNameNS(chartNamespace, "chart"),
        ];
        if (
          names.length !== 1 ||
          charts.length !== 1 ||
          !names[0].getAttribute("name")
        )
          continue;
        const id = charts[0].getAttributeNS(
          relationshipAttributeNamespace,
          "id",
        );
        const relations = entries[relationshipsPath(slide)]
          ? relationshipElements(
              parseXml(entries, relationshipsPath(slide)),
            ).filter(
              (relationship) =>
                relationship.getAttribute("Id") === id &&
                relationship.getAttribute("Type") ===
                  `${relationshipAttributeNamespace}/chart` &&
                relationship.getAttribute("TargetMode") !== "External",
            )
          : [];
        if (relations.length !== 1) continue;
        const chart = resolvePart(slide, relations[0].getAttribute("Target"));
        if (!entries[chart] || !/^ppt\/charts\/[^/]+\.xml$/u.test(chart))
          continue;
        const data = [
          ...parseXml(entries, chart).getElementsByTagNameNS(
            chartNamespace,
            "externalData",
          ),
        ];
        if (data.length !== 1 || !entries[relationshipsPath(chart)]) continue;
        const resourceId = data[0].getAttributeNS(
          relationshipAttributeNamespace,
          "id",
        );
        const resources = relationshipElements(
          parseXml(entries, relationshipsPath(chart)),
        ).filter(
          (relationship) =>
            relationship.getAttribute("Id") === resourceId &&
            relationship.getAttribute("Type") ===
              `${relationshipAttributeNamespace}/package` &&
            relationship.getAttribute("TargetMode") !== "External",
        );
        if (resources.length !== 1) continue;
        const workbook = resolvePart(
          chart,
          resources[0].getAttribute("Target"),
        );
        if (
          !/^ppt\/embeddings\/[^/]+\.xlsx$/u.test(workbook) ||
          !entries[workbook]
        )
          continue;
        const key = `${slide}\0${names[0].getAttribute("name")}`;
        result.set(key, result.has(key) ? null : { chart, workbook });
      }
    }
    return result;
  };
  const authored = bindings(original),
    exported = bindings(baseline),
    renames = new Map(),
    destinations = new Map();
  for (const [key, binding] of exported) {
    const source = authored.get(key);
    if (
      !binding ||
      !source ||
      source.chart !== binding.chart ||
      source.workbook === binding.workbook
    )
      continue;
    // Names in two different package namespaces can coincide without sharing
    // ownership. The unique frame/chart/externalData binding is the proof.
    // A destination already present in the same native package is a collision.
    if (
      (renames.has(binding.workbook) &&
        renames.get(binding.workbook) !== source.workbook) ||
      (destinations.has(source.workbook) &&
        destinations.get(source.workbook) !== binding.workbook) ||
      baseline[source.workbook]
    )
      throw new Error(
        "Native snapshot has ambiguous chart workbook ownership.",
      );
    renames.set(binding.workbook, source.workbook);
    destinations.set(source.workbook, binding.workbook);
  }
  return renames;
}

function renameEnginePackageParts(engine, renames) {
  if (!renames.size) return engine;

  const renamedPart = (part) => {
    if (renames.has(part)) return renames.get(part);
    const owner = part.replace(/\/_rels\/([^/]+)\.rels$/u, "/$1");
    return owner !== part && renames.has(owner)
      ? relationshipsPath(renames.get(owner))
      : part;
  };
  const aligned = {};
  for (const [part, bytes] of Object.entries(engine)) {
    const target = renamedPart(part);
    if (Object.hasOwn(aligned, target))
      throw new Error(`Native snapshot cannot align ${part} with ${target}.`);
    aligned[target] = bytes;
  }
  for (const part of Object.keys(engine)) {
    if (!part.endsWith(".rels")) continue;
    const owner = part.replace(/\/_rels\/([^/]+)\.rels$/u, "/$1");
    const source = part === "_rels/.rels" ? "" : owner;
    const document = parseXml(engine, part);
    let changed = false;
    for (const relationship of relationshipElements(document)) {
      if (relationship.getAttribute("TargetMode") === "External") continue;
      const target = resolvePart(source, relationship.getAttribute("Target"));
      if (!renames.has(target) && !renames.has(source)) continue;
      relationship.setAttribute(
        "Target",
        relativePart(renamedPart(source), renamedPart(target)),
      );
      changed = true;
    }
    if (changed) aligned[renamedPart(part)] = serializeXml(document);
  }
  if (engine[contentTypesPath]) {
    const document = parseXml(engine, contentTypesPath);
    for (const override of [
      ...document.getElementsByTagNameNS(contentTypeNamespace, "Override"),
    ]) {
      const part = override.getAttribute("PartName")?.replace(/^\//u, "");
      if (part && renames.has(part))
        override.setAttribute("PartName", `/${renames.get(part)}`);
    }
    aligned[contentTypesPath] = serializeXml(document);
  }
  return aligned;
}

// When a person adds or removes one slide in Office, its export renumbers the
// later slide parts. Pair the unchanged engine slides with the no-edit export
// before doing the three-way merge. Ambiguous or concurrent slide edits stay
// on the conservative path and are refused by the saved-model check.
function topologySlideBytes(entries, part, ignoreShapeNames = false) {
  const document = parseXml(entries, part);
  document
    .getElementsByTagNameNS(presentationNamespace, "cSld")[0]
    ?.removeAttribute("name");
  if (ignoreShapeNames)
    for (const shape of document.getElementsByTagNameNS(
      presentationNamespace,
      "cNvPr",
    ))
      shape.removeAttribute("name");
  for (const paragraph of document.getElementsByTagNameNS(
    drawingNamespace,
    "p",
  )) {
    if (
      xmlElementChildren(paragraph).some((child) =>
        ["r", "fld", "br"].includes(child.localName),
      )
    )
      continue;
    for (const properties of [
      ...paragraph.getElementsByTagNameNS(drawingNamespace, "pPr"),
    ])
      properties.parentNode.removeChild(properties);
  }
  return serializeXml(document);
}

// Connected lines recalculate their bounding box when the engine exports a
// retained slide again. Endpoint rounding is at most one 1/100 mm per end.
// This is only a topology correspondence check: retained source parts are
// copied unchanged, and the product must separately prove their live model
// did not change. Other geometry, connection targets and styles stay exact.
function topologyConnectorRoundingMatches(part, beforeBytes, afterBytes) {
  const before = parseXml({ [part]: beforeBytes }, part);
  const after = parseXml({ [part]: afterBytes }, part);
  const left = [...before.getElementsByTagNameNS(presentationNamespace, "cxnSp")];
  const right = [...after.getElementsByTagNameNS(presentationNamespace, "cxnSp")];
  if (left.length !== right.length || !left.length) return false;
  let adjusted = false;
  for (let index = 0; index < left.length; index++) {
    if (!["stCxn", "endCxn"].some(tag => left[index].getElementsByTagNameNS(drawingNamespace, tag).length)) continue;
    for (const [tag, axes, tolerance] of [["off", ["x", "y"], 360], ["ext", ["cx", "cy"], 720]]) {
      const a = left[index].getElementsByTagNameNS(drawingNamespace, tag)[0];
      const b = right[index].getElementsByTagNameNS(drawingNamespace, tag)[0];
      if (!a || !b) return false;
      for (const axis of axes) {
        if (!a.hasAttribute(axis) || !b.hasAttribute(axis)) return false;
        const first = Number(a.getAttribute(axis));
        const second = Number(b.getAttribute(axis));
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || Math.abs(first - second) > tolerance) return false;
        if (first !== second) { b.setAttribute(axis, a.getAttribute(axis)); adjusted = true; }
      }
    }
  }
  return adjusted && sameEngineExportPart(part, beforeBytes, serializeXml(after));
}

function directSlideTopologyPaths(original, noEdit, edited, sourceTargets) {
  const baseline = orderedSlidePaths(noEdit);
  const saved = orderedSlidePaths(edited);
  const authored = orderedSlidePaths(original);
  if (
    baseline.length !== authored.length ||
    Math.abs(saved.length - baseline.length) !== 1
  )
    return null;
  // cSld names can be regenerated from the slide's position, including a
  // collision with another retained slide's old name. Never use them to veto
  // a content match. A recorded insertion position may disambiguate identical
  // adjacent slides, but it cannot bypass retained-content equality.
  const intent = sourceTargets?.find(
    (target) => target.op === "native_slide_topology",
  );
  const baselineBytes = baseline.map((part) =>
    topologySlideBytes(noEdit, part),
  );
  const savedBytes = saved.map((part) => topologySlideBytes(edited, part));
  const comparisons = new Map();
  const matches = (baseIndex, savedIndex) => {
    const key = `${baseIndex}/${savedIndex}`;
    if (!comparisons.has(key))
      comparisons.set(
        key,
        sameEngineExportPart(
          baseline[baseIndex],
          baselineBytes[baseIndex],
          savedBytes[savedIndex],
        ) || topologyConnectorRoundingMatches(baseline[baseIndex], baselineBytes[baseIndex], savedBytes[savedIndex]),
      );
    return comparisons.get(key);
  };
  const candidates = [];
  if (saved.length === baseline.length + 1) {
    for (let insert = 0; insert < saved.length; insert += 1) {
      if (
        baseline.every((_, index) =>
          matches(index, index < insert ? index : index + 1),
        )
      )
        candidates.push(insert);
    }
    const selected = candidates.length === 1 ? candidates[0]
      : candidates.includes(intent?.slideIndex) ? intent.slideIndex : null;
    if (selected === null) return null;
    const newPart =
      saved.find((part) => !original[part]) ??
      (() => {
        let ordinal = 1;
        while (
          original[`ppt/slides/slide${ordinal}.xml`] ||
          edited[`ppt/slides/slide${ordinal}.xml`]
        )
          ordinal += 1;
        return `ppt/slides/slide${ordinal}.xml`;
      })();
    const targetPaths = authored.slice();
    targetPaths.splice(selected, 0, newPart);
    return { kind: "insert", index: selected, paths: targetPaths };
  }
  for (let removed = 0; removed < baseline.length; removed += 1) {
    if (
      saved.every((_, index) =>
        matches(index < removed ? index : index + 1, index),
      )
    )
      candidates.push(removed);
  }
  const selected = candidates.length === 1 ? candidates[0]
    : candidates.includes(intent?.slideIndex) ? intent.slideIndex : null;
  if (selected === null) return null;
  return {
    kind: "delete",
    index: selected,
    paths: authored.filter((_, index) => index !== selected),
  };
}

// Impress can omit a newly created placeholder's explicit empty-paragraph
// alignment and a duplicated title's auto-grow state from its native export.
// Write the exact live properties into ONLY the new slide, then verify those
// properties through the ordinary native persisted-intent comparator.
function preserveInsertedShapeProperties(entries, part, intent) {
  if (!intent?.elements) return;
  const document = parseXml(entries, part);
  const shapes = topLevelSlideShapes(document);
  const observed = intent.elements.filter(
    (element) => !element.parentElementId,
  );
  if (shapes.length !== observed.length)
    throw new Error("Native insertion cannot identify every new shape.");
  const direct = (element, field) =>
    [0, "0", "DIRECT_VALUE"].includes(element.propertyStates?.[field]);
  for (const [index, shape] of shapes.entries()) {
    const element = observed[index];
    const properties = shape.getElementsByTagNameNS(
      presentationNamespace,
      "cNvPr",
    )[0];
    if (
      typeof element.objectName === "string" &&
      element.objectName &&
      properties
    )
      properties.setAttribute("name", element.objectName);
    const body = optionalDirectXmlChild(shape, presentationNamespace, "txBody");
    if (!body) continue;
    if (readShapeText(shape) !== element.text)
      throw new Error(
        "Native insertion text does not match the observed shape.",
      );
    const bodyProperties = directXmlChild(body, drawingNamespace, "bodyPr");
    for (const [side, attribute] of [
      ["left", "lIns"],
      ["right", "rIns"],
      ["top", "tIns"],
      ["bottom", "bIns"],
    ]) {
      const value = element.textMargins?.[side];
      if (
        bodyProperties &&
        direct(element, `textMargins.${side}`) &&
        Number.isFinite(value)
      )
        bodyProperties.setAttribute(attribute, String(Math.round(value * 360)));
    }
    const autoFitMode = direct(element, "textAutoGrowHeight") && element.textAutoGrowHeight === true
      ? "spAutoFit"
      : direct(element, "textFitToSize")
        ? { NONE: "noAutofit", AUTOFIT: "normAutofit" }[element.textFitToSize]
        : direct(element, "textAutoGrowHeight") && element.textAutoGrowHeight === false
          ? "noAutofit" : null;
    if (bodyProperties && autoFitMode) {
      const modes = xmlElementChildren(bodyProperties)
        .filter(child => ["noAutofit", "normAutofit", "spAutoFit"].includes(child.localName));
      // Keep authored scaling attributes when the existing mode already
      // matches. Grow-height=false does not mean automatic text fitting=false.
      if (modes.length !== 1 || modes[0].localName !== autoFitMode) {
        for (const child of modes) bodyProperties.removeChild(child);
        const successor = xmlElementChildren(bodyProperties)
          .find(child => ["scene3d", "sp3d", "flatTx", "extLst"].includes(child.localName));
        bodyProperties.insertBefore(document.createElementNS(drawingNamespace, `a:${autoFitMode}`), successor ?? null);
      }
    }
    if (
      element.text !== "" ||
      !shape.getElementsByTagNameNS(presentationNamespace, "ph").length
    )
      continue;
    const paragraphs = [...body.getElementsByTagNameNS(drawingNamespace, "p")];
    if (paragraphs.length !== 1) continue;
    const paragraph = paragraphs[0];
    const paragraphProperties = ensureParagraphProperties(paragraph);
    // UNO ParagraphAdjust is LEFT, RIGHT, BLOCK, CENTER, STRETCH.
    const alignment = ["l", "r", "just", "ctr", "dist"][
      element.paragraphAlignment
    ];
    if (direct(element, "paragraphAlignment") && alignment)
      paragraphProperties.setAttribute("algn", alignment);
    const format = element.paragraphFormats?.[0];
    for (const [field, name] of [
      ["topMargin", "spcBef"],
      ["bottomMargin", "spcAft"],
    ]) {
      if (!Number.isFinite(format?.[field])) continue;
      for (const previous of [
        ...paragraphProperties.getElementsByTagNameNS(drawingNamespace, name),
      ])
        previous.parentNode.removeChild(previous);
      const spacing = document.createElementNS(drawingNamespace, `a:${name}`);
      const points = document.createElementNS(drawingNamespace, "a:spcPts");
      points.setAttribute(
        "val",
        String(Math.round((format[field] * 7200) / 2540)),
      );
      spacing.appendChild(points);
      const successor = xmlElementChildren(paragraphProperties).find(
        (child) =>
          !["lnSpc", ...(name === "spcAft" ? ["spcBef"] : [])].includes(
            child.localName,
          ),
      );
      paragraphProperties.insertBefore(spacing, successor ?? null);
    }
    // Empty presentation objects use list-style defaults on import; there is
    // no text run onto which the importer can apply paragraph properties.
    let listStyle = optionalDirectXmlChild(body, drawingNamespace, "lstStyle");
    if (!listStyle) {
      listStyle = document.createElementNS(drawingNamespace, "a:lstStyle");
      body.insertBefore(listStyle, paragraph);
    }
    for (const name of ["defPPr", "lvl1pPr"]) {
      const existing = optionalDirectXmlChild(
        listStyle,
        drawingNamespace,
        name,
      );
      if (existing) listStyle.removeChild(existing);
      const defaults = document.createElementNS(drawingNamespace, `a:${name}`);
      for (const attribute of [...paragraphProperties.attributes])
        defaults.setAttribute(attribute.name, attribute.value);
      for (const child of [...paragraphProperties.childNodes])
        defaults.appendChild(child.cloneNode(true));
      const following = xmlElementChildren(listStyle).find(
        (child) => name === "defPPr" || /^lvl[2-9]pPr$/u.test(child.localName),
      );
      listStyle.insertBefore(defaults, following ?? null);
    }
  }
  entries[part] = serializeXml(document);
}

// Keep every surviving author's part, and transplant the inserted native
// slide itself (including its placeholders). Import only its dependencies;
// reconnect layouts to their authored owners instead of admitting the
// engine's one-master-per-layout presentation.
function mergeDirectSlideTopology(
  originalBytes,
  original,
  noEdit,
  edited,
  topology,
  sourceTargets,
  designProof,
) {
  const context = openPackage(originalBytes, { requireSimpleTopology: false });
  if (topology.kind === "delete") {
    deleteSlide(context, { op: "delete_slide", slideIndex: topology.index });
    return context.entries;
  }
  if (context.slideIds.length >= 200)
    throw new Error("The browser document slide limit is 200.");
  const newSlide = topology.paths[topology.index];
  const intent = sourceTargets?.find(
    (target) =>
      target.op === "native_slide_topology" &&
      target.slideIndex === topology.index,
  );
  // A duplicate can be matched to one whole native baseline slide after only
  // generated identities and empty-paragraph save noise are removed. Clone its
  // authored package instead of introducing export-created text bodies on
  // non-text decoration (thin rectangles otherwise acquire clamped margins).
  const baselinePaths = orderedSlidePaths(noEdit);
  const mayBeClone = Number.isInteger(intent?.cloneSourceSlideIndex) || intent?.elements?.some(
    (element) =>
      !(
        element.presentationObject === true &&
        element.emptyPresentationObject === true
      ),
  );
  const newFingerprint = mayBeClone
    ? topologySlideBytes(edited, newSlide, true)
    : null;
  const cloneSources = mayBeClone
    ? baselinePaths.filter((part) =>
        sameEngineExportPart(
          part,
          topologySlideBytes(noEdit, part, true),
          newFingerprint,
        ),
      )
    : [];
  let cloneSource = cloneSources.length === 1 ? cloneSources[0] : null;
  if (intent && Object.hasOwn(intent, "cloneSourceSlideIndex")) {
    const index = intent.cloneSourceSlideIndex;
    if (!Number.isInteger(index) || index < 0 || index >= baselinePaths.length ||
        !cloneSources.includes(baselinePaths[index]))
      throw new Error("Native duplicate source does not match the captured baseline.");
    cloneSource = baselinePaths[index];
  }
  if (cloneSource) {
    const changed = new Set();
    clonePart(
      context,
      orderedSlidePaths(original)[baselinePaths.indexOf(cloneSource)],
      newSlide,
      new Map([[cloneSource, newSlide]]),
      changed,
    );
    preserveInsertedShapeProperties(context.entries, newSlide, intent);
    registerSlide(
      context,
      newSlide,
      topology.index,
      changed,
      readSections(context),
    );
    return context.entries;
  }
  const copied = new Map([[newSlide, newSlide]]);
  const importedTypes = contentTypeDeclarations(
    parseXml(edited, contentTypesPath),
  );
  const imported = new Set();
  const retainedNativeSlides = topology.paths.filter((_, index) => index !== topology.index);
  const authoredMasterForLayout = (layout) => {
    const nativeMasters = relationshipsOfType(edited, layout, "slideMaster");
    if (nativeMasters.length !== 1) throw new Error("Native layout has no unique master.");
    const owners = new Set();
    orderedSlidePaths(original).forEach((slide, index) => {
      const nativeLayouts = relationshipsOfType(edited, retainedNativeSlides[index], "slideLayout");
      const nativeOwners = nativeLayouts.flatMap(({ target }) => relationshipsOfType(edited, target, "slideMaster"));
      if (!nativeOwners.some(({ target }) => target === nativeMasters[0].target)) return;
      const layouts = relationshipsOfType(original, slide, "slideLayout");
      for (const { target } of layouts)
        for (const owner of relationshipsOfType(original, target, "slideMaster")) owners.add(owner.target);
    });
    if (owners.size !== 1) throw new Error("Native layout cannot identify one authored master from retained slides.");
    return [...owners][0];
  };
  const cloneMasterForLayout = (source, layout) => {
    const destination = nextPartPath(context.entries, source);
    const master = parseXml(original, source);
    const relationships = parseXml(original, relationshipsPath(source));
    for (const relationship of relationshipElements(relationships))
      if (relationship.getAttribute("Type").endsWith("/slideLayout")) relationship.parentNode.removeChild(relationship);
    const layoutRelationship = relationships.createElementNS(packageRelationshipNamespace, "Relationship");
    const layoutId = nextRelationshipId(relationships);
    layoutRelationship.setAttribute("Id", layoutId);
    layoutRelationship.setAttribute("Type", `${relationshipAttributeNamespace}/slideLayout`);
    layoutRelationship.setAttribute("Target", relativePart(destination, layout));
    relationships.documentElement.appendChild(layoutRelationship);
    const layoutIds = requiredElement(master, presentationNamespace, "sldLayoutIdLst");
    while (layoutIds.firstChild) layoutIds.removeChild(layoutIds.firstChild);
    const layoutEntry = master.createElementNS(presentationNamespace, "p:sldLayoutId");
    const maximumLayoutId = Math.max(...Object.keys(original)
      .filter(part => /^ppt\/slideMasters\/slideMaster[^/]+\.xml$/u.test(part))
      .flatMap(part => Array.from(parseXml(original, part).getElementsByTagNameNS(presentationNamespace, "sldLayoutId")))
      .map(node => Number(node.getAttribute("id"))));
    if (!Number.isSafeInteger(maximumLayoutId) || maximumLayoutId < 2147483648 || maximumLayoutId >= 0xffffffff)
      throw new Error("PPTX layout identifiers are invalid.");
    layoutEntry.setAttribute("id", String(maximumLayoutId + 1));
    layoutEntry.setAttributeNS(relationshipAttributeNamespace, "r:id", layoutId);
    layoutIds.appendChild(layoutEntry);
    context.entries[destination] = serializeXml(master);
    context.entries[relationshipsPath(destination)] = serializeXml(relationships);
    copyContentType(context, source, destination);
    imported.add(destination);
    imported.add(relationshipsPath(destination));
    const registry = requiredElement(context.presentation, presentationNamespace, "sldMasterIdLst");
    const maximum = Math.max(...xmlElementChildren(registry).map(node => Number(node.getAttribute("id"))));
    if (!Number.isSafeInteger(maximum) || maximum < 2147483648 || maximum >= 0xffffffff)
      throw new Error("PPTX master identifiers are invalid.");
    const id = nextRelationshipId(context.relationships);
    const masterRelationship = context.relationships.createElementNS(packageRelationshipNamespace, "Relationship");
    masterRelationship.setAttribute("Id", id);
    masterRelationship.setAttribute("Type", `${relationshipAttributeNamespace}/slideMaster`);
    masterRelationship.setAttribute("Target", relativePart(presentationPath, destination));
    context.relationships.documentElement.appendChild(masterRelationship);
    const entry = context.presentation.createElementNS(presentationNamespace, "p:sldMasterId");
    entry.setAttribute("id", String(maximum + 1));
    entry.setAttributeNS(relationshipAttributeNamespace, "r:id", id);
    registry.appendChild(entry);
    Object.assign(designProof, { sourceMaster: source, importedMaster: destination, importedLayout: layout });
    return destination;
  };
  const importPart = (source, destination) => {
    if (copied.size > 500)
      throw new Error("Slide dependency graph exceeds the safe copy limit.");
    if (!edited[source] || original[destination])
      throw new Error(`Native topology cannot import ${source}.`);
    context.entries[destination] = edited[source];
    imported.add(destination);
    copyContentType(
      context,
      source,
      destination,
      declaredContentType(importedTypes, source),
    );
    const related = relationshipsPath(source);
    if (!edited[related]) return;
    const relationships = parseXml(edited, related);
    for (const relationship of relationshipElements(relationships)) {
      if (relationship.getAttribute("TargetMode") === "External") continue;
      const target = resolvePart(source, relationship.getAttribute("Target"));
      const kind = relationship.getAttribute("Type").split("/").at(-1);
      let mapped = copied.get(target);
      if (!mapped && kind === "slideLayout") {
        if (Number.isSafeInteger(intent?.sourceLayoutSlideIndex)) {
          const index=intent.sourceLayoutSlideIndex;
          const nativeLayouts=relationshipsOfType(edited,retainedNativeSlides[index],"slideLayout");
          const authoredLayouts=relationshipsOfType(original,orderedSlidePaths(original)[index],"slideLayout");
          if(nativeLayouts.length!==1||authoredLayouts.length!==1||nativeLayouts[0].target!==target)
            throw new Error("Native insertion changed its declared source layout.");
          mapped=authoredLayouts[0].target;
        }
        // Export can renumber layouts and create a new layout with an old
        // name but a different type. Use the edited identity, never the old
        // path or a name-only fallback. A genuinely new layout gets its own
        // copy of the proven authored master, leaving existing designs intact.
        if (!mapped) {
        const identity = slideLayoutIdentity(edited, target);
        const owner = authoredMasterForLayout(target);
        const candidates = Object.keys(original).filter(part => /^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(part))
          .filter(part => {
            const candidate = slideLayoutIdentity(original, part);
            return candidate.name === identity.name && candidate.type === identity.type &&
              relationshipsOfType(original, part, "slideMaster").some(master => master.target === owner);
          });
        if (candidates.length === 1) mapped = candidates[0];
        }
      } else if (!mapped && kind === "slideMaster" && /^ppt\/slideLayouts\//u.test(source)) {
        mapped = cloneMasterForLayout(authoredMasterForLayout(source), destination);
      } else if (!mapped && kind === "notesMaster") {
        const masters = relationshipsOfType(
          original,
          presentationPath,
          "notesMaster",
        );
        if (masters.length === 1) mapped = masters[0].target;
        else if (masters.length > 1)
          throw new Error(
            "Native topology cannot identify the authored notes master.",
          );
      } else if (!mapped && kind === "slide" && original[target])
        mapped = target;
      else if (
        !mapped &&
        !["notesSlide", "comments"].includes(kind) &&
        original[target] &&
        samePartBytes(original[target], edited[target])
      )
        mapped = target;
      if (!mapped) {
        mapped = nextPartPath(context.entries, target);
        copied.set(target, mapped);
        importPart(target, mapped);
      }
      if (kind === "notesMaster" && !relationshipsOfType(original, presentationPath, "notesMaster").length) {
        const registered = relationshipElements(context.relationships).some(entry =>
          entry.getAttribute("Type").endsWith("/notesMaster") &&
          resolvePart(presentationPath, entry.getAttribute("Target")) === mapped);
        if (!registered) {
          const id = nextRelationshipId(context.relationships);
          const entry = context.relationships.createElementNS(packageRelationshipNamespace, "Relationship");
          entry.setAttribute("Id", id);
          entry.setAttribute("Type", relationship.getAttribute("Type"));
          entry.setAttribute("Target", relativePart(presentationPath, mapped));
          context.relationships.documentElement.appendChild(entry);
          registerNotesMaster(context.presentation, id);
        }
      }
      relationship.setAttribute("Target", relativePart(destination, mapped));
    }
    context.entries[relationshipsPath(destination)] =
      serializeXml(relationships);
    imported.add(relationshipsPath(destination));
  };
  importPart(newSlide, newSlide);
  preserveInsertedShapeProperties(context.entries, newSlide, intent);
  registerSlide(
    context,
    newSlide,
    topology.index,
    imported,
    readSections(context),
  );
  return context.entries;
}

// Requested human scenarios have a narrower change boundary than arbitrary
// human edits. Use the authored relationship graph and the canonical registry.
export function assessHumanComparisonPreservation(originalBytes, savedBytes, scenario) {
  for (const bytes of [originalBytes, savedBytes]) inspectZipPackage(bytes);
  const original = unzipSync(originalBytes), saved = unzipSync(savedBytes);
  const paths = orderedSlidePaths(original), first = paths[0];
  if (!first) throw new Error("Comparison input has no authored slide identity.");
  const operations = {
    roundtrip: [], type: ["replace_text"], "type-move": ["replace_text", "move"],
    move: ["move"], delete: ["delete_element"], newslide: ["insert_slide"],
    dupslide: ["duplicate_slide"], delslide: ["delete_slide"],
  }[scenario];
  if (!operations) throw new Error("Unknown preservation comparison scenario.");
  const topology = ["newslide", "dupslide", "delslide"].includes(scenario);
  const budget = operations.length ? nativePreservationBudget(operations) : { allowedCategories: new Set() };
  const allowedExisting = new Set(topology
    ? [contentTypesPath, presentationPath, presentationRelationshipsPath]
    : scenario === "roundtrip" ? [] : [first, relationshipsPath(first)]);
  if (scenario === "delslide") {
    allowedExisting.add(first); allowedExisting.add(relationshipsPath(first));
    for (const { target } of relationshipsOfType(original, first, "notesSlide")) {
      allowedExisting.add(target); allowedExisting.add(relationshipsPath(target));
    }
  }
  const changedParts = [...new Set([...Object.keys(original), ...Object.keys(saved)])]
    .filter(part => !samePartBytes(original[part], saved[part])).sort();
  const violations = changedParts.filter(part => {
    if (original[part]) return !allowedExisting.has(part);
    return !topology || !budget.allowedCategories.has(classifyNativePackagePart(part));
  });
  const expectedCount = paths.length + (scenario === "delslide" ? -1 : topology ? 1 : 0);
  if (orderedSlidePaths(saved).length !== expectedCount) violations.push("presentation_slide_count");
  return { valid: violations.length === 0, changedParts, violations,
    scope: "Authored package payload preservation for the requested human scenario; not the full product or visible-fidelity contract" };
}

function orderedSlidePaths(entries) {
  if (!entries[presentationPath] || !entries[presentationRelationshipsPath])
    return [];
  const relationships = new Map(
    relationshipElements(parseXml(entries, presentationRelationshipsPath)).map(
      (relationship) => [relationship.getAttribute("Id"), relationship],
    ),
  );
  return [
    ...parseXml(entries, presentationPath).getElementsByTagNameNS(
      presentationNamespace,
      "sldId",
    ),
  ].map((slideId) => {
    const relationship = relationships.get(
      slideId.getAttributeNS(relationshipAttributeNamespace, "id"),
    );
    return relationship &&
      relationship.getAttribute("TargetMode") !== "External"
      ? resolvePart(presentationPath, relationship.getAttribute("Target"))
      : null;
  });
}

// The slide parts the commands target, each with the author's names of the
// shapes they may change there (null: any shape). Null unless every operation
// is confined to its slide and every target was identified; the merge then
// keeps every other slide, and every other shape, as authored.
function shapeTargetsBySlide(original, scopes) {
  const slidePaths = orderedSlidePaths(original);
  const targets = new Map();
  for (const [slideIndex, names] of scopes) {
    const part = slidePaths[slideIndex];
    if (!part) return null;
    targets.set(part, names);
  }
  return targets;
}

// The observation and the OOXML merge both enumerate top-level slide shapes
// in their slide order. A direct edit keeps that position even when the live
// placeholder name differs from the author's cNvPr name.
function directShapeTargetIndexesBySlide(original, operations, targets) {
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > 3 ||
    !operations.every((operation) =>
      directShapeIndexOperations.includes(operation),
    ) ||
    !Array.isArray(targets) ||
    targets.length !== operations.length ||
    !targets.every(
      (target, index) =>
        target?.op === operations[index] &&
        target.slideIndex === targets[0].slideIndex &&
        target.shapeIndex === targets[0].shapeIndex &&
        target.name === targets[0].name,
    ) ||
    !Number.isSafeInteger(targets[0].slideIndex) ||
    !Number.isSafeInteger(targets[0].shapeIndex) ||
    targets[0].shapeIndex < 0
  )
    return null;
  const part = orderedSlidePaths(original)[targets[0].slideIndex];
  return part ? new Map([[part, new Set([targets[0].shapeIndex])]]) : null;
}

function changedPackageParts(original, merged) {
  return [...new Set([...Object.keys(original), ...Object.keys(merged)])]
    .filter((part) => !samePartBytes(original[part], merged[part]))
    .sort();
}

function contentTypePartKey(partName) {
  const part = (partName ?? "").replace(/^\//u, "");
  try {
    return decodeURIComponent(part).toLowerCase();
  } catch {
    return part.toLowerCase();
  }
}

// OPC: the extension follows the last period of the last segment, so the
// package relationships part /_rels/.rels has the extension "rels".
function partExtension(part) {
  const name = part.slice(part.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// OPC resolves a part's content type from an Override for the part name
// (percent-encoded, ASCII case-insensitive) before a Default for its
// extension.
function contentTypeDeclarations(document) {
  const overrides = new Map();
  const defaults = new Map();
  for (const element of document.getElementsByTagNameNS(
    contentTypeNamespace,
    "Override",
  ))
    overrides.set(
      contentTypePartKey(element.getAttribute("PartName")),
      element,
    );
  for (const element of document.getElementsByTagNameNS(
    contentTypeNamespace,
    "Default",
  ))
    defaults.set(
      (element.getAttribute("Extension") ?? "").toLowerCase(),
      element,
    );
  return { overrides, defaults };
}

function declaredContentType({ overrides, defaults }, part) {
  return (
    (
      overrides.get(part.toLowerCase()) ?? defaults.get(partExtension(part))
    )?.getAttribute("ContentType") || null
  );
}

// Every package part needs a declared content type. The merge can keep an
// author's part that the engine dropped (printer settings, a transition
// sound) while taking the engine's [Content_Types].xml, or keep the author's
// manifest while adding an engine-created part. Bind the effective type to
// the package supplying each part: a generic XML Default cannot replace an
// author's specific Override. Drop overrides for parts the merge left out.
// Returns null when the manifest already declares the correct types.
function reconcileContentTypes(merged, original, edited) {
  if (!merged[contentTypesPath]) return null;
  const document = parseXml(merged, contentTypesPath);
  const declared = contentTypeDeclarations(document);
  const [authoredTypes, engineTypes] = [original, edited].map((entries) =>
    entries[contentTypesPath]
      ? contentTypeDeclarations(parseXml(entries, contentTypesPath))
      : null,
  );
  const present = new Set(
    Object.keys(merged).map((part) => part.toLowerCase()),
  );
  const known = new Set(
    [...Object.keys(original), ...Object.keys(edited)].map((part) =>
      part.toLowerCase(),
    ),
  );
  let changed = false;
  for (const [key, override] of [...declared.overrides])
    if (!present.has(key) && known.has(key)) {
      override.parentNode.removeChild(override);
      declared.overrides.delete(key);
      changed = true;
    }
  for (const part of Object.keys(merged).sort()) {
    if (part === contentTypesPath) continue;
    // A merge-created clone has neither source path. Its cloning operation
    // already declared its type: do not infer one from an unrelated source
    // manifest's broad XML Default.
    const authoredSource = original[part] ? authoredTypes : null;
    const engineSource = edited[part] ? engineTypes : null;
    const sources = samePartBytes(merged[part], original[part])
      ? [authoredSource, engineSource]
      : [engineSource, authoredSource];
    const source = sources.find(
      (candidate) => candidate && declaredContentType(candidate, part),
    );
    if (!source) continue;
    const contentType = declaredContentType(source, part);
    if (declaredContentType(declared, part) === contentType) continue;
    const previousOverride = declared.overrides.get(part.toLowerCase());
    if (previousOverride) {
      previousOverride.setAttribute("ContentType", contentType);
      changed = true;
      continue;
    }
    const sourceOverride = source.overrides.get(part.toLowerCase());
    const extension = partExtension(part);
    if (!sourceOverride && extension && !declared.defaults.has(extension)) {
      const element = document.createElementNS(contentTypeNamespace, "Default");
      element.setAttribute("Extension", extension);
      element.setAttribute("ContentType", contentType);
      const firstOverride = [...document.documentElement.childNodes].find(
        (child) => child.nodeType === 1 && child.localName === "Override",
      );
      document.documentElement.insertBefore(element, firstOverride ?? null);
      declared.defaults.set(extension, element);
    } else {
      const element = document.createElementNS(
        contentTypeNamespace,
        "Override",
      );
      element.setAttribute(
        "PartName",
        sourceOverride?.getAttribute("PartName") ??
          `/${part.split("/").map(encodeURIComponent).join("/")}`,
      );
      element.setAttribute("ContentType", contentType);
      document.documentElement.appendChild(element);
      declared.overrides.set(part.toLowerCase(), element);
    }
    changed = true;
  }
  return changed ? serializeXml(document) : null;
}

function referencedRelationshipsStillMatch(
  part,
  editedBytes,
  originalRels,
  noEditRels,
) {
  if (!editedBytes || !part.endsWith(".xml")) return false;
  const edited = parseXml({ [part]: editedBytes }, part);
  const referencedIds = new Set();
  for (const element of edited.getElementsByTagName("*")) {
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (
        attribute.namespaceURI === relationshipAttributeNamespace &&
        attribute.value
      )
        referencedIds.add(attribute.value);
    }
  }
  if (referencedIds.size === 0) return true;
  if (!originalRels || !noEditRels) return false;
  const relationshipPath = relationshipsPath(part);
  const original = parseXml(
    { [relationshipPath]: originalRels },
    relationshipPath,
  );
  const normalized = parseXml(
    { [relationshipPath]: noEditRels },
    relationshipPath,
  );
  const relationshipsById = (document) =>
    new Map(
      relationshipElements(document).map((relationship) => [
        relationship.getAttribute("Id"),
        relationship,
      ]),
    );
  const originals = relationshipsById(original);
  const normalizedRels = relationshipsById(normalized);
  for (const id of referencedIds) {
    const before = originals.get(id);
    const after = normalizedRels.get(id);
    if (
      !before ||
      !after ||
      before.getAttribute("Type") !== after.getAttribute("Type") ||
      before.getAttribute("TargetMode") !== after.getAttribute("TargetMode")
    )
      return false;
    const external = before.getAttribute("TargetMode") === "External";
    const beforeTarget = before.getAttribute("Target");
    const afterTarget = after.getAttribute("Target");
    if (
      (external ? beforeTarget : resolvePart(part, beforeTarget)) !==
      (external ? afterTarget : resolvePart(part, afterTarget))
    )
      return false;
  }
  return true;
}

function slideLayoutIdentity(entries, part) {
  if (
    !entries[part] ||
    !/^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(part)
  )
    throw new Error(`Native snapshot has no comparable slide layout: ${part}.`);
  const layout = parseXml(entries, part).documentElement;
  if (
    layout.namespaceURI !== presentationNamespace ||
    layout.localName !== "sldLayout"
  )
    throw new Error(`Native snapshot has an invalid slide layout: ${part}.`);
  const commonSlide = [...layout.childNodes].find(
    (child) =>
      child.nodeType === 1 &&
      child.namespaceURI === presentationNamespace &&
      child.localName === "cSld",
  );
  const name = commonSlide?.getAttribute("name")?.trim();
  if (!name)
    throw new Error(`Native snapshot cannot identify slide layout: ${part}.`);
  return { name, type: layout.getAttribute("type") || null };
}

function remapSlideLayoutTarget(sourcePart, target, original, noEdit) {
  const sourcePath = resolvePart(sourcePart, target);
  const identity = slideLayoutIdentity(noEdit, sourcePath);
  const candidates = Object.keys(original)
    .filter((part) => /^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(part))
    .map((part) => ({ part, identity: slideLayoutIdentity(original, part) }))
    .filter(({ identity: candidate }) => candidate.name === identity.name);
  const exactType = candidates.filter(
    ({ identity: candidate }) => candidate.type === identity.type,
  );
  const matching = exactType.length === 1 ? exactType : candidates;
  if (matching.length !== 1)
    throw new Error(
      `Native snapshot cannot uniquely remap slide layout ${sourcePath}: ${identity.name}.`,
    );
  return relativePart(sourcePart, matching[0].part);
}

function remapAuthoredRelationships(
  part,
  bytes,
  original,
  noEdit,
  sourceOperations,
  humanEdit = false,
  sourceTargets = null,
  edited = null,
) {
  const sourcePart = part.replace(/\/_rels\/([^/]+)\.rels$/u, "/$1");
  const document = parseXml({ [part]: bytes }, part);
  const normalized = noEdit[part] ? parseXml(noEdit, part) : null;
  const normalizedById = new Map(
    normalized
      ? relationshipElements(normalized).map((relationship) => [
          relationship.getAttribute("Id"),
          relationship,
        ])
      : [],
  );
  let changed = false;
  for (const relationship of relationshipElements(document)) {
    if (relationship.getAttribute("TargetMode") === "External") continue;
    const target = relationship.getAttribute("Target");
    if(relationship.getAttribute("Type")?.endsWith("/notesSlide") && !humanEdit &&
        !sourceOperations.includes("set_speaker_notes")){
      const path=resolvePart(sourcePart,target),prior=normalizedById.get(relationship.getAttribute("Id"));
      if(!original[path] && prior?.getAttribute("Type")===relationship.getAttribute("Type") &&
          prior.getAttribute("Target")===target && edited &&
          sameEngineExportPart(path,noEdit[path],edited[path]) &&
          sameEngineExportPart(relationshipsPath(path),noEdit[relationshipsPath(path)],edited[relationshipsPath(path)])){
        relationship.parentNode.removeChild(relationship);changed=true;continue;
      }
    }
    if (!relationship.getAttribute("Type")?.endsWith("/slideLayout")) continue;
    if (
      !/^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(
        resolvePart(sourcePart, target),
      )
    )
      continue;
    const normalizedRelationship = normalizedById.get(
      relationship.getAttribute("Id"),
    );
    const sameNativeTarget = normalizedRelationship?.getAttribute("Type") ===
      relationship.getAttribute("Type") && normalizedRelationship.getAttribute("Target") === target;
    const layoutWasNotEdited = sameNativeTarget ||
      (!humanEdit && !sourceOperations.includes("set_slide_layout"));
    const originalLayout =
      layoutWasNotEdited && original[part]
        ? relationshipsOfType(original, sourcePart, "slideLayout")
        : [];
    // A hyperlink or media edit can rewrite the slide's .rels without
    // changing its layout. Keep the author's exact original target instead
    // of guessing among same-named LibreOffice-normalized layouts.
    const sourceSlideIndex=orderedSlidePaths(original).indexOf(sourcePart);
    const declaration=sourceTargets?.find(target=>target.op==="set_slide_layout"&&target.slideIndex===sourceSlideIndex);
    const ownedLayout=declaration?authoredMasterLayout(original,declaration):null;
    const remapped =
      ownedLayout ? relativePart(sourcePart,ownedLayout.layout) :
      originalLayout.length === 1
        ? relativePart(sourcePart, originalLayout[0].target)
        : remapSlideLayoutTarget(sourcePart, target, original, noEdit);
    if (remapped !== target) {
      relationship.setAttribute("Target", remapped);
      changed = true;
    }
  }
  return changed ? serializeXml(document) : bytes;
}

function directXmlChild(parent, namespace, localName) {
  const child = optionalDirectXmlChild(parent, namespace, localName);
  if (!child)
    throw new Error(`Native snapshot needs exactly one ${localName} node.`);
  return child;
}

function optionalDirectXmlChild(parent, namespace, localName) {
  const matches = [...parent.childNodes].filter(
    (child) =>
      child.nodeType === 1 &&
      child.namespaceURI === namespace &&
      child.localName === localName,
  );
  if (matches.length > 1)
    throw new Error(`Native snapshot needs exactly one ${localName} node.`);
  return matches[0] ?? null;
}

function themeEditableNodes(document) {
  const root = document.documentElement;
  if (root.namespaceURI !== drawingNamespace || root.localName !== "theme")
    throw new Error("Native snapshot has an invalid theme.");
  const elements = directXmlChild(root, drawingNamespace, "themeElements");
  const colors = directXmlChild(elements, drawingNamespace, "clrScheme");
  const fonts = directXmlChild(elements, drawingNamespace, "fontScheme");
  const nodes = new Map([
    ["themeName", [root, "name"]],
    ["colorSchemeName", [colors, "name"]],
    ["fontSchemeName", [fonts, "name"]],
  ]);
  for (const name of [
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ]) {
    const slot = directXmlChild(colors, drawingNamespace, name);
    const value = [...slot.childNodes].find((child) => child.nodeType === 1);
    if (
      !value ||
      value.namespaceURI !== drawingNamespace ||
      !["srgbClr", "sysClr"].includes(value.localName)
    )
      throw new Error(
        `Native snapshot has an unsupported theme color ${name}.`,
      );
    nodes.set(`color:${name}`, [
      value,
      value.localName === "sysClr" ? "lastClr" : "val",
    ]);
  }
  for (const role of ["majorFont", "minorFont"]) {
    const font = directXmlChild(fonts, drawingNamespace, role);
    for (const name of ["latin", "ea", "cs"])
      nodes.set(`font:${role}:${name}`, [
        directXmlChild(font, drawingNamespace, name),
        "typeface",
      ]);
  }
  return nodes;
}

function mergeThemeValues(originalBytes, noEditBytes, editedBytes, part) {
  const original = parseXml({ [part]: originalBytes }, part);
  const noEdit = parseXml({ [part]: noEditBytes }, part);
  const edited = parseXml({ [part]: editedBytes }, part);
  const originalNodes = themeEditableNodes(original);
  const baselineNodes = themeEditableNodes(noEdit);
  const editedNodes = themeEditableNodes(edited);
  let changed = 0;
  for (const [key, [editedNode, editedAttribute]] of editedNodes) {
    const [baselineNode, baselineAttribute] = baselineNodes.get(key);
    const [originalNode, originalAttribute] = originalNodes.get(key);
    const before = baselineNode.getAttribute(baselineAttribute);
    const after = editedNode.getAttribute(editedAttribute);
    if (before === after) continue;
    if (key.startsWith("color:") && !/^[0-9a-f]{6}$/iu.test(after))
      throw new Error(`Native snapshot has an invalid theme color ${key}.`);
    if (key.startsWith("color:") && originalNode.localName === "sysClr") {
      const explicit = original.createElementNS(drawingNamespace, "a:srgbClr");
      explicit.setAttribute("val", after);
      originalNode.parentNode.replaceChild(explicit, originalNode);
    } else originalNode.setAttribute(originalAttribute, after);
    // Compare the complete same-engine XML after undoing only the fields that
    // this command is allowed to change. A collateral theme rewrite fails.
    if (key.startsWith("color:") || key.startsWith("font:")) {
      editedNode.parentNode.replaceChild(
        importOoxmlSubtree(noEdit, baselineNode, true),
        editedNode,
      );
    } else editedNode.setAttribute(editedAttribute, before);
    changed += 1;
  }
  if (
    !changed ||
    !sameEngineExportPart(part, serializeXml(edited), noEditBytes)
  )
    throw new Error("Native snapshot theme contains a non-theme mutation.");
  return serializeXml(original);
}

// The engine's presentation part and its relationships differ from the
// author's throughout (it writes one master per layout), so they are never
// taken as saved. A deck without a notes master gets one when a slide first
// receives notes, and one without comment authors gets that part with its
// first comment: only the new relationship and, for a notes master, its id
// list entry join the author's copies. Deleting the deck's last comment drops
// the comment authors part, and its relationship leaves the author's copy.
// Otherwise the author's copies stay as they are. The engine also rewrites
// the notes page size on some saves, which no edit here asks for. Any other
// change to the presentation part is left to the ordinary merge.
const addedPresentationRelationships = new Set([
  "notesMaster",
  "commentAuthors",
]);
const removedPresentationRelationships = new Set(["commentAuthors"]);

function mergePresentationParts(original, noEdit, edited) {
  const hasPresentation = (entries) =>
    Boolean(
      entries[presentationPath] && entries[presentationRelationshipsPath],
    );
  if (![original, noEdit, edited].every(hasPresentation)) return null;
  if (
    samePartBytes(noEdit[presentationPath], edited[presentationPath]) &&
    samePartBytes(
      noEdit[presentationRelationshipsPath],
      edited[presentationRelationshipsPath],
    )
  )
    return null;
  const relationshipsOf = (entries) =>
    relationshipElements(parseXml(entries, presentationRelationshipsPath))
      .filter(
        (relationship) =>
          relationship.getAttribute("TargetMode") !== "External",
      )
      .map((relationship) => ({
        id: relationship.getAttribute("Id"),
        type: relationship.getAttribute("Type"),
        kind: relationship.getAttribute("Type")?.split("/").at(-1),
        target: resolvePart(
          presentationPath,
          relationship.getAttribute("Target"),
        ),
      }));
  const identity = ({ type, target }) => `${type}|${target}`;
  const [authored, normalized, changed] = [original, noEdit, edited].map(
    relationshipsOf,
  );
  const normalizedIdentities = new Set(normalized.map(identity));
  const changedIdentities = new Set(changed.map(identity));
  const added = changed.filter(
    (relationship) => !normalizedIdentities.has(identity(relationship)),
  );
  const removed = normalized.filter(
    (relationship) => !changedIdentities.has(identity(relationship)),
  );
  if (
    removed.some(
      ({ kind, target }) =>
        !removedPresentationRelationships.has(kind) || edited[target],
    ) ||
    added.some(
      ({ kind }) =>
        !addedPresentationRelationships.has(kind) ||
        authored.some((relationship) => relationship.kind === kind),
    )
  )
    return null;

  // Beyond those, the engine's two saves may differ only by the notes master
  // list and the notes page size, with every r:id read as its target.
  const comparable = (entries, relationships) => {
    const targets = new Map(
      relationships.map((relationship) => [
        relationship.id,
        identity(relationship),
      ]),
    );
    const document = parseXml(entries, presentationPath);
    for (const name of ["notesMasterIdLst", "notesSz"])
      for (const element of [
        ...document.documentElement.getElementsByTagNameNS(
          presentationNamespace,
          name,
        ),
      ])
        element.parentNode.removeChild(element);
    for (const element of [
      document.documentElement,
      ...document.getElementsByTagName("*"),
    ]) {
      const id = element.getAttributeNS(relationshipAttributeNamespace, "id");
      if (id)
        element.setAttributeNS(
          relationshipAttributeNamespace,
          "r:id",
          targets.get(id) ?? `missing:${id}`,
        );
    }
    return serializeXml(document);
  };
  if (
    !samePartBytes(comparable(noEdit, normalized), comparable(edited, changed))
  )
    return null;
  if (!added.length && !removed.length)
    return {
      [presentationPath]: original[presentationPath],
      [presentationRelationshipsPath]: original[presentationRelationshipsPath],
    };

  const relationships = parseXml(original, presentationRelationshipsPath);
  const presentation = parseXml(original, presentationPath);
  let presentationChanged = false;
  for (const { kind } of removed)
    for (const element of relationshipElements(relationships))
      if (element.getAttribute("Type")?.split("/").at(-1) === kind)
        element.parentNode.removeChild(element);
  for (const relationship of added) {
    // Every part the new one needs arrives from the engine; none may take the
    // place of one the author has.
    const dependencies = edited[relationshipsPath(relationship.target)]
      ? relationshipElements(
          parseXml(edited, relationshipsPath(relationship.target)),
        )
          .filter(
            (dependency) =>
              dependency.getAttribute("TargetMode") !== "External",
          )
          .map((dependency) =>
            resolvePart(relationship.target, dependency.getAttribute("Target")),
          )
      : [];
    for (const part of [relationship.target, ...dependencies])
      if (original[part])
        throw new Error(
          `Native snapshot cannot add ${relationship.target} over the author's ${part}.`,
        );
    const id = nextRelationshipId(relationships);
    const element = relationships.createElementNS(
      packageRelationshipNamespace,
      "Relationship",
    );
    element.setAttribute("Id", id);
    element.setAttribute("Type", relationship.type);
    element.setAttribute(
      "Target",
      relativePart(presentationPath, relationship.target),
    );
    relationships.documentElement.appendChild(element);
    if (relationship.kind !== "notesMaster") continue;
    registerNotesMaster(presentation, id);
    presentationChanged = true;
  }
  return {
    [presentationPath]: presentationChanged
      ? serializeXml(presentation)
      : original[presentationPath],
    [presentationRelationshipsPath]: serializeXml(relationships),
  };
}

function registerNotesMaster(presentation, relationshipId) {
  const root = presentation.documentElement;
  let list = optionalDirectXmlChild(root, presentationNamespace, "notesMasterIdLst");
  if (!list) {
    list = presentation.createElementNS(presentationNamespace, "p:notesMasterIdLst");
    // CT_Presentation: sldMasterIdLst, then notesMasterIdLst.
    const masters = optionalDirectXmlChild(root, presentationNamespace, "sldMasterIdLst");
    root.insertBefore(list, masters ? masters.nextSibling : root.firstChild);
  }
  const entry = presentation.createElementNS(presentationNamespace, "p:notesMasterId");
  entry.setAttributeNS(relationshipAttributeNamespace, "r:id", relationshipId);
  list.appendChild(entry);
}

function relationshipsOfType(entries, sourcePart, type) {
  const relsPath = relationshipsPath(sourcePart);
  if (!entries[relsPath])
    throw new Error(
      `Native snapshot is missing relationships for ${sourcePart}.`,
    );
  const document = parseXml(entries, relsPath);
  return relationshipElements(document)
    .filter(
      (relationship) =>
        relationship.getAttribute("Type")?.endsWith(`/${type}`) &&
        relationship.getAttribute("TargetMode") !== "External",
    )
    .map((relationship) => ({
      id: relationship.getAttribute("Id"),
      target: resolvePart(sourcePart, relationship.getAttribute("Target")),
    }));
}

function singleRelationshipTarget(entries, sourcePart, type) {
  const targets = relationshipsOfType(entries, sourcePart, type);
  if (targets.length !== 1)
    throw new Error(
      `Native snapshot cannot identify ${type} for ${sourcePart}.`,
    );
  return targets[0].target;
}

function setRelationshipTarget(entries, sourcePart, type, target) {
  const relsPath = relationshipsPath(sourcePart);
  const document = parseXml(entries, relsPath);
  const matching = relationshipElements(document).filter((relationship) =>
    relationship.getAttribute("Type")?.endsWith(`/${type}`),
  );
  if (matching.length !== 1)
    throw new Error(
      `Native snapshot cannot retarget ${type} for ${sourcePart}.`,
    );
  matching[0].setAttribute("Target", relativePart(sourcePart, target));
  entries[relsPath] = serializeXml(document);
}

// A selected master/layout is an ordered package relationship, not a unique
// display name. Bind it before the edit; same-named layouts remain distinct.
function authoredMasterLayout(entries,target) {
  const presentation=parseXml(entries,presentationPath);
  const relations=new Map(relationshipsOfType(entries,presentationPath,"slideMaster").map(item=>[item.id,item.target]));
  const masters=[...presentation.getElementsByTagNameNS(presentationNamespace,"sldMasterId")].map(node=>relations.get(node.getAttributeNS(relationshipAttributeNamespace,"id")));
  if(masters.length!==target.sourceMasterCount||!Number.isSafeInteger(target.masterIndex)||!masters[target.masterIndex])
    throw Error("Native snapshot source master binding differs from admission.");
  const master=masters[target.masterIndex],document=parseXml(entries,master);
  const layoutRelations=new Map(relationshipsOfType(entries,master,"slideLayout").map(item=>[item.id,item.target]));
  const layouts=[...document.getElementsByTagNameNS(presentationNamespace,"sldLayoutId")].map(node=>layoutRelations.get(node.getAttributeNS(relationshipAttributeNamespace,"id")));
  if(layouts.length!==target.sourceLayoutCount||layouts.some(part=>!part))
    throw Error("Native snapshot source layout binding differs from admission.");
  if(target.op==="set_slide_layout"&&(!Number.isSafeInteger(target.layout)||!layouts[target.layout]))
    throw Error("Native snapshot selected source layout is missing.");
  return {master,layouts,layout:layouts[target.layout]??null};
}

function mergeMasterThemeIntoOriginal(original, noEdit, edited, sourceTarget = null) {
  const themeParts = Object.keys(edited).filter(
    (part) =>
      /^ppt\/theme\/theme[^/]+\.xml$/u.test(part) &&
      !sameEngineExportPart(part, noEdit[part], edited[part]),
  );
  if (themeParts.length !== 1)
    throw new Error("Native snapshot needs exactly one edited master theme.");
  const sourceTheme = themeParts[0];
  const normalizedMasters = Object.keys(noEdit).filter((part) =>
    /^ppt\/slideMasters\/slideMaster[^/]+\.xml$/u.test(part),
  );
  const sourceMasters = normalizedMasters.filter(
    (part) => singleRelationshipTarget(noEdit, part, "theme") === sourceTheme,
  );
  if (sourceMasters.length !== 1)
    throw new Error("Native snapshot cannot identify the edited master.");
  const sourceLayouts = relationshipsOfType(
    noEdit,
    sourceMasters[0],
    "slideLayout",
  ).map(({ target }) => target);
  if (!sourceLayouts.length)
    throw new Error("Native snapshot edited master has no layouts.");
  const originalLayouts = Object.keys(original).filter((part) =>
    /^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(part),
  );
  const owned=sourceTarget?authoredMasterLayout(original,sourceTarget):null;
  const selected = owned ? new Set(owned.layouts) : new Set(
    sourceLayouts.map((source) => {
      const identity = slideLayoutIdentity(noEdit, source);
      const matches = originalLayouts.filter((part) => {
        const candidate = slideLayoutIdentity(original, part);
        return (
          candidate.name === identity.name && candidate.type === identity.type
        );
      });
      if (matches.length !== 1)
        throw new Error(
          `Native snapshot cannot uniquely map layout ${identity.name}.`,
        );
      return matches[0];
    }),
  );
  const owners = new Set(
    [...selected].map((part) =>
      singleRelationshipTarget(original, part, "slideMaster"),
    ),
  );
  if (owners.size !== 1)
    throw new Error(
      "Native snapshot selected layouts have different original masters.",
    );
  const owner = [...owners][0];
  const ownerLayouts = relationshipsOfType(original, owner, "slideLayout");
  if (
    ![...selected].every((part) =>
      ownerLayouts.some(({ target }) => target === part),
    )
  )
    throw new Error("Native snapshot master does not own a selected layout.");
  const originalTheme = singleRelationshipTarget(original, owner, "theme");
  const themeBytes = mergeThemeValues(
    original[originalTheme],
    noEdit[sourceTheme],
    edited[sourceTheme],
    originalTheme,
  );
  const patched = {};
  if (selected.size === ownerLayouts.length) {
    patched[originalTheme] = themeBytes;
    return patched;
  }
  const masterCopy = nextPartPath(original, owner);
  const themeCopy = nextPartPath(original, originalTheme);
  const oldMaster = parseXml(original, owner);
  const newMaster = parseXml(original, owner);
  const oldRelsPath = relationshipsPath(owner);
  const oldRels = parseXml(original, oldRelsPath);
  const newRels = parseXml(original, oldRelsPath);
  const pruneMaster = (master, rels, keepSelected) => {
    const ids = master.getElementsByTagNameNS(
      presentationNamespace,
      "sldLayoutId",
    );
    const byId = new Map(
      [...ids].map((element) => [
        element.getAttributeNS(relationshipAttributeNamespace, "id"),
        element,
      ]),
    );
    for (const relationship of relationshipElements(rels)) {
      if (!relationship.getAttribute("Type")?.endsWith("/slideLayout"))
        continue;
      const target = resolvePart(owner, relationship.getAttribute("Target"));
      if (selected.has(target) === keepSelected) continue;
      const id = relationship.getAttribute("Id");
      const element = byId.get(id);
      if (!element)
        throw new Error(`Native snapshot master lacks layout ${id}.`);
      element.parentNode.removeChild(element);
      relationship.parentNode.removeChild(relationship);
    }
  };
  pruneMaster(oldMaster, oldRels, false);
  pruneMaster(newMaster, newRels, true);
  const themeRelation = relationshipElements(newRels).find((relationship) =>
    relationship.getAttribute("Type")?.endsWith("/theme"),
  );
  if (!themeRelation)
    throw new Error("Native snapshot master has no theme link.");
  themeRelation.setAttribute("Target", relativePart(masterCopy, themeCopy));
  patched[owner] = serializeXml(oldMaster);
  patched[oldRelsPath] = serializeXml(oldRels);
  patched[masterCopy] = serializeXml(newMaster);
  patched[relationshipsPath(masterCopy)] = serializeXml(newRels);
  patched[themeCopy] = themeBytes;
  for (const layout of selected) {
    const entries = { ...original };
    setRelationshipTarget(entries, layout, "slideMaster", masterCopy);
    patched[relationshipsPath(layout)] = entries[relationshipsPath(layout)];
  }
  const presentation = parseXml(original, presentationPath);
  const presentationRels = parseXml(original, presentationRelationshipsPath);
  const masterIds = directXmlChild(
    presentation.documentElement,
    presentationNamespace,
    "sldMasterIdLst",
  );
  const existingIds = [
    ...masterIds.getElementsByTagNameNS(presentationNamespace, "sldMasterId"),
  ].map((element) => Number(element.getAttribute("id")));
  const nextId = Math.max(...existingIds) + 1;
  if (!Number.isSafeInteger(nextId) || nextId > 0xffffffff)
    throw new Error("Native snapshot has no available master ID.");
  const relationshipId = nextRelationshipId(presentationRels);
  const sourceRelationship = relationshipElements(presentationRels).find(
    (relationship) =>
      relationship.getAttribute("Type")?.endsWith("/slideMaster") &&
      resolvePart(presentationPath, relationship.getAttribute("Target")) ===
        owner,
  );
  if (!sourceRelationship)
    throw new Error("Native snapshot original master is not presented.");
  const newRelationship = sourceRelationship.cloneNode(true);
  newRelationship.setAttribute("Id", relationshipId);
  newRelationship.setAttribute(
    "Target",
    relativePart(presentationPath, masterCopy),
  );
  presentationRels.documentElement.appendChild(newRelationship);
  const newMasterId = presentation.createElementNS(
    presentationNamespace,
    "p:sldMasterId",
  );
  newMasterId.setAttribute("id", String(nextId));
  newMasterId.setAttributeNS(
    relationshipAttributeNamespace,
    "r:id",
    relationshipId,
  );
  masterIds.appendChild(newMasterId);
  patched[presentationPath] = serializeXml(presentation);
  patched[presentationRelationshipsPath] = serializeXml(presentationRels);
  const contentTypes = parseXml(original, contentTypesPath);
  const context = { entries: original, contentTypes };
  copyContentType(context, owner, masterCopy);
  copyContentType(context, originalTheme, themeCopy);
  patched[contentTypesPath] = serializeXml(contentTypes);
  return patched;
}

function slideSizeFromPresentation(entries) {
  const document = parseXml(entries, presentationPath);
  const sizes = [
    ...document.getElementsByTagNameNS(presentationNamespace, "sldSz"),
  ];
  if (sizes.length !== 1)
    throw new Error("Native snapshot needs exactly one slide size.");
  const [width, height] = ["cx", "cy"].map((attribute) =>
    sizes[0].getAttribute(attribute),
  );
  if (![width, height].every((value) => /^[1-9]\d*$/u.test(value ?? "")))
    throw new Error("Native snapshot has an invalid slide size.");
  return { document, element: sizes[0], width, height };
}

function replaceXmlNumericAttribute(tag, attribute, value) {
  const pattern = new RegExp(
    `(\\b${attribute}\\s*=\\s*)(["'])([0-9]+)\\2`,
    "u",
  );
  if (!pattern.test(tag))
    throw new Error(`Native snapshot cannot patch slide size ${attribute}.`);
  return tag.replace(
    pattern,
    (_match, prefix, quote) => `${prefix}${quote}${value}${quote}`,
  );
}

function mergeSlideSizeIntoOriginal(original, noEdit, edited) {
  if (
    !samePartBytes(
      noEdit[presentationRelationshipsPath],
      edited[presentationRelationshipsPath],
    )
  )
    throw new Error("Slide size edit changed presentation relationships.");
  const baseline = slideSizeFromPresentation(noEdit);
  const candidate = slideSizeFromPresentation(edited);
  if (
    baseline.width === candidate.width &&
    baseline.height === candidate.height
  )
    throw new Error("Slide size edit did not change the slide size.");
  candidate.element.setAttribute("cx", baseline.width);
  candidate.element.setAttribute("cy", baseline.height);
  if (
    !sameEngineExportPart(
      presentationPath,
      serializeXml(candidate.document),
      noEdit[presentationPath],
    )
  )
    throw new Error("Slide size edit also changed other presentation fields.");
  const source = strFromU8(original[presentationPath]);
  const tags = [...source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sldSz\b[^>]*>/gu)];
  if (tags.length !== 1)
    throw new Error("Original presentation slide size is not patchable.");
  const replacement = replaceXmlNumericAttribute(
    replaceXmlNumericAttribute(tags[0][0], "cx", candidate.width),
    "cy",
    candidate.height,
  );
  const bytes = strToU8(
    `${source.slice(0, tags[0].index)}${replacement}${source.slice(tags[0].index + tags[0][0].length)}`,
  );
  const reopened = slideSizeFromPresentation({ [presentationPath]: bytes });
  if (
    reopened.width !== candidate.width ||
    reopened.height !== candidate.height
  )
    throw new Error("Original presentation slide size patch did not persist.");
  return bytes;
}

// A numeric chart edit must keep workbook content the engine did not edit.
// Only accept a complete, same-engine delta consisting of constant cell values;
// new sheets, formulas, styles and ambiguous cell identities use the ordinary
// package path instead. The author's cell must agree with the native baseline.
export function mergeNumericWorkbookDelta(
  originalBytes,
  baselineBytes,
  editedBytes,
  labelIntent = null,
) {
  if (
    ![originalBytes, baselineBytes, editedBytes].every(
      (bytes) => bytes instanceof Uint8Array,
    )
  )
    return null;
  let sizes;
  try {
    sizes = [originalBytes, baselineBytes, editedBytes].map(
      (bytes) => inspectZipPackage(bytes).expandedBytes,
    );
  } catch {
    // Embedded package relationships can also contain opaque legacy payloads.
    // No guessed XML interpretation or numeric reconciliation is permitted.
    return null;
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > maximumInputBytes)
    return null;
  const [original, baseline, edited] = [
    originalBytes,
    baselineBytes,
    editedBytes,
  ].map((bytes) => unzipSync(bytes));
  const names = Object.keys(baseline);
  if (
    names.length !== Object.keys(edited).length ||
    names.some((name) => !edited[name])
  )
    return null;
  const result = { ...original };
  let changes = 0;
  const sheetOwners = (entries) => {
    if (!entries["xl/workbook.xml"] || !entries["xl/_rels/workbook.xml.rels"])
      return null;
    const document = parseXml(entries, "xl/workbook.xml");
    const relationships = relationshipElements(
      parseXml(entries, "xl/_rels/workbook.xml.rels"),
    );
    const owners = new Map(),
      sheetNames = new Set();
    for (const sheet of document.getElementsByTagNameNS(
      document.documentElement.namespaceURI,
      "sheet",
    )) {
      const name = sheet.getAttribute("name");
      const id =
        sheet.getAttributeNS(relationshipAttributeNamespace, "id") ||
        sheet.getAttributeNS(
          "http://purl.oclc.org/ooxml/officeDocument/relationships",
          "id",
        );
      const matches = relationships.filter(
        (relationship) =>
          relationship.getAttribute("Id") === id &&
          [
            `${relationshipAttributeNamespace}/worksheet`,
            "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
          ].includes(relationship.getAttribute("Type")) &&
          relationship.getAttribute("TargetMode") !== "External",
      );
      if (!name || sheetNames.has(name) || matches.length !== 1) return null;
      const target = resolvePart(
        "xl/workbook.xml",
        matches[0].getAttribute("Target"),
      );
      if (!entries[target] || owners.has(target)) return null;
      owners.set(target, name);
      sheetNames.add(name);
    }
    return owners;
  };
  const owners = [original, baseline, edited].map(sheetOwners);
  if (owners.some((owner) => !owner)) return null;
  const numericEqual = (left, right) =>
    Math.abs(left - right) <=
    1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
  const strings = (entries) => {
    if (!entries["xl/sharedStrings.xml"]) return [];
    const document=parseXml(entries,"xl/sharedStrings.xml");
    return [...document.getElementsByTagNameNS(document.documentElement.namespaceURI,"si")]
      .map(item=>[...item.getElementsByTagNameNS(item.namespaceURI,"t")].map(text=>text.textContent).join(""));
  };
  const stringTables=[original,baseline,edited].map(strings);
  const textValue=(cell,index)=>{
    if(!cell||optionalDirectXmlChild(cell,cell.namespaceURI,"f"))return null;
    const type=cell.getAttribute("t");
    if(type==="s"){
      const value=optionalDirectXmlChild(cell,cell.namespaceURI,"v")?.textContent;
      return /^\d+$/u.test(value??"")?stringTables[index][Number(value)]??null:null;
    }
    if(type!=="inlineStr")return null;
    const inline=optionalDirectXmlChild(cell,cell.namespaceURI,"is");
    return inline?[...inline.getElementsByTagNameNS(cell.namespaceURI,"t")].map(text=>text.textContent).join(""):null;
  };
  const hasLabels=labelIntent?.writes?.size>0;
  for (const part of names) {
    const sheetPart=/^xl\/worksheets\/[^/]+\.xml$/u.test(part);
    // A shared-string value can change while a worksheet's index stays the
    // same. Inspect every worksheet when admitting explicit label writes.
    if (samePartBytes(baseline[part], edited[part])&&!(hasLabels&&sheetPart)) continue;
    if(hasLabels&&part==="xl/sharedStrings.xml")continue;
    // These properties describe the save, not chart data. All other metadata
    // and every unknown package payload must match the two native exports.
    if (part === "docProps/core.xml") {
      const documents = [baseline, edited].map((entries) =>
        parseXml(entries, part),
      );
      for (const document of documents)
        for (const element of [...document.getElementsByTagName("*")])
          if (
            (element.namespaceURI === "http://purl.org/dc/terms/" &&
              element.localName === "modified") ||
            (element.namespaceURI ===
              "http://schemas.openxmlformats.org/package/2006/metadata/core-properties" &&
              ["lastModifiedBy", "revision"].includes(element.localName))
          )
            element.textContent = "__native_save_property__";
      if (
        !samePartBytes(serializeXml(documents[0]), serializeXml(documents[1]))
      )
        return null;
      continue;
    }
    if (!/^xl\/worksheets\/[^/]+\.xml$/u.test(part) || !original[part]) {
      if (!sameEngineExportPart(part, baseline[part], edited[part]))
        return null;
      continue;
    }
    const [source, before, after] = [original, baseline, edited].map(
      (entries) => parseXml(entries, part),
    );
    const owner = owners[0].get(part);
    if (
      !owner ||
      owners[1].get(part) !== owner ||
      owners[2].get(part) !== owner
    )
      return null;
    const cells = (document) => {
      const nodes = [
        ...document.getElementsByTagNameNS(
          document.documentElement.namespaceURI,
          "c",
        ),
      ];
      const map = new Map(nodes.map((cell) => [cell.getAttribute("r"), cell]));
      return map.size === nodes.length &&
        [...map.keys()].every((address) =>
          /^[A-Z]{1,3}[1-9]\d*$/u.test(address),
        )
        ? map
        : null;
    };
    const maps = [source, before, after].map(cells);
    if (maps.some((map) => !map) || maps[1].size !== maps[2].size) return null;
    let worksheetChanges = 0;
    for (const [address, priorCell] of maps[1]) {
      const nextCell = maps[2].get(address);
      if (!nextCell) return null;
      const authoredCell = maps[0].get(address);
      const texts=[authoredCell,priorCell,nextCell].map(textValue);
      const labelChanged=texts[1]!==texts[2];
      const sameCell=samePartBytes(serializeXml(priorCell),serializeXml(nextCell));
      if(sameCell&&!labelChanged)continue;
      if(texts.every(text=>typeof text==="string")){
        if(texts[0]!==texts[1])return null;
        if(labelChanged&&(!hasLabels||owner!==labelIntent.sheetName||labelIntent.writes.get(address)!==texts[2]))return null;
        // Compare all non-value properties, and retain the author's cell
        // attributes/styles. The only admitted delta is the requested text.
        const stripped=[priorCell,nextCell].map(cell=>{
          const clone=cell.cloneNode(true);clone.removeAttribute("t");
          for(const child of [...clone.childNodes])if(child.nodeType===1&&["v","is"].includes(child.localName))clone.removeChild(child);
          return serializeXml(clone);
        });
        if(!samePartBytes(...stripped))return null;
        if(labelChanged){
          authoredCell.setAttribute("t","inlineStr");
          for(const child of [...authoredCell.childNodes])if(child.nodeType===1&&["v","is"].includes(child.localName))authoredCell.removeChild(child);
          const inline=source.createElementNS(authoredCell.namespaceURI,"is"),text=source.createElementNS(authoredCell.namespaceURI,"t");
          if(/^\s|\s$/u.test(texts[2]))text.setAttribute("xml:space","preserve");
          text.textContent=texts[2];inline.appendChild(text);authoredCell.appendChild(inline);worksheetChanges++;
        }
        nextCell.parentNode.replaceChild(priorCell.cloneNode(true),nextCell);
        continue;
      }
      const numeric = (cell) => {
        if (
          !cell ||
          ![null, "", "n"].includes(cell.getAttribute("t")) ||
          optionalDirectXmlChild(cell, cell.namespaceURI, "f")
        )
          return null;
        const node=optionalDirectXmlChild(cell,cell.namespaceURI,"v");
        const value=node?.textContent.trim()?Number(node.textContent):null;
        return value===null||Number.isFinite(value)?{node,value}:null;
      };
      const values = [authoredCell, priorCell, nextCell].map(numeric);
      if (
        values.some((value) => !value) ||
        (values[0].value===null)!==(values[1].value===null)||
        values[0].value!==null&&!numericEqual(values[0].value,values[1].value)
      )
        return null;
      const nextValue=values[2].value;
      const stripValue=cell=>{
        const clone=cell.cloneNode(true),value=optionalDirectXmlChild(clone,clone.namespaceURI,"v");
        if(value)clone.removeChild(value);return serializeXml(clone);
      };
      if (!samePartBytes(stripValue(priorCell),stripValue(nextCell)))
        return null;
      const valueChanged=(values[1].value===null)!==(nextValue===null)||nextValue!==null&&!numericEqual(values[1].value,nextValue);
      if(valueChanged){
        if(labelIntent&&(!labelIntent.values?.has(address)||owner!==labelIntent.sheetName||labelIntent.values.get(address)!==nextValue))return null;
        if(nextValue===null){if(values[0].node)authoredCell.removeChild(values[0].node);}
        else {
          const valueNode=values[0].node??source.createElementNS(authoredCell.namespaceURI,"v");valueNode.textContent=String(nextValue);
          if(!values[0].node)authoredCell.appendChild(valueNode);
        }
        worksheetChanges++;
      }
      nextCell.parentNode.replaceChild(priorCell.cloneNode(true),nextCell);
    }
    if (!samePartBytes(serializeXml(before), serializeXml(after))) return null;
    if (worksheetChanges) {
      result[part] = serializeXml(source);
      changes += worksheetChanges;
    }
  }
  return changes
    ? zipSync(result, { level: 6, mtime: deterministicZipModifiedAt })
    : null;
}
// A no-op export can materialize empty notes and their relationships. When
// notes text is subsequently authored, its unchanged incoming relationship is
// nevertheless required. Promote only the changed, authorized notes page;
// never import every empty notes page from the engine's no-op export.
function connectChangedNewNotes(original, noEdit, edited, merged, operations, targets, humanEdit, budget) {
  if (!humanEdit && !operations.includes("set_speaker_notes")) return [];
  const patched = [];
  const slides = orderedSlidePaths(original);
  const permitted = humanEdit || targets === null ? slides : (targets ?? []).filter((t) => t.op === "set_speaker_notes").map((t) => slides[t.slideIndex]);
  const allowedSlides = new Set(permitted);
  if (!humanEdit)
    for (const slide of slides) {
      if (allowedSlides.has(slide) || !edited[relationshipsPath(slide)]) continue;
      for (const {target} of relationshipsOfType(edited, slide, "notesSlide"))
        if (!original[target] && merged[target]) {
          delete merged[target];
          delete merged[relationshipsPath(target)];
          patched.push(target);
        }
    }
  const append = (source, kind, target) => {
    const path = relationshipsPath(source);
    const document = merged[path] ? parseXml(merged, path) : new DOMParser().parseFromString(`<Relationships xmlns="${packageRelationshipNamespace}"/>`, "application/xml");
    if (relationshipElements(document).some((r) => r.getAttribute("Type").endsWith("/" + kind) && resolvePart(source, r.getAttribute("Target")) === target)) return null;
    const id = nextRelationshipId(document);
    const relationship = document.createElementNS(packageRelationshipNamespace, "Relationship");
    relationship.setAttribute("Id", id);
    relationship.setAttribute("Type", `${relationshipAttributeNamespace}/${kind}`);
    relationship.setAttribute("Target", relativePart(source, target));
    document.documentElement.appendChild(relationship);
    merged[path] = serializeXml(document);
    patched.push(path);
    return id;
  };
  for (const slide of new Set(permitted)) {
    if (!slide || !edited[relationshipsPath(slide)]) continue;
    const notes = relationshipsOfType(edited, slide, "notesSlide");
    if (!notes.length) continue;
    if (notes.length !== 1) throw new Error(`Native snapshot cannot identify notes for ${slide}.`);
    const part = notes[0].target;
    if (original[part] || !merged[part] || sameEngineExportPart(part, noEdit[part], edited[part])) continue;
    if (!budget.allowPartCreationOrDeletion || !budget.allowedCategories.has("slide_relationships") || !budget.allowedCategories.has("notes_relationships"))
      throw new Error("Native snapshot cannot connect new notes outside its change budget.");
    append(slide, "notesSlide", part);
    const related = relationshipsPath(part);
    if (!edited[related]) throw new Error(`Native snapshot is missing new notes relationships for ${part}.`);
    merged[related] = edited[related];
    patched.push(related);
    const masters = relationshipsOfType(edited, part, "notesMaster");
    if (masters.length !== 1) throw new Error(`Native snapshot cannot identify notes master for ${part}.`);
    const master = masters[0].target;
    const existing = merged[presentationRelationshipsPath] ? relationshipsOfType(merged, presentationPath, "notesMaster") : [];
    if (!existing.some((r) => r.target === master)) {
      if (!budget.allowedCategories.has("presentation_relationships") || !budget.allowedCategories.has("presentation"))
        throw new Error("Native snapshot cannot connect notes master outside its change budget.");
      const id = append(presentationPath, "notesMaster", master);
      const presentation = parseXml(merged, presentationPath);
      registerNotesMaster(presentation, id);
      merged[presentationPath] = serializeXml(presentation);
      patched.push(presentationPath);
    }
  }
  return patched;
}

// Office can rewrite unrelated package parts even when no edit was made.
// Compare two exports from that same engine, then apply only their actual
// difference to the user's original package. Reopening the result and proving
// its intended model state is still required before it can be committed.
export function preserveOriginalPptxParts(
  originalBytes,
  noEditBytes,
  editedBytes,
  sourceOperations,
  sourceTargets = null,
) {
  // null marks a direct human edit; every AI edit names its operations.
  const humanEdit = sourceOperations === null;
  const budget = humanEdit
    ? humanEditPreservationBudget()
    : nativePreservationBudget(sourceOperations);
  sourceOperations = humanEdit ? [] : sourceOperations;
  for (const bytes of [originalBytes, noEditBytes, editedBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumInputBytes)
      throw new TypeError("Native snapshot inputs must be bounded PPTX bytes.");
    inspectZipPackage(bytes);
  }
  const original = unzipSync(originalBytes);
  const rawNoEdit = alignEngineSlideParts(original, unzipSync(noEditBytes));
  const workbookRenames = chartWorkbookRenames(original, rawNoEdit);
  const noEdit = renameEnginePackageParts(rawNoEdit, workbookRenames);
  const rawEdited = unzipSync(editedBytes);
  const topology = humanEdit
    ? directSlideTopologyPaths(original, noEdit, rawEdited, sourceTargets)
    : null;
  if (
    humanEdit &&
    orderedSlidePaths(original).length !==
      orderedSlidePaths(rawEdited).length &&
    !topology
  )
    throw new Error(
      "Native slide topology has no unambiguous retained-content correspondence.",
    );
  const topologyPaths = topology?.paths ?? null;
  const edited = renameEnginePackageParts(
    alignEngineSlideParts(original, rawEdited, topologyPaths), workbookRenames,
  );
  const expandedBytes = [original, noEdit, edited].reduce(
    (total, entries) =>
      total +
      Object.values(entries).reduce(
        (size, bytes) => size + bytes.byteLength,
        0,
      ),
    0,
  );
  if (expandedBytes > maximumExpandedBytes)
    throw new Error(
      "Native snapshot comparison exceeds the browser memory limit.",
    );

  if (sourceOperations.includes("set_sections") && sourceTargets?.some(target=>target.op === "set_sections")) {
    if (sourceOperations.length !== 1 || sourceTargets?.length !== 1 || sourceTargets[0].op !== "set_sections")
      throw new Error("Native sections require one declared complete section list.");
    const expected = normalizedSections(sourceTargets[0].sections,orderedSlidePaths(original).length);
    const exported = readSections(openPackage(editedBytes,{requireSimpleTopology:false})).map(({slideCount,...section})=>section);
    if (JSON.stringify(normalizedSections(exported,orderedSlidePaths(rawEdited).length)) !== JSON.stringify(expected))
      throw new Error("Native exported sections do not match the requested section list.");
    const context = openPackage(originalBytes,{requireSimpleTopology:false});
    const change = updateSections(context,{op:"set_sections",sections:expected});
    const bytes = zipSync(context.entries,{level:6,mtime:deterministicZipModifiedAt});
    inspectOoxmlDocument(bytes);
    return {bytes,report:{changedParts:change.changedParts,semanticPatchedParts:change.changedParts,suppressedNoopParts:[],suppressedOutOfBudgetParts:[],authoredShapeScopes:null,topologyAligned:false,topologyImportedDesign:null,topology:null,topologyExistingContentChanges:[]}};
  }

  if (sourceOperations.includes("insert_slide")) {
    if (sourceOperations.length !== 1 || sourceTargets?.length !== 1 || sourceTargets[0].op !== "insert_slide")
      throw new Error("Native slide insertion requires one declared position.");
    const sourceIndex = sourceTargets[0].slideIndex;
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= orderedSlidePaths(original).length)
      throw new Error("Native insertion position is outside the authored deck.");
    const intent = [{op:"native_slide_topology",slideIndex:sourceIndex+1,...(sourceTargets[0].masterIndex==null ? {sourceLayoutSlideIndex:sourceIndex} : {})}];
    const topology = directSlideTopologyPaths(original,noEdit,rawEdited,intent);
    if (topology?.kind !== "insert" || topology.index !== sourceIndex+1)
      throw new Error("Native insertion does not retain declared slide ownership.");
    const aligned = renameEnginePackageParts(alignEngineSlideParts(original,rawEdited,topology.paths),workbookRenames);
    const designProof = {};
    const entries = mergeDirectSlideTopology(originalBytes,original,noEdit,aligned,topology,intent,designProof);
    const bytes = zipSync(entries,{level:6,mtime:deterministicZipModifiedAt});
    inspectOoxmlDocument(bytes);
    const changed = changedPackageParts(original,entries);
    return {bytes,report:{changedParts:changed,semanticPatchedParts:changed,suppressedNoopParts:[],suppressedOutOfBudgetParts:[],authoredShapeScopes:null,topologyAligned:true,topologyImportedDesign:Object.keys(designProof).length?designProof:null,topology:{kind:"insert",index:sourceIndex+1},topologyExistingContentChanges:[]}};
  }

  if (sourceOperations.includes("duplicate_slide")) {
    if (sourceOperations.length !== 1 || sourceTargets?.length !== 1 || sourceTargets[0].op !== "duplicate_slide")
      throw new Error("Native slide duplication requires one declared source.");
    const sourceIndex = sourceTargets[0].slideIndex;
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= orderedSlidePaths(original).length)
      throw new Error("Native duplicate source is outside the authored deck.");
    const intent = [{op:"native_slide_topology",slideIndex:sourceIndex+1,cloneSourceSlideIndex:sourceIndex}];
    const topology = directSlideTopologyPaths(original,noEdit,rawEdited,intent);
    if (topology?.kind !== "insert" || topology.index !== sourceIndex+1)
      throw new Error("Native duplicate does not retain declared slide ownership.");
    const aligned = renameEnginePackageParts(alignEngineSlideParts(original,rawEdited,topology.paths),workbookRenames);
    const entries = mergeDirectSlideTopology(originalBytes,original,noEdit,aligned,topology,intent,{});
    const bytes = zipSync(entries,{level:6,mtime:deterministicZipModifiedAt});
    inspectOoxmlDocument(bytes);
    const changed = changedPackageParts(original,entries);
    return {bytes,report:{changedParts:changed,semanticPatchedParts:changed,suppressedNoopParts:[],suppressedOutOfBudgetParts:[],authoredShapeScopes:null,topologyAligned:true,topologyImportedDesign:null,topology:{kind:"duplicate",index:sourceIndex+1,sourceIndex},topologyExistingContentChanges:[]}};
  }

  if (sourceOperations.some(op => ["move_slide", "delete_slide"].includes(op))) {
    if (sourceOperations.length !== 1 || sourceTargets?.length !== 1 || sourceTargets[0].op !== sourceOperations[0])
      throw new Error("Native slide moves require one declared source and destination.");
    const request = sourceTargets[0], deleting = request.op === "delete_slide";
    const paths = orderedSlidePaths(noEdit), saved = orderedSlidePaths(rawEdited);
    if (!Number.isSafeInteger(request.slideIndex) || request.slideIndex < 0 || request.slideIndex >= paths.length ||
        (!deleting && (!Number.isSafeInteger(request.targetSlideIndex) || request.targetSlideIndex < 0 || request.targetSlideIndex >= paths.length)) ||
        paths.length - (deleting ? 1 : 0) !== saved.length)
      throw new Error("Native slide move coordinates do not match the authored deck.");
    const order = paths.map((_,index) => index);
    const [moved] = order.splice(request.slideIndex,1);
    if (!deleting) order.splice(request.targetSlideIndex,0,moved);
    for (const [index,originalIndex] of order.entries()) {
      const part = paths[originalIndex];
      let after = topologySlideBytes(rawEdited,saved[index]);
      const related = relationshipsPath(part), savedRelated = relationshipsPath(saved[index]);
      if (hasRelationshipReference(parseXml({[part]:after},part).documentElement)) {
        after = remapPartRelationshipIds(part,after,noEdit[related],rawEdited[savedRelated],[noEdit,rawEdited]);
        if (!after) throw new Error("Native moved slide relationships have no unique retained owner.");
      }
      const before = topologySlideBytes(noEdit,part);
      if (!sameEngineExportPart(part,before,after) && !topologyConnectorRoundingMatches(part,before,after))
        throw new Error("Native slide move changed retained content in " + part);
    }
    const context = openPackage(originalBytes,{requireSimpleTopology:false});
    const change = deleting ? deleteSlide(context,{op:"delete_slide",slideIndex:request.slideIndex}) : moveSlide(context,{op:"move_slide",slideIndex:request.slideIndex,insertIndex:request.targetSlideIndex});
    const bytes = zipSync(context.entries,{level:6,mtime:deterministicZipModifiedAt});
    inspectOoxmlDocument(bytes);
    return {bytes,report:{changedParts:change.changedParts,semanticPatchedParts:change.changedParts,
      suppressedNoopParts:[],suppressedOutOfBudgetParts:[],authoredShapeScopes:null,topologyAligned:true,
      topologyImportedDesign:null,topology:{kind:deleting ? "delete" : "move",index:request.slideIndex,...(!deleting ? {targetIndex:request.targetSlideIndex} : {})},
      topologyExistingContentChanges:[]}};
  }

  const tableTopologyTargetsByPart = new Map();
  if (sourceTargets?.some(t => sourceOperations.includes(t.op) && ["insert_table_rows", "delete_table_rows", "insert_table_columns", "delete_table_columns"].includes(t.op))) {
    const paths = orderedSlidePaths(original);
    for (const target of sourceTargets.filter(t => sourceOperations.includes(t.op) && ["insert_table_rows", "delete_table_rows", "insert_table_columns", "delete_table_columns"].includes(t.op))) {
      const part = paths[target.slideIndex];
      if (!part) throw new Error("Native table row target has no authored slide.");
      const targets = tableTopologyTargetsByPart.get(part) ?? [];
      targets.push(target);
      tableTopologyTargetsByPart.set(part, targets);
    }
  }
  const shapeScopes = humanEdit
    ? null
    : slideShapeTargets(sourceOperations, sourceTargets);
  const targetNamesBySlide = shapeScopes
    ? shapeTargetsBySlide(original, shapeScopes)
    : null;
  const targetIndexesBySlide = targetNamesBySlide
    ? directShapeTargetIndexesBySlide(original, sourceOperations, sourceTargets)
    : null;
  const directDeletionPart =
    sourceOperations.length === 1 &&
    sourceOperations[0] === "delete_element" &&
    targetIndexesBySlide?.size === 1
      ? [...targetIndexesBySlide.keys()][0]
      : null;
  const topologyImportedDesign = {};
  const topologyPatch = topology
    ? mergeDirectSlideTopology(
        originalBytes,
        original,
        noEdit,
        edited,
        topology,
        sourceTargets,
        topologyImportedDesign,
      )
    : null;
  const workbookLabelIntents=new Map();
  for(const target of sourceTargets??[]){
    if(target.op!=="set_chart_data"||!sourceOperations.includes(target.op))continue;
    const prepared=prepareChartWorkbookMutation(originalBytes,{
      ...target,shapeName:target.name,
    });
    const previous=workbookLabelIntents.get(prepared.workbookPart);
    if(previous&&previous.sheetName!==prepared.sheetName)
      throw Error("Chart label requests do not share one owned worksheet.");
    const intent=previous??{sheetName:prepared.sheetName,writes:new Map(),values:new Map()};
    for(const {address,value} of prepared.changedCells)intent.values.set(address,value);
    for(const {address,text} of prepared.labelWrites)intent.writes.set(address,text);
    workbookLabelIntents.set(prepared.workbookPart,intent);
  }
  const merged = topologyPatch ?? {};
  const editedSlides = [];
  const semanticPatchedParts = topologyPatch
    ? changedPackageParts(original, topologyPatch)
    : [];
  const suppressedNoopParts = [];
  const suppressedOutOfBudgetParts = [];
  const semanticMasterThemePatch =
    sourceOperations.length === 1 && sourceOperations[0] === "set_master_theme"
      ? mergeMasterThemeIntoOriginal(original, noEdit, edited, sourceTargets?.find(target=>target.op==="set_master_theme")??null)
      : null;
  const presentationPartsPatch = semanticMasterThemePatch
    ? null
    : mergePresentationParts(original, noEdit, edited);
  // A replacement may keep the converter's relationship XML and filename
  // while changing the referenced media bytes. Those relationships belong
  // to the authored edit too; retaining the original author's different
  // filename would reconnect the previous audio/image.
  const replacedMediaRelationships = new Set();
  for (const target of sourceTargets ?? []) {
    if (!sourceOperations.includes(target.op) || !["replace_media","replace_image"].includes(target.op)) continue;
    const slideIndex=Number(target.elementId?.split("/")[0]);
    const slidePart=orderedSlidePaths(original)[slideIndex],related=slidePart&&relationshipsPath(slidePart);
    if(!related||!noEdit[related]||!edited[related])continue;
    const relationships=relationshipElements(parseXml(edited,related));
    if(relationships.some(relationship=>{
      if(relationship.getAttribute("TargetMode")==="External")return false;
      const dependency=resolvePart(slidePart,relationship.getAttribute("Target"));
      return classifyNativePackagePart(dependency)==="media_parts"&&noEdit[dependency]&&edited[dependency]&&!samePartBytes(noEdit[dependency],edited[dependency]);
    }))replacedMediaRelationships.add(related);
  }
  const paths = new Set(
    topologyPatch
      ? []
      : [
          ...Object.keys(original),
          ...Object.keys(noEdit),
          ...Object.keys(edited),
          ...Object.keys(semanticMasterThemePatch ?? {}),
        ],
  );
  for (const part of [...paths].sort()) {
    // No current native command edits package core properties. Impress
    // updates modified time, lastModifiedBy and revision as a save side
    // effect, not as part of the requested slide/content mutation.
    const engineChanged = replacedMediaRelationships.has(part) || !sameEngineExportPart(
      part,
      noEdit[part],
      edited[part],
    );
    const withinBudget =
      budget.allowedCategories.has(classifyNativePackagePart(part)) &&
      (budget.allowPartCreationOrDeletion ||
        Boolean(original[part]) === Boolean(edited[part]));
    const existingSlideContentDuringTopology =
      topologyPaths !== null &&
      Boolean(original[part]) &&
      Boolean(edited[part]) &&
      /^ppt\/(?:slides|notesSlides|notesMasters|slideMasters|slideLayouts|theme)\//u.test(
        part,
      );
    // A command confined to named shapes leaves every other slide as authored.
    const untargetedSlide =
      targetNamesBySlide !== null &&
      /^ppt\/slides\/(?:_rels\/)?slide[^/]+\.xml(?:\.rels)?$/u.test(part) &&
      !targetNamesBySlide.has(part.replace(/_rels\/([^/]+)\.rels$/u, "$1"));
    const changedByEngine =
      !semanticMasterThemePatch &&
      part !== "docProps/core.xml" &&
      engineChanged &&
      withinBudget &&
      !untargetedSlide &&
      !existingSlideContentDuringTopology &&
      !(part.endsWith(".rels") && targetIndexesBySlide?.has(part.replace(/_rels\/([^/]+)\.rels$/u, "$1")));
    // The author's copy of an unchanged part is kept, but its .rels may be the
    // engine's renumbered copy by now (.rels sort before their part). Rebind
    // the kept part's r:* references to the same relationships; when one no
    // longer exists because the edit retargeted it, take the engine's copy of
    // the part, which matches the engine's .rels.
    const related = relationshipsPath(part);
    const staleAuthorReferences =
      !changedByEngine &&
      part.endsWith(".xml") &&
      Boolean(original[part]) &&
      Boolean(merged[related]) &&
      !samePartBytes(merged[related], original[related]) &&
      !referencedRelationshipsStillMatch(
        part,
        original[part],
        original[related],
        merged[related],
      );
    const reboundReferences = staleAuthorReferences
      ? remapPartRelationshipIds(
          part,
          original[part],
          merged[related],
          original[related],
        )
      : null;
    if (
      staleAuthorReferences &&
      !reboundReferences &&
      !(withinBudget && edited[part])
    )
      throw new Error(
        `Native snapshot cannot keep ${part} consistent with its relationships.`,
      );
    const authoredChange =
      changedByEngine || (staleAuthorReferences && !reboundReferences);
    const semanticSlideSizePatch =
      authoredChange &&
      part === presentationPath &&
      sourceOperations.length === 1 &&
      sourceOperations[0] === "set_slide_size";
    const semanticTableInsetPatch = authoredChange
      ? repairChangedTableCellInsets(
          part,
          original[part],
          noEdit[part],
          edited[part],
          sourceOperations,
        )
      : null;
    const semanticShapePatch = authoredChange
      ? directDeletionPart === part
        ? removeDirectShapeFromOriginal(
            part,
            original[part],
            noEdit[part],
            edited[part],
            [...targetIndexesBySlide.get(part)][0],
            sourceTargets[0].name,
          )
        : preserveUnaffectedSlideShapes(
            part,
            original[part],
            noEdit[part],
            semanticTableInsetPatch ?? edited[part],
            sourceOperations,
            targetNamesBySlide?.get(part) ?? null,
            targetIndexesBySlide?.get(part) ?? null,
            { part, entries: [original, noEdit, edited], targets: tableTopologyTargetsByPart.get(part) },
          )
      : null;
    if (targetIndexesBySlide?.has(part) && semanticShapePatch === null)
      throw new Error(
        `Native snapshot cannot isolate direct ${sourceOperations[0] === "replace_text" ? "text" : sourceOperations[0] === "delete_element" ? "deletion" : "move"} in ${part}.`,
      );
    const semanticExtendedPropertiesPatch =
      authoredChange &&
      part === "docProps/app.xml" &&
      original[part] &&
      noEdit[part] &&
      edited[part]
        ? mergeExtendedProperties(original[part], noEdit[part], edited[part])
        : null;
    const semanticWorkbookPatch = authoredChange && /^ppt\/embeddings\/[^/]+\.xlsx$/u.test(part)
      ? mergeNumericWorkbookDelta(original[part], noEdit[part], edited[part],workbookLabelIntents.get(part))
      : null;
    const authoredDirectShape = semanticShapePatch && targetIndexesBySlide?.has(part) &&
      sourceOperations.every(operation => directShapeIndexOperations.includes(operation));
    let relationshipRemap = null;
    const presentationPatch =
      presentationPartsPatch && Object.hasOwn(presentationPartsPatch, part);
    if (
      authoredChange &&
      part.endsWith(".xml") &&
      !part.endsWith(".rels") &&
      !semanticSlideSizePatch &&
      !presentationPatch &&
      // Scoped text/geometry/deletion builds XML in the authored ID space
      // and keeps its original .rels; no engine relationship IDs remain.
      !authoredDirectShape
    ) {
      if (
        !replacedMediaRelationships.has(related) &&
        samePartBytes(noEdit[related], edited[related]) &&
        !samePartBytes(original[related], noEdit[related]) &&
        !referencedRelationshipsStillMatch(
          part,
          edited[part],
          original[related],
          noEdit[related],
        )
      ) {
        relationshipRemap = remapPartRelationshipIds(
          part,
          semanticShapePatch ?? semanticTableInsetPatch ?? edited[part],
          original[related],
          noEdit[related],
          [original, edited],
        );
        if (!relationshipRemap)
          throw new Error(
            `Native snapshot needs relationship remapping before preserving ${part}.`,
          );
      }
    }
    const selected =
      semanticMasterThemePatch && Object.hasOwn(semanticMasterThemePatch, part)
        ? semanticMasterThemePatch[part]
        : presentationPartsPatch && Object.hasOwn(presentationPartsPatch, part)
          ? presentationPartsPatch[part]
          : authoredChange
            ? semanticSlideSizePatch
              ? mergeSlideSizeIntoOriginal(original, noEdit, edited)
              : part.endsWith(".rels")
                ? edited[part]
                  ? remapAuthoredRelationships(
                      part,
                      edited[part],
                      original,
                      noEdit,
                      sourceOperations,
                      humanEdit,
                      sourceTargets,
                      edited,
                    )
                  : undefined
                : (relationshipRemap ??
                  semanticShapePatch ??
                  semanticTableInsetPatch ??
                  semanticExtendedPropertiesPatch ??
                  semanticWorkbookPatch ??
                  edited[part])
            : (reboundReferences ?? original[part]);
    if (semanticSlideSizePatch) semanticPatchedParts.push(part);
    if (
      semanticShapePatch ||
      semanticTableInsetPatch ||
      (semanticExtendedPropertiesPatch &&
        semanticExtendedPropertiesPatch !== original[part]) ||
      relationshipRemap ||
      (reboundReferences && reboundReferences !== original[part])
    )
      semanticPatchedParts.push(part);
    if (
      (semanticMasterThemePatch &&
        Object.hasOwn(semanticMasterThemePatch, part)) ||
      (presentationPartsPatch && Object.hasOwn(presentationPartsPatch, part))
    )
      semanticPatchedParts.push(part);
    if (selected) merged[part] = selected;
    if (authoredChange && /^ppt\/slides\/slide[^/]+\.xml$/u.test(part))
      editedSlides.push(part);
    if (!authoredChange && !samePartBytes(original[part], noEdit[part]))
      suppressedNoopParts.push(part);
    if (engineChanged && !withinBudget) suppressedOutOfBudgetParts.push(part);
  }
  semanticPatchedParts.push(...connectChangedNewNotes(original, noEdit, edited, merged, sourceOperations, sourceTargets, humanEdit, budget));
  // These repairs depend on the complete merged package: a restored
  // transition sound needs its media part, and every kept part needs a
  // declared content type.
  for (const part of editedSlides) {
    const transition = mergeSlideTransition(part, original, noEdit, merged);
    if (!transition) continue;
    merged[part] = transition.slide;
    semanticPatchedParts.push(part);
    if (transition.relationships) {
      merged[relationshipsPath(part)] = transition.relationships;
      semanticPatchedParts.push(relationshipsPath(part));
    }
  }
  semanticPatchedParts.push(
    ...dropStaleDiagramDrawings(
      merged,
      edited,
      changedPackageParts(original, merged),
    ),
  );
  // A no-op Office export can add a master or layout that the later edit
  // references without changing that part's bytes. The three-way merge sees
  // no delta and would otherwise omit the newly required part.
  for (let iteration = 0; iteration < maximumEntries; iteration += 1) {
    const missing = [...reachableParts(merged)].filter((part) => !merged[part]);
    if (!missing.length) break;
    let restored = 0;
    for (const part of missing) {
      if (
        original[part] ||
        !noEdit[part] ||
        !edited[part] ||
        !sameEngineExportPart(part, noEdit[part], edited[part]) ||
        !budget.allowedCategories.has(classifyNativePackagePart(part))
      )
        continue;
      merged[part] = edited[part];
      semanticPatchedParts.push(part);
      restored += 1;
      if (part.endsWith(".xml")) {
        const related = relationshipsPath(part);
        if (
          !merged[related] &&
          noEdit[related] &&
          edited[related] &&
          sameEngineExportPart(related, noEdit[related], edited[related]) &&
          budget.allowedCategories.has(classifyNativePackagePart(related))
        ) {
          merged[related] = edited[related];
          semanticPatchedParts.push(related);
        }
      }
    }
    if (!restored) break;
  }
  const contentTypes = reconcileContentTypes(merged, original, edited);
  if (contentTypes) {
    merged[contentTypesPath] = contentTypes;
    semanticPatchedParts.push(contentTypesPath);
  }
  const changedParts = changedPackageParts(original, merged);
  assertChangedReferencesResolve(merged, changedParts);
  const bytes = zipSync(merged, {
    level: 6,
    mtime: deterministicZipModifiedAt,
  });
  if (bytes.byteLength > maximumInputBytes)
    throw new Error(
      "Preserved native snapshot exceeds the browser PPTX limit.",
    );
  for (const part of reachableParts(merged))
    if (!merged[part])
      throw new Error(
        `Preserved native snapshot has a missing dependency: ${part}.`,
      );
  inspectOoxmlDocument(bytes);
  return {
    bytes,
    report: {
      changedParts,
      semanticPatchedParts: [...new Set(semanticPatchedParts)],
      suppressedNoopParts,
      suppressedOutOfBudgetParts,
      // The shapes this merge let the engine's save change, so the caller can
      // check the saved file against what the author still owns elsewhere.
      authoredShapeScopes: shapeScopes
        ? [...shapeScopes].map(([slideIndex, names]) => [
            slideIndex,
            names ? [...names] : null,
          ])
        : null,
      topologyAligned: topologyPaths !== null,
      topologyImportedDesign: topologyImportedDesign.importedMaster ? topologyImportedDesign : null,
      topology: topology
        ? { kind: topology.kind, index: topology.index }
        : null,
      topologyExistingContentChanges: topology
        ? changedParts.filter(
            (part) =>
              original[part] &&
              merged[part] &&
              /^ppt\/(?:slides|notesSlides|notesMasters|slideMasters|slideLayouts|theme)\//u.test(
                part,
              ),
          )
        : null,
    },
  };
}

export function applyOoxmlCommand(input, command) {
  if (!(input instanceof Uint8Array))
    throw new TypeError("PPTX input must be a Uint8Array.");
  if (input.byteLength > maximumInputBytes)
    throw new Error("PPTX exceeds the browser mutation limit.");
  if (!browserOperations.has(command?.op))
    throw new Error(`Unsupported browser OOXML operation: ${command?.op}`);
  const context = openPackage(input, {
    requireSimpleTopology: topologyOperations.has(command.op),
  });
  const slideIdsBefore = topologyOperations.has(command.op)
    ? currentSlideIds(context).map((slide) => slide.getAttribute("id"))
    : null;
  const report =
    command.op === "set_sections"
      ? updateSections(context, command)
      : command.op === "add_slide" || command.op === "duplicate_slide"
        ? createSlide(context, command)
        : command.op === "delete_slide"
          ? deleteSlide(context, command)
          : command.op === "move_slide"
            ? moveSlide(context, command)
            : slideMetadataOperations.has(command.op)
              ? updateSlideMetadata(context, command)
              : updateElement(context, command);
  const bytes = zipSync(context.entries, {
    level: 6,
    mtime: deterministicZipModifiedAt,
  });
  if (slideIdsBefore) {
    report.slideIdsBefore = slideIdsBefore;
    report.slideIdsAfter = inspectOoxmlDocument(bytes).slideIds;
  }
  if (report.changedParts.length && elementOperations.has(command.op)) {
    verifyPersistedElementMutation(input, bytes, command);
    report.persistedSemanticVerified = true;
  }
  return { bytes, report };
}

export function verifyPersistedElementMutation(
  beforeBytes,
  afterBytes,
  command,
) {
  if (!elementOperations.has(command?.op))
    throw new Error(
      "The persisted element verifier received an invalid operation.",
    );
  const before = openPackage(beforeBytes, { requireSimpleTopology: false });
  const after = openPackage(afterBytes, { requireSimpleTopology: false });
  const beforeTarget = resolveElementShape(before, command.elementId);
  const beforeShape = beforeTarget.shape;
  const afterShape = resolveElementShape(after, command.elementId).shape;
  const unchanged = (expected, actual) => {
    if (expected !== actual)
      throw new Error(`browser_package_semantics_not_persisted:${command.op}`);
  };
  if (command.op === "replace_text") {
    unchanged(command.text.replace(/\r\n/gu, "\n"), readShapeText(afterShape));
    return;
  }
  if (geometryOperations.has(command.op)) {
    const beforeTransform = effectiveShapeTransform(
      before,
      beforeTarget.target.path,
      beforeShape,
    );
    const afterTransform = requiredShapeTransform(afterShape);
    if (command.op === "move") {
      for (const [attribute, requested, previous] of [
        ["x", command.x, command.expectedX],
        ["y", command.y, command.expectedY],
      ])
        unchanged(
          coordinateAttribute(
            requiredDirectElement(beforeTransform, drawingNamespace, "off"),
            attribute,
          ) +
            (requested - previous) * emuPerHundredthMillimeter,
          coordinateAttribute(
            requiredDirectElement(afterTransform, drawingNamespace, "off"),
            attribute,
          ),
        );
    } else if (command.op === "resize") {
      for (const [attribute, requested, previous] of [
        ["cx", command.width, command.expectedWidth],
        ["cy", command.height, command.expectedHeight],
      ])
        unchanged(
          coordinateAttribute(
            requiredDirectElement(beforeTransform, drawingNamespace, "ext"),
            attribute,
          ) +
            (requested - previous) * emuPerHundredthMillimeter,
          coordinateAttribute(
            requiredDirectElement(afterTransform, drawingNamespace, "ext"),
            attribute,
          ),
        );
    } else {
      const previous = beforeTransform.hasAttribute("rot")
        ? coordinateAttribute(beforeTransform, "rot")
        : 0;
      const saved = afterTransform.hasAttribute("rot")
        ? coordinateAttribute(afterTransform, "rot")
        : 0;
      unchanged(
        previous + (command.rotation - command.expectedRotation) * 600,
        saved,
      );
    }
    return;
  }
  const properties = requiredShapeProperties(afterShape);
  const line = () => requiredDirectElement(properties, drawingNamespace, "ln");
  const solidColor = (container) =>
    requiredDirectElement(
      requiredDirectElement(container, drawingNamespace, "solidFill"),
      drawingNamespace,
      "srgbClr",
    );
  const hexColor = (value) => value.toString(16).padStart(6, "0").toUpperCase();
  switch (command.op) {
    case "fill_color":
    case "line_color":
      unchanged(
        hexColor(command.color),
        solidColor(
          command.op === "fill_color" ? properties : line(),
        ).getAttribute("val"),
      );
      return;
    case "line_width":
      unchanged(
        String(command.width * emuPerHundredthMillimeter),
        line().getAttribute("w"),
      );
      return;
    case "fill_opacity":
    case "line_opacity": {
      const container = command.op === "fill_opacity" ? properties : line();
      const fill = requiredDirectElement(
        container,
        drawingNamespace,
        "solidFill",
      );
      unchanged(
        String(command.opacity * 1000),
        directColorTransform(fill, "alpha")?.getAttribute("val"),
      );
      return;
    }
    case "paragraph_alignment": {
      const value = { left: "l", center: "ctr", right: "r", justify: "just" }[
        command.alignment
      ];
      for (const paragraph of editableParagraphs(afterShape))
        unchanged(
          value,
          requiredDirectElement(
            paragraph,
            drawingNamespace,
            "pPr",
          ).getAttribute("algn"),
        );
      return;
    }
    default:
      break;
  }
  for (const property of existingRunProperties(afterShape)) {
    if (command.op === "font_size")
      unchanged(String(command.size), property.getAttribute("sz"));
    else if (command.op === "bold" || command.op === "italic")
      unchanged(
        command[command.op] ? "1" : "0",
        property.getAttribute(command.op === "bold" ? "b" : "i"),
      );
    else if (command.op === "underline")
      unchanged(command.underline ? "sng" : "none", property.getAttribute("u"));
    else if (command.op === "strikethrough")
      unchanged(
        command.strikethrough ? "sngStrike" : "noStrike",
        property.getAttribute("strike"),
      );
    else if (command.op === "font_family")
      for (const script of ["latin", "ea", "cs"])
        unchanged(
          fontFamily(command.family, "family"),
          requiredDirectElement(
            property,
            drawingNamespace,
            script,
          ).getAttribute("typeface"),
        );
    else if (command.op === "font_color")
      unchanged(
        hexColor(command.color),
        solidColor(property).getAttribute("val"),
      );
    else throw new Error(`No persisted verifier for ${command.op}.`);
  }
}

export function inspectOoxmlDocument(input) {
  if (!(input instanceof Uint8Array))
    throw new TypeError("PPTX input must be a Uint8Array.");
  if (input.byteLength > maximumInputBytes)
    throw new Error("PPTX exceeds the browser inspection limit.");
  const context = openPackage(input, { requireSimpleTopology: false });
  return packageObservation(context);
}

// Experimental candidate-output boundary. Production persistence does not
// invoke this function. Repair only proven structural defects, never infer
// missing content or drop unknown chart children. Independent validation and
// engine readback remain required after these repairs.
export function repairCandidatePptxStructure(originalInput, candidateInput) {
  for (const input of [originalInput, candidateInput]) {
    if (!(input instanceof Uint8Array) || input.byteLength > maximumInputBytes)
      throw new Error("Invalid PPTX structural repair input.");
    inspectZipPackage(input);
  }
  const original = unzipSync(originalInput);
  const entries = unzipSync(candidateInput);
  const repairs = [];
  const changedParts = new Set();
  const commit = (part, document, kind) => {
    entries[part] = serializeXml(document);
    changedParts.add(part);
    repairs.push({ part, kind });
  };
  // The pinned converter writes two nonstandard legacy comment MIME types.
  // Accept only those exact known values and their matching native XML root;
  // never reinterpret arbitrary parts or overwrite an authored content type.
  const commentTypes=parseXml(entries,contentTypesPath);
  let repairedCommentTypes=false;
  for(const node of [...commentTypes.documentElement.childNodes].filter(node=>node.nodeType===1&&node.localName==="Override")){
    const wrong=node.getAttribute("ContentType"),part=node.getAttribute("PartName").replace(/^\//,"");
    const expected=wrong==="application/vnd.openxmlformats-officedocument.presentationml.comment+xml"?
      {root:"cmLst",type:"comments"}:wrong==="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors.main+xml"?
      {root:"cmAuthorLst",type:"commentAuthors"}:null;
    if(!expected)continue;
    const document=parseXml(entries,part);
    if(document.documentElement.namespaceURI!==presentationNamespace||document.documentElement.localName!==expected.root)
      throw Error("Candidate comment content type does not match its native XML root.");
    node.setAttribute("ContentType","application/vnd.openxmlformats-officedocument.presentationml."+expected.type+"+xml");
    repairedCommentTypes=true;
  }
  if(repairedCommentTypes)commit(contentTypesPath,commentTypes,"legacy-comment-content-types");
  const relationships = (parts, part) =>
    relationshipElements(parseXml(parts, relationshipsPath(part))).filter(
      (element) => element.getAttribute("TargetMode") !== "External",
    );
  const themeTargets = (parts, part) =>
    relationships(parts, part)
      .filter(
        (element) =>
          element.getAttribute("Type") ===
          `${relationshipAttributeNamespace}/theme`,
      )
      .map((element) => resolvePart(part, element.getAttribute("Target")));
  const masterThemes = (parts) => {
    const masters = relationships(parts, presentationPath).filter(
      (element) =>
        element.getAttribute("Type") ===
        `${relationshipAttributeNamespace}/slideMaster`,
    );
    if (!masters.length)
      throw new Error("Presentation theme ownership is unavailable.");
    return new Set(
      masters.flatMap((element) => {
        const part = resolvePart(
          presentationPath,
          element.getAttribute("Target"),
        );
        const targets = themeTargets(parts, part);
        if (targets.length !== 1 || !parts[targets[0]])
          throw new Error("Slide master theme ownership is ambiguous.");
        return targets;
      }),
    );
  };
  const presentationRels = parseXml(entries, presentationRelationshipsPath);
  const themes = relationshipElements(presentationRels).filter(
    (element) =>
      element.getAttribute("Type") ===
      `${relationshipAttributeNamespace}/theme`,
  );
  if (themes.length > 1) {
    const originalThemes = themeTargets(original, presentationPath);
    const originalMasterThemes = masterThemes(original);
    const candidateMasterThemes = masterThemes(entries);
    if (
      originalThemes.length !== 1 ||
      originalMasterThemes.size !== 1 ||
      !originalMasterThemes.has(originalThemes[0]) ||
      candidateMasterThemes.size !== 1
    )
      throw new Error(
        "Cannot infer presentation default theme from ambiguous ownership.",
      );
    const owned = [...candidateMasterThemes][0];
    const retained = themes.filter(
      (element) =>
        element.getAttribute("TargetMode") !== "External" &&
        resolvePart(presentationPath, element.getAttribute("Target")) === owned,
    );
    if (retained.length !== 1)
      throw new Error("No unique presentation theme matches master ownership.");
    const presentation = parseXml(entries, presentationPath);
    for (const theme of themes) {
      if (theme === retained[0]) continue;
      const id = theme.getAttribute("Id");
      if (
        !id ||
        [...presentation.getElementsByTagName("*")].some((element) =>
          [...element.attributes].some(
            (attribute) =>
              attribute.namespaceURI === relationshipAttributeNamespace &&
              attribute.value === id,
          ),
        )
      )
        throw new Error(
          "An extra presentation theme has an explicit reference.",
        );
      if (
        theme.getAttribute("TargetMode") === "External" ||
        !entries[resolvePart(presentationPath, theme.getAttribute("Target"))]
      )
        throw new Error(
          "An extra presentation theme target is not an internal package part.",
        );
      theme.parentNode.removeChild(theme);
    }
    // Retain all theme files, master/layout relationships and declarations.
    commit(
      presentationRelationshipsPath,
      presentationRels,
      "presentation-theme-ownership",
    );
  }
  const types = parseXml(entries, contentTypesPath);
  let typesChanged = false;
  for (const element of types.getElementsByTagNameNS(
    contentTypeNamespace,
    "Override",
  )) {
    if (
      element.getAttribute("ContentType") !==
      "application/vnd.openxmlformats-officedocument.drawingml.diagramDrawing+xml"
    )
      continue;
    const part = decodeURIComponent(element.getAttribute("PartName")).replace(
      /^\//u,
      "",
    );
    const root = parseXml(entries, part).documentElement;
    if (
      root.namespaceURI !== diagramDrawingNamespace ||
      root.localName !== "drawing"
    )
      throw new Error(
        "Diagram drawing content type disagrees with its document root.",
      );
    element.setAttribute(
      "ContentType",
      "application/vnd.ms-office.drawingml.diagramDrawing+xml",
    );
    typesChanged = true;
  }
  if (typesChanged)
    commit(contentTypesPath, types, "diagram-drawing-content-type");
  // Graphic-frame transforms allow off/ext, not group chOff/chExt. Only
  // remove the redundant identity child-space mapping of SmartArt frames.
  // A non-identity mapping needs a native exporter fix, never guessed geometry.
  for (const part of Object.keys(entries).filter((part) =>
    /^ppt\/slides\/slide\d+\.xml$/u.test(part),
  )) {
    const document = parseXml(entries, part);
    let changed = false;
    for (const frame of document.getElementsByTagNameNS(
      presentationNamespace,
      "graphicFrame",
    )) {
      const transform = [...frame.childNodes].find(
        (node) =>
          node.nodeType === 1 &&
          node.namespaceURI === presentationNamespace &&
          node.localName === "xfrm",
      );
      if (!transform) continue;
      const children = [...transform.childNodes].filter(
        (node) => node.nodeType === 1,
      );
      const groupChildren = children.filter(
        (node) =>
          node.namespaceURI === drawingNamespace &&
          ["chOff", "chExt"].includes(node.localName),
      );
      if (!groupChildren.length) continue;
      const data = frame.getElementsByTagNameNS(
        drawingNamespace,
        "graphicData",
      );
      const one = (name) =>
        children.filter(
          (node) =>
            node.namespaceURI === drawingNamespace && node.localName === name,
        );
      const ext = one("ext"),
        off = one("off"),
        chOff = one("chOff"),
        chExt = one("chExt");
      const exactAttributes = (node, names) =>
        [...node.attributes].every(
          (attribute) =>
            attribute.namespaceURI === "http://www.w3.org/2000/xmlns/" ||
            (!attribute.namespaceURI && names.includes(attribute.localName)),
        ) &&
        ![...node.childNodes].some(
          (child) =>
            child.nodeType === 1 || (child.nodeType === 3 && child.data.trim()),
        );
      const integer = (node, name) =>
        /^-?\d+$/u.test(node.getAttribute(name))
          ? BigInt(node.getAttribute(name))
          : null;
      if (
        data.length !== 1 ||
        data[0].getAttribute("uri") !==
          "http://schemas.openxmlformats.org/drawingml/2006/diagram" ||
        children.length !== 4 ||
        ext.length !== 1 ||
        off.length !== 1 ||
        chOff.length !== 1 ||
        chExt.length !== 1 ||
        !exactAttributes(chOff[0], ["x", "y"]) ||
        !exactAttributes(chExt[0], ["cx", "cy"]) ||
        integer(chOff[0], "x") !== 0n ||
        integer(chOff[0], "y") !== 0n ||
        ["cx", "cy"].some(
          (name) =>
            integer(ext[0], name) === null ||
            integer(ext[0], name) <= 0n ||
            integer(ext[0], name) !== integer(chExt[0], name),
        )
      )
        throw new Error(
          "Cannot repair non-identity or unknown graphic-frame child transform.",
        );
      for (const child of groupChildren) transform.removeChild(child);
      changed = true;
    }
    if (changed)
      commit(part, document, "diagram-frame-identity-child-transform");
  }
  // Microsoft Open XML SDK schema particles, DataLabels / ChartStyle.
  const labels = [
    "dLbl",
    "delete",
    "numFmt",
    "spPr",
    "txPr",
    "dLblPos",
    "showLegendKey",
    "showVal",
    "showCatName",
    "showSerName",
    "showPercent",
    "showBubbleSize",
    "separator",
    "showLeaderLines",
    "leaderLines",
    "extLst",
  ];
  const style = [
    "axisTitle",
    "categoryAxis",
    "chartArea",
    "dataLabel",
    "dataLabelCallout",
    "dataPoint",
    "dataPoint3D",
    "dataPointLine",
    "dataPointMarker",
    "dataPointMarkerLayout",
    "dataPointWireframe",
    "dataTable",
    "downBar",
    "dropLine",
    "errorBar",
    "floor",
    "gridlineMajor",
    "gridlineMinor",
    "hiLoLine",
    "leaderLine",
    "legend",
    "plotArea",
    "plotArea3D",
    "seriesAxis",
    "seriesLine",
    "title",
    "trendline",
    "trendlineLabel",
    "upBar",
    "valueAxis",
    "wall",
    "extLst",
  ];
  const chartStyleNamespace =
    "http://schemas.microsoft.com/office/drawing/2012/chartStyle";
  const reorder = (parent, namespace, order) => {
    const children = [...parent.childNodes].filter(
      (node) => node.nodeType === 1,
    );
    for (const child of children)
      if (child.namespaceURI !== namespace || !order.includes(child.localName))
        throw new Error(
          `Unknown chart child in structural repair: ${child.nodeName}`,
        );
    const sorted = [...children].sort(
      (left, right) =>
        order.indexOf(left.localName) - order.indexOf(right.localName),
    );
    if (sorted.every((child, index) => child === children[index])) return false;
    // Replace only element slots; comments, whitespace, attributes and all
    // child contents survive. Stable sort preserves repeated dLbl order.
    const slots = children.map((child) => {
      const slot = parent.ownerDocument.createTextNode("");
      parent.replaceChild(slot, child);
      return slot;
    });
    slots.forEach((slot, index) => parent.replaceChild(sorted[index], slot));
    return true;
  };
  for (const part of Object.keys(entries).filter((part) =>
    /^ppt\/charts\/[^/]+\.xml$/u.test(part),
  )) {
    const document = parseXml(entries, part);
    let changed = false;
    for (const element of document.getElementsByTagNameNS(
      chartNamespace,
      "dLbls",
    ))
      changed = reorder(element, chartNamespace, labels) || changed;
    for (const element of document.getElementsByTagNameNS(
      chartStyleNamespace,
      "chartStyle",
    ))
      changed = reorder(element, chartStyleNamespace, style) || changed;
    if (changed) commit(part, document, "chart-schema-child-order");
  }
  let nestedExpanded = 0;
  for (const part of Object.keys(entries)) {
    if (!/^ppt\/embeddings\/[^/]+\.xlsx$/u.test(part) ||
        samePartBytes(original[part], entries[part])) continue;
    nestedExpanded += inspectZipPackage(entries[part]).expandedBytes;
    if (nestedExpanded > maximumInputBytes)
      throw new Error("Embedded workbook repair exceeds the browser memory limit.");
    const workbook = unzipSync(entries[part]);
    if (!workbook["docProps/app.xml"]) continue;
    const document = parseXml(workbook, "docProps/app.xml");
    if (document.documentElement.namespaceURI !== extendedPropertiesNamespace ||
        document.documentElement.localName !== "Properties") continue;
    let changed = false;
    for (const [name, baseType] of [["HeadingPairs", "variant"], ["TitlesOfParts", "lpstr"]]) {
      const property = optionalDirectXmlChild(document.documentElement, extendedPropertiesNamespace, name);
      if (!property) continue;
      const children = [...property.childNodes].filter(node => node.nodeType === 1);
      const vector = children[0];
      if (property.attributes.length || children.length !== 1 ||
          [...property.childNodes].some(node => node !== vector && (node.nodeType !== 3 || node.data.trim())) ||
          vector.namespaceURI !== "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" ||
          vector.localName !== "vector" || vector.attributes.length !== 2 ||
          vector.getAttribute("size") !== "0" || vector.getAttribute("baseType") !== baseType ||
          [...vector.childNodes].some(node => node.nodeType !== 3 || node.data.trim())) continue;
      property.parentNode.removeChild(property);
      changed = true;
    }
    if (changed) {
      workbook["docProps/app.xml"] = serializeXml(document);
      entries[part] = zipSync(workbook, { level: 6, mtime: deterministicZipModifiedAt });
      changedParts.add(part);
      repairs.push({ part, kind: "embedded-workbook-empty-property-vectors", nestedPart: "docProps/app.xml" });
    }
  }
  return {
    bytes: changedParts.size
      ? zipSync(entries, { level: 6, mtime: deterministicZipModifiedAt })
      : candidateInput,
    report: { changedParts: [...changedParts].sort(), repairs },
  };
}

function packageObservation(context) {
  return {
    sections: readSections(context),
    slideIds: currentSlideIds(context).map((slide) => slide.getAttribute("id")),
    slideNames: orderedSlidePaths(context.entries).map((part) => {
      const document = parseXml(context.entries, part);
      const slide = document.getElementsByTagNameNS(presentationNamespace, "cSld")[0];
      return slide?.getAttribute("name") || null;
    }),
  };
}

export async function inspectOoxmlDocumentWithAssets(input) {
  if (!(input instanceof Uint8Array) || input.byteLength > maximumInputBytes)
    throw new Error("Invalid PPTX inspection input.");
  const context = openPackage(input, { requireSimpleTopology: false });
  const partHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(context.entries)
        .map(async ([name, bytes]) => {
          const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes),
          );
          return [
            name,
            Array.from(digest, (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
          ];
        }),
    ),
  );
  const assetHashes = Object.fromEntries(
    Object.entries(partHashes).filter(([name]) => name.startsWith("ppt/media/")),
  );
  return {
    ...packageObservation(context),
    assetHashes,
    partHashes,
    slidePaths: orderedSlidePaths(context.entries),
  };
}

function openPackage(input, { requireSimpleTopology }) {
  inspectZipPackage(input);
  const entries = unzipSync(input);
  const entryNames = Object.keys(entries);
  if (entryNames.length > maximumEntries)
    throw new Error("PPTX contains too many package entries.");
  const expandedBytes = Object.values(entries).reduce(
    (total, bytes) => total + bytes.byteLength,
    0,
  );
  if (expandedBytes > maximumExpandedBytes)
    throw new Error("Expanded PPTX exceeds the browser mutation limit.");
  const presentation = parseXml(entries, presentationPath);
  const relationships = parseXml(entries, presentationRelationshipsPath);
  const contentTypes = parseXml(entries, contentTypesPath);
  if (presentation.documentElement.namespaceURI !== presentationNamespace)
    throw new Error(
      "Browser structural editing currently requires transitional PresentationML.",
    );
  if (
    requireSimpleTopology &&
    presentation.getElementsByTagNameNS(presentationNamespace, "custShowLst")
      .length > 0
  )
    throw new Error(
      "Slides in custom shows require an explicit structure migration.",
    );

  const slideIdList = requiredElement(
    presentation,
    presentationNamespace,
    "sldIdLst",
  );
  const slideIds = [...slideIdList.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === presentationNamespace &&
      node.localName === "sldId",
  );
  if (slideIds.length === 0) throw new Error("The PPTX has no template slide.");
  return {
    entries,
    presentation,
    relationships,
    contentTypes,
    slideIdList,
    slideIds,
  };
}

function currentSlideIds(context) {
  return [...context.slideIdList.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === presentationNamespace &&
      node.localName === "sldId",
  );
}

function sectionExtension(context) {
  const extensions = [
    ...context.presentation.getElementsByTagNameNS(
      presentationNamespace,
      "ext",
    ),
  ];
  return (
    extensions.find(
      (extension) =>
        extension.getAttribute("uri").toUpperCase() ===
        "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}",
    ) ?? null
  );
}

function sectionList(context) {
  const extension = sectionExtension(context);
  if (!extension) return null;
  return (
    [...extension.childNodes].find(
      (node) =>
        node.nodeType === 1 &&
        node.namespaceURI === powerpoint2010Namespace &&
        node.localName === "sectionLst",
    ) ?? null
  );
}

function readSections(context) {
  const list = sectionList(context);
  if (!list) return [];
  const slideIds = currentSlideIds(context);
  const slideIndexById = new Map(
    slideIds.map((element, index) => [element.getAttribute("id"), index]),
  );
  const sections = [...list.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === powerpoint2010Namespace &&
      node.localName === "section",
  );
  const seenSlideIds = new Set();
  let previousEnd = -1;
  return sections.map((section, sectionIndex) => {
    const id = section.getAttribute("id");
    const name = section.getAttribute("name");
    if (!validSectionId(id) || !validSectionName(name))
      throw new Error(`PPTX section ${sectionIndex} has invalid identity.`);
    const slideList = directElement(
      section,
      powerpoint2010Namespace,
      "sldIdLst",
    );
    if (!slideList)
      throw new Error(`PPTX section ${sectionIndex} has no slide list.`);
    const numericIds = [...slideList.childNodes]
      .filter(
        (node) =>
          node.nodeType === 1 &&
          node.namespaceURI === powerpoint2010Namespace &&
          node.localName === "sldId",
      )
      .map((node) => node.getAttribute("id"));
    if (!numericIds.length)
      throw new Error(`PPTX section ${sectionIndex} has no slides.`);
    const slideIndexes = numericIds.map((numericId) => {
      const slideIndex = slideIndexById.get(numericId);
      if (slideIndex === undefined || seenSlideIds.has(numericId))
        throw new Error(
          `PPTX section ${sectionIndex} has an invalid slide id.`,
        );
      seenSlideIds.add(numericId);
      return slideIndex;
    });
    if (
      slideIndexes.some(
        (slideIndex, index) =>
          index > 0 && slideIndex !== slideIndexes[index - 1] + 1,
      ) ||
      slideIndexes[0] <= previousEnd
    )
      throw new Error("PPTX sections must cover consecutive slide ranges.");
    previousEnd = slideIndexes.at(-1);
    return {
      id,
      name,
      startSlideIndex: slideIndexes[0],
      slideCount: slideIndexes.length,
    };
  });
}


function writeSections(context, sections) {
  const existingExtension = sectionExtension(context);
  if (existingExtension)
    existingExtension.parentNode.removeChild(existingExtension);
  if (!sections.length) {
    const extensionLists = [
      ...context.presentation.getElementsByTagNameNS(
        presentationNamespace,
        "extLst",
      ),
    ];
    for (const list of extensionLists)
      if (![...list.childNodes].some((node) => node.nodeType === 1))
        list.parentNode.removeChild(list);
    return;
  }
  const root = context.presentation.documentElement;
  let extensionList = directElement(root, presentationNamespace, "extLst");
  if (!extensionList) {
    extensionList = context.presentation.createElementNS(
      presentationNamespace,
      "p:extLst",
    );
    root.appendChild(extensionList);
  }
  const extension = context.presentation.createElementNS(
    presentationNamespace,
    "p:ext",
  );
  extension.setAttribute("uri", "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}");
  const list = context.presentation.createElementNS(
    powerpoint2010Namespace,
    "p14:sectionLst",
  );
  const slideIds = currentSlideIds(context);
  sections.forEach((section, index) => {
    const entry = context.presentation.createElementNS(
      powerpoint2010Namespace,
      "p14:section",
    );
    entry.setAttribute("name", section.name);
    entry.setAttribute("id", section.id);
    const slides = context.presentation.createElementNS(
      powerpoint2010Namespace,
      "p14:sldIdLst",
    );
    const end = sections[index + 1]?.startSlideIndex ?? slideIds.length;
    for (const slideId of slideIds.slice(section.startSlideIndex, end)) {
      const reference = context.presentation.createElementNS(
        powerpoint2010Namespace,
        "p14:sldId",
      );
      reference.setAttribute("id", slideId.getAttribute("id"));
      slides.appendChild(reference);
    }
    entry.appendChild(slides);
    list.appendChild(entry);
  });
  extension.appendChild(list);
  extensionList.appendChild(extension);
}

function updateSections(context, command) {
  const previous = readSections(context);
  const value = normalizedSections(command.sections, context.slideIds.length);
  if (
    JSON.stringify(
      previous.map(({ slideCount: _count, ...section }) => section),
    ) === JSON.stringify(value)
  )
    return {
      operation: command.op,
      slideCount: context.slideIds.length,
      previous,
      value: previous,
      changedParts: [],
    };
  writeSections(context, value);
  context.entries[presentationPath] = serializeXml(context.presentation);
  return {
    operation: command.op,
    slideCount: context.slideIds.length,
    previous,
    value: readSections(context),
    changedParts: [presentationPath],
  };
}

function updateSlideMetadata(context, command) {
  const slideIndex = integerInRange(
    command.slideIndex,
    0,
    context.slideIds.length - 1,
    "slideIndex",
  );
  const target = slideInfo(context, slideIndex);
  const slide = parseXml(context.entries, target.path);
  const changedParts = [];
  let previous;
  let value;

  if (command.op === "rename_slide") {
    value = validSlideName(command.name);
    const commonSlideData = requiredElement(
      slide,
      presentationNamespace,
      "cSld",
    );
    previous = commonSlideData.getAttribute("name") || "";
    if (previous !== value) {
      commonSlideData.setAttribute("name", value);
      context.entries[target.path] = serializeXml(slide);
      changedParts.push(target.path);
    }
  } else {
    if (typeof command.hidden !== "boolean")
      throw new TypeError("hidden must be a boolean.");
    previous = slideHidden(slide.documentElement);
    value = command.hidden;
    if (previous !== value) {
      if (value) slide.documentElement.setAttribute("show", "0");
      else slide.documentElement.removeAttribute("show");
      context.entries[target.path] = serializeXml(slide);
      changedParts.push(target.path);
    }
  }

  return {
    operation: command.op,
    slideIndex,
    slideCount: context.slideIds.length,
    previous,
    value,
    changedParts,
  };
}

function updateElement(context, command) {
  if (
    geometryOperations.has(command.op) &&
    /^\d+(?:\/\d+)+$/u.test(command.elementId) &&
    command.elementId.split("/").length !== 2
  )
    throw new Error(
      "Browser package geometry currently requires a top-level shape.",
    );
  const { slideIndex, target, slide, shape, path } = resolveElementShape(
    context,
    command.elementId,
  );
  if (geometryOperations.has(command.op) && path.length !== 1)
    throw new Error(
      "Browser package geometry currently requires a top-level shape.",
    );
  const mutation =
    command.op === "replace_text"
      ? replaceElementText(shape, command)
      : geometryOperations.has(command.op)
        ? updateElementGeometry(context, target.path, shape, path, command)
        : shapeAppearanceOperations.has(command.op)
          ? updateShapeAppearance(shape, command)
          : updateTextAppearance(shape, command);
  if (mutation.changed) context.entries[target.path] = serializeXml(slide);
  return {
    operation: command.op,
    elementId: command.elementId,
    slideIndex,
    slideCount: context.slideIds.length,
    previous: mutation.previous,
    value: mutation.value,
    changedParts: mutation.changed ? [target.path] : [],
  };
}

function resolveElementShape(context, elementId) {
  if (typeof elementId !== "string" || !/^\d+(?:\/\d+)+$/u.test(elementId))
    throw new Error("elementId must be a browser Office object path.");
  const path = elementId.split("/").map(Number);
  const slideIndex = integerInRange(
    path.shift(),
    0,
    context.slideIds.length - 1,
    "element slide index",
  );
  const target = slideInfo(context, slideIndex);
  const slide = parseXml(context.entries, target.path);
  const shapeTree = requiredElement(slide, presentationNamespace, "spTree");
  let container = shapeTree;
  let shape;
  for (const [depth, index] of path.entries()) {
    const shapes = directShapes(container);
    shape =
      shapes[
        integerInRange(index, 0, shapes.length - 1, `element path ${depth}`)
      ];
    container = shape;
  }
  return { slideIndex, target, slide, shape, path };
}

function replaceElementText(shape, command) {
  if (
    typeof command.expectedText !== "string" ||
    typeof command.text !== "string"
  )
    throw new TypeError("replace_text requires expectedText and text strings.");
  const previous = readShapeText(shape);
  if (previous !== command.expectedText)
    throw new Error("The browser package text changed after observation.");
  if (previous !== command.text) replaceShapeText(shape, command.text);
  return {
    previous,
    value: command.text,
    changed: previous !== command.text,
  };
}

function updateElementGeometry(context, slidePath, shape, path, command) {
  if (path.length !== 1) throw new Error("Invalid top-level shape path.");
  const transform = ownShapeTransform(context, slidePath, shape);
  if (command.op === "move") {
    const offset = requiredDirectElement(transform, drawingNamespace, "off");
    const expectedX = safeInteger(command.expectedX, "expectedX");
    const expectedY = safeInteger(command.expectedY, "expectedY");
    const x = safeInteger(command.x, "x");
    const y = safeInteger(command.y, "y");
    const previous = { x: expectedX, y: expectedY };
    const value = { x, y };
    if (expectedX !== x)
      offset.setAttribute(
        "x",
        String(
          coordinateAttribute(offset, "x") +
            (x - expectedX) * emuPerHundredthMillimeter,
        ),
      );
    if (expectedY !== y)
      offset.setAttribute(
        "y",
        String(
          coordinateAttribute(offset, "y") +
            (y - expectedY) * emuPerHundredthMillimeter,
        ),
      );
    return {
      previous,
      value,
      changed: expectedX !== x || expectedY !== y,
    };
  }
  if (command.op === "resize") {
    const extent = requiredDirectElement(transform, drawingNamespace, "ext");
    const expectedWidth = positiveInteger(
      command.expectedWidth,
      "expectedWidth",
    );
    const expectedHeight = positiveInteger(
      command.expectedHeight,
      "expectedHeight",
    );
    const width = positiveInteger(command.width, "width");
    const height = positiveInteger(command.height, "height");
    const nextWidth =
      coordinateAttribute(extent, "cx") +
      (width - expectedWidth) * emuPerHundredthMillimeter;
    const nextHeight =
      coordinateAttribute(extent, "cy") +
      (height - expectedHeight) * emuPerHundredthMillimeter;
    if (nextWidth <= 0 || nextHeight <= 0)
      throw new Error("Browser package resize produced an invalid extent.");
    if (expectedWidth !== width) extent.setAttribute("cx", String(nextWidth));
    if (expectedHeight !== height)
      extent.setAttribute("cy", String(nextHeight));
    return {
      previous: { width: expectedWidth, height: expectedHeight },
      value: { width, height },
      changed: expectedWidth !== width || expectedHeight !== height,
    };
  }
  if (command.op === "rotate") {
    const expectedRotation = safeInteger(
      command.expectedRotation,
      "expectedRotation",
    );
    const rotation = safeInteger(command.rotation, "rotation");
    const current = transform.hasAttribute("rot")
      ? coordinateAttribute(transform, "rot")
      : 0;
    const next = current + (rotation - expectedRotation) * 600;
    if (!Number.isSafeInteger(next))
      throw new Error("Browser package rotation exceeds the OOXML range.");
    if (rotation !== expectedRotation)
      transform.setAttribute("rot", String(next));
    return {
      previous: expectedRotation,
      value: rotation,
      changed: rotation !== expectedRotation,
    };
  }
  throw new Error(`Unsupported browser element operation: ${command.op}`);
}

function updateShapeAppearance(shape, command) {
  const properties = requiredShapeProperties(shape);
  if (command.op === "fill_color" || command.op === "line_color") {
    const expectedColor = observedColorInteger(
      command.expectedColor,
      "expectedColor",
    );
    const color = colorInteger(command.color, "color");
    // A fill or line that is not drawn becomes a solid one in the new colour,
    // even when its hidden colour already matches.
    if (
      command.expectedSolid !== undefined &&
      typeof command.expectedSolid !== "boolean"
    )
      throw new Error("Browser color command is invalid.");
    const changed = expectedColor !== color || command.expectedSolid === false;
    if (changed) {
      const container =
        command.op === "fill_color" ? properties : ensureShapeLine(properties);
      setSolidColor(container, color, {
        laterNames:
          command.op === "fill_color"
            ? ["ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst"]
            : [
                "prstDash",
                "custDash",
                "round",
                "bevel",
                "miter",
                "headEnd",
                "tailEnd",
                "extLst",
              ],
      });
    }
    return {
      previous: expectedColor,
      value: color,
      changed,
    };
  }
  if (command.op === "line_width") {
    const expectedWidth = nonnegativeInteger(
      command.expectedWidth,
      "expectedWidth",
    );
    const width = nonnegativeInteger(command.width, "width");
    if (expectedWidth !== width)
      ensureShapeLine(properties).setAttribute(
        "w",
        String(width * emuPerHundredthMillimeter),
      );
    return {
      previous: expectedWidth,
      value: width,
      changed: expectedWidth !== width,
    };
  }
  if (command.op === "fill_opacity" || command.op === "line_opacity") {
    const expectedOpacity = percentageInteger(
      command.expectedOpacity,
      "expectedOpacity",
    );
    const opacity = percentageInteger(command.opacity, "opacity");
    if (expectedOpacity !== opacity) {
      const fallbackColor = colorInteger(
        command.expectedColor,
        "expectedColor",
      );
      const container =
        command.op === "fill_opacity"
          ? properties
          : ensureShapeLine(properties);
      setSolidOpacity(container, opacity, fallbackColor, {
        laterNames:
          command.op === "fill_opacity"
            ? ["ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst"]
            : [
                "prstDash",
                "custDash",
                "round",
                "bevel",
                "miter",
                "headEnd",
                "tailEnd",
                "extLst",
              ],
      });
    }
    return {
      previous: expectedOpacity,
      value: opacity,
      changed: expectedOpacity !== opacity,
    };
  }
  throw new Error(`Unsupported browser shape operation: ${command.op}`);
}

function updateTextAppearance(shape, command) {
  if (command.explicitScriptFormatting !== undefined && typeof command.explicitScriptFormatting !== "boolean")
    throw new TypeError("explicitScriptFormatting must be boolean.");
  const explicitScripts = command.explicitScriptFormatting === true;
  if (command.op === "paragraph_alignment") {
    const expectedAlignment = paragraphAlignment(
      command.expectedAlignment,
      "expectedAlignment",
    );
    const alignment = paragraphAlignment(command.alignment, "alignment");
    if (expectedAlignment !== alignment)
      for (const paragraph of editableParagraphs(shape))
        ensureParagraphProperties(paragraph).setAttribute(
          "algn",
          {
            left: "l",
            center: "ctr",
            right: "r",
            justify: "just",
          }[alignment],
        );
    return {
      previous: expectedAlignment,
      value: alignment,
      changed: expectedAlignment !== alignment,
    };
  }

  const properties = editableRunProperties(shape);
  if (command.op === "font_size") {
    const expectedSize = positiveInteger(command.expectedSize, "expectedSize");
    const size = positiveInteger(command.size, "size");
    if (size < 100 || size > 40_000)
      throw new RangeError("size must be between 100 and 40000.");
    if (expectedSize !== size || explicitScripts)
      for (const property of properties)
        property.setAttribute("sz", String(size));
    return {
      previous: expectedSize,
      value: size,
      changed: expectedSize !== size || explicitScripts,
    };
  }
  if (command.op === "bold" || command.op === "italic") {
    const field = command.op === "bold" ? "bold" : "italic";
    const attribute = command.op === "bold" ? "b" : "i";
    if (
      typeof command[`expected${field[0].toUpperCase()}${field.slice(1)}`] !==
        "boolean" ||
      typeof command[field] !== "boolean"
    )
      throw new TypeError(`${field} values must be boolean.`);
    const previous =
      command[`expected${field[0].toUpperCase()}${field.slice(1)}`];
    const value = command[field];
    if (previous !== value || explicitScripts)
      for (const property of properties)
        property.setAttribute(attribute, value ? "1" : "0");
    return { previous, value, changed: previous !== value || explicitScripts };
  }
  if (command.op === "underline" || command.op === "strikethrough") {
    const field = command.op === "underline" ? "underline" : "strikethrough";
    const expectedField =
      command.op === "underline"
        ? "expectedUnderline"
        : "expectedStrikethrough";
    if (
      typeof command[expectedField] !== "boolean" ||
      typeof command[field] !== "boolean"
    )
      throw new TypeError(`${field} values must be boolean.`);
    const previous = command[expectedField];
    const value = command[field];
    if (previous !== value)
      for (const property of properties)
        property.setAttribute(
          command.op === "underline" ? "u" : "strike",
          command.op === "underline"
            ? value
              ? "sng"
              : "none"
            : value
              ? "sngStrike"
              : "noStrike",
        );
    return { previous, value, changed: previous !== value };
  }
  if (command.op === "font_family") {
    const previous = fontFamily(command.expectedFamily, "expectedFamily");
    const value = fontFamily(command.family, "family");
    if (previous !== value || explicitScripts)
      for (const property of properties)
        for (const name of ["latin", "ea", "cs"])
          ensureDirectDrawingElement(property, name).setAttribute(
            "typeface",
            value,
          );
    return { previous, value, changed: previous !== value || explicitScripts };
  }
  if (command.op === "font_color") {
    const previous = observedColorInteger(
      command.expectedColor,
      "expectedColor",
    );
    const value = colorInteger(command.color, "color");
    if (previous !== value)
      for (const property of properties)
        setSolidColor(property, value, {
          laterNames: [
            "highlight",
            "uLnTx",
            "uLn",
            "uFillTx",
            "uFill",
            "latin",
            "ea",
            "cs",
            "sym",
            "hlinkClick",
            "hlinkMouseOver",
            "rtl",
            "extLst",
          ],
        });
    return { previous, value, changed: previous !== value };
  }
  throw new Error(`Unsupported browser text operation: ${command.op}`);
}

function editableParagraphs(shape) {
  const paragraphs = [...shape.getElementsByTagNameNS(drawingNamespace, "p")];
  if (!paragraphs.length)
    throw new Error("The browser package target has no editable paragraphs.");
  return paragraphs;
}

function editableRunProperties(shape) {
  const properties = [];
  for (const paragraph of editableParagraphs(shape))
    for (const name of ["r", "fld"])
      for (const run of [
        ...paragraph.getElementsByTagNameNS(drawingNamespace, name),
      ]) {
        let property = directElement(run, drawingNamespace, "rPr");
        if (!property) {
          property = run.ownerDocument.createElementNS(
            drawingNamespace,
            "a:rPr",
          );
          run.insertBefore(property, run.firstChild);
        }
        properties.push(property);
      }
  if (!properties.length)
    throw new Error("The browser package target has no editable text runs.");
  return properties;
}

function existingRunProperties(shape) {
  const properties = [];
  for (const paragraph of editableParagraphs(shape))
    for (const name of ["r", "fld"])
      for (const run of [
        ...paragraph.getElementsByTagNameNS(drawingNamespace, name),
      ])
        properties.push(requiredDirectElement(run, drawingNamespace, "rPr"));
  if (!properties.length)
    throw new Error("The saved browser package has no editable text runs.");
  return properties;
}

function ensureParagraphProperties(paragraph) {
  let properties = directElement(paragraph, drawingNamespace, "pPr");
  if (properties) return properties;
  properties = paragraph.ownerDocument.createElementNS(
    drawingNamespace,
    "a:pPr",
  );
  paragraph.insertBefore(properties, paragraph.firstChild);
  return properties;
}

function ensureDirectDrawingElement(parent, name) {
  let element = directElement(parent, drawingNamespace, name);
  if (element) return element;
  element = parent.ownerDocument.createElementNS(drawingNamespace, `a:${name}`);
  const order = [
    "ln",
    "noFill",
    "solidFill",
    "gradFill",
    "blipFill",
    "pattFill",
    "grpFill",
    "effectLst",
    "effectDag",
    "highlight",
    "uLnTx",
    "uLn",
    "uFillTx",
    "uFill",
    "latin",
    "ea",
    "cs",
    "sym",
    "hlinkClick",
    "hlinkMouseOver",
    "rtl",
    "extLst",
  ];
  const position = order.indexOf(name);
  const anchor = [...parent.childNodes].find(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === drawingNamespace &&
      order.indexOf(node.localName) > position,
  );
  if (anchor) parent.insertBefore(element, anchor);
  else parent.appendChild(element);
  return element;
}

function requiredShapeProperties(shape) {
  if (shape.localName === "graphicFrame")
    throw new Error("The browser package target has no shape appearance.");
  const propertiesName = shape.localName === "grpSp" ? "grpSpPr" : "spPr";
  return requiredDirectElement(shape, presentationNamespace, propertiesName);
}

function ensureShapeLine(properties) {
  let line = directElement(properties, drawingNamespace, "ln");
  if (line) return line;
  line = properties.ownerDocument.createElementNS(drawingNamespace, "a:ln");
  insertBeforeDrawingChildren(properties, line, [
    "effectLst",
    "effectDag",
    "scene3d",
    "sp3d",
    "extLst",
  ]);
  return line;
}

function setSolidColor(container, color, { laterNames }) {
  const existingFill = directDrawingFill(container);
  const previousAlpha = existingFill
    ? (directColorTransform(existingFill, "alpha")?.getAttribute("val") ?? null)
    : null;
  const solidFill = container.ownerDocument.createElementNS(
    drawingNamespace,
    "a:solidFill",
  );
  const colorElement = container.ownerDocument.createElementNS(
    drawingNamespace,
    "a:srgbClr",
  );
  colorElement.setAttribute(
    "val",
    color.toString(16).padStart(6, "0").toUpperCase(),
  );
  if (previousAlpha !== null) {
    const alpha = container.ownerDocument.createElementNS(
      drawingNamespace,
      "a:alpha",
    );
    alpha.setAttribute("val", previousAlpha);
    colorElement.appendChild(alpha);
  }
  solidFill.appendChild(colorElement);
  if (existingFill) container.replaceChild(solidFill, existingFill);
  else insertBeforeDrawingChildren(container, solidFill, laterNames);
  return solidFill;
}

function setSolidOpacity(container, opacity, fallbackColor, { laterNames }) {
  let solidFill = directElement(container, drawingNamespace, "solidFill");
  const otherFill = directDrawingFill(container);
  if (!solidFill && otherFill)
    throw new Error(
      "Browser package opacity currently requires a solid or inherited fill.",
    );
  if (!solidFill)
    solidFill = setSolidColor(container, fallbackColor, { laterNames });
  let color = [...solidFill.childNodes].find(
    (node) => node.nodeType === 1 && node.namespaceURI === drawingNamespace,
  );
  if (!color) {
    color = container.ownerDocument.createElementNS(
      drawingNamespace,
      "a:srgbClr",
    );
    color.setAttribute(
      "val",
      fallbackColor.toString(16).padStart(6, "0").toUpperCase(),
    );
    solidFill.appendChild(color);
  }
  const current = directElement(color, drawingNamespace, "alpha");
  const alpha =
    current ??
    container.ownerDocument.createElementNS(drawingNamespace, "a:alpha");
  alpha.setAttribute("val", String(opacity * 1000));
  if (!current) color.appendChild(alpha);
}

function directDrawingFill(container) {
  const names = new Set([
    "noFill",
    "solidFill",
    "gradFill",
    "blipFill",
    "pattFill",
    "grpFill",
  ]);
  return [...container.childNodes].find(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === drawingNamespace &&
      names.has(node.localName),
  );
}

function directColorTransform(fill, name) {
  const color = [...fill.childNodes].find(
    (node) => node.nodeType === 1 && node.namespaceURI === drawingNamespace,
  );
  return color ? directElement(color, drawingNamespace, name) : null;
}

function insertBeforeDrawingChildren(parent, child, laterNames) {
  const later = new Set(laterNames);
  const anchor = [...parent.childNodes].find(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === drawingNamespace &&
      later.has(node.localName),
  );
  if (anchor) parent.insertBefore(child, anchor);
  else parent.appendChild(child);
}

// A placeholder without its own a:xfrm takes its position and size from the
// matching placeholder of its layout, and a layout placeholder without one
// from its master.
function effectiveShapeTransform(context, slidePath, shape) {
  const own =
    shape.localName === "graphicFrame" ||
    directElement(requiredShapeProperties(shape), drawingNamespace, "xfrm");
  const placeholder = own ? null : shapePlaceholder(shape);
  if (!placeholder) return requiredShapeTransform(shape);
  const layoutPath = singleRelationshipTarget(
    context.entries,
    slidePath,
    "slideLayout",
  );
  const masterPath = singleRelationshipTarget(
    context.entries,
    layoutPath,
    "slideMaster",
  );
  const layoutMatch = matchingPlaceholder(
    parseXml(context.entries, layoutPath),
    placeholder,
    false,
  );
  return (
    placeholderTransform(layoutMatch) ??
    placeholderTransform(
      matchingPlaceholder(
        parseXml(context.entries, masterPath),
        layoutMatch ? shapePlaceholder(layoutMatch) : placeholder,
        true,
      ),
    ) ??
    requiredShapeTransform(shape)
  );
}

// Moving or resizing a placeholder writes its inherited transform onto the
// slide first, the way PowerPoint does, so only the edited value changes.
function ownShapeTransform(context, slidePath, shape) {
  const transform = effectiveShapeTransform(context, slidePath, shape);
  if (transform.ownerDocument === shape.ownerDocument) return transform;
  const properties = requiredShapeProperties(shape);
  const copy = importOoxmlSubtree(shape.ownerDocument, transform, true);
  properties.insertBefore(copy, properties.firstChild);
  return copy;
}

function shapePlaceholder(shape) {
  const nonVisual = [...shape.childNodes].find(
    (node) => node.nodeType === 1 && node.localName.startsWith("nv"),
  );
  const properties =
    nonVisual && directElement(nonVisual, presentationNamespace, "nvPr");
  const placeholder =
    properties && directElement(properties, presentationNamespace, "ph");
  return placeholder
    ? {
        type: placeholder.getAttribute("type") || "obj",
        idx: placeholder.getAttribute("idx") || "0",
      }
    : null;
}

const masterPlaceholderType = (type) =>
  ["title", "ctrTitle"].includes(type)
    ? "title"
    : ["dt", "ftr", "sldNum"].includes(type)
      ? type
      : "body";

// A slide placeholder matches its layout placeholder by idx, and by type
// when no idx matches; a layout placeholder matches its master by type.
function matchingPlaceholder(document, placeholder, byTypeOnly) {
  const tree = document.getElementsByTagNameNS(
    presentationNamespace,
    "spTree",
  )[0];
  if (!tree) return null;
  const candidates = directShapes(tree)
    .map((node) => ({ node, placeholder: shapePlaceholder(node) }))
    .filter((candidate) => candidate.placeholder);
  const unique = (matches) => (matches.length === 1 ? matches[0].node : null);
  if (byTypeOnly)
    return unique(
      candidates.filter(
        (candidate) =>
          masterPlaceholderType(candidate.placeholder.type) ===
          masterPlaceholderType(placeholder.type),
      ),
    );
  return (
    unique(
      candidates.filter(
        (candidate) => candidate.placeholder.idx === placeholder.idx,
      ),
    ) ??
    unique(
      candidates.filter(
        (candidate) => candidate.placeholder.type === placeholder.type,
      ),
    )
  );
}

function placeholderTransform(shape) {
  if (!shape || shape.localName === "graphicFrame") return null;
  const properties = directElement(
    shape,
    presentationNamespace,
    shape.localName === "grpSp" ? "grpSpPr" : "spPr",
  );
  const transform =
    properties && directElement(properties, drawingNamespace, "xfrm");
  return transform &&
    directElement(transform, drawingNamespace, "off") &&
    directElement(transform, drawingNamespace, "ext")
    ? transform
    : null;
}

function requiredShapeTransform(shape) {
  if (shape.localName === "graphicFrame")
    return requiredDirectElement(shape, presentationNamespace, "xfrm");
  const properties = requiredShapeProperties(shape);
  return requiredDirectElement(properties, drawingNamespace, "xfrm");
}

function directElement(parent, namespace, name) {
  return [...parent.childNodes].find(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === namespace &&
      node.localName === name,
  );
}

function requiredDirectElement(parent, namespace, name) {
  const element = directElement(parent, namespace, name);
  if (!element) throw new Error(`Required OOXML element is missing: ${name}`);
  return element;
}

function coordinateAttribute(element, name) {
  const value = Number(element.getAttribute(name));
  if (!Number.isSafeInteger(value))
    throw new Error(`OOXML coordinate is invalid: ${name}`);
  return value;
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value))
    throw new TypeError(`${name} must be a safe integer.`);
  return value;
}

function positiveInteger(value, name) {
  const integer = safeInteger(value, name);
  if (integer <= 0) throw new RangeError(`${name} must be greater than zero.`);
  return integer;
}

function nonnegativeInteger(value, name) {
  const integer = safeInteger(value, name);
  if (integer < 0) throw new RangeError(`${name} must not be negative.`);
  return integer;
}

function colorInteger(value, name) {
  const integer = nonnegativeInteger(value, name);
  if (integer > 0xffffff)
    throw new RangeError(`${name} must be an RGB color integer.`);
  return integer;
}

function observedColorInteger(value, name) {
  if (value === -1) return value;
  return colorInteger(value, name);
}

function percentageInteger(value, name) {
  const integer = nonnegativeInteger(value, name);
  if (integer > 100) throw new RangeError(`${name} must be between 0 and 100.`);
  return integer;
}

function paragraphAlignment(value, name) {
  if (!["left", "center", "right", "justify"].includes(value))
    throw new TypeError(`${name} must be left, center, right, or justify.`);
  return value;
}

function fontFamily(value, name) {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string.`);
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  )
    throw new RangeError(`${name} is not a valid font family.`);
  return trimmed;
}

function directShapes(container) {
  const names = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);
  return [...container.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === presentationNamespace &&
      names.has(node.localName),
  );
}

function readShapeText(shape) {
  const paragraphs = [...shape.getElementsByTagNameNS(drawingNamespace, "p")];
  if (!paragraphs.length)
    throw new Error("The browser package target has no editable text.");
  return paragraphs.map(readParagraphText).join("\n");
}

function readParagraphText(paragraph) {
  let value = "";
  for (const child of [...paragraph.childNodes]) {
    if (child.nodeType !== 1 || child.namespaceURI !== drawingNamespace)
      continue;
    if (child.localName === "br") value += "\v";
    else if (child.localName === "r" || child.localName === "fld") {
      const text = child.getElementsByTagNameNS(drawingNamespace, "t")[0];
      if (text) value += text.textContent ?? "";
    }
  }
  return value;
}

// A whole native text replacement owns paragraph topology. Preserve the
// author's first paragraph and first run style rather than importing the
// engine's rewritten text body, inherited defaults and unrelated properties.
function replaceNativeShapeText(shape, value) {
  const paragraphs = [...shape.getElementsByTagNameNS(drawingNamespace, "p")];
  const lines = value.replace(/\r\n/gu, "\n").split("\n");
  if (paragraphs.length === lines.length) return replaceShapeText(shape, value);
  if (!paragraphs.length ||
      shape.getElementsByTagNameNS(drawingNamespace, "fld").length)
    throw new Error("Native text replacement requires plain editable paragraphs.");
  const first = paragraphs[0];
  const parent = first.parentNode;
  if (paragraphs.some(p => p.parentNode !== parent))
    throw new Error("Native text replacement has ambiguous paragraph ownership.");
  const template = first.cloneNode(true);
  let retainedRun = false;
  for (const child of [...template.childNodes]) {
    if (child.nodeType !== 1 || child.namespaceURI !== drawingNamespace) continue;
    if (child.localName === "r") {
      if (!retainedRun) { retainedRun = true; continue; }
      template.removeChild(child);
    } else if (child.localName === "br") template.removeChild(child);
  }
  for (const line of lines) {
    const paragraph = template.cloneNode(true);
    replaceParagraphText(paragraph, line);
    parent.insertBefore(paragraph, first);
  }
  for (const paragraph of paragraphs) parent.removeChild(paragraph);
}

function replaceShapeText(shape, value) {
  const paragraphs = [...shape.getElementsByTagNameNS(drawingNamespace, "p")];
  const replacements = value.replace(/\r\n/gu, "\n").split("\n");
  if (replacements.length !== paragraphs.length)
    throw new Error(
      "Browser package reconciliation cannot change paragraph count yet.",
    );
  for (let index = 0; index < paragraphs.length; index += 1)
    replaceParagraphText(paragraphs[index], replacements[index]);
}

function replaceParagraphText(paragraph, value) {
  if (value.includes("\v"))
    throw new Error(
      "Browser package reconciliation cannot change line-break structure yet.",
    );
  const fields = [...paragraph.getElementsByTagNameNS(drawingNamespace, "fld")];
  if (fields.length)
    throw new Error("Replacing dynamic fields as plain text is not supported.");
  const textNodes = [
    ...paragraph.getElementsByTagNameNS(drawingNamespace, "t"),
  ];
  if (!textNodes.length) {
    if (!value) return;
    const document = paragraph.ownerDocument;
    const run = document.createElementNS(drawingNamespace, "a:r");
    const endProperties = optionalDirectXmlChild(
      paragraph,
      drawingNamespace,
      "endParaRPr",
    );
    if (endProperties) {
      const runProperties = document.createElementNS(drawingNamespace, "a:rPr");
      for (let index = 0; index < endProperties.attributes.length; index += 1) {
        const attribute = endProperties.attributes.item(index);
        runProperties.setAttributeNS(
          attribute.namespaceURI,
          attribute.name,
          attribute.value,
        );
      }
      for (const child of [...endProperties.childNodes])
        runProperties.appendChild(child.cloneNode(true));
      run.appendChild(runProperties);
    }
    const text = document.createElementNS(drawingNamespace, "a:t");
    text.textContent = value;
    if (/^\s|\s$/u.test(value))
      text.setAttributeNS(
        "http://www.w3.org/XML/1998/namespace",
        "xml:space",
        "preserve",
      );
    run.appendChild(text);
    paragraph.insertBefore(run, endProperties);
    return;
  }
  const original = textNodes.map((node) => node.textContent ?? "").join("");
  if (original === value) return;
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < value.length &&
    original[prefix] === value[prefix]
  )
    prefix += 1;
  if (
    prefix > 0 &&
    prefix < original.length &&
    isLowSurrogate(original, prefix)
  )
    prefix -= 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < value.length - prefix &&
    original[original.length - suffix - 1] === value[value.length - suffix - 1]
  )
    suffix += 1;
  if (suffix > 0 && isLowSurrogate(original, original.length - suffix))
    suffix -= 1;
  const end = original.length - suffix;
  const inserted = value.slice(prefix, value.length - suffix);
  let offset = 0;
  let insertedOnce = false;
  for (const [index, node] of textNodes.entries()) {
    const text = node.textContent ?? "";
    const runEnd = offset + text.length;
    const before = text.slice(
      0,
      Math.max(0, Math.min(text.length, prefix - offset)),
    );
    const after = text.slice(Math.max(0, Math.min(text.length, end - offset)));
    const anchor =
      !insertedOnce && (prefix < runEnd || index === textNodes.length - 1);
    const replacement = before + (anchor ? inserted : "") + after;
    if (anchor) insertedOnce = true;
    node.textContent = replacement;
    if (/^\s|\s$/u.test(replacement))
      node.setAttributeNS(
        "http://www.w3.org/XML/1998/namespace",
        "xml:space",
        "preserve",
      );
    else
      node.removeAttributeNS("http://www.w3.org/XML/1998/namespace", "space");
    offset = runEnd;
  }
}

function isLowSurrogate(value, index) {
  const code = value.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function validSlideName(value) {
  if (typeof value !== "string") throw new TypeError("name must be a string.");
  const codePoints = [...value];
  if (codePoints.length === 0 || codePoints.length > 255)
    throw new Error("name must contain from 1 to 255 characters.");
  if (/[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("name contains an unsupported control character.");
  return value;
}

function slideHidden(slideRoot) {
  if (!slideRoot.hasAttribute("show")) return false;
  return ["0", "false", "off", "no"].includes(
    slideRoot.getAttribute("show").trim().toLowerCase(),
  );
}

function createSlide(context, command) {
  const {
    entries,
    presentation,
    relationships,
    contentTypes,
    slideIdList,
    slideIds,
  } = context;
  const sectionsBefore = readSections(context);
  if (slideIds.length >= 200)
    throw new Error("The browser document slide limit is 200.");
  const sourceProperty =
    command.op === "add_slide" ? "templateSlideIndex" : "slideIndex";
  const sourceIndex = integerInRange(
    command[sourceProperty],
    0,
    slideIds.length - 1,
    sourceProperty,
  );
  const insertIndex = integerInRange(
    command.insertIndex,
    0,
    slideIds.length,
    "insertIndex",
  );
  const source = slideInfo(context, sourceIndex);
  const newSlidePath = nextSlidePath(Object.keys(entries));
  const newSlideRelationshipsPath = relationshipsPath(newSlidePath);
  const sourceSlideRelationshipsPath = relationshipsPath(source.path);
  const changedParts = new Set();

  if (command.op === "duplicate_slide") {
    const copied = new Map([[source.path, newSlidePath]]);
    clonePart(context, source.path, newSlidePath, copied, changedParts);
  } else {
    const slide = parseXml(entries, source.path);
    const commonSlideData = requiredElement(
      slide,
      presentationNamespace,
      "cSld",
    );
    const shapeTree = requiredElement(
      commonSlideData,
      presentationNamespace,
      "spTree",
    );
    removeDirectChildrenExcept(shapeTree, ["nvGrpSpPr", "grpSpPr"]);
    removeDirectChildrenExcept(commonSlideData, ["bg", "spTree"]);
    removeDirectChildrenExcept(slide.documentElement, ["cSld", "clrMapOvr"]);
    entries[newSlidePath] = serializeXml(slide);
    changedParts.add(newSlidePath);
    copyContentType(context, source.path, newSlidePath, slideContentType);
    if (!entries[sourceSlideRelationshipsPath])
      throw new Error("Template slide has no layout relationship.");
    const slideRelationships = parseXml(entries, sourceSlideRelationshipsPath);
    for (const element of [
      ...slideRelationships.getElementsByTagNameNS(
        packageRelationshipNamespace,
        "Relationship",
      ),
    ]) {
      const kind = element.getAttribute("Type").split("/").at(-1);
      if (kind !== "slideLayout" && kind !== "image")
        element.parentNode.removeChild(element);
    }
    const layoutRelationships = relationshipElements(slideRelationships).filter(
      (element) => element.getAttribute("Type").endsWith("/slideLayout"),
    );
    if (layoutRelationships.length !== 1)
      throw new Error(
        "Template slide must have exactly one layout relationship.",
      );
    entries[newSlideRelationshipsPath] = serializeXml(slideRelationships);
    changedParts.add(newSlideRelationshipsPath);
  }
  registerSlide(
    context,
    newSlidePath,
    insertIndex,
    changedParts,
    sectionsBefore,
  );
  return {
    operation: command.op,
    sourceIndex,
    insertIndex,
    slideCount: slideIds.length + 1,
    changedParts: [...changedParts].sort(),
  };
}

function registerSlide(
  context,
  newSlidePath,
  insertIndex,
  changedParts,
  sectionsBefore,
) {
  const {
    entries,
    presentation,
    relationships,
    contentTypes,
    slideIdList,
    slideIds,
  } = context;
  const newRelationshipId = nextRelationshipId(relationships);
  const newRelationship = relationships.createElementNS(
    packageRelationshipNamespace,
    "Relationship",
  );
  newRelationship.setAttribute("Id", newRelationshipId);
  newRelationship.setAttribute(
    "Type",
    `${relationshipAttributeNamespace}/slide`,
  );
  newRelationship.setAttribute(
    "Target",
    relativePart(presentationPath, newSlidePath),
  );
  relationships.documentElement.appendChild(newRelationship);

  const maximumSlideId = Math.max(
    ...slideIds.map((element) => Number(element.getAttribute("id"))),
  );
  if (
    !Number.isSafeInteger(maximumSlideId) ||
    maximumSlideId < 1 ||
    maximumSlideId >= 0xffffffff
  )
    throw new Error("PPTX slide identifiers are invalid.");
  const newSlideId = presentation.createElementNS(
    presentationNamespace,
    "p:sldId",
  );
  newSlideId.setAttribute("id", String(maximumSlideId + 1));
  newSlideId.setAttributeNS(
    relationshipAttributeNamespace,
    "r:id",
    newRelationshipId,
  );
  if (insertIndex === slideIds.length) slideIdList.appendChild(newSlideId);
  else slideIdList.insertBefore(newSlideId, slideIds[insertIndex]);
  if (sectionsBefore.length)
    writeSections(
      context,
      sectionsBefore.map(({ slideCount: _slideCount, ...section }) => ({
        ...section,
        startSlideIndex:
          section.startSlideIndex > insertIndex ||
          (section.startSlideIndex === insertIndex && insertIndex !== 0)
            ? section.startSlideIndex + 1
            : section.startSlideIndex,
      })),
    );
  entries[presentationPath] = serializeXml(presentation);
  entries[presentationRelationshipsPath] = serializeXml(relationships);
  entries[contentTypesPath] = serializeXml(contentTypes);
  changedParts.add(contentTypesPath);
  changedParts.add(presentationRelationshipsPath);
  changedParts.add(presentationPath);
}

function moveSlide(context, command) {
  const sectionsBefore = readSections(context);
  const sourceIndex = integerInRange(
    command.slideIndex,
    0,
    context.slideIds.length - 1,
    "slideIndex",
  );
  const insertIndex = integerInRange(
    command.insertIndex,
    0,
    context.slideIds.length - 1,
    "insertIndex",
  );
  const reordered = [...context.slideIds];
  const [slideId] = reordered.splice(sourceIndex, 1);
  reordered.splice(insertIndex, 0, slideId);
  for (const element of context.slideIds)
    context.slideIdList.removeChild(element);
  for (const element of reordered) context.slideIdList.appendChild(element);
  if (sectionsBefore.length)
    writeSections(
      context,
      sectionsBefore.map(({ slideCount: _slideCount, ...section }) => section),
    );
  context.entries[presentationPath] = serializeXml(context.presentation);
  return {
    operation: command.op,
    sourceIndex,
    insertIndex,
    slideCount: context.slideIds.length,
    changedParts: [presentationPath],
  };
}

function deleteSlide(context, command) {
  if (context.slideIds.length === 1)
    throw new Error("The last slide cannot be deleted.");
  const sourceIndex = integerInRange(
    command.slideIndex,
    0,
    context.slideIds.length - 1,
    "slideIndex",
  );
  const sectionsBefore = readSections(context);
  const source = slideInfo(context, sourceIndex);
  for (let index = 0; index < context.slideIds.length; index += 1) {
    if (index === sourceIndex) continue;
    const other = slideInfo(context, index);
    const relPath = relationshipsPath(other.path);
    if (!context.entries[relPath]) continue;
    const linked = relationshipElements(
      parseXml(context.entries, relPath),
    ).some(
      (relationship) =>
        relationship.getAttribute("TargetMode") !== "External" &&
        resolvePart(other.path, relationship.getAttribute("Target")) ===
          source.path,
    );
    if (linked)
      throw new Error(
        "Another slide links to this slide. Remove that link before deleting it.",
      );
  }

  const before = reachableParts(context.entries);
  source.slideId.parentNode.removeChild(source.slideId);
  source.relationship.parentNode.removeChild(source.relationship);
  if (sectionsBefore.length) {
    const sectionsAfter = sectionsBefore
      .filter((section, index) => {
        const end =
          sectionsBefore[index + 1]?.startSlideIndex ?? context.slideIds.length;
        return !(
          section.startSlideIndex === sourceIndex && end === sourceIndex + 1
        );
      })
      .map(({ slideCount: _slideCount, ...section }) => ({
        ...section,
        startSlideIndex:
          section.startSlideIndex > sourceIndex
            ? section.startSlideIndex - 1
            : section.startSlideIndex,
      }));
    writeSections(context, sectionsAfter);
  }
  const after = reachableParts(context.entries, context.relationships);
  const removedParts = [...before].filter((part) => !after.has(part));
  const changedParts = new Set([
    contentTypesPath,
    presentationRelationshipsPath,
    presentationPath,
  ]);
  for (const part of removedParts) {
    delete context.entries[part];
    changedParts.add(part);
    const relPath = relationshipsPath(part);
    if (context.entries[relPath]) {
      delete context.entries[relPath];
      changedParts.add(relPath);
    }
  }
  for (const override of [
    ...context.contentTypes.getElementsByTagNameNS(
      contentTypeNamespace,
      "Override",
    ),
  ])
    if (
      removedParts.includes(
        override.getAttribute("PartName").replace(/^\//u, ""),
      )
    )
      override.parentNode.removeChild(override);
  context.entries[presentationPath] = serializeXml(context.presentation);
  context.entries[presentationRelationshipsPath] = serializeXml(
    context.relationships,
  );
  context.entries[contentTypesPath] = serializeXml(context.contentTypes);
  return {
    operation: command.op,
    sourceIndex,
    slideCount: context.slideIds.length - 1,
    changedParts: [...changedParts].sort(),
    removedParts: removedParts.sort(),
  };
}

function slideInfo(context, index) {
  const slideId = context.slideIds[index];
  const relationshipId = slideId.getAttributeNS(
    relationshipAttributeNamespace,
    "id",
  );
  const relationship = relationshipElements(context.relationships).find(
    (element) => element.getAttribute("Id") === relationshipId,
  );
  if (!relationship || relationship.getAttribute("TargetMode") === "External")
    throw new Error("Slide relationship is missing or external.");
  const path = resolvePart(
    presentationPath,
    relationship.getAttribute("Target"),
  );
  if (!path.startsWith("ppt/slides/") || !context.entries[path])
    throw new Error("Slide relationship does not target a package slide.");
  return { slideId, relationship, path };
}

function relationshipElements(document) {
  return [
    ...document.getElementsByTagNameNS(
      packageRelationshipNamespace,
      "Relationship",
    ),
  ];
}

function nextRelationshipId(document) {
  const existing = new Set(
    relationshipElements(document).map((element) => element.getAttribute("Id")),
  );
  let ordinal = 1;
  while (existing.has(`rIdSpellbook${ordinal}`)) ordinal += 1;
  return `rIdSpellbook${ordinal}`;
}

function copyContentType(context, source, destination, fallback = null) {
  const overrides = [
    ...context.contentTypes.getElementsByTagNameNS(
      contentTypeNamespace,
      "Override",
    ),
  ];
  if (
    overrides.some(
      (element) => element.getAttribute("PartName") === `/${destination}`,
    )
  )
    throw new Error(`PPTX content type already exists for ${destination}.`);
  const sourceOverride = overrides.find(
    (element) => element.getAttribute("PartName") === `/${source}`,
  );
  if (!sourceOverride && !fallback) return;
  const override = context.contentTypes.createElementNS(
    contentTypeNamespace,
    "Override",
  );
  override.setAttribute("PartName", `/${destination}`);
  override.setAttribute(
    "ContentType",
    sourceOverride?.getAttribute("ContentType") || fallback,
  );
  context.contentTypes.documentElement.appendChild(override);
}

function clonePart(context, source, destination, copied, changedParts) {
  if (copied.size > 500)
    throw new Error("Slide dependency graph exceeds the safe copy limit.");
  const bytes = context.entries[source];
  if (!bytes) throw new Error(`Missing slide dependency: ${source}`);
  context.entries[destination] = bytes.slice();
  changedParts.add(destination);
  copyContentType(context, source, destination);
  const sourceRelationshipsPath = relationshipsPath(source);
  if (!context.entries[sourceRelationshipsPath]) return;
  const relationships = parseXml(context.entries, sourceRelationshipsPath);
  for (const relationship of relationshipElements(relationships)) {
    if (relationship.getAttribute("TargetMode") === "External") continue;
    const target = resolvePart(source, relationship.getAttribute("Target"));
    const kind = relationship.getAttribute("Type").split("/").at(-1);
    let mapped = copied.get(target);
    if (!mapped) {
      if (sharedDependencyKinds.has(kind)) mapped = target;
      else {
        mapped = nextPartPath(context.entries, target);
        copied.set(target, mapped);
        clonePart(context, target, mapped, copied, changedParts);
      }
    }
    relationship.setAttribute("Target", relativePart(destination, mapped));
  }
  const destinationRelationshipsPath = relationshipsPath(destination);
  context.entries[destinationRelationshipsPath] = serializeXml(relationships);
  changedParts.add(destinationRelationshipsPath);
}

function nextPartPath(entries, source) {
  if (source.startsWith("ppt/slides/"))
    return nextSlidePath(Object.keys(entries));
  const slash = source.lastIndexOf("/");
  const dot = source.lastIndexOf(".");
  const directory = source.slice(0, slash + 1);
  const stem = source.slice(slash + 1, dot > slash ? dot : undefined);
  const extension = dot > slash ? source.slice(dot) : "";
  let ordinal = 1;
  let candidate;
  do {
    candidate = `${directory}${stem}-spellbook-${ordinal}${extension}`;
    ordinal += 1;
  } while (entries[candidate]);
  return candidate;
}

function reachableParts(entries, presentationRelationshipsOverride = null) {
  const reachable = new Set();
  const visit = (source, relationshipPath) => {
    if (
      !entries[relationshipPath] &&
      relationshipPath !== presentationRelationshipsPath
    )
      return;
    const relationships =
      relationshipPath === presentationRelationshipsPath &&
      presentationRelationshipsOverride
        ? presentationRelationshipsOverride
        : parseXml(entries, relationshipPath);
    for (const relationship of relationshipElements(relationships)) {
      if (relationship.getAttribute("TargetMode") === "External") continue;
      const target = resolvePart(source, relationship.getAttribute("Target"));
      if (reachable.has(target)) continue;
      reachable.add(target);
      visit(target, relationshipsPath(target));
    }
  };
  visit("", "_rels/.rels");
  return reachable;
}

function inspectZipPackage(input) {
  if (input.byteLength < 22) throw new Error("PPTX ZIP end record is missing.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const minimumOffset = Math.max(0, input.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = input.byteLength - 22; offset >= minimumOffset; offset -= 1)
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  if (endOffset < 0) throw new Error("PPTX ZIP end record is missing.");
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new Error(
      "ZIP64 PPTX packages are not supported in the browser worker.",
    );
  if (entryCount > maximumEntries)
    throw new Error("PPTX contains too many package entries.");
  if (directoryOffset + directorySize > endOffset)
    throw new Error("PPTX ZIP central directory is invalid.");

  const decoder = new TextDecoder();
  const names = new Set();
  let expandedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > input.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw new Error("PPTX ZIP central directory entry is invalid.");
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (flags & 1) throw new Error("Encrypted PPTX entries are not supported.");
    if (compression !== 0 && compression !== 8)
      throw new Error(
        `Unsupported PPTX ZIP compression method: ${compression}.`,
      );
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > input.byteLength)
      throw new Error("PPTX ZIP entry name exceeds the package boundary.");
    const name = decoder.decode(input.subarray(nameStart, nameEnd));
    const segments = name.split("/");
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      segments.includes("..") ||
      names.has(name)
    )
      throw new Error(
        `Unsafe or duplicate PPTX ZIP entry: ${name || "<empty>"}.`,
      );
    names.add(name);
    expandedBytes += uncompressedBytes;
    if (expandedBytes > maximumExpandedBytes)
      throw new Error("Expanded PPTX exceeds the browser mutation limit.");
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize)
    throw new Error("PPTX ZIP central directory size is inconsistent.");
  return { entryCount, expandedBytes };
}

function parseXml(entries, path) {
  const bytes = entries[path];
  if (!bytes) throw new Error(`PPTX package part is missing: ${path}`);
  const source = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(source))
    throw new Error(`Unsafe XML declaration in ${path}.`);
  const issues = [];
  const document = new DOMParser({
    onError: (level, message) => issues.push(`${level}: ${message}`),
  }).parseFromString(source, "application/xml");
  if (issues.length || document.getElementsByTagName("parsererror").length)
    throw new Error(`Invalid XML in ${path}: ${issues.join("; ")}`);
  return document;
}

// importNode preserves XML names, but QName-valued attributes can refer
// to ancestor-only declarations. Carry exactly those bindings, keeping
// unrelated authored/engine XML serialization unchanged.
function importOoxmlSubtree(document, source, deep) {
  const copy = document.importNode(source, deep);
  if (copy.nodeType !== 1) return copy;
  const sources = [source, ...(deep ? source.getElementsByTagName("*") : [])];
  const copies = [copy, ...(deep ? copy.getElementsByTagName("*") : [])];
  sources.forEach((element, index) => {
    for (const attribute of element.attributes) {
      const prefixList =
        (element.namespaceURI === markupCompatibilityNamespace &&
          element.localName === "Choice" &&
          !attribute.namespaceURI &&
          attribute.localName === "Requires") ||
        (attribute.namespaceURI === markupCompatibilityNamespace &&
          ["Ignorable", "MustUnderstand"].includes(attribute.localName));
      const qnameList =
        (attribute.namespaceURI === markupCompatibilityNamespace &&
          ["ProcessContent", "PreserveElements", "PreserveAttributes"].includes(
            attribute.localName,
          )) ||
        (attribute.namespaceURI ===
          "http://www.w3.org/2001/XMLSchema-instance" &&
          attribute.localName === "type");
      if (!prefixList && !qnameList) continue;
      for (const value of attribute.value
        .trim()
        .split(/\s+/u)
        .filter(Boolean)) {
        const prefix = prefixList
          ? value
          : value.includes(":")
            ? value.split(":")[0]
            : "";
        const uri = element.lookupNamespaceURI(prefix || null);
        if (!uri && prefix)
          throw new Error(
            `Cannot import unbound XML namespace prefix ${prefix}.`,
          );
        const target = copies[index];
        if (target.lookupNamespaceURI(prefix || null) !== uri)
          target.setAttributeNS(
            "http://www.w3.org/2000/xmlns/",
            prefix ? `xmlns:${prefix}` : "xmlns",
            uri ?? "",
          );
      }
    }
  });
  return copy;
}

function serializeXml(document) {
  return strToU8(new XMLSerializer().serializeToString(document));
}

function requiredElement(document, namespace, localName) {
  const element = document.getElementsByTagNameNS(namespace, localName)[0];
  if (!element)
    throw new Error(`Required PresentationML element is missing: ${localName}`);
  return element;
}

function removeDirectChildrenExcept(parent, allowed) {
  for (const child of [...parent.childNodes])
    if (
      child.nodeType === 1 &&
      child.namespaceURI === presentationNamespace &&
      !allowed.includes(child.localName)
    )
      parent.removeChild(child);
}

function integerInRange(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return value;
}

function nextSlidePath(entryNames) {
  const used = new Set(entryNames);
  let ordinal = 1;
  while (used.has(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
  return `ppt/slides/slide${ordinal}.xml`;
}

function relationshipsPath(part) {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

function resolvePart(source, target) {
  if (!target || target.includes("\\"))
    throw new Error("Unsafe internal relationship target.");
  const resolved = new URL(target, `https://package.invalid/${source}`);
  if (resolved.origin !== "https://package.invalid")
    throw new Error("External slide relationship is not supported.");
  const decoded = decodeURIComponent(resolved.pathname).replace(/^\//u, "");
  if (decoded.includes("\\"))
    throw new Error("Unsafe internal relationship target.");
  return decoded;
}

function relativePart(source, target) {
  const sourceSegments = source.split("/");
  sourceSegments.pop();
  const targetSegments = target.split("/");
  while (
    sourceSegments.length &&
    targetSegments.length &&
    sourceSegments[0] === targetSegments[0]
  ) {
    sourceSegments.shift();
    targetSegments.shift();
  }
  return `${"../".repeat(sourceSegments.length)}${targetSegments.join("/")}`;
}

if (typeof self !== "undefined")
  self.onmessage = async (event) => {
    const {
      requestId,
      bytes,
      command,
      operation,
      noEditBytes,
      editedBytes,
      sourceOperations,
      sourceTargets,
    } = event.data;
    try {
      if (operation === "inspect") {
        self.postMessage({
          requestId,
          report: await inspectOoxmlDocumentWithAssets(new Uint8Array(bytes)),
        });
      } else if (operation === "compare-native-export") {
        self.postMessage({
          requestId,
          report: {
            changedParts: nativeExportDifferences(
              new Uint8Array(noEditBytes),
              new Uint8Array(editedBytes),
            ),
          },
        });
      } else if (operation === "preserve-native") {
        const result = preserveOriginalPptxParts(
          new Uint8Array(bytes),
          new Uint8Array(noEditBytes),
          new Uint8Array(editedBytes),
          sourceOperations,
          sourceTargets ?? null,
        );
        self.postMessage(
          { requestId, bytes: result.bytes.buffer, report: result.report },
          [result.bytes.buffer],
        );
      } else {
        const result = applyOoxmlCommand(new Uint8Array(bytes), command);
        self.postMessage(
          { requestId, bytes: result.bytes.buffer, report: result.report },
          [result.bytes.buffer],
        );
      }
    } catch (error) {
      self.postMessage({
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
