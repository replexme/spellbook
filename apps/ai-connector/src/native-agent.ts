import * as runtime from "../../../contracts/native-turn-runtime.cjs";
import { createSubscriptionModel } from "../../../contracts/native-subscription-model.cjs";
import * as webPolicy from "../../../contracts/native-web-policy.cjs";
import type {
  NativeObservation as RuntimeObservation,
  NativeTurnInput,
} from "../../../contracts/native-turn-runtime.cjs";
import type {
  AgentTurnClient,
  GeneratedImage,
  DynamicTool,
} from "./app-server-client.js";
import { fetchPublicPage } from "./safe-web-fetch.js";
export interface NativeObservation extends RuntimeObservation {
  unit: string;
  revision?: string;
  slides: Array<{
    slideIndex: number;
    elements: Array<{ elementId: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  activeSlide: number;
  selectedElementIds: string[];
  masters?: Array<{
    layouts?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>;
  assets?: Array<{
    assetId: string;
    fileName: string;
    contentType: string;
    kind: "image" | "media";
    width: number;
    height: number;
  }>;
  textDetails?: {
    slideIndex: number;
    elements: Array<{
      elementId: string;
      paragraphs: Array<{
        paragraphId: string;
        paragraphIndex: number;
        startOffset: number;
        endOffset: number;
        text: string;
        portions: Array<{
          rangeId: string;
          portionIndex: number;
          startOffset: number;
          endOffset: number;
          text: string;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      }>;
    }>;
  };
  images: Array<{
    slideIndex: number;
    pngBytes?: number[];
    pngBase64?: string;
  }>;
  engine?: {
    patchLevel?: string;
    supportedOperations?: string[];
    [key: string]: unknown;
  };
  changedSlideIndexes: number[];
  visualEvidenceComplete: boolean;
  layoutAudit?: {
    issueCount: number;
    issues: Array<Record<string, unknown>>;
    introducedIssueCount?: number;
    introducedIssues?: Array<Record<string, unknown>>;
  };
  transaction?: Record<string, unknown>;
}
export interface NativePermission {
  mode: "read_only" | "selection" | "slides" | "document";
  slideIndexes: number[];
  elementIds: string[];
}
export interface NativeHost {
  call(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<NativeObservation>;
  createImage?(
    image: GeneratedImage,
    signal: AbortSignal,
  ): Promise<{ assetId: string }>;
}

export const {
  newModelInput,
  nativeModelObservation,
  requestedSlideIndexes,
  UNCONFIRMED_EDIT_NOTICE,
  UNREVIEWED_EDIT_NOTICE,
} = runtime;
export type ModelInputCounts = ReturnType<typeof newModelInput>;
export const {
  TurnWebAccess,
  pageKey,
  WEB_FETCHES_PER_TURN,
  WEB_SEARCHES_PER_TURN,
  WEB_TOOLS_INSTRUCTION,
  UNTRUSTED_PAGE_NOTICE,
} = webPolicy;
export const WEB_TOOL_DEFINITIONS: DynamicTool[] = [
  {
    type: "function",
    name: "web_search",
    description: webPolicy.WEB_SEARCH_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "fetch_web_page",
    description: webPolicy.FETCH_WEB_PAGE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];
export async function runNativeTurn(
  client: AgentTurnClient,
  input: Omit<NativeTurnInput, "web" | "host"> & { host: NativeHost },
) {
  const allowImageGeneration =
    ["slides", "document"].includes(input.permission.mode) &&
    client.supportsImageGeneration === true &&
    (await client.supportsImageGenerationForModel?.(input.modelSettings)) ===
      true;
  return runtime.runNativeTurn(
    createSubscriptionModel(client, allowImageGeneration),
    {
      ...input,
      host: {
        call: (request, signal) => input.host.call(request, signal),
        ...(input.host.createImage
          ? {
              createImage: (image: unknown, signal: AbortSignal) =>
                input.host.createImage!(image as GeneratedImage, signal),
            }
          : {}),
      },
      web: { search: performWebSearch, readPage: fetchWebPageText },
    },
  );
}

async function fetchWebPageText(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const html = await fetchPublicPage(rawUrl, signal);
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return cleanText.slice(0, 10_000) || "The webpage content is empty.";
  } catch (error) {
    return `Webpage fetch error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function performWebSearch(
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ title: string; snippet: string; url?: string }>> {
  const failures: string[] = [];
  for (const language of ["ko", "en"]) {
    try {
      const wikiUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
      const data = JSON.parse(await fetchPublicPage(wikiUrl, signal)) as {
        query?: { search?: Array<{ title: string; snippet: string }> };
      };
      const results = (data.query?.search ?? []).slice(0, 5).map((item) => ({
        title: item.title,
        snippet: item.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"'),
        url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
      }));
      if (results.length) return results;
    } catch (error) {
      failures.push(
        `${language}.wikipedia.org: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length === 2)
    throw new Error(`web_search_failed: ${failures.join("; ")}`);
  return [];
}
