import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { EditRunner } from "./edit-runner.js";
import { SessionManager } from "./session-manager.js";
import { JobResultStore } from "./job-result-store.js";
import type { AiJob, AiWorkerCallback, NativeJob } from "./types.js";
import { runNativeTurn, type NativeObservation } from "./native-agent.js";
import {
  maintainNativeRemoteLease,
  NativeRemoteHost,
} from "./native-remote-host.js";
import { createLocalConnectorHandler } from "./local-connector-server.js";
import { LocalPairingAuthority } from "./local-pairing.js";

const sessions = new SessionManager();
const runner = new EditRunner(sessions);
const results = new JobResultStore();
const localMode = process.env.SPELLBOOK_CONNECTOR_MODE === "local";
const port = parsePort(process.env.PORT, localMode ? 43_127 : 8080);
const host = localMode ? "127.0.0.1" : "0.0.0.0";

const server = localMode
  ? http.createServer(
      createLocalConnectorHandler({
        authority: new LocalPairingAuthority(
          randomBytes(32),
          optionalList("SPELLBOOK_CONNECTOR_ALLOWED_ORIGINS"),
        ),
        accounts: sessions,
        connectorOrigin: `http://127.0.0.1:${port}`,
        identity:
          process.env.SPELLBOOK_LOCAL_EMAIL?.trim() || "local@spellbook",
        runNativeJob: (job, capability) =>
          runAcceptedJob(
            job,
            () => executeNativeJob(job, capability),
            capability,
          ),
      }),
    )
  : http.createServer(handleInternalRequest);

async function handleInternalRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { status: "ok" });
    }
    authorize(request);
    if (request.method !== "POST") {
      return json(response, 405, { error: "method_not_allowed" });
    }
    const body = await readJson(request);
    if (url.pathname === "/internal/models") {
      return json(response, 200, {
        models: await sessions.models(requiredString(body, "email")),
      });
    }
    if (url.pathname === "/internal/account/status") {
      return json(
        response,
        200,
        await sessions.status(requiredString(body, "email")),
      );
    }
    if (url.pathname === "/internal/account/login/start") {
      return json(
        response,
        200,
        await sessions.startLogin(requiredString(body, "email")),
      );
    }
    if (url.pathname === "/internal/account/logout") {
      await sessions.logout(requiredString(body, "email"));
      return json(response, 200, { status: "disconnected" });
    }
    if (url.pathname === "/internal/jobs/edit") {
      const job = body as unknown as AiJob;
      validateJob(job);
      runAcceptedJob(job, () => executeJob(job));
      return json(response, 202, { status: "accepted", jobId: job.jobId });
    }
    if (url.pathname === "/internal/jobs/native") {
      const job = body as unknown as NativeJob;
      validateNativeJob(job);
      runAcceptedJob(job, () => executeNativeJob(job));
      return json(response, 202, { status: "accepted", jobId: job.jobId });
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected AI worker error.";
    return json(response, message === "unauthorized" ? 401 : 400, {
      error: message,
    });
  }
}

server.listen(port, host, () => {
  process.stdout.write(
    `Spellbook AI connector listening on ${host}:${port} (${localMode ? "local" : "internal"}).\n`,
  );
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

function optionalList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("invalid_connector_port");
  return port;
}

function runAcceptedJob(
  job: AiJob | NativeJob,
  work: () => Promise<AiWorkerCallback>,
  callbackBearerToken?: string,
): void {
  void results
    .execute(job, work)
    .then((callback) =>
      sendCallback(job.callbackUrl, callback, callbackBearerToken),
    )
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "ai_job_delivery_failed",
          jobId: job.jobId,
          error: error instanceof Error ? error.message : "unknown_error",
        }),
      );
    });
}

async function executeJob(job: AiJob): Promise<AiWorkerCallback> {
  try {
    validateJob(job);
    return {
      jobId: job.jobId,
      status: "succeeded",
      mode: job.mode,
      result: await runner.run(job),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /agent_already_running|agent_lease_lost/.test(error.message)
    )
      throw error;
    const safe =
      error instanceof Error &&
      /not connected|invalid edit result|timed out|rate limit|Selected model/i.test(
        error.message,
      )
        ? error.message
        : "AI editing failed. Check worker logs with the job id.";
    return { jobId: job.jobId, status: "failed", mode: job.mode, error: safe };
  }
}

