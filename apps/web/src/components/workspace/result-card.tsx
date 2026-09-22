"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Banner,
  Button,
  ButtonLink,
  CheckList,
  Icon,
  SlideImage,
  StepList,
  type CheckItem,
  type SlideMark,
} from "@/design-system";
import { normalizeQuotedStrongMarkdown } from "@/lib/markdown";
import type { TurnSummary } from "@/lib/native-turn-summary";
import {
  elapsed,
  scopeTitle,
  slideList,
  subjectParticle,
  when,
  widerScope,
  type PermissionMode,
} from "../copy";
import { runningStages } from "./running-stages";
import type { UndoAction } from "./turn-timeline";

export type CardTurn = {
  key: string;
  turnId: string | null;
  requestText: string;
  permission: string;
  status: "running" | "done" | "error";
  text: string;
  tools: string[];
  summary: TurnSummary | null;
  changed?: boolean;
  reviewed?: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string | null;
  beforeVersionId?: string | null;
  /** When the request was undone in the editor. */
  undoneAt?: string | null;
};

/**
 * Before/after images of one changed slide. `ai`: what the AI looked at
 * during this session; `saved`: server previews of the saved versions
 * (after a reload, because the AI's own screenshots are not kept).
 */
export type EvidencePair = {
  slideIndex: number;
  before: string | null;
  after: string | null;
  source: "ai" | "saved";
  framing: "slide" | "window";
  stale?: boolean;
};

export type Outcome = TurnSummary["outcome"];

export function outcomeOf(turn: CardTurn): Outcome {
  if (turn.status === "running") return "running";
  if (turn.summary) return turn.summary.outcome;
  if (turn.status === "error") return "failed";
  if (turn.changed) return turn.reviewed ? "changed" : "unverified";
  return "answered";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <Button
      size="sm"
      variant="quiet"
      icon={copied ? "check" : "copy"}
      onClick={handleCopy}
    >
      {copied ? "복사됨" : "복사"}
    </Button>
  );
}

function Answer({
  text,
  allowCopy = false,
}: {
  text: string;
  allowCopy?: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <div className="msg-answer">
      <ReactMarkdown>{normalizeQuotedStrongMarkdown(text)}</ReactMarkdown>
      {allowCopy ? (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: "var(--ds-space-1)",
          }}
        >
          <CopyButton text={text} />
        </div>
      ) : null}
    </div>
  );
}

/** Outlines of changed elements; none on a whole-window capture, where they would misplace. */
export function marksFor(
  summary: TurnSummary | null,
  slideIndex: number,
  framing: EvidencePair["framing"] = "slide",
): SlideMark[] {
  if (framing === "window") return [];
  return (summary?.changes ?? [])
    .filter(
      (change) =>
        change.slideIndex === slideIndex &&
        change.box &&
        change.kind !== "removed",
    )
    .map((change) => ({ ...change.box!, label: change.target }));
}

/** Every check line a result card may show, each backed by an editor record. */
export function checksFor(summary: TurnSummary, outcome: Outcome): CheckItem[] {
  const items: CheckItem[] = [];
  if (outcome === "changed")
    items.push({
      tone: "ok",
      label: "바뀐 화면을 AI가 다시 보고 검토함",
      evidence: "turn.reviewed",
    });
  else if (outcome === "unverified")
    items.push({
      tone: "warn",
      label: "바뀐 화면을 AI가 다시 확인하지 못함",
      evidence: "turn.reviewed=false",
    });
  const issues = summary.introducedIssues;
  if (issues) {
    items.push(
      issues.overlap
        ? {
            tone: "warn",
            label: `새로 생긴 겹침 ${issues.overlap}곳`,
            evidence:
              "edit.layoutAudit.introducedIssues possible_element_overlap",
          }
        : {
            tone: "ok",
            label: "새로 생긴 겹침 없음",
            evidence:
              "edit.layoutAudit.introducedIssues possible_element_overlap",
          },
    );
    items.push(
      issues.outOfBounds
        ? {
            tone: "warn",
            label: `슬라이드 밖으로 나간 요소 ${issues.outOfBounds}개`,
            evidence: "edit.layoutAudit.introducedIssues out_of_slide_bounds",
          }
        : {
            tone: "ok",
            label: "슬라이드 밖으로 나간 요소 없음",
            evidence: "edit.layoutAudit.introducedIssues out_of_slide_bounds",
          },
    );
    if (issues.invalidSize)
      items.push({
        tone: "warn",
        label: `크기가 잘못된 요소 ${issues.invalidSize}개`,
        evidence: "edit.layoutAudit.introducedIssues invalid_size",
      });
  }
  const total = summary.slideCount.after;
  const changed = summary.changedSlides.length;
  if (
    typeof summary.unchangedSlides === "number" &&
    total &&
    changed &&
    summary.unchangedSlides > 0 &&
    summary.unchangedSlides === total - changed
  )
    items.push({
      tone: "ok",
      label:
        changed === 1
          ? "다른 슬라이드는 바뀌지 않음"
          : `나머지 ${summary.unchangedSlides}장은 바뀌지 않음`,
      evidence: "editor before/after states compared slide by slide",
    });
  return items;
}

