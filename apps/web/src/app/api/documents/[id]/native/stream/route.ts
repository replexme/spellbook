import { routeError } from "../../../../../../lib/http";
import { requireNativeRequestSession } from "../../../../../../lib/native-request-auth";
import { subscribeNativeChanges } from "../../../../../../lib/native-event-signal";
import {
  nativeSessionSignalId,
  pollNativeSession,
} from "../../../../../../lib/native-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STREAM_MS = 55_000;
const MAINTENANCE_MS = 8_000;
const MIN_QUERY_INTERVAL_MS = 250;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const raw = new URL(request.url).searchParams.get("after") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      return Response.json({ error: "invalid_event_cursor" }, { status: 400 });
    const session = await requireNativeRequestSession(request, id);
    const sessionId = await nativeSessionSignalId(session, id);
    let closed = false;
    let dirty = true;
    let resume: (() => void) | null = null;
    let cursor = Number(raw);
    const wake = () => {
      dirty = true;
      resume?.();
    };
    // Subscribe before the initial durable read to close the subscribe/read race.
    const unsubscribe = await subscribeNativeChanges(sessionId, wake);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => {
          closed = true;
          resume?.();
          unsubscribe();
        };
        request.signal.addEventListener("abort", stop, { once: true });
        void (async () => {
          let lastQuery = 0;
          const deadline = Date.now() + STREAM_MS;
          try {
            controller.enqueue(encoder.encode("retry: 1000\n\n"));
            while (!closed && Date.now() < deadline) {
              if (dirty) {
                const delay = Math.max(
                  0,
                  MIN_QUERY_INTERVAL_MS - (Date.now() - lastQuery),
                );
                if (delay)
                  await new Promise((resolve) => setTimeout(resolve, delay));
                if (closed) break;
                dirty = false;
                lastQuery = Date.now();
                const snapshot = await pollNativeSession(session, id, cursor);
                if (closed) break;
                for (const event of snapshot.events)
                  cursor = Math.max(cursor, event.id);
                controller.enqueue(
                  encoder.encode(
                    `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
                  ),
                );
              }
              if (!closed && !dirty) {
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(
                    () => {
                      resume = null;
                      dirty = true; // retry jobs, task expiry, and lost NOTIFY recovery
                      resolve();
                    },
                    Math.min(
                      MAINTENANCE_MS,
                      Math.max(1, deadline - Date.now()),
                    ),
                  );
                  resume = () => {
                    clearTimeout(timer);
                    resume = null;
                    resolve();
                  };
                });
              }
            }
          } catch (error) {
            if (!closed)
              controller.enqueue(
                encoder.encode(
                  `event: stream-error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`,
                ),
              );
          } finally {
            stop();
            request.signal.removeEventListener("abort", stop);
            try {
              controller.close();
            } catch {
              /* cancelled by the browser */
            }
          }
        })();
      },
      cancel() {
        closed = true;
        resume?.();
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "private, no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
