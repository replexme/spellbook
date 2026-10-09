# Owned linked presentation images

The original PPTX remains the artifact authority. A document worker reads only
external image relationships that the original package actually consumes. It
resolves public HTTP(S) URLs with a bounded, pinned-DNS reader, validates raster
bytes with Chromium, and publishes an immutable account/document/source-SHA
snapshot. No browser receives a remote-fetch proxy.

The provider-neutral reader and writer take the existing storage adapter. The
selfhost uses `object-store.mjs`; managed hosts inject their own adapter and
retain its deletion semantics. An immutable create-only write is required. A
managed worker copies the winning verified snapshot into its private job
workspace for the native renderer. The preparation sidecar is worker-owned;
it is never part of the author file.

The authenticated browser API checks the current owned session revision before
returning the manifest or one content-addressed image. The SDK converter alone
receives a derived package with those images embedded. Editor checkpoints,
Undo/Redo, saved files, and journals continue to use the original relationships.
An in-memory render context rebinds unchanged URLs to approved edited source
bytes. A changed URL requires a newly prepared source snapshot.

Limits are 64 consumed relationships, 5 MB per raster, 16 million pixels, and
32 MB of unique raster content per source. PNG, GIF and baseline/progressive
JPEG are supported. Other external content stays in the original package and
is outside this image preparation contract. Unavailable or invalid resources
fail preparation rather than publishing an incomplete usable snapshot.

Ordinary files with no consumed external images make no resource-provider
calls during preparation. Reopening a published snapshot does not refetch its
URLs; edited children reuse validated parent content without reuploading it.
Document and account deletion remove snapshots with their existing owned
prefix. Version retention does not currently collect snapshots independently
of document deletion; storage accounting must include the full document prefix.

When adopting this code for a managed release, existing linked documents need
resource preparation by the new document worker before they are opened with
the new SDK. This is a release migration requirement, not evidence that an
older ready document already has an immutable snapshot. Build, authenticated
API checks, and native captures are separate from production deployment.
