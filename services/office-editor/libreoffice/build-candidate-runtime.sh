#!/usr/bin/env bash
set -euo pipefail

spellbook_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
candidate_engine_image="${1:-}"
target_image="${2:-spellbook-office-editor:candidate}"

if [[ ! "$candidate_engine_image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "Usage: $0 <candidate-engine@sha256:digest> [target-image:tag]" >&2
  exit 1
fi
if [[ "$target_image" == *@sha256:* ]]; then
  echo "The output runtime must use a mutable local tag; pin it by digest after registry push." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is required to build the Spellbook Office runtime." >&2
  exit 1
fi

if [[ -n "$(git -C "$spellbook_repo_root" status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to label a release runtime from a dirty Spellbook worktree." >&2
  exit 1
fi
source_revision="${SPELLBOOK_SOURCE_REVISION:-$(git -C "$spellbook_repo_root" rev-parse HEAD)}"
if [[ ! "$source_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SPELLBOOK_SOURCE_REVISION must be a full Git commit." >&2
  exit 1
fi
if [[ "$source_revision" != "$(git -C "$spellbook_repo_root" rev-parse HEAD)" ]]; then
  echo "SPELLBOOK_SOURCE_REVISION must match the checked-out public commit." >&2
  exit 1
fi

candidate_env="$(mktemp "${TMPDIR:-/tmp}/spellbook-candidate-runtime.XXXXXX")"
cleanup() {
  local build_status=$?
  rm -f -- "$candidate_env" || build_status=1
  if ! node "$spellbook_repo_root/scripts/cleanup-local-docker.mjs" --execute --build-cache-only; then
    if [[ "$build_status" -eq 0 ]]; then build_status=1; fi
  fi
  exit "$build_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$spellbook_repo_root/services/office-editor/libreoffice/write-candidate-build-env.mjs" \
  "$candidate_env" "$candidate_engine_image"
source "$candidate_env"

docker pull "$COLLABORA_CANDIDATE_IMAGE" >/dev/null
docker build \
  --file="$spellbook_repo_root/services/office-editor/Dockerfile" \
  --build-arg="SPELLBOOK_COLLABORA_BASE_IMAGE=$COLLABORA_CANDIDATE_IMAGE" \
  --build-arg="SPELLBOOK_COLLABORA_ENGINE_PATCH_LEVEL=$COLLABORA_CANDIDATE_PATCH_LEVEL" \
  --build-arg="SPELLBOOK_PUBLIC_SOURCE_REVISION=$source_revision" \
  --build-arg="SPELLBOOK_COLLABORA_ENGINE_IMAGE=$COLLABORA_CANDIDATE_IMAGE" \
  --build-arg="SPELLBOOK_COLLABORA_PATCH_SERIES_SHA256=$COLLABORA_CANDIDATE_PATCH_SERIES_SHA256" \
  --build-arg="SPELLBOOK_COLLABORA_SOURCE_COMMIT=$COLLABORA_CANDIDATE_SOURCE_COMMIT" \
  --label="org.opencontainers.image.source=https://github.com/replex-me/spellbook" \
  --label="org.opencontainers.image.revision=$source_revision" \
  --label="org.spellbook.collabora-engine-image=$COLLABORA_CANDIDATE_IMAGE" \
  --label="org.spellbook.collabora-source-commit=$COLLABORA_CANDIDATE_SOURCE_COMMIT" \
  --label="org.spellbook.collabora-patch-series-sha256=$COLLABORA_CANDIDATE_PATCH_SERIES_SHA256" \
  --tag="$target_image" \
  "$spellbook_repo_root"

docker image inspect "$target_image" >/dev/null
echo "Built $target_image from the digest-pinned, native-tested candidate engine."
