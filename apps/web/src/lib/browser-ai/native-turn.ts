import type { ModelSettings } from "../ai-models";
import { engineSupports } from "../ai-edit-limits";
import {
  nativeBatchEditSchema,
  nativeCreateOperations,
  nativeDocumentOperations,
  nativeEditContract,
  nativeEditOperationCount,
  nativeElementOperations,
  nativeIdentityReplacingOperations,
  nativeMultiElementOperations,
  nativePlatformAssetOperations,
  nativeSlideOperations,
} from "./native-edit-contract";

/*
 * One AI request run in this browser: the model looks at the open editor,
 * edits it through the same bounded operations, looks again and records a
 * review. The rules are the AI connector's (apps/ai-connector native-agent);
 * only the transport differs — the editor is called directly on this page.
 */

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
    introducedIssueCount?: number;
    introducedIssues?: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
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
}

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
  run(input: {
    instructions: string;
    tools: ToolSpec[];
    onTool: (
      name: string,
      args: unknown,
      signal: AbortSignal,
    ) => Promise<ToolOutput>;
    onText: (delta: string) => void;
    onThinking?: (delta: string) => void;
    modelSettings?: ModelSettings;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<string>;
}

interface NativeEditCommand {
  elementId?: string | null;
  elementIds?: string[] | null;
  slideIndex?: number | null;
  assetId?: string;
  op?: string;
  [key: string]: unknown;
}

export const UNCONFIRMED_EDIT_NOTICE =
  "요청한 수정 가운데 적용되지 않았거나 적용 여부를 확인하지 못한 명령이 있습니다. 결과를 직접 확인해 주세요.";
export const UNREVIEWED_EDIT_NOTICE =
  "수정 뒤 화면 재검토가 끝나지 않아 이 결과는 아직 확인되지 않았습니다. 결과를 직접 확인해 주세요.";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A screenshot as base64 PNG, whichever encoding the editor used. */
export function screenshotBase64(
  image: NativeObservation["images"][number],
): string {
  if (typeof image.pngBase64 === "string") return image.pngBase64;
  const bytes = image.pngBytes ?? [];
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192)
    binary += String.fromCharCode(
      ...bytes.slice(offset, offset + 8_192).map((value) => value & 255),
    );
  return btoa(binary);
}

function isPng(base64: string) {
  const head = atob(base64.slice(0, 12));
  return PNG_SIGNATURE.every(
    (value, index) => head.charCodeAt(index) === value,
  );
}

