/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCandidateNativeEvidence } from "./onlyoffice/native-evidence.mjs";

test("native evidence preserves strings, signed bytes and view boundaries; it rejects absent exports", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "candidate-native-evidence-"),
  );
  const prior = globalThis.window;
  try {
    await mkdir(path.join(root, "src/lib"), { recursive: true });
    await writeFile(
      path.join(root, "src/lib/native-save-identity.ts"),
      "export function nativeSaveContentIdentity(input: Uint8Array) { return input; }",
    );
    const expected = new Uint8Array([65, 49, 255]);
    const view = new Uint8Array([0, ...expected, 0]).subarray(1, 4);
    for (const data of [
      "A1\xff",
      [65, 49, -1],
      expected.buffer,
      view,
      new DataView(view.buffer, 1, 3),
    ]) {
      globalThis.window = {
        Asc: {
          editor: {
            asc_nativeGetFile3: () => ({ data }),
            isDocumentModified: () => false,
          },
        },
        AscCommon: {
          History: {
            Index: -1,
            Points: [],
            SavedIndex: null,
            UserSavedIndex: null,
            ForceSave: false,
            Have_Changes: () => false,
          },
        },
      };
      const evidence = await readCandidateNativeEvidence(
        { evaluate: async (fn) => fn() },
        root,
      );
      assert.equal(evidence.contentBytes, 3);
      assert.equal(
        evidence.contentSha256,
        createHash("sha256").update(expected).digest("hex"),
      );
      assert.equal(evidence.haveChanges, false);
    }
    for (const data of [null, {}, new Uint8Array()]) {
      window.Asc.editor.asc_nativeGetFile3 = () => ({ data });
      await assert.rejects(
        readCandidateNativeEvidence({ evaluate: async (fn) => fn() }, root),
        /candidate_native_evidence_(unavailable|empty)/,
      );
    }
    await writeFile(
      path.join(root, "src/lib/native-save-identity.ts"),
      "export function nativeSaveContentIdentity() { throw Error('unknown native format'); }",
    );
    window.Asc.editor.asc_nativeGetFile3 = () => ({ data: expected });
    await assert.rejects(
      readCandidateNativeEvidence({ evaluate: async (fn) => fn() }, root),
      /unknown native format/,
    );
  } finally {
    globalThis.window = prior;
    await rm(root, { recursive: true, force: true });
  }
});
