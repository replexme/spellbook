/* SPDX-License-Identifier: AGPL-3.0-only */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installOnlyOfficeMissingSmartArtLayouts } from "./missing-smartart-layouts.mjs";
import { onlyOfficeParagraphFormat } from "./paragraph-format.mjs";

function runtime() {
  let history = true;
  class CBodyPr {
    setDefault(value = false) {
      this.spcCol = value;
      return "default";
    }
  }
  class SmartArt {
    constructor(type, children = [], supported = false) {
      this.type = type;
      this.drawing = { spTree: children };
      this.supported = supported;
    }
    getTypeOfSmartArt() {
      return this.type;
    }
    isCanGenerateSmartArt() {
      return this.supported;
    }
    copy2(target) {
      target.drawing = this.drawing;
      return "copy";
    }
    recalculate() {
      this.fit?.();
      return "recalculated";
    }
  }
  class TextAlgorithm {
    applyTxXfrmSettings(shape, contentShadow) {
      return this.apply(shape, contentShadow);
    }
  }
  const format = {
    CBodyPr,
    SmartArt,
    TextAlgorithm,
    ExecuteNoHistory(fn, receiver, args) {
      const previous = history;
      history = false;
      try {
        return fn.apply(receiver, args);
      } finally {
        history = previous;
      }
    },
  };
  const context = vm.createContext({ AscFormat: format });
  const install = () =>
    vm.runInContext(
      "(" +
        installOnlyOfficeMissingSmartArtLayouts.toString() +
        ")(" +
        onlyOfficeParagraphFormat.toString() +
        ")",
      context,
    );
  install();
  return { format, install, history: () => history };
}

test("missing list caches recover without replacing authored caches or extending unknown layouts", () => {
  const {
    format: { SmartArt },
    install,
  } = runtime();
  const authored = new SmartArt(7, [{}]);
  const authoredMethod = SmartArt.prototype.isCanGenerateSmartArt;
  assert.equal(authored.isCanGenerateSmartArt(), false);
  assert.equal(new SmartArt(116).isCanGenerateSmartArt(), false);
  assert.equal(new SmartArt(59, [], true).isCanGenerateSmartArt(), true);
  for (const type of [7, 29]) {
    const recovered = new SmartArt(type);
    assert.equal(recovered.isCanGenerateSmartArt(), true);
    recovered.drawing.spTree.push({});
    assert.equal(recovered.isCanGenerateSmartArt(), true);
    const clone = new SmartArt(type);
    assert.equal(recovered.copy2(clone), "copy");
    assert.equal(clone.isCanGenerateSmartArt(), true);
  }
  install();
  assert.equal(SmartArt.prototype.isCanGenerateSmartArt, authoredMethod);
  assert.equal(authored.isCanGenerateSmartArt(), false);
});

test("post-fit generated paragraph spacing survives native serialization without adding authored history", () => {
  const {
    format: { SmartArt },
    history,
  } = runtime();
  let writes = 0;
  const paragraph = {
    Pr: { Spacing: { Before: 0, After: 2.667 } },
    Set_Spacing(values, replace) {
      assert.equal(history(), false);
      assert.equal(replace, false);
      Object.assign(this.Pr.Spacing, values);
      writes++;
    },
  };
  const diagram = new SmartArt(29);
  assert.equal(diagram.isCanGenerateSmartArt(), true);
  diagram.fit = () => {
    paragraph.Pr.Spacing.After = 2.667;
  };
  diagram.drawing.spTree.push({
    txBody: { content: { Content: [paragraph] } },
  });
  assert.equal(diagram.recalculate(), "recalculated");
  assert.equal(writes, 1);
  assert.equal(history(), true);
  const value = paragraph.Pr.Spacing.After;
  assert.equal(Math.trunc(value / 0.00352777778), 756);
  assert.ok(Math.abs(value - 756 * 0.00352777778) < 1e-12);
  const authored = new SmartArt(29, [
    { txBody: { content: { Content: [paragraph] } } },
  ]);
  paragraph.Pr.Spacing.After = 2.667;
  authored.recalculate();
  assert.equal(writes, 1);
  assert.equal(paragraph.Pr.Spacing.After, 2.667);
});

test("authored text bounds match native shapes and restore temporary layout state even on errors", () => {
  const {
    format: { TextAlgorithm },
  } = runtime();
  const shadow = { x: 1, y: 2, width: 3, height: 4, rot: 5 };
  const previous = { ...shadow };
  const algorithm = new TextAlgorithm();
  algorithm.parentNode = { getShape: () => shadow };
  const shape = {
    spPr: { xfrm: { offX: 10, offY: 20, extX: 30, extY: 40, rot: 0 } },
    getSmartArtInfo: () => ({
      contentPoint: [{ point: { spPr: { xfrm: { extX: 30, extY: 40 } } } }],
    }),
  };
  algorithm.apply = () => {
    assert.deepEqual(shadow, { x: 10, y: 20, width: 30, height: 40, rot: 0 });
    throw Error("native layout failed");
  };
  assert.throws(
    () => algorithm.applyTxXfrmSettings(shape),
    /native layout failed/,
  );
  assert.deepEqual(shadow, previous);
  algorithm.apply = () => {
    assert.deepEqual(shadow, previous);
    return "delegated";
  };
  assert.equal(algorithm.applyTxXfrmSettings(shape, {}), "delegated");
  shape.getSmartArtInfo = () => null;
  assert.equal(algorithm.applyTxXfrmSettings(shape), "delegated");
});

test("body defaults retain numeric column spacing across native file readback", () => {
  const {
    format: { CBodyPr },
  } = runtime();
  const body = new CBodyPr();
  assert.equal(body.setDefault(), "default");
  assert.equal(body.spcCol, 0);
  body.setDefault(250);
  assert.equal(body.spcCol, 250);
});
