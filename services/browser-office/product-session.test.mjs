/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProductSession } from "./product-session.mjs";

function setup() {
  let value = 1,
    prepared = false,
    transaction = null,
    nativeUndo = [],
    nativeRedo = [];
  let stored = null;
  const calls = [];
  const observation = (v) => ({
    revision: "r" + v,
    slides: [
      {
        slideIndex: 0,
        name: "slide",
        elements: [{ elementId: "shape", kind: "text", text: String(v) }],
      },
    ],
    masters: [],
    sections: [],
  });
  const engine = {
    open: async (bytes) => {
      value = bytes[2];
      nativeUndo = [];
      nativeRedo = [];
    },
    observe: async () => observation(value),
    inspect: async (bytes) => observation(bytes[2]),
    verifyIntent: async (_, after, commands) => {
      if (after.revision !== "r" + commands.at(-1).value)
        throw Error("intent_mismatch");
    },
    preflight: async (commands) => {
      calls.push("preflight");
      if (commands.some((c) => c.op === "reject"))
        throw Error("unsupported_target");
      prepared = true;
      return commands;
    },
    begin: async () => {
      assert(prepared);
      prepared = false;
      calls.push("begin");
      transaction = { value, redo: nativeRedo.slice() };
      return transaction;
    },
    apply: async (command) => {
      calls.push("apply");
      value = command.value;
      if (command.fail) throw Error("native_failure");
    },
    finish: async (_, commit) => {
      calls.push(commit ? "commit" : "rollback");
      if (commit) {
        nativeUndo.push(transaction.value);
        nativeRedo = [];
      } else {
        value = transaction.value;
        nativeRedo = transaction.redo;
      }
      transaction = null;
    },
    snapshot: async () => Uint8Array.of(80, 75, value),
    undo: async () => {
      nativeRedo.push(value);
      value = nativeUndo.pop();
    },
    redo: async () => {
      nativeUndo.push(value);
      value = nativeRedo.pop();
    },
  };
  const journal = {
    save: async (record) => {
      stored = structuredClone({
        metadata: {
          commands: record.commands,
          commandGroups: record.commandGroups,
          appliedGroups: record.appliedGroups,
          artifactReceipt: record.artifactReceipt,
          productHistory: record.history,
        },
        baseBytes: record.baseBytes,
        candidateBytes: record.candidateBytes,
        historyArtifacts: record.historyArtifacts,
      });
    },
    load: async () => structuredClone(stored),
    clear: async () => {
      stored = null;
    },
  };
  const session = createProductSession({
    engine,
    journal,
    operationContracts: { set: {}, reject: {} },
    validateCommand: (c) => Number.isSafeInteger(c.value),
  });
  return {
    session,
    engine,
    journal,
    calls,
    observation,
    record: () => stored,
    change: (v) => {
      value = v;
    },
    bytes: (v) => Uint8Array.of(80, 75, v),
  };
}
const apply = (s, value, extra = {}) =>
  s.session.apply({
    expectedRevision: "r" + (value - 1),
    commands: [{ op: "set", value, ...extra }],
  });

test("full batch preflight rejects its last target before any native edit/history", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await assert.rejects(
    s.session.apply({
      expectedRevision: "r1",
      commands: [
        { op: "set", value: 2 },
        { op: "reject", value: 3 },
      ],
    }),
    /unsupported_target/,
  );
  assert.deepEqual(s.calls, ["preflight"]);
  assert.equal((await s.session.observe()).revision, "r1");
  assert.equal(s.record(), null);
});
test("stale observation and unknown operation are refused before target binding", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await assert.rejects(
    s.session.apply({
      expectedRevision: "old",
      commands: [{ op: "set", value: 2 }],
    }),
    /stale/,
  );
  await assert.rejects(
    s.session.apply({
      expectedRevision: "r1",
      commands: [{ op: "invented", value: 2 }],
    }),
    /contract/,
  );
  assert.deepEqual(s.calls, []);
});
test("native partial failure preserves the existing Redo branch and journal", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  await s.session.undo();
  const old = structuredClone(s.record());
  await assert.rejects(apply(s, 3, { fail: true }), /product_command_stale/);
  await assert.rejects(
    s.session.apply({
      expectedRevision: "r1",
      commands: [{ op: "set", value: 3, fail: true }],
    }),
    /native_failure/,
  );
  assert.deepEqual(s.record(), old);
  assert.equal(s.session.status().redo, 1);
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r2");
});
test("a setter that exports the wrong document rolls back and cannot become a checkpoint", async () => {
  const s = setup();
  s.engine.snapshot = async () => s.bytes(9);
  await s.session.open(s.bytes(1));
  await assert.rejects(apply(s, 2), /model_not_persisted/);
  assert.equal((await s.session.observe()).revision, "r1");
  assert.equal(s.record(), null);
  assert.equal(s.session.status().undo, 0);
});
test("only an acknowledgement for the inspected file can clear recovery state", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  await assert.rejects(
    s.session.save(async () => ({ candidateSha256: "wrong" })),
    /acknowledgement/,
  );
  assert.ok(s.record());
  await assert.rejects(
    s.session.save(async () => {
      throw Error("disk_full");
    }),
    /disk_full/,
  );
  assert.ok(s.record());
  const receipt = await s.session.save(async (bytes, receipt) => {
    bytes[2] = 99;
    return { candidateSha256: receipt.candidateSha256 };
  });
  assert.equal(receipt.modelRevision, "r2");
  assert.equal(s.record(), null);
  assert.equal((await s.session.observe()).revision, "r2");
});
test("human edits during a pending save do not clear the recovery checkpoint", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  await assert.rejects(
    s.session.save(async (_, receipt) => {
      s.change(3);
      return { candidateSha256: receipt.candidateSha256 };
    }),
    /document_changed/,
  );
  assert.ok(s.record());
  assert.equal(s.session.status().commands, 1);
});
test("recovery reads back the exact retained package and rejects replaced bytes", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  s.change(1);
  assert.equal((await s.session.recover()).revision, "r2");
  s.record().candidateBytes[2] = 8;
  await assert.rejects(s.session.recover(), /recovery|evidence/);
});
test("requests serialize and cannot both apply from one observed revision", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  const a = apply(s, 2),
    b = apply(s, 2);
  await a;
  await assert.rejects(b, /stale/);
  assert.equal(s.calls.filter((c) => c === "apply").length, 1);
});

