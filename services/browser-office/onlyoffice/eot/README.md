# Embedded-font decoder

This MPL-2.0 libeot decoder reads edit-enabled EOT faces already carried inside
an owned presentation. Customer font bytes travel through disposable workers
and a document-owned memory context. They are never placed in the public font
catalog, HTTP font responses, service-worker program cache or global font folder.

The source snapshot and its LICENSE/PATENTS files are under `source/libeot`.
The adapter limits input/output faces to32MiB and the decoder's linear memory to
128MiB. The native FreeType worker uses the admitted ONLYOFFICE engine to read
face metadata; its allocation contract is separate from this decoder limit.
Each face worker has a5second processing deadline and is then terminated.
Existing Hangul-coverage admission is preserved. Unsupported faces retain the
native fallback and a document-scoped reason rather than being silently admitted.

A sparse subset previously preallocated the maximum possible outline size of
all glyphs (over140MiB for one2.28MiB decoded font). The supplied libeot change
uses bounded amortized growth while preserving the decoded native bytes.

Rebuild locally with pinned Emscripten4.0.11:

```
python3 build-decoder.py --emcc /path/to/emcc
```

`build-receipt.json` records relative source hashes, command, compiler and output
hashes. The workspace source archive includes the complete preferred source,
patch, notices, rebuild script and decoder outputs. No vendor engine is rebuilt
by `build-workspace.mjs`.
