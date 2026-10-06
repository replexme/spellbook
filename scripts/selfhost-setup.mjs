import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const proofKeyPath = path.resolve(
  ".spellbook",
  "secrets",
  "wopi-proof-key.pem",
);
const proofKeyCreated = ensureWopiProofKey(proofKeyPath);

const emailArgument = process.argv.find((value) =>
  value.startsWith("--email="),
);
const email = (
  emailArgument?.slice("--email=".length) || "owner@spellbook.local"
)
  .trim()
  .toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  throw new Error("Use --email=you@example.com with a valid email address.");

const destination = path.resolve(".env");
if (fs.existsSync(destination)) {
  process.stdout.write(
    [
      ".env already exists. It was not changed.",
      proofKeyCreated
        ? "Created the persistent Collabora WOPI proof key."
        : "The persistent Collabora WOPI proof key already exists.",
      "Run pnpm selfhost:doctor to inspect the installation.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const password = randomBytes(18).toString("base64url");
const salt = randomBytes(16);
const passwordHash = `scrypt:${salt.toString("base64url")}:${scryptSync(
  password,
  salt,
  64,
).toString("base64url")}`;
const secret = () => randomBytes(36).toString("base64url");
const values = {
  SPELLBOOK_PUBLIC_URL: "http://localhost:3000",
  SPELLBOOK_EDITOR_MODE: "browser",
  SPELLBOOK_BROWSER_ENGINE: "onlyoffice",
  SPELLBOOK_ONLYOFFICE_SDK_ORIGIN: "http://localhost:4174",
  SPELLBOOK_ONLYOFFICE_INSPECTION_ORIGIN: "http://localhost:4175",
  SPELLBOOK_OFFICE_PUBLIC_URL: "http://localhost:9980",
  SPELLBOOK_BROWSER_OFFICE_PUBLIC_URL: "http://localhost:4173",
  SPELLBOOK_LOCAL_EMAIL: email,
  SPELLBOOK_LOCAL_PASSWORD_HASH: passwordHash,
  SPELLBOOK_SESSION_SECRET: secret(),
  SPELLBOOK_WOPI_SECRET: secret(),
  SPELLBOOK_WOPI_PROOF_MODE: "required",
  SPELLBOOK_WOPI_PROOF_KEY_PATH: "./.spellbook/secrets/wopi-proof-key.pem",
  SPELLBOOK_INTERNAL_TOKEN: secret(),
  SPELLBOOK_POSTGRES_PASSWORD: secret(),
  SPELLBOOK_DB_POOL_MAX: "4",
  SPELLBOOK_JOB_REDELIVERY_SECONDS: "15",
};
const content = `${Object.entries(values)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n")}\n`;
fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });

process.stdout.write(
  [
    "Created .env with mode 0600.",
    "Created a persistent Collabora WOPI proof key with mode 0600.",
    `Login email: ${email}`,
    `One-time displayed password: ${password}`,
    "Store the password now; only its scrypt hash was written to .env.",
    "Next: pnpm selfhost:up",
  ].join("\n") + "\n",
);

function ensureWopiProofKey(destination) {
  if (fs.existsSync(destination)) {
    fs.chmodSync(destination, 0o600);
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(destination), 0o700);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(destination, privateKey, { flag: "wx", mode: 0o600 });
  return true;
}
