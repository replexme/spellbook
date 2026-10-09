import * as objectStore from "./storage";
import {
  readLinkedImageManifest,
  readOwnedLinkedImage,
} from "../../../../services/document-resources/linked-image-snapshots.mjs";
import { browserDocumentIdentity } from "./browser-session";
import { HttpError } from "./http";
import type { Session } from "./models";

/** Read the worker's published snapshot for this active, owned file revision. */
export async function browserRenderResources(
  session: Session,
  documentId: string,
  expectedRevision: string,
  requestedHash: string | null = null,
) {
  if (!expectedRevision) throw new HttpError(428, "browser_revision_required");
  const source = await browserDocumentIdentity(session, documentId);
  if (source.revision !== expectedRevision)
    throw new HttpError(409, "browser_document_changed");
  const scope = {
    accountId: session.accountId,
    documentId,
    sourceSha256: source.sourceSha256,
    objectStore,
  };
  const manifest = await readLinkedImageManifest(scope);
  if (requestedHash !== null) {
    if (!/^[a-f0-9]{64}$/.test(requestedHash))
      throw new HttpError(400, "invalid_render_resource");
    if (!manifest.images.some((value) => value.sha256 === requestedHash))
      throw new HttpError(404, "render_resource_not_found");
    return {
      revision: source.revision,
      asset: await readOwnedLinkedImage(scope, requestedHash),
    };
  }
  return { revision: source.revision, manifest };
}
