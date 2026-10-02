# Self-hosting

## Requirements

- Docker Engine or Docker Desktop with Compose v2
- 4 CPU cores, 8 GB RAM and 10 GB free disk for a practical first build
- Node.js 22 and pnpm 10.26 for setup and verification
- outbound access during the first build for pinned base images and font/LibreOffice downloads

The document worker builds natively for both `linux/amd64` and `linux/arm64`. It installs the same pinned LibreOffice 26.8.0.3 Debian backport on both architectures and publishes the .NET worker for Docker's target architecture. This avoids x86 emulation on Apple Silicon. Architecture is still part of the renderer identity: fidelity reports must record it and compare both targets before a tagged beta.

## Start

```bash
pnpm install --frozen-lockfile
pnpm selfhost:setup
pnpm selfhost:up
pnpm selfhost:doctor
```

The setup command creates `.env` with mode `0600`, generates independent secrets, creates a persistent 4096-bit Collabora WOPI proof key under the ignored `.spellbook/secrets/` directory and prints the initial password once. Re-running setup preserves both `.env` and the proof key. Open `http://localhost:3000`, log in, then connect Codex from the AI panel if AI editing is needed.

The start command removes unused Spellbook service images before building,
starts the new services in detached mode, waits for all declared health checks
and runs cleanup again, including when building or starting fails. It preserves
every image referenced by a container and removes every unused Spellbook image
plus unused build cache. The cleanup recognizes exact legacy Compose image
names during migration. It preserves other projects' images, containers and
data volumes. Run `pnpm docker:cleanup` to inspect the plan without changing state.

`SPELLBOOK_EDITOR_MODE` selects exactly one live editor engine. The default
`wopi` profile starts the server-side Collabora editor while the browser engine
is still being promoted. Set it to `browser` to start the client-side Office
runtime instead; `pnpm selfhost:up` stops the inactive engine before starting
the selected profile, so browser mode does not retain Collabora's runtime
memory cost. The browser endpoint defaults to `http://localhost:4173` through
`SPELLBOOK_BROWSER_OFFICE_PUBLIC_URL`.

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

`database-data` holds metadata and version lineage. `document-data` holds uploaded documents, derived renders and job receipts. `ai-auth-data` is mounted only into the AI connector and holds its provider runtime home. `.spellbook/secrets/wopi-proof-key.pem` is the stable identity that lets the host authenticate Collabora requests across restarts. A usable document backup requires a consistent copy of the database and document volumes plus this proof key; back up the AI volume separately if reconnecting the provider is not acceptable.

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

The command pauses only the services that can write state, makes a PostgreSQL custom-format dump, archives both persistent application volumes, copies `.env` and the stable WOPI proof key, then writes a manifest containing byte lengths and SHA-256 digests. Services that were running before the backup are resumed even if the backup fails. The default destination is an ignored, mode-`0700` directory under `.spellbook/backups/`; use `--output=/encrypted/path/name` to place it elsewhere.

Restore replaces the named Compose project's database and application volumes, so it requires an exact project-name confirmation:

```bash
pnpm selfhost:restore -- --backup=.spellbook/backups/<name> --confirm=spellbook
```

Add `--restore-config` only for disaster recovery when `.env` and the proof key must also be restored. Add `--start` when restoring into a new project that had no running services. The command verifies every declared file before it stops or replaces target data. If restore fails after replacement begins, it intentionally leaves application services stopped instead of exposing a partial restore; correct the cause and rerun the same verified backup.

Backup archives contain the database, documents, AI provider login state, application secrets and the WOPI private key in plaintext. Store them only on access-controlled encrypted storage, never commit them, and restore only an archive obtained from a trusted operator. SHA-256 detects accidental corruption; it does not make an untrusted backup safe or prove who created it. Run `pnpm selfhost:doctor` and one real open/edit/save/download smoke test after restoration.

The original upload is immutable. Deleting the Compose stack with `docker compose down` keeps volumes. Adding `--volumes` destroys document and database data and must not be used as a routine reset.

## Network and TLS

Only the web application and the selected editor endpoint are published by the local profile. Worker ports stay on the private Compose network and require an internal token. For internet exposure, terminate TLS at a reverse proxy, set the active editor's public URL to its HTTPS origin, restrict frame ancestors, and do not publish PostgreSQL or worker ports.

WOPI access tokens are scoped to one document session and use a secret distinct from service-to-service authentication. Collabora signs each WOPI request with the stable installation key advertised in discovery. The host verifies the three rotation-safe proof combinations defined by WOPI, rejects timestamps outside a 20-minute window and refreshes cached discovery keys after a mismatch or old-key match. Keep `SPELLBOOK_WOPI_PROOF_MODE=required`; disabling it is only for isolated development tests. Internet exposure still requires TLS termination and an applicable WOPI conformance run against the deployed HTTPS origin.

## Fonts and fidelity

The default image installs redistributable metric-compatible and Korean fallback fonts. It cannot lawfully bundle every Microsoft desktop font. Install fonts you are entitled to use into a private derived image, rebuild the font cache and run the public corpus. Missing fonts are surfaced in the document graph; they are not silently treated as fidelity success.

## Scaling boundary

The default dispatcher accepts work over the private HTTP network and workers persist completion receipts. Accepted but unfinished jobs become eligible for redelivery after `SPELLBOOK_JOB_REDELIVERY_SECONDS` (15 seconds by default). A running worker deduplicates repeat deliveries in memory; after a restart it either resumes from the durable receipt or safely reruns the version-isolated job. This is sufficient for one-worker Compose recovery, but it is not a distributed queue. Multi-node hosting must supply a durable queue adapter, shared leases, rate limits and storage concurrency controls downstream without changing the document adapter contract.

Native AI work has a stricter boundary because it may already have changed the
live canvas. Once a connector claims a turn it sends a heartbeat every 15
seconds. If that heartbeat is absent for 60 seconds, the next browser poll
fails the job and unfinished browser tasks visibly instead of replaying the
edit. The open native session remains available so the user can inspect the
slide and submit a new request.

## Live smoke test

After uploading a PPTX, copy its UUID from the document URL and run:

```bash
SPELLBOOK_SELFHOST_DOCUMENT_ID=<uuid> pnpm test:selfhost
```

The test reuses an unexpired local session cookie when one exists. For a loopback self-host target only, it can instead derive a short-lived session in memory from the local `.env`; remote targets still require an explicit unexpired cookie. It opens the real Collabora canvas, waits for the Spellbook extension bridge, changes an actual slide text object, saves it through WOPI, downloads the resulting PPTX, validates the ZIP package and checks the changed slide XML. It writes screenshots and the downloaded test file only under the ignored `.tmp-runtime/evidence/` directory.
