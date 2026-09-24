import type { BrowserKeyProvider } from "./key-store";

/*
 * Checks a key from this browser straight to the provider before it is
 * kept. A rejected key throws the message the settings screen shows.
 */

const TIMEOUT_MS = 10_000;

function request(provider: BrowserKeyProvider, apiKey: string) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (provider === "gemini_api")
    return fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      { headers: { "x-goog-api-key": apiKey }, signal },
    );
  if (provider === "openai_api")
    return fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
  if (provider === "anthropic_api")
    return fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal,
    });
  // Lists a key's own limits, so an invalid key is refused.
  return fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
}

const NAMES: Record<BrowserKeyProvider, string> = {
  gemini_api: "Google Gemini",
  openai_api: "OpenAI",
  anthropic_api: "Anthropic",
  openrouter_api: "OpenRouter",
};

export async function checkProviderKey(
  provider: BrowserKeyProvider,
  rawKey: string,
): Promise<void> {
  const apiKey = rawKey.trim();
  if (!apiKey) throw new Error("API 키를 입력해 주세요.");
  if (provider === "openai_api" && !apiKey.startsWith("sk-"))
    throw new Error("OpenAI API 키는 'sk-'로 시작해야 합니다.");
  if (provider === "anthropic_api" && !apiKey.startsWith("sk-ant-"))
    throw new Error("Anthropic API 키는 'sk-ant-'로 시작해야 합니다.");
  let response: Response;
  try {
    response = await request(provider, apiKey);
  } catch {
    throw new Error(
      `${NAMES[provider]}에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.`,
    );
  }
  if (response.ok) return;
  if ([400, 401, 403].includes(response.status))
    throw new Error(`${NAMES[provider]} API 키가 유효하지 않습니다.`);
  if (response.status === 429)
    throw new Error(
      `${NAMES[provider]} API 사용량 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.`,
    );
  throw new Error(`${NAMES[provider]} API 오류 (${response.status})`);
}
