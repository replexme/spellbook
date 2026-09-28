import { describe, expect, it, vi } from "vitest";

import type { NativeObservation } from "./native-turn";
import {
  initialPageObservations,
  requestedSlideIndexes,
} from "./run-browser-turn";

describe("initial page selection", () => {
  it("loads explicitly numbered pages as actual pages", () => {
    expect(requestedSlideIndexes("1장과 60장 제목을 수정해", 60, 4)).toEqual([
      0, 59,
    ]);
  });

  it("uses the active page when no valid page number is given", () => {
    expect(requestedSlideIndexes("매출 슬라이드를 수정해", 60, 4)).toEqual([4]);
    expect(requestedSlideIndexes("999장 제목을 수정해", 60, 4)).toEqual([4]);
  });

  it("fetches each numbered page image and full detail before model work", async () => {
    const initial: NativeObservation = {
      revision: "r1",
      activeSlide: 0,
      slides: Array.from({ length: 60 }, (_, slideIndex) => ({
        slideIndex,
        elements: [],
      })),
      images: [],
      changedSlideIndexes: [],
      visualEvidenceComplete: true,
    };
    const observe = vi.fn(async (slideIndex: number) => ({
      ...initial,
      textDetails: { slideIndex, elements: [] },
      images: [{ slideIndex, pngBase64: "png" }],
    }));
    const result = await initialPageObservations(
      "1장과 60장 제목을 수정해",
      initial,
      observe,
    );
    expect(observe.mock.calls.map(([slideIndex]) => slideIndex)).toEqual([
      0, 59,
    ]);
    expect(result.pages.map((page) => page.textDetails?.slideIndex)).toEqual([
      0, 59,
    ]);
    expect(result.current.textDetails?.slideIndex).toBe(59);
    await expect(
      initialPageObservations("1장", initial, async () => ({
        ...initial,
        revision: "r2",
      })),
    ).rejects.toThrow("document_changed_during_initial_observation");
  });
});
