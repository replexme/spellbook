import { elementLabel } from "../../lib/element-label";
import { directionParticle, objectParticle, type PermissionMode } from "../copy";

/*
 * What the request box says about scope, from the editor's own selection
 * notices ("선택 · 제목 상자 (3번)"), and the suggestions it offers. A
 * suggestion appears only when the editor reported the edit it needs.
 */

/** What the editor reports as selected (extension `selection` operation). */
export type EditorSelection = {
  activeSlide: number;
  slideCount: number;
  selected: Array<{ elementId: string; name?: string; kind?: string; text?: string | null }>;
  /** Edits this editor engine can run; missing from older editors. */
  editableOperations?: string[];
};

function selectedLabel(selection: EditorSelection) {
  const [first] = selection.selected;
  return first ? elementLabel(first) : "";
}

/** The chip above the request box. */
export function scopeLabel(permission: PermissionMode, selection: EditorSelection | null) {
  if (permission === "document") return "범위 · 전체 문서";
  if (permission === "read_only") return "범위 · 묻기만";
  if (!selection) return permission === "slides" ? "범위 · 이 슬라이드" : "범위 · 선택한 요소";
  const slide = `${selection.activeSlide + 1}번`;
  if (permission === "slides") return `범위 · ${slide} 슬라이드`;
  const count = selection.selected.length;
  if (count === 0) return "선택 · 선택한 것 없음";
  if (count === 1) return `선택 · ${selectedLabel(selection)} (${slide})`;
  return `선택 · 요소 ${count}개 (${slide})`;
}

/** Scope menu descriptions that name what is selected right now. */
export function scopeDescription(mode: PermissionMode, selection: EditorSelection | null) {
  if (mode === "document") return "모든 슬라이드를 바꿀 수 있어요";
  if (mode === "read_only") return "문서를 바꾸지 않고 답해요";
  if (mode === "slides")
    return selection
      ? `${selection.activeSlide + 1}번 슬라이드 안에서만 바꿔요`
      : "보고 있는 슬라이드 안에서만 바꿔요";
  if (!selection) return "편집기에서 지금 선택한 요소만 바꿔요";
  const count = selection.selected.length;
  if (count === 0) return "편집기에서 요소를 먼저 선택해 주세요";
  if (count === 1) return `지금 선택한 ${selectedLabel(selection)} 1개만 바꿔요`;
  return `지금 선택한 요소 ${count}개만 바꿔요`;
}

export type Suggestion = { text: string; scope: PermissionMode; note?: string };
export type SuggestionGroup = { title: string; items: Suggestion[] };

/**
 * Edits every engine can run (patch level 0 in the edit contract; a test
 * holds this list to the contract). Used when an older editor does not
 * report its editable operations.
 */
export const ALWAYS_EDITABLE = new Set(["replace_text", "move", "resize", "align", "font_color", "fill_color"]);

export function suggestionsFor(selection: EditorSelection | null): SuggestionGroup[] {
  const editable = (operation: string) =>
    ALWAYS_EDITABLE.has(operation) || Boolean(selection?.editableOperations?.includes(operation));
  const groups: SuggestionGroup[] = [];
  const selected = selection?.selected ?? [];
  if (selected.length === 1) {
    const label = selectedLabel(selection!);
    const kind = String(selected[0]!.kind ?? "");
    const items: Suggestion[] = [];
    if (/Graphic|Picture/i.test(kind)) {
      items.push({ text: "이 그림을 슬라이드 가운데로 옮기기", scope: "slides" });
    } else if (/Table/i.test(kind)) {
      if (editable("set_table_cell"))
        items.push({ text: "이 표의 숫자를 천 단위 쉼표로 맞추기", scope: "selection" });
    } else if (typeof selected[0]!.text === "string" && selected[0]!.text.trim()) {
      const target = `이 ${label}${objectParticle(label)}`;
      items.push({ text: `${target} 한 줄로 줄이기`, scope: "selection" });
      items.push({ text: `${target} 영어로 바꾸기`, scope: "selection" });
      if (label === "제목" && editable("font_size"))
        items.push({ text: "다른 슬라이드 제목과 글자 크기 맞추기", scope: "document" });
    }
    if (items.length) groups.push({ title: `선택한 ${label}${directionParticle(label)}`, items });
  } else if (selection) {
    const items: Suggestion[] = [{ text: "이 슬라이드의 맞춤법 고치기", scope: "slides" }];
    if (editable("font_size"))
      items.push({ text: "이 슬라이드 본문의 글자 크기 맞추기", scope: "slides" });
    groups.push({ title: `${selection.activeSlide + 1}번 슬라이드에서`, items });
  }
  groups.push({
    title: "문서 전체",
    items: [
      { text: "모든 날짜 표기를 한 가지로 맞추기", scope: "document" },
      { text: "이 문서 요약 듣기", scope: "read_only", note: "문서는 바꾸지 않음" },
    ],
  });
  return groups;
}
