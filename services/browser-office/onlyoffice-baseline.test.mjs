import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { captureStableOnlyOfficeBaseline } from "./onlyoffice-baseline.mjs";

const original = unzipSync(
  await readFile(
    new URL(
      "../../eval/public/fixtures/general-native-surface.pptx",
      import.meta.url,
    ),
  ),
);
const version = (value) =>
  zipSync({
    ...original,
    "ppt/slides/slide1.xml": strToU8(
      strFromU8(original["ppt/slides/slide1.xml"]).replace(
        "</p:sld>",
        `<!--${value}--></p:sld>`,
      ),
    ),
  });
function trial(values) {
  const window = {},
    calls = [];
  const page = {
    evaluate: (fn, value) =>
      Promise.resolve(vm.runInNewContext(`(${fn})(value)`, { window, value })),
  };
  const save = async () => {
    assert.equal(window.__comparisonCaptureBaseline, true);
    const bytes = values[calls.length];
    calls.push(bytes);
    if (bytes instanceof Error) throw bytes;
    return { ms: 10, base64: Buffer.from(bytes).toString("base64") };
  };
  return { window, calls, page, save };
}
test("same-engine source baseline requires two equivalent exports and retains timing", async () => {
  const t = trial([version(1), version(1)]);
  const result = await captureStableOnlyOfficeBaseline(t.page, t.save);
  assert.equal(result.attempts, 2);
  assert.equal(result.ms, 20);
  assert.deepEqual(result.transitions, [[]]);
  assert.equal(t.window.__comparisonCaptureBaseline, false);
});
test("cold serializer derived changes do not become the comparison's authored edit", async () => {
  const t = trial([version(1), version(2), version(2)]);
  const result = await captureStableOnlyOfficeBaseline(t.page, t.save);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.transitions, [["ppt/slides/slide1.xml"], []]);
  assert.deepEqual(
    Buffer.from(result.base64, "base64"),
    Buffer.from(version(2)),
  );
});
test("unstable serialization and export failures release the baseline capture boundary", async () => {
  for (const values of [
    [version(1), version(2), version(3), version(4)],
    [new Error("native export failed")],
  ]) {
    const t = trial(values);
    await assert.rejects(
      captureStableOnlyOfficeBaseline(t.page, t.save),
      /export_unstable|native export failed/u,
    );
    assert.equal(t.window.__comparisonCaptureBaseline, false);
    assert.ok(t.calls.length <= 4);
  }
});

test("a native saved-state checkpoint can retain the independently prepared preservation reference", async () => {
  const t = trial([version(1), version(1)]);
  await captureStableOnlyOfficeBaseline(
    t.page,
    async (page) => {
      assert.equal(t.window.__comparisonRetainPreservationBaseline, true);
      return t.save(page);
    },
    { retainPreservationBaseline: true },
  );
  assert.equal(t.window.__comparisonRetainPreservationBaseline, false);
});
