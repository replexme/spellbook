/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { finalizeOnlyOfficeNativeGeometry } from "./onlyoffice/product-engine.mjs";
test("human pixel movement keeps its existing native history point and exact serialized positions", () => {
  const changes = [];
  const make = (value) => ({
    offX: value,
    setOffX(v) {
      changes.push([this.offX, v]);
      this.offX = v;
    },
  });
  const positive = make(1567295.454545 / 36000),
    negative = make(-1567295.454545 / 36000);
  const authored = make(1524000 / 36000);
  const point = { Items: [{ human: true }] };
  const model = {
    Slides: [
      {
        cSld: {
          spTree: [
            {
              spPr: { xfrm: positive },
              spTree: [{ spPr: { xfrm: negative } }],
            },
            { spPr: { xfrm: authored } },
          ],
        },
      },
    ],
    Recalculate() {
      changes.push("recalculate");
    },
  };
  globalThis.window = {
    Asc: { editor: { WordControl: { m_oLogicDocument: model } } },
    AscCommon: { History: { Points: [point], Index: 0 } },
  };
  try {
    assert.equal(finalizeOnlyOfficeNativeGeometry(), true);
    assert.equal(Math.trunc(positive.offX * 36000), 1567295);
    assert.equal(Math.trunc(negative.offX * 36000), -1567295);
    assert.equal(authored.offX, 1524000 / 36000);
    assert.strictEqual(window.AscCommon.History.Points[0], point);
    assert.equal(changes.length, 3);
    assert.equal(finalizeOnlyOfficeNativeGeometry(), false);
    positive.offX += 0.25 / 36000;
    point.Items = [];
    assert.throws(
      finalizeOnlyOfficeNativeGeometry,
      /geometry_history_required/,
    );
  } finally {
    delete globalThis.window;
  }
});
