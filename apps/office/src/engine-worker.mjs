// The engine (WASM) in a Web Worker. Requests `{id, method, args}` call the
// same-named method of the open document's workspace; replies are
// `{id, value}` or `{id, error}`. Byte results are transferred, not copied.
// PowerPoint decks use `Workspace`; an InDesign (IDML) document loads the
// separate IDML engine (`IdmlWorkspace`, same methods) the first time one opens.
import init, { Workspace } from "./engine/present_engine_wasm.js";

let workspace;
let idml = null;
let active;
const local = []; // fonts added after start (Local Font Access), for an engine loaded later

// Fallback fonts served with this page (see fonts/manifest.json), fetched
// while the engine itself downloads and compiles rather than after it.
const manifestFonts = (async () => {
  const manifest = await (await fetch(new URL("./fonts/manifest.json", import.meta.url))).json();
  return Promise.all(manifest.files.map(async (name) => new Uint8Array(await (await fetch(new URL(`./fonts/${name}`, import.meta.url))).arrayBuffer())));
})();

const ready = (async () => {
  await init();
  workspace = new Workspace();
  active = workspace;
  for (const bytes of await manifestFonts) workspace.add_font(bytes);
})();

/** An IDML package: a ZIP whose first entry is its stored mimetype. */
function isIdml(bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 100 || ascii(0, 4) !== "PK\u0003\u0004" || ascii(30, 38) !== "mimetype") return false;
  const extra = bytes[28] | (bytes[29] << 8);
  const type = "application/vnd.adobe.indesign-idml-package";
  return ascii(38 + extra, 38 + extra + type.length) === type;
}

async function idmlWorkspace() {
  if (idml) return idml;
  const engine = await import("./engine/present_idml_wasm.js");
  await engine.default();
  const ws = new engine.IdmlWorkspace();
  for (const bytes of await manifestFonts) ws.add_font(bytes);
  for (const bytes of local) ws.add_font(bytes.slice());
  idml = ws;
  return idml;
}

const METHODS = new Set(["add_font", "open", "format", "version", "can_undo", "describe", "apply", "undo", "redo", "render", "layout", "text_fit", "save"]);

self.onmessage = async ({ data: { id, method, args = [] } }) => {
  try {
    await ready;
    if (!METHODS.has(method)) throw new Error(JSON.stringify({ code: "unknown_method", detail: method }));
    const values = args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a));
    let value;
    if (method === "open") {
      active = isIdml(values[0]) ? await idmlWorkspace() : workspace;
      value = active.open(values[0]);
    } else if (method === "add_font") {
      local.push(values[0].slice());
      workspace.add_font(values[0].slice());
      idml?.add_font(values[0]);
    } else if (method === "format") {
      value = active === workspace ? "pptx" : active.format();
    } else {
      if (typeof active[method] !== "function") throw new Error(JSON.stringify({ code: "unsupported_content", detail: `${method} is not available for this document` }));
      value = active[method](...values);
    }
    if (value instanceof Uint8Array) {
      const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      self.postMessage({ id, value: buffer }, [buffer]);
    } else self.postMessage({ id, value });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
