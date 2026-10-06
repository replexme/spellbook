/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import { selection } from "../engine-selection.mjs";
import { exportOnlyOfficeStatic } from "./export-static.mjs";
test("unadmitted candidate cannot produce a public release artifact", async () => {
  const previous = selection.onlyoffice.publicReleaseAdmitted;
  selection.onlyoffice.publicReleaseAdmitted = false;
  try { await assert.rejects(
    exportOnlyOfficeStatic({ out: "/nonexistent/unowned" }),
    /onlyoffice_public_release_not_admitted/,
  ); } finally { selection.onlyoffice.publicReleaseAdmitted = previous; }
});
