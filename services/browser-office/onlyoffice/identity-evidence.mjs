/* SPDX-License-Identifier: MPL-2.0 */
// These functions execute separately inside the trusted native frame. Native
// history objects never cross the port. Approval covers the captured observation,
// not history added after that observation, and survives native Undo/Redo.
export function captureOnlyOfficeNativeChanges() {
  const history = window.AscCommon.History;
  const model = window.Asc.editor.WordControl.m_oLogicDocument;
  if (
    !Number.isSafeInteger(window.AscDFH.historyitem_CNvPr_SetId) ||
    !history ||
    !Array.isArray(history.Points) ||
    !Number.isSafeInteger(history.Index)
  )
    throw Error("onlyoffice_product_change_token_unavailable");
  const key = Symbol.for("spellbook.onlyoffice.identityEvidence/v1");
  if (window[key]?.model !== model)
    window[key] = { model, approved: new WeakSet(), captures: new Map() };
  const evidence = window[key];
  let count = 0,
    last = null;
  const identities = [];
  const derived=window[Symbol.for("spellbook.onlyoffice.derivedFieldHistory/v1")];
  for (const point of history.Points.slice(0, history.Index + 1))
    for (const item of point.Items) {
      if (
        !Number.isSafeInteger(item.Binary?.Pos) ||
        !Number.isSafeInteger(item.Binary?.Len)
      )
        throw Error("onlyoffice_product_change_token_unavailable");
      // Retain these items in native Undo/Redo; exclude only provider-generated
      // display-cache changes marked by the trusted SDK derivation boundary.
      if(derived?.has(item.Data))continue;
      count++;
      last = item.Binary;
      if (item.Data?.Type === window.AscDFH.historyitem_CNvPr_SetId)
        identities.push(item.Data);
    }
  const token = JSON.stringify([count, last?.Pos ?? null, last?.Len ?? null]);
  evidence.captures.set(token, identities);
  while (evidence.captures.size > 32)
    evidence.captures.delete(evidence.captures.keys().next().value);
  return token;
}

export function approveOnlyOfficeNativeChanges(token) {
  const evidence =
    window[Symbol.for("spellbook.onlyoffice.identityEvidence/v1")];
  if (
    evidence?.model !== window.Asc.editor.WordControl.m_oLogicDocument ||
    !evidence.captures.has(token)
  )
    throw Error("onlyoffice_product_change_evidence_missing");
  for (const data of evidence.captures.get(token)) evidence.approved.add(data);
}

export function verifyOnlyOfficeManualChanges() {
  const evidence =
    window[Symbol.for("spellbook.onlyoffice.identityEvidence/v1")];
  if (evidence?.model !== window.Asc.editor.WordControl.m_oLogicDocument)
    throw Error("onlyoffice_product_change_evidence_missing");
  const history = window.AscCommon.History;
  for (const point of history.Points.slice(0, history.Index + 1))
    for (const item of point.Items)
      if (
        item.Data?.Type === window.AscDFH.historyitem_CNvPr_SetId &&
        !evidence.approved.has(item.Data)
      )
        throw Error("product_unobserved_native_edit:object_identity");
}
