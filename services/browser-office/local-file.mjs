/* SPDX-License-Identifier: MPL-2.0 */
// File writes and OPFS recovery are separate durability boundaries. Only a
// completed, read-back file write acknowledges the editor's exact artifact.
export async function writeLocalOfficeFile(
  handle,
  bytes,
  expectedSha256,
  baseSha256 = null,
) {
  if (
    !handle ||
    typeof handle.createWritable !== "function" ||
    !(bytes instanceof Uint8Array)
  )
    throw Error("local_file_write_invalid");
  const digest = async (value) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
  if ((await digest(bytes)) !== expectedSha256)
    throw Error("local_file_artifact_changed");
  if (
    baseSha256 !== null &&
    (await digest(await (await handle.getFile()).arrayBuffer())) !== baseSha256
  )
    throw Error(
      "선택한 파일이 밖에서 변경됐습니다. 다른 이름으로 저장해 두 사본을 보존하세요",
    );
  const stream = await handle.createWritable({ mode: "exclusive" });
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    await stream.abort?.().catch(() => {});
    throw error;
  }
  const actual = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  if ((await digest(actual)) !== expectedSha256)
    throw Error("local_file_readback_mismatch");
  return { sha256: expectedSha256, byteLength: actual.length };
}

export async function localOfficeIdentity(file) {
  if (
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > 64 * 1024 * 1024
  )
    throw Error("64MB 이하의 PPTX 파일을 선택해 주세요");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw Error("PPTX 파일 형식을 확인해 주세요");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  // Filename alone is not ownership. Different files with the same name never
  // acquire another document's recovery journal.
  return { bytes, sha256: digest, documentId: `local:${digest}` };
}

async function localHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("spellbook-local-files", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("documents", { keyPath: "documentId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberLocalOfficeHandle(documentId, handle, sha256) {
  const database = await localHandleDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      const store = transaction.objectStore("documents");
      const record = store.get(documentId);
      record.onsuccess = () =>
        store.put({
          ...record.result,
          documentId,
          handle,
          sha256,
          name: handle.name,
        });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? Error("local_handle_record_aborted"));
    });
  } finally {
    database.close();
  }
}

export async function openLocalOfficeHandle(handle) {
  const file = await handle.getFile(),
    identity = await localOfficeIdentity(file),
    database = await localHandleDatabase();
  let records;
  try {
    records = await new Promise((resolve, reject) => {
      const request = database
        .transaction("documents", "readonly")
        .objectStore("documents")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
  for (const record of records) {
    if (await handle.isSameEntry(record.handle))
      return { ...identity, name: file.name, documentId: record.documentId };
  }
  const documentId = "local:" + crypto.randomUUID();
  await rememberLocalOfficeHandle(documentId, handle, identity.sha256);
  return { ...identity, name: file.name, documentId };
}

// Goal/history stay beside the local file handle and retain its document scope.
export async function localOfficeAIState(documentId, state) {
  const database = await localHandleDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        "documents",
        state === undefined ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("documents"),
        record = store.get(documentId);
      let value;
      record.onsuccess = () => {
        value = record.result?.aiState ?? null;
        if (state !== undefined) {
          if (!record.result) {
            transaction.abort();
            return;
          }
          value = state;
          store.put({ ...record.result, aiState: state });
        }
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? Error("local_ai_state_record_aborted"));
    });
  } finally {
    database.close();
  }
}
