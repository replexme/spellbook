import type { StepState } from "@/design-system";

/*
 * The four stages of an AI edit (보기 → 고치기 → 다시 보기 → 검토) placed
 * from the progress labels the AI agent sends ("현재 슬라이드 확인",
 * "여러 요소 한 번에 수정", "수정 화면 확인 완료"). Stages not reached yet
 * are shown as the usual next steps, not as claims.
 */

type Stage = "look" | "edit" | "recheck" | "review" | "answer";

const names: Record<Stage, string> = {
  look: "슬라이드 보기",
  edit: "고치기",
  recheck: "바뀐 화면 다시 보기",
  review: "검토",
  answer: "답하기",
};

export type StageRow = { label: string; detail?: string; state: StepState };

export function runningStages(
  tools: string[],
  readOnly: boolean,
  answering = false,
): StageRow[] {
  const order: Stage[] = readOnly
    ? ["look", "answer"]
    : ["look", "edit", "recheck", "review"];
  let edited = false;
  let current = 0;
  const details = new Map<Stage, string>();
  for (const label of tools) {
    let stage: Stage | null = null;
    if (/수정 화면 (확인 완료|재검토)/.test(label)) stage = "review";
    else if (/슬라이드 확인/.test(label)) stage = edited ? "recheck" : "look";
    else if (/수정|삽입|이미지/.test(label)) {
      stage = "edit";
      edited = true;
    }
    if (!stage || !order.includes(stage)) continue;
    current = order.indexOf(stage);
    details.set(stage, label);
  }
  if (readOnly && answering) current = order.indexOf("answer");
  return order.map((stage, index) => ({
    label: names[stage],
    ...(details.has(stage) && index === current
      ? { detail: details.get(stage) }
      : {}),
    state: index < current ? "done" : index === current ? "now" : "todo",
  }));
}
