"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Brand,
  Button,
  CheckList,
  Chip,
  EmptyState,
  IconButton,
  Progress,
  Segmented,
  SlideImage,
  Spinner,
  StepList,
  Tabs,
  TextField,
} from "@/design-system";
import type { TurnSummary } from "@/lib/native-turn-summary";
import { ScopeMenu } from "./workspace/composer";
import { ConversationLog } from "./workspace/conversation-log";
import { OpeningView } from "./workspace/opening";
import { PhoneSlides } from "./workspace/phone-slides";
import type { EditorSelection } from "./workspace/request-scope";
import {
  ResultCard,
  RunningCard,
  type CardTurn,
  type EvidencePair,
} from "./workspace/result-card";
import type { UndoAction } from "./workspace/turn-timeline";

/* Sample data only. Nothing here reads a document or an account. */

const roles = [
  ["--ds-bg-app", "앱 바탕"],
  ["--ds-bg-surface", "면"],
  ["--ds-bg-sunken", "캔버스"],
  ["--ds-text", "글자"],
  ["--ds-text-secondary", "보조 글자"],
  ["--ds-border", "선"],
  ["--ds-action", "주 동작"],
  ["--ds-ai", "AI가 한 일"],
  ["--ds-ai-soft", "AI 바탕"],
  ["--ds-ok", "확인됨"],
  ["--ds-warn", "주의"],
  ["--ds-danger", "실패·위험"],
  ["--ds-focus", "키보드 초점"],
] as const;

const sizes = ["2xl", "xl", "lg", "base", "md", "sm", "xs"] as const;

/** Draws a sample slide from the token colours, so no colour is hard-coded. */
function useSampleSlide(variant: "before" | "after") {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (!context) return;
    const token = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    context.fillStyle = token("--ds-bg-surface");
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = token("--ds-text");
    context.font = `${variant === "after" ? "700 34px" : "500 26px"} sans-serif`;
    context.fillText("하반기 시장 현황", 48, 86);
    context.fillStyle = token("--ds-text-secondary");
    context.font = "400 17px sans-serif";
    [
      "국내 시장 규모 4.2조 원",
      "상위 3사 점유율 61%",
      "중소 고객 비중 확대",
    ].forEach((line, index) =>
      context.fillText(`•  ${line}`, 52, 160 + index * 36),
    );
    context.fillStyle = token("--ds-border-strong");
    [0.38, 0.52, 0.6, 0.74, 0.92].forEach((height, index) =>
      context.fillRect(380 + index * 46, 300 - 190 * height, 30, 190 * height),
    );
    setUrl(canvas.toDataURL("image/png"));
  }, [variant]);
  return url;
}

const baseSummary: TurnSummary = {
  version: 1,
  outcome: "changed",
  changedSlides: [2],
  slideCount: { before: 12, after: 12 },
  changes: [
    {
      slideIndex: 2,
      target: "제목",
      kind: "modified",
      details: ["굵게", "글자 크기 26 → 34"],
      box: { x: 0.065, y: 0.14, width: 0.47, height: 0.15 },
    },
    {
      slideIndex: 2,
      target: "본문 3줄",
      kind: "modified",
      details: ["줄 간격 1.0 → 1.2"],
      box: { x: 0.07, y: 0.38, width: 0.42, height: 0.3 },
    },
  ],
  omittedChanges: 0,
  reviewed: true,
  introducedIssues: { overlap: 0, outOfBounds: 0, invalidSize: 0 },
  scopeEnforced: true,
  scopeRejected: false,
  evidence: [{ slideIndex: 2, before: "before", after: "after" }],
  failure: null,
  unchangedSlides: 11,
  undoSteps: 1,
  revisions: { before: "sample-before", after: "sample-after" },
  slideGroups: [
    {
      slideIndex: 2,
      count: 2,
      targets: [
        { label: "제목", count: 1 },
        { label: "본문 3줄", count: 1 },
      ],
    },
  ],
  sharedDetail: null,
};

