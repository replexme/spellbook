"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Chip,
  Dialog,
  Segmented,
  SlideImage,
  type SlideMark,
} from "@/design-system";
import type { TurnChange } from "@/lib/native-turn-summary";

export type ComparePair = {
  slideIndex: number;
  before: string | null;
  after: string | null;
  marks: SlideMark[];
};

/**
 * Before/after of the slides one request (or one saved version) changed.
 * Outlines are drawn on our images, never inside the live editor.
 */
export function CompareDialog({
  open,
  onClose,
  title,
  subtitle,
  pairs,
  changes,
  imageSource,
  onRestore,
  restoreLabel = "이 요청 되돌리기",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle: string;
  pairs: ComparePair[];
  changes?: TurnChange[];
  imageSource: string;
  onRestore?: () => void;
  restoreLabel?: string;
}) {
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [showAfter, setShowAfter] = useState(true);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (open) {
      setIndex(0);
      setFocus(null);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[role="radiogroup"]')
      )
        return;
      if (event.key === "ArrowRight")
        setIndex((value) => Math.min(pairs.length - 1, value + 1));
      if (event.key === "ArrowLeft")
        setIndex((value) => Math.max(0, value - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pairs.length]);
  const pair = pairs[Math.min(index, pairs.length - 1)];
  const slideChanges = pair
    ? (changes ?? []).filter((change) => change.slideIndex === pair.slideIndex)
    : [];
  const marks = (pair?.marks ?? []).map((mark, markIndex) => ({
    ...mark,
    focused: focus === markIndex,
  }));
  return (
    <Dialog open={open} onClose={onClose} title={title} size="full" flush>
      <div className="cmp">
        <div className="cmp-bar">
          <p title={subtitle}>{subtitle}</p>
          <Segmented
            label="비교 방식"
            value={mode}
            onChange={setMode}
            options={[
              { value: "side", label: "나란히" },
              { value: "overlay", label: "겹쳐 보기" },
            ]}
          />
          {mode === "overlay" ? (
            <Segmented
              label="보이는 화면"
              value={showAfter ? "after" : "before"}
              onChange={(value) => setShowAfter(value === "after")}
              options={[
                { value: "before", label: "전" },
                { value: "after", label: "후" },
              ]}
            />
          ) : null}
          {onRestore ? (
            <Button size="sm" icon="restore" onClick={onRestore}>
              {restoreLabel}
            </Button>
          ) : null}
        </div>
        {pairs.length > 1 ? (
          <div className="cmp-slides" role="tablist" aria-label="바뀐 슬라이드">
            {pairs.map((item, itemIndex) => (
              <button
                key={item.slideIndex}
                type="button"
                role="tab"
                aria-selected={itemIndex === index}
                className={`ds-chip ${itemIndex === index ? "is-ai" : ""}`}
                onClick={() => {
                  setIndex(itemIndex);
                  setFocus(null);
                }}
              >
                <span>
                  {item.slideIndex + 1}번
                  {changes
                    ? ` · ${(changes ?? []).filter((change) => change.slideIndex === item.slideIndex).length}곳`
                    : ""}
                </span>
              </button>
            ))}
            <span className="cmp-hint">← → 키로 슬라이드 이동</span>
          </div>
        ) : null}
        {pair ? (
          <div className={`cmp-body ${mode === "overlay" ? "is-single" : ""}`}>
            {mode === "side" || !showAfter ? (
              <figure>
                <figcaption>
                  <strong>전</strong> · {pair.slideIndex + 1}번 슬라이드
                </figcaption>
                <SlideImage
                  src={pair.before}
                  alt={`${pair.slideIndex + 1}번 슬라이드 수정 전`}
                  loading="eager"
                />
              </figure>
            ) : null}
            {mode === "side" || showAfter ? (
              <figure>
                <figcaption>
                  <strong>후</strong> · 바뀐 곳{" "}
                  {pair.marks.length || slideChanges.length}
                </figcaption>
                <SlideImage
                  src={pair.after}
                  alt={`${pair.slideIndex + 1}번 슬라이드 수정 후`}
                  marks={marks}
                  loading="eager"
                />
              </figure>
            ) : null}
          </div>
        ) : (
          <div className="cmp-body is-single">
            <p className="dialog-lead">비교할 화면이 없어요.</p>
          </div>
        )}
        <div className="cmp-list">
          {slideChanges.length ? (
            slideChanges.map((change, changeIndex) => {
              const markIndex =
                pair?.marks.findIndex((mark) => mark.label === change.target) ??
                -1;
              return (
                <button
                  key={changeIndex}
                  type="button"
                  onMouseEnter={() =>
                    setFocus(markIndex >= 0 ? markIndex : null)
                  }
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(markIndex >= 0 ? markIndex : null)}
                  onBlur={() => setFocus(null)}
                >
                  {change.target} · {change.details.join(" · ")}
                </button>
              );
            })
          ) : (
            <Chip>저장본 미리보기로 비교해요</Chip>
          )}
          <span>그림: {imageSource}</span>
        </div>
      </div>
    </Dialog>
  );
}
