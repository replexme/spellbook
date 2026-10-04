/* SPDX-License-Identifier: MPL-2.0 */
import { createOnlyOfficeProductEngine } from "./product-engine.mjs";

// Installed by the trusted product host in the pinned presentation frame.
// The model never receives this private port or executable JavaScript authority.
export function installOnlyOfficeProductPort({
  clientWindow,
  clientOrigin,
  sessionId,
}) {
  if (
    !clientWindow ||
    new URL(clientOrigin).origin !== clientOrigin ||
    typeof sessionId !== "string" ||
    sessionId.length < 32
  )
    throw Error("onlyoffice_product_connection_invalid");
  const unavailable = async () => {
    throw Error("onlyoffice_product_host_authority_required");
  };
  const localFrame = {
    evaluate: (fn, argument) => Promise.resolve(fn(argument)),
  };
  const engine = createOnlyOfficeProductEngine({
    getFrame: async () => localFrame,
    open: unavailable,
    inspect: unavailable,
    snapshot: unavailable,
  });
  let port,
    disposed = false,
    queue = Promise.resolve();
  const transactions = new Map();
  const invoke = async ({ method, payload }) => {
    if (disposed) throw Error("onlyoffice_product_port_closed");
    switch (method) {
      case "observe":
        return engine.observe();
      case "preflight":
        if (!Array.isArray(payload) || !payload.length || payload.length > 50)
          throw Error("onlyoffice_product_batch_invalid");
        return engine.preflight(payload);
      case "begin": {
        if (transactions.size)
          throw Error("onlyoffice_product_transaction_busy");
        const id = crypto.randomUUID();
        transactions.set(id, await engine.begin());
        return id;
      }
      case "apply":
        if (transactions.size !== 1)
          throw Error("onlyoffice_product_transaction_required");
        return engine.apply(payload);
      case "finish": {
        const token = transactions.get(payload?.transaction);
        if (!token || typeof payload.commit !== "boolean")
          throw Error("onlyoffice_product_transaction_invalid");
        await engine.finish(token, payload.commit);
        transactions.delete(payload.transaction);
        return true;
      }
      case "undo":
      case "redo":
        if (transactions.size)
          throw Error("onlyoffice_product_transaction_busy");
        await engine[method]();
        return true;
      case "close":
        return true;
      default:
        throw Error("onlyoffice_product_method_unavailable");
    }
  };
  const connect = (event) => {
    if (
      disposed ||
      port ||
      event.source !== clientWindow ||
      event.origin !== clientOrigin ||
      event.data?.type !== "spellbook.onlyoffice-product-connect" ||
      event.data.sessionId !== sessionId ||
      event.ports.length !== 1
    )
      return;
    port = event.ports[0];
    port.onmessage = (event) => {
      const request = event.data;
      if (typeof request?.id !== "string" || request.id.length > 64) return;
      const run = queue.then(() => invoke(request));
      queue = run.catch(() => {});
      run.then(
        async (value) => {
          port?.postMessage({ id: request.id, value });
          if (request.method === "close") await dispose();
        },
        (error) => port?.postMessage({ id: request.id, error: error.message }),
      );
    };
    port.start();
    port.postMessage({ type: "ready", protocolVersion: 1 });
  };
  async function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("message", connect);
    for (const token of transactions.values())
      await engine.finish(token, false);
    transactions.clear();
    port?.close();
  }
  window.addEventListener("message", connect);
  return dispose;
}
