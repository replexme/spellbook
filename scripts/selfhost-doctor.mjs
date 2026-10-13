import { execFileSync } from "node:child_process";
import fs from "node:fs";

const required = [
  "SPELLBOOK_LOCAL_EMAIL",
  "SPELLBOOK_LOCAL_PASSWORD_HASH",
  "SPELLBOOK_SESSION_SECRET",
  // Signs the AI job capability tokens (historical name).
  "SPELLBOOK_WOPI_SECRET",
  "SPELLBOOK_INTERNAL_TOKEN",
  "SPELLBOOK_POSTGRES_PASSWORD",
];

const result = [];
const environment = readEnvironment(".env");
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
try {
  execFileSync("docker", ["compose", "config", "--quiet"], {
    stdio: "ignore",
  });
  result.push({ check: "docker compose config", ok: true });
} catch {
  result.push({ check: "docker compose config", ok: false });
}

for (const [name, url] of [
  ["web", "http://127.0.0.1:3000/api/health"],
  ["document view", "http://127.0.0.1:4173/readyz.json"],
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
