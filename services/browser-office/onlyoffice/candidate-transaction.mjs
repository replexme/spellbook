/* SPDX-License-Identifier: MPL-2.0 */
// Diagnostic adapter for the pinned presentation SDK. Product admission remains
// separate. A Redo branch requires the provider's explicit rollback capability.
export async function beginCandidateTransaction(frame) {
  return frame.evaluate(() => {
    const a = window.Asc.editor,
      h = window.AscCommon.History;
    if (a.isGroupActions() || h.UndoRedoInProgress || h.TurnOffHistory !== 0)
      throw new Error("candidate_transaction_busy");
    if (h.Can_Redo() && h.spellbookGroupRedoRollbackVersion !== 1)
      throw new Error("candidate_transaction_redo_branch_not_admitted");
    if (
      ![
        "startGroupActions",
        "executeGroupActionsStart",
        "cancelGroupActions",
        "endGroupActions",
      ].every((k) => typeof a[k] === "function")
    )
      throw new Error("candidate_transaction_native_api_unavailable");
    const checkpoint = {
      index: h.Index,
      points: h.Points.length,
      savedIndex: h.SavedIndex,
      userSavedIndex: h.UserSavedIndex,
      forceSave: h.ForceSave,
      canRedo: h.Can_Redo(),
    };
    a.startGroupActions();
    a.executeGroupActionsStart();
    return checkpoint;
  });
}

export async function finishCandidateTransaction(frame, checkpoint, commit) {
  return frame.evaluate(
    ({ checkpoint, commit }) => {
      const a = window.Asc.editor,
        h = window.AscCommon.History,
        m = a.WordControl.m_oLogicDocument;
      if (a.groupActionsCounter !== 1)
        throw new Error("candidate_transaction_native_scope_lost");
      if (commit) {
        a.endGroupActions();
        if (h.Index !== checkpoint.index + 1 || h.Is_LastPointEmpty())
          throw new Error("candidate_transaction_commit_history_mismatch");
      } else {
        a.cancelGroupActions();
        // The pinned presentation API has no _onEndGroupActions override. Use
        // native cancellation's own change list, as Document_Undo does, then
        // verify the full readback outside this boundary.
        m.Recalculate(h.Get_RecalcData(null, h.getGroupChanges()));
        h.resetGroupChanges();
        m.Document_UpdateSelectionState();
        m.Document_UpdateInterfaceState();
        if (
          h.Index !== checkpoint.index ||
          h.Points.length !== checkpoint.points ||
          h.Can_Redo() !== checkpoint.canRedo ||
          h.SavedIndex !== checkpoint.savedIndex ||
          h.UserSavedIndex !== checkpoint.userSavedIndex ||
          h.ForceSave !== checkpoint.forceSave
        )
          throw new Error("candidate_transaction_rollback_history_mismatch");
      }
      if (a.isGroupActions() || AscCommon.CollaborativeEditing.Get_GlobalLock())
        throw new Error("candidate_transaction_lock_not_released");
      return {
        nativeGroupClosed: true,
        index: h.Index,
        points: h.Points.length,
        canRedo: h.Can_Redo(),
      };
    },
    { checkpoint, commit },
  );
}
