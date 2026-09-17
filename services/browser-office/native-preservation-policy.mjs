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
