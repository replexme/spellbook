/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  admitSelectedOnlyOffice,
  selectedDistribution,
  selection,
} from "../engine-selection.mjs";
import { createOnlyOfficeWorkspaceServer } from "./workspace-server.mjs";
import { localUiFiles } from "../local-ui-assets.mjs";
export async function exportOnlyOfficeStatic({
  out,
  workspaceOrigin,
  sdkOrigin,
  inspectionOrigin,
  hostOrigins,
  distributionDirectory = selectedDistribution(),
  candidate = false,
}) {
  if (!candidate && !selection.onlyoffice.publicReleaseAdmitted)
    throw Error("onlyoffice_public_release_not_admitted");
  const admission = await admitSelectedOnlyOffice(distributionDirectory);
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8",
  }).trim();
  await fs.mkdir(out, { recursive: false }); // Never overwrite an existing artifact.
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(distributionDirectory, "distribution-manifest.json"),
      "utf8",
    ),
  );
  const identities = new Map(),
    sha = (b) => createHash("sha256").update(b).digest("hex");
  for (const entry of [
    ...manifest.files,
    { path: "distribution-manifest.json" },
  ]) {
    // The Replex static packager owns transport compression and rejects
    // precompressed inputs. Keep authoritative emitted plain bytes only.
    if (entry.path.endsWith(".br")) continue;
    const destination = path.join(out, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(
      path.join(distributionDirectory, entry.path),
      destination,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    identities.set(
      entry.path,
      entry.sha256 || sha(await fs.readFile(destination)),
    );
  }
  const server = createOnlyOfficeWorkspaceServer({
    distributionDirectory,
    workspaceOrigin,
    sdkOrigin,
    inspectionOrigin,
    hostOrigins,
    admission,
    publicReleaseAdmitted: selection.onlyoffice.publicReleaseAdmitted,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = [],
    rewrites = [];
  try {
    for (const route of [
      ...Object.keys(localUiFiles),
      "/workspace",
      "/local",
      "/licenses",
      "/readyz",
      "/workspace.bundle.js",
      "/sdk.bundle.js",
      "/local-ai.bundle.js",
      "/local-workspace.mjs",
      "/local-phone-view.mjs",
      "/local-file.mjs",
      "/comparison-repair.js",
      "/workspace-sources.tar.gz",
      "/workspace-source-receipt.json",
      "/sw.js",
      "/verification-cache-worker.js",
      "/document_editor_service_worker.js",
      "/web-apps/apps/presentationeditor/main/index.html",
      "/assets/officeHost-C2hljZhH.js",
    ]) {
      const response = await fetch(origin + route);
      if (!response.ok) throw Error("static_export_route_failed:" + route);
      const served = Buffer.from(await response.arrayBuffer());
      const bytes = route === "/readyz"
        ? Buffer.from(JSON.stringify({ ...JSON.parse(served), editorSourceRevision: sourceRevision, receiptSha256: admission.distributionSha256 }))
        : served,
        file =
          route === "/"
            ? "index.html"
            : route.slice(1) +
              (["/workspace", "/local", "/licenses"].includes(route)
                ? ".html"
                : route === "/readyz"
                  ? ".json"
                  : "");
      await fs.mkdir(path.dirname(path.join(out, file)), { recursive: true });
      await fs.writeFile(path.join(out, file), bytes);
      identities.set(file, sha(bytes));
      if (identities.has(file + ".br")) {
        const compressed = brotliCompressSync(bytes);
        await fs.writeFile(path.join(out, file + ".br"), compressed);
        identities.set(file + ".br", sha(compressed));
      }
      headers.push({
        source: route,
        headers: [...response.headers.entries()]
          .filter(
            ([k]) =>
              ![
                "date",
                "connection",
                "keep-alive",
                "transfer-encoding",
                "content-length",
              ].includes(k),
          )
          .map(([key, value]) => ({ key, value })),
      });
      if ("/" + file !== route)
        rewrites.push({ source: route, destination: "/" + file });
    }
    headers.unshift({
      source: "**",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    });
    await fs.writeFile(
      path.join(out, "firebase.json"),
      JSON.stringify({ hosting: { public: ".", headers, rewrites } }, null, 2),
    );
    const receipt = {
      engine: "onlyoffice",
      candidate: !selection.onlyoffice.publicReleaseAdmitted,
      admission,
      origins: { workspaceOrigin, sdkOrigin, inspectionOrigin, hostOrigins },
      files: [...identities].map(([file, sha256]) => ({ file, sha256 })),
      engineBuilds: 0,
      procedure:
        "Verified pinned files plus served host overlays; same artifact served at three distinct origins; compression delegated to the authoritative static packager.",
    };
    await fs.writeFile(
      path.join(out, "onlyoffice-static-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    return receipt;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf("--" + name);
    if (i < 0 || !process.argv[i + 1]) throw Error("missing_" + name);
    return process.argv[i + 1];
  };
  console.log(
    JSON.stringify(
      await exportOnlyOfficeStatic({
        out: arg("out"),
        workspaceOrigin: arg("workspace-origin"),
        sdkOrigin: arg("sdk-origin"),
        inspectionOrigin: arg("inspection-origin"),
        hostOrigins: arg("host-origins").split(","),
        candidate: process.argv.includes("--candidate"),
      }),
    ),
  );
}
