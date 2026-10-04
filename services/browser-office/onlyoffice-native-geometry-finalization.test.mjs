/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { finalizeOnlyOfficeNativeGeometry } from "./onlyoffice/product-engine.mjs";
test("human pixel movement keeps its existing native history point and exact serialized positions", () => {
  const changes = [];
  const groupChanges = [{ section: true }];
  const authoredChange={sectionName:"typed-section-change"};
  const expectedChanges=[...groupChanges,authoredChange];
  const recalcData = { typedChanges: expectedChanges };
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
  const point = { Items: [{ human: true,NeedRecalc:true,Data:authoredChange }] };
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
    Recalculate(data) {
      assert.strictEqual(data, recalcData);
      changes.push("recalculate");
    },
  };
  globalThis.window = {
    Asc: { editor: { WordControl: { m_oLogicDocument: model } } },
    AscCommon: { History: { Points: [point], Index: 0, getGroupChanges:()=>groupChanges, Get_RecalcData:(index, values)=>{ assert.equal(index,null); assert.deepEqual(values,expectedChanges); return recalcData; } } },
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

test("manual checkpoint preserves authored crop despite inverse writer truncation", () => {
  const original = { l: 0, t: 0, r: 89.069, b: 100 };
  const history = { Points: [{ Items: [{ human: true }] }], Index: 0, getGroupChanges:()=>[], Get_RecalcData:()=>({}) };
  const shape = {
    Id:"owned-image",
    blipFill: {
      srcRect: original,
      createDuplicate() {
        return { ...this };
      },
    },
    setBlipFill(fill) {
      history.Points[0].Items.push({ previous: this.blipFill, next: fill });
      this.blipFill = fill;
    },
  };
  globalThis.window = {
    Asc: {
      editor: {
        WordControl: {
          m_oLogicDocument: {
            Slides: [{ cSld: { spTree: [shape] } }],
            Recalculate() {},
          },
        },
      },
    },
    AscCommon: { History: history },
    AscFormat: { CSrcRect: class {} },
  };
  try {
    assert.equal(Math.trunc((100 - original.r) * 1000), 10930);
    assert.equal(finalizeOnlyOfficeNativeGeometry({cropNativeIds:[]}), false);
    assert.strictEqual(shape.blipFill.srcRect,original);
    assert.equal(Math.trunc((100 - shape.blipFill.srcRect.r) * 1000), 10930);
    assert.equal(finalizeOnlyOfficeNativeGeometry({cropNativeIds:[shape.Id]}), true);
    assert.equal(Math.trunc((100 - shape.blipFill.srcRect.r) * 1000), 10931);
    assert.equal(Number(shape.blipFill.srcRect.r.toFixed(3)), original.r);
    assert.equal(history.Points.length, 1);
    assert.equal(history.Points[0].Items.length, 2);
    assert.equal(finalizeOnlyOfficeNativeGeometry(), false);
    shape.blipFill = history.Points[0].Items[1].previous;
    assert.strictEqual(shape.blipFill.srcRect, original);
  } finally {
    delete globalThis.window;
  }
});

test("generated SmartArt geometry stays derived while authored placement is finalized",()=>{
  const make=value=>({offX:value,setOffX(value){this.offX=value;}});
  const root=make(90000.75/36000),derived=make(7000.75/36000),authored=make(7000.75/36000);
  const diagram={getObjectType:()=>123,isLocalDrawingPart:false,spPr:{xfrm:root},spTree:[{spPr:{xfrm:derived}}]};
  const local={getObjectType:()=>123,isLocalDrawingPart:true,spTree:[{spPr:{xfrm:authored}}]};
  const model={Slides:[{cSld:{spTree:[diagram,local]}}],Recalculate(){}};
  globalThis.window={Asc:{editor:{WordControl:{m_oLogicDocument:model}}},AscDFH:{historyitem_type_SmartArt:123},AscCommon:{History:{Index:0,Points:[{Items:[{}]}],getGroupChanges:()=>[],Get_RecalcData:()=>({})}}};
  try{
    assert.equal(finalizeOnlyOfficeNativeGeometry(),true);
    assert.equal(Math.trunc(root.offX*36000),90000);
    assert.equal(derived.offX,7000.75/36000);
    assert.equal(Math.trunc(authored.offX*36000),7000);
  }finally{delete globalThis.window;}
});