function CardHead({
  tone,
  icon,
  title,
  time,
}: {
  tone: string;
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  time: string | null;
}) {
  return (
    <header className="rc-head" data-tone={tone}>
      <Icon name={icon} size={14} />
      <span>{title}</span>
      {time ? <time>{when(time)}</time> : null}
    </header>
  );
}

function afterCaption(pair: EvidencePair, outcome: Outcome) {
  return [
    "후",
    pair.source === "saved"
      ? "저장본 미리보기"
      : outcome === "changed"
        ? "AI가 다시 본 화면"
        : "AI가 본 화면",
    pair.framing === "window" ? "편집기 창 전체" : "",
    pair.stale ? "바뀌기 전 화면일 수 있음" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One changed slide, before and after. `fresh` plays the change once. */
function BeforeAfter({
  pair,
  summary,
  outcome,
  fresh,
}: {
  pair: EvidencePair;
  summary: TurnSummary | null;
  outcome: Outcome;
  fresh: boolean;
}) {
  // Shows the before image in the after slot, then the after image, once;
  // skipped when the person asked the system for less motion.
  const [stage, setStage] = useState<"still" | "playing" | "revealed">(() =>
    fresh &&
    typeof window !== "undefined" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "playing"
      : "still",
  );
  useEffect(() => {
    if (stage !== "playing") return;
    const timer = setTimeout(() => setStage("revealed"), 700);
    return () => clearTimeout(timer);
  }, [stage]);
  const playing = stage === "playing" && Boolean(pair.before && pair.after);
  return (
    <div className="rc-ba">
      <figure>
        <SlideImage
          src={pair.before}
          alt={`${pair.slideIndex + 1}번 슬라이드 수정 전`}
        />
        <figcaption>
          {pair.source === "saved" ? "전 · 저장본 미리보기" : "전"}
        </figcaption>
      </figure>
      <Icon name="arrowRight" size={14} />
      <figure
        className={`rc-ba-after ${stage === "revealed" ? "is-revealed" : ""}`}
        data-playing={playing || undefined}
      >
        <SlideImage
          src={playing ? pair.before : pair.after}
          alt={`${pair.slideIndex + 1}번 슬라이드 수정 후`}
          marks={
            playing ? [] : marksFor(summary, pair.slideIndex, pair.framing)
          }
        />
        <figcaption>{afterCaption(pair, outcome)}</figcaption>
      </figure>
    </div>
  );
}

function ChangeList({
  summary,
  multi,
}: {
  summary: TurnSummary;
  multi: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const changes = summary.changes;
  const groups = summary.slideGroups ?? [];
  const total = groups.length
    ? groups.reduce((sum, group) => sum + group.count, 0)
    : changes.length + summary.omittedChanges;
  if (!changes.length) return null;
  const detailed = (
    <ul className="rc-changes">
      {changes.map((change, index) => (
        <li key={index}>
          <strong>
            {multi ? `${change.slideIndex + 1}번 · ` : ""}
            {change.target}
          </strong>
          <span>{change.details.join(" · ")}</span>
        </li>
      ))}
      {summary.omittedChanges ? (
        <li className="rc-more-count">외 {summary.omittedChanges}곳</li>
      ) : null}
    </ul>
  );
  if (!multi || !groups.length)
    return (
      <div className="rc-section">
        <h4>바꾼 것 {total}곳</h4>
        {detailed}
      </div>
    );
  return (
    <div className="rc-section">
      <h4>바꾼 것 {total}곳</h4>
      {summary.sharedDetail ? (
        <p className="rc-quote">모두 {summary.sharedDetail}</p>
      ) : null}
      {expanded ? (
        detailed
      ) : (
        <ul className="rc-groups">
          {groups.map((group) => (
            <li key={group.slideIndex}>
              <strong>{group.slideIndex + 1}번</strong>
              <span>
                {group.count}곳 ·{" "}
                {group.targets
                  .map((target) =>
                    target.count > 1
                      ? `${target.label} ${target.count}`
                      : target.label,
                  )
                  .join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        variant="quiet"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "슬라이드별로 보기" : "하나씩 보기"}
      </Button>
    </div>
  );
}

/** The one place an AI request's result is shown. */
export function ResultCard({
  turn,
  pairs,
  undo,
  onUndo,
  undoBusy,
  onCompare,
  onRetry,
  onReveal,
  fresh = false,
}: {
  turn: CardTurn;
  /** Before/after images for the changed slides, resolved by the caller. */
  pairs: EvidencePair[];
  undo: UndoAction | null;
  onUndo: (turn: CardTurn, action: UndoAction) => void;
  undoBusy?: boolean;
  /** Absent where no compare view exists (the opening screen). */
  onCompare?: (turn: CardTurn) => void;
  onRetry: (text: string, scope?: PermissionMode) => void;
  /** Select the changed element in the editor; absent when the editor is not shown. */
  onReveal?: (slideIndex: number, elementId: string | null) => void;
  /** Just finished in this session: show the before→after change once. */
  fresh?: boolean;
}) {
  const outcome = outcomeOf(turn);
  const summary = turn.summary;
  const time = turn.finishedAt ?? turn.startedAt;

  if (outcome === "answered")
    return (
      <div className="rc-answered">
        <Answer text={turn.text} allowCopy />
        <p className="rc-note">
          <Icon name="dash" size={13} /> 문서는 바뀌지 않았어요
        </p>
      </div>
    );

  const wider = summary?.scopeRejected ? widerScope(turn.permission) : null;
  const widenButton = wider ? (
    <Button
      size="sm"
      variant="primary"
      onClick={() => onRetry(turn.requestText, wider)}
    >
      ‘{scopeTitle(wider)}’로 넓혀 다시 요청
    </Button>
  ) : null;

  if (outcome === "failed" || outcome === "cancelled") {
    const message =
      summary?.failure?.message ??
      turn.error ??
      "AI가 요청을 끝내지 못했어요. 다시 요청해 주세요.";
    const failureCode = summary?.failure?.code;
    const isRateLimit =
      failureCode === "usage_limit" ||
      failureCode === "quota_exhausted" ||
      /한도|rate[ _-]?limit|quota|out of codex messages/i.test(message);
    const isAuthError =
      failureCode === "api_key_invalid" || failureCode === "ai_not_connected";
    const title =
      outcome === "cancelled"
        ? "요청 중단됨"
        : isRateLimit
          ? "AI 사용량 한도 도달"
          : isAuthError
            ? "AI 인증 실패"
            : failureCode === "model_unavailable"
              ? "AI 모델 사용 불가"
              : failureCode === "timeout"
                ? "AI 응답 시간 초과"
                : "AI 요청 실패";
    return (
      <article
        className={`rc ${outcome === "failed" ? "is-failed" : "is-cancelled"}`}
      >
        <CardHead
          tone={isRateLimit ? "warn" : outcome}
          icon={outcome === "failed" ? "close" : "stop"}
          title={title}
          time={time}
        />
        <div className="rc-section">
          <Banner
            tone={
              isRateLimit
                ? "warn"
                : outcome === "failed"
                  ? "danger"
                  : "neutral"
            }
          >
            {message}
          </Banner>
          {summary?.failure?.detail && summary.failure.detail !== message ? (
            <details
              style={{
                marginTop: "0.5rem",
                fontSize: "12px",
                opacity: 0.85,
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                상세 에러 내용 (Technical Details)
              </summary>
              <pre
                style={{
                  margin: "0.25rem 0",
                  padding: "0.5rem",
                  borderRadius: "4px",
                  fontSize: "11px",
                  background: "var(--bg-subtle)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {summary.failure.detail}
              </pre>
            </details>
          ) : null}
          {isRateLimit || isAuthError ? (
            <div style={{ marginTop: "0.5rem" }}>
              <ButtonLink size="sm" variant="primary" href="/settings#ai">
                설정에서 API 키 등록 또는 공급자 전환
              </ButtonLink>
            </div>
          ) : null}
          {summary?.scopeRejected ? (
            <p className="rc-quote">
              지금 범위는 ‘{scopeTitle(turn.permission)}’예요. 범위 밖의 요소가
              필요하면 범위를 넓혀 다시 요청해 주세요.
            </p>
          ) : null}
          {summary?.changedSlides.length ? (
            <p className="rc-quote">
              중단 전에 {slideList(summary.changedSlides)}
              {subjectParticle(slideList(summary.changedSlides))} 바뀌었어요.
              버전 기록에서 확인할 수 있어요.
            </p>
          ) : null}
        </div>
        <footer className="rc-foot">
          {widenButton}
          <Button
            size="sm"
            icon="refresh"
            onClick={() => onRetry(turn.requestText)}
          >
            {wider ? "요청 고치기" : "다시 요청"}
          </Button>
        </footer>
      </article>
    );
  }

  if (outcome === "unchanged") {
    if (summary?.scopeRejected)
      return (
        <article className="rc is-failed">
          <CardHead
            tone="failed"
            icon="close"
            title="고치지 못함"
            time={time}
          />
          <div className="rc-section">
            <Banner tone="danger">
              이 요청에는 범위 밖의 요소가 필요해요.
            </Banner>
            <p className="rc-quote">
              지금 범위는 ‘{scopeTitle(turn.permission)}’예요.
              {wider
                ? ` ‘${scopeTitle(wider)}’로 넓히면 고칠 수 있어요.`
                : ""}{" "}
              이번 요청으로 바뀐 것은 없어요.
            </p>
            {turn.text.trim() ? (
              <details className="rc-more">
                <summary>AI의 답 보기</summary>
                <Answer text={turn.text} />
              </details>
            ) : null}
          </div>
          <footer className="rc-foot">
            {widenButton}
            <Button
              size="sm"
              icon="edit"
              onClick={() => onRetry(turn.requestText)}
            >
              요청 고치기
            </Button>
          </footer>
        </article>
      );
    return (
      <article className="rc is-unchanged">
        <CardHead
          tone="unchanged"
          icon="dash"
          title="바뀐 것 없음"
          time={time}
        />
        <div className="rc-section">
          <Banner>편집기 기록으로는 문서가 바뀌지 않았어요.</Banner>
          {turn.text.trim() ? (
            <details className="rc-more">
              <summary>AI의 답 보기</summary>
              <Answer text={turn.text} />
            </details>
          ) : null}
        </div>
        <footer className="rc-foot">
          <Button
            size="sm"
            icon="refresh"
            onClick={() => onRetry(turn.requestText)}
          >
            다시 요청
          </Button>
          {widerScope(turn.permission) ? (
            <Button
              size="sm"
              variant="quiet"
              onClick={() =>
                onRetry(turn.requestText, widerScope(turn.permission)!)
              }
            >
              범위 바꾸기
            </Button>
          ) : null}
        </footer>
      </article>
    );
  }

  // changed / unverified
  const changedSlides = summary?.changedSlides ?? [];
  const multi = changedSlides.length > 1;
  const single = !multi && pairs.length === 1 ? pairs[0]! : null;
  const checks = summary ? checksFor(summary, outcome) : [];
  const firstChange =
    summary?.changes.find((change) => change.elementId) ?? summary?.changes[0];
  const title =
    outcome === "unverified"
      ? "바뀜 · 확인 못 함"
      : `바뀜${changedSlides.length ? ` · ${slideList(changedSlides)}` : ""}`;
  return (
    <article
      className={`rc ${outcome === "unverified" ? "is-unverified" : "is-changed"} ${turn.undoneAt ? "is-undone" : ""}`}
    >
      <CardHead
        tone={outcome}
        icon={outcome === "unverified" ? "warning" : "sparkles"}
        title={title}
        time={time}
      />
      {turn.undoneAt ? (
        <div className="rc-section">
          <Banner icon="restore">
            {when(turn.undoneAt)}에 되돌렸어요. 버전 기록에 남아 있어요.
          </Banner>
        </div>
      ) : null}
      {outcome === "unverified" ? (
        <div className="rc-section">
          <Banner tone="warn">
            AI가 바뀐 화면을 다시 보지 못했어요. 직접 확인해 주세요.
          </Banner>
        </div>
      ) : null}
      {single && (single.before || single.after) ? (
        <div className="rc-section">
          <BeforeAfter
            pair={single}
            summary={summary}
            outcome={outcome}
            fresh={fresh}
          />
        </div>
      ) : pairs.length > 1 ? (
        <div className="rc-section">
          <ul className="rc-slides">
            {pairs.slice(0, 5).map((item) => {
              const count =
                summary?.slideGroups?.find(
                  (group) => group.slideIndex === item.slideIndex,
                )?.count ??
                summary?.changes.filter(
                  (change) => change.slideIndex === item.slideIndex,
                ).length ??
                0;
              return (
                <li key={item.slideIndex}>
                  <SlideImage
                    src={item.after}
                    alt={`${item.slideIndex + 1}번 슬라이드 수정 후`}
                  />
                  <span>
                    <strong>{item.slideIndex + 1}번</strong>
                    {count ? ` · ${count}곳` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {summary ? <ChangeList summary={summary} multi={multi} /> : null}
      {checks.length ? (
        <div className="rc-section">
          <h4>확인한 것</h4>
          <CheckList items={checks} />
        </div>
      ) : null}
      {turn.text.trim() ? (
        <div className="rc-section">
          <details className="rc-more">
            <summary>AI의 설명</summary>
            <Answer text={turn.text} />
          </details>
        </div>
      ) : null}
      <footer className="rc-foot">
        {undo ? (
          <Button
            size="sm"
            icon="restore"
            loading={undoBusy}
            disabled={undoBusy}
            onClick={() => onUndo(turn, undo)}
          >
            {undo.label}
          </Button>
        ) : null}
        {onCompare && pairs.length && turn.turnId ? (
          <Button
            size="sm"
            variant="quiet"
            icon="compare"
            onClick={() => onCompare(turn)}
          >
            비교
          </Button>
        ) : null}
        {onReveal && !multi && firstChange && !turn.undoneAt ? (
          <Button
            size="sm"
            variant="quiet"
            icon="eye"
            onClick={() =>
              onReveal(firstChange.slideIndex, firstChange.elementId ?? null)
            }
          >
            슬라이드에서 보기
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

/** Work in progress: what the AI is looking at and which stage it is on. */
export function RunningCard({
  turn,
  lookingAt,
  onStop,
}: {
  turn: CardTurn;
  lookingAt: { slideIndex: number; url: string } | null;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [activityExpanded, setActivityExpanded] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = turn.startedAt ? new Date(turn.startedAt).getTime() : now;
  const stages = runningStages(
    turn.tools,
    turn.permission === "read_only",
    Boolean(turn.text.trim()),
  );
  const latestTool =
    turn.tools.length > 0 ? turn.tools[turn.tools.length - 1] : null;

  return (
    <section className="run" aria-live="polite" aria-label="AI 작업 중">
      <header className="run-head">
        <span className="ds-spinner is-ai" aria-hidden="true" />
        <span>작업 중</span>
        <span className="ds-tabular">{elapsed(started, now)}</span>
      </header>

      {latestTool ? (
        <div className="run-active-action">
          <span className="run-pulse-dot" aria-hidden="true" />
          <span className="run-active-text">{latestTool}</span>
        </div>
      ) : null}

      {lookingAt ? (
        <figure className="run-look">
          <SlideImage
            src={lookingAt.url}
            alt={`AI가 보고 있는 ${lookingAt.slideIndex + 1}번 슬라이드`}
            loading="eager"
          />
          <figcaption>
            <strong>AI가 보고 있는 화면</strong>
            {lookingAt.slideIndex + 1}번 슬라이드
          </figcaption>
        </figure>
      ) : null}

      <StepList
        steps={stages.map((stage) => ({
          label: stage.detail
            ? `${stage.label} · ${stage.detail}`
            : stage.label,
          state: stage.state,
        }))}
        label="진행 단계"
      />

      {turn.tools.length > 1 ? (
        <div className="run-history-toggle">
          <Button
            size="sm"
            variant="quiet"
            icon={activityExpanded ? "chevronUp" : "chevronDown"}
            onClick={() => setActivityExpanded((v) => !v)}
          >
            실행 세부 기록 ({turn.tools.length}단계)
          </Button>
          {activityExpanded ? (
            <ul className="run-activity-stream">
              {turn.tools.map((item, idx) => (
                <li key={idx} className="run-activity-step">
                  <span className="run-step-bullet">✓</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {turn.text.trim() ? (
        <div className="run-streaming-answer">
          <Answer text={turn.text} />
          <span className="run-cursor" aria-hidden="true">
            ▊
          </span>
        </div>
      ) : null}

      <p className="run-hint">
        작업 중에 문서를 직접 고치면 AI가 바뀐 문서를 다시 확인해야 해서
        늦어지거나 멈출 수 있어요.
      </p>
      <div>
        <Button size="sm" icon="stop" onClick={onStop}>
          멈추기
        </Button>
      </div>
    </section>
  );
}
