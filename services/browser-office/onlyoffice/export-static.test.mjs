/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import { exportOnlyOfficeStatic } from "./export-static.mjs";
test("unadmitted candidate cannot produce a public release artifact", async () => {
  await assert.rejects(
    exportOnlyOfficeStatic({ out: "/nonexistent/unowned" }),
    /onlyoffice_public_release_not_admitted/,
  );
});