export async function runNativeTurn(
  model: TurnModel,
  input: {
    requestText: string;
    conversationHistory?: Array<{
      request: string;
      response: string | null;
      status: "completed" | "failed" | "cancelled";
    }>;
    modelSettings?: ModelSettings;
    permission: NativePermission;
    host: NativeHost;
    web: WebTools;
    initialObservation?: NativeObservation;
    signal: AbortSignal;
    onText: (delta: string) => void;
    onThinking?: (delta: string) => void;
    onTool: (label: string) => void;
  },
) {
  let observed: NativeObservation | undefined = input.initialObservation;
  let pendingReview:
    | { revision: string; slideIndexes: number[]; introducedIssueCount: number }
    | undefined;
  let changed = false,
    reviewed = false;
  let toolTail: Promise<unknown> = Promise.resolve();
  const content = (state: NativeObservation): ToolOutput => ({
    ok: true,
    text: JSON.stringify({
      ...state,
      images: undefined,
      permission: input.permission,
    }),
    images: state.images.map(screenshotBase64),
  });
  const registerMutationEvidence = (state: NativeObservation): boolean => {
    if (state.visualEvidenceComplete !== true)
      throw new Error("Mutation result has incomplete visual evidence.");
    if (!Array.isArray(state.changedSlideIndexes))
      throw new Error("Mutation result has no changed-slide identity.");
    const slideIndexes = [...new Set(state.changedSlideIndexes)].sort(
      (left, right) => left - right,
    );
    if (slideIndexes.some((value) => !Number.isInteger(value) || value < 0))
      throw new Error("Mutation result has invalid changed-slide identity.");
    if (slideIndexes.length === 0) {
      pendingReview = undefined;
      return false;
    }
    if (typeof state.revision !== "string" || !state.revision)
      throw new Error("Mutation result has no reviewable revision.");
    const imageSlideIndexes = state.images
      .map((image) => image.slideIndex)
      .sort((left, right) => left - right);
    if (
      JSON.stringify(imageSlideIndexes) !== JSON.stringify(slideIndexes) ||
      state.images.some((image) => !isPng(screenshotBase64(image)))
    )
      throw new Error(
        "Mutation result does not include one fresh PNG for every changed slide.",
      );
    pendingReview = {
      revision: state.revision,
      slideIndexes,
      introducedIssueCount:
        state.layoutAudit?.introducedIssueCount ??
        state.layoutAudit?.introducedIssues?.length ??
        0,
    };
    return true;
  };
  const authorize = (
    command: NativeEditCommand,
    state: NativeObservation,
  ): number => {
    const operation = command.op ?? "";
    const operationContract =
      nativeEditContract.mutationModel.operations[operation];
    if (
      !operationContract ||
      operationContract.availability === "format_excluded" ||
      (!nativeDocumentOperations.has(operation) &&
        !nativeSlideOperations.has(operation) &&
        !nativeCreateOperations.has(operation) &&
        !nativeMultiElementOperations.has(operation) &&
        !nativeElementOperations.has(operation))
    )
      throw new Error("Unsupported native edit operation.");
    const supportedOperations = state.engine?.supportedOperations;
    if (
      !engineSupports(
        {
          patchLevel: state.engine?.patchLevel ?? null,
          supportedOperations:
            Array.isArray(supportedOperations) &&
            supportedOperations.every((value) => typeof value === "string")
              ? supportedOperations
              : [],
        },
        operation,
      )
    )
      throw new Error(
        `${operation}에는 undo-v${operationContract.minEnginePatch} 이상의 편집 엔진이 필요합니다.`,
      );
    if (nativePlatformAssetOperations.has(operation)) {
      const expectedKind = operation.endsWith("_image") ? "image" : "media";
      const asset = state.assets?.find(
        (candidate) => candidate.assetId === command.assetId,
      );
      if (!asset)
        throw new Error(
          "Asset target not present in the current document observation.",
        );
      if (asset.kind !== expectedKind)
        throw new Error(`Expected a ${expectedKind} asset for ${operation}.`);
    }
    let slideIndex: number;
    if (nativeDocumentOperations.has(operation)) {
      if (input.permission.mode !== "document")
        throw new Error("문서 전체 변경 권한이 필요합니다.");
      return state.activeSlide;
    }
    if (
      nativeSlideOperations.has(operation) ||
      nativeCreateOperations.has(operation)
    ) {
      if (
        !Number.isInteger(command.slideIndex) ||
        !state.slides.some((slide) => slide.slideIndex === command.slideIndex)
      )
        throw new Error("Slide target not present in observation.");
      slideIndex = command.slideIndex as number;
      if (
        input.permission.mode === "selection" ||
        (["insert_slide", "move_slide"].includes(operation) &&
          input.permission.mode !== "document") ||
        (input.permission.mode === "slides" &&
          !input.permission.slideIndexes.includes(slideIndex))
      )
        throw new Error("허용된 슬라이드 범위 밖입니다.");
      return slideIndex;
    }
    if (nativeMultiElementOperations.has(operation)) {
      if (!Array.isArray(command.elementIds) || command.elementIds.length < 2)
        throw new Error("Element targets not present in observation.");
      const targets = command.elementIds.map((elementId) => {
        const slide = state.slides.find((candidate) =>
          candidate.elements.some((element) => element.elementId === elementId),
        );
        return slide ? { elementId, slideIndex: slide.slideIndex } : null;
      });
      if (
        targets.some((target) => !target) ||
        new Set(targets.map((target) => target?.slideIndex)).size !== 1
      )
        throw new Error("Element targets not present in one slide.");
      slideIndex = targets[0]!.slideIndex;
      if (
        input.permission.mode === "selection" &&
        command.elementIds.some(
          (elementId) => !input.permission.elementIds.includes(elementId),
        )
      )
        throw new Error("선택 범위 밖입니다.");
    } else {
      const targetSlide = command.elementId
        ? state.slides.find((slide) =>
            slide.elements.some(
              (element) => element.elementId === command.elementId,
            ),
          )
        : undefined;
      if (!targetSlide) throw new Error("Target not present in observation.");
      slideIndex = targetSlide.slideIndex;
      if (
        input.permission.mode === "selection" &&
        !input.permission.elementIds.includes(command.elementId!)
      )
        throw new Error("선택 범위 밖입니다.");
    }
    if (
      input.permission.mode === "slides" &&
      !input.permission.slideIndexes.includes(slideIndex)
    )
      throw new Error("허용된 슬라이드 밖입니다.");
    return slideIndex;
  };
  // A mutation call that failed or timed out may still land in the editor.
  let unconfirmedMutation = false;
  // An edit the editor applied without complete evidence is also unconfirmed.
  const applied = (state: NativeObservation) => {
    try {
      return registerMutationEvidence(state);
    } catch (error) {
      unconfirmedMutation = true;
      throw error;
    }
  };
  const mutate = async (
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<NativeObservation> => {
    try {
      return await input.host.call(request, signal);
    } catch (error) {
      unconfirmedMutation = true;
      throw error;
    }
  };
  const tools: ToolSpec[] = [
    {
      name: "native_observe",
      description:
        "Read the open document, including unsaved human edits. Pass null for the active slide or a slide index to receive that slide's screenshot and paragraph/run details without changing the user's active slide.",
      inputSchema: {
        type: "object",
        properties: { detailSlideIndex: { type: ["number", "null"] } },
        required: ["detailSlideIndex"],
        additionalProperties: false,
      },
    },
    {
      name: "native_edit",
      description: `Change one observed object or slide in the SAME open editor with native undo. The schema includes all ${nativeEditOperationCount} bounded PPTX operations implemented by Spellbook: slide creation/reorder/layout/background/visibility/transition, speaker notes and animation timing; object creation/duplication/deletion/topology/geometry/style/text/range formatting/locking/cropping and safe click interactions; image/audio/video insertion or identity-preserving replacement using an observed document-scoped assetId; media playback, SmartArt semantic nodes, equations, Fontwork, 3D material and accessibility reading order; table content/structure/style; and fixed-size internal chart data plus column/line/area/pie/scatter/radar chart-family changes. Operations that need a patched engine are rejected unless the live observation reports the required undo-v level. Asset insertion/replacement must use native_edit and cannot be put in native_batch_edit because binary delivery crosses the trusted host boundary. For set_chart_data, keep the observed dimensions when changing data, rowDescriptions (category labels), or columnDescriptions (series labels). An identity-replacing operation must be isolated in its own edit. External interactions accept credential-free HTTP(S) only; do not add one without explicit user intent. Linked or external-workbook chart mutation and arbitrary new master/layout authoring are outside this bounded schema; set_master_theme only edits a fully observed existing master theme. Observe after stale state. Do not send executable code.`,
      inputSchema: nativeEditContract.toolInputSchema,
    },
    {
      name: "native_batch_edit",
      description: `Plan or atomically apply 1-50 validated native edits to the SAME observed presentation. All targets come from one revision and are rebound to their live objects before each command. ${nativeEditContract.transaction.ordering} dryRun validates targets, options, and permission without changing the document. A non-dry-run batch becomes one native Undo action and rolls back completely if any command fails. Do not send executable code.`,
      inputSchema: nativeBatchEditSchema,
    },
    {
      name: "native_review",
      description:
        "Record a visual review of the latest mutation. Inspect every returned changed-slide screenshot and pass exactly those changedSlideIndexes. This is not user approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approved: { type: "boolean" },
          problems: { type: "array", items: { type: "string" } },
          reviewedSlideIndexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            uniqueItems: true,
          },
        },
        required: ["approved", "problems", "reviewedSlideIndexes"],
      },
    },
    {
      name: "web_search",
      description:
        "Search the web for up-to-date real-world facts, recent news, industry statistics, domain references, or company information to create or enrich presentation slides. Returns top search results with titles, snippets, and source URLs.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query (e.g., '2026 AI industry trends', 'Apple latest financial report').",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch_web_page",
      description:
        "Fetch and read the text content of any web page URL provided by the user or found via search, extracting clean text to summarize or incorporate into the presentation.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full HTTP or HTTPS URL to read.",
          },
        },
        required: ["url"],
      },
    },
  ];
  // A review-only step may look and record a review, never edit.
  const REVIEW_ONLY_TOOLS = new Set(["native_observe", "native_review"]);
  const runTool = async (
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolOutput> => {
    if (name === "native_observe") {
      const detailSlideIndex = (args as { detailSlideIndex?: unknown })
        ?.detailSlideIndex;
      if (detailSlideIndex !== null && !Number.isInteger(detailSlideIndex))
        throw new Error("Invalid detail slide.");
      input.onTool("현재 슬라이드 확인");
      const nextObservation = await input.host.call(
        { operation: "observe", detailSlideIndex },
        signal,
      );
      if (
        pendingReview &&
        nextObservation.revision !== pendingReview.revision
      ) {
        pendingReview = undefined;
        reviewed = false;
      }
      observed = nextObservation;
      return content(observed);
    }
    if (name === "native_edit") {
      if (!observed) throw new Error("Observe before editing.");
      if (input.permission.mode === "read_only")
        throw new Error("읽기 전용 권한입니다.");
      const command = args as NativeEditCommand;
      const slideIndex = authorize(command, observed);
      input.onTool("슬라이드 수정");
      const expectedSlides = JSON.stringify(observed.slides);
      const expectedRevision = observed.revision;
      // A failed response may conceal an already-applied edit. Require
      // another observation instead of replaying stale targets.
      observed = undefined;
      observed = await mutate(
        nativePlatformAssetOperations.has(command.op ?? "")
          ? {
              ...command,
              operation: command.op,
              slideIndex,
              expectedRevision,
              expectedSlides,
              permission: input.permission,
            }
          : {
              operation: "edit",
              expectedRevision,
              expectedSlides,
              command,
              permission: input.permission,
            },
        signal,
      );
      if (applied(observed)) {
        changed = true;
        reviewed = false;
      }
      return content(observed);
    }
    if (name === "native_batch_edit") {
      if (!observed) throw new Error("Observe before editing.");
      if (input.permission.mode === "read_only")
        throw new Error("읽기 전용 권한입니다.");
      const batch = args as {
        commands?: NativeEditCommand[];
        dryRun?: boolean;
      };
      if (
        !Array.isArray(batch.commands) ||
        batch.commands.length < 1 ||
        batch.commands.length > nativeEditContract.transaction.maxCommands ||
        typeof batch.dryRun !== "boolean"
      )
        throw new Error("Invalid native edit transaction.");
      if (
        batch.commands.some((command) =>
          nativePlatformAssetOperations.has(command.op ?? ""),
        )
      )
        throw new Error(
          "자산 삽입과 교체는 신뢰된 파일 전송 경계를 사용하므로 native_edit에서 한 번에 하나씩 실행해야 합니다.",
        );
      if (
        batch.commands.length > 1 &&
        batch.commands.some((command) =>
          nativeIdentityReplacingOperations.has(command.op ?? ""),
        )
      )
        throw new Error(
          "An identity-replacing edit must be a one-command transaction.",
        );
      for (const command of batch.commands) authorize(command, observed);
      input.onTool(batch.dryRun ? "수정 계획 검사" : "여러 요소 한 번에 수정");
      const previous = observed;
      observed = undefined;
      const request = {
        operation: "edit_batch",
        expectedRevision: previous.revision,
        expectedSlides: JSON.stringify(previous.slides),
        commands: batch.commands,
        dryRun: batch.dryRun,
        permission: input.permission,
      };
      observed = batch.dryRun
        ? await input.host.call(request, signal)
        : await mutate(request, signal);
      if (!batch.dryRun && applied(observed)) {
        changed = true;
        reviewed = false;
      }
      return content(observed);
    }
    if (name === "native_review") {
      if (!changed || !observed) throw new Error("No changed slide to review.");
      const result = args as {
        approved?: boolean;
        problems?: unknown[];
        reviewedSlideIndexes?: unknown[];
      };
      if (
        typeof result.approved !== "boolean" ||
        !Array.isArray(result.problems) ||
        result.problems.some((problem) => typeof problem !== "string") ||
        !Array.isArray(result.reviewedSlideIndexes) ||
        result.reviewedSlideIndexes.some(
          (slideIndex) => !Number.isInteger(slideIndex),
        )
      )
        throw new Error("Invalid review.");
      if (!pendingReview || observed.revision !== pendingReview.revision)
        throw new Error("The visual review evidence is stale.");
      const reviewedSlideIndexes = [
        ...new Set(result.reviewedSlideIndexes as number[]),
      ].sort((left, right) => left - right);
      if (
        JSON.stringify(reviewedSlideIndexes) !==
        JSON.stringify(pendingReview.slideIndexes)
      )
        throw new Error(
          "Every changed slide must be included in the visual review.",
        );
      const current = await input.host.call(
        { operation: "observe", detailSlideIndex: null },
        signal,
      );
      if (current.revision !== pendingReview.revision) {
        observed = current;
        pendingReview = undefined;
        reviewed = false;
        throw new Error("The visual review evidence is stale.");
      }
      observed = current;
      if (result.approved && result.problems.length > 0)
        throw new Error(
          "A visual review cannot approve while reporting problems.",
        );
      if (result.approved && pendingReview.introducedIssueCount > 0)
        throw new Error(
          "A visual review cannot approve newly introduced layout issues.",
        );
      reviewed = result.approved && result.problems.length === 0;
      input.onTool(reviewed ? "수정 화면 확인 완료" : "수정 화면 재검토 필요");
      return { ok: true, text: JSON.stringify(result) };
    }
    if (name === "web_search") {
      const query = String((args as { query?: string })?.query ?? "").trim();
      if (!query) throw new Error("Search query is required.");
      input.onTool(`웹 검색: "${query}"`);
      return {
        ok: true,
        text: JSON.stringify(await input.web.search(query, signal)),
      };
    }
    if (name === "fetch_web_page") {
      const url = String((args as { url?: string })?.url ?? "").trim();
      if (!url) throw new Error("URL is required.");
      input.onTool(`웹페이지 읽기: ${url}`);
      return { ok: true, text: await input.web.readPage(url, signal) };
    }
    throw new Error("Unknown tool.");
  };
  const turn = (prompt: string, timeoutMs: number, reviewOnly = false) =>
    model.run({
      instructions: [
        observed && !reviewOnly
          ? `Live document structure is ALREADY observed (Revision: ${observed.revision}, Active slide: ${observed.activeSlide + 1}번). Elements: ${JSON.stringify(observed.slides.find((s) => s.slideIndex === observed?.activeSlide)?.elements?.map((e) => ({ id: e.elementId, name: e.name, text: e.text, table: e.table })) ?? [])}. You do NOT need to call native_observe. You can immediately call native_batch_edit to apply the changes.`
          : reviewOnly
            ? `This is a review-only step. The user's request was already applied to the SAME open PowerPoint document in this turn: ${JSON.stringify(input.requestText)}. Only native_observe and native_review are available; you cannot edit.`
            : "You are editing the SAME open PowerPoint document as the user. Always observe first. Human edits may happen between calls: a stale-state error requires observing again, never replaying an edit blindly.",
        `Previous conversation, oldest first, is context only. It may describe failed, cancelled, reverted, or human-overwritten work. The live observation and revision are the only authority for the current document: ${JSON.stringify(input.conversationHistory ?? [])}`,
        "Observe returns live element structure, a revision, deterministic layout findings, and slide screenshots. After an edit, introducedIssues distinguishes problems created by this edit from pre-existing document warnings. Use native_batch_edit for coordinated changes so they are planned and applied atomically as one undo action; use dryRun first for a risky or structural batch. native_edit remains available for one isolated change. Stay within returned permission. Inspect introducedIssues and the fresh screenshot after edits, correct any regression, then call native_review. Do not claim an edit happened without a successful tool result.",
        "Web search and webpage reading are fully supported via web_search and fetch_web_page. When the user asks for real-world knowledge, recent news, industry statistics, domain references, or provides a URL, proactively use web_search and fetch_web_page to obtain accurate, up-to-date facts and cite sources. NEVER claim that you cannot access the internet or that browsing is disabled.",
        ...(reviewOnly
          ? []
          : [
              "CRITICAL DIRECTIVE - BIAS FOR ACTION: When the user asks to edit, fill, create, or update content in the presentation (such as filling templates, modifying text/tables, adding text boxes, or updating slides), you MUST NOT merely observe and stop. You MUST NOT say '말씀해 주시면 진행하겠습니다' or ask for further confirmation. You MUST proactively execute the mutations in this turn using native_batch_edit (or native_edit), verify with native_review, and then report the completed result.",
            ]),
        `Coordinates are 1/100 mm. IDs refer to the last observed revision; the editor rebinds batch targets to the same live objects before every command. ${nativeEditContract.transaction.ordering} Do not change original text or geometry merely to hide font/rendering differences. Answer in Korean.`,
        prompt,
      ].join("\n"),
      tools: tools.filter(
        (tool) => !reviewOnly || REVIEW_ONLY_TOOLS.has(tool.name),
      ),
      onTool: (name, args, signal) => {
        if (reviewOnly && !REVIEW_ONLY_TOOLS.has(name))
          return Promise.resolve({
            ok: false,
            text: "Only native_observe and native_review are allowed in this review step.",
          });
        // Editor calls run one at a time, in the order the model asked.
        const work = toolTail.then(() => runTool(name, args, signal));
        toolTail = work.catch(() => undefined);
        return work.catch(
          (error): ToolOutput => ({
            ok: false,
            text:
              error instanceof Error
                ? error.message
                : "Document operation failed.",
          }),
        );
      },
      onText: input.onText,
      onThinking: input.onThinking,
      modelSettings: input.modelSettings,
      signal: input.signal,
      timeoutMs,
    });
  let text = await turn(`User request: ${input.requestText}`, 240_000);
  // Looking at the result after an edit is the product contract, not a hint.
  // A model that edits and stops is asked once more to observe and review.
  if (changed && !reviewed) {
    const review = await turn(
      "Observe the changed slides, then call native_review with every changed slide. Approve only if the fresh screenshot shows the requested change without new problems; otherwise report the problems. Then tell the user in Korean what changed and what the review found.",
      180_000,
      true,
    );
    if (review.trim()) text = review;
  }
  if (changed && !reviewed)
    text = `${text.trim()}\n\n${UNREVIEWED_EDIT_NOTICE}`;
  else if (unconfirmedMutation && !reviewed)
    text = `${text.trim()}\n\n${UNCONFIRMED_EDIT_NOTICE}`;
  return {
    text,
    changed,
    reviewed,
    status:
      changed && !reviewed ? ("needs_review" as const) : ("completed" as const),
  };
}
