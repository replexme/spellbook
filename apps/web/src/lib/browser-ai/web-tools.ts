import type { WebTools } from "./native-turn";

/*
 * Web access for an AI request run in this browser. Wikipedia search is
 * called directly (it allows browser requests); reading a page goes through
 * Spellbook's page reader for this request, because most sites do not.
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

/** Web tools for one running request, using that request's capability. */
export function browserWebTools(job: {
  jobId: string;
  capability: string;
}): WebTools {
  async function readPage(url: string, signal: AbortSignal) {
    try {
      const response = await fetch(
        `/api/native/jobs/${encodeURIComponent(job.jobId)}/web-page`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${job.capability}`,
          },
          body: JSON.stringify({ url }),
          cache: "no-store",
          signal,
        },
      );
      const value = (await response.json()) as {
        text?: string;
        error?: string;
      };
      if (!response.ok || typeof value.text !== "string")
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value.text || "The webpage content is empty.";
    } catch (error) {
      if (signal.aborted) throw error;
      return `Webpage fetch error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { search, readPage };
}
