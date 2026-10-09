/* SPDX-License-Identifier: MPL-2.0 */
import * as objectStore from "./object-store.mjs";
/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { prepareOwnedLinkedImages } from "./prepare-linked-images.mjs";
import { readOwnedLinkedImages } from "./linked-image-snapshots.mjs";

export function ownedScopeFromObjectName(inputObject) {
  const match =
    typeof inputObject === "string" &&
    inputObject.match(
      /^accounts\/([A-Za-z0-9_-]+)\/documents\/([a-f0-9-]{36})\/(.+)$/i,
    );
  if (
    !match ||
    match[3].split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("external_image_owner_required");
  const accountId = Buffer.from(match[1], "base64url").toString("utf8");
  if (Buffer.from(accountId).toString("base64url") !== match[1])
    throw Error("external_image_owner_required");
  return { accountId, documentId: match[2] };
}

export async function prepareOwnedPptx(
  inputPath,
  inputObject,
  parentSourceSha256 = null,
  { store = objectStore, resourceDirectory = null } = {},
) {
  const scope = ownedScopeFromObjectName(inputObject),
    sourceBytes = new Uint8Array(await fs.readFile(inputPath));
  let browser, page, launch;
  try {
    const result = await prepareOwnedLinkedImages({
      ...scope,
      sourceBytes,
      parentSourceSha256,
      objectStore: store,
      validateImage: async (bytes, { signal } = {}) => {
        signal?.throwIfAborted();
        if (!browser) {
          launch = chromium.launch({
            headless: true,
            timeout: 10_000,
            executablePath:
              process.env.SPELLBOOK_CHROMIUM_EXECUTABLE || undefined,
          });
          browser = await launch;
          page = await browser.newPage();
        }
        const info = await page.evaluate(
          async (bytes) => {
            const source = new Uint8Array(bytes),
              bitmap = await createImageBitmap(new Blob([source]), {
                imageOrientation: "none",
              });
            try {
              return { width: bitmap.width, height: bitmap.height };
            } finally {
              bitmap.close();
            }
          },
          [...bytes],
        );
        signal?.throwIfAborted();
        const { inspectExternalRaster } = await import(
          "../browser-office/external-raster.mjs"
        );
        return { ...inspectExternalRaster(bytes), ...info };
      },
    });
    const resourceScope = {
      ...scope,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    };
    if (!result.manifest.images.length) {
      await fs.rm(inputPath + ".render-resources.json", { force: true });
      return { ...resourceScope, fetched: 0, reused: 0, imageCount: 0 };
    }
    if (resourceDirectory !== null) {
      const snapshot = await readOwnedLinkedImages({
        ...resourceScope,
        sourceBytes,
        objectStore: store,
      });
      // A managed writer publishes through its existing provider adapter. The
      // native converter receives only a verified, job-owned private copy.
      process.env.SPELLBOOK_DATA_DIR = resourceDirectory;
      const prefix =
        objectStore.accountPrefix(scope.accountId, scope.documentId) +
        "/render-resources";
      const copied = new Set();
      for (const asset of snapshot.assets)
        if (!copied.has(asset.sha256)) {
          copied.add(asset.sha256);
          await objectStore.putObjectIfAbsent(
            prefix + "/blobs/" + asset.sha256,
            asset.bytes,
            asset.contentType,
          );
        }
      await objectStore.putObjectIfAbsent(
        prefix + "/sources/" + resourceScope.sourceSha256 + ".json",
        Buffer.from(JSON.stringify(snapshot.manifest)),
        "application/json",
      );
      await readOwnedLinkedImages({
        ...resourceScope,
        sourceBytes,
        objectStore,
      });
      resourceScope.dataDirectory = resourceDirectory;
    }
    await fs.writeFile(
      inputPath + ".render-resources.json",
      JSON.stringify(resourceScope),
      { mode: 0o600 },
    );
    return {
      ...resourceScope,
      fetched: result.fetched,
      reused: result.reused,
      imageCount: result.manifest.images.length,
    };
  } finally {
    if (launch)
      await launch.then(
        (value) => value.close(),
        () => {},
      );
  }
}
if (process.argv[1] === import.meta.filename) {
  const [inputPath, inputObject, parentSourceSha256] = process.argv.slice(2);
  if (!inputPath || !inputObject)
    throw Error(
      "Usage: prepare-owned-pptx.mjs INPUT.pptx INPUT_OBJECT [PARENT_SHA256]",
    );
  process.stdout.write(
    JSON.stringify(
      await prepareOwnedPptx(
        inputPath,
        inputObject,
        parentSourceSha256 ?? null,
      ),
    ) + "\n",
  );
}
