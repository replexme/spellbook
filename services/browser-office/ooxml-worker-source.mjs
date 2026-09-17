/* SPDX-License-Identifier: MPL-2.0 */

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

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

// Office can rewrite unrelated package parts even when no edit was made.
// Compare two exports from that same engine, then apply only their actual
// difference to the user's original package. Reopening the result and proving
// its intended model state is still required before it can be committed.
export function preserveOriginalPptxParts(
  originalBytes,
  noEditBytes,
  editedBytes,
) {
  for (const bytes of [originalBytes, noEditBytes, editedBytes]) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumInputBytes)
      throw new TypeError("Native snapshot inputs must be bounded PPTX bytes.");
    inspectZipPackage(bytes);
  }
  const original = unzipSync(originalBytes);
  const noEdit = unzipSync(noEditBytes);
  const edited = unzipSync(editedBytes);
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

  const merged = {};
  const changedParts = [];
  const suppressedNoopParts = [];
  const paths = new Set([
    ...Object.keys(original),
    ...Object.keys(noEdit),
    ...Object.keys(edited),
  ]);
  for (const part of [...paths].sort()) {
    // No current native command edits package core properties. Impress
    // updates modified time, lastModifiedBy and revision as a save side
    // effect, not as part of the requested slide/content mutation.
    const authoredChange =
      part !== "docProps/core.xml" &&
      !sameEngineExportPart(part, noEdit[part], edited[part]);
    if (authoredChange && !part.endsWith(".rels")) {
      const related = relationshipsPath(part);
      if (
        samePartBytes(noEdit[related], edited[related]) &&
        !samePartBytes(original[related], noEdit[related]) &&
        !referencedRelationshipsStillMatch(
          part,
          edited[part],
          original[related],
          noEdit[related],
        )
      )
        throw new Error(
          `Native snapshot needs relationship remapping before preserving ${part}.`,
        );
    }
    const selected = authoredChange ? edited[part] : original[part];
    if (selected) merged[part] = selected;
    if (!samePartBytes(original[part], selected)) changedParts.push(part);
    if (!authoredChange && !samePartBytes(original[part], noEdit[part]))
      suppressedNoopParts.push(part);
  }
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
  return { bytes, report: { changedParts, suppressedNoopParts } };
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
    if (expectedColor !== color) {
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
      changed: expectedColor !== color,
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
    ? directColorTransform(existingFill, "alpha")?.getAttribute("val")
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
    const { requestId, bytes, command, operation, noEditBytes, editedBytes } =
      event.data;
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
