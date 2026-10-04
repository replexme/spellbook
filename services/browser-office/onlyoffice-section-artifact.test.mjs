/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import {
  serializeOnlyOfficeSections,
  initializeOnlyOfficeSections,
} from "./onlyoffice/section-artifact.mjs";
import { inspectOoxmlDocument } from "./ooxml-worker-source.mjs";

test("section serialization uses actual native values and changes only presentation XML", async () => {
  const bytes = new Uint8Array(
    await readFile(
      new URL(
        "../../eval/public/fixtures/general-native-surface.pptx",
        import.meta.url,
      ),
    ),
  );
  const native = [
    {
      name: "실제 구역",
      guid: "{11111111-1111-4111-8111-111111111111}",
      startIndex: 0,
    },
  ];
  const saved = serializeOnlyOfficeSections(bytes, native);
  assert.deepEqual(inspectOoxmlDocument(saved).sections, [
    {
      name: native[0].name,
      id: native[0].guid,
      startSlideIndex: 0,
      slideCount: 1,
    },
  ]);
  const before = unzipSync(bytes),
    after = unzipSync(saved);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const part of Object.keys(before))
    if (part !== "ppt/presentation.xml")
      assert.deepEqual(after[part], before[part], part);
  assert.throws(
    () => serializeOnlyOfficeSections(bytes, [{ ...native[0], startIndex: 1 }]),
    /invalid|start at slide 0|outside/,
  );
  assert.deepEqual(
    inspectOoxmlDocument(serializeOnlyOfficeSections(saved, [])).sections,
    [],
  );
});

test("original section import initializes once before edits and retains native history ownership", () => {
  const previous = globalThis.window;
  let disabled = 0;
  const model = { Sections: [] };
  const history = {
    Index: -1,
    Points: [],
    TurnOff: () => disabled++,
    TurnOn: () => disabled--,
  };
  class Section {
    setName(name) {
      this.name = name;
    }
    setGuid(guid) {
      this.guid = guid;
    }
    setStartIndex(startIndex) {
      this.startIndex = startIndex;
    }
  }
  globalThis.window = {
    Asc: { editor: { WordControl: { m_oLogicDocument: model } } },
    AscCommon: { History: history },
    AscCommonSlide: { CPrSection: Section },
  };
  const sections = [
    {
      name: "원본",
      id: "{11111111-1111-4111-8111-111111111111}",
      startSlideIndex: 0,
    },
  ];
  try {
    initializeOnlyOfficeSections(sections);
    const original = model.Sections[0];
    initializeOnlyOfficeSections(sections);
    assert.equal(model.Sections[0], original);
    assert.equal(disabled, 0);
    assert.throws(() => initializeOnlyOfficeSections([]), /import_conflict/);
    history.Index = 0;
    history.Points = [{ Items: [{}] }];
    assert.throws(() => initializeOnlyOfficeSections(sections), /after_edit/);
  } finally {
    globalThis.window = previous;
  }
});
