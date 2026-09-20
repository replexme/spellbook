# Browser-engine conformance harness

This local-only harness exercises the same Collabora document, extension bridge and WOPI save boundary used by Spellbook. It is not a production server and binds only to loopback.

The test matrix is declared in `contracts/native-mutation-conformance.json`. Every scenario records the exact source fixture hash, engine patch level, apply probe, reopen probe and required evidence. Public fixture binaries are fetched into the ignored corpus directory:

```bash
pnpm corpus:fetch-public -- \
  --renderer-image <libreoffice-image> \
  --renderer-version <libreoffice-release>
```

Build the connector and browser extension, start the candidate editor image, then start a probe for one source file and a new evidence directory:

```bash
pnpm connector:build
node services/office-editor/build.mjs
node services/office-session-spike/host.mjs \
  eval/public/downloads/ox-typical.pptx \
  .tmp-native-conformance/general
```

The page is available at `http://localhost:3190`. The host keeps the original immutable, stores each saved candidate separately and writes a receipt with hashes and WOPI events. Probe scripts use headless Playwright to execute typed commands in the extension and compare apply, one-step Undo, Redo, failure rollback and save/reopen state.

Release conformance refuses to start unless the running Office container has at
least 12 GiB free. The digest-pinned amd64 runtime can occupy tens of gigabytes
after extraction on Docker Desktop, so complete release runs belong on a
disposable native x86 worker. A local Mac is appropriate for focused probe
development only; remove the dedicated probe container and image after use.

Examples:

```bash
SPELLBOOK_PROBE_PATCHED_ENGINE=1 \
  node services/office-session-spike/probe-uno.mjs \
  http://localhost:3190 \
  .tmp-native-conformance/general/report.json

node services/office-session-spike/probe-uno-reopen.mjs \
  http://localhost:3190 \
  .tmp-native-conformance/general/report.json
```

Transition and animation scenarios additionally run the real Collabora web slideshow and require changing canvas frames plus a completion event. A static PNG cannot prove playback.

Set `SPELLBOOK_NATIVE_AI_HOME` only for an explicit local AI integration run. It points to a user-owned Codex home and is never copied, printed or committed. Engine conformance itself does not require an AI account.
