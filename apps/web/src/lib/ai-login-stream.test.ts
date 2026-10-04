import { describe, expect, it, vi } from "vitest";

import { loginStreamLine, readLoginStream } from "./ai-login-stream";

function streamOf(...chunks: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("subscription sign-in stream", () => {
  it("hands over the sign-in page first and resolves with the outcome", async () => {
    const started = vi.fn();
    const whole =
      loginStreamLine({ type: "started", loginId: "l1", verificationUrl: "https://x" }) +
      loginStreamLine({ type: "waiting" }) +
      loginStreamLine({ type: "finished", connected: true });
    // Lines may arrive split anywhere.
    const finished = await readLoginStream(
      streamOf(whole.slice(0, 7), whole.slice(7, 60), whole.slice(60)),
      started,
    );
    expect(started).toHaveBeenCalledWith({
      type: "started",
      loginId: "l1",
      verificationUrl: "https://x",
    });
    expect(finished).toEqual({ type: "finished", connected: true });
  });

  it("treats a stream that ends early as an expired sign-in", async () => {
    const finished = await readLoginStream(
      streamOf(loginStreamLine({ type: "started", loginId: "l2" })),
      () => undefined,
    );
    expect(finished).toMatchObject({ connected: false, error: "login_stream_closed" });
  });
});
