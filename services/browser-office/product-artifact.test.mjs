import assert from "node:assert/strict";
import test from "node:test";
import { createProductArtifactAuthority } from "./product-artifact.mjs";
import { assertArtifactMatchesObservation } from "./harness/product-persistence.mjs";
import { onlyOfficePersistenceState } from "./onlyoffice/product-engine.mjs";

function observed(text = "saved") {
  return {
    revision: text,
    slides: [
      {
        slideIndex: 0,
        name: "slide",
        elements: [
          {
            elementId: "0/0",
            kind: "text",
            objectName: "title",
            text,
            x: 10,
            y: 20,
          },
        ],
      },
    ],
    masters: [],
    sections: [],
  };
}
function document(value = 1) {
  return Uint8Array.of(80, 75, value);
}
function authority(options = {}) {
  return createProductArtifactAuthority({
    inspect: async () => observed(),
    ...options,
  });
}
function admit(gate, bytes = document(), modelRevision = "v1", extra = {}) {
  return gate.admit({
    bytes,
    modelRevision,
    verify: (actual) => assertArtifactMatchesObservation(observed(), actual),
    ...extra,
  });
}

test("every artifact consumer refuses bytes without actual inspection and intent proof", async () => {
  const gate = authority();
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
  await gate.inspect(document());
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
  await assert.rejects(
    gate.admit({ bytes: document(), modelRevision: "v1" }),
    /intent_evidence_missing/,
  );
  await admit(gate);
  assert.equal((await gate.require(document(), "v1")).modelRevision, "v1");
});

test("an admitted revision cannot authorize substituted bytes or another live revision", async () => {
  const gate = authority();
  await admit(gate);
  await assert.rejects(gate.require(document(2), "v1"), /not_verified/);
  await assert.rejects(gate.require(document(), "v2"), /not_verified/);
});

test("readback missing the intended text cannot produce an admission", async () => {
  const gate = authority({ inspect: async () => observed("lost") });
  await assert.rejects(admit(gate), /model_not_persisted/);
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
});

test("an omitted non-text field also fails common model readback", async () => {
  const expected = observed();
  expected.slides[0].elements[0].picture = { graphicCrop: { left: 100 } };
  const gate = authority();
  await assert.rejects(
    admit(gate, document(), "v1", {
      verify: (actual) => assertArtifactMatchesObservation(expected, actual),
    }),
    /model_not_persisted/,
  );
});

test("a write during async readback cannot be admitted under the previous digest", async () => {
  const bytes = document();
  const gate = authority({
    inspect: async () => {
      bytes[2] = 3;
      return observed();
    },
  });
  await assert.rejects(admit(gate, bytes), /changed_during_verification/);
});

test("a write inside intent verification also invalidates its evidence", async () => {
  const bytes = document();
  await assert.rejects(
    admit(authority(), bytes, "v1", {
      verify: () => {
        bytes[2] = 4;
      },
    }),
    /changed_during_verification/,
  );
});

test("an inspector cannot substitute its private byte snapshot or poison the cache", async () => {
  let replace = true;
  const gate = authority({
    inspect: async (captured) => {
      if (replace) captured[2] = 9;
      return observed();
    },
  });
  await assert.rejects(admit(gate), /changed_during_verification/);
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
  replace = false;
  await admit(gate);
  await gate.require(document(), "v1");
});

test("intent verification cannot rewrite the persisted-state evidence", async () => {
  const expected = await admit(authority());
  const actual = await admit(authority(), document(), "v1", {
    verify: (observation) => {
      assertArtifactMatchesObservation(observed(), observation);
      observation.slides[0].elements[0].text = "rewritten proof";
    },
  });
  assert.deepEqual(actual, expected);
});

test("recovery re-inspects the file and refuses stale semantic evidence", async () => {
  const receipt = await admit(authority());
  const fresh = authority();
  await admit(fresh, document(), "opened-revision", {
    recoveredReceipt: receipt,
  });
  const stale = { ...receipt, persistedStateSha256: "f".repeat(64) };
  await assert.rejects(
    admit(authority(), document(), "v1", { recoveredReceipt: stale }),
    /recovery_evidence_mismatch/,
  );
  await assert.rejects(
    admit(authority(), document(2), "v1", { recoveredReceipt: receipt }),
    /recovery_evidence_mismatch/,
  );
});

test("ONLYOFFICE recovery includes styles, masters and themes but excludes live revision", async () => {
  const original = observed();
  original.slides[0].elements[0].onlyoffice = { fill: { color: 0xff0000 } };
  original.masters = [{ theme: { fonts: { major: "Aptos" } } }];
  const readback = async (state, recoveredReceipt = null) =>
    admit(
      authority({
        inspect: async () => state,
        persistenceState: onlyOfficePersistenceState,
      }),
      document(),
      "live-revision",
      { verify: () => {}, recoveredReceipt },
    );
  const receipt = await readback(original);
  const changedRevision = structuredClone(original);
  changedRevision.revision = "another-native-session";
  await readback(changedRevision, receipt);
  for (const change of [
    (state) => {
      state.slides[0].elements[0].onlyoffice.fill.color = 0x00ff00;
    },
    (state) => {
      state.masters[0].theme.fonts.major = "Arial";
    },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    await assert.rejects(
      readback(changed, receipt),
      /recovery_evidence_mismatch/,
    );
  }
  assert.equal(original.revision, "saved");
});

test("same exact artifact can reuse inspection while intent is verified on every admission", async () => {
  let reads = 0,
    checks = 0;
  const gate = authority({
    inspect: async () => {
      reads++;
      return observed();
    },
  });
  for (const revision of ["v1", "v2"])
    await admit(gate, document(), revision, {
      verify: (actual) => {
        checks++;
        assertArtifactMatchesObservation(observed(), actual);
        actual.slides[0].elements[0].text = "poison cache";
      },
    });
  assert.equal(reads, 1);
  assert.equal(checks, 2);
});

test("delayed save acknowledgement survives bounded history eviction", async () => {
  const gate = authority({ maximumEntries: 2 });
  await admit(gate);
  const release = await gate.retainSave(document(), "v1");
  for (let index = 2; index < 8; index++)
    await admit(gate, document(index), `v${index}`);
  await gate.require(document(), "v1");
  release();
  await admit(gate, document(8), "v8");
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
});

test("opening another document drops prior artifact authority", async () => {
  const gate = authority();
  await admit(gate);
  gate.clear();
  await assert.rejects(gate.require(document(), "v1"), /not_verified/);
});
