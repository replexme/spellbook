/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import { patchOnlyOfficeDistributedAlignment } from "./distributed-alignment.mjs";

const source = await fs.readFile(
  new URL("./distribution/sdkjs/slide/sdk-all.js", import.meta.url),
  "utf8",
);
const patched = patchOnlyOfficeDistributedAlignment(source);

test("refuses unknown SDK bytes instead of applying an approximate source patch", () => {
  assert.throws(
    () => patchOnlyOfficeDistributedAlignment(source + "\n"),
    /identity_mismatch/,
  );
  assert.equal(patchOnlyOfficeDistributedAlignment(source), patched);
  new vm.Script(patched);
});

test("native writer and observation retain distributed independently of justify", () => {
  const start = patched.indexOf("function private_GetStrParaAlign(jc)"),
    end = patched.indexOf("function private_GetTableBorder", start);
  const read = vm.runInNewContext(
    patched.slice(start, end) + ";private_GetStrParaAlign",
    {
      AscCommon: { align_Distributed: 4 },
      align_Left: 0,
      align_Right: 2,
      align_Center: 1,
      align_Justify: 3,
    },
  );
  assert.equal(read(4), "distributed");
  assert.equal(read(3), "both");
  const writer = patched.slice(
    patched.indexOf("this.WriteTextParagraphPr=function"),
    patched.indexOf(
      "var defTab=",
      patched.indexOf("this.WriteTextParagraphPr=function"),
    ),
  );
  const nativeAlignment = writer.match(/switch\(pPr.Jc\)\{(.*?)\}/s)[1];
  const serialize = vm.runInNewContext(
    "(value=>{const pPr={Jc:value},bytes=[];const oThis={_WriteUChar1:(_,v)=>bytes.push(v)};switch(pPr.Jc){" +
      nativeAlignment +
      "}return bytes[0]})",
    {
      AscCommon: {
        align_Left: 0,
        align_Right: 2,
        align_Center: 1,
        align_Justify: 3,
        align_Distributed: 4,
      },
    },
  );
  assert.equal(serialize(4), 1);
  assert.equal(serialize(3), 2);
});
