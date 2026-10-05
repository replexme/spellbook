import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("./extension/operations.js", import.meta.url),
  "utf8",
);
const helper = (start, end, name, globals = {}) =>
  runInNewContext(
    source.slice(
      source.indexOf(start),
      source.indexOf(end, source.indexOf(start)),
    ) + `\n${name};`,
    globals,
  );
const wholeTextFormatting = helper(
  "  const wholeTextFormatting =",
  "  // The public command contract",
  "wholeTextFormatting",
  {
    fontSlantName: (value) => value,
    localeDetails: (value) => value,
  },
);

test("outline formatting is observed after text portions initialize inheritance", () => {
  const state = { fontSize: 24, family: "Master default", reads: 0 };
  const observe = helper(
    "  const shapeTextFormatting =",
    "  // The public command contract",
    "shapeTextFormatting",
    {
      runFormatting: () => {
        state.reads++;
        state.fontSize = 18;
        state.family = "Authored body";
        return { languages: ["ko-KR"] };
      },
      shapePropertyStates: () => ({ fontSize: "DEFAULT_VALUE" }),
      wholeTextFormatting: () => ({
        fontSize: state.fontSize,
        fontFamily: state.family,
      }),
    },
  );
  const observation = observe({}, "본문", null);
  assert.equal(observation.wholeTextFormatting.fontSize, 18);
  assert.equal(observation.wholeTextFormatting.fontFamily, "Authored body");
  assert.equal(observation.propertyStates.fontSize, "DEFAULT_VALUE");
  assert.deepEqual([...observation.runFormatting.languages], ["ko-KR"]);
  assert.equal(state.reads, 1);
});

function textShape(bulk) {
  const state = {
    family: "Before",
    size: 18,
    created: 0,
    individual: 0,
    bulk: 0,
    ranges: [],
  };
  const properties = (name) =>
    name === "CharFontName"
      ? state.family
      : name === "CharHeight"
        ? state.size
        : null;
  const shape = {
    getPropertyValue: properties,
    createTextCursor() {
      state.created++;
      const cursor = {
        gotoEnd(expand) {
          state.ranges.push(expand);
        },
        getPropertyValue(name) {
          state.individual++;
          return properties(name);
        },
      };
      if (bulk)
        cursor.getPropertyValues = (names) => {
          state.bulk++;
          assert.deepEqual([...names], [...names].sort());
          return names.map(properties);
        };
      return cursor;
    },
  };
  return { shape, state };
}

test("whole text bulk read preserves mixed values and rereads after a mutation", () => {
  const { shape, state } = textShape(true);
  const before = wholeTextFormatting(shape, "Text");
  assert.equal(before.fontFamily, "Before");
  assert.equal(before.fontSize, 18);
  assert.equal(before.fontFamilyAsian, null);
  state.family = "After";
  state.size = 24;
  const after = wholeTextFormatting(shape, "Text");
  assert.equal(after.fontFamily, "After");
  assert.equal(after.fontSize, 24);
  assert.equal(state.bulk, 2);
  assert.equal(state.individual, 0);
  assert.deepEqual(state.ranges, [true, true]);
});

test("individual-only objects and failed bulk reads retain the same observation", () => {
  const { shape } = textShape(false);
  const expected = wholeTextFormatting(shape, "Text");
  for (const getPropertyValues of [
    () => {
      throw new Error("unsupported");
    },
    () => ["incomplete"],
  ]) {
    const create = shape.createTextCursor;
    const fallbackShape = {
      ...shape,
      createTextCursor() {
        return { ...create(), getPropertyValues };
      },
    };
    assert.deepEqual(wholeTextFormatting(fallbackShape, "Text"), expected);
  }
});

test("empty bodies use authored shape defaults without creating a cursor", () => {
  const { shape, state } = textShape(true);
  assert.equal(wholeTextFormatting(shape, "").fontFamily, "Before");
  assert.equal(state.created, 0);
  assert.equal(wholeTextFormatting(shape, null), null);
});

const cursorSource = source.slice(
  source.indexOf("    const textCursors = new WeakMap();"),
  source.indexOf(
    "    documentReadCount++;",
    source.indexOf("    const textCursors = new WeakMap();"),
  ),
);
const newRead = () => runInNewContext(cursorSource + "\ntextCursor;");

test("one observation shares separate collapsed and whole ranges, then discards anchors", () => {
  const { shape, state } = textShape(true);
  const read = newRead();
  const collapsed = read(shape, false);
  const whole = read(shape, true);
  whole.gotoEnd(true);
  assert.notEqual(collapsed, whole);
  assert.equal(read(shape, false), collapsed);
  assert.equal(read(shape, true), whole);
  const next = newRead();
  assert.notEqual(next(shape, false), collapsed);
  assert.notEqual(next(shape, true), whole);
  assert.equal(state.created, 4);
});

const capabilitySource = source.slice(
  source.indexOf("  let propertyCapabilityCache ="),
  source.indexOf(
    "  const safeProperty =",
    source.indexOf("  let propertyCapabilityCache ="),
  ),
);
function capabilityRead() {
  return runInNewContext(
    capabilitySource + "\npropertyInfoCapabilities = [];\npropertyIsSupported;",
    {
      uno: { sameUnoObject: (left, right) => left.identity === right.identity },
    },
  );
}

test("property capabilities share only exact UNO info identity within one read", () => {
  let calls = 0;
  const info = (identity, names) => ({
    identity,
    hasPropertyByName(name) {
      calls++;
      return names.includes(name);
    },
  });
  const read = capabilityRead();
  const a = { getPropertySetInfo: () => info(1, ["CharHeight"]) };
  const b = { getPropertySetInfo: () => info(1, ["CharHeight"]) };
  const other = { getPropertySetInfo: () => info(2, ["CharFontName"]) };
  assert.equal(read(a, "CharHeight"), true);
  assert.equal(read(b, "CharHeight"), true);
  assert.equal(calls, 1);
  assert.equal(read(other, "CharHeight"), false);
  assert.equal(calls, 2);
  const nextRead = capabilityRead();
  assert.equal(nextRead(a, "CharHeight"), true);
  assert.equal(calls, 3);
});
