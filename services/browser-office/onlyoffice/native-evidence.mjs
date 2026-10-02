/* SPDX-License-Identifier: MPL-2.0 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

// Diagnostic evidence uses the candidate's own pinned canonicalizer. Do not
// maintain another parser or treat derived native bytes as authored OOXML.
const canonicalizers = new Map();
export async function readCandidateNativeEvidence(frame, candidateRoot) {
  const source = await readFile(
    path.join(candidateRoot, "src/lib/native-save-identity.ts"),
    "utf8",
  );
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  let canonicalize = canonicalizers.get(sourceSha256);
  if (!canonicalize) {
    const { code } = await transform(source, { loader: "ts", format: "esm" });
    ({ nativeSaveContentIdentity: canonicalize } = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    ));
    canonicalizers.set(sourceSha256, canonicalize);
  }
  const native = await frame.evaluate(() => {
    const a = window.Asc.editor,
      h = window.AscCommon.History;
    const payload = a.asc_nativeGetFile3(),
      data = payload?.data ?? payload;
    // The presentation SDK returns a binary/base64 string; Array.from alone
    // would turn characters into numeric zeroes when constructing a Buffer.
    let bytes;
    if (typeof data === "string")
      bytes = Array.from(data, (value) => value.charCodeAt(0) & 255);
    else if (data instanceof ArrayBuffer)
      bytes = Array.from(new Uint8Array(data));
    else if (ArrayBuffer.isView(data))
      bytes = Array.from(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    else if (Array.isArray(data)) bytes = data.map((value) => value & 255);
    else throw new Error("candidate_native_evidence_unavailable");
    if (!bytes.length) throw new Error("candidate_native_evidence_empty");
    return {
      bytes,
      index: h.Index,
      points: h.Points.length,
      savedIndex: h.SavedIndex,
      userSavedIndex: h.UserSavedIndex,
      forceSave: h.ForceSave,
      haveChanges: h.Have_Changes(),
      modified: a.isDocumentModified(),
    };
  });
  const identity = canonicalize(Uint8Array.from(native.bytes));
  delete native.bytes;
  return {
    ...native,
    contentBytes: identity.length,
    contentSha256: createHash("sha256").update(identity).digest("hex"),
    canonicalizerSourceSha256: sourceSha256,
  };
}
