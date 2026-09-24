import assert from "node:assert/strict";
import test from "node:test";

import { createTextInputBridge } from "./text-input-bridge.mjs";

function bridgeWithLog() {
  const typed = [];
  const shown = [];
  const bridge = createTextInputBridge({
    typeKey: (init) => typed.push(init),
    showComposition: (text) => shown.push(text),
  });
  return { bridge, typed, shown };
}

test("Korean composition types only committed syllables and never Backspace", () => {
  const { bridge, typed, shown } = bridgeWithLog();
  assert.equal(bridge.keydown({ key: "Process", keyCode: 229 }), true);
  bridge.compositionstart();
  bridge.compositionupdate({ data: "ㅎ" });
  bridge.compositionupdate({ data: "하" });
  bridge.compositionupdate({ data: "한" });
  assert.equal(bridge.keyup({ key: "Process", keyCode: 229 }), true);
  bridge.input({
    inputType: "insertCompositionText",
    data: "한",
    isComposing: true,
  });
  bridge.compositionend({ data: "한" });
  bridge.compositionstart();
  bridge.compositionupdate({ data: "그" });
  bridge.compositionupdate({ data: "글" });
  bridge.compositionend({ data: "글" });
  assert.deepEqual(
    typed.map(({ key }) => key),
    ["한", "글"],
  );
  assert.ok(typed.every(({ key }) => key !== "Backspace"));
  assert.deepEqual(shown, ["", "ㅎ", "하", "한", "", "", "그", "글", ""]);
  assert.equal(bridge.composing, false);
});

test("a key Qt already received is not typed again from its input event", () => {
  const { bridge, typed } = bridgeWithLog();
  assert.equal(bridge.keydown({ key: "a", keyCode: 65 }), false);
  bridge.input({ inputType: "insertText", data: "a" });
  assert.equal(bridge.keydown({ key: "Enter", keyCode: 13 }), false);
  bridge.input({ inputType: "insertParagraph", data: null });
  assert.deepEqual(typed, []);
});

test("text inserted without a key press is typed character by character", () => {
  const { bridge, typed } = bridgeWithLog();
  bridge.input({ inputType: "insertText", data: "테스트" });
  bridge.input({ inputType: "insertText", data: "a😀b" });
  assert.deepEqual(
    typed.map(({ key }) => key),
    ["테", "스", "트", "a", "b"],
  );
});

test("a space or Enter that ended a composition reaches the document once", () => {
  const { bridge, typed } = bridgeWithLog();
  bridge.compositionstart();
  bridge.compositionupdate({ data: "한" });
  assert.equal(
    bridge.keydown({ key: " ", keyCode: 229, isComposing: true }),
    true,
  );
  bridge.compositionend({ data: "한" });
  bridge.input({ inputType: "insertText", data: " " });
  bridge.compositionstart();
  bridge.compositionupdate({ data: "글" });
  assert.equal(
    bridge.keydown({ key: "Enter", keyCode: 229, isComposing: true }),
    true,
  );
  bridge.compositionend({ data: "글" });
  bridge.input({ inputType: "insertParagraph", data: null });
  assert.deepEqual(
    typed.map(({ key }) => key),
    ["한", " ", "글", "Enter"],
  );
});

test("input events during a composition type nothing", () => {
  const { bridge, typed } = bridgeWithLog();
  bridge.compositionstart();
  bridge.input({ inputType: "insertText", data: "ㅎ" });
  bridge.input({
    inputType: "insertCompositionText",
    data: "하",
    isComposing: true,
  });
  assert.deepEqual(typed, []);
});
