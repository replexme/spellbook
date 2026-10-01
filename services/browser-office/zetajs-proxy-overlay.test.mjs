import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { applyZetaProxyMetadataOverlay } from "./zetajs-proxy-overlay.mjs";
import {
  applyZetaByteSequenceOverlay,
  applyZetaJsOverlay,
} from "./zetajs-overlay.mjs";

const original = readFileSync(
  new URL("./runtime/zeta.js", import.meta.url),
  "utf8",
);

function fixture() {
  const counts = new Map();
  const liveHandles = new Set();
  let failMember = false;
  const root = { name: "com.sun.star.uno.XInterface", bases: [], members: [] };
  const enumeration = {
    name: "com.sun.star.container.XEnumeration",
    bases: [root],
    members: [{ name: "hasMoreElements" }, { name: "nextElement" }],
  };
  const base = {
    name: "test.Base",
    bases: [root],
    members: [
      { name: "Value", attribute: true },
      { name: "Name", attribute: true, readOnly: true },
    ],
  };
  const derived = {
    name: "test.Derived",
    bases: [base, enumeration],
    members: [{ name: "read" }],
  };
  function own(value) {
    const result = {
      ...value,
      delete() {
        assert(liveHandles.delete(result), "native handle deleted once");
      },
    };
    liveHandles.add(result);
    return result;
  }
  const sequence = (values, convert) =>
    own({ size: () => values.length, get: (index) => convert(values[index]) });
  const type = (definition) =>
    own({ definition, getName: () => definition.name, getTypeClass: () => 1 });
  const Module = {
    uno: {
      com: {
        sun: {
          star: {
            uno: { TypeClass: { INTERFACE: 1 } },
            reflection: {
              XInterfaceTypeDescription2: {
                query(td) {
                  const definition = td.definition;
                  counts.set(
                    definition.name,
                    (counts.get(definition.name) ?? 0) + 1,
                  );
                  return own({
                    getBaseTypes: () => sequence(definition.bases, type),
                    getMembers: () =>
                      sequence(definition.members, (member) =>
                        own({
                          member,
                          getMemberName() {
                            if (failMember)
                              throw new Error("reflection failure");
                            return member.name;
                          },
                        }),
                      ),
                  });
                },
              },
              XInterfaceAttributeTypeDescription: {
                query(member) {
                  return member.member.attribute
                    ? own({ isReadOnly: () => member.member.readOnly === true })
                    : null;
                },
              },
            },
          },
        },
      },
    },
  };
  const patched = applyZetaProxyMetadataOverlay(original);
  const declarations = patched.slice(
    patched.indexOf("    const proxyInterfaceDefinitions = new Map();"),
    patched.indexOf("    function proxy(unoObject) {"),
  );
  const walkStart = patched.indexOf(
    "        function walk(td) {",
    patched.indexOf("    function proxy(unoObject) {"),
  );
  const walk = patched.slice(
    walkStart,
    patched.indexOf(
      "        const tdm = getTypeDescriptionManager();",
      walkStart,
    ),
  );
  const context = vm.createContext({ Module });
  vm.runInContext(
    `${declarations}
    globalThis.install = function(td, values, names) {
      const prox = {$precise:{}};
      const seen = {'com.sun.star.uno.XInterface':true};
      const invokeMethod = (name,args,precise) => {
        if (name==='hasMoreElements') return names.length>0;
        if (name==='nextElement') return names.shift();
        return {name,value:values.Value,args:Array.from(args),precise};
      };
      const invokeGetter = (name,precise) => precise ? {value:values[name],precise} : values[name];
      const invokeSetter = (name,value) => {values[name]=value;};
      ${walk}
      walk(td);return prox;
    };
    globalThis.cache = proxyInterfaceDefinitions;`,
    context,
  );
  return {
    context,
    counts,
    liveHandles,
    install(values = { Value: 1, Name: "first" }, names = [1, 2]) {
      const td = type(derived);
      try {
        return context.install(td, values, names);
      } finally {
        td.delete();
      }
    },
    fail(value) {
      failMember = value;
    },
  };
}

test("proxy metadata caches declarations while values, calls and precise views stay object-local", () => {
  const f = fixture();
  const first = f.install();
  const second = f.install({ Value: 8, Name: "second" });
  assert.equal(first.Value, 1);
  assert.equal(second.Value, 8);
  second.$precise.Value = 9;
  assert.equal(second.Value, 9);
  assert.equal(first.Value, 1);
  assert.equal(second.$precise.Value.value, 9);
  assert.equal(first.read("a").value, 1);
  assert.equal(second.$precise.read("b").precise, true);
  assert.equal(Object.getOwnPropertyDescriptor(first, "Name").set, undefined);
  assert.equal(second.Name, "second");
  assert.deepEqual([...f.counts.values()], [1, 1, 1, 1]);
  assert.equal(f.liveHandles.size, 0);
  const definitions = JSON.parse(JSON.stringify([...f.context.cache.values()]));
  assert.equal(definitions.length, 4);
  assert(
    definitions.every(
      (entry) =>
        typeof entry.name === "string" && !entry.definition && !entry.delete,
    ),
  );
});

test("cached inherited enumeration members preserve normal and precise iteration", () => {
  const f = fixture();
  assert.deepEqual([...f.install()], [1, 2]);
  assert.deepEqual([...f.install({}, [3, 4]).$precise], [3, 4]);
  assert.equal(f.liveHandles.size, 0);
});

test("failed reflection releases all handles and cannot admit a partial definition", () => {
  const f = fixture();
  f.fail(true);
  assert.throws(() => f.install(), /reflection failure/);
  assert.equal(f.liveHandles.size, 0);
  assert.equal(f.context.cache.has("test.Derived"), false);
  assert.equal(f.context.cache.has("test.Base"), false);
  f.fail(false);
  assert.equal(f.install().Value, 1);
  assert.equal(f.liveHandles.size, 0);
});

test("proxy overlay composes with admitted typedef and byte overlays and refuses source drift", () => {
  const patched = applyZetaProxyMetadataOverlay(
    applyZetaByteSequenceOverlay(applyZetaJsOverlay(original)),
  );
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.throws(
    () => applyZetaProxyMetadataOverlay(patched),
    /already contains/,
  );
  assert.throws(
    () =>
      applyZetaProxyMetadataOverlay(
        original.replace(
          "const name = mem.getMemberName();",
          "const name = 'changed';",
        ),
      ),
    /has drifted/,
  );
  assert.throws(() => applyZetaProxyMetadataOverlay(null), /must be text/);
});
