/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeLocalOfficeFile, localOfficeIdentity } from "./local-file.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function file(initial, { closeFails = false, corrupt = false } = {}) {
  let bytes = initial.slice(),
    writes = 0,
    aborted = false;
  return {
    get writes() {
      return writes;
    },
    get aborted() {
      return aborted;
    },
    get bytes() {
      return bytes;
    },
    getFile: async () => new Blob([bytes]),
    createWritable: async () => {
      let pending;
      writes++;
      return {
        write: async (value) => {
          pending = value.slice();
        },
        close: async () => {
          if (closeFails) throw Error("disk_full");
          bytes = corrupt ? new Uint8Array([9]) : pending;
        },
        abort: async () => {
          aborted = true;
        },
      };
    },
  };
}
test("external file change is rejected before acquiring a writable stream", async () => {
  const h = file(new Uint8Array([2])),
    candidate = new Uint8Array([3]);
  await assert.rejects(
    writeLocalOfficeFile(
      h,
      candidate,
      sha(candidate),
      sha(new Uint8Array([1])),
    ),
    /밖에서 변경/,
  );
  assert.equal(h.writes, 0);
  assert.deepEqual([...h.bytes], [2]);
});
test("durability requires close and independently read-back bytes", async () => {
  const h = file(new Uint8Array([1])),
    candidate = new Uint8Array([3]);
  assert.deepEqual(
    await writeLocalOfficeFile(h, candidate, sha(candidate), sha(h.bytes)),
    { sha256: sha(candidate), byteLength: 1 },
  );
  const bad = file(new Uint8Array([1]), { corrupt: true });
  await assert.rejects(
    writeLocalOfficeFile(bad, candidate, sha(candidate)),
    /readback_mismatch/,
  );
});
test("disk-full close failure retains original and aborts write", async () => {
  const h = file(new Uint8Array([1]), { closeFails: true }),
    candidate = new Uint8Array([3]);
  await assert.rejects(
    writeLocalOfficeFile(h, candidate, sha(candidate)),
    /disk_full/,
  );
  assert.equal(h.aborted, true);
  assert.deepEqual([...h.bytes], [1]);
});
test("a corrupted candidate never touches the destination", async () => {
  const h = file(new Uint8Array([1]));
  await assert.rejects(
    writeLocalOfficeFile(h, new Uint8Array([3]), sha(new Uint8Array([4]))),
    /artifact_changed/,
  );
  assert.equal(h.writes, 0);
});

test("local file identity refuses oversized input before reading and rejects a non-package", async () => {
  let read = false;
  await assert.rejects(
    localOfficeIdentity({
      size: 67108865,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    }),
    /64MB/,
  );
  assert.equal(read, false);
  await assert.rejects(
    localOfficeIdentity(new Blob([new Uint8Array([1, 2, 3])])),
    /PPTX/,
  );
  const result = await localOfficeIdentity(
    new Blob([new Uint8Array([0x50, 0x4b, 1])]),
  );
  assert.equal(result.bytes.length, 3);
  assert.equal(result.sha256, sha(result.bytes));
});
