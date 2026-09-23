import type { pollNativeSession } from "./native-runtime";

type NativeSnapshot = Awaited<ReturnType<typeof pollNativeSession>>;

// Fetch streaming is used rather than EventSource: the editor's document-scoped
// capability belongs in an Authorization header, never in a logged URL.
export async function consumeNativeStream(
  url: string,
  token: string,
  after: number,
  signal: AbortSignal,
  onSnapshot: (value: NativeSnapshot) => void | Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${url}?after=${after}`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SSE HTTP ${response.status}: ${body}`);
  }
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(
        /\r\n/g,
        "\n",
      );
      if (buffer.length > 2_000_000) throw new Error("SSE frame exceeds 2 MB");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split("\n");
        const kind = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (kind === "snapshot") await onSnapshot(JSON.parse(data));
        if (kind === "stream-error") throw new Error(JSON.parse(data).error);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
