#!/usr/bin/env node
// The fallback fonts the engine draws with when a document's own font is not available, as
// fonts.lock.json pins them: the document view serves them to the browser, and the document
// worker draws its previews with the same files so a preview looks like the view.
//   node apps/office/fonts.mjs <fonts dir> <licences dir> [--cache <dir>]
// Downloads go to the cache once and are checked against their recorded checksums.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Copies every locked font into `fontsDir` and its licences into `licensesDir`; returns the font file names. */
export async function installFonts(fontsDir, licensesDir, cache = path.join(os.homedir(), ".cache", "present-office-fonts")) {
  const fetchLocked = async (entry) => {
    await fs.mkdir(cache, { recursive: true });
    const file = path.join(cache, entry.name);
    let body = await fs.readFile(file).catch(() => null);
    if (!body || sha256(body) !== entry.sha256) {
      const res = await fetch(entry.url);
      if (!res.ok) throw Error(`${entry.url}: ${res.status}`);
      body = Buffer.from(await res.arrayBuffer());
      if (sha256(body) !== entry.sha256) throw Error(`${entry.name}: checksum differs from fonts.lock.json`);
      await fs.writeFile(file, body);
    }
    return file;
  };
  await fs.mkdir(fontsDir, { recursive: true });
  await fs.mkdir(licensesDir, { recursive: true });
  const lock = JSON.parse(await fs.readFile(path.join(here, "fonts.lock.json"), "utf8"));
  const fonts = [];
  for (const entry of lock.files) {
    const file = await fetchLocked(entry);
    if (entry.extract) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "present-fonts-"));
      try {
        execFileSync("tar", ["-xzf", file, "-C", dir]);
        const root = path.join(dir, (await fs.readdir(dir))[0]);
        for (const name of entry.extract) {
          await fs.copyFile(path.join(root, name), path.join(fontsDir, name));
          fonts.push(name);
        }
        if (entry.license) await fs.copyFile(path.join(root, entry.license), path.join(licensesDir, "OFL-Liberation.txt"));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } else {
      await fs.copyFile(file, path.join(fontsDir, entry.name));
      fonts.push(entry.name);
    }
  }
  for (const entry of lock.licenses) await fs.copyFile(await fetchLocked(entry), path.join(licensesDir, entry.name));
  return fonts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [fontsDir, licensesDir] = process.argv.slice(2);
  if (!fontsDir || !licensesDir) throw Error("usage: node apps/office/fonts.mjs <fonts dir> <licences dir> [--cache <dir>]");
  const at = process.argv.indexOf("--cache");
  console.log((await installFonts(path.resolve(fontsDir), path.resolve(licensesDir), at > 0 ? path.resolve(process.argv[at + 1]) : undefined)).join("\n"));
}
