import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseRequired = [
  "SPELLBOOK_LOCAL_EMAIL",
  "SPELLBOOK_LOCAL_PASSWORD_HASH",
  "SPELLBOOK_SESSION_SECRET",
  "SPELLBOOK_INTERNAL_TOKEN",
  "SPELLBOOK_POSTGRES_PASSWORD",
];

const result = [];
const environment = readEnvironment(".env");
const editorMode = (environment.SPELLBOOK_EDITOR_MODE || "browser")
  .trim()
  .toLowerCase();
const editorModeValid = editorMode === "wopi" || editorMode === "browser";
result.push({ check: `editor mode ${editorMode}`, ok: editorModeValid });
const required = [
  ...baseRequired,
  ...(editorMode === "wopi" ? ["SPELLBOOK_WOPI_SECRET"] : []),
];
for (const key of required) {
  const value = environment[key];
  const valid =
    key === "SPELLBOOK_LOCAL_PASSWORD_HASH"
      ? value?.startsWith("scrypt:")
      : key === "SPELLBOOK_LOCAL_EMAIL"
        ? Boolean(value?.includes("@"))
        : Boolean(value && value.length >= 32);
  result.push({ check: key, ok: valid });
}

const proofMode = environment.SPELLBOOK_WOPI_PROOF_MODE || "required";
result.push({
  check: "WOPI proof verification required",
  ok: editorMode !== "wopi" || proofMode === "required",
});
const storageReserve = Number(
  environment.SPELLBOOK_STORAGE_RESERVE_BYTES || 512 * 1024 * 1024,
);
result.push({
  check: "storage safety reserve",
  ok:
    Number.isSafeInteger(storageReserve) &&
    storageReserve >= 64 * 1024 * 1024 &&
    storageReserve <= 1024 * 1024 * 1024 * 1024,
});
const proofKeyPath = path.resolve(
  environment.SPELLBOOK_WOPI_PROOF_KEY_PATH ||
    ".spellbook/secrets/wopi-proof-key.pem",
);
let proofKeyValid = false;
try {
  const stat = fs.statSync(proofKeyPath);
  proofKeyValid =
    stat.isFile() &&
    (stat.mode & 0o077) === 0 &&
    fs.readFileSync(proofKeyPath, "utf8").includes("BEGIN RSA PRIVATE KEY");
} catch {
  proofKeyValid = false;
}
result.push({
  check: "persistent WOPI proof key",
  ok: editorMode !== "wopi" || proofKeyValid,
});

try {
  execFileSync("docker", ["compose", "config", "--quiet"], {
    stdio: "ignore",
  });
  result.push({ check: "docker compose config", ok: true });
} catch {
  result.push({ check: "docker compose config", ok: false });
}

const editorRuntime =
  editorMode === "browser"
    ? ["browser-office", "http://127.0.0.1:4173/readyz"]
    : ["office-editor", "http://127.0.0.1:9980/readyz"];
for (const [name, url] of [
  ["web", "http://127.0.0.1:3000/api/health"],
  editorRuntime,
]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    result.push({ check: `${name} runtime`, ok: response.ok, optional: true });
  } catch {
    result.push({ check: `${name} runtime`, ok: false, optional: true });
  }
}

for (const item of result)
  process.stdout.write(
    `${item.ok ? "PASS" : item.optional ? "WAIT" : "FAIL"} ${item.check}\n`,
  );
if (result.some((item) => !item.ok && !item.optional)) process.exitCode = 1;

function readEnvironment(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
