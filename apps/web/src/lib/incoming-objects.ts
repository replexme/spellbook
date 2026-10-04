/**
 * Files the browser writes straight to storage land under their final name
 * plus this suffix. Completing the transfer checks the file and moves it
 * into place; a transfer that is never completed leaves only a suffixed
 * object, which the managed bucket's lifecycle rule deletes after a day
 * (infra/provision.sh in the managed deployment matches this suffix).
 */
export const INCOMING_SUFFIX = ".incoming";

export function incomingObjectName(objectName: string): string {
  return `${objectName}${INCOMING_SUFFIX}`;
}
