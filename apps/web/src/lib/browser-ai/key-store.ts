import {
  anthropicModels,
  geminiModels,
  openAiModels,
  openRouterModels,
  type AvailableModel,
} from "../ai-models";

/*
 * AI provider keys live only in this browser, one entry per Spellbook
 * account, so another account signing in on the same browser does not see
 * them. Spellbook's servers never receive a key.
 */

export const BROWSER_KEY_PROVIDERS = [
  "gemini_api",
  "openai_api",
  "anthropic_api",
  "openrouter_api",
] as const;
export type BrowserKeyProvider = (typeof BROWSER_KEY_PROVIDERS)[number];

/** A subscription connected on the server, chosen in this browser. */
export type SubscriptionChoice = "codex" | "claude_code";

export interface BrowserKeys {
  /** What the next request uses; null means the connected subscription. */
  active: BrowserKeyProvider | SubscriptionChoice | null;
  keys: Partial<Record<BrowserKeyProvider, string>>;
}

const EMPTY: BrowserKeys = { active: null, keys: {} };
const storageKey = (scope: string) => `spellbook.ai-keys.v1:${scope}`;

export function isBrowserKeyProvider(
  value: unknown,
): value is BrowserKeyProvider {
  return BROWSER_KEY_PROVIDERS.includes(value as BrowserKeyProvider);
}

export function readBrowserKeys(scope: string | null): BrowserKeys {
  if (!scope) return EMPTY;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(storageKey(scope)) ?? "null",
    ) as Partial<BrowserKeys> | null;
    const keys: BrowserKeys["keys"] = {};
    for (const provider of BROWSER_KEY_PROVIDERS) {
      const key = value?.keys?.[provider];
      if (typeof key === "string" && key) keys[provider] = key;
    }
    const active =
      value?.active === "codex" || value?.active === "claude_code"
        ? value.active
        : isBrowserKeyProvider(value?.active) && keys[value.active]
          ? value.active
          : null;
    return { active, keys };
  } catch {
    return EMPTY;
  }
}

export function writeBrowserKeys(scope: string, value: BrowserKeys) {
  // Private windows or blocked storage throw; the caller shows the message.
  window.localStorage.setItem(storageKey(scope), JSON.stringify(value));
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

const CATALOG: Record<BrowserKeyProvider, () => AvailableModel[]> = {
  gemini_api: geminiModels,
  openai_api: openAiModels,
  anthropic_api: anthropicModels,
  openrouter_api: openRouterModels,
};

/** Models the stored keys can run, listed after the server's own models. */
export function browserKeyModels(keys: BrowserKeys): AvailableModel[] {
  return BROWSER_KEY_PROVIDERS.filter(
    (provider) => keys.keys[provider],
  ).flatMap((provider) => CATALOG[provider]());
}
