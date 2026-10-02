#!/usr/bin/env bash
set -euo pipefail

spellbook_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
upstream_reader="$spellbook_repo_root/services/office-editor/libreoffice/upstream.mjs"
base_image="$(node "$upstream_reader" get runtimeImage)"
runtime_patch_level="$(node "$upstream_reader" get runtimePatchLevel)"
if [[ "${1:-}" == "--" ]]; then shift; fi
target_image="${1:-spellbook-office-editor:local}"

cleanup() {
  local build_status=$?
  if ! node "$spellbook_repo_root/scripts/cleanup-local-docker.mjs" --execute --build-cache-only; then
    if [[ "$build_status" -eq 0 ]]; then build_status=1; fi
  fi
  exit "$build_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build \
  --file="$spellbook_repo_root/services/office-editor/Dockerfile" \
  --build-arg="SPELLBOOK_COLLABORA_BASE_IMAGE=$base_image" \
  --build-arg="SPELLBOOK_COLLABORA_ENGINE_PATCH_LEVEL=$runtime_patch_level" \
  --tag="$target_image" \
  "$spellbook_repo_root"
