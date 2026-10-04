import { describe, expect, it } from "vitest";

import {
  pageKey,
  TurnWebAccess,
  WEB_FETCHES_PER_TURN,
  WEB_SEARCHES_PER_TURN,
} from "./web-access";

describe("web access within one AI request", () => {
  it("allows exact addresses the person wrote, without trailing punctuation", () => {
    const access = new TurnWebAccess(
      "참고: https://a.example/x?y=1, 그리고 (https://b.example/p).",
    );
    expect(access.pageAddress({ url: "https://a.example/x?y=1" })).toBe(
      "https://a.example/x?y=1",
    );
    expect(access.pageAddress({ url: "https://b.example/p#part" })).toBe(
      "https://b.example/p",
    );
    // A changed query string could carry document text: refused.
    expect(() =>
      access.pageAddress({ url: "https://a.example/x?y=1&leak=doc" }),
    ).toThrow(/cannot be read/);
    expect(() => access.pageAddress({ url: "http://a.example/x?y=1" })).toThrow();
  });

  it("allows search results and caps searches and reads", () => {
    const access = new TurnWebAccess("요약");
    access.allowResults([{ url: "https://ko.wikipedia.org/wiki/A" }]);
    expect(access.pageAddress({ url: "https://ko.wikipedia.org/wiki/A" })).toBe(
      "https://ko.wikipedia.org/wiki/A",
    );
    for (let index = 1; index < WEB_SEARCHES_PER_TURN; index += 1)
      access.searchQuery({ query: `q${index}` });
    access.searchQuery({ query: "last" });
    expect(() => access.searchQuery({ query: "one more" })).toThrow(/Only 5/);
    const many = new TurnWebAccess(
      Array.from({ length: WEB_FETCHES_PER_TURN + 1 }, (_, i) => `https://s.example/${i}`).join(" "),
    );
    for (let index = 0; index < WEB_FETCHES_PER_TURN; index += 1)
      many.pageAddress({ url: `https://s.example/${index}` });
    expect(() =>
      many.pageAddress({ url: `https://s.example/${WEB_FETCHES_PER_TURN}` }),
    ).toThrow(/Only 5 pages/);
  });

  it("knows a page by its address without the fragment", () => {
    expect(pageKey("https://x.example/a#b")).toBe("https://x.example/a");
    expect(pageKey("https://user:pw@x.example/")).toBeNull();
    expect(pageKey("javascript:alert(1)")).toBeNull();
  });
});
