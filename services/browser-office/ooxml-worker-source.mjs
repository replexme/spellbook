/* SPDX-License-Identifier: MPL-2.0 */

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  classifyNativePackagePart,
  nativePreservationBudget,
  humanEditPreservationBudget,
  operationsConfinedToTargets,
} from "./native-preservation-policy.mjs";

const presentationNamespace =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const powerpoint2010Namespace =
  "http://schemas.microsoft.com/office/powerpoint/2010/main";
const drawingNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const relationshipAttributeNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationshipNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypeNamespace =
  "http://schemas.openxmlformats.org/package/2006/content-types";
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

function sameEngineExportPart(part, left, right) {
  if (samePartBytes(left, right)) return true;
  if (!left || !right || !part.endsWith(".xml")) return false;
  const normalized = (bytes) => {
    const document = parseXml({ [part]: bytes }, part);
    let fieldIndex = 0;
    for (const field of document.getElementsByTagNameNS(
      drawingNamespace,
      "fld",
    ))
      field.setAttribute("id", `__office_field_${++fieldIndex}__`);
    return serializeXml(document);
  };
  return samePartBytes(normalized(left), normalized(right));
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
// The engine generates a new field GUID on every save.
const volatileXmlAttribute = (element, attribute) =>
  element.namespaceURI === drawingNamespace &&
  element.localName === "fld" &&
  !attribute.namespaceURI &&
  attribute.localName === "id";
function comparableXml(node) {
  const copy = node.cloneNode(true);
  for (const element of [copy, ...copy.getElementsByTagName("*")])
    if (
      element.namespaceURI === drawingNamespace &&
      element.localName === "fld"
    )
      element.removeAttribute("id");
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
    return document.importNode(source, true);
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

  const merged = document.importNode(source, false);
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
      output.push({ key, node: document.importNode(authored, true) });
    else if (!after) continue;
    else if (!before)
      output.push({ key, node: document.importNode(after, true) });
    else
      output.push({
        key,
        node:
          mergeElementThreeWay(document, authored, before, after) ??
          document.importNode(after, true),
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
      node: document.importNode(after, true),
    });
  }
  for (const { node } of output) merged.appendChild(node);
  return merged;
}

