import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import {
  anthropicModels,
  geminiModels,
  openAiModels,
  openRouterModels,
  type AvailableModel,
} from "./ai-models";

export type ApiKeyProvider =
  | "openai_api"
  | "anthropic_api"
  | "gemini_api"
  | "openrouter_api"
  | "custom_api";

function encryptionKey(): Buffer {
  const secret =
    process.env.SPELLBOOK_INTERNAL_TOKEN?.trim() ||
    process.env.PRESENT_INTERNAL_TOKEN?.trim();
  // A built-in fallback would let anyone who reads the source forge or decrypt.
  if (!secret)
    throw new Error(
      "SPELLBOOK_INTERNAL_TOKEN is required for provider key encryption.",
    );
  return createHash("sha256").update(secret).digest();
}

export function encryptApiKey(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptApiKey(token: string): string {
  const [ivStr, dataStr, tagStr] = token.split(".");
  if (!ivStr || !dataStr || !tagStr) throw new Error("invalid_encrypted_key");
  const iv = Buffer.from(ivStr, "base64url");
  const data = Buffer.from(dataStr, "base64url");
  const tag = Buffer.from(tagStr, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function discoverProviderModels(
  provider: ApiKeyProvider,
  apiKey: string,
  customBaseUrl?: string,
): Promise<AvailableModel[]> {
  const trimmed = apiKey.trim();
  if (provider === "gemini_api") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${trimmed}&pageSize=50`,
      { signal: AbortSignal.timeout(10000) },
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
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        description?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    const contentModels = (data.models || []).filter((m) =>
      m.supportedGenerationMethods?.includes("generateContent"),
    );
    if (contentModels.length === 0) return geminiModels();

    contentModels.sort((a, b) => {
      const aName = a.name || "";
      const bName = b.name || "";
      return bName.localeCompare(aName, undefined, { numeric: true });
    });

    return contentModels.map((m, index) => {
      const modelId = (m.name || "").replace(/^models\//, "");
      const isThinking =
        modelId.includes("thinking") || modelId.includes("reasoning");
      return {
        provider: "gemini_api" as const,
        model: modelId,
        displayName: `${m.displayName || modelId} (Google AI)`,
        defaultReasoningEffort: isThinking ? "high" : "medium",
        supportedReasoningEfforts: isThinking
          ? [
              { reasoningEffort: "low", description: "빠르게" },
              { reasoningEffort: "medium", description: "보통" },
              { reasoningEffort: "high", description: "심층 추론" },
            ]
          : [{ reasoningEffort: "medium", description: "기본" }],
        isDefault: index === 0,
      };
    });
  }

  if (provider === "openai_api") {
    if (!trimmed.startsWith("sk-"))
      throw new HttpError(400, "OpenAI API 키는 'sk-'로 시작해야 합니다.");
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (res.status === 401)
        throw new HttpError(
          400,
          "OpenAI API 키가 유효하지 않습니다. (401 Unauthorized)",
        );
      if (res.status === 429)
        throw new HttpError(
          400,
          "OpenAI API 잔액(Quota)이 부족하거나 사용량 한도에 도달했습니다.",
        );
      throw new HttpError(400, `OpenAI API 오류 (${res.status})`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const chatModels = (data.data || []).filter(
      (m) =>
        (m.id.startsWith("gpt-") ||
          m.id.startsWith("o1") ||
          m.id.startsWith("o3") ||
          m.id.startsWith("chatgpt-")) &&
        !m.id.includes("realtime") &&
        !m.id.includes("audio") &&
        !m.id.includes("transcription"),
    );
    if (chatModels.length === 0) return openAiModels();
    chatModels.sort((a, b) =>
      b.id.localeCompare(a.id, undefined, { numeric: true }),
    );
    return chatModels.slice(0, 8).map((m, index) => ({
      provider: "openai_api" as const,
      model: m.id,
      displayName: `${m.id} (OpenAI API)`,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: index === 0,
    }));
  }

  if (provider === "anthropic_api") {
    if (!trimmed.startsWith("sk-ant-"))
      throw new HttpError(
        400,
        "Anthropic API 키는 'sk-ant-'로 시작해야 합니다.",
      );
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": trimmed, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (res.status === 401)
        throw new HttpError(
          400,
          "Anthropic API 키가 유효하지 않습니다. (401 Unauthorized)",
        );
      return anthropicModels();
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string }>;
    };
    const list = data.data || [];
    if (list.length === 0) return anthropicModels();
    return list.map((m, index) => ({
      provider: "anthropic_api" as const,
      model: m.id,
      displayName: `${m.display_name || m.id} (Anthropic API)`,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: index === 0,
    }));
  }

  if (provider === "openrouter_api") {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (res.status === 401)
        throw new HttpError(
          400,
          "OpenRouter API 키가 유효하지 않습니다. (401 Unauthorized)",
        );
      return openRouterModels();
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string }>;
    };
    const list = data.data || [];
    if (list.length === 0) return openRouterModels();
    return list.slice(0, 10).map((m, index) => ({
      provider: "openrouter_api" as const,
      model: m.id,
      displayName: `${m.name || m.id} (OpenRouter)`,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: index === 0,
    }));
  }

  if (provider === "custom_api" && customBaseUrl) {
    const endpoint = `${customBaseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(endpoint, {
      headers: { authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const list = data.data || [];
      if (list.length > 0) {
        return list.map((m, index) => ({
          provider: "custom_api" as const,
          model: m.id,
          displayName: `${m.id} (사용자 API)`,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "기본" },
          ],
          isDefault: index === 0,
        }));
      }
    }
  }

  return [];
}

export async function validateApiKey(
  provider: ApiKeyProvider,
  apiKey: string,
  customBaseUrl?: string,
): Promise<AvailableModel[]> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new HttpError(400, "API 키를 입력해 주세요.");
  return discoverProviderModels(provider, trimmed, customBaseUrl);
}

export async function saveProviderKey(
  accountId: string,
  provider: ApiKeyProvider,
  apiKey: string,
  active = true,
  customModel?: string,
  customBaseUrl?: string,
): Promise<AvailableModel[]> {
  await ensureSchema();
  const models = await validateApiKey(provider, apiKey, customBaseUrl);
  if (customModel && customModel.trim()) {
    models.unshift({
      provider: provider as any,
      model: customModel.trim(),
      displayName: `${customModel.trim()} (사용자 지정)`,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: true,
    });
    for (let i = 1; i < models.length; i++) models[i]!.isDefault = false;
  }
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
        (account_id, provider, api_key_encrypted, is_active, models_cache, custom_model, custom_base_url, updated_at)
      values
        (${accountId}, ${provider}, ${encrypted}, ${active}, ${sql.json(models as any)}, ${customModel ?? null}, ${customBaseUrl ?? null}, now())
      on conflict (account_id, provider) do update set
        api_key_encrypted = excluded.api_key_encrypted,
        is_active = excluded.is_active,
        models_cache = excluded.models_cache,
        custom_model = excluded.custom_model,
        custom_base_url = excluded.custom_base_url,
        updated_at = now()
    `;
  });
  return models;
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

export async function getAccountProviders(accountId: string): Promise<
  Array<{
    provider: string;
    isActive: boolean;
    maskedKey: string | null;
    modelsCache: AvailableModel[] | null;
    customModel: string | null;
    customBaseUrl: string | null;
  }>
> {
  await ensureSchema();
  const rows = await db()`
    select provider, api_key_encrypted, is_active, models_cache, custom_model, custom_base_url
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
      modelsCache: Array.isArray(row.models_cache)
        ? (row.models_cache as AvailableModel[])
        : null,
      customModel: row.custom_model ?? null,
      customBaseUrl: row.custom_base_url ?? null,
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
