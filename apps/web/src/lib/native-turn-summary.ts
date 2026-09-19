/*
 * Builds the result-card summary of one native AI turn from the editor's
 * own task records (observe/edit results), never from the assistant's text.
 * Pure functions; the DB loader lives at the bottom.
 */
import capabilities from "../../../../contracts/native-edit-capabilities.json";
import { elementLabel } from "./element-label";

export { elementLabel };

export type TurnOutcome =
  | "running"
  | "changed"
  | "unverified"
  | "unchanged"
  | "answered"
  | "failed"
  | "cancelled";

export type TurnChange = {
  slideIndex: number;
  target: string;
  kind: "added" | "removed" | "modified";
  details: string[];
  /** Slide-relative box (0–1) of the element after the change (before, if removed). */
  box: { x: number; y: number; width: number; height: number } | null;
  /**
   * The element as it is after the turn (`slide/index`), so the editor can
   * select it. Null for removed elements and slide-level changes. Missing on
   * summaries stored before this field existed.
   */
  elementId?: string | null;
};

/** Changes on one slide, counted by what was changed ("텍스트 상자 3, 바닥글 1"). */
export type TurnSlideGroup = {
  slideIndex: number;
  count: number;
  targets: Array<{ label: string; count: number }>;
};

/** `taskId:imageIndex` reference into a stored task result. */
export type EvidenceRef = string;

export type TurnSlideEvidence = {
  slideIndex: number;
  before: EvidenceRef | null;
  after: EvidenceRef | null;
  /**
   * `window`: the image is the whole editor window (the browser editor's
   * canvas), so slide-relative outlines cannot be placed on it. Missing on
   * summaries stored before this field existed; treat as `slide`.
   */
  framing?: "slide" | "window";
  /**
   * The after image may show the editor before it repainted the change (the
   * browser editor never repainted within its wait). Shown with a caveat.
   */
  stale?: boolean;
};

export type TurnFailure = { code: string; message: string };

export type TurnSummary = {
  version: 1;
  outcome: TurnOutcome;
  changedSlides: number[];
  slideCount: { before: number | null; after: number | null };
  changes: TurnChange[];
  omittedChanges: number;
  reviewed: boolean;
  /** Issues the edits introduced; null when no edit evidence exists. */
  introducedIssues: {
    overlap: number;
    outOfBounds: number;
    invalidSize: number;
  } | null;
  /** True when every applied edit passed the editor's own scope check. */
  scopeEnforced: boolean;
  scopeRejected: boolean;
  evidence: TurnSlideEvidence[];
  failure: TurnFailure | null;
  /*
   * Fields below were added later; summaries stored earlier lack them.
   */
  /**
   * Slides whose content is identical before and after the turn, compared
   * slide by slide from the editor's own before/after states. Null when that
   * comparison is not possible (no states, slide count or masters changed).
   */
  unchangedSlides?: number | null;
  /** Undo actions the turn's applied edits recorded in the editor. */
  undoSteps?: number;
  /** Editor revisions right before the first applied edit and after the last. */
  revisions?: { before: string | null; after: string | null };
  /** Every change grouped by slide, including changes beyond the listed ones. */
  slideGroups?: TurnSlideGroup[];
  /** The one detail every change shares ("글자 크기 32pt → 28pt"), if any. */
  sharedDetail?: string | null;
};

type Json = Record<string, any>;

export type TurnTaskRecord = {
  id: string;
  request: Json;
  status: string;
  result: Json | null;
  error: string | null;
};

export type TurnRecord = {
  status: string;
  permissionMode: string;
  changed: boolean;
  reviewed: boolean;
  lastError: string | null;
};

const MUTATIONS = new Set([
  "edit",
  "edit_batch",
  "insert_image",
  "replace_image",
  "insert_media",
  "replace_media",
]);
const MAX_CHANGES = 24;

function isMutation(task: TurnTaskRecord) {
  const operation = String(task.request?.operation ?? "");
  if (!MUTATIONS.has(operation)) return false;
  return !(operation === "edit_batch" && task.request?.dryRun === true);
}

