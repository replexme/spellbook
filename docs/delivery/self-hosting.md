# Self-hosting

## Requirements

- Docker Engine or Docker Desktop with Compose v2
- 4 CPU cores, 8 GB RAM and 10 GB free disk for a practical first build
- Node.js 22 and pnpm 10.26 for setup and verification
- outbound access during the first build for pinned base images, dependencies and the document view's fallback fonts

The services are the web app, the document view (the Rust document engine compiled to WebAssembly, which shows documents and applies AI edits), the document worker (which draws previews with the engine's command-line programs `present-pptx` and `present-idml`; no LibreOffice), the AI connector and PostgreSQL.

## Start

```bash
pnpm install --frozen-lockfile
pnpm selfhost:setup
pnpm selfhost:up
pnpm selfhost:doctor
```

The setup command creates `.env` with mode `0600`, generates independent secrets and prints the initial password once. Local key files are kept under the ignored `.spellbook/secrets/` directory. Re-running setup preserves `.env` and those files. Open `http://localhost:3000`, log in, then connect Codex or Claude Code from the AI panel to ask for edits.

The start command removes unused Spellbook service images before building,
starts the new services in detached mode, waits for all declared health checks
and runs cleanup again, including when building or starting fails. It preserves
every image referenced by a container and removes every unused Spellbook image
plus unused build cache. The cleanup recognizes exact legacy Compose image
names during migration. It preserves other projects' images, containers and
data volumes. Run `pnpm docker:cleanup` to inspect the plan without changing state.

The default `internal` mode keeps the connector in the private Compose network. To exercise the same user-device boundary used by a hosted Spellbook service, set `SPELLBOOK_AI_CONNECTOR_MODE=local` in `.env`, recreate only the web container, and start the loopback connector on the user's computer:

```bash
docker compose up -d --no-deps --force-recreate web
pnpm connector:start
```

The connector listens only on `127.0.0.1:43127` and starts without product-specific configuration. Each HTTPS Spellbook site must open a local approval page that names its exact origin before it receives a short-lived, origin-bound session. Set `SPELLBOOK_CONNECTOR_ALLOWED_ORIGINS` only when an operator wants to restrict the connector to a fixed comma-separated allowlist. By default it uses the same local Codex login cache as the CLI and IDE extension, so an already signed-in user does not authenticate again. Set `SPELLBOOK_CODEX_AUTH_MODE=isolated` to use a separate Spellbook-only login instead. The approval session is stored in browser session storage and expires; Codex credentials stay on the user's computer and are never copied into Spellbook storage. Do not expose the connector port through a reverse proxy or bind it to a LAN interface.

On macOS, contributors can assemble the same connector as a standalone app:

```bash
pnpm connector:package:macos
```

The build bundles the connector, the pinned official Node runtime and the matching Codex executable; verifies the Node download checksum; injects the connector with Node's single-executable format; signs the app; and runs loopback health, origin-bound pairing and approval-page smoke checks. The ignored result is written under `artifacts/connector/`. Without `SPELLBOOK_MACOS_SIGN_IDENTITY`, the app receives an ad-hoc signature for local verification only. A downloadable public macOS build must use a Developer ID Application identity and pass Apple notarization; the current source build is not a substitute for that release gate.

## Data and backup

`database-data` holds metadata and version lineage. `document-data` holds uploaded documents, derived renders and job receipts. `ai-auth-data` is mounted only into the AI connector and holds its provider runtime home. A usable document backup requires a consistent copy of the database and document volumes plus `.env`; back up the AI volume separately if reconnecting the provider is not acceptable.

Web uploads, document-worker outputs and AI receipts preserve 512 MiB of free
space by default through `SPELLBOOK_STORAGE_RESERVE_BYTES`. Each adapter checks
the complete write size before creating an object, commits through an atomic
rename or link and removes temporary data after failure. Capacity exhaustion is
reported explicitly instead of replacing a valid object with a partial file.
Failure and completion receipts are capped at 1 MiB and use a separate 16 MiB
emergency margin, so rejecting a large write does not strand an accepted job
without a durable terminal result.
The reserve is an emergency operating margin, not a user quota; size the host
and retention policy for expected documents and keep the reserve enabled.

Create one consistent backup with:

```bash
pnpm selfhost:backup
```

The command pauses only the services that can write state, makes a PostgreSQL custom-format dump, archives both persistent application volumes, copies `.env` and the local key files, then writes a manifest containing byte lengths and SHA-256 digests. Services that were running before the backup are resumed even if the backup fails. The default destination is an ignored, mode-`0700` directory under `.spellbook/backups/`; use `--output=/encrypted/path/name` to place it elsewhere.

Restore replaces the named Compose project's database and application volumes, so it requires an exact project-name confirmation:

```bash
pnpm selfhost:restore -- --backup=.spellbook/backups/<name> --confirm=spellbook
```

Add `--restore-config` only for disaster recovery when `.env` and the local key files must also be restored. Add `--start` when restoring into a new project that had no running services. The command verifies every declared file before it stops or replaces target data. If restore fails after replacement begins, it intentionally leaves application services stopped instead of exposing a partial restore; correct the cause and rerun the same verified backup.

Backup archives contain the database, documents, AI provider login state, application secrets and local key files in plaintext. Store them only on access-controlled encrypted storage, never commit them, and restore only an archive obtained from a trusted operator. SHA-256 detects accidental corruption; it does not make an untrusted backup safe or prove who created it. Run `pnpm selfhost:doctor` and one real open/edit/save/download smoke test after restoration.

The original upload is immutable. Deleting the Compose stack with `docker compose down` keeps volumes. Adding `--volumes` destroys document and database data and must not be used as a routine reset.

## Network and TLS

Only the browser-facing endpoints (the web application and the document view) are published by the local profile. Worker ports stay on the private Compose network and require an internal token. For internet exposure, terminate TLS at a reverse proxy, serve the document view from an HTTPS origin, restrict frame ancestors, and do not publish PostgreSQL or worker ports.

## Fonts and fidelity

The document engine uses fonts embedded in the document. For other text, the document view ships redistributable fallback fonts (Noto Sans KR, Noto Serif KR, Liberation Sans and Liberation Serif; pinned in `apps/office/fonts.lock.json`). It cannot lawfully bundle Microsoft desktop fonts. Where the browser supports it, the document view offers to draw with fonts installed on the viewer's computer after the browser asks for permission. A substituted font is reported to the AI as a warning; it is not treated as fidelity success.

## Scaling boundary

The default dispatcher accepts work over the private HTTP network and workers persist completion receipts. Accepted but unfinished jobs become eligible for redelivery after `SPELLBOOK_JOB_REDELIVERY_SECONDS` (15 seconds by default). A running worker deduplicates repeat deliveries in memory; after a restart it either resumes from the durable receipt or safely reruns the version-isolated job. This is sufficient for one-worker Compose recovery, but it is not a distributed queue. Multi-node hosting must supply a durable queue adapter, shared leases, rate limits and storage concurrency controls downstream without changing the document adapter contract.

Native AI work has a stricter boundary because it may already have changed the
live document view. Once a connector claims a turn it sends a heartbeat every 15
seconds. If that heartbeat is absent for 60 seconds, the next browser poll
fails the job and unfinished browser tasks visibly instead of replaying the
edit. The open native session remains available so the user can inspect the
slide and submit a new request.
