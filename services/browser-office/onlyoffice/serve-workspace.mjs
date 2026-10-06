/* SPDX-License-Identifier: MPL-2.0 */
import { verifyOfficeDistribution } from "../distribution-check.mjs";
import { createOnlyOfficeWorkspaceServer } from "./workspace-server.mjs";
const distributionDirectory = process.env.SPELLBOOK_ONLYOFFICE_DISTRIBUTION;
if (!distributionDirectory)
  throw Error("SPELLBOOK_ONLYOFFICE_DISTRIBUTION_required");
const workspaceOrigin =
  process.env.SPELLBOOK_BROWSER_OFFICE_URL ?? "http://127.0.0.1:35602";
const sdkOrigin =
  process.env.SPELLBOOK_ONLYOFFICE_SDK_ORIGIN ?? "http://127.0.0.1:35616";
const inspectionOrigin =
  process.env.SPELLBOOK_ONLYOFFICE_INSPECTION_ORIGIN ??
  "http://127.0.0.1:35617";
const hostOrigins = (
  process.env.SPELLBOOK_BROWSER_HOST_ORIGINS ?? workspaceOrigin
)
  .split(",")
  .map((s) => s.trim());
const admission = await verifyOfficeDistribution(distributionDirectory);
const servers = [];
try {
  for (const origin of [workspaceOrigin, sdkOrigin, inspectionOrigin]) {
    const url = new URL(origin);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
      throw Error("local_candidate_requires_loopback");
    const server = createOnlyOfficeWorkspaceServer({
      distributionDirectory,
      workspaceOrigin,
      sdkOrigin,
      inspectionOrigin,
      hostOrigins,
      admission,
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(url.port), "127.0.0.1", resolve);
    });
  }
  console.log(
    JSON.stringify({
      status: "local_candidate_ready",
      admission,
      origins: [workspaceOrigin, sdkOrigin, inspectionOrigin],
      engineBuilds: 0,
    }),
  );
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
