import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { checksFor, ResultCard, type CardTurn } from "./result-card";
import { summarizeTurn } from "@/lib/native-turn-summary";
it("does not call an unfulfilled but visually reviewed result unreviewed", () => {
  const summary = summarizeTurn(
    {
      status: "completed",
      permissionMode: "document",
      changed: true,
      reviewed: true,
      lastError: null,
      task: {
        intent: "edit",
        goal: "원형 사진",
        outcome: "unverified",
        reason: "goal_review_missing",
      },
    },
    [],
  );
  const checks = checksFor(summary, "unverified");
  expect(checks[0]?.label).toBe("요청한 결과의 완료를 확인하지 못함");
  expect(checks[0]?.evidence).not.toBe("turn.reviewed=false");
});

it("shows unconfirmed execution without claiming the document changed", () => {
  const summary = summarizeTurn(
    {
      status: "completed",
      permissionMode: "document",
      changed: false,
      reviewed: false,
      lastError: null,
      task: {
        intent: "edit",
        goal: "원형 사진",
        outcome: "unverified",
        reason: "no_mutation",
      },
    },
    [],
  );
  const turn: CardTurn = {
    key: "fixture",
    turnId: "fixture",
    requestText: "사진을 원형으로 바꿔줘",
    permission: "document",
    status: "done",
    text: "실제 문서 편집이 실행되지 않았습니다.",
    tools: [],
    summary,
    changed: false,
    reviewed: false,
    startedAt: null,
    finishedAt: null,
  };
  const markup = renderToStaticMarkup(
    createElement(ResultCard, {
      turn,
      pairs: [],
      undo: null,
      onUndo: () => {},
      onRetry: () => {},
    }),
  );
  expect(markup).toContain("편집 결과 확인 필요");
  expect(markup).not.toContain("바뀜 ·");
  if (process.env.SPELLBOOK_RESULT_CARD_CAPTURE) {
    const css = ["tokens", "base", "components", "patterns"]
      .map((name) => readFileSync(`src/design-system/${name}.css`, "utf8"))
      .join("\n");
    writeFileSync(
      process.env.SPELLBOOK_RESULT_CARD_CAPTURE,
      `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css} body{padding:32px;background:var(--ds-color-bg,#f5f5f5)}main{max-width:640px;margin:auto}</style><main>${markup}</main></html>`,
    );
  }
});
