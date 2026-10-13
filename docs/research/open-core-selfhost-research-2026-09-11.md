# Open-core and self-host architecture research

Date: 2026-09-11

Note (2026-10-13): this is a dated record. The WOPI host, Collabora and LibreOffice sections describe editors and a renderer that have since been removed; the current structure is in [Document platform architecture](../architecture/document-platform.md). The identity, open-core, license and repository-security findings still apply.

## Executive conclusion

The correct public boundary is a runnable product with local identity, local storage, the browser editor, document adapters, WOPI host, AI connector and evaluation harness. Publishing only the PPTX engine would not deliver the experience being evaluated and would make “self-hosted” misleading. The Replex-hosted product should remain a downstream overlay containing identity, billing, entitlement, cloud adapters, deployment and private operational evidence.

Expansion beyond PowerPoint changes the architecture in one decisive way: the common platform must stop at lifecycle, permission, version and evidence contracts. It must not turn today's slide graph into a universal document model. PPTX, DOCX and a future native page-layout format need separate semantic adapters and validators.

## Evidence and resulting decisions

### Identity

OpenID Connect defines issuer metadata discovery at a standard well-known location.[^1] Therefore multi-user self-hosting should add a provider-neutral OIDC port rather than embedding Replex or another vendor. A single local owner with a salted password hash is the smaller honest v1; it is not presented as enterprise identity.

### WOPI boundary

Microsoft's WOPI documentation treats the host as the authority for stable file IDs, access tokens, file content and locks; locks are opaque values with specified size and expiry behavior.[^2] PutFile and the endpoint catalog define save semantics independently of the editor implementation.[^3][^4] Microsoft also publishes proof-key verification, a validator and host quality requirements for integrations.[^5][^6][^7] Consequently Spellbook keeps WOPI tokens document-scoped, separates their signing secret from internal service authentication, and makes proof-key verification plus validator success a public-hosting gate rather than claiming the local flow is production-complete.

### Container startup and failure reporting

Docker Compose does not consider a dependency ready merely because its process started; health checks and `service_healthy` dependencies are the intended readiness mechanism.[^8] The Compose profile therefore gates the web process on database, workers and editor health. User-visible progress must still distinguish job acceptance, render readiness and first editable frame.

### Collabora distribution

Collabora's official container notes say the CODE brand package is not open source and document a `nobrand=yes` source build for a fully open-source result; the same guidance recommends a dedicated seccomp profile.[^9] The Collabora Online repository is primarily MPL-2.0 but includes separately licensed parts.[^10] Spellbook therefore pins the upstream image, carries notices, does not publish a derived image in the initial release, and removes local replacement of Collabora branding assets. A public image requires a separate no-brand/source and trademark review.

### Open-core license

Mozilla describes MPL-2.0 as file-level copyleft: changes to MPL-covered files remain covered, while separate files in a larger work can use different terms.[^11] That fits a public document platform with separately authored hosted adapters better than a permissive license that allows silent proprietary forks, while avoiding whole-work copyleft. This is an engineering recommendation, not legal advice; contributors and third-party distributions still need license review.

REUSE provides a machine-readable way to associate copyright and SPDX license identifiers with every file, including generated or non-commentable files.[^12] Spellbook uses a root `REUSE.toml`, license texts and third-party notices; CI should add a REUSE lint job before the first tagged release.

### Repository security

GitHub's repository security guidance recommends a security policy, dependency visibility/review, CodeQL and secret scanning with push protection where available.[^13] The public repo includes a private reporting route and boundary scan. CodeQL, dependency review and secret scanning must be enabled at the repository layer after creation; a local file cannot prove those provider settings.

### OOXML engine

The Open XML SDK is MIT-licensed and provides direct manipulation of Open XML packages.[^14] Spellbook uses direct package-level edits for the narrow changed surface and treats LibreOffice as editor/renderer, avoiding a full import/export rewrite for AI patches. This supports the minimum-intrusion invariant but does not prove visual fidelity; only the reference corpus can do that.

### Multi-architecture LibreOffice worker

Debian publishes LibreOffice Impress 26.8.0.3 in the trixie-backports suite for both amd64 and arm64.[^15] Using that single package lineage on both targets removes QEMU from Apple Silicon's document-processing path without creating two product feature sets. Architecture remains part of the render baseline because identical package versions do not prove identical font rasterization or layout output.

## Alternatives considered

| Alternative                                                 | Decision | Reason                                                                                                          |
| ----------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| Publish only the document engine                            | Reject   | Runnable self-hosting and the human/AI shared-editor loop would be absent.                                      |
| Publish the current hosted monolith                         | Reject   | It would expose operational details and still depend on private identity/infrastructure.                        |
| Put hosted and public code in one branch with runtime flags | Reject   | Secrets and boundary drift become review problems inside every file.                                            |
| Maintain unrelated public and private forks                 | Reject   | Document fixes diverge and private behavior becomes the accidental source of truth.                             |
| Public upstream plus private downstream adapters            | Adopt    | One document engine and UX; hosted-specific capabilities remain outside the public dependency graph.            |
| Convert every format into a Spellbook intermediate format   | Reject   | Round-trip fidelity and native editability would be lost at the exact boundary the product promises to protect. |

## Remaining research and release risks

- The default Collabora image path must be runtime-tested without branding replacement and reviewed before any derived image distribution.
- WOPI proof-key validation is not implemented in the local beta profile.
- The public Compose dispatcher is not a crash-durable queue.
- Codex subscription connection is implemented; additional providers are not.
- DOCX and the native Spellbook format have registry entries and architecture only.
- PowerPoint-faithful visual claims require current PowerPoint reference exports, licensed fonts and hard-failure analysis, not only LibreOffice renders.
- Public corpus fixture licenses must be checked individually before a tagged release even when their source repositories are open.

## Sources

[^1]: OpenID Foundation, [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html).

[^2]: Microsoft Learn, [WOPI concepts](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/concepts).

[^3]: Microsoft Learn, [WOPI PutFile](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/putfile).

[^4]: Microsoft Learn, [WOPI REST endpoints](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/endpoints).

[^5]: Microsoft Learn, [WOPI proof keys](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/proofkeys).

[^6]: Microsoft Learn, [WOPI launch and validator](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/build-test-ship/shipping).

[^7]: Microsoft Learn, [WOPI host quality requirements](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/plus/host-quality-reqs).

[^8]: Docker Docs, [Control startup and shutdown order in Compose](https://docs.docker.com/compose/how-tos/startup-order/).

[^9]: Collabora Online, [CODE Docker image README](https://github.com/CollaboraOnline/online.mirror/blob/main/docker/README).

[^10]: Collabora Online, [source repository and licensing](https://github.com/CollaboraOnline/online).

[^11]: Mozilla, [MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

[^12]: REUSE, [Specification 3.3](https://reuse.software/spec/).

[^13]: GitHub Docs, [Quickstart for securing a repository](https://docs.github.com/en/code-security/getting-started/quickstart-for-securing-your-repository?apiVersion=2022-11-28).

[^14]: .NET Foundation, [Open XML SDK](https://github.com/dotnet/Open-XML-SDK).

[^15]: Debian, [libreoffice-impress in trixie-backports](https://packages.debian.org/trixie-backports/libreoffice-impress).
