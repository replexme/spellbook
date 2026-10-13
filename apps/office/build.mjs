#!/usr/bin/env node
// Builds the document view as a static site:
//   node apps/office/build.mjs --out <new dir> --glue <wasm-bindgen --target web dir> --host-origins <origin,...> [--cache <dir>]
// The glue directory holds present_engine_wasm.js and present_engine_wasm_bg.wasm
// built from engine/wasm, and present_idml_wasm.js and present_idml_wasm_bg.wasm
// built from engine/wasm-idml (see build.sh). Fonts are downloaded once into the
// cache and checked against fonts.lock.json.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFonts } from "./fonts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []));
for (const k of ["out", "glue", "host-origins"]) if (!args[k]) throw Error(`--${k} is required`);
const out = path.resolve(args.out);
const cache = path.resolve(args.cache ?? path.join(os.homedir(), ".cache", "present-office-fonts"));
const hostOrigins = args["host-origins"].split(",").map((o) => o.trim()).filter(Boolean);
for (const o of hostOrigins) if (new URL(o).origin !== o) throw Error(`not an origin: ${o}`);
try {
  if ((await fs.readdir(out)).length) throw Error(`${out} is not empty`);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

await fs.mkdir(path.join(out, "engine"), { recursive: true });
await fs.mkdir(path.join(out, "fonts"), { recursive: true });
await fs.mkdir(path.join(out, "licenses"), { recursive: true });
// The engine includes DesignCraft parts (MIT OR Apache-2.0), their bundled fonts (OFL) and
// the Hunspell English hyphenation patterns (BSD-style): their notices ship with it.
const vendor = path.join(here, "..", "..", "engine", "vendor");
for (const [from, to] of [
  ["LICENSE-MIT", "DesignCraft-LICENSE-MIT.txt"],
  ["LICENSE-APACHE", "DesignCraft-LICENSE-APACHE.txt"],
  ["NOTICE", "DesignCraft-NOTICE.txt"],
  ["designcraft-fonts/assets/fonts/OFL-Inter.txt", "OFL-Inter.txt"],
  ["designcraft-fonts/assets/fonts/OFL-JetBrainsMono.txt", "OFL-JetBrainsMono.txt"],
  ["designcraft-fonts/assets/fonts/OFL-SourceSans3.txt", "OFL-SourceSans3.txt"],
  ["designcraft-fonts/assets/fonts/OFL-SourceSerif4.txt", "OFL-SourceSerif4.txt"],
])
  await fs.copyFile(path.join(vendor, from), path.join(out, "licenses", to));
for (const f of ["workspace.mjs", "engine-worker.mjs", "commands.mjs", "observation.mjs", "idml.mjs", "workspace.css", "native-edit-capabilities.json"])
  await fs.copyFile(path.join(here, "src", f), path.join(out, f));
const runtime = {
  hostOrigins,
  // Installed families read when the person has allowed Local Font Access.
  localFontFamilies: ["Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Calibri", "Arial", "Helvetica", "Pretendard", "Noto Sans KR", "NanumGothic", "나눔고딕", "NanumSquareRound", "Gulim", "굴림", "Dotum", "돋움", "Batang", "바탕", "Times New Roman", "Georgia", "Verdana", "Segoe UI", "Apple Color Emoji"],
};
const html = (await fs.readFile(path.join(here, "src", "workspace.html"), "utf8")).replace("__OFFICE_RUNTIME__", JSON.stringify(runtime).replaceAll("<", "\\u003c"));
await fs.writeFile(path.join(out, "workspace.html"), html);
for (const f of ["present_engine_wasm.js", "present_engine_wasm_bg.wasm", "present_idml_wasm.js", "present_idml_wasm_bg.wasm"]) await fs.copyFile(path.join(args.glue, f), path.join(out, "engine", f));

const fonts = await installFonts(path.join(out, "fonts"), path.join(out, "licenses"), cache);
await fs.writeFile(path.join(out, "fonts", "manifest.json"), JSON.stringify({ files: fonts }));

let revision = "unknown";
try {
  revision = execFileSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
const wasm = await fs.readFile(path.join(out, "engine", "present_engine_wasm_bg.wasm"));
const idmlWasm = await fs.readFile(path.join(out, "engine", "present_idml_wasm_bg.wasm"));
const ready = { status: "ready", engine: "present", sourceRevision: revision, wasmSha256: sha256(wasm), idmlWasmSha256: sha256(idmlWasm) };
await fs.writeFile(path.join(out, "readyz.json"), JSON.stringify(ready));
// The static origin serves /readyz from readyz.html (clean URLs).
await fs.writeFile(path.join(out, "readyz.html"), `<!doctype html><meta charset="utf-8"><title>ready</title><pre>${JSON.stringify(ready)}</pre>\n`);
await fs.writeFile(path.join(out, "index.html"), '<!doctype html><meta charset="utf-8"><title>Spellbook</title><p>Spellbook document view.</p>\n');
console.log(JSON.stringify({ out, fonts: fonts.length, hostOrigins, sourceRevision: revision }));
