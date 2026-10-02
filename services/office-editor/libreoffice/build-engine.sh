#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The official host-driven Collabora source build requires Linux." >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "LibreOffice refuses root compilation. Run this script as a regular user with Docker socket access." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "The build user cannot reach the Docker daemon. Grant that user Docker socket access without running the compiler as root." >&2
  exit 1
fi
node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ ! "$node_major" =~ ^[0-9]+$ || "$node_major" -lt 20 ]]; then
  echo "Collabora Online requires Node.js 20 or newer; verify the release toolchain before compiling LibreOffice." >&2
  exit 1
fi

# Release-candidate boundary only. Patch development belongs in
# A failed source candidate must return to a persistent incremental worktree;
# one counterexample should not trigger another complete Online image build.

spellbook_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
upstream_reader="$spellbook_repo_root/services/office-editor/libreoffice/upstream.mjs"
source_ref="${SPELLBOOK_COLLABORA_SOURCE_REF:-$(node "$upstream_reader" get source.ref)}"
source_commit="${SPELLBOOK_COLLABORA_SOURCE_COMMIT:-$(node "$upstream_reader" get source.commit)}"
source_repository="$(node "$upstream_reader" get source.repository)"
patch_level="$(node "$upstream_reader" get patchLevel)"
expected_patch_series_sha256="$(node "$upstream_reader" get patchSeriesSha256)"
actual_patch_series_sha256="$(node "$upstream_reader" patch-series-sha256)"
source_patch_series_ready="$(node "$upstream_reader" get sourcePatchSeriesReady)"
if [[ "$source_patch_series_ready" != "true" ]]; then
  echo "The Collabora patch series has not passed exact clean-source admission; sourcePatchSeriesReady must be true before a full image build." >&2
  exit 1
fi
if [[ "$actual_patch_series_sha256" != "$expected_patch_series_sha256" ]]; then
  echo "Expected Collabora patch series $expected_patch_series_sha256, got $actual_patch_series_sha256." >&2
  exit 1
fi
patch_files=()
while IFS= read -r value; do patch_files+=("$value"); done \
  < <(node "$upstream_reader" get patches)
patch_paths=()
for relative_patch in "${patch_files[@]}"; do
  patch_paths+=("$spellbook_repo_root/services/office-editor/libreoffice/$relative_patch")
done
cppunit_targets=()
while IFS= read -r value; do cppunit_targets+=("$value"); done \
  < <(node "$upstream_reader" get requiredCppunitTargets)
image_repository="${SPELLBOOK_COLLABORA_ENGINE_REPOSITORY:-spellbook-collabora-engine}"
image_tag="${SPELLBOOK_COLLABORA_ENGINE_TAG:-$(node "$upstream_reader" get engineImageTag)}"
if [[ -n "${SPELLBOOK_COLLABORA_BUILD_ROOT:-}" ]]; then
  # Cloud Build uses one stable path so compiler-cache keys survive between
  # otherwise isolated builds. Keep the accepted target exact: this script
  # removes it before and after use.
  build_root="$SPELLBOOK_COLLABORA_BUILD_ROOT"
  if [[ "$build_root" != "/workspace/.spellbook-collabora-build" ]]; then
    echo "SPELLBOOK_COLLABORA_BUILD_ROOT must be /workspace/.spellbook-collabora-build." >&2
    exit 1
  fi
  rm -rf -- "$build_root"
  mkdir -p "$build_root"
else
  build_root="$(mktemp -d /tmp/spellbook-collabora-build.XXXXXX)"
fi

