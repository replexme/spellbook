// The server and browser LibreOffice builds use different patch-line prefixes.
// Their numeric milestones are checked here only to select probe assertions;
// candidate admission separately binds the exact browser receipt and source.
export function probeEnginePatchVersion(patchLevel) {
  const expected = process.env.SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL;
  if (expected && patchLevel !== expected) return 0;
  const match = /^(?:browser-)?undo-v([1-9][0-9]*)$/u.exec(patchLevel ?? "");
  return match ? Number(match[1]) : 0;
}
