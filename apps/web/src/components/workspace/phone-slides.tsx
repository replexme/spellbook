"use client";

import { useRef } from "react";
import { IconButton, SlideImage } from "@/design-system";

/**
 * The phone's view of the file: saved previews of each slide, one at a
 * time. Direct editing stays on large screens; the editor keeps running
 * out of sight so AI requests still work.
 */
export function PhoneSlides({
  previews,
  index,
  onIndex,
}: {
  previews: Array<string | null>;
  index: number;
  onIndex: (index: number) => void;
}) {
  const count = previews.length;
  const current = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
  const touchStart = useRef<number | null>(null);
  const go = (next: number) => {
    if (next >= 0 && next < count) onIndex(next);
  };
  return (
    <section
      className="ws-phone-slides"
      aria-label="슬라이드 미리보기"
      onTouchStart={(event) => {
        touchStart.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        const end = event.changedTouches[0]?.clientX;
        touchStart.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < 40)
          return;
        go(end < start ? current + 1 : current - 1);
      }}
    >
      <SlideImage
        src={previews[current] ?? null}
        alt={count ? `${current + 1}번 슬라이드 미리보기` : "슬라이드 미리보기"}
        loading="eager"
      />
      <div className="ws-phone-bar">
        <IconButton
          icon="arrowLeft"
          label="이전 슬라이드"
          size="sm"
          disabled={current <= 0}
          onClick={() => go(current - 1)}
        />
        <p>
          <span className="ds-tabular">
            {count ? current + 1 : 0} / {count}
          </span>{" "}
          · 보기만 가능 · 직접 편집은 큰 화면에서
        </p>
        <IconButton
          icon="arrowRight"
          label="다음 슬라이드"
          size="sm"
          disabled={current >= count - 1}
          onClick={() => go(current + 1)}
        />
      </div>
    </section>
  );
}
