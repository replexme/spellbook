import { describe, expect, it } from "vitest";
import { slideList, subjectParticle } from "./copy";

describe("subjectParticle", () => {
  it("follows the last syllable", () => {
    expect(subjectParticle("3번 슬라이드")).toBe("가");
    expect(subjectParticle("슬라이드 2장")).toBe("이");
    expect(subjectParticle(slideList([2]))).toBe("가");
    expect(subjectParticle(slideList([1, 4]))).toBe("이");
  });

  it("reads digits and falls back when it cannot tell", () => {
    expect(subjectParticle("2026")).toBe("이");
    expect(subjectParticle("Q2")).toBe("가");
    expect(subjectParticle("report")).toBe("이(가)");
    expect(subjectParticle("")).toBe("이(가)");
  });
});