const multiSummary: TurnSummary = {
  ...baseSummary,
  changedSlides: [0, 2, 3, 4],
  changes: [
    {
      slideIndex: 0,
      target: "부제목",
      kind: "modified",
      details: ["문구 “2026.9.18” → “2026년 9월 18일”"],
      box: null,
    },
    {
      slideIndex: 2,
      target: "바닥글",
      kind: "modified",
      details: ["문구 “2026.9.18” → “2026년 9월 18일”"],
      box: null,
    },
    {
      slideIndex: 3,
      target: "바닥글",
      kind: "modified",
      details: ["문구 “2026.9.18” → “2026년 9월 18일”"],
      box: null,
    },
    {
      slideIndex: 4,
      target: "텍스트 상자",
      kind: "modified",
      details: ["문구 “9.18” → “9월 18일”"],
      box: null,
    },
  ],
  unchangedSlides: 8,
  undoSteps: 1,
  evidence: [0, 2, 3, 4].map((slideIndex) => ({
    slideIndex,
    before: "before",
    after: "after",
  })),
  slideGroups: [
    { slideIndex: 0, count: 1, targets: [{ label: "부제목", count: 1 }] },
    { slideIndex: 2, count: 1, targets: [{ label: "바닥글", count: 1 }] },
    { slideIndex: 3, count: 1, targets: [{ label: "바닥글", count: 1 }] },
    {
      slideIndex: 4,
      count: 4,
      targets: [
        { label: "텍스트 상자", count: 3 },
        { label: "바닥글", count: 1 },
      ],
    },
  ],
  sharedDetail: null,
};

function turn(
  overrides: Partial<CardTurn>,
  summary: Partial<TurnSummary> | null = {},
): CardTurn {
  return {
    key: "sample",
    turnId: "sample",
    requestText: "3번 슬라이드 제목을 더 눈에 띄게 해 줘",
    permission: "slides",
    status: "done",
    text: "제목을 굵게 하고 크기를 키웠어요. 본문 줄 간격도 맞췄어요.",
    tools: [],
    summary: summary === null ? null : { ...baseSummary, ...summary },
    changed: true,
    reviewed: true,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    beforeVersionId: "sample",
    ...overrides,
  };
}

const noop = () => undefined;

const sampleTime = (hour: number, minute: number) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

const sampleSelection: EditorSelection = {
  activeSlide: 2,
  slideCount: 12,
  selected: [
    {
      elementId: "2/0",
      name: "Title 1",
      kind: "com.sun.star.presentation.TitleTextShape",
      text: "하반기 시장 현황",
    },
  ],
  editableOperations: ["replace_text"],
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="gallery-section" aria-labelledby={`gallery-${title}`}>
      <h2 id={`gallery-${title}`}>{title}</h2>
      {children}
    </section>
  );
}

