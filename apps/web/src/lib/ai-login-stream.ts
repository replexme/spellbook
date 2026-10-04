/*
 * The subscription sign-in stream shared by the sign-in route and the page:
 * one JSON object per line.
 */

export type LoginStreamEvent =
  | ({ type: "started" } & Record<string, unknown>)
  | { type: "waiting" }
  | {
      type: "finished";
      connected: boolean;
      /** The connector cannot report the end; the page watches the status. */
      pending?: boolean;
      error?: string;
    };

export const LOGIN_STREAM_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

export function loginStreamLine(event: LoginStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Reads a sign-in stream. Calls `onStarted` with the first line and resolves
 * with the last; a stream that ends without `finished` counts as expired.
 */
export async function readLoginStream(
  response: Response,
  onStarted: (started: Record<string, unknown>) => void,
): Promise<Extract<LoginStreamEvent, { type: "finished" }>> {
  if (!response.body) return { type: "finished", connected: false, error: "login_stream_closed" };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: LoginStreamEvent;
        try {
          event = JSON.parse(line) as LoginStreamEvent;
        } catch {
          continue;
        }
        if (event.type === "started") onStarted(event);
        if (event.type === "finished") return event;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { type: "finished", connected: false, error: "login_stream_closed" };
}