function applied(task: TurnTaskRecord) {
  if (task.status !== "completed" || !task.result) return false;
  const status = task.result.transaction?.status;
  if (status === "unchanged" || status === "validated") return false;
  return Array.isArray(task.result.changedSlideIndexes)
    ? task.result.changedSlideIndexes.length > 0
    : status === "applied";
}

const scopePattern =
  /outside|scope|permission|권한|범위 밖|선택 범위|허용된 슬라이드|읽기 전용/i;

/* ── Failure reasons: one sentence of cause, safe to show ─────────── */
const failureRules: Array<{ test: RegExp; code: string; message: string }> = [
  {
    test: /user_cancelled|사용자가 작업을 중단/,
    code: "cancelled",
    message: "요청을 중단했어요. 중단 전까지 바뀐 것이 있으면 아래에 보여요.",
  },
  {
    test: /native_agent_interrupted|연결이 중단/,
    code: "interrupted",
    message:
      "AI 작업 연결이 끊겼어요. 슬라이드를 확인한 뒤 다시 요청해 주세요.",
  },
  {
    test: /selected_model_unavailable|model[^.]{0,40}(not found|unavailable|unsupported|does not exist)/i,
    code: "model_unavailable",
    message:
      "선택한 AI 모델을 지금 쓸 수 없어요. 모델을 바꿔 다시 요청해 주세요.",
  },
  {
    test: /rate[ _-]?limit|quota|usage limit|\b429\b|사용 한도/i,
    code: "usage_limit",
    message: "AI 구독의 사용 한도에 걸렸어요. 잠시 뒤 다시 요청해 주세요.",
  },
  {
    test: /unauthori[sz]ed|\b401\b|not logged in|login required|auth(entication)? (failed|required|expired)|ai_account_not_connected/i,
    code: "ai_not_connected",
    message:
      "AI 구독 연결을 다시 확인해야 해요. 설정에서 연결 상태를 확인해 주세요.",
  },
  {
    test: /document_changed|observe_again/i,
    code: "document_changed",
    message:
      "작업 중에 문서가 바뀌어서 멈췄어요. 다시 요청하면 바뀐 문서를 보고 이어서 해요.",
  },
  {
    test: /native_session_not_active|native_save_validation_in_progress/,
    code: "save_in_progress",
    message:
      "문서를 저장하는 중에 요청이 시작돼 멈췄어요. 저장이 끝난 뒤 다시 요청해 주세요.",
  },
  {
    test: /timeout|timed out|ETIMEDOUT|deadline/i,
    code: "timeout",
    message:
      "AI 응답이 너무 오래 걸려 멈췄어요. 요청을 조금 나눠서 다시 보내 주세요.",
  },
  {
    test: /dispatch_failed|native_ai_unavailable|ECONNREFUSED|fetch failed|unavailable/i,
    code: "ai_unavailable",
    message: "AI 작업기에 연결하지 못했어요. 잠시 뒤 다시 요청해 주세요.",
  },
];

export function nativeFailureReason(
  error: string | null | undefined,
): TurnFailure {
  const text = error ?? "";
  for (const rule of failureRules)
    if (rule.test.test(text)) return { code: rule.code, message: rule.message };
  return {
    code: "unknown",
    message:
      "AI가 요청을 끝내지 못했어요. 문서는 요청 전 상태를 유지하고 있어요.",
  };
}

/* ── Element diff ─────────────────────────────────────────────────── */
function quote(text: unknown, limit = 36) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function hex(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  return `#${Math.round(value).toString(16).padStart(6, "0").toUpperCase()}`;
}

function sameNumber(left: unknown, right: unknown, tolerance: number) {
  if (typeof left !== "number" || typeof right !== "number")
    return left === right;
  return Math.abs(left - right) <= tolerance;
}

