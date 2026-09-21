import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";

export type ApiKeyProvider =
  | "openai_api"
  | "anthropic_api"
  | "gemini_api"
  | "openrouter_api"
  | "custom_api";

function encryptionKey(): Buffer {
  const secret =
    process.env.SPELLBOOK_INTERNAL_TOKEN ||
    process.env.PRESENT_INTERNAL_TOKEN ||
    "spellbook-default-token-secret-32b";
  return createHash("sha256").update(secret).digest();
}

export function encryptApiKey(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptApiKey(token: string): string {
  const [ivStr, dataStr, tagStr] = token.split(".");
  if (!ivStr || !dataStr || !tagStr) throw new Error("invalid_encrypted_key");
  const iv = Buffer.from(ivStr, "base64url");
  const data = Buffer.from(dataStr, "base64url");
  const tag = Buffer.from(tagStr, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function validateApiKey(
  provider: ApiKeyProvider,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new HttpError(400, "API 키를 입력해 주세요.");
  if (provider === "openai_api") {
    if (!trimmed.startsWith("sk-"))
      throw new HttpError(400, "OpenAI API 키는 'sk-'로 시작해야 합니다.");
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      if (res.status === 401)
        throw new HttpError(400, "OpenAI API 키가 유효하지 않습니다. (401 Unauthorized)");
      if (res.status === 429)
        throw new HttpError(400, "OpenAI API 잔액(Quota)이 부족하거나 사용량 한도에 도달했습니다.");
      throw new HttpError(400, `OpenAI API 오류 (${res.status})`);
    }
  } else if (provider === "anthropic_api") {
    if (!trimmed.startsWith("sk-ant-"))
      throw new HttpError(400, "Anthropic API 키는 'sk-ant-'로 시작해야 합니다.");
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": trimmed, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok && res.status === 401) {
      throw new HttpError(400, "Anthropic API 키가 유효하지 않습니다. (401 Unauthorized)");
    }
  } else if (provider === "gemini_api") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${trimmed}`,
      { signal: AbortSignal.timeout(7000) },
    );
    if (!res.ok) {
      if (res.status === 400 || res.status === 403)
        throw new HttpError(
          400,
          "Google Gemini API 키가 유효하지 않습니다. Google AI Studio(aistudio.google.com)에서 발급받은 키를 확인해 주세요.",
        );
      if (res.status === 429)
        throw new HttpError(
          400,
          "Google Gemini API 사용량 한도(Rate limit)에 도달했습니다.",
        );
      throw new HttpError(400, `Google Gemini API 오류 (${res.status})`);
    }
  } else if (provider === "openrouter_api") {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      if (res.status === 401)
        throw new HttpError(
          400,
          "OpenRouter API 키가 유효하지 않습니다. (401 Unauthorized)",
        );
      throw new HttpError(400, `OpenRouter API 오류 (${res.status})`);
    }
  }
}

export async function saveProviderKey(
  accountId: string,
  provider: ApiKeyProvider,
  apiKey: string,
  active = true,
): Promise<void> {
  await ensureSchema();
  await validateApiKey(provider, apiKey);
  const encrypted = encryptApiKey(apiKey.trim());
  await db().begin(async (sql) => {
    if (active) {
      await sql`
        update spellbook_account_providers
        set is_active = false, updated_at = now()
        where account_id = ${accountId}
      `;
    }
    await sql`
      insert into spellbook_account_providers
        (account_id, provider, api_key_encrypted, is_active, updated_at)
      values
        (${accountId}, ${provider}, ${encrypted}, ${active}, now())
      on conflict (account_id, provider) do update set
        api_key_encrypted = excluded.api_key_encrypted,
        is_active = excluded.is_active,
        updated_at = now()
    `;
  });
}

export async function deleteProviderKey(
  accountId: string,
  provider: string,
): Promise<void> {
  await ensureSchema();
  await db()`
    delete from spellbook_account_providers
    where account_id = ${accountId} and provider = ${provider}
  `;
}

export async function selectActiveProvider(
  accountId: string,
  provider: string,
): Promise<void> {
  await ensureSchema();
  await db().begin(async (sql) => {
    await sql`
      update spellbook_account_providers
      set is_active = false, updated_at = now()
      where account_id = ${accountId}
    `;
    await sql`
      update spellbook_account_providers
      set is_active = true, updated_at = now()
      where account_id = ${accountId} and provider = ${provider}
    `;
  });
}

export async function getAccountProviders(
  accountId: string,
): Promise<
  Array<{
    provider: string;
    isActive: boolean;
    maskedKey: string | null;
  }>
> {
  await ensureSchema();
  const rows = await db()`
    select provider, api_key_encrypted, is_active
    from spellbook_account_providers
    where account_id = ${accountId}
  `;
  return rows.map((row) => {
    let maskedKey: string | null = null;
    if (row.api_key_encrypted) {
      try {
        const decrypted = decryptApiKey(row.api_key_encrypted);
        maskedKey = maskApiKey(decrypted);
      } catch {
        maskedKey = "••••••••";
      }
    }
    return {
      provider: row.provider,
      isActive: Boolean(row.is_active),
      maskedKey,
    };
  });
}

export async function getActiveProviderKey(
  accountId: string,
  provider: string,
): Promise<string | null> {
  await ensureSchema();
  const [row] = await db()`
    select api_key_encrypted
    from spellbook_account_providers
    where account_id = ${accountId} and provider = ${provider}
  `;
  if (!row?.api_key_encrypted) return null;
  try {
    return decryptApiKey(row.api_key_encrypted);
  } catch {
    return null;
  }
}
