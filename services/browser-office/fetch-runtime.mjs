import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(serviceRoot, "upstream.json"), "utf8"),
);
const outputRoot = path.resolve(
  process.argv[2] ?? path.join(serviceRoot, "runtime"),
);

const fonts = JSON.parse(
  await readFile(path.join(serviceRoot, "fonts.json"), "utf8"),
);
const fontSource = new URL(fonts.source.repository).pathname;
await mkdir(path.join(outputRoot, "fonts"), { recursive: true });
const downloadableAssets = [
  ...manifest.runtimeAssets.map((asset) => ({
    ...asset,
    url: new URL(asset.path, manifest.runtimeBaseUrl),
  })),
  manifest.javascriptBridge.runtimeAsset,
  // Korean fonts the engine does not carry (see fonts.json).
  ...fonts.fonts.map((font) => ({
    ...font,
    storedPath: `fonts/${font.file}`,
    url: `https://raw.githubusercontent.com${fontSource}/${fonts.source.commit}/${font.path}`,
    requestEncoding: "identity",
  })),
];

for (const asset of downloadableAssets) {
  const destination = path.join(outputRoot, asset.storedPath);
  if (await matches(destination, asset)) {
    process.stdout.write(`verified ${asset.storedPath}\n`);
    continue;
  }
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });
  try {
    await download(new URL(asset.url), temporary, asset.requestEncoding);
    if (!(await matches(temporary, asset)))
      throw new Error(
        `${asset.url} does not match the pinned ${asset.bytes}-byte ${asset.sha256} artifact.`,
      );
    await rename(temporary, destination);
    process.stdout.write(`downloaded ${asset.storedPath}\n`);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function matches(file, asset) {
  try {
    if ((await stat(file)).size !== asset.bytes) return false;
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    return digest === asset.sha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function download(url, destination, encoding, redirects = 0) {
  if (redirects > 5)
    throw new Error(`Too many redirects while downloading ${url}.`);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: { "Accept-Encoding": encoding, "User-Agent": "Spellbook/0.1" },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          download(
            new URL(response.headers.location, url),
            destination,
            encoding,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `${url} returned HTTP ${response.statusCode ?? "unknown"}.`,
            ),
          );
          return;
        }
        if (
          encoding !== "identity" &&
          response.headers["content-encoding"] !== encoding
        ) {
          response.resume();
          reject(
            new Error(
              `${url} was not served with Content-Encoding: ${encoding}.`,
            ),
          );
          return;
        }
        const output = createWriteStream(destination, { flags: "wx" });
        response.pipe(output);
        output.on("finish", () => output.close(resolve));
        output.on("error", reject);
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}
