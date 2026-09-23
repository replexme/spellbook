import { describe, expect, it, vi } from "vitest";
import {
  consumeNativeStream,
  shouldStreamNativeEvents,
} from "./native-stream-client";

const encoder = new TextEncoder();
function chunked(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("authenticated native SSE transport", () => {
  it("streams only busy turns and preserves an explicit polling rollback", () => {
    expect(shouldStreamNativeEvents(true, "capability")).toBe(true);
    expect(shouldStreamNativeEvents(false, "capability")).toBe(false);
    expect(shouldStreamNativeEvents(true, "")).toBe(false);
    expect(shouldStreamNativeEvents(true, "capability", "poll")).toBe(false);
  });
  it("parses split CRLF frames and never places the capability in the URL", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          chunked([
            "retry: 1000\r\n\r\nevent: snapshot\r",
            '\ndata: {"events":[{"id":42}],"task":null}\r\n\r',
            "\n: heartbeat\n\n",
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;
    const snapshots: unknown[] = [];
    await consumeNativeStream(
      "/api/native/stream",
      "secret",
      41,
      new AbortController().signal,
      (snapshot) => {
        snapshots.push(snapshot);
      },
      fetcher,
    );
    expect(snapshots).toEqual([{ events: [{ id: 42 }], task: null }]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/native/stream?after=41",
      expect.objectContaining({
        headers: {
          authorization: "Bearer secret",
          accept: "text/event-stream",
        },
      }),
    );
  });
  it("propagates HTTP status and server error details rather than concealing them", async () => {
    const failed = vi.fn(
      async () =>
        new Response('{"error":"permission_denied"}', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      consumeNativeStream(
        "/stream",
        "secret",
        0,
        new AbortController().signal,
        () => {},
        failed,
      ),
    ).rejects.toThrow('SSE HTTP 403: {"error":"permission_denied"}');
    const errored = vi.fn(
      async () =>
        new Response(
          chunked([
            'event: stream-error\ndata: {"error":"db_unavailable"}\n\n',
          ]),
        ),
    ) as unknown as typeof fetch;
    await expect(
      consumeNativeStream(
        "/stream",
        "secret",
        0,
        new AbortController().signal,
        () => {},
        errored,
      ),
    ).rejects.toThrow("db_unavailable");
  });
});