function round(value: unknown, digits = 1) {
  if (typeof value !== "number") return "?";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

export function describeElementChange(before: Json, after: Json): string[] {
  const lines: string[] = [];
  if ((before.text ?? null) !== (after.text ?? null)) {
    if (!before.text) lines.push(`문구 추가 “${quote(after.text)}”`);
    else if (!after.text) lines.push(`문구 삭제 “${quote(before.text)}”`);
    else lines.push(`문구 “${quote(before.text)}” → “${quote(after.text)}”`);
  }
  if (!sameNumber(before.fontSize, after.fontSize, 0.05))
    lines.push(
      `글자 크기 ${round(before.fontSize)}pt → ${round(after.fontSize)}pt`,
    );
  if (before.fontFamily !== after.fontFamily && after.fontFamily)
    lines.push(`글꼴 ${before.fontFamily ?? "기본"} → ${after.fontFamily}`);
  const bold = (value: unknown) => typeof value === "number" && value >= 140;
  if (bold(before.fontWeight) !== bold(after.fontWeight))
    lines.push(bold(after.fontWeight) ? "굵게" : "굵게 해제");
  const italic = (value: unknown) =>
    /ITALIC|OBLIQUE/i.test(String(value ?? ""));
  if (italic(before.fontStyle) !== italic(after.fontStyle))
    lines.push(italic(after.fontStyle) ? "기울임" : "기울임 해제");
  const underline = (value: unknown) => typeof value === "number" && value > 0;
  if (underline(before.underline) !== underline(after.underline))
    lines.push(underline(after.underline) ? "밑줄" : "밑줄 해제");
  if (before.color !== after.color && hex(after.color))
    lines.push(`글자 색 ${hex(before.color) ?? "기본"} → ${hex(after.color)}`);
  if (before.fillStyle !== after.fillStyle && after.fillStyle)
    lines.push(after.fillStyle === "NONE" ? "채우기 없앰" : "채우기 바꿈");
  else if (before.fill !== after.fill && hex(after.fill))
    lines.push(`채우기 색 ${hex(before.fill) ?? "없음"} → ${hex(after.fill)}`);
  if (before.lineColor !== after.lineColor && hex(after.lineColor))
    lines.push(
      `선 색 ${hex(before.lineColor) ?? "없음"} → ${hex(after.lineColor)}`,
    );
  if (!sameNumber(before.lineWidth, after.lineWidth, 1))
    lines.push(
      `선 굵기 ${round(Number(before.lineWidth) / 35.28, 1)}pt → ${round(Number(after.lineWidth) / 35.28, 1)}pt`,
    );
  if (!sameNumber(before.rotation, after.rotation, 1))
    lines.push(
      `회전 ${round(Number(before.rotation ?? 0) / 100, 0)}° → ${round(Number(after.rotation ?? 0) / 100, 0)}°`,
    );
  const shadowOn = (value: Json) => value?.shadow?.enabled === true;
  if (shadowOn(before) !== shadowOn(after))
    lines.push(shadowOn(after) ? "그림자 추가" : "그림자 해제");
  else if (
    JSON.stringify(before.shadow ?? null) !==
    JSON.stringify(after.shadow ?? null)
  )
    lines.push("그림자 바꿈");
  if ((before.hyperlink ?? "") !== (after.hyperlink ?? ""))
    lines.push("링크 바꿈");
  if (
    (before.description ?? "") !== (after.description ?? "") ||
    (before.title ?? "") !== (after.title ?? "")
  )
    lines.push("대체 텍스트 바꿈");
  if (
    JSON.stringify(before.chart ?? null) !== JSON.stringify(after.chart ?? null)
  )
    lines.push("차트 바꿈");
  if (
    JSON.stringify(before.table ?? before.cells ?? null) !==
    JSON.stringify(after.table ?? after.cells ?? null)
  )
    lines.push("표 내용 바꿈");
  if (
    before.paragraphAlignment !== after.paragraphAlignment &&
    after.paragraphAlignment != null
  )
    lines.push("문단 정렬 바꿈");
  const moved =
    !sameNumber(before.x, after.x, 50) || !sameNumber(before.y, after.y, 50);
  const resized =
    !sameNumber(before.width, after.width, 50) ||
    !sameNumber(before.height, after.height, 50);
  if (resized)
    lines.push(
      `크기 ${round(Number(before.width) / 1000)}×${round(Number(before.height) / 1000)}cm → ${round(Number(after.width) / 1000)}×${round(Number(after.height) / 1000)}cm`,
    );
  else if (moved) lines.push("위치 이동");
  return lines;
}

function elementKey(element: Json) {
  return String(element.stableId ?? element.elementId ?? "");
}

function relativeBox(element: Json, slide: Json) {
  const width = Number(slide?.width);
  const height = Number(slide?.height);
  if (!(width > 0 && height > 0)) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(Number(element.x) / width);
  const y = clamp(Number(element.y) / height);
  return {
    x,
    y,
    width: clamp(Number(element.width) / width + x) - x,
    height: clamp(Number(element.height) / height + y) - y,
  };
}

function topLevel(elements: unknown) {
  return (Array.isArray(elements) ? elements : []).filter(
    (element: Json) => !element?.parentElementId,
  ) as Json[];
}

export function diffSlides(
  beforeSlides: Json[],
  afterSlides: Json[],
  slideIndexes: number[],
) {
  const changes: TurnChange[] = [];
  for (const slideIndex of slideIndexes) {
    const before = beforeSlides.find(
      (slide) => slide?.slideIndex === slideIndex,
    );
    const after = afterSlides.find((slide) => slide?.slideIndex === slideIndex);
    if (!before && after) {
      changes.push({
        slideIndex,
        target: "슬라이드",
        kind: "added",
        details: ["새 슬라이드"],
        box: null,
      });
      continue;
    }
    if (before && !after) {
      changes.push({
        slideIndex,
        target: "슬라이드",
        kind: "removed",
        details: ["슬라이드 삭제"],
        box: null,
      });
      continue;
    }
    if (!before || !after) continue;
    const changesBefore = changes.length;
    const slideLines = describeSlideChange(before, after);
    if (slideLines.length)
      changes.push({
        slideIndex,
        target: "슬라이드",
        kind: "modified",
        details: slideLines,
        box: null,
      });
    const beforeElements = new Map(
      topLevel(before.elements).map((e) => [elementKey(e), e]),
    );
    const afterElements = new Map(
      topLevel(after.elements).map((e) => [elementKey(e), e]),
    );
    for (const [key, element] of afterElements) {
      const previous = beforeElements.get(key);
      if (!previous) {
        changes.push({
          slideIndex,
          target: elementLabel(element),
          kind: "added",
          details: element.text
            ? [`새로 추가 “${quote(element.text)}”`]
            : ["새로 추가"],
          box: relativeBox(element, after),
          elementId:
            typeof element.elementId === "string" ? element.elementId : null,
        });
        continue;
      }
      const details = describeElementChange(previous, element);
      if (
        !details.length &&
        JSON.stringify(previous) !== JSON.stringify(element)
      )
        details.push("서식 바꿈");
      if (details.length)
        changes.push({
          slideIndex,
          target: elementLabel(element),
          kind: "modified",
          details,
          box: relativeBox(element, after),
          elementId:
            typeof element.elementId === "string" ? element.elementId : null,
        });
    }
    for (const [key, element] of beforeElements)
      if (!afterElements.has(key))
        changes.push({
          slideIndex,
          target: elementLabel(element),
          kind: "removed",
          details: element.text ? [`삭제 “${quote(element.text)}”`] : ["삭제"],
          box: relativeBox(element, before),
          elementId: null,
        });
    if (
      changes.length === changesBefore &&
      comparableSlide(before) !== comparableSlide(after)
    )
      changes.push({
        slideIndex,
        target: "슬라이드",
        kind: "modified",
        details: ["슬라이드 서식 바꿈"],
        box: null,
      });
  }
  return changes;
}

/**
 * Slide JSON without derived audit fields and live-session identities, for
 * "did this slide change". Element ids are positions and stableIds are
 * handles of the running editor; neither is content.
 */
function comparableSlide(slide: Json) {
  const {
    layoutIssues: _layout,
    accessibilityIssues: _accessibility,
    readingOrder: _order,
    slideIndex: _index,
    elements,
    ...rest
  } = slide ?? {};
  return JSON.stringify({
    ...rest,
    elements: (Array.isArray(elements) ? elements : []).map(
      ({
        stableId: _stable,
        elementId: _id,
        parentElementId: _parent,
        childElementIds: _children,
        ...element
      }: Json) => element,
    ),
  });
}

/** Masters without the diagnostic shape count the editor itself excludes. */
function comparableMasters(masters: unknown) {
  return JSON.stringify(
    (Array.isArray(masters) ? masters : []).map(
      ({ shapeCount: _count, ...master }: Json) => master,
    ),
  );
}

/** Slide positions whose content differs, comparing position by position. */
export function differingSlides(beforeSlides: Json[], afterSlides: Json[]) {
  return beforeSlides
    .map((slide, index) =>
      comparableSlide(slide) === comparableSlide(afterSlides[index])
        ? -1
        : index,
    )
    .filter((index) => index >= 0);
}

const mutationOperations = capabilities.mutationModel.operations as Record<
  string,
  { family?: string }
>;
const structureLabels: Record<string, string> = {
  move_slide: "슬라이드 순서 바꿈",
  insert_slide: "슬라이드 추가",
  duplicate_slide: "슬라이드 복제",
  delete_slide: "슬라이드 삭제",
};

/** What the edits did to the slide list itself (add, delete, move). */
function structureChanges(tasks: TurnTaskRecord[]) {
  const labels = new Set<string>();
  for (const task of tasks) {
    const commands =
      task.request?.operation === "edit_batch"
        ? task.request.commands
        : [task.request?.command];
    for (const command of Array.isArray(commands) ? commands : []) {
      const op = String(command?.op ?? "");
      if (
        mutationOperations[op]?.family === "slide_structure" &&
        structureLabels[op]
      )
        labels.add(structureLabels[op]);
    }
  }
  return [...labels];
}

export function describeSlideChange(before: Json, after: Json): string[] {
  const lines: string[] = [];
  const differs = (key: string) =>
    JSON.stringify(before?.[key] ?? null) !==
    JSON.stringify(after?.[key] ?? null);
  if (differs("backgroundColor")) lines.push("배경 바꿈");
  if (differs("layout") || differs("masterName")) lines.push("레이아웃 바꿈");
  if (differs("hidden"))
    lines.push(after?.hidden ? "슬라이드 숨김" : "슬라이드 표시");
  if (differs("transition")) lines.push("전환 효과 바꿈");
  if (differs("animations")) lines.push("애니메이션 바꿈");
  if (differs("speakerNotes")) lines.push("발표자 노트 바꿈");
  if (differs("footer")) lines.push("바닥글 바꿈");
  if (differs("name")) lines.push("슬라이드 이름 바꿈");
  return lines;
}

/* ── Evidence images ──────────────────────────────────────────────── */
function imagesOf(task: TurnTaskRecord) {
  const images = task.result?.images;
  return Array.isArray(images) ? (images as Json[]) : [];
}

function imageAt(tasks: TurnTaskRecord[], reference: EvidenceRef | null) {
  if (!reference) return null;
  const [taskId, index] = reference.split(":");
  return (
    imagesOf(
      tasks.find((task) => task.id === taskId) ?? ({} as TurnTaskRecord),
    )[Number(index)] ?? null
  );
}

function findImage(
  tasks: TurnTaskRecord[],
  slideIndex: number,
  fromEnd: boolean,
) {
  const ordered = fromEnd ? [...tasks].reverse() : tasks;
  for (const task of ordered) {
    if (task.status !== "completed") continue;
    const images = imagesOf(task);
    const index = images.findIndex((image) => image?.slideIndex === slideIndex);
    if (index >= 0) return `${task.id}:${index}`;
  }
  return null;
}

function framingOf(
  tasks: TurnTaskRecord[],
  reference: EvidenceRef | null,
): "slide" | "window" {
  return imageAt(tasks, reference)?.source === "browser_canvas"
    ? "window"
    : "slide";
}

function issueCounts(issues: Json[]) {
  const counts = { overlap: 0, outOfBounds: 0, invalidSize: 0 };
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue?.code}:${issue?.slideIndex ?? ""}:${JSON.stringify(issue?.stableIds ?? issue?.elementIds ?? [])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (issue?.code === "possible_element_overlap") counts.overlap += 1;
    else if (issue?.code === "out_of_slide_bounds") counts.outOfBounds += 1;
    else if (issue?.code === "invalid_size") counts.invalidSize += 1;
  }
  return counts;
}

