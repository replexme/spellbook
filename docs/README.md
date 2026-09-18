# Documentation map

The repository is governed by a small set of documents with distinct jobs:

- [Document platform](architecture/document-platform.md): dependency direction and format-adapter architecture.
- [Open-core boundary](architecture/open-core-boundary.md): what may enter this public repository and what remains in a hosted-service overlay.
- [Browser editing engine](../services/office-editor/libreoffice/README.md): upstream pins, patch series and promotion workflow.
- [Headless render engine](../services/document-worker/libreoffice/README.md): PowerPoint-fidelity patch and upgrade workflow.
- [Format support](product/format-support.md): the user-visible support truth for each document type.
- [Design system](product/design-system.md): the four layers every product screen is built from, the colour roles and the rules for verification wording.
- [Multi-format roadmap](product/multiformat-roadmap.md): how PPTX becomes one adapter without flattening DOCX or page-layout semantics.
- [Self-hosting](delivery/self-hosting.md): installation, secrets, storage and operational requirements.
- [Storage-pressure verification](delivery/storage-pressure-verification-2026-09-15.md): packaged runtime evidence for atomic rejection and durable failure receipts under disk pressure.
- [Release gates](delivery/release-gates.md): evidence required before a public release can be called usable.
- [Product completion](delivery/product-completion.md): binary completion contract for the full public product and its required evidence.
- [Local AI connector verification](delivery/connector-runtime-verification-2026-09-13.md): source and packaged macOS connector evidence and remaining distribution gates.
- [Local runtime evidence](delivery/runtime-verification-2026-09-11.md): the exact end-to-end path verified before the first public push.
- [Research record](research/open-core-selfhost-research-2026-09-11.md): external evidence and the decisions derived from it.

Status documents report evidence; they do not override these contracts. A format is available only when both the machine-readable registry in `contracts/document-formats.json` and the support document say so.
