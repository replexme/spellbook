# Spellbook

[English](README.md) | [한국어](docs/README.ko.md)

Spellbook opens an existing document in the browser, lets a person ask an AI to change it, and keeps the result an editable file in its original format. The person sees the document, asks for changes, and can undo, redo or go back to an earlier version; only the AI edits the document. Each AI edit is checked against the document structure and the drawn page before it is accepted.

The current usable vertical is **PowerPoint (`.pptx`)**. InDesign documents (`.idml`) are experimental. DOCX and Spellbook's native page-layout format are planned adapters; they are not advertised as working features yet.

## What is public

This repository is the complete self-hosted product. It does not require Replex accounts or Google Cloud.

- **Web app** (`apps/web`): sign-in, uploads, versions, conversations and the workspace screen.
- **Document view** (`apps/office`): the page inside the workspace that shows the document. It runs Spellbook's own Rust document engine (`engine/`, `formats/`) compiled to WebAssembly, and applies the AI's edits with that same engine.
- **Document worker** (`services/document-worker`): checks uploaded files and draws page previews with the engine's command-line programs `present-pptx` and `present-idml`. It does not use LibreOffice.
- **AI connector** (`apps/ai-connector`): connects the user's own Codex or Claude Code subscription to a document turn.
- Contracts (`contracts/`) and the public evaluation harness (`scripts/`, `eval/`).

The hosted Replex service adds private deployment, billing, entitlement, managed identity, managed credential storage, and private evaluation data outside this repository. Hosted modules depend on this public core; the public core never imports hosted modules.

## Run locally

Prerequisites: Docker with Compose, Node.js 22, and pnpm 10.26.

```bash
pnpm selfhost:setup
pnpm selfhost:up
```

Open <http://localhost:3000> and sign in with the email and generated password printed by the setup command. Connect a supported local AI subscription from the workspace to ask for edits; without a connection you can open and view documents.

The Compose profile uses its private connector by default. The optional user-device flow used by hosted deployments is available with `SPELLBOOK_AI_CONNECTOR_MODE=local` and `pnpm connector:start`; see [self-hosting](docs/delivery/self-hosting.md) for the exact boundary and current verification status.

Run `pnpm selfhost:doctor` to validate configuration and service health.

`pnpm selfhost:up` builds the services, waits for their health checks and then
removes unused Spellbook service images automatically, including after failed
builds or starts. `pnpm docker:cleanup` shows the exact plan; its explicit
`--execute` mode keeps every image used by a container and removes all unused
Spellbook images plus unused build cache. Persistent document and database
volumes are never part of this cleanup.

## Product contract

- The uploaded file remains the immutable original.
- Edits create versions; accepted versions remain editable files, not flattened images.
- The AI receives the current rendered view plus format-specific structure and permissions.
- A changed candidate is rendered and structurally validated before it can be presented for approval.
- Unsupported constructs are preserved or blocked, never silently rewritten.

See [the architecture](docs/architecture/document-platform.md), [format status](docs/product/format-support.md), [multi-format roadmap](docs/product/multiformat-roadmap.md), and [open-core boundary](docs/architecture/open-core-boundary.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:e2e
```

The public boundary test fails if hosted infrastructure, private identities, credentials, or private corpus paths enter this repository.

The regression catalog is committed, but upstream PPTX binaries are not. Fetch the pinned, hash-checked corpus into the ignored `eval/public/downloads/` directory when you need fidelity tests. The renderer image and release are recorded with the coverage report, so name the build the references were rendered with:

```bash
pnpm corpus:fetch-public -- \
  --renderer-image <renderer-image> \
  --renderer-version <renderer-release>
```

## License

Spellbook-authored source, including the Rust document engine, is licensed under MPL-2.0. Third-party components and adapted files retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSES/`.