/* ── Summary ──────────────────────────────────────────────────────── */
function slideGroups(changes: TurnChange[]): TurnSlideGroup[] {
  const groups = new Map<number, Map<string, number>>();
  for (const change of changes) {
    const targets = groups.get(change.slideIndex) ?? new Map<string, number>();
    targets.set(change.target, (targets.get(change.target) ?? 0) + 1);
    groups.set(change.slideIndex, targets);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slideIndex, targets]) => ({
      slideIndex,
      count: [...targets.values()].reduce((total, count) => total + count, 0),
      targets: [...targets.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count),
    }));
}

function sharedDetail(changes: TurnChange[]) {
  if (changes.length < 2) return null;
  const first = changes[0]!.details.join(" · ");
  return first &&
    changes.every((change) => change.details.join(" · ") === first)
    ? first
    : null;
}

export function summarizeTurn(
  turn: TurnRecord,
  tasks: TurnTaskRecord[],
): TurnSummary {
  const mutations = tasks.filter(isMutation);
  const appliedMutations = mutations.filter(applied);
  // Measure from the first edit that took effect: an earlier edit that was
  // refused (for example because the person edited meanwhile) left the
  // document as the person made it, not as the AI first saw it.
  const firstApplied = tasks.findIndex(
    (task) => isMutation(task) && applied(task),
  );
  const firstMutation =
    firstApplied >= 0 ? firstApplied : tasks.findIndex(isMutation);
  const beforeTasks = firstMutation < 0 ? tasks : tasks.slice(0, firstMutation);
  const hasSlides = (task: TurnTaskRecord) =>
    task.status === "completed" && Array.isArray(task.result?.slides);
  const beforeState = [...beforeTasks].reverse().find(hasSlides);
  // The last applied edit's own result is the document as the AI left it; a
  // later observation could already include the person's own edits.
  const afterState =
    [...appliedMutations].reverse().find(hasSlides) ??
    [...tasks].reverse().find(hasSlides);
  const reportedSlides = [
    ...new Set(
      appliedMutations.flatMap(
        (task) =>
          (task.result?.changedSlideIndexes as unknown[] | undefined)?.filter(
            (value): value is number =>
              Number.isSafeInteger(value) && Number(value) >= 0,
          ) ?? [],
      ),
    ),
  ].sort((left, right) => left - right);
  const beforeSlides = beforeState?.result?.slides as Json[] | undefined;
  const afterSlides = afterState?.result?.slides as Json[] | undefined;
  let allChanges: TurnChange[] = [];
  let changedSlides = reportedSlides;
  let unchangedSlides: number | null = null;
  const documentChange = (slideIndex: number, detail: string): TurnChange => ({
    slideIndex,
    target: "문서",
    kind: "modified",
    details: [detail],
    box: null,
    elementId: null,
  });
  if (beforeSlides && afterSlides && appliedMutations.length) {
    const structure = structureChanges(appliedMutations);
    const mastersChanged =
      comparableMasters(beforeState?.result?.masters) !==
      comparableMasters(afterState?.result?.masters);
    if (structure.length || beforeSlides.length !== afterSlides.length) {
      // Slides were added, removed or moved: positions no longer name the
      // same slides, so report the structural change without guessing
      // per-element details.
      if (beforeSlides.length === afterSlides.length) {
        const differing = differingSlides(beforeSlides, afterSlides);
        unchangedSlides = mastersChanged
          ? null
          : beforeSlides.length - differing.length;
        if (differing.length) changedSlides = differing;
      }
      const details = [
        ...structure,
        ...(beforeSlides.length !== afterSlides.length
          ? [`슬라이드 ${beforeSlides.length}장 → ${afterSlides.length}장`]
          : []),
      ];
      if (changedSlides.length)
        allChanges = [documentChange(changedSlides[0]!, details.join(" · "))];
    } else {
      // Same slides in the same places: compare every slide, so the card can
      // say which slides changed and that the rest did not.
      const differing = differingSlides(beforeSlides, afterSlides);
      unchangedSlides = mastersChanged
        ? null
        : beforeSlides.length - differing.length;
      allChanges = diffSlides(
        beforeSlides,
        afterSlides,
        differing.length ? differing : reportedSlides,
      );
      if (allChanges.length)
        changedSlides = [
          ...new Set(allChanges.map((change) => change.slideIndex)),
        ].sort((left, right) => left - right);
      else if (reportedSlides.length)
        // The edit changed something outside slide content (master, theme).
        allChanges = [documentChange(reportedSlides[0]!, "문서 서식 바꿈")];
    }
  }
  const introduced = appliedMutations.flatMap((task) =>
    Array.isArray(task.result?.layoutAudit?.introducedIssues)
      ? (task.result!.layoutAudit.introducedIssues as Json[])
      : [],
  );
  const lastMutationIndex = tasks.map(isMutation).lastIndexOf(true);
  const afterTasks =
    lastMutationIndex < 0 ? [] : tasks.slice(lastMutationIndex);
  const evidence = changedSlides.map((slideIndex) => {
    const before =
      findImage(beforeTasks, slideIndex, true) ??
      findImage(beforeTasks, slideIndex, false);
    const after = findImage(afterTasks, slideIndex, true);
    const window = [before, after].some(
      (reference) => framingOf(tasks, reference) === "window",
    );
    return {
      slideIndex,
      before,
      after,
      framing: window ? ("window" as const) : ("slide" as const),
      ...(imageAt(tasks, after)?.stale === true ? { stale: true } : {}),
    };
  });
  const scopeRejected = tasks.some(
    (task) => task.status === "failed" && scopePattern.test(task.error ?? ""),
  );
  const changed = turn.changed || appliedMutations.length > 0;
  let outcome: TurnOutcome;
  if (turn.status === "queued" || turn.status === "running")
    outcome = "running";
  else if (turn.status === "cancelled") outcome = "cancelled";
  else if (turn.status === "failed") outcome = "failed";
  else if (changed) outcome = turn.reviewed ? "changed" : "unverified";
  else if (turn.permissionMode === "read_only" || mutations.length === 0)
    outcome = "answered";
  else outcome = "unchanged";
  const failure =
    outcome === "failed" || outcome === "cancelled"
      ? nativeFailureReason(turn.lastError)
      : null;
  const undoSteps = appliedMutations.reduce((total, task) => {
    // A single edit records exactly one undo action (the editor refuses it
    // otherwise); transactions and asset edits report their own count.
    const added = task.result?.transaction?.undoActionsAdded;
    return (
      total + (Number.isSafeInteger(added) && added >= 0 ? Number(added) : 1)
    );
  }, 0);
  return {
    version: 1,
    outcome,
    changedSlides,
    slideCount: {
      before: Array.isArray(beforeState?.result?.slides)
        ? beforeState!.result!.slides.length
        : null,
      after: Array.isArray(afterState?.result?.slides)
        ? afterState!.result!.slides.length
        : null,
    },
    changes: allChanges.slice(0, MAX_CHANGES),
    omittedChanges: Math.max(0, allChanges.length - MAX_CHANGES),
    reviewed: turn.reviewed,
    introducedIssues: appliedMutations.length ? issueCounts(introduced) : null,
    scopeEnforced: appliedMutations.length > 0,
    scopeRejected,
    evidence,
    failure,
    unchangedSlides,
    undoSteps,
    revisions: {
      before:
        typeof beforeState?.result?.revision === "string"
          ? beforeState.result.revision
          : null,
      after:
        typeof afterState?.result?.revision === "string"
          ? afterState.result.revision
          : null,
    },
    slideGroups: slideGroups(allChanges),
    sharedDetail: sharedDetail(allChanges),
  };
}

/* ── DB loader ────────────────────────────────────────────────────── */
type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<any[]>;

export async function loadTurnSummary(
  sql: Sql,
  turnId: string,
): Promise<TurnSummary | null> {
  const [turn] = await sql`
    select status, permission_mode, changed, reviewed, last_error
    from spellbook_native_turns where id=${turnId}
  `;
  if (!turn) return null;
  const tasks = await sql`
    select id, request, status, result, error from spellbook_native_tasks
    where turn_id=${turnId} order by created_at, id
  `;
  return summarizeTurn(
    {
      status: turn.status,
      permissionMode: turn.permission_mode,
      changed: turn.changed,
      reviewed: turn.reviewed,
      lastError: turn.last_error,
    },
    tasks as TurnTaskRecord[],
  );
}