export function DesignGallery() {
  const before = useSampleSlide("before");
  const after = useSampleSlide("after");
  const [segment, setSegment] = useState<"side" | "overlay">("side");
  const [tab, setTab] = useState<"ai" | "versions">("ai");
  const pairsOf = (
    sample: CardTurn,
    source: EvidencePair["source"] = "ai",
  ): EvidencePair[] =>
    (sample.summary?.evidence ?? []).map((item) => ({
      slideIndex: item.slideIndex,
      before,
      after,
      source,
      framing: "slide",
    }));
  const undo: UndoAction = { kind: "native", label: "되돌리기" };
  const cards: Array<
    [
      string,
      CardTurn,
      { source?: EvidencePair["source"]; undo?: UndoAction | null }?,
    ]
  > = [
    ["바뀜 · AI가 다시 보고 검토함", turn({})],
    [
      "바뀜 · 여러 슬라이드",
      turn(
        {
          requestText: "모든 날짜를 ‘2026년 9월 18일’ 형식으로 바꿔 줘",
          permission: "document",
        },
        multiSummary,
      ),
      { undo: { kind: "native", label: "모두 되돌리기" } },
    ],
    [
      "바뀜 · 다시 확인하지 못함",
      turn(
        { reviewed: false },
        {
          outcome: "unverified",
          reviewed: false,
          introducedIssues: { overlap: 1, outOfBounds: 0, invalidSize: 0 },
        },
      ),
      { undo: { kind: "restore", label: "이 요청 전으로 돌아가기" } },
    ],
    [
      "새로고침 뒤 · 저장본 미리보기",
      turn({}),
      {
        source: "saved",
        undo: { kind: "restore", label: "이 요청 전으로 돌아가기" },
      },
    ],
    ["되돌림", turn({ undoneAt: new Date().toISOString() }), { undo: null }],
    [
      "고치지 못함 · 범위 밖",
      turn(
        { changed: false, permission: "selection" },
        {
          outcome: "unchanged",
          changes: [],
          changedSlides: [],
          evidence: [],
          scopeRejected: true,
        },
      ),
    ],
    [
      "바뀐 것 없음",
      turn(
        { changed: false, permission: "slides" },
        { outcome: "unchanged", changes: [], changedSlides: [], evidence: [] },
      ),
    ],
    [
      "답만 함",
      turn(
        {
          changed: false,
          text: "3번 슬라이드는 제목 1개, 본문 3줄, 막대그래프 1개로 되어 있어요.",
        },
        { outcome: "answered", changes: [], evidence: [] },
      ),
    ],
    [
      "고치지 못함",
      turn(
        { status: "error", changed: false },
        {
          outcome: "failed",
          changes: [],
          evidence: [],
          failure: {
            code: "usage_limit",
            message: "구독 사용 한도에 닿았어요. 잠시 뒤 다시 요청해 주세요.",
          },
        },
      ),
    ],
    [
      "중단됨",
      turn(
        { status: "error", changed: false },
        {
          outcome: "cancelled",
          changes: [],
          evidence: [],
          changedSlides: [],
          failure: { code: "cancelled", message: "작업을 중단했어요." },
        },
      ),
    ],
  ];
  return (
    <main className="app-main gallery">
      <header className="gallery-head">
        <Brand />
        <h1>디자인 시스템</h1>
        <p>
          토큰 → 부품 → 패턴 → 화면. 모든 화면은 여기 있는 것만으로 만듭니다.
          예시 데이터만 씁니다.
        </p>
      </header>

      <Section title="색 역할">
        <ul className="gallery-swatches">
          {roles.map(([name, label]) => (
            <li key={name}>
              <span style={{ background: `var(${name})` }} />
              <strong>{label}</strong>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p className="dialog-note">
          청록(AI가 한 일)은 AI의 결과와 AI로 보내는 동작에만 씁니다.
        </p>
      </Section>

      <Section title="글자">
        <div className="gallery-stack">
          {sizes.map((size) => (
            <p
              key={size}
              style={{ margin: 0, fontSize: `var(--ds-text-${size})` }}
            >
              {size} · 요청 하나에 카드 한 장
            </p>
          ))}
        </div>
      </Section>

      <Section title="버튼">
        <div className="gallery-row">
          <Button variant="primary">주 동작</Button>
          <Button variant="ai" icon="sparkles">
            AI로 보내기
          </Button>
          <Button variant="ai-soft">AI 부드럽게</Button>
          <Button>보조</Button>
          <Button variant="quiet">조용히</Button>
          <Button variant="danger" icon="trash">
            지우기
          </Button>
          <Button variant="danger-quiet">연결 해제</Button>
          <Button loading>저장 중</Button>
          <Button disabled>쓸 수 없음</Button>
        </div>
        <div className="gallery-row">
          <Button size="sm">작게</Button>
          <Button size="lg">크게</Button>
          <IconButton icon="undo" label="실행 취소" />
          <IconButton icon="arrowUp" label="요청 보내기" tone="ai" />
          <IconButton icon="stop" label="멈추기" tone="primary" />
          <IconButton icon="close" label="닫기" size="sm" />
        </div>
      </Section>

      <Section title="선택">
        <div className="gallery-row">
          <Segmented
            label="비교 방식"
            value={segment}
            onChange={setSegment}
            options={[
              { value: "side", label: "나란히" },
              { value: "overlay", label: "겹쳐 보기" },
            ]}
          />
          <Tabs
            label="패널"
            idPrefix="gallery-tabs"
            value={tab}
            onChange={setTab}
            options={[
              { value: "ai", label: "AI", icon: "sparkles" },
              { value: "versions", label: "버전 기록", icon: "clock" },
            ]}
          />
        </div>
        <div className="gallery-row">
          <TextField
            label="파일 이름"
            defaultValue="2026 하반기 사업계획"
            hint="끝의 .pptx는 저절로 붙어요"
          />
        </div>
      </Section>

      <Section title="상태 표시">
        <div className="gallery-row">
          <Chip icon="scope" tone="ai">
            범위 · 이 슬라이드
          </Chip>
          <Chip dot="ok">AI 연결됨 · Codex</Chip>
          <Chip dot="warn">AI 연결 필요</Chip>
          <Badge>
            <Spinner /> 확인 중…
          </Badge>
          <Badge tone="warn">열 수 없음</Badge>
          <Badge tone="ok" dot>
            연결됨
          </Badge>
        </div>
        <div className="gallery-stack">
          <Banner>편집기 기록으로는 문서가 바뀌지 않았어요.</Banner>
          <Banner tone="warn">
            AI가 바뀐 화면을 다시 보지 못했어요. 직접 확인해 주세요.
          </Banner>
          <Banner tone="danger">
            구독 사용 한도에 닿았어요. 잠시 뒤 다시 요청해 주세요.
          </Banner>
          <Banner tone="ok">그림.png 올림</Banner>
          <Progress value={0.38} label="올리는 중" />
          <Progress label="확인 중" />
        </div>
      </Section>

      <Section title="확인 목록과 진행 단계">
        <div className="gallery-columns">
          <CheckList
            label="확인 목록"
            items={[
              {
                tone: "ok",
                label: "바뀐 화면을 AI가 다시 보고 검토함",
                evidence: "turn.reviewed",
              },
              {
                tone: "warn",
                label: "새로 생긴 겹침 1곳",
                evidence: "edit.layoutAudit.introducedIssues",
              },
              {
                tone: "fail",
                label: "저장한 파일을 다시 열지 못함",
                evidence: "sample",
              },
              {
                tone: "na",
                label: "PowerPoint에서 직접 열어 보는 확인은 아직 하지 않아요",
                evidence: "sample",
              },
              {
                tone: "info",
                label: "6번 슬라이드의 SmartArt 1개는 AI가 고치지 못해요",
                evidence: "sample",
              },
            ]}
          />
          <StepList
            label="진행 단계"
            steps={[
              { label: "슬라이드 보기", state: "done" },
              { label: "고치기 · 여러 요소 한 번에 수정", state: "now" },
              { label: "바뀐 화면 다시 보기", state: "todo" },
              { label: "검토", state: "todo" },
            ]}
          />
        </div>
      </Section>

      <Section title="슬라이드 그림">
        <div className="gallery-columns">
          <SlideImage
            src={after}
            alt="예시 슬라이드"
            marks={baseSummary.changes.map((change) => ({
              ...change.box!,
              label: change.target,
            }))}
          />
          <SlideImage src={null} alt="미리보기 없음" />
        </div>
      </Section>

      <Section title="결과 카드">
        <div className="gallery-cards">
          <div>
            <h3>작업 중</h3>
            <RunningCard
              turn={turn(
                {
                  status: "running",
                  tools: [
                    "현재 슬라이드 확인",
                    "수정 계획 검사",
                    "여러 요소 한 번에 수정",
                  ],
                  finishedAt: null,
                },
                null,
              )}
              lookingAt={after ? { slideIndex: 2, url: after } : null}
              onStop={noop}
            />
          </div>
          {cards.map(([title, sample, options]) => (
            <div key={title}>
              <h3>{title}</h3>
              <ResultCard
                turn={sample}
                pairs={pairsOf(sample, options?.source)}
                undo={
                  options && "undo" in options ? (options.undo ?? null) : undo
                }
                onUndo={noop}
                onCompare={noop}
                onRetry={noop}
                onReveal={noop}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="대화 줄">
        <div className="gallery-stack">
          <ConversationLog
            items={[
              {
                kind: "user",
                key: "u",
                text: "3번 슬라이드 제목을 한 줄로 줄여 줘",
                permission: "slides",
                queued: false,
              },
              {
                kind: "manual",
                key: "m",
                run: {
                  from: sampleTime(10, 31),
                  to: sampleTime(10, 38),
                  saves: 3,
                  afterTurnId: null,
                },
              },
              {
                kind: "user",
                key: "q",
                text: "표의 숫자 서식을 천 단위 쉼표로 통일해 줘",
                permission: "slides",
                queued: true,
              },
            ]}
            renderTurn={() => null}
          />
          <div className="gallery-row">
            <ScopeMenu
              value="selection"
              onChange={noop}
              selection={sampleSelection}
            />
            <ScopeMenu
              value="slides"
              onChange={noop}
              selection={sampleSelection}
            />
            <ScopeMenu
              value="selection"
              onChange={noop}
              selection={{ ...sampleSelection, selected: [] }}
            />
          </div>
        </div>
      </Section>

      <Section title="휴대폰 보기와 여는 중">
        <div className="gallery-columns">
          <div className="gallery-phone">
            <PhoneSlides
              previews={[before, after, after]}
              index={1}
              onIndex={noop}
            />
          </div>
          <div className="gallery-frame">
            <OpeningView
              previews={[before, after, after, before]}
              message="편집기 준비 중 · 처음 열 때는 1분쯤 걸려요"
            />
          </div>
        </div>
      </Section>

      <Section title="빈 상태">
        <EmptyState icon="search" title="찾는 파일이 없어요">
          ‘분기’가 들어간 파일 이름이 없어요.
        </EmptyState>
      </Section>
    </main>
  );
}
