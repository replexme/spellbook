"use client";

import type { TurnSummary } from "@/lib/native-turn-summary";
import { ResultCard, type CardTurn } from "./workspace/result-card";

const summary: TurnSummary = {
  version: 1,
  outcome: "changed",
  changedSlides: [2],
  slideCount: { before: 12, after: 12 },
  changes: [
    {
      slideIndex: 2,
      target: "제목",
      kind: "modified",
      details: ["굵게", "글자 크기 28 → 36"],
      box: { x: 0.07, y: 0.12, width: 0.46, height: 0.16 },
    },
  ],
  omittedChanges: 0,
  reviewed: true,
  introducedIssues: { overlap: 0, outOfBounds: 0, invalidSize: 0 },
  scopeEnforced: true,
  scopeRejected: false,
  evidence: [],
  failure: null,
  unchangedSlides: 11,
  undoSteps: 1,
  revisions: { before: "sample-before", after: "sample-after" },
};

const turn: CardTurn = {
  key: "sample",
  turnId: null,
  requestText: "제목을 더 눈에 띄게 해 줘",
  permission: "slides",
  status: "done",
  text: "",
  tools: [],
  summary,
  changed: true,
  reviewed: true,
  startedAt: null,
  finishedAt: null,
  beforeVersionId: "sample",
};

const noop = () => undefined;

/**
 * The sign-in illustration: a slide and the real result card component with
 * sample data, so the picture always matches the product.
 */
export function SignInScene() {
  return (
    <div className="signin-scene" inert>
      <div className="signin-slide">
        <span className="signin-slide-title">
          하반기 시장 현황
          <i>제목 · 굵게, 글자 크기</i>
        </span>
        <ul>
          <li>국내 시장 규모 4.2조 원</li>
          <li>상위 3사 점유율 61%</li>
          <li>중소 고객 비중 확대</li>
        </ul>
        <span className="signin-slide-bars">
          <i style={{ height: "38%" }} />
          <i style={{ height: "52%" }} />
          <i style={{ height: "60%" }} />
          <i style={{ height: "74%" }} />
          <i style={{ height: "92%" }} />
        </span>
      </div>
      <ResultCard
        turn={turn}
        pairs={[]}
        undo={{ kind: "native", label: "되돌리기" }}
        onUndo={noop}
        onCompare={noop}
        onRetry={noop}
      />
    </div>
  );
}
