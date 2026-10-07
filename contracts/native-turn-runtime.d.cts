import type { ModelSettings } from "./ai-models.js";
import type { TaskResult, ConversationTurn } from "./native-turn-policy.cjs";
import type { ActiveGoal } from "./native-goal.cjs";
export interface NativeObservation {
  unit?: string;
  revision?: string;
  slides: Array<{
    slideIndex: number;
    elements: Array<{ elementId: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  assets?: Array<{ assetId: string; kind: "image" | "media" }>;
  activeSlide: number;
  images: Array<{
    slideIndex: number;
    pngBytes?: number[];
    pngBase64?: string;
  }>;
  engine?: { patchLevel?: string; supportedOperations?: string[] };
  changedSlideIndexes: number[];
  visualEvidenceComplete: boolean;
  layoutAudit?: {
    issues?: Array<Record<string, unknown>>;
    issueCount?: number;
    introducedIssueCount?: number;
    introducedIssues?: Array<Record<string, unknown>>;
  };
  textDetails?: { slideIndex: number; elements?: unknown[] };
  [key: string]: unknown;
  modelView?: Record<string, unknown> & {
    slides?: unknown[];
    revision?: string;
  };
}

export interface NativePermission {
  mode: "read_only" | "selection" | "slides" | "document";
  slideIndexes: number[];
  elementIds: string[];
}

export interface NativeHost {
  createImage?: (
    image: unknown,
    signal: AbortSignal,
  ) => Promise<{ assetId: string }>;
  call(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<NativeObservation>;
}

/** What one turn sent to the model and what the provider reported using. */
export type ModelInputCounts = {
  calls: number;
  fullTextBytes: number;
  sentTextBytes: number;
  imageCount: number;
  imageBytes: number;
  providerCalls: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  elapsedMs: number;
  hostMs: number;
  modelMs: number;
  hostCalls: number;
};

export function newModelInput(): ModelInputCounts;

export interface WebTools {
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<Array<{ title: string; snippet: string; url?: string }>>;
  readPage(url: string, signal: AbortSignal): Promise<string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool hands back to the model: text, plus PNG screenshots as base64. */
export interface ToolOutput {
  ok: boolean;
  text: string;
  images?: string[];
}

export interface TurnModel {
  supportsInputImages?: boolean;
  allowImageGeneration?: boolean;
  run(input: {
    instructions: string;
    allowImageGeneration?: boolean;
    onGeneratedImage?: (image: unknown) => Promise<void>;
    initialPage?: ToolOutput;
    tools: ToolSpec[];
    onTool: (
      name: string,
      args: unknown,
      signal: AbortSignal,
    ) => Promise<ToolOutput>;
    onText: (delta: string) => void;
    onThinking?: (delta: string) => void;
    onUsage?: (usage: {
      calls: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }) => void;
    modelSettings?: ModelSettings;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<string>;
}

export type NativeTurnInput = {
  requestText: string;
  conversationHistory?: ConversationTurn[];
  activeGoal?: ActiveGoal | null;
  documentScope?: string;
  modelSettings?: ModelSettings;
  permission: NativePermission;
  host: NativeHost;
  web: WebTools;
  modelInput?: ModelInputCounts;
  initialObservation?: NativeObservation;
  initialPages?: NativeObservation[];
  signal: AbortSignal;
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onTool: (text: string) => void;
};
export const UNCONFIRMED_EDIT_NOTICE: string;
export const UNREVIEWED_EDIT_NOTICE: string;
export function screenshotBase64(
  image: NativeObservation["images"][number],
): string;
export function requestedSlideIndexes(
  requestText: string,
  slideCount: number,
  activeSlide: number,
): number[];
export function nativeModelObservation(state: NativeObservation): Record<
  string,
  unknown
> & {
  slides: Array<{ slideIndex: number; [key: string]: unknown }>;
  masters?: Array<Record<string, unknown>>;
};
export function runNativeTurn(
  model: TurnModel,
  input: NativeTurnInput,
): Promise<{
  text: string;
  changed: boolean;
  reviewed: boolean;
  requestSatisfied: boolean;
  task: TaskResult;
  activeGoal: ActiveGoal | null;
  status: "needs_review" | "completed";
  modelInput: ModelInputCounts;
}>;
