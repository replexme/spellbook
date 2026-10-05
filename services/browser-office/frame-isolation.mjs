// Shared by the local server and the published static workspace. The editor
// must isolate itself when embedded in a normal, non-isolated product page.
export const FRAME_ISOLATION = Object.freeze({
  "Document-Isolation-Policy": "isolate-and-require-corp",
});
