import type { CheckItem } from "@/design-system";
import type { DocumentSummary } from "@/lib/history-types";

/*
 * Check lines about a stored version. Each line states only what the server
 * actually did or found; a check that was not performed gets no line.
 */

export function renderCheck(summary: DocumentSummary | null): CheckItem | null {
  if (!summary?.version?.rendered) return null;
  return {
    tone: "ok",
    label: `서버에서 파일을 다시 열어 ${summary.version.slideCount ?? summary.previews.length}장을 모두 그려 봤어요`,
    evidence: "every slide in the version graph has a preview",
  };
}

export function fontCheck(summary: DocumentSummary | null): CheckItem | null {
  if (!summary?.version?.rendered) return null;
  const { inventoryAvailable, missing } = summary.fonts;
  if (inventoryAvailable === false)
    return {
      tone: "warn",
      label: "서버의 글꼴 목록을 확인하지 못해 글꼴 차이를 검사하지 못했어요",
      evidence: "graph.fontInventoryAvailable=false",
    };
  if (missing.length)
    return {
      tone: "warn",
      label: `서버에 없어 비슷한 글꼴로 그린 글꼴 ${missing.length}개: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? " 외" : ""}. 받는 사람 컴퓨터에도 없으면 모양이 달라질 수 있어요`,
      evidence: "graph.missingFonts",
    };
  if (inventoryAvailable)
    return {
      tone: "ok",
      label: "파일이 쓰는 글꼴이 서버에 모두 있어요",
      evidence: "graph.missingFonts is empty",
    };
  return null;
}

function slidePhrase(slides: number[]) {
  if (slides.length === 1) return `${slides[0]! + 1}번 슬라이드`;
  if (slides.length <= 3)
    return `${slides.map((index) => index + 1).join("·")}번 슬라이드`;
  return `슬라이드 ${slides.length}장`;
}

/**
 * What can be changed in this file, as information rather than checks.
 * The first line holds on every editor engine; each limit comes from the
 * element graph and, where it depends on the engine, from what the engine
 * reported it can do.
 */
export function editScopeLines(summary: DocumentSummary | null): CheckItem[] {
  if (!summary?.version?.rendered) return [];
  const items: CheckItem[] = [
    {
      tone: "info",
      label:
        "글자 문구와 도형의 위치·크기·색은 편집기에서 직접, 또는 AI로 고칠 수 있어요",
      evidence: "edit contract operations with minEnginePatch 0",
    },
  ];
  for (const limit of summary.aiLimits ?? []) {
    const where = slidePhrase(limit.slides);
    const label =
      limit.kind === "diagram"
        ? `${where}의 SmartArt ${limit.count}개는 AI가 고치지 못해요`
        : limit.kind === "table"
          ? `${where}의 표 ${limit.count}개는 칸 내용을 AI가 고치지 못해요`
          : limit.kind === "linked_chart"
            ? `${where}의 차트 ${limit.count}개는 데이터가 다른 파일에 연결돼 있어 AI가 데이터를 고치지 못해요`
            : `${where}의 다른 프로그램 개체 ${limit.count}개는 AI가 고치지 못해요`;
    items.push({
      tone: "info",
      label,
      evidence: `element graph graphicKind + editor engine (${limit.kind})`,
    });
  }
  return items;
}
