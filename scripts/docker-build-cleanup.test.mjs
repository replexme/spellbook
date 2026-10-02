import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const scenario of [
  { name: "successful build", build: 0, prune: 0, expected: 0 },
  { name: "failed build", build: 23, prune: 0, expected: 23 },
  { name: "failed cleanup", build: 0, prune: 11, expected: 1 },
  {
    name: "terminated build",
    build: 0,
    prune: 0,
    terminate: true,
    expected: 143,
  },
]) {
  test(`runtime ${scenario.name} discards build cache and preserves its outcome`, () => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "spellbook-build-cleanup-"),
    );
    try {
      const log = path.join(temp, "commands.jsonl");
      fs.writeFileSync(
        path.join(temp, "docker"),
        `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='build') {
  if(process.env.FIXTURE_TERMINATE==='true')process.kill(process.ppid,'SIGTERM');
  process.exit(Number(process.env.FIXTURE_BUILD_EXIT));
}

if(a.join(' ')==='builder prune --all --force')process.exit(Number(process.env.FIXTURE_PRUNE_EXIT));
process.exit(99);
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        "bash",
        [
          path.join(
            root,
            "services/office-editor/libreoffice/build-runtime.sh",
          ),
        ],
        {
          env: {
            ...process.env,
            PATH: temp + path.delimiter + process.env.PATH,
            FIXTURE_DOCKER_LOG: log,
            FIXTURE_BUILD_EXIT: String(scenario.build),
            FIXTURE_PRUNE_EXIT: String(scenario.prune),
            FIXTURE_TERMINATE: String(scenario.terminate ?? false),
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.equal(result.status, scenario.expected, result.stderr);
      const commands = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(commands[0][0], "build");
      assert.deepEqual(commands.slice(1), [
        ["builder", "prune", "--all", "--force"],
      ]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

for (const failure of [null, "image", "inventory"]) {
  test(`image cleanup ${failure ? `${failure} failure still prunes cache` : "removes all aliases without forcing an image"}`, () => {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "spellbook-image-cleanup-"),
    );
    try {
      const log = path.join(temp, "commands.jsonl");
      fs.writeFileSync(
        path.join(temp, "docker"),
        `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='ps')process.exit(process.env.FIXTURE_CLEANUP_FAILURE==='inventory'?18:0);
if(a[0]==='image'&&a[1]==='ls'){process.stdout.write('sha256:fixture');process.exit(0)}
if(a[0]==='inspect'){process.stdout.write(JSON.stringify([{Id:'sha256:fixture',Created:'2026-10-03T00:00:00Z',Config:{Labels:{'org.spellbook.component':'web'}},RepoTags:['spellbook-web:first','spellbook-web:second']} ]));process.exit(0)}
if(a[0]==='image'&&a[1]==='rm')process.exit(process.env.FIXTURE_CLEANUP_FAILURE==='image'?17:0);
if(a.join(' ')==='builder prune --all --force')process.exit(0);
process.exit(99);
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/cleanup-local-docker.mjs"), "--execute"],
        {
          env: {
            ...process.env,
            PATH: temp + path.delimiter + process.env.PATH,
            FIXTURE_DOCKER_LOG: log,
            FIXTURE_CLEANUP_FAILURE: failure ?? "none",
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const commands = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(commands.at(-1), [
        "builder",
        "prune",
        "--all",
        "--force",
      ]);
      assert.deepEqual(
        commands.filter((c) => c[0] === "image" && c[1] === "rm"),
        (failure === "inventory"
          ? []
          : failure === "image"
            ? ["spellbook-web:first"]
            : ["spellbook-web:first", "spellbook-web:second"]
        ).map((reference) => ["image", "rm", "--", reference]),
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
