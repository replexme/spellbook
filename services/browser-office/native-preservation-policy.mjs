/* SPDX-License-Identifier: MPL-2.0 */

import capabilities from "../../contracts/native-edit-capabilities.json" with { type: "json" };

// Keep these package categories aligned with
// PptxPackageChangeBudgetValidator.Classify. The contract owns each operation's
// allowed categories; the browser must not infer authority from an Office save.
export function classifyNativePackagePart(part) {
  if (part === "[Content_Types].xml") return "package_manifest";
  if (part === "_rels/.rels") return "package_relationships";
  if (part.startsWith("docProps/")) return "document_properties";
  if (
    ["ppt/presentation.xml", "ppt/presProps.xml", "ppt/viewProps.xml"].includes(
      part,
    )
  )
    return "presentation";
  if (part === "ppt/_rels/presentation.xml.rels")
    return "presentation_relationships";
  for (const [directory, category, relationshipCategory] of [
    ["ppt/slides/", "slide_parts", "slide_relationships"],
    ["ppt/notesSlides/", "notes_parts", "notes_relationships"],
    ["ppt/notesMasters/", "notes_master_parts", "notes_master_relationships"],
    ["ppt/slideLayouts/", "slide_layout_parts", "slide_layout_relationships"],
    ["ppt/slideMasters/", "slide_master_parts", "slide_master_relationships"],
  ]) {
    if (part.startsWith(`${directory}_rels/`)) return relationshipCategory;
    if (part.startsWith(directory)) return category;
  }
  for (const [directory, category] of [
    ["ppt/theme/", "theme_parts"],
    ["ppt/charts/", "chart_parts"],
    ["ppt/embeddings/", "embedded_workbooks"],
    ["ppt/media/", "media_parts"],
    ["ppt/diagrams/", "diagram_parts"],
    ["customXml/", "custom_xml"],
  ])
    if (part.startsWith(directory)) return category;
  if (part.startsWith("ppt/comments/") || part.startsWith("ppt/commentAuthors"))
    return "comments";
  if (
    part === "ppt/vbaProject.bin" ||
    part.startsWith("ppt/vbaProjectSignature")
  )
    return "macros";
  return "unknown";
}

// Direct human edits may use any LibreOffice feature, so they are not bound
// to one command family. Macros and unrecognized package parts still stay out
// of a saved candidate, matching the server's human-save policy.
const humanEditCategories = [
  "package_manifest",
  "package_relationships",
  "document_properties",
  "presentation",
  "presentation_relationships",
  "slide_parts",
  "slide_relationships",
  "notes_parts",
  "notes_relationships",
  "notes_master_parts",
  "notes_master_relationships",
  "slide_layout_parts",
  "slide_layout_relationships",
  "slide_master_parts",
  "slide_master_relationships",
  "theme_parts",
  "chart_parts",
  "embedded_workbooks",
  "media_parts",
  "diagram_parts",
  "custom_xml",
  "comments",
];

export function humanEditPreservationBudget() {
  return {
    allowedCategories: new Set(humanEditCategories),
    allowPartCreationOrDeletion: true,
  };
}

const elementScopedTargets = new Set([
  "element",
  "elements",
  "table_cell",
  "table_range",
]);
const shapeTreeIdentityEffects = new Set(["reorder", "reparent"]);

/**
 * What the contract lets an operation change on the one slide it targets:
 * only the shapes it names ("named_shapes"), any shape ("any_shape"), or none
 * of the slide's existing shapes ("no_shape": slide settings, notes, comments
 * and animation timing, or a new object beside them). Every other slide and
 * shape is export noise that the merge replaces with the author's XML. null
 * means the operation can reach beyond its slide: slide structure, document
 * and master settings.
 */
export function operationSlideScope(operation) {
  const contract = capabilities.mutationModel.operations[operation];
  if (!contract) return null;
  if (elementScopedTargets.has(contract.target))
    // Reordering and regrouping change the shape tree itself.
    return shapeTreeIdentityEffects.has(contract.identityEffect)
      ? "any_shape"
      : "named_shapes";
  if (contract.target === "animation_effect") return "no_shape";
  if (contract.target !== "slide" || contract.family === "slide_structure")
    return null;
  // Applying a layout adds, removes and moves the slide's placeholders.
  return operation === "set_slide_layout" ? "any_shape" : "no_shape";
}

export function nativePreservationBudget(operations) {
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > 50
  )
    throw new Error("Native snapshot needs a bounded operation list.");
  const allowedCategories = new Set();
  let allowPartCreationOrDeletion = false;
  for (const operation of operations) {
    const contract = capabilities.mutationModel.operations[operation];
    if (!contract || contract.availability === "format_excluded")
      throw new Error(
        `Native snapshot has an unknown operation: ${operation}.`,
      );
    const family = capabilities.mutationModel.families[contract.family];
    const categories = contract.changeBudget ?? family?.changeBudget;
    if (!Array.isArray(categories))
      throw new Error(`Native snapshot has no change budget: ${operation}.`);
    for (const category of categories) allowedCategories.add(category);
    if (["create", "delete"].includes(contract.identityEffect))
      allowPartCreationOrDeletion = true;
    if (
      contract.allowPartCreationOrDeletion === true ||
      family?.allowPartCreationOrDeletion === true
    )
      allowPartCreationOrDeletion = true;
  }
  return { allowedCategories, allowPartCreationOrDeletion };
}
