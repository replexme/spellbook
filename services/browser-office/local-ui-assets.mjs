/* SPDX-License-Identifier: MPL-2.0 */
import { fileURLToPath } from "node:url";
export const localUiFiles = Object.fromEntries([
  ["/local-workspace.css", new URL("./local-workspace.css", import.meta.url)],
  ...["tokens", "base", "components", "patterns"].map(name => [
    `/design-system/${name}.css`,
    new URL(`../../apps/web/src/design-system/${name}.css`, import.meta.url),
  ]),
].map(([route, url]) => [route, fileURLToPath(url)]));
