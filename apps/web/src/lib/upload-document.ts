/** A failed upload; the message is a reason code from upload-reasons.ts. */
export class UploadError extends Error {}

/**
 * Sends a PPTX to the library with upload progress (fetch cannot report it).
 * Resolves to the new document id.
 */
export function uploadDocumentFile(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): { done: Promise<string>; abort: () => void } {
  const request = new XMLHttpRequest();
  const done = new Promise<string>((resolve, reject) => {
    request.open("POST", "/api/documents");
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onload = () => {
      const body = request.response as { id?: string; error?: string } | null;
      if (request.status >= 200 && request.status < 300 && body?.id) resolve(body.id);
      else
        reject(
          new UploadError(
            body?.error ?? (request.status === 413 ? "file_too_large" : "unexpected_error"),
          ),
        );
    };
    request.onerror = () => reject(new UploadError("network"));
    request.onabort = () => reject(new UploadError("aborted"));
    const form = new FormData();
    form.set("file", file);
    request.send(form);
  });
  return { done, abort: () => request.abort() };
}
