import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { compactNativeContext, INITIAL_PAGE_PREFIX } from "./native-context";

const result = (revision: string, page: number): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: `${revision}-${page}`,
    toolName: "native_observe",
    content: [
      {
        type: "text",
        text: JSON.stringify({ revision, detailSlideIndexes: [page] }),
      },
      { type: "image", data: "png", mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 0,
  }) as AgentMessage;
const contentLength = (message: AgentMessage | undefined) =>
  message?.role === "toolResult" ? message.content.length : 0;

describe("native model context", () => {
  it("keeps the latest real pages and replaces stale image payloads", () => {
    const original = [
      result("r1", 0),
      result("r1", 59),
      result("r2", 0),
      result("r2", 0),
      result("r2", 59),
    ];
    const compact = compactNativeContext(original);
    expect(compact).toHaveLength(original.length);
    expect(contentLength(compact[0])).toBe(1);
    expect(contentLength(compact[1])).toBe(1);
    expect(contentLength(compact[2])).toBe(1);
    expect(compact[3]).toBe(original[3]);
    expect(compact[4]).toBe(original[4]);
    expect(contentLength(original[0])).toBe(2);
  });

  it("drops the initial page image after the document revision changes", () => {
    const initial = {
      role: "user",
      content: [
        {
          type: "text",
          text: `${INITIAL_PAGE_PREFIX}\n${JSON.stringify({ revision: "r1", pages: [] })}`,
        },
        { type: "image", data: "png", mimeType: "image/png" },
      ],
      timestamp: 0,
    } as AgentMessage;
    const compact = compactNativeContext([initial, result("r2", 0)]);
    expect(contentLength(compact[0])).toBe(0);
    expect(compact[0]?.role).toBe("user");
    if (compact[0]?.role === "user") expect(compact[0].content).toHaveLength(1);
  });
});
