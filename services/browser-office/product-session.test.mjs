/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProductSession } from "./product-session.mjs";

function setup(engineOptions = {}, sessionOptions = {}) {
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
  Object.assign(engine, engineOptions);
  const session = createProductSession({
    engine,
    journal,
    operationContracts: { set: {}, reject: {} },
    validateCommand: (c) => Number.isSafeInteger(c.value),
    ...sessionOptions,
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

test("resource authority failure precedes native preflight and history", async () => {
  const s=setup({}, {prepareResources:async()=>{throw Error("asset_owner_mismatch");}});
  await s.session.open(s.bytes(1));
  await assert.rejects(apply(s,2),/asset_owner_mismatch/);
  assert.deepEqual(s.calls,[]);
  assert.equal((await s.session.observe()).revision,"r1");
  assert.equal(s.record(),null);
});

test("resource preparation receives copies of admitted bytes and requests", async () => {
  const s=setup({}, {prepareResources:async({bytes,observation,commands})=>{
    bytes[2]=9;observation.revision="foreign";commands[0].value=9;
  }});
  await s.session.open(s.bytes(1));
  assert.equal((await apply(s,2)).observation.revision,"r2");
  assert.equal(s.record().candidateBytes[2],2);
});

test("a human edit during asynchronous resource preparation prevents AI history", async () => {
  let release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const s=setup({}, {prepareResources:async()=>{started();await wait;}});
  await s.session.open(s.bytes(1));
  const pending=apply(s,2);
  await ready;s.change(7);release();
  await assert.rejects(pending,/document_changed/);
  assert(!s.calls.includes("begin"));
  assert.equal(s.record(),null);
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

test("the coordinator uses the engine persistence projection for recovery evidence", async () => {
  let theme = "original";
  const s = setup({ persistenceState: (state) => ({ ...state, theme }) });
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  theme = "changed-inspector-contract";
  await assert.rejects(s.session.recover(), /recovery_evidence_mismatch/);
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

test("unobserved native edits cannot save an older file, execute AI or alter recovery", async () => {
  const s = setup();
  let token = "native-base";
  s.engine.changeToken = async () => token;
  await s.session.open(s.bytes(1));
  token = "unobserved-property-change";
  let persisted = false;
  await assert.rejects(s.session.observe(), /product_unobserved_native_edit/);
  await assert.rejects(
    s.session.save(async () => {
      persisted = true;
    }),
    /product_unobserved_native_edit/,
  );
  await assert.rejects(apply(s, 2), /product_unobserved_native_edit/);
  assert.equal(persisted, false);
  assert.deepEqual(s.calls, []);
  assert.equal(s.record(), null);
  token = "native-base"; // The person undoes the unsupported native edit.
  assert.equal((await s.session.observe()).revision, "r1");
  await apply(s, 2);
  assert.equal((await s.session.observe()).revision, "r2");
});

test("mixed observed and unsupported native edits refuse before journal or host writes", async () => {
  let unsupported = false;
  const approvals = [];
  const s = setup({
    changeToken: async () => "captured",
    approveNativeChanges: async (token) => approvals.push(token),
    verifyManualChanges: async () => {
      if (unsupported)
        throw Error("product_unobserved_native_edit:object_identity");
    },
  });
  await s.session.open(s.bytes(1));
  s.change(3);
  unsupported = true;
  await assert.rejects(s.session.observe(), /product_unobserved_native_edit/);
  let written = false;
  await assert.rejects(
    s.session.save(async () => {
      written = true;
    }),
    /product_unobserved_native_edit/,
  );
  await assert.rejects(apply(s, 2), /product_unobserved_native_edit/);
  assert.equal(written, false);
  assert.equal(s.record(), null);
  assert.deepEqual(approvals, ["captured"]);
  unsupported = false;
  s.change(1);
  assert.equal((await s.session.observe()).revision, "r1");
  await apply(s, 2);
  assert.equal((await s.session.observe()).revision, "r2");
});

test("owned native transactions and restored artifact history refresh private change evidence", async () => {
  const s = setup();
  let token = 0;
  s.engine.changeToken = async () => String(token);
  for (const name of ["open", "finish", "undo", "redo"]) {
    const original = s.engine[name];
    s.engine[name] = async (...args) => {
      await original(...args);
      token++;
    };
  }
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  assert.equal((await s.session.observe()).revision, "r2");
  await s.session.undo();
  assert.equal((await s.session.observe()).revision, "r1");
  await s.session.redo();
  assert.equal((await s.session.observe()).revision, "r2");
  await s.session.recover();
  assert.equal((await s.session.observe()).revision, "r2");
});

test("manual artifact finalization is reobserved and never runs on known Undo or Redo", async () => {
  const s = setup();
  await s.session.open(s.bytes(1));
  await apply(s, 2);
  let prepared = 0;
  s.engine.prepareManualCheckpoint = async () => {
    prepared++;
    s.change(4);
    return true;
  };
  s.change(3);
  await s.session.checkpointManual();
  assert.equal(prepared, 1);
  assert.equal(s.record().candidateBytes[2], 4);
  await s.session.undo();
  assert.equal(prepared, 1);
  await s.session.redo();
  assert.equal(prepared, 1);
});

test('export retains dirty state, journal and undo history without an external ACK', async () => {
  const {session} = setup();
  await session.open(new Uint8Array([0x50,0x4b,1]));
  await session.apply({expectedRevision:'r1',commands:[{op:'set',value:2}]});
  const before=session.status();
  const exported=await session.exportCurrentArtifact();
  assert.equal(exported[2],2);
  assert.deepEqual(session.status(),before);
  assert.equal(session.status().modified,true);
});
