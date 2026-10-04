/* SPDX-License-Identifier: MPL-2.0 */
export async function connectOnlyOfficeProductPort({
  frameWindow,
  frameOrigin,
  sessionId,
  timeoutMs = 30000,
}) {
  if (
    !frameWindow ||
    new URL(frameOrigin).origin !== frameOrigin ||
    typeof sessionId !== "string" ||
    sessionId.length < 32
  )
    throw Error("onlyoffice_product_connection_invalid");
  const channel = new MessageChannel(),
    pending = new Map();
  let closed = false,
    readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  channel.port1.onmessage = (event) => {
    if (event.data?.type === "ready" && event.data.protocolVersion === 1)
      return readyResolve();
    const waiter = pending.get(event.data?.id);
    if (!waiter) return;
    pending.delete(event.data.id);
    clearTimeout(waiter.timer);
    event.data.error
      ? waiter.reject(Error(event.data.error))
      : waiter.resolve(event.data.value);
  };
  channel.port1.start();
  frameWindow.postMessage(
    { type: "spellbook.onlyoffice-product-connect", sessionId },
    frameOrigin,
    [channel.port2],
  );
  let readyTimer;
  try {
    await Promise.race([
      ready,
      new Promise(
        (_, reject) =>
          (readyTimer = setTimeout(
            () => reject(Error("onlyoffice_product_connection_timeout")),
            timeoutMs,
          )),
      ),
    ]);
  } catch (error) {
    channel.port1.close();
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  const call = (method, payload) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(Error("onlyoffice_product_port_closed"));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("onlyoffice_product_request_timeout:" + method));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        channel.port1.postMessage({ id, method, payload });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  return {
    observe: () => call("observe"),
    changeToken: () => call("changeToken"),
    prepareManualCheckpoint: () => call("prepareManualCheckpoint"),
    preflight: (commands) => call("preflight", commands),
    begin: () => call("begin"),
    apply: (command) => call("apply", command),
    finish: (transaction, commit) => call("finish", { transaction, commit }),
    undo: () => call("undo"),
    redo: () => call("redo"),
    dispose: async () => {
      try {
        await call("close");
      } finally {
        closed = true;
        channel.port1.close();
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(Error("onlyoffice_product_port_closed"));
        }
        pending.clear();
      }
    },
  };
}
