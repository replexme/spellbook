import type { AgentMessage } from "@earendil-works/pi-agent-core";

const DOCUMENT_TOOLS = new Set([
  "native_observe",
  "native_edit",
  "native_batch_edit",
]);
export const INITIAL_PAGE_PREFIX =
  "프레젠테이션 작업을 시작해 주세요. 아래는 현재 요청의 실제 페이지 데이터입니다. 첨부된 이미지는 pages 배열과 같은 순서입니다.";

function documentView(message: AgentMessage) {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    !DOCUMENT_TOOLS.has(message.toolName)
  )
    return null;
  const text = message.content.find((part) => part.type === "text")?.text;
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.revision !== "string") return null;
    const pages = [
      ...(Array.isArray(value.detailSlideIndexes)
        ? value.detailSlideIndexes
        : []),
      ...(Array.isArray(value.changedSlideIndexes)
        ? value.changedSlideIndexes
        : []),
    ];
    return {
      revision: value.revision,
      pages: pages.filter((page): page is number => Number.isInteger(page)),
    };
  } catch {
    return null;
  }
}

// Preserve the transcript's tool-call/result structure while removing older
// page payloads and images once a newer view covers them. The actual agent
// history remains intact; this only changes what the next model call sees.
export function compactNativeContext(messages: AgentMessage[]): AgentMessage[] {
  try {
    let latestRevision: string | null = null;
    const seenPages = new Set<number>();
    return messages
      .slice()
      .reverse()
      .map((message) => {
        if (message.role === "user" && latestRevision) {
          const text = Array.isArray(message.content)
            ? message.content.find((part) => part.type === "text")?.text
            : message.content;
          if (text?.startsWith(INITIAL_PAGE_PREFIX)) {
            try {
              const initial = JSON.parse(
                text.slice(INITIAL_PAGE_PREFIX.length).trim(),
              ) as { revision?: string };
              if (initial.revision !== latestRevision)
                return {
                  ...message,
                  content: [
                    {
                      type: "text" as const,
                      text: "Initial page images and data were superseded. Use the latest document view.",
                    },
                  ],
                };
            } catch {
              return message;
            }
          }
        }
        const view = documentView(message);
        if (!view) return message;
        latestRevision ??= view.revision;
        const stale = view.revision !== latestRevision;
        const duplicate =
          view.pages.length > 0 &&
          view.pages.every((page) => seenPages.has(page));
        if (!stale) for (const page of view.pages) seenPages.add(page);
        return stale || duplicate
          ? {
              ...message,
              content: [
                {
                  type: "text" as const,
                  text: `Earlier document view superseded by revision ${latestRevision}. Reobserve a page if needed.`,
                },
              ],
            }
          : message;
      })
      .reverse();
  } catch {
    return messages;
  }
}
