import { db } from "./db";

// PostgreSQL LISTEN uses one connection per web instance, not one per browser.
// Notifications carry only a session ID; the stream reads the durable events.
const subscribers = new Map<string, Set<() => void>>();
let listening: Promise<{ unlisten(): Promise<void> }> | null = null;
let shutdown: Promise<void> = Promise.resolve();

export async function subscribeNativeChanges(
  sessionId: string,
  wake: () => void,
): Promise<() => void> {
  let callbacks = subscribers.get(sessionId);
  if (!callbacks) subscribers.set(sessionId, (callbacks = new Set()));
  callbacks.add(wake);
  try {
    listening ??= shutdown.then(() =>
      db().listen("spellbook_native_changed", (id) => {
        for (const callback of subscribers.get(id) ?? []) callback();
      }),
    );
    await listening;
  } catch (error) {
    listening = null;
    callbacks.delete(wake);
    if (!callbacks.size && subscribers.get(sessionId) === callbacks)
      subscribers.delete(sessionId);
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    callbacks.delete(wake);
    if (!callbacks.size && subscribers.get(sessionId) === callbacks)
      subscribers.delete(sessionId);
    if (!subscribers.size && listening) {
      const current = listening;
      listening = null;
      shutdown = shutdown.then(async () => {
        try {
          await (await current).unlisten();
        } catch {
          /* subscription failed or connection was closed */
        }
      });
    }
  };
}
