/* SPDX-License-Identifier: MPL-2.0 */

import { createHash } from "node:crypto";

// Cache only immutable IDL declarations. Every proxy still owns its own UNO
// object, invocation bridge and finalizer; values and model state are never
// shared. ZetaJS otherwise reflects every inherited member for every shape,
// paragraph, text cursor and property-info object returned by the engine.
function describeProxyInterface(td, definitions, Module) {
  const name = td.getName();
  if (td.getTypeClass() !== Module.uno.com.sun.star.uno.TypeClass.INTERFACE)
    throw new Error("not a UNO interface type: " + name);
  if (definitions.has(name)) return definitions.get(name);
  const reflection = Module.uno.com.sun.star.reflection;
  const description = reflection.XInterfaceTypeDescription2.query(td);
  const bases = [];
  const members = [];
  try {
    const baseTypes = description.getBaseTypes();
    try {
      for (let index = 0; index < baseTypes.size(); index++) {
        const base = baseTypes.get(index);
        try {
          bases.push(describeProxyInterface(base, definitions, Module));
        } finally {
          base.delete();
        }
      }
    } finally {
      baseTypes.delete();
    }
    const memberTypes = description.getMembers();
    try {
      for (let index = 0; index < memberTypes.size(); index++) {
        const member = memberTypes.get(index);
        try {
          const attribute =
            reflection.XInterfaceAttributeTypeDescription.query(member);
          try {
            members.push(
              Object.freeze({
                name: member.getMemberName(),
                attribute: attribute !== null,
                readOnly: attribute !== null && attribute.isReadOnly(),
              }),
            );
          } finally {
            attribute?.delete();
          }
        } finally {
          member.delete();
        }
      }
    } finally {
      memberTypes.delete();
    }
  } finally {
    description.delete();
  }
  const definition = Object.freeze({
    name,
    bases: Object.freeze(bases),
    members: Object.freeze(members),
  });
  definitions.set(name, definition);
  return definition;
}

const proxyAnchor = "    function proxy(unoObject) {";
const walkAnchor = "        function walk(td) {";
const walkEnd = "        const tdm = getTypeDescriptionManager();";
const pinnedWalkSha256 =
  "ba66ccded5e0c8dc073d47ac9d1c0ceeb6f16c4fe94f97f37d97be26d7cb83fc";

const cachedWalk = `        function walk(td) {
          const definition = describeProxyInterface(td, proxyInterfaceDefinitions, Module);
          function install(definition) {
            const iname = definition.name;
            if (Object.hasOwn(seen, iname)) return;
            seen[iname] = true;
            definition.bases.forEach(install);
            for (const member of definition.members) {
              const name = member.name;
              if (member.attribute) {
                Object.defineProperty(prox, name, {
                  enumerable: true,
                  get() { return invokeGetter(name, false); },
                  set: member.readOnly ? undefined
                    : function(value) { return invokeSetter(name, value); }});
                Object.defineProperty(prox.$precise, name, {
                  enumerable: true,
                  get() { return invokeGetter(name, true); },
                  set: member.readOnly ? undefined
                    : function(value) { return invokeSetter(name, value); }});
              } else {
                prox[name] = function() { return invokeMethod(name, arguments, false); };
                prox.$precise[name] = function() { return invokeMethod(name, arguments, true); };
              }
            }
            if (iname === 'com.sun.star.container.XEnumeration') {
              prox[Symbol.iterator] = function*() {
                while (prox.hasMoreElements()) yield prox.nextElement();
              };
              prox.$precise[Symbol.iterator] = function*() {
                while (prox.$precise.hasMoreElements()) yield prox.$precise.nextElement();
              };
            }
          }
          install(definition);
        };

`;

export function applyZetaProxyMetadataOverlay(source) {
  if (typeof source !== "string")
    throw new TypeError("Pinned ZetaJS source must be text.");
  if (source.includes("const proxyInterfaceDefinitions = new Map();"))
    throw new Error(
      "Pinned ZetaJS already contains the proxy metadata overlay.",
    );
  const proxyStart = source.indexOf(proxyAnchor);
  const start = source.indexOf(walkAnchor, proxyStart);
  const end = source.indexOf(walkEnd, start);
  if (
    proxyStart < 0 ||
    start < 0 ||
    end < 0 ||
    source.indexOf(proxyAnchor, proxyStart + 1) >= 0 ||
    createHash("sha256").update(source.slice(start, end)).digest("hex") !==
      pinnedWalkSha256
  )
    throw new Error("Pinned ZetaJS proxy metadata anchor has drifted.");
  const patched = source.slice(0, start) + cachedWalk + source.slice(end);
  return patched.replace(
    proxyAnchor,
    () =>
      `    const proxyInterfaceDefinitions = new Map();\n    ${describeProxyInterface.toString()}\n${proxyAnchor}`,
  );
}
