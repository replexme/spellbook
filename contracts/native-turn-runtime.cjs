/* SPDX-License-Identifier: MPL-2.0 */
// One editor workflow for browser, local connector and managed worker.
const goal = require("./native-goal.cjs");
const policy = require("./native-turn-policy.cjs");
const webPolicy = require("./native-web-policy.cjs");
const edit = require("./native-edit-tools.cjs");
function newModelInput() {
  return {
    calls: 0,
    fullTextBytes: 0,
    sentTextBytes: 0,
    imageCount: 0,
    imageBytes: 0,
    providerCalls: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    elapsedMs: 0,
    hostMs: 0,
    modelMs: 0,
    hostCalls: 0,
  };
}
const UNCONFIRMED_EDIT_NOTICE =
  "요청한 수정 가운데 적용되지 않았거나 적용 여부를 확인하지 못한 명령이 있습니다. 결과를 직접 확인해 주세요.";
const UNREVIEWED_EDIT_NOTICE =
  "수정 뒤 화면 재검토가 끝나지 않아 이 결과는 아직 확인되지 않았습니다. 결과를 직접 확인해 주세요.";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function screenshotBase64(image) {
  if (typeof image.pngBase64 === "string") return image.pngBase64;
  const bytes = image.pngBytes ?? [];
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(
      ...bytes.slice(offset, offset + 8192).map((value) => value & 255),
    );
  return btoa(binary);
}
function isPng(base64) {
  const head = atob(base64.slice(0, 12));
  return PNG_SIGNATURE.every(
    (value, index) => head.charCodeAt(index) === value,
  );
}
function slideHeadings(state) {
  return JSON.stringify(
    state.slides.map((slide) => {
      const first =
        slide.elements.find(
          (element) =>
            typeof element.text === "string" &&
            /title/iu.test(`${element.kind ?? ""} ${element.name ?? ""}`),
        ) ?? slide.elements.find((element) => typeof element.text === "string");
      const text = typeof first?.text === "string" ? first.text : "";
      return {
        slide: slide.slideIndex + 1,
        heading: Array.from(text).slice(0, 80).join(""),
      };
    }),
  );
}
async function executeNativeTurn(model, input) {
  const started = performance.now();
  const modelInput = input.modelInput ?? newModelInput();
  const host = input.host;
  const call = async (request, signal) => {
    signal.throwIfAborted();
    const start = performance.now();
    modelInput.hostCalls++;
    try {
      const result = await host.call(request, signal);
      signal.throwIfAborted();
      return result;
    } finally {
      modelInput.hostMs += performance.now() - start;
    }
  };
  const scope = input.documentScope ?? "";
  const activeGoal = goal.normalizeActiveGoal(input.activeGoal, scope);
  const unfinishedGoal = policy.continuationGoal(
    input.requestText,
    input.conversationHistory,
    activeGoal,
  );
  const effectiveRequest = unfinishedGoal ?? input.requestText;
  let checks = unfinishedGoal && activeGoal ? activeGoal.checks : [];
  let observed = input.initialObservation;
  let pendingReview;
  let lastMutationObservation;
  let repairAllowed = false;
  let changed = false,
    reviewed = false;
  const changedSlides = new Set();
  let baselineIssues = Array.isArray(
    input.initialObservation?.layoutAudit?.issues,
  )
    ? new Set(
        input.initialObservation.layoutAudit.issues.map((issue) =>
          JSON.stringify(issue),
        ),
      )
    : null;
  let requestSatisfied = false;
  let toolTail = Promise.resolve();
  const outputInfo = new WeakMap();
  let deliveredRevision;
  let deliveredSlides = new Set();
  const observationOutput = (
    text,
    images,
    fullText,
    revision,
    slideIndexes,
  ) => {
    const output = { ok: true, text, images };
    outputInfo.set(output, { fullText, revision, slideIndexes });
    return output;
  };
  const recordOutput = (output) => {
    const info = outputInfo.get(output);
    if (!info) return;
    const bytes = new TextEncoder();
    const images = model.supportsInputImages === false ? [] : output.images;
    modelInput.calls++;
    modelInput.fullTextBytes += bytes.encode(info.fullText).length;
    modelInput.sentTextBytes += bytes.encode(output.text).length;
    modelInput.imageCount += images.length;
    modelInput.imageBytes += images.reduce(
      (size, image) =>
        size +
        Math.floor((image.length * 3) / 4) -
        (image.endsWith("==") ? 2 : image.endsWith("=") ? 1 : 0),
      0,
    );
    if (deliveredRevision !== info.revision) {
      deliveredRevision = info.revision;
      deliveredSlides = new Set();
    }
    if (images.length)
      for (const index of info.slideIndexes) deliveredSlides.add(index);
  };

  const content = (state) => {
    const { modelView, ...complete } = state;
    const fullText = JSON.stringify({
      ...complete,
      images: void 0,
      permission: input.permission,
    });
    const view =
      Array.isArray(modelView?.slides) && modelView.revision === state.revision
        ? modelView
        : nativeModelObservation(state);
    const detailSlides = Array.isArray(view.detailSlideIndexes)
      ? view.detailSlideIndexes
      : [];
    const modelSlides =
      view !== complete && Array.isArray(view.slides) ? view.slides : null;
    const focusedView =
      modelSlides && detailSlides.length > 0
        ? {
            ...view,
            slideCount: modelSlides.length,
            slides: modelSlides.filter(
              (slide) =>
                typeof slide === "object" &&
                slide !== null &&
                detailSlides.includes(slide.slideIndex),
            ),
          }
        : view;
    const text2 =
      view === complete
        ? fullText
        : JSON.stringify({ ...focusedView, permission: input.permission });
    const images = state.images.map(screenshotBase64);
    return observationOutput(
      text2,
      images,
      fullText,
      state.revision,
      state.images.map((image) => image.slideIndex),
    );
  };
  if (observed) {
    if (!checks.length)
      checks = goal.goalChecks(effectiveRequest, observed, input.permission);
    const initialPages = [];
    const revision = observed.revision;
    for (const slideIndex of requestedSlideIndexes(
      effectiveRequest,
      observed.slides.length,
      observed.activeSlide,
    )) {
      const page =
        (input.initialPages ?? []).find(
          (page) =>
            page.textDetails?.slideIndex === slideIndex &&
            page.revision === revision &&
            page.images.some((image) => image.slideIndex === slideIndex),
        ) ??
        (observed.textDetails?.slideIndex === slideIndex &&
        observed.images.some((image) => image.slideIndex === slideIndex)
          ? observed
          : await call(
              { operation: "observe", detailSlideIndex: slideIndex },
              input.signal,
            ));
      if (page.revision !== revision)
        throw Error("document_changed_during_initial_observation");
      initialPages.push(page);
    }
    input = { ...input, initialPages };
  }
  let initialPage = (() => {
    const pages = (input.initialPages ?? []).flatMap((state) => {
      const slideIndex = state.textDetails?.slideIndex;
      const slide = state.slides.find(
        (candidate) => candidate.slideIndex === slideIndex,
      );
      const image = state.images.find(
        (candidate) => candidate.slideIndex === slideIndex,
      );
      return slide && image && state.revision === observed?.revision
        ? [{ slideIndex, slide, textDetails: state.textDetails, image }]
        : [];
    });
    if (!pages.length) return void 0;
    const text2 = JSON.stringify({
      revision: observed?.revision,
      pages: pages.map(({ slideIndex, slide, textDetails }) => ({
        slideIndex,
        slide,
        textDetails,
      })),
    });
    const images = pages.map(({ image }) => screenshotBase64(image));
    return observationOutput(
      text2,
      images,
      text2,
      observed?.revision,
      pages.map((page) => page.slideIndex),
    );
  })();
  const registerMutationEvidence = (state) => {
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
      pendingReview = void 0;
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
    for (const index of slideIndexes) changedSlides.add(index);
    pendingReview = {
      revision: state.revision,
      slideIndexes,
      introducedIssueCount:
        baselineIssues && Array.isArray(state.layoutAudit?.issues)
          ? state.layoutAudit.issues.filter(
              (issue) => !baselineIssues.has(JSON.stringify(issue)),
            ).length
          : (state.layoutAudit?.introducedIssueCount ??
            state.layoutAudit?.introducedIssues?.length ??
            0),
    };
    lastMutationObservation = state;
    return true;
  };
  const authorize = (command, state) => {
    edit.validateOperationArguments(command);
    const operation = command.op ?? "";
    const operationContract =
      edit.nativeEditContract.mutationModel.operations[operation];
    if (
      !operationContract ||
      operationContract.availability === "format_excluded" ||
      (!edit.nativeDocumentOperations.has(operation) &&
        !edit.nativeSlideOperations.has(operation) &&
        !edit.nativeCreateOperations.has(operation) &&
        !edit.nativeMultiElementOperations.has(operation) &&
        !edit.nativeElementOperations.has(operation))
    )
      throw new Error("Unsupported native edit operation.");
    const supportedOperations = state.engine?.supportedOperations;
    if (
      !(0, edit.engineSupports)(
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
    if (edit.nativePlatformAssetOperations.has(operation)) {
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
    let slideIndex;
    if (edit.nativeDocumentOperations.has(operation)) {
      if (input.permission.mode !== "document")
        throw new Error("문서 전체 변경 권한이 필요합니다.");
      return state.activeSlide;
    }
    if (
      edit.nativeSlideOperations.has(operation) ||
      edit.nativeCreateOperations.has(operation)
    ) {
      if (
        !Number.isInteger(command.slideIndex) ||
        !state.slides.some((slide) => slide.slideIndex === command.slideIndex)
      )
        throw new Error("Slide target not present in observation.");
      slideIndex = command.slideIndex;
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
    if (edit.nativeMultiElementOperations.has(operation)) {
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
      slideIndex = targets[0].slideIndex;
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
        : void 0;
      if (!targetSlide) throw new Error("Target not present in observation.");
      slideIndex = targetSlide.slideIndex;
      if (
        input.permission.mode === "selection" &&
        !input.permission.elementIds.includes(command.elementId)
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
  let unconfirmedMutation = false;
  const applied = (state) => {
    try {
      return registerMutationEvidence(state);
    } catch (error) {
      unconfirmedMutation = true;
      throw error;
    }
  };
  const mutate = async (request, signal) => {
    try {
      const state = await call(request, signal);
      if (state.changedSlideIndexes?.length) {
        const indexes = [
          ...new Set([...changedSlides, ...state.changedSlideIndexes]),
        ].sort((a, b) => a - b);
        if (
          indexes.some(
            (index) =>
              !state.images.some((image) => image.slideIndex === index),
          )
        ) {
          const images = [];
          let refreshed;
          for (let offset = 0; offset < indexes.length; offset += 8) {
            const chunk = indexes.slice(offset, offset + 8);
            refreshed = await call(
              {
                operation: "observe",
                captureSlideIndexes: chunk,
                detailSlideIndex: null,
              },
              signal,
            );
            if (refreshed.revision !== state.revision)
              throw Error("document_changed_during_mutation_evidence");
            if (
              chunk.some(
                (index) =>
                  !refreshed.images.some((image) => image.slideIndex === index),
              )
            )
              throw Error("changed_slide_image_missing");
            images.push(
              ...refreshed.images.filter((image) =>
                chunk.includes(image.slideIndex),
              ),
            );
          }
          return {
            ...refreshed,
            images,
            changedSlideIndexes: indexes,
            visualEvidenceComplete: true,
          };
        }
      }
      return state;
    } catch (error) {
      if (
        !/^product_mutation_(?:rejected|rolled_back):/.test(error.message ?? "")
      )
        unconfirmedMutation = true;
      throw error;
    }
  };
  const tools = [
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
      description:
        "Insert or replace one image/audio/video using an observed document-scoped assetId through the trusted binary host boundary. For every other native change use native_batch_edit (one command is valid). Preserve native media and identity; never flatten editable objects.",
      inputSchema: edit.nativeAssetEditSchema,
    },
    {
      name: "native_batch_edit",
      description: `Plan or atomically apply 1-50 validated native edits to the SAME observed presentation. All targets come from one revision and are rebound to their live objects before each command. ${edit.nativeEditContract.transaction.ordering} dryRun validates targets, options, and permission without changing the document. A non-dry-run batch becomes one native Undo action and rolls back completely if any command fails. Do not send executable code. For an existing photo use crop_image with geometry ellipse/rectangle; a circle needs equal width and height (resize in the same batch if needed). Crops preserve original media. Pass null for unused fields.`,
      inputSchema: edit.nativeBatchEditSchema,
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
          requestSatisfied: { type: "boolean" },
          problems: { type: "array", items: { type: "string" } },
          reviewedSlideIndexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            uniqueItems: true,
          },
        },
        required: [
          "approved",
          "problems",
          "reviewedSlideIndexes",
          "requestSatisfied",
        ],
      },
    },
    {
      name: "web_search",
      description: webPolicy.WEB_SEARCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short search words, for example a topic or a name.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch_web_page",
      description: webPolicy.FETCH_WEB_PAGE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The exact https address from the user's request or a web_search result.",
          },
        },
        required: ["url"],
      },
    },
  ];
  const webAccess = new webPolicy.TurnWebAccess(input.requestText);
  const REVIEW_ONLY_TOOLS = /* @__PURE__ */ new Set([
    "native_observe",
    "native_review",
  ]);
  const runTool = async (name, args, signal) => {
    if (name === "native_observe") {
      const detailSlideIndex = args?.detailSlideIndex;
      if (detailSlideIndex !== null && !Number.isInteger(detailSlideIndex))
        throw new Error("Invalid detail slide.");
      input.onTool("현재 슬라이드 확인");
      const nextObservation = await call(
        { operation: "observe", detailSlideIndex },
        signal,
      );
      if (
        pendingReview &&
        nextObservation.revision !== pendingReview.revision
      ) {
        pendingReview = void 0;
        reviewed = false;
      }
      observed = nextObservation;
      if (
        !changed &&
        !baselineIssues &&
        Array.isArray(observed.layoutAudit?.issues)
      )
        baselineIssues = new Set(
          observed.layoutAudit.issues.map((issue) => JSON.stringify(issue)),
        );
      if (!changed && !checks.length)
        checks = goal.goalChecks(effectiveRequest, observed, input.permission);
      return content(observed);
    }
    if (name === "native_edit") {
      if (!observed) throw new Error("Observe before editing.");
      if (input.permission.mode === "read_only")
        throw new Error("읽기 전용 권한입니다.");
      const command = args;
      const slideIndex = authorize(command, observed);
      input.onTool("슬라이드 수정");
      const expectedSlides = JSON.stringify(observed.slides);
      const expectedRevision = observed.revision;
      observed = void 0;
      observed = await mutate(
        edit.nativePlatformAssetOperations.has(command.op ?? "")
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
      const batch = args;
      if (
        !Array.isArray(batch.commands) ||
        batch.commands.length < 1 ||
        batch.commands.length >
          edit.nativeEditContract.transaction.maxCommands ||
        typeof batch.dryRun !== "boolean"
      )
        throw new Error("Invalid native edit transaction.");
      if (
        batch.commands.some((command) =>
          edit.nativePlatformAssetOperations.has(command.op ?? ""),
        )
      )
        throw new Error(
          "자산 삽입과 교체는 신뢰된 파일 전송 경계를 사용하므로 native_edit에서 한 번에 하나씩 실행해야 합니다.",
        );
      if (
        batch.commands.length > 1 &&
        batch.commands.some((command) =>
          edit.nativeIdentityReplacingOperations.has(command.op ?? ""),
        )
      )
        throw new Error(
          "An identity-replacing edit must be a one-command transaction.",
        );
      for (const command of batch.commands) authorize(command, observed);
      input.onTool(batch.dryRun ? "수정 계획 검사" : "여러 요소 한 번에 수정");
      const previous = observed;
      observed = void 0;
      const request = {
        operation: "edit_batch",
        expectedRevision: previous.revision,
        expectedSlides: JSON.stringify(previous.slides),
        commands: batch.commands,
        dryRun: batch.dryRun,
        permission: input.permission,
      };
      observed = batch.dryRun
        ? await call(request, signal)
        : await mutate(request, signal);
      if (!batch.dryRun && applied(observed)) {
        changed = true;
        reviewed = false;
      }
      return content(observed);
    }
    if (name === "native_review") {
      if (!changed || !observed) throw new Error("No changed slide to review.");
      const result = args;
      if (
        typeof result.approved !== "boolean" ||
        typeof result.requestSatisfied !== "boolean" ||
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
      if (
        deliveredRevision !== pendingReview.revision ||
        pendingReview.slideIndexes.some((index) => !deliveredSlides.has(index))
      )
        throw Error(
          "The model has not received every changed-slide screenshot.",
        );
      const reviewedSlideIndexes = [
        ...new Set(result.reviewedSlideIndexes),
      ].sort((left, right) => left - right);
      if (
        JSON.stringify(reviewedSlideIndexes) !==
        JSON.stringify(pendingReview.slideIndexes)
      )
        throw new Error(
          "Every changed slide must be included in the visual review.",
        );
      const current = await call(
        { operation: "observe", detailSlideIndex: null },
        signal,
      );
      if (current.revision !== pendingReview.revision) {
        observed = current;
        pendingReview = void 0;
        reviewed = false;
        throw new Error("The visual review evidence is stale.");
      }
      observed = current;
      // A fresh, unchanged document can be repaired within the user's existing
      // permission. An ambiguous mutation or a human edit cannot authorize it.
      repairAllowed = !unconfirmedMutation;
      if (result.approved && result.problems.length > 0)
        throw new Error(
          "A visual review cannot approve while reporting problems.",
        );
      if (result.approved && pendingReview.introducedIssueCount > 0)
        throw new Error(
          "A visual review cannot approve newly introduced layout issues.",
        );
      const objective = goal.verifyGoalChecks(checks, current);
      if (result.requestSatisfied && !objective.passed)
        throw Error(
          "customer_goal_not_satisfied:" + JSON.stringify(objective.failures),
        );
      requestSatisfied = result.requestSatisfied === true && objective.passed;
      reviewed = result.approved && result.problems.length === 0;
      input.onTool(reviewed ? "수정 화면 확인 완료" : "수정 화면 재검토 필요");
      return { ok: true, text: JSON.stringify(result) };
    }
    if (name === "web_search") {
      const query = webAccess.searchQuery(args);
      input.onTool(`위키백과 검색: "${query}"`);
      const results = await input.web.search(query, signal);
      webAccess.allowResults(results);
      return { ok: true, text: JSON.stringify(results) };
    }
    if (name === "fetch_web_page") {
      const url = webAccess.pageAddress(args);
      input.onTool(`웹페이지 읽기: ${new URL(url).hostname}`);
      return {
        ok: true,
        text: `${webPolicy.UNTRUSTED_PAGE_NOTICE}
${await input.web.readPage(url, signal)}`,
      };
    }
    throw new Error("Unknown tool.");
  };

  let directlyApplied = false;
  const planned =
    observed &&
    edit.engineSupports(
      {
        patchLevel: observed.engine?.patchLevel ?? null,
        supportedOperations: observed.engine?.supportedOperations ?? [],
      },
      "crop_image",
    )
      ? goal.simpleGoalCommands(
          effectiveRequest,
          checks,
          observed,
          input.permission,
        )
      : null;
  if (planned) {
    try {
      await runTool(
        "native_batch_edit",
        { commands: planned, dryRun: false },
        input.signal,
      );
      directlyApplied = changed;
      initialPage = content(observed);
    } catch (error) {
      input.signal.throwIfAborted();
      observed = await call(
        { operation: "observe", detailSlideIndex: null },
        input.signal,
      );
      initialPage = content(observed);
    }
  }
  let generatedImageInserted = false;
  const turn = async (prompt, timeoutMs, reviewOnly = false) => {
    const start = performance.now(),
      hostBefore = modelInput.hostMs;
    try {
      if (initialPage) recordOutput(initialPage);
      return await model.run({
        allowImageGeneration:
          !reviewOnly &&
          !generatedImageInserted &&
          model.allowImageGeneration === true,
        onGeneratedImage: async (image) => {
          const work = toolTail.then(async () => {
            input.signal.throwIfAborted();
            if (
              !["slides", "document"].includes(input.permission.mode) ||
              !host.createImage ||
              !observed ||
              generatedImageInserted
            )
              throw Error("generated_image_permission_or_target_missing");
            const slideIndex = observed.activeSlide;
            if (
              input.permission.mode === "slides" &&
              !input.permission.slideIndexes.includes(slideIndex)
            )
              throw Error("허용된 슬라이드 밖입니다.");
            const asset = await host.createImage(image, input.signal);
            const before = observed,
              expectedRevision = before.revision,
              expectedSlides = JSON.stringify(before.slides);
            observed = undefined;
            observed = await mutate(
              {
                operation: "insert_image",
                assetId: asset.assetId,
                slideIndex,
                expectedRevision,
                expectedSlides,
                permission: input.permission,
              },
              input.signal,
            );
            if (
              observed.slides.reduce((n, s) => n + s.elements.length, 0) <=
                before.slides.reduce((n, s) => n + s.elements.length, 0) ||
              !applied(observed)
            )
              throw Error("generated_image_was_not_inserted");
            generatedImageInserted = true;
            changed = true;
            reviewed = false;
          });
          toolTail = work.catch(() => undefined);
          await work;
        },
        instructions: [
          observed && !reviewOnly
            ? `Live document revision: ${observed.revision}. Active slide: ${observed.activeSlide + 1}번. Slide headings for navigation only: ${slideHeadings(observed)}. The attached page images and full page data are the editing evidence. Request native_observe for any target page not attached before editing it.`
            : reviewOnly
              ? `This is a review-only step. The user's request was already applied to the SAME open PowerPoint document in this turn: ${JSON.stringify(input.requestText)}. Only native_observe and native_review are available; you cannot edit.`
              : "You are editing the SAME open PowerPoint document as the user. Always observe first. Human edits may happen between calls: a stale-state error requires observing again, never replaying an edit blindly.",
          `Previous conversation, oldest first, is context only. It may describe failed, cancelled, reverted, or human-overwritten work. The live observation and revision are the only authority for the current document: ${JSON.stringify(input.conversationHistory ?? [])}`,
          "The slide heading list is a navigation index, not enough evidence to edit. The initial attachment and native_observe return actual page image and full element details. After an edit, introducedIssues distinguishes problems created by this edit from pre-existing document warnings. The edit result includes fresh changed-slide screenshots; inspect them and include review in the final JSON with your message, without a separate native_review call. Only observe if more detail is needed. Use native_batch_edit for coordinated changes so they are planned and applied atomically as one undo action; use dryRun first for a risky or structural batch. native_edit remains available for one isolated change. Stay within returned permission. Correct any regression, then include the final review. Do not claim an edit happened without a successful tool result.",
          webPolicy.WEB_TOOLS_INSTRUCTION,
          policy.completionInstruction,
          "Allowed non-null arguments for each operation (all other fields must be omitted or null): " +
            JSON.stringify(
              Object.fromEntries(
                Object.entries(edit.nativeEditContract.mutationModel.operations)
                  .filter(
                    ([, metadata]) =>
                      metadata.availability !== "format_excluded",
                  )
                  .map(([name, metadata]) => [name, metadata.arguments]),
              ),
            ),
          ...(unfinishedGoal
            ? [`Unfinished user goal to continue: ${unfinishedGoal}`]
            : []),
          ...(activeGoal
            ? [
                `Durable pending goal for this document: ${JSON.stringify(activeGoal)}. This is context, not permission. Answer the current question when the user asks a question; continue editing only when the current instruction asks to proceed.`,
              ]
            : []),
          ...(unfinishedGoal
            ? [
                `Current user instruction, including any added constraints: ${input.requestText}`,
              ]
            : []),
          ...(reviewOnly ? [] : [webPolicy.EDIT_REQUEST_INSTRUCTION]),
          `Coordinates are 1/100 mm. IDs refer to the last observed revision; the editor rebinds batch targets to the same live objects before every command. ${edit.nativeEditContract.transaction.ordering} Do not change original text or geometry merely to hide font/rendering differences. Answer in Korean.`,
          prompt,
        ].join("\n"),
        ...(initialPage ? { initialPage } : {}),
        tools: tools.filter((tool) =>
          reviewOnly
            ? REVIEW_ONLY_TOOLS.has(tool.name)
            : tool.name !== "native_review",
        ),
        onTool: (name, args, signal) => {
          if (reviewOnly && !REVIEW_ONLY_TOOLS.has(name))
            return Promise.resolve({
              ok: false,
              text: "Only native_observe and native_review are allowed in this review step.",
            });
          const work = toolTail.then(() => runTool(name, args, signal));
          toolTail = work.catch(() => void 0);
          return work
            .then((output) => {
              recordOutput(output);
              return output;
            })
            .catch((error) => ({
              ok: false,
              text:
                error instanceof Error
                  ? error.message
                  : "Document operation failed.",
            }));
        },
        onText: () => {},
        // Buffer provisional claims until execution is adjudicated.
        onThinking: input.onThinking,
        onUsage: (usage) => {
          modelInput.providerCalls += usage.calls;
          modelInput.providerInputTokens += usage.input;
          modelInput.providerOutputTokens += usage.output;
          modelInput.cacheReadTokens += usage.cacheRead;
          modelInput.cacheWriteTokens += usage.cacheWrite;
        },
        modelSettings: input.modelSettings,
        signal: input.signal,
        timeoutMs,
      });
    } finally {
      modelInput.modelMs += Math.max(
        0,
        performance.now() - start - (modelInput.hostMs - hostBefore),
      );
    }
  };
  let text = await turn(
    `User request: ${effectiveRequest}`,
    24e4,
    directlyApplied,
  );
  const finishReview = async (raw) => {
    await toolTail;
    input.signal.throwIfAborted();
    const report = policy.parseCompletion(raw);
    if (report?.review && changed) {
      try {
        await runTool("native_review", report.review, input.signal);
      } catch (error) {
        reviewed = false;
        requestSatisfied = false;
        input.onTool("요청 결과 재검토 필요".trim());
      }
    }
  };
  await finishReview(text);
  if (changed && (!reviewed || !requestSatisfied)) {
    // Provider calls may use fresh threads: never assume the next call retains
    // screenshots returned to the previous one.
    if (observed)
      initialPage = content(
        lastMutationObservation?.revision === observed.revision
          ? { ...observed, images: lastMutationObservation.images }
          : observed,
      );
    const review = await turn(
      "Use the fresh changed-slide screenshots already returned by the edit. If the requested result is missing, correct only the missing part when editing is allowed. Include review with every changed slide, requestSatisfied and problems in the final JSON. Only observe again if necessary. Prefer a final JSON with review and message together. Approve only if the fresh screenshot shows the requested change without new problems; otherwise report the problems. Then tell the user in Korean what changed and what the review found.",
      18e4,
      !reviewed && !repairAllowed,
    );
    await finishReview(review);
    if (review.trim()) text = review;
  }
  const completion = (0, policy.finalizeTurn)(text, {
    requestText: unfinishedGoal || input.requestText,
    ...(unfinishedGoal ? { requiredIntent: "edit" } : {}),
    readOnly: input.permission.mode === "read_only",
    changed,
    reviewed,
    requestSatisfied,
    unconfirmedMutation,
  });
  text = completion.text;
  if (changed && !reviewed)
    text += `

${UNREVIEWED_EDIT_NOTICE}`;
  else if (unconfirmedMutation && !reviewed)
    text += `

${UNCONFIRMED_EDIT_NOTICE}`;
  const nextGoal = goal.nextActiveGoal(
    activeGoal,
    scope,
    effectiveRequest,
    completion,
    checks,
  );
  modelInput.elapsedMs = performance.now() - started;
  modelInput.hostMs = Math.round(modelInput.hostMs);
  modelInput.modelMs = Math.round(modelInput.modelMs);
  modelInput.elapsedMs = Math.round(modelInput.elapsedMs);
  input.onText(text);
  return {
    text,
    changed,
    reviewed,
    requestSatisfied,
    task: completion.task,
    activeGoal: nextGoal,
    status:
      completion.task.outcome === "unverified" || (changed && !reviewed)
        ? "needs_review"
        : "completed",
    modelInput,
  };
}

function nativeModelObservation(state) {
  if (
    state.modelView?.revision === state.revision &&
    Array.isArray(state.modelView.slides)
  )
    return state.modelView;
  const detailed = new Set([
    state.activeSlide,
    state.textDetails?.slideIndex,
    ...state.images.map((image) => image.slideIndex),
  ]);
  const { images, modelView, ...rest } = state;
  return {
    ...rest,
    slides: state.slides.map((slide) =>
      detailed.has(slide.slideIndex)
        ? slide
        : {
            slideIndex: slide.slideIndex,
            elementCount: slide.elements.length,
            previewText: slide.elements
              .map((e) => e.text ?? "")
              .join(" ")
              .slice(0, 200),
            detailsAvailable: true,
          },
    ),
    masters: state.masters?.map(({ drawings, layouts, ...master }) => ({
      ...master,
      layouts: layouts?.map(({ drawings, ...layout }) => layout),
    })),
  };
}

function requestedSlideIndexes(requestText, slideCount, activeSlide) {
  const candidates = [];
  const add = (match, number, end) => {
    const tail = requestText.slice(end);
    if (
      /^(?:을|를)?\s*(?:추가|삽입|만들|생성)/u.test(tail) ||
      (match[0].startsWith("슬라이드") && /^\s*(?:장|개)/u.test(tail)) ||
      /^의\s*슬라이드/u.test(tail)
    )
      return;
    candidates.push({ position: match.index, number });
  };
  for (const match of requestText.matchAll(/슬라이드\s*(\d+)\s*(?:번)?/gu))
    add(match, Number(match[1]), match.index + match[0].length);
  for (const match of requestText.matchAll(
    /(\d+)\s*(?:번\s*)?(?:장|슬라이드)/gu,
  ))
    add(match, Number(match[1]), match.index + match[0].length);
  const ordinals = {
    첫: 1,
    한: 1,
    두: 2,
    세: 3,
    네: 4,
    다섯: 5,
    여섯: 6,
    일곱: 7,
    여덟: 8,
    아홉: 9,
    열: 10,
  };
  for (const match of requestText.matchAll(
    /(첫|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*번째\s*(?:장|슬라이드)/gu,
  ))
    add(match, ordinals[match[1]], match.index + match[0].length);
  const named = candidates
    .sort((left, right) => left.position - right.position)
    .map(({ number }) => number - 1)
    .filter(
      (index) =>
        Number.isSafeInteger(index) && index >= 0 && index < slideCount,
    );
  return [...new Set(named.length ? named : [activeSlide])].slice(0, 8);
}

async function runNativeTurn(model, input) {
  const started = performance.now(),
    modelInput = input.modelInput ?? newModelInput();
  try {
    return await executeNativeTurn(model, { ...input, modelInput });
  } finally {
    modelInput.elapsedMs = Math.round(performance.now() - started);
    modelInput.hostMs = Math.round(modelInput.hostMs);
    modelInput.modelMs = Math.round(modelInput.modelMs);
  }
}
module.exports = {
  runNativeTurn,
  newModelInput,
  screenshotBase64,
  nativeModelObservation,
  requestedSlideIndexes,
  UNCONFIRMED_EDIT_NOTICE,
  UNREVIEWED_EDIT_NOTICE,
};