test("recovery recreates batch boundaries and an existing Redo branch", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await s.session.apply({
    expectedRevision: "r1",
    commands: [
      { op: "set", value: 2 },
      { op: "set", value: 3 },
    ],
  });
  await s.session.apply({
    expectedRevision: "r3",
    commands: [{ op: "set", value: 4 }],
  });
  await s.session.undo();
  await s.session.recover();
  assert.deepEqual(s.session.status(), {
    ready: true,
    modified: true,
    commands: 2,
    undo: 1,
    redo: 1,
  });
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r4");
  await s.session.undo();
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
});
test("journal failure before native commit preserves the old Redo branch", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  await s.session.undo();
  const old = s.record(),
    save = s.journal.save;
  s.journal.save = async () => {
    throw Error("disk_full");
  };
  await assert.rejects(
    s.session.apply({
      expectedRevision: "r1",
      commands: [{ op: "set", value: 3 }],
    }),
    /disk_full/,
  );
  assert.deepEqual(s.record(), old);
  assert.equal(s.session.status().ready, true);
  s.journal.save = save;
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r2");
});

test("bounded history advances the recovery base without losing retained batches", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  for (let value = 2; value <= 36; value++) await apply(s, value);
  assert.equal(s.session.status().undo, 32);
  assert.equal(s.record().baseBytes[2], 4);
  assert.equal(s.record().metadata.commands.length, 32);
  await s.session.recover();
  for (let index = 0; index < 32; index++) await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r4");
  assert.equal(await s.session.undo(), false);
});

test("human edits retain earlier AI Undo and survive recovery with a Redo branch", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  s.change(3);
  await s.session.checkpointManual();
  s.change(4);
  await s.session.checkpointManual();
  assert.equal(s.session.status().undo, 2);
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r2");
  await s.session.recover();
  assert.equal(s.session.status().redo, 1);
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r4");
  await s.session.undo();
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
});
test("a failed human checkpoint keeps the last approved bytes and can be retried", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  s.change(3);
  const old = s.record(),
    save = s.journal.save;
  s.journal.save = async () => {
    throw Error("disk_full");
  };
  await assert.rejects(s.session.checkpointManual(), /disk_full/);
  assert.deepEqual(s.record(), old);
  s.journal.save = save;
  await s.session.checkpointManual();
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r2");
});

test("acknowledged save preserves Undo and a later recovery base", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  await s.session.save(async (_, r) => ({
    candidateSha256: r.candidateSha256,
  }));
  assert.equal(s.session.status().modified, false);
  assert.equal(s.session.status().undo, 1);
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
  assert.equal(s.session.status().modified, true);
  await s.session.recover();
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r2");
  assert.equal(s.session.status().modified, false);
  await apply(s, 3);
  await s.session.recover();
  await s.session.undo();
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
});

test("native user Undo and Redo reuse exact approved files and request boundaries", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await s.session.apply({
    expectedRevision: "r1",
    commands: [
      { op: "set", value: 2 },
      { op: "set", value: 3 },
    ],
  });
  const snapshot = s.engine.snapshot;
  s.engine.snapshot = async () => {
    throw Error("known_history_must_not_export");
  };
  await s.engine.undo();
  await s.session.observe();
  assert.equal(s.session.status().undo, 0);
  assert.equal(s.session.status().redo, 1);
  await s.engine.redo();
  await s.session.observe();
  assert.equal(s.session.status().undo, 1);
  assert.equal(s.session.status().redo, 0);
  s.engine.snapshot = snapshot;
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
});

test("a ignored setter cannot report a successful no-op for a different requested value", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  s.engine.apply = async () => {};
  await assert.rejects(apply(s, 2), /intent_mismatch/);
  assert.equal(s.record(), null);
  assert.equal(s.session.status().undo, 0);
});
