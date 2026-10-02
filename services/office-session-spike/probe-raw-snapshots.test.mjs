import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureNativeSnapshots,
  closeNativeProbe,
} from "./probe-raw-snapshots.mjs";

test("native probe captures all available raw phases under one scenario", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-raw-probe-"),
  );
  const previous = process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR;
  process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR = directory;
  try {
    const page = {
      evaluate: async (_callback, label) =>
        label === undefined
          ? {
              nativeCoverageFailure: {
                changedParts: ["ppt/charts/chart1.xml"],
              },
            }
          : label === "native-snapshot-edited"
            ? null
            : [0, 1, 2],
    };
    await captureNativeSnapshots(page, "table-style");
    assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-original.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-no-edit.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    await assert.rejects(
      readFile(
        path.join(directory, "table-style", "native-snapshot-edited.pptx"),
      ),
      /ENOENT/u,
    );
    await assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-preserved.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-coverage-baseline.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(directory, "table-style", "diagnostics.json"),
          "utf8",
        ),
      ),
      { nativeCoverageFailure: { changedParts: ["ppt/charts/chart1.xml"] } },
    );
    await assert.rejects(
      captureNativeSnapshots(page, "../outside"),
      /scope is invalid/u,
    );
  } finally {
    if (previous === undefined) delete process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR;
    else process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("probe cleanup closes the browser even when collection cannot inspect its contexts", async () => {
  let closed = false;
  await closeNativeProbe(
    {
      contexts() {
        throw new Error("context_failure");
      },
      async close() {
        closed = true;
      },
    },
    "chart-data",
  );
  assert.equal(closed, true);
});

test("every declared conformance probe uses the shared evidence collector", async () => {
  const contract = await readFile(
    new URL(
      "../../contracts/native-mutation-conformance.json",
      import.meta.url,
    ),
    "utf8",
  );
  const runner = await readFile(
    new URL("../browser-office/verify-native-conformance.mjs", import.meta.url),
    "utf8",
  );
  const scripts = new Set(
    [
      ...`${contract}\n${runner}`.matchAll(
        /services\/office-session-spike\/probe-[^" ]+\.mjs/gu,
      ),
    ].map(([name]) => name),
  );
  assert(scripts.size > 20);
  for (const script of scripts) {
    const source = await readFile(
      new URL(`../../${script}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /from "\.\/probe-raw-snapshots\.mjs"/, script);
    assert.match(
      source,
      /finally \{\s+await closeNativeProbe\(browser,/,
      script,
    );
  }
});