build_completed=false
cleanup() {
  local build_status=$?
  if [[ "$build_root" == "/workspace/.spellbook-collabora-build" ]]; then
    # Cloud Build workers are disposable and this exact path is recreated on
    # every run, so leaving a partial tree there cannot provide an incremental
    # recovery path.
    rm -rf -- "$build_root" || build_status=1
  elif [[ "$build_root" == /tmp/spellbook-collabora-build.* ]]; then
    if [[ "$build_completed" == true ]]; then
      rm -rf -- "$build_root" || build_status=1
    else
      echo "Integrated build failed; preserving $build_root for diagnosis and incremental target rebuilds." >&2
    fi
  fi
  if ! node "$spellbook_repo_root/scripts/cleanup-local-docker.mjs" --execute --build-cache-only; then
    if [[ "$build_status" -eq 0 ]]; then build_status=1; fi
  fi
  exit "$build_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

source_root="$build_root/source"
patched_repository="$build_root/patched.git"
git init --quiet "$source_root"
git -C "$source_root" remote add origin "$source_repository"
# Release branches are discovery labels and can advance after publication.
# Fetch the manifest's immutable commit directly so a later upstream branch
# update cannot change or block a reproducible build.
git -C "$source_root" fetch --quiet --depth=1 origin "$source_commit"
git -C "$source_root" checkout --quiet --detach FETCH_HEAD
actual_commit="$(git -C "$source_root" rev-parse HEAD)"
if [[ "$actual_commit" != "$source_commit" ]]; then
  echo "Expected Collabora $source_ref at $source_commit, got $actual_commit." >&2
  exit 1
fi

# Apply the declared patch series cumulatively. Later patches are allowed to
# extend code and tests introduced by earlier patches, so validating every
# patch against the pristine checkout would reject a valid ordered series.
for patch_path in "${patch_paths[@]}"; do
  git -C "$source_root" apply --check --whitespace=error-all \
    --directory=engine "$patch_path"
  git -C "$source_root" apply --whitespace=error-all \
    --directory=engine "$patch_path"
done
git -C "$source_root" diff --check
command_audit_report="$build_root/impress-command-surface.json"
node "$spellbook_repo_root/services/office-editor/libreoffice/audit-ai-command-surface.mjs" \
  --source "$source_root" > "$command_audit_report"
git -C "$source_root" -c user.name=Spellbook -c user.email=build@invalid.example \
  commit --quiet --all --message="Apply Spellbook Impress compatibility patch series"
git -C "$source_root" branch "spellbook-$patch_level"
git clone --quiet --bare "$source_root" "$patched_repository"

export COLLABORA_ONLINE_REPO="file://$patched_repository"
export COLLABORA_ONLINE_BRANCH="spellbook-$patch_level"
export DOCKER_HUB_REPO="$image_repository"
export DOCKER_HUB_TAG="$image_tag"
export ENGINE_BUILD_TARGET="-j$(nproc)"
bash "$source_root/docker/from-source/build.sh"

# The image is not a release candidate unless the engine tests that exercise
# every patched Undo/identity path pass in the exact tree used for packaging.
# Run these after the full build so all shared test dependencies already exist.
engine_build_root="$source_root/docker/from-source/builddir/online/engine"
# The LibreOffice toplevel delegates named targets to recursive makes. Passing
# multiple CppunitTest targets together lets those submakes race while creating
# the same generated RDB and dependency files. Run suites sequentially while
# each suite still uses its own normal internal parallelism.
native_evidence_dir="${SPELLBOOK_NATIVE_EVIDENCE_DIR:-}"
if [[ -n "$native_evidence_dir" ]]; then
  mkdir -p "$native_evidence_dir"
  cp "$command_audit_report" "$native_evidence_dir/impress-command-surface.json"
fi
for cppunit_target in "${cppunit_targets[@]}"; do
  if [[ -z "$native_evidence_dir" ]]; then
    make -C "$engine_build_root" "$cppunit_target"
    continue
  fi
  if [[ ! "$cppunit_target" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "Invalid Cppunit target name: $cppunit_target" >&2
    exit 1
  fi
  set +e
  {
    printf 'Spellbook native suite: %s\n' "$cppunit_target"
    make -C "$engine_build_root" "$cppunit_target"
  } 2>&1 | tee "$native_evidence_dir/$cppunit_target.log"
  cppunit_status="${PIPESTATUS[0]}"
  set -e
  printf '%s\n' "$cppunit_status" > "$native_evidence_dir/$cppunit_target.status"
  if [[ "$cppunit_status" != 0 ]]; then
    echo "$cppunit_target failed with exit code $cppunit_status." >&2
    exit "$cppunit_status"
  fi
done

docker image inspect "$image_repository:$image_tag" >/dev/null
build_completed=true
echo "Built and engine-tested $image_repository:$image_tag from $source_ref with the verified patch series."
