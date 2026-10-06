/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import {
  configuredBrowserEngine,
  admitSelectedOnlyOffice,
  selectedDistribution,
  selection,
} from "./engine-selection.mjs";
import { createOnlyOfficeWorkspaceServer } from "./onlyoffice/workspace-server.mjs";
import { createHarnessServer, configuredServerPort } from "./server.mjs";
const engine = configuredBrowserEngine(),
  port = configuredServerPort(),
  bind = process.env.HOST || "127.0.0.1";
const servers = [];
try {
  if (engine === "libreoffice") {
    let options = {};
    const directory = process.env.SPELLBOOK_LIBREOFFICE_RUNTIME_DIRECTORY;
    const manifestPath = process.env.SPELLBOOK_LIBREOFFICE_MANIFEST;
    if (!!directory !== !!manifestPath)
      throw Error("libreoffice_rollback_runtime_and_manifest_required");
    if (directory) {
      const runtime = await admitCandidateRuntime({
        runtimeDirectory: directory,
        manifest: JSON.parse(await fs.readFile(manifestPath, "utf8")),
      });
      options = {
        runtimeRoot: runtime.runtimeDirectory,
        runtimeIdentity: runtime.runtimeIdentity,
        upstream: runtime.upstream,
        hostOrigin: process.env.SPELLBOOK_BROWSER_HOST_ORIGIN,
      };
    }
    const server = createHarnessServer(options);
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, bind, resolve);
    });
  } else {
    const directory = selectedDistribution(),
      admission = await admitSelectedOnlyOffice(directory);
    for (const name of [
      "workspace.bundle.js",
      "sdk.bundle.js",
      "local-ai.bundle.js",
      "workspace-sources.tar.gz",
      "workspace-source-receipt.json",
    ]) {
      await fs.access(
        new URL("./onlyoffice/workspace-dist/" + name, import.meta.url),
      );
    }
    await fs.access(new URL("./runtime/ooxml-worker.js", import.meta.url));
    const workspaceOrigin =
      process.env.SPELLBOOK_BROWSER_OFFICE_PUBLIC_URL ||
      `http://127.0.0.1:${port}`;
    const sdkOrigin =
      process.env.SPELLBOOK_ONLYOFFICE_SDK_ORIGIN ||
      `http://127.0.0.1:${port + 1}`;
    const inspectionOrigin =
      process.env.SPELLBOOK_ONLYOFFICE_INSPECTION_ORIGIN ||
      `http://127.0.0.1:${port + 2}`;
    const hostOrigins = (
      process.env.SPELLBOOK_BROWSER_HOST_ORIGINS ||
      process.env.SPELLBOOK_BROWSER_HOST_ORIGIN ||
      "http://localhost:3000"
    )
      .split(",")
      .map((x) => x.trim());
    const origins = [workspaceOrigin, sdkOrigin, inspectionOrigin];
    if (new Set(origins.map((x) => new URL(x).protocol)).size !== 1)
      throw Error("office_origins_protocol_mismatch");
    // A reverse proxy may route all three HTTPS names to one listening port.
    // Local direct serving uses three ports to preserve the same origin boundary.
    const ports = origins.every((x) => new URL(x).protocol === "http:")
      ? origins.map((x) => Number(new URL(x).port || 80))
      : [port];
    if (ports.length === 3 && new Set(ports).size !== 3)
      throw Error("local_office_ports_must_differ");
    for (const listenPort of ports) {
      const server = createOnlyOfficeWorkspaceServer({
        distributionDirectory: directory,
        workspaceOrigin,
        sdkOrigin,
        inspectionOrigin,
        hostOrigins,
        admission,
        publicReleaseAdmitted: selection.onlyoffice.publicReleaseAdmitted,
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, bind, resolve);
      });
    }
    console.log(
      JSON.stringify({
        engine,
        admission,
        origins,
        publicReleaseAdmitted: selection.onlyoffice.publicReleaseAdmitted,
      }),
    );
  }
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
} finally {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
}