async function executeNativeJob(
  job: NativeJob,
  bearerToken?: string,
): Promise<AiWorkerCallback> {
  const executionToken = randomUUID();
  const host = new NativeRemoteHost(
    job.toolUrl,
    {
      jobId: job.jobId,
      sessionId: job.sessionId,
      executionToken,
    },
    bearerToken,
  );
  const controller = new AbortController();
  let events: Promise<void> = Promise.resolve();
  let heartbeat: Promise<void> | null = null;
  let heartbeatFailure: unknown = null;
  try {
    await host.start(controller.signal);
    heartbeat = maintainNativeRemoteLease(host, controller.signal).catch(
      (error) => {
        if (!controller.signal.aborted) {
          heartbeatFailure = error;
          controller.abort(error);
        }
      },
    );
    const initial: NativeObservation =
      (job as any).initialObservation && typeof (job as any).initialObservation === "object"
        ? ((job as any).initialObservation as NativeObservation)
        : await host.call({ operation: "observe" }, controller.signal);
    const effectiveMode =
      job.permissionMode === "selection" && initial.selectedElementIds.length === 0
        ? ("slides" as const)
        : job.permissionMode;
    const permission = {
      mode:
        effectiveMode === "slides"
          ? ("slides" as const)
          : effectiveMode,
      slideIndexes:
        effectiveMode === "slides" ? [initial.activeSlide] : [],
      elementIds:
        effectiveMode === "selection" ? initial.selectedElementIds : [],
    };
    const client = await sessions.client(job.email, job.modelSettings);
    const result = await runNativeTurn(client, {
      requestText: job.requestText,
      conversationHistory: job.conversationHistory,
      modelSettings: job.modelSettings,
      permission,
      host,
      initialObservation: initial,
      signal: controller.signal,
      onText: (delta) => {
        events = events.then(() =>
          host.event("delta", delta, controller.signal),
        );
      },
      onThinking: (delta) => {
        events = events.then(() =>
          host.event("thinking", delta, controller.signal),
        );
      },
      onTool: (label) => {
        events = events.then(() =>
          host.event("tool", label, controller.signal),
        );
      },
    });
    await events;
    if (heartbeatFailure) throw heartbeatFailure;
    return {
      jobId: job.jobId,
      status: "succeeded",
      mode: "native",
      result: { ...result, executionToken },
    };
  } catch (error) {
    controller.abort();
    const failure = heartbeatFailure ?? error;
    console.error(
      JSON.stringify({
        event: "native_ai_turn_failed",
        jobId: job.jobId,
        provider:
          job.modelSettings?.provider ?? job.modelSettings?.model ?? "default",
        error:
          failure instanceof Error
            ? failure.message.slice(0, 1_000)
            : "unknown_error",
      }),
    );
    const message =
      failure instanceof Error &&
      /not connected|timed out|rate limit|permission|cancel|native_/i.test(
        failure.message,
      )
        ? failure.message
        : "Native AI editing failed. Check worker logs with the job id.";
    return {
      jobId: job.jobId,
      status: "failed",
      mode: "native",
      error: message,
    };
  } finally {
    host.stop();
    controller.abort();
    await heartbeat?.catch(() => undefined);
  }
}

function validateNativeJob(job: NativeJob): void {
  if (
    !job?.jobId ||
    !job.callbackUrl ||
    !job.toolUrl ||
    !job.sessionId ||
    !job.turnId ||
    !job.email ||
    !job.storageNamespace ||
    !job.baseGraphObject ||
    !job.requestText ||
    job.mode !== "native" ||
    !["read_only", "selection", "slides", "document"].includes(
      job.permissionMode,
    )
  )
    throw new Error("Native AI job is invalid.");
  const callback = new URL(job.callbackUrl);
  const tools = new URL(job.toolUrl);
  if (
    callback.origin !== tools.origin ||
    tools.pathname !== "/api/internal/native/tools"
  )
    throw new Error("Native AI callback boundary is invalid.");
}

function validateJob(job: AiJob): void {
  if (
    !job?.jobId ||
    !job.callbackUrl ||
    !job.email ||
    !job.storageNamespace ||
    !job.baseGraphObject ||
    !job.requestText
  ) {
    throw new Error("AI job is missing required fields.");
  }
  if (job.mode !== "plan" && job.mode !== "review") {
    throw new Error("AI job mode is invalid.");
  }
}

async function sendCallback(
  url: string,
  callback: AiWorkerCallback,
  bearerToken?: string,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearerToken
        ? { authorization: `Bearer ${bearerToken}` }
        : process.env.SPELLBOOK_INTERNAL_TOKEN
          ? {
              "x-spellbook-internal-token":
                process.env.SPELLBOOK_INTERNAL_TOKEN,
            }
          : {}),
    },
    body: JSON.stringify(callback),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`AI callback failed with ${response.status}.`);
  }
}

function authorize(request: http.IncomingMessage): void {
  const expected = process.env.SPELLBOOK_INTERNAL_TOKEN;
  if (!expected) return;
  const given = request.headers["x-spellbook-internal-token"];
  const value = Array.isArray(given) ? given[0] : given;
  const left = Buffer.from(value ?? "");
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("unauthorized");
  }
}

async function readJson(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2_000_000) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key])
    throw new Error(`${key}_required`);
  return value[key];
}

function json(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
