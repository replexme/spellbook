# Spellbook

[English](README.md) | [한국어](docs/README.ko.md)

Spellbook opens an existing document in a real browser editor, lets a person and an AI work on the same editable file, and checks the result against both the document structure and the rendered screen before it is accepted.

The current usable vertical is **PowerPoint (`.pptx`)**. DOCX and Spellbook's native page-layout format are planned adapters; they are not advertised as working features yet.

## What is public

This repository is the complete self-hosted product: the web workspace, WOPI host, AI connector, PPTX structure-preserving editor, LibreOffice renderer customizations, and public evaluation harness. It does not require Replex accounts or Google Cloud.

The hosted Replex service adds private deployment, billing, entitlement, managed identity, managed credential storage, and private evaluation data outside this repository. Hosted modules depend on this public core; the public core never imports hosted modules.

## Run locally

Prerequisites: Docker with Compose, Node.js 22, and pnpm 10.26.

```bash
pnpm selfhost:setup
pnpm selfhost:up
```

Open <http://localhost:3000> and sign in with the email and generated password printed by the setup command. Connect a supported local AI subscription from the workspace when you want AI editing; direct editing remains available without an AI connection.

The Compose profile uses its private connector by default. The optional user-device flow used by hosted deployments is available with `SPELLBOOK_AI_CONNECTOR_MODE=local` and `pnpm connector:start`; see [self-hosting](docs/delivery/self-hosting.md) for the exact boundary and current verification status.

The first build downloads pinned LibreOffice and Collabora images and can take several minutes. Subsequent starts reuse the images and persistent volumes. Run `pnpm selfhost:doctor` to validate configuration and service health.

`pnpm selfhost:up` builds the services, waits for their health checks and then
retires old Spellbook service images automatically. Runtime images carry a
Spellbook component label so this lifecycle never prunes another project's
Docker data. `pnpm docker:cleanup` shows the exact plan; its explicit
`--execute` mode keeps every image used by a container plus one unused rollback
per component and removes only older Spellbook images. Persistent document and
database volumes are never part of this cleanup.

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

The regression catalog is committed, but upstream PPTX binaries are not. Fetch the pinned, hash-checked corpus into the ignored `eval/public/downloads/` directory when you need fidelity tests. The renderer image and release are recorded with the coverage report, so name the LibreOffice build the references were rendered with:

```bash
pnpm corpus:fetch-public -- \
  --renderer-image <libreoffice-image> \
  --renderer-version <libreoffice-release>
```

## License

Spellbook-authored source is licensed under MPL-2.0. Third-party components and adapted files retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSES/`.