function preserveUnaffectedSlideShapes(
  part,
  originalBytes,
  noEditBytes,
  editedBytes,
  sourceOperations,
  targetNames = null,
) {
  if (
    !/^ppt\/slides\/slide[^/]+\.xml$/u.test(part) ||
    !originalBytes ||
    !noEditBytes ||
    !editedBytes ||
    samePartBytes(originalBytes, noEditBytes)
  )
    return null;
  const documents = [originalBytes, noEditBytes, editedBytes].map((bytes) =>
    parseXml({ [part]: bytes }, part),
  );
  const shapeChildren = (document) => {
    const commonSlide = directXmlChild(
      document.documentElement,
      presentationNamespace,
      "cSld",
    );
    const tree =
      commonSlide &&
      directXmlChild(commonSlide, presentationNamespace, "spTree");
    if (!tree) return null;
    return [...tree.childNodes].filter(
      (node) =>
        node.nodeType === 1 &&
        node.namespaceURI === presentationNamespace &&
        ["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(
          node.localName,
        ),
    );
  };
  const [authored, normalized, changed] = documents.map(shapeChildren);
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
  const hasRelationshipReference = (node) => {
    for (const element of [node, ...node.getElementsByTagName("*")])
      for (let index = 0; index < element.attributes.length; index += 1)
        if (
          element.attributes.item(index).namespaceURI ===
          relationshipAttributeNamespace
        )
          return true;
    return false;
  };
  const editedById = new Map(changed.map((node) => [identity(node)?.id, node]));
  const additiveOnly =
    sourceOperations.length > 0 &&
    sourceOperations.every((operation) =>
      additiveShapeOperations.has(operation),
    );
  // A shape the command did not name keeps its authored XML even when the
  // engine's save rewrote it (for example dropping an empty paragraph's
  // alignment): the contract confines the command to its targets.
  const untargeted = (source) =>
    targetNames !== null &&
    Boolean(identity(source)?.name) &&
    !targetNames.has(identity(source).name);
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
      sourceIdentity.name !== baselineIdentity.name
    )
      continue;
    const editedShape = editedById.get(baselineIdentity.id);
    if (
      !editedShape ||
      editedShape.localName !== baseline.localName ||
      identity(editedShape)?.name !== baselineIdentity.name
    )
      continue;
    const pair = {
      sourceId: sourceIdentity.id,
      baselineId: baselineIdentity.id,
      editedId: identity(editedShape).id,
      finalId: identity(editedShape).id,
    };
    pairs.push(pair);
    if (hasRelationshipReference(source)) continue;
    if (
      additiveOnly ||
      untargeted(source) ||
      samePartBytes(serializeXml(editedShape), serializeXml(baseline))
    ) {
      replacements.push({
        pair,
        editedShape,
        restored: true,
        node: documents[2].importNode(source, true),
      });
      continue;
    }
    // A shape the command named keeps the author's XML wherever the engine's
    // saves before and after the command agree.
    const merged = mergeElementThreeWay(
      documents[2],
      source,
      baseline,
      editedShape,
    );
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
    const timing = documents[2].importNode(authoredTiming, true);
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
          if (attribute.namespaceURI !== relationshipAttributeNamespace)
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
            const copy = document.importNode(relationship, true);
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
    const restored = selected.importNode(authored, true);
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
    const copy = selected.importNode(sound, true);
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
function remapPartRelationshipIds(part, bytes, originalRels, engineRels) {
  if (!bytes || !originalRels || !engineRels || !part.endsWith(".xml"))
    return null;
  const relationshipPath = relationshipsPath(part);
  const keyed = (relsBytes) =>
    relationshipElements(
      parseXml({ [relationshipPath]: relsBytes }, relationshipPath),
    ).map((relationship) => ({
      id: relationship.getAttribute("Id"),
      key: relationshipIdentity(part, relationship),
    }));
  const engineById = new Map(keyed(engineRels).map(({ id, key }) => [id, key]));
  const originalByKey = new Map();
  for (const { id, key } of keyed(originalRels))
    originalByKey.set(key, originalByKey.has(key) ? null : id);
  const document = parseXml({ [part]: bytes }, part);
  let changed = false;
  for (const element of [
    document.documentElement,
    ...document.getElementsByTagName("*"),
  ])
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (attribute.namespaceURI !== relationshipAttributeNamespace) continue;
      const key = engineById.get(attribute.value);
      const originalId = key ? originalByKey.get(key) : undefined;
      if (!originalId) return null;
      if (originalId !== attribute.value) {
        attribute.value = originalId;
        changed = true;
      }
    }
  return changed ? serializeXml(document) : bytes;
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
function alignEngineSlideParts(original, engine) {
  const authored = orderedSlidePaths(original);
  const saved = orderedSlidePaths(engine);
  if (
    !authored.length ||
    authored.length !== saved.length ||
    authored.some((part) => !part || !original[part]) ||
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
    const taken = new Set([...Object.keys(original), ...Object.keys(engine)]);
    while (taken.has(`ppt/notesSlides/notesSlide${ordinal}.xml`)) ordinal += 1;
    renames.set(engineNotes, `ppt/notesSlides/notesSlide${ordinal}.xml`);
  }
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

// The author's names of the shapes the commands target, per slide part.
// Null unless every operation is confined to the shapes it names and every
// target was identified, in which case the merge keeps nothing else from
// the engine's save.
function shapeTargetsBySlide(original, sourceOperations, sourceTargets) {
  if (
    !Array.isArray(sourceTargets) ||
    sourceTargets.length === 0 ||
    !operationsConfinedToTargets(sourceOperations)
  )
    return null;
  const slidePaths = orderedSlidePaths(original);
  const targets = new Map();
  for (const target of sourceTargets) {
    const part = Number.isSafeInteger(target?.slideIndex)
      ? slidePaths[target.slideIndex]
      : null;
    if (!part || typeof target.name !== "string" || !target.name) return null;
    if (!targets.has(part)) targets.set(part, new Set());
    targets.get(part).add(target.name);
  }
  return targets;
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
// manifest while adding an engine-created part. Declare each undeclared part
// the way the package it came from declared it, and drop overrides for parts
// the merge left out. Returns null when the manifest is already complete.
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
    if (part === contentTypesPath || declaredContentType(declared, part))
      continue;
    const sources = samePartBytes(merged[part], original[part])
      ? [authoredTypes, engineTypes]
      : [engineTypes, authoredTypes];
    const source = sources.find(
      (candidate) => candidate && declaredContentType(candidate, part),
    );
    if (!source) continue;
    const contentType = declaredContentType(source, part);
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
      if (attribute.namespaceURI === relationshipAttributeNamespace)
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
    if (!relationship.getAttribute("Type")?.endsWith("/slideLayout")) continue;
    const target = relationship.getAttribute("Target");
    if (
      !/^ppt\/slideLayouts\/slideLayout[^/]+\.xml$/u.test(
        resolvePart(sourcePart, target),
      )
    )
      continue;
    const normalizedRelationship = normalizedById.get(
      relationship.getAttribute("Id"),
    );
    const layoutWasNotEdited =
      !sourceOperations.includes("set_slide_layout") ||
      (normalizedRelationship?.getAttribute("Type") ===
        relationship.getAttribute("Type") &&
        normalizedRelationship.getAttribute("Target") === target);
    const originalLayout =
      layoutWasNotEdited && original[part]
        ? relationshipsOfType(original, sourcePart, "slideLayout")
        : [];
    // A hyperlink or media edit can rewrite the slide's .rels without
    // changing its layout. Keep the author's exact original target instead
    // of guessing among same-named LibreOffice-normalized layouts.
    const remapped =
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
  const matches = [...parent.childNodes].filter(
    (child) =>
      child.nodeType === 1 &&
      child.namespaceURI === namespace &&
      child.localName === localName,
  );
  if (matches.length !== 1)
    throw new Error(`Native snapshot needs exactly one ${localName} node.`);
  return matches[0];
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
        noEdit.importNode(baselineNode, true),
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
// list entry join the author's copies. Otherwise the author's copies stay as
// they are. The engine also rewrites the notes page size on some saves, which
// no edit here asks for. Any other change to the presentation part is left
// to the ordinary merge.
const addedPresentationRelationships = new Set([
  "notesMaster",
  "commentAuthors",
]);

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
  if (
    normalized.some(
      (relationship) => !changedIdentities.has(identity(relationship)),
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
  if (!added.length)
    return {
      [presentationPath]: original[presentationPath],
      [presentationRelationshipsPath]: original[presentationRelationshipsPath],
    };

  const relationships = parseXml(original, presentationRelationshipsPath);
  const presentation = parseXml(original, presentationPath);
  let presentationChanged = false;
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
    const root = presentation.documentElement;
    const list = presentation.createElementNS(
      presentationNamespace,
      "p:notesMasterIdLst",
    );
    const entry = presentation.createElementNS(
      presentationNamespace,
      "p:notesMasterId",
    );
    entry.setAttributeNS(relationshipAttributeNamespace, "r:id", id);
    list.appendChild(entry);
    // CT_Presentation: sldMasterIdLst, then notesMasterIdLst.
    const slideMasters = directXmlChild(
      root,
      presentationNamespace,
      "sldMasterIdLst",
    );
    root.insertBefore(list, slideMasters.nextSibling);
    presentationChanged = true;
  }
  return {
    [presentationPath]: presentationChanged
      ? serializeXml(presentation)
      : original[presentationPath],
    [presentationRelationshipsPath]: serializeXml(relationships),
  };
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

function mergeMasterThemeIntoOriginal(original, noEdit, edited) {
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
  const selected = new Set(
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
  const noEdit = alignEngineSlideParts(original, unzipSync(noEditBytes));
  const edited = alignEngineSlideParts(original, unzipSync(editedBytes));
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

  const targetNamesBySlide = humanEdit
    ? null
    : shapeTargetsBySlide(original, sourceOperations, sourceTargets);
  const merged = {};
  const editedSlides = [];
  const semanticPatchedParts = [];
  const suppressedNoopParts = [];
  const suppressedOutOfBudgetParts = [];
  const semanticMasterThemePatch =
    sourceOperations.length === 1 && sourceOperations[0] === "set_master_theme"
      ? mergeMasterThemeIntoOriginal(original, noEdit, edited)
      : null;
  const presentationPartsPatch = semanticMasterThemePatch
    ? null
    : mergePresentationParts(original, noEdit, edited);
  const paths = new Set([
    ...Object.keys(original),
    ...Object.keys(noEdit),
    ...Object.keys(edited),
    ...Object.keys(semanticMasterThemePatch ?? {}),
  ]);
  for (const part of [...paths].sort()) {
    // No current native command edits package core properties. Impress
    // updates modified time, lastModifiedBy and revision as a save side
    // effect, not as part of the requested slide/content mutation.
    const engineChanged = !sameEngineExportPart(
      part,
      noEdit[part],
      edited[part],
    );
    const withinBudget =
      budget.allowedCategories.has(classifyNativePackagePart(part)) &&
      (budget.allowPartCreationOrDeletion ||
        Boolean(original[part]) === Boolean(edited[part]));
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
      !untargetedSlide;
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
      ? preserveUnaffectedSlideShapes(
          part,
          original[part],
          noEdit[part],
          semanticTableInsetPatch ?? edited[part],
          sourceOperations,
          targetNamesBySlide?.get(part) ?? null,
        )
      : null;
    let relationshipRemap = null;
    const presentationPatch =
      presentationPartsPatch && Object.hasOwn(presentationPartsPatch, part);
    if (
      authoredChange &&
      !part.endsWith(".rels") &&
      !semanticSlideSizePatch &&
      !presentationPatch
    ) {
      if (
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
                ? remapAuthoredRelationships(
                    part,
                    edited[part],
                    original,
                    noEdit,
                    sourceOperations,
                  )
                : (relationshipRemap ??
                  semanticShapePatch ??
                  semanticTableInsetPatch ??
                  edited[part])
            : (reboundReferences ?? original[part]);
    if (semanticSlideSizePatch) semanticPatchedParts.push(part);
    if (
      semanticShapePatch ||
      semanticTableInsetPatch ||
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
  const beforeShape = resolveElementShape(before, command.elementId).shape;
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
    const beforeTransform = requiredShapeTransform(beforeShape);
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
  return {
    sections: readSections(context),
    slideIds: currentSlideIds(context).map((slide) => slide.getAttribute("id")),
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

function validSectionId(value) {
  return /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu.test(
    value,
  );
}

function validSectionName(value) {
  return (
    typeof value === "string" &&
    [...value].length > 0 &&
    [...value].length <= 255 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizedSections(value, slideCount) {
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
        ? updateElementGeometry(shape, path, command)
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

function updateElementGeometry(shape, path, command) {
  if (path.length !== 1) throw new Error("Invalid top-level shape path.");
  const transform = requiredShapeTransform(shape);
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
    if (expectedSize !== size)
      for (const property of properties)
        property.setAttribute("sz", String(size));
    return {
      previous: expectedSize,
      value: size,
      changed: expectedSize !== size,
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
    if (previous !== value)
      for (const property of properties)
        property.setAttribute(attribute, value ? "1" : "0");
    return { previous, value, changed: previous !== value };
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
    if (previous !== value)
      for (const property of properties)
        for (const name of ["latin", "ea", "cs"])
          ensureDirectDrawingElement(property, name).setAttribute(
            "typeface",
            value,
          );
    return { previous, value, changed: previous !== value };
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
  if (!textNodes.length)
    throw new Error("The browser package paragraph has no editable text run.");
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
  return {
    operation: command.op,
    sourceIndex,
    insertIndex,
    slideCount: slideIds.length + 1,
    changedParts: [...changedParts].sort(),
  };
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
  self.onmessage = (event) => {
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
          report: inspectOoxmlDocument(new Uint8Array(bytes)),
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
