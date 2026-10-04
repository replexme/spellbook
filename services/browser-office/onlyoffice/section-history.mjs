/* SPDX-License-Identifier: MPL-2.0 */
// Pinned SDK supplies section fields and content-history primitives but omits
// the presentation section-array registrations. Bind that existing contract;
// refuse a collision rather than overriding another implementation.
export function ensureOnlyOfficeSectionHistory() {
  const d = window.AscDFH,
    format = window.AscFormat;
  if (
    typeof d.CChangesDrawingsContent !== "function" ||
    !Array.isArray(window.Asc.editor.WordControl.m_oLogicDocument.Sections)
  )
    throw Error("onlyoffice_product_section_history_unavailable");
  format.spellbookSectionContent ??= function (owner) {
    return owner.Sections;
  };
  for (const type of [
    d.historyitem_Presentation_AddSection,
    d.historyitem_Presentation_RemoveSection,
  ]) {
    if (!Number.isSafeInteger(type))
      throw Error("onlyoffice_product_section_history_unavailable");
    if (
      !d.changesFactory[type] &&
      !d.drawingContentChanges[type] &&
      !d.drawingsChangesMap?.[type]
    ) {
      d.changesFactory[type] = d.CChangesDrawingsContent;
      d.drawingContentChanges[type] = format.spellbookSectionContent;
    } else if (
      d.drawingsChangesMap?.[type] ||
      d.changesFactory[type] !== d.CChangesDrawingsContent ||
      d.drawingContentChanges[type] !== format.spellbookSectionContent
    )
      throw Error("onlyoffice_product_section_history_collision");
  }
}
