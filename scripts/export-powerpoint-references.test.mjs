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
  captureFontEnvironment,
} from "./export-powerpoint-references.mjs";

test("native reference identity changes when a font is installed or replaced", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "spellbook-fonts-test-"),
  );
  try {
    await fs.writeFile(path.join(directory, "layout.ttf"), "first font bytes");
    const first = await captureFontEnvironment([directory]);
    assert.equal(first.files.length, 1);
    await fs.writeFile(path.join(directory, "readme.txt"), "not a font");
    assert.equal(
      (await captureFontEnvironment([directory])).sha256,
      first.sha256,
    );
    await fs.writeFile(
      path.join(directory, "layout.ttf"),
      "replacement font bytes",
    );
    const replaced = await captureFontEnvironment([directory]);
    assert.notEqual(replaced.sha256, first.sha256);
    await fs.writeFile(
      path.join(directory, "additional.otf"),
      "additional font bytes",
    );
    assert.notEqual(
      (await captureFontEnvironment([directory])).sha256,
      replaced.sha256,
    );
    const renderer = buildReferenceRenderer({
      powerPointVersion: "16",
      macOsVersion: "27",
      dpi: 144,
      fontEnvironmentSha256: first.sha256,
    });
    assert.equal(renderer.fontEnvironmentSha256, first.sha256);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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
  let launched = false,
    hidden = false;
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "open") launched = true;
    if (
      args.some((arg) =>
        arg.includes("runningApplicationWithProcessIdentifier(123)"),
      )
    )
      hidden = true;
    return {
      stdout: JSON.stringify(
        launched ? [{ pid: 123, hidden, active: !hidden }] : [],
      ),
    };
  };
  assert.equal(
    ensureHiddenPowerPoint(run, () => {}),
    true,
  );
  assert.equal(hidden, true);
  assert.equal(
    calls.some((call) =>
      call.args.some((arg) => arg.includes("tell application")),
    ),
    false,
  );
});

test("counts ordered strict slides and exposes hidden slides only in the capture copy", async () => {
  const { zipSync, unzipSync, strToU8, strFromU8 } = await import("fflate");
  const { presentationSlideCount, preparePowerPointRenderSource } =
    await import("./export-powerpoint-references.mjs");
  const ns = "http://purl.oclc.org/ooxml/presentationml/main",
    r = "http://purl.oclc.org/ooxml/officeDocument/relationships";
  const parts = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation xmlns:p="${ns}" xmlns:r="${r}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p:sldIdLst><p:sldId id="256" r:id="one"/><p:sldId id="257" r:id="two"/></p:sldIdLst><p:extLst><p:ext uri="section"><p14:sldId id="256"/></p:ext></p:extLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="one" Target="slides/slide1.xml"/><Relationship Id="two" Target="/ppt/slides/slide2.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:p="${ns}" show="false"/>`),
    "ppt/slides/slide2.xml": strToU8(`<p:sld xmlns:p="${ns}" show="0"/>`),
    "ppt/slides/unused.xml": strToU8(`<p:sld xmlns:p="${ns}" show="0"/>`),
  };
  const original = zipSync(parts),
    snapshot = original.slice();
  assert.equal(presentationSlideCount(original), 2);
  const rendered = preparePowerPointRenderSource(original),
    output = unzipSync(rendered.bytes);
  assert.deepEqual(rendered.hiddenSlideIndexes, [0, 1]);
  assert.deepEqual(original, snapshot);
  for (const n of ["slide1", "slide2"])
    assert.match(strFromU8(output["ppt/slides/" + n + ".xml"]), /show="1"/);
  assert.deepEqual(
    output["ppt/slides/unused.xml"],
    parts["ppt/slides/unused.xml"],
  );
});
