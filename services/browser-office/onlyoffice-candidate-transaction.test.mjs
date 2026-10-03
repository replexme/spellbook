/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCandidateTransaction,
  finishCandidateTransaction,
} from "./onlyoffice/candidate-transaction.mjs";

function fixture({
  redo = false,
  busy = false,
  refuseRollback = false,
  leakedLock = false,
} = {}) {
  const calls = [];
  const h = {
    Index: -1,
    Points: [],
    SavedIndex: null,
    UserSavedIndex: null,
    TurnOffHistory: 0,
    UndoRedoInProgress: false,
    Can_Redo: () => redo,
    Is_LastPointEmpty: () => false,
    Get_RecalcData: (_, changes) => {
      calls.push(["recalc-data", changes]);
      return changes;
    },
    getGroupChanges: () => ["native-undo"],
    resetGroupChanges: () => calls.push("reset-group"),
  };
  const a = {
    groupActionsCounter: Number(busy),
    isGroupActions() {
      return this.groupActionsCounter > 0;
    },
    startGroupActions() {
      calls.push("begin");
      this.groupActionsCounter++;
      h.Index++;
      h.Points.push({});
    },
    executeGroupActionsStart: () => calls.push("execute"),
    cancelGroupActions() {
      calls.push("cancel");
      this.groupActionsCounter--;
      if (!refuseRollback) {
        h.Index--;
        h.Points.pop();
      }
    },
    endGroupActions() {
      calls.push("commit");
      this.groupActionsCounter--;
    },
    WordControl: {
      m_oLogicDocument: {
        Recalculate: (changes) => calls.push(["recalculate", changes]),
        Document_UpdateSelectionState: () => calls.push("selection"),
        Document_UpdateInterfaceState: () => calls.push("interface"),
      },
    },
  };
  const globals = {
    window: globalThis.window,
    AscCommon: globalThis.AscCommon,
  };
  globalThis.AscCommon = {
    History: h,
    CollaborativeEditing: { Get_GlobalLock: () => leakedLock },
  };
  globalThis.window = { Asc: { editor: a }, AscCommon: globalThis.AscCommon };
  return {
    calls,
    a,
    h,
    frame: { evaluate: async (fn, value) => fn(value) },
    cleanup() {
      Object.assign(globalThis, globals);
    },
  };
}

test("preflight refuses busy sessions and an unadmitted Redo branch before changing native history", async () => {
  for (const options of [{ busy: true }, { redo: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(
        beginCandidateTransaction(f.frame),
        /candidate_transaction_(busy|redo_branch_not_admitted)/,
      );
      assert.deepEqual(f.calls, []);
    } finally {
      f.cleanup();
    }
  }
});

test("native cancellation uses its own undo changes and verifies release and history restoration", async () => {
  const f = fixture();
  try {
    const checkpoint = await beginCandidateTransaction(f.frame);
    assert.equal(checkpoint.index, -1);
    const result = await finishCandidateTransaction(f.frame, checkpoint, false);
    assert.equal(result.points, 0);
    assert.deepEqual(f.calls, [
      "begin",
      "execute",
      "cancel",
      ["recalc-data", ["native-undo"]],
      ["recalculate", ["native-undo"]],
      "reset-group",
      "selection",
      "interface",
    ]);
  } finally {
    f.cleanup();
  }
});

test("a native cancellation which leaves changed history or a lock cannot be reported as recovered", async () => {
  for (const options of [{ refuseRollback: true }, { leakedLock: true }]) {
    const f = fixture(options);
    try {
      const checkpoint = await beginCandidateTransaction(f.frame);
      await assert.rejects(
        finishCandidateTransaction(f.frame, checkpoint, false),
        /candidate_transaction_(rollback_history_mismatch|lock_not_released)/,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("a lost or nested group cannot cancel someone else's history", async () => {
  const f = fixture();
  try {
    const checkpoint = await beginCandidateTransaction(f.frame);
    f.a.groupActionsCounter = 2;
    await assert.rejects(
      finishCandidateTransaction(f.frame, checkpoint, false),
      /native_scope_lost/,
    );
    assert.deepEqual(f.calls, ["begin", "execute"]);
  } finally {
    f.cleanup();
  }
});

test("commit requires one nonempty native history point", async () => {
  const f = fixture();
  try {
    const checkpoint = await beginCandidateTransaction(f.frame);
    f.h.Is_LastPointEmpty = () => true;
    await assert.rejects(
      finishCandidateTransaction(f.frame, checkpoint, true),
      /commit_history_mismatch/,
    );
  } finally {
    f.cleanup();
  }
});


test("native Redo capability permits cancellation while verifying Redo and ForceSave", async () => {
  const f = fixture({redo:true});
  try {
    f.h.spellbookGroupRedoRollbackVersion=1;
    f.h.ForceSave=true;
    const checkpoint=await beginCandidateTransaction(f.frame);
    assert.equal(checkpoint.canRedo,true);
    assert.equal((await finishCandidateTransaction(f.frame,checkpoint,false)).canRedo,true);
    const next=await beginCandidateTransaction(f.frame);
    f.h.ForceSave=false;
    await assert.rejects(finishCandidateTransaction(f.frame,next,false),/rollback_history_mismatch/);
  } finally {f.cleanup()}
});
