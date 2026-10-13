import fs from "node:fs";
import path from "node:path";

import {
  booleanOption,
  compose,
  composeCapture,
  copyPrivateFile,
  ensureComposeVolume,
  parseNamedArguments,
  requireBackupMembers,
  requiredStringOption,
  restoreVolume,
  sleepSync,
  validateProjectName,
  verifyBackupManifest,
} from "./selfhost-archive-lib.mjs";

const root = process.cwd();
const options = parseNamedArguments(
  process.argv.slice(2),
  new Set(["backup", "project", "confirm", "restore-config", "start"]),
);
const backup = path.resolve(root, requiredStringOption(options, "backup"));
const project = validateProjectName(
  requiredStringOption(options, "project", "spellbook"),
);
if (options.confirm !== project)
  throw new Error(
    `Restore replaces ${project} data. Pass --confirm=${project}.`,
  );
const restoreConfig = booleanOption(options, "restore-config");
const start = booleanOption(options, "start");
const manifest = verifyBackupManifest(backup);
requireBackupMembers(manifest, [
  "database.dump",
  "document-data.tar.gz",
  "ai-auth-data.tar.gz",
  "config/.env",
]);

if (restoreConfig) {
  const configDirectory = path.join(backup, "config");
  const environmentSource = path.join(configDirectory, ".env");
  replacePrivateFile(environmentSource, path.join(root, ".env"));
}

const runningBefore = new Set(
  composeCapture(project, ["ps", "--services", "--status", "running"])
    .split("\n")
    .filter(Boolean),
);
const services = ["web", "document-worker", "ai-connector", "database"];
const runningServices = services.filter((service) =>
  runningBefore.has(service),
);
if (runningServices.length)
  compose(project, ["stop", "--timeout", "30", ...runningServices]);

compose(project, ["up", "-d", "database"]);
waitForDatabase(project);
const helperImage = composeCapture(project, ["images", "-q", "database"]);
if (!helperImage) throw new Error("Database image is unavailable.");

restoreVolume({
  image: helperImage,
  volume: ensureComposeVolume(project, "document-data"),
  source: backup,
  fileName: "document-data.tar.gz",
});
restoreVolume({
  image: helperImage,
  volume: ensureComposeVolume(project, "ai-auth-data"),
  source: backup,
  fileName: "ai-auth-data.tar.gz",
});

compose(project, [
  "exec",
  "-T",
  "database",
  "psql",
  "--username=spellbook",
  "--dbname=postgres",
  "--set=ON_ERROR_STOP=1",
  "--command=select pg_terminate_backend(pid) from pg_stat_activity where datname='spellbook' and pid <> pg_backend_pid();",
  "--command=drop database if exists spellbook;",
  "--command=create database spellbook owner spellbook template template0;",
]);
const dumpFile = fs.openSync(path.join(backup, "database.dump"), "r");
try {
  compose(
    project,
    [
      "exec",
      "-T",
      "database",
      "pg_restore",
      "--exit-on-error",
      "--username=spellbook",
      "--dbname=spellbook",
      "--no-owner",
      "--no-privileges",
    ],
    { stdio: [dumpFile, "inherit", "inherit"] },
  );
} finally {
  fs.closeSync(dumpFile);
}
compose(project, [
  "exec",
  "-T",
  "database",
  "psql",
  "--username=spellbook",
  "--dbname=spellbook",
  "--set=ON_ERROR_STOP=1",
  "--command=analyze;",
]);

const servicesToStart = start
  ? services.filter((service) => service !== "database")
  : runningServices.filter((service) => service !== "database");
if (servicesToStart.length) compose(project, ["up", "-d", ...servicesToStart]);
process.stdout.write(
  `Restored verified backup from ${backup} into ${project} (${manifest.createdAt}).\n`,
);

function replacePrivateFile(source, destination) {
  const temporary = `${destination}.restore-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  copyPrivateFile(source, temporary);
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function waitForDatabase(projectName) {
  const container = composeCapture(projectName, ["ps", "-q", "database"]);
  if (!container) throw new Error("Database container was not created.");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = composeCapture(projectName, [
      "ps",
      "--format",
      "json",
      "database",
    ]);
    if (health.includes('"Health":"healthy"')) return;
    sleepSync(1_000);
  }
  throw new Error("Database did not become healthy.");
}
