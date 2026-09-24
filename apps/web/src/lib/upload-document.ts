/** A failed upload; the message is a reason code from upload-reasons.ts. */
export class UploadError extends Error {}

type Target =
  | { direct: false }
  | {
      direct: true;
      url: string;
      headers: Record<string, string>;
      token: string;
    };

/** Sends a body with upload progress (fetch cannot report it). */
function send(
  request: XMLHttpRequest,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: XMLHttpRequestBodyInit,
  onProgress: (loaded: number, total: number) => void,
) {
  return new Promise<unknown>((resolve, reject) => {
    request.open(method, url);
    request.responseType = "json";
    for (const [name, value] of Object.entries(headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onload = () => {
      const response = request.response as { error?: string } | null;
      if (request.status >= 200 && request.status < 300) resolve(response);
      else
        reject(
          new UploadError(
            response?.error ??
              (request.status === 413 ? "file_too_large" : "unexpected_error"),
          ),
        );
    };
    request.onerror = () => reject(new UploadError("network"));
    request.onabort = () => reject(new UploadError("aborted"));
    request.send(body);
  });
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => {
    throw new UploadError("network");
  });
  const value = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & Record<string, unknown>;
  if (!response.ok) throw new UploadError(value.error ?? "unexpected_error");
  return value;
}

/**
 * Sends a PPTX to the library with upload progress and resolves to the new
 * document id. Where storage allows it the file goes straight from the
 * browser to storage; otherwise it is posted to the app.
 */
export function uploadDocumentFile(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): { done: Promise<string>; abort: () => void } {
  const request = new XMLHttpRequest();
  let aborted = false;
  const done = (async () => {
    const target = (await postJson("/api/documents/uploads", {
      fileName: file.name,
      size: file.size,
    })) as Target;
    if (aborted) throw new UploadError("aborted");
    if (target.direct) {
      // A network that blocks the storage host (or a storage rule problem)
      // must not stop an upload: it then goes through the app instead.
      const sent = await send(
        request,
        "PUT",
        target.url,
        target.headers,
        file,
        onProgress,
      ).then(
        () => true,
        (error: unknown) => {
          if (aborted || !(error instanceof UploadError)) throw error;
          if (error.message !== "network") throw error;
          return false;
        },
      );
      if (sent) {
        const { id } = await postJson("/api/documents/uploads/complete", {
          token: target.token,
        });
        if (typeof id !== "string") throw new UploadError("unexpected_error");
        return id;
      }
    }
    const form = new FormData();
    form.set("file", file);
    const body = (await send(
      request,
      "POST",
      "/api/documents",
      {},
      form,
      onProgress,
    )) as { id?: string } | null;
    if (!body?.id) throw new UploadError("unexpected_error");
    return body.id;
  })();
  return {
    done,
    abort: () => {
      aborted = true;
      request.abort();
    },
  };
}
