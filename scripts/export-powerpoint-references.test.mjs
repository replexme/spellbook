import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildReferenceRenderer,
  ensureHiddenPowerPoint,
  parseRasterSlideName,
  retainNativeReferencePdf,
} from "./export-powerpoint-references.mjs";

test("new reference exports retain the native PDF for font and text geometry diagnostics", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "spellbook-pdf-test-"),
  );
  try {
    const source = path.join(directory, "source.pdf");
    const bytes = Buffer.from("%PDF-1.7\nfixture\n");
    await fs.writeFile(source, bytes);
    await retainNativeReferencePdf(source, directory);
    assert.deepEqual(
      await fs.readFile(path.join(directory, "reference.pdf")),
      bytes,
    );
    assert.deepEqual(await fs.readFile(source), bytes);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("normalizes zero-padded pdftoppm slide names", () => {
  assert.equal(parseRasterSlideName("slide-001.png"), 1);
  assert.equal(parseRasterSlideName("slide-503.PNG"), 503);
  assert.equal(parseRasterSlideName("reference.pdf"), null);
});

test("records the exact PowerPoint and rasterization environment", () => {
  assert.deepEqual(
    buildReferenceRenderer({
      powerPointVersion: "16.109.127.0",
      macOsVersion: "27.0",
      dpi: 144,
    }),
    {
      name: "Microsoft PowerPoint",
      version: "16.109.127.0",
      os: "macOS 27.0",
      exportProcedure:
        "PowerPoint AppleScript save as PDF, then Poppler pdftoppm 144 DPI PNG; one image per slide",
    },
  );
});

test("cold native automation launches hidden before any tell-application count", () => {
  const calls = [];
  let launched = false;
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "open") {
      launched = true;
      return { stdout: "" };
    }
    return {
      stdout: JSON.stringify(
        launched ? [{ pid: 123, hidden: true, active: false }] : [],
      ),
    };
  };
  assert.equal(
    ensureHiddenPowerPoint(run, () => {}),
    true,
  );
  assert.equal(calls[0].command, "osascript");
  assert(calls[0].args.includes("JavaScript"));
  assert.deepEqual(calls[1].args.slice(0, 3), ["-g", "-j", "-a"]);
  assert.equal(
    calls.some((call) =>
      call.args.some((value) => value.includes("tell application")),
    ),
    false,
  );
});
test("existing visible PowerPoint is refused without hiding or launching it", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push(command);
    return {
      stdout: JSON.stringify([{ pid: 123, hidden: false, active: true }]),
    };
  };
  assert.throws(
    () => ensureHiddenPowerPoint(run, () => {}),
    /hidden and inactive/,
  );
  assert.deepEqual(calls, ["osascript"]);
});
test("a cold launched process whose hidden flag was ignored is hidden via AppKit before automation", () => {
  let launched = false, hidden = false;
  const calls = [];
  const run = (command, args) => {
    calls.push({command, args});
    if (command === "open") launched = true;
    if (args.some(arg => arg.includes("runningApplicationWithProcessIdentifier(123)"))) hidden = true;
    return {stdout: JSON.stringify(launched ? [{pid: 123, hidden, active: !hidden}] : [])};
  };
  assert.equal(ensureHiddenPowerPoint(run, () => {}), true);
  assert.equal(hidden, true);
  assert.equal(calls.some(call => call.args.some(arg => arg.includes("tell application"))), false);
});
