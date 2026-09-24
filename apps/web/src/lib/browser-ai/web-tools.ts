import type { WebTools } from "./native-turn";

/*
 * Web access for an AI request run in this browser. Wikipedia search is
 * called directly (it allows browser requests); reading an arbitrary page
 * goes through Spellbook's page reader, because most sites do not.
 */

async function search(query: string, signal: AbortSignal) {
  const failures: string[] = [];
  for (const language of ["ko", "en"]) {
    try {
      const response = await fetch(
        `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&origin=*`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        query?: { search?: Array<{ title: string; snippet: string }> };
      };
      const results = (data.query?.search ?? []).slice(0, 5).map((item) => ({
        title: item.title,
        snippet: item.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"'),
        url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
      }));
      if (results.length) return results;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(
        `${language}.wikipedia.org: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length === 2)
    throw new Error(`web_search_failed: ${failures.join("; ")}`);
  return [];
}

async function readPage(url: string, signal: AbortSignal) {
  try {
    const response = await fetch("/api/web/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
      signal,
    });
    const value = (await response.json()) as { text?: string; error?: string };
    if (!response.ok || typeof value.text !== "string")
      throw new Error(value.error ?? `HTTP ${response.status}`);
    return value.text || "The webpage content is empty.";
  } catch (error) {
    if (signal.aborted) throw error;
    return `Webpage fetch error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const browserWebTools: WebTools = { search, readPage };
