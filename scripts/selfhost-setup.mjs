import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  SPELLBOOK_DOCUMENT_VIEW_PUBLIC_URL: "http://localhost:4173",
  SPELLBOOK_LOCAL_EMAIL: email,
  SPELLBOOK_LOCAL_PASSWORD_HASH: passwordHash,
  SPELLBOOK_SESSION_SECRET: secret(),
  // Signs the AI job capability tokens (historical name).
  SPELLBOOK_WOPI_SECRET: secret(),
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
    `Login email: ${email}`,
    `One-time displayed password: ${password}`,
    "Store the password now; only its scrypt hash was written to .env.",
    "Next: pnpm selfhost:up",
  ].join("\n") + "\n",
);
