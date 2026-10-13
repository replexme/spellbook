# Document resources

Shared server-side helpers the web app and the self-hosted services use:

- `object-store.mjs`: the self-hosted object store (files under `SPELLBOOK_DATA_DIR`) with
  create-only writes, reads and deletion. Managed hosts substitute their own adapter.
- `public-address.mjs`: whether an address is a public internet address, used before the
  web app fetches a page the AI asked to read.
