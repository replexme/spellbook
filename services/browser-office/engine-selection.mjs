/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOfficeDistribution } from "./distribution-check.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
export const selection = JSON.parse(
  await fs.readFile(path.join(root, "engine-selection.json"), "utf8"),
);
export function configuredBrowserEngine(environment = process.env) {
  const engine =
    environment.SPELLBOOK_BROWSER_ENGINE?.trim() || selection.defaultEngine;
  if (!["onlyoffice", "libreoffice"].includes(engine))
    throw Error("browser_engine_invalid");
  return engine;
}
export async function admitSelectedOnlyOffice(directory) {
  const admission = await verifyOfficeDistribution(directory);
  if (admission.distributionSha256 !== selection.onlyoffice.distributionSha256)
    throw Error("onlyoffice_distribution_not_selected");
  return admission;
}
export function selectedDistribution(environment = process.env) {
  return path.resolve(
    environment.SPELLBOOK_ONLYOFFICE_DISTRIBUTION ||
      path.join(root, selection.onlyoffice.directory),
  );
}
