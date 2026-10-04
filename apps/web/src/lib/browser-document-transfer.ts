/*
 * Moves the editor's PPTX between the browser and storage. Where storage
 * gives a short-lived link, the file goes straight to or from storage, so a
 * large file never passes through the app (whose requests stop at 32 MiB).
 * Otherwise, or when the network blocks the storage host, it goes through
 * the app's .../contents endpoint.
 */

const PPTX_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Largest file the app itself relays (its requests stop at 32 MiB). */
export const RELAYED_FILE_MAX_BYTES = 30 * 1024 * 1024;

export class TransferError extends Error {}

async function errorCode(response: Response, fallback: string) {
  const value = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  return typeof value.error === "string" ? value.error : fallback;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function isPackage(bytes: ArrayBuffer, maxBytes: number) {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
  return (
    bytes.byteLength > 0 &&
    bytes.byteLength <= maxBytes &&
    head[0] === 0x50 &&
    head[1] === 0x4b
  );
}

/**
 * Reads the editor's file and proves it is the expected revision: the
 * revision names the file's SHA-256, and a file read from storage must
 * hash to it.
 */
export async function readBrowserDocument(
  contentApiBase: string,
  expectedRevision: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revision: string; bytes: ArrayBuffer }> {
  const source = await fetchImpl(`${contentApiBase}/source`, {
    cache: "no-store",
  }).catch(() => null);
  if (source?.ok) {
    const value = (await source.json().catch(() => ({}))) as {
      revision?: unknown;
      url?: unknown;
    };
    if (typeof value.url === "string" && value.revision === expectedRevision) {
      const stored = await fetchImpl(value.url, { cache: "no-store" }).catch(
        () => null,
      );
      if (stored?.ok) {
        const bytes = await stored.arrayBuffer();
        const digest = await sha256Hex(bytes);
        if (
          !isPackage(bytes, maxBytes) ||
          !expectedRevision.endsWith(`:${digest}"`)
        )
          throw new TransferError("browser_document_identity_mismatch");
        return { revision: expectedRevision, bytes };
      }
      // The storage host is unreachable from here; use the app instead.
    }
  }
  const response = await fetchImpl(`${contentApiBase}/contents`, {
    cache: "no-store",
  });
  if (!response.ok)
    throw new TransferError(
      await errorCode(response, "browser_document_download_failed"),
    );
  const revision = response.headers.get("etag") ?? "";
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  const bytes = await response.arrayBuffer();
  if (
    revision !== expectedRevision ||
    contentType !== PPTX_TYPE ||
    !isPackage(bytes, maxBytes)
  )
    throw new TransferError("browser_document_identity_mismatch");
  return { revision, bytes };
}

/**
 * Saves the editor's file against the revision it was opened at. The
 * server checks the stored file itself (size, package, SHA-256) before
 * it becomes a version.
 */
export async function writeBrowserDocument(
  contentApiBase: string,
  revision: string,
  bytes: ArrayBuffer,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revision: string; unchanged: boolean }> {
  const started = await fetchImpl(`${contentApiBase}/saves`, {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": revision },
    body: JSON.stringify({ size: bytes.byteLength }),
    cache: "no-store",
  });
  if (!started.ok)
    throw new TransferError(
      await errorCode(started, "browser_document_save_failed"),
    );
  const target = (await started.json().catch(() => ({}))) as {
    direct?: unknown;
    url?: unknown;
    headers?: Record<string, string>;
    token?: unknown;
  };
  if (target.direct === true && typeof target.url === "string") {
    const stored = await fetchImpl(target.url, {
      method: "PUT",
      headers: target.headers ?? {},
      body: bytes,
      cache: "no-store",
    }).catch(() => null);
    if (stored?.ok)
      return saved(
        await fetchImpl(`${contentApiBase}/saves/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: target.token }),
          cache: "no-store",
        }),
      );
    // Storage refused or was unreachable. The app can relay only a small file.
    if (bytes.byteLength > RELAYED_FILE_MAX_BYTES)
      throw new TransferError("direct_upload_blocked");
  }
  return saved(
    await fetchImpl(`${contentApiBase}/contents`, {
      method: "PUT",
      headers: { "content-type": PPTX_TYPE, "if-match": revision },
      body: bytes,
      cache: "no-store",
    }),
  );
}

async function saved(
  response: Response,
): Promise<{ revision: string; unchanged: boolean }> {
  const value = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    revision?: unknown;
    unchanged?: unknown;
  };
  if (!response.ok)
    throw new TransferError(
      typeof value.error === "string"
        ? value.error
        : "browser_document_save_failed",
    );
  const revision = response.headers.get("etag") ?? value.revision;
  if (typeof revision !== "string" || !revision)
    throw new TransferError("browser_save_revision_missing");
  return { revision, unchanged: value.unchanged === true };
}
