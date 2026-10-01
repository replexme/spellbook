import assert from "node:assert/strict";
import test from "node:test";

import { openBrowserDocumentJournal } from "./opfs-journal.mjs";
import { createProductArtifactAuthority } from "./product-artifact.mjs";

test("a journal retains byte-bound readback evidence and refuses a receipt for another package", async () => {
  const root = new MemoryDirectory();
  const journal = await openBrowserDocumentJournal({
    identity: "verified-artifact",
    root,
  });
  const candidateBytes = bytes(1, 2, 3);
  const gate = createProductArtifactAuthority({
    inspect: async () => ({ slides: [{ elements: [] }] }),
  });
  const artifactReceipt = await gate.admit({
    bytes: candidateBytes,
    modelRevision: "v1",
    verify: () => {},
  });
  await journal.save({
    fileName: "deck.pptx",
    baseBytes: bytes(1),
    candidateBytes,
    commands: [],
    artifactReceipt,
  });
  assert.deepEqual(
    (await journal.load()).metadata.artifactReceipt,
    artifactReceipt,
  );
  await assert.rejects(
    journal.save({
      fileName: "deck.pptx",
      baseBytes: bytes(1),
      candidateBytes: bytes(7),
      commands: [],
      artifactReceipt,
    }),
    /evidence does not match/,
  );
  assert.equal((await journal.load()).metadata.generation, 1);
});

test("OPFS journal restores the newest complete browser checkpoint", async () => {
  const root = new MemoryDirectory();
  const journal = await openBrowserDocumentJournal({
    identity: "account/document/version-1",
    root,
  });
  await journal.save({
    fileName: "deck.pptx",
    baseVersionId: "version-1",
    baseBytes: bytes(1, 2),
    candidateBytes: bytes(1, 2, 3),
    commands: [{ op: "add_slide" }],
  });
  await journal.save({
    fileName: "deck.pptx",
    baseVersionId: "version-1",
    baseBytes: bytes(1, 2),
    candidateBytes: bytes(1, 2, 3, 4),
    commands: [{ op: "add_slide" }, { op: "rename_slide" }],
  });

  const restored = await journal.load();
  assert.equal(restored.metadata.generation, 2);
  assert.deepEqual(restored.metadata.commands, [
    { op: "add_slide" },
    { op: "rename_slide" },
  ]);
  assert.deepEqual(restored.candidateBytes, bytes(1, 2, 3, 4));
});

test("OPFS journal falls back after a torn newest-slot write", async () => {
  const root = new MemoryDirectory();
  const journal = await openBrowserDocumentJournal({
    identity: "account/document/version-2",
    root,
  });
  await journal.save({
    fileName: "deck.pptx",
    baseBytes: bytes(7),
    candidateBytes: bytes(7, 8),
    commands: [{ op: "add_slide" }],
  });
  await journal.save({
    fileName: "deck.pptx",
    baseBytes: bytes(7),
    candidateBytes: bytes(7, 8, 9),
    commands: [{ op: "add_slide" }, { op: "move_slide" }],
  });
  const namespace = root.directory("spellbook-browser-office-v1");
  const document = [...namespace.directories.values()][0];
  document.file("candidate-a.pptx").data = bytes(0xff);

  const restored = await journal.load();
  assert.equal(restored.metadata.generation, 1);
  assert.deepEqual(restored.candidateBytes, bytes(7, 8));
});

test("OPFS journal clear removes both commit slots", async () => {
  const root = new MemoryDirectory();
  const journal = await openBrowserDocumentJournal({
    identity: "account/document/version-3",
    root,
  });
  await journal.save({
    fileName: "deck.pptx",
    baseBytes: bytes(4),
    candidateBytes: bytes(4, 5),
    commands: [],
  });
  await journal.clear();
  assert.equal(await journal.load(), null);
});

function bytes(...values) {
  return Uint8Array.from(values);
}

class MemoryDirectory {
  directories = new Map();
  files = new Map();

  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name)) {
      if (!options.create) throw notFound();
      this.directories.set(name, new MemoryDirectory());
    }
    return this.directories.get(name);
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw notFound();
      this.files.set(name, new MemoryFile());
    }
    return this.files.get(name);
  }

  async removeEntry(name) {
    if (!this.files.delete(name)) throw notFound();
  }

  directory(name) {
    return this.directories.get(name);
  }

  file(name) {
    return this.files.get(name);
  }
}

class MemoryFile {
  data = new Uint8Array();

  async getFile() {
    return new Blob([this.data]);
  }

  async createWritable() {
    let next = new Uint8Array();
    return {
      write: async (value) => {
        next = new Uint8Array(value).slice();
      },
      close: async () => {
        this.data = next;
      },
      abort: async () => undefined,
    };
  }
}

function notFound() {
  return new DOMException("Not found", "NotFoundError");
}
