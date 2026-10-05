/* SPDX-License-Identifier: MPL-2.0 */
export { serializeNativePptxSections as serializeOnlyOfficeSections } from "../ooxml-worker-source.mjs";

// Initialization only: restore original package sections before the first
// observation or user history. Never use this to mutate an open session.
export function initializeOnlyOfficeSections(sections) {
  const model = window.Asc.editor.WordControl.m_oLogicDocument;
  const history = window.AscCommon.History;
  if (
    history.Index !== -1 ||
    history.Points.some((point) => point.Items.length)
  )
    throw Error("onlyoffice_product_section_initialization_after_edit");
  if (
    !Array.isArray(model.Sections) ||
    typeof window.AscCommonSlide.CPrSection !== "function"
  )
    throw Error("onlyoffice_product_sections_unavailable");
  if (model.Sections.length) {
    const actual = model.Sections.map(({ name, guid, startIndex }) => ({
      name,
      id: guid,
      startSlideIndex: startIndex,
    }));
    if (
      actual.length !== sections.length ||
      actual.some(
        (value, i) =>
          value.name !== sections[i].name ||
          value.id !== sections[i].id ||
          value.startSlideIndex !== sections[i].startSlideIndex,
      )
    )
      throw Error("onlyoffice_product_section_import_conflict");
    return;
  }
  history.TurnOff();
  try {
    model.Sections = sections.map((value) => {
      const section = new window.AscCommonSlide.CPrSection();
      section.setName(value.name);
      section.setGuid(value.id);
      section.setStartIndex(value.startSlideIndex);
      return section;
    });
  } finally {
    history.TurnOn();
  }
}
