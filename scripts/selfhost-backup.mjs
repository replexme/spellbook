import fs from "node:fs";
import path from "node:path";

import {
  archiveVolume,
  capture,
  compose,
  composeCapture,
  copyPrivateFile,
  parseNamedArguments,
  requiredStringOption,
  resolveComposeVolume,
  sleepSync,
  validateProjectName,
  writeBackupManifest,
} from "./selfhost-archive-lib.mjs";

const root = process.cwd();
const options = parseNamedArguments(
  process.argv.slice(2),
  new Set(["output", "project"]),
);
const project = validateProjectName(
  requiredStringOption(options, "project", "spellbook"),
);
const createdAt = new Date();
const defaultName = createdAt.toISOString().replace(/[:.]/g, "-");
const destination = path.resolve(
  root,
  requiredStringOption(options, "output", `.spellbook/backups/${defaultName}`),
);
if (fs.existsSync(destination))
  throw new Error(`Backup destination already exists: ${destination}`);
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
fs.mkdirSync(destination, { mode: 0o700 });
fs.mkdirSync(path.join(destination, "config"), { mode: 0o700 });

const environmentFile = path.join(root, ".env");
if (!fs.existsSync(environmentFile))
  throw new Error(".env is required. Run pnpm selfhost:setup first.");
const writeServices = ["web", "document-worker", "ai-connector"];
const runningBefore = new Set(
  composeCapture(project, ["ps", "--services", "--status", "running"])
    .split("\n")
    .filter(Boolean),
);
const writersToResume = writeServices.filter((service) =>
  runningBefore.has(service),
);
let databaseStartedForBackup = false;

try {
  if (writersToResume.length)
    compose(project, ["stop", "--timeout", "30", ...writersToResume]);
  if (!runningBefore.has("database")) {
    compose(project, ["up", "-d", "database"]);
    waitForDatabase(project);
    databaseStartedForBackup = true;
  }

  const dumpPath = path.join(destination, "database.dump");
  const dumpFile = fs.openSync(dumpPath, "wx", 0o600);
  try {
    compose(
      project,
      [
        "exec",
        "-T",
        "database",
        "pg_dump",
        "--username=spellbook",
        "--dbname=spellbook",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ],
      { stdio: ["ignore", dumpFile, "inherit"] },
    );
  } finally {
    fs.closeSync(dumpFile);
  }

  const helperImage = composeCapture(project, ["images", "-q", "database"]);
  if (!helperImage) throw new Error("Database image is unavailable.");
  archiveVolume({
    image: helperImage,
    volume: resolveComposeVolume(project, "document-data"),
    destination,
    fileName: "document-data.tar.gz",
  });
  archiveVolume({
    image: helperImage,
    volume: resolveComposeVolume(project, "ai-auth-data"),
    destination,
    fileName: "ai-auth-data.tar.gz",
  });
  copyPrivateFile(environmentFile, path.join(destination, "config", ".env"));

  const commit = capture("git", ["rev-parse", "HEAD"], { cwd: root });
  writeBackupManifest(
    destination,
    {
      createdAt: createdAt.toISOString(),
      sourceProject: project,
      sourceCommit: commit,
      stoppedWriteServices: writersToResume,
    },
    [
      "database.dump",
      "document-data.tar.gz",
      "ai-auth-data.tar.gz",
      "config/.env",
    ],
  );
  process.stdout.write(`Backup verified and written to ${destination}\n`);
} finally {
  if (writersToResume.length)
    compose(project, ["up", "-d", ...writersToResume]);
  if (databaseStartedForBackup)
    compose(project, ["stop", "--timeout", "30", "database"]);
}

function waitForDatabase(projectName) {
  const container = composeCapture(projectName, ["ps", "-q", "database"]);
  if (!container) throw new Error("Database container was not created.");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = capture("docker", [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      container,
    ]);
    if (health === "healthy") return;
    sleepSync(1_000);
  }
  throw new Error("Database did not become healthy.");
}
