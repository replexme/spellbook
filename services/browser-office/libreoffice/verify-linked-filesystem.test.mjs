import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyLinkedFilesystem } from "./verify-linked-filesystem.mjs";

test("linked JavaScript must create every packaged directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spellbook-linked-fs-"));
  const program = path.join(root, "instdir/program");
  const packageRoot = path.join(
    root,
    "workdir/CustomTarget/static/emscripten_fs_image",
  );
  try {
    await Promise.all([
      mkdir(program, { recursive: true }),
      mkdir(packageRoot, { recursive: true }),
    ]);
    const filename =
      "/instdir/share/config/soffice.cfg/modules/sdraw/menubar/menubar.xml";
    await Promise.all([
      writeFile(
        path.join(program, "soffice.js"),
        'Module["FS_createPath"]("/instdir/share/config/soffice.cfg/modules/sdraw","menubar",true,true);',
      ),
      writeFile(
        path.join(packageRoot, "soffice.data.js.metadata"),
        JSON.stringify({
          remote_package_size: 1,
          files: [
            ...["scalc", "swriter", "simpress"].map((module) => ({
              filename: `/instdir/share/config/soffice.cfg/modules/${module}/menubar/menubar.xml`,
              start: 0,
              end: 1,
            })),
            { filename, start: 0, end: 1 },
          ],
        }),
      ),
      writeFile(path.join(packageRoot, "soffice.data"), Buffer.from([1])),
    ]);
    await assert.rejects(
      verifyLinkedFilesystem(root),
      /JavaScript filesystem disagree.*scalc/u,
    );
    await writeFile(
      path.join(program, "soffice.js"),
      ["scalc", "swriter", "simpress", "sdraw"]
        .map(
          (module) =>
            `Module["FS_createPath"]("/instdir/share/config/soffice.cfg/modules/${module}","menubar",true,true);`,
        )
        .join("\n"),
    );
    await verifyLinkedFilesystem(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
