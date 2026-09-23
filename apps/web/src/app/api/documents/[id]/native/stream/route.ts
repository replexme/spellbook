import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { pollNativeSession } from "@/lib/native-runtime";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireNativeRequestSession(
      request,
      (await context.params).id,
    );
    const documentId = (await context.params).id;
    let after = Number(new URL(request.url).searchParams.get("after") ?? 0);

    const encoder = new TextEncoder();
    let closed = false;

    request.signal.addEventListener("abort", () => {
      closed = true;
    });

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": ping\n\n"));

        while (!closed) {
          try {
            const data = await pollNativeSession(session, documentId, after);
            if (data.events.length > 0 || data.task) {
              for (const event of data.events) {
                after = Math.max(after, Number(event.id));
              }
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify(data)}\n\n`,
                ),
              );
            }
          } catch {
            // Keep alive through transient errors
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "stream_error",
      { status: 400 },
    );
  }
}
