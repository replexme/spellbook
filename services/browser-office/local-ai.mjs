/* SPDX-License-Identifier: MPL-2.0 */
import {
  pairLocalConnector,
  readLocalConnectorSession,
} from "../../apps/web/src/lib/local-ai-connector.ts";
import { localOffice } from "./local-workspace.mjs";
const origin = "http://127.0.0.1:43127",
  el = (id) => document.getElementById(id);
let session = readLocalConnectorSession(sessionStorage),
  turnId,
  busy = false,
  cancelled = false,
  offset = 0;
async function post(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: "Bearer " + session.token } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? "local_ai_failed");
  return value;
}
const fail = (error) => {
  el("ai-result").textContent =
    "AI 작업을 완료하지 못했습니다: " + error.message;
};
async function models() {
  const value = await post("/v1/models", {});
  el("ai-model").replaceChildren(
    ...value.models.map((model) => {
      const option = document.createElement("option");
      option.value = JSON.stringify({
        model: model.model,
        effort: model.defaultReasoningEffort ?? "medium",
        provider:
          model.provider ??
          (model.model.startsWith("claude") ? "claude_code" : "codex"),
      });
      option.textContent = model.displayName ?? model.model;
      return option;
    }),
  );
  el("ai-run").disabled = false;
  el("ai-result").textContent = "로컬 AI 연결 완료";
}
el("ai-connect").onclick = async () => {
  try {
    session = await pairLocalConnector(origin, el("ai-provider").value);
    await models();
  } catch (error) {
    fail(error);
  }
};
el("ai-run").onclick = async () => {
  if (busy || !localOffice.isReady()) return;
  busy = true;
  cancelled = false;
  const generation = localOffice.generation();
  el("ai-run").disabled = true;
  try {
    const created = await post("/v1/local-turns", {
      requestText: el("ai-request").value,
      permissionMode: el("ai-scope").value,
      modelSettings: JSON.parse(el("ai-model").value),
    });
    turnId = created.turnId;
    if (cancelled || generation !== localOffice.generation())
      throw Error("document_closed");
    offset = 0;
    el("ai-run").disabled = true;
    el("ai-cancel").disabled = false;
    el("ai-result").textContent = "";
    while (turnId) {
      const current = turnId;
      const value = await post("/v1/local-turns/poll", {
        turnId: current,
        offset,
      });
      offset = value.offset;
      for (const event of value.events)
        if (event.type === "delta") el("ai-result").textContent += event.text;
      for (const task of value.tasks) {
        let result, error;
        try {
          if (cancelled || generation !== localOffice.generation())
            throw Error("document_closed");
          result = await localOffice.call(task.request);
          if (cancelled || generation !== localOffice.generation())
            throw Error("document_closed");
        } catch (reason) {
          error = reason.message;
        }
        await post("/v1/local-turns/reply", {
          turnId: current,
          taskId: task.id,
          value: result,
          error,
        });
      }
      if (value.done) {
        if (value.result?.error) throw Error(value.result.error);
        el("ai-result").textContent =
          value.result?.text ?? el("ai-result").textContent;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    fail(error);
  } finally {
    if (turnId)
      await post("/v1/local-turns/cancel", { turnId }).catch(() => {});
    turnId = null;
    busy = false;
    el("ai-run").disabled = false;
    el("ai-cancel").disabled = true;
  }
};
const cancel = () => {
  cancelled = true;
  if (turnId) void post("/v1/local-turns/cancel", { turnId }).catch(fail);
};
el("ai-cancel").onclick = cancel;
window.addEventListener("pagehide", cancel);
window.addEventListener("spellbook-local-document-changing", cancel);
el("ai").addEventListener("toggle", () => {
  if (localOffice.isReady())
    void localOffice.call({ operation: "fit_view" }).catch(() => {});
});
if (session) void models().catch(fail);
