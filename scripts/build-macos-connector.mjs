#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error("The macOS connector must be assembled on macOS.");
if (!["arm64", "x64"].includes(process.arch))
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = "22.22.3";
const version = JSON.parse(
  fs.readFileSync(path.join(root, "apps/ai-connector/package.json"), "utf8"),
).version;
const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
const codexTarget = `${architecture}-apple-darwin`;
const artifactRoot = path.join(
  root,
  "artifacts",
  "connector",
  `macos-${process.arch}`,
);
const buildRoot = path.join(
  root,
  ".tmp-connector-build",
  `macos-${process.arch}`,
);
const app = path.join(artifactRoot, "Spellbook AI Connector.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const executable = path.join(macos, "SpellbookAIConnector");
const bundle = path.join(buildRoot, "connector.cjs");
const blob = path.join(buildRoot, "connector.blob");
const seaConfig = path.join(buildRoot, "sea-config.json");
const archive = path.join(
  artifactRoot,
  `spellbook-ai-connector-${version}-macos-${process.arch}.zip`,
);

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.rmSync(artifactRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

run("pnpm", [
  "exec",
  "esbuild",
  "apps/ai-connector/src/desktop-entry.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  '--define:import.meta.url="file:///spellbook-connector.cjs"',
  `--outfile=${bundle}`,
]);
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
const nodeArchiveName = `node-v${nodeVersion}-darwin-${process.arch}.tar.gz`;
const nodeDistribution = `https://nodejs.org/dist/v${nodeVersion}`;
const [nodeArchiveResponse, checksumsResponse] = await Promise.all([
  fetch(`${nodeDistribution}/${nodeArchiveName}`),
  fetch(`${nodeDistribution}/SHASUMS256.txt`),
]);
if (!nodeArchiveResponse.ok || !checksumsResponse.ok)
  throw new Error("The pinned Node.js distribution could not be downloaded.");
const nodeArchive = Buffer.from(await nodeArchiveResponse.arrayBuffer());
const expectedNodeSha = (await checksumsResponse.text())
  .split("\n")
  .find((line) => line.endsWith(`  ${nodeArchiveName}`))
  ?.split(/\s+/, 1)[0];
const actualNodeSha = createHash("sha256").update(nodeArchive).digest("hex");
if (!expectedNodeSha || actualNodeSha !== expectedNodeSha)
  throw new Error("The pinned Node.js distribution checksum did not match.");
const nodeArchivePath = path.join(buildRoot, nodeArchiveName);
fs.writeFileSync(nodeArchivePath, nodeArchive);
run("tar", ["-xzf", nodeArchivePath, "-C", buildRoot]);
fs.copyFileSync(
  path.join(
    buildRoot,
    `node-v${nodeVersion}-darwin-${process.arch}`,
    "bin",
    "node",
  ),
  executable,
);
fs.chmodSync(executable, 0o755);
run(executable, ["--experimental-sea-config", seaConfig]);
try {
  run("codesign", ["--remove-signature", executable]);
} catch {}
run("pnpm", [
  "exec",
  "postject",
  executable,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  "--macho-segment-name",
  "NODE_SEA",
]);

const require = createRequire(import.meta.url);
const codexManifestPath = require.resolve("@openai/codex/package.json", {
  paths: [path.join(root, "apps/ai-connector")],
});
const codexVersion = JSON.parse(
  fs.readFileSync(codexManifestPath, "utf8"),
).version;
const platformPackage = path.join(
  root,
  "node_modules",
  ".pnpm",
  `@openai+codex@${codexVersion}-darwin-${process.arch}`,
  "node_modules",
  "@openai",
  "codex",
);
if (!fs.existsSync(platformPackage))
  throw new Error(
    `The installed Codex package does not include ${codexTarget}.`,
  );
const vendorRoot = path.join(platformPackage, "vendor", codexTarget);
fs.cpSync(vendorRoot, path.join(resources, "codex"), { recursive: true });
fs.cpSync(path.join(root, "contracts"), path.join(resources, "contracts"), {
  recursive: true,
});

fs.writeFileSync(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Spellbook AI Connector</string>
<key>CFBundleExecutable</key><string>SpellbookAIConnector</string>
<key>CFBundleIdentifier</key><string>me.replex.spellbook.connector</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
);

const signingIdentity =
  process.env.SPELLBOOK_MACOS_SIGN_IDENTITY?.trim() || "-";
const signingArgs = [
  "--force",
  ...(signingIdentity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
  "--sign",
  signingIdentity,
];
run("codesign", [
  ...signingArgs,
  path.join(resources, "codex", "bin", "codex"),
]);
run("codesign", [...signingArgs, executable]);
run("codesign", [...signingArgs, "--deep", app]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const smoke = await smokeTest(executable);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);

process.stdout.write(
  `${JSON.stringify({
    app,
    archive,
    archiveSha256: createHash("sha256")
      .update(fs.readFileSync(archive))
      .digest("hex"),
    signingIdentity,
    smoke,
  })}\n`,
);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

async function smokeTest(binary) {
  const port = await freePort();
  const child = spawn(binary, [], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => (diagnostics += chunk.toString()));
  child.stderr.on("data", (chunk) => (diagnostics += chunk.toString()));
  try {
    const health = await waitForHealth(port, child, () => diagnostics);
    if (health.capabilities?.localTurns !== true)
      throw new Error(
        "Packaged connector does not support local document turns.",
      );
    const origin = "https://package-smoke.spellbook.invalid";
    const response = await fetch(`http://127.0.0.1:${port}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        challenge: "package_smoke_challenge_1234567890_abcdef",
      }),
    });
    if (response.status !== 201)
      throw new Error(
        `Packaged connector pairing returned ${response.status}.`,
      );
    const pairing = await response.json();
    const approval = await fetch(pairing.approvalUrl);
    if (!approval.ok || !(await approval.text()).includes(origin))
      throw new Error(
        "Packaged connector approval page did not bind the origin.",
      );
    return {
      health: health.status,
      mode: health.mode,
      protocolVersion: health.protocolVersion,
      capabilities: health.capabilities,
      pairingStatus: response.status,
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function waitForHealth(port, child, diagnostics) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `Packaged connector exited before health check: ${diagnostics().trim()}`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Packaged connector health check timed out: ${diagnostics().trim()}`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a connector smoke-test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
