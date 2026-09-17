#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The browser LibreOffice candidate build requires Linux." >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "The admitted browser toolchain currently requires Linux x86_64." >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "LibreOffice refuses root compilation; run as an unprivileged build user." >&2
  exit 1
fi

spellbook_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
upstream_reader="$spellbook_repo_root/services/browser-office/libreoffice/upstream.mjs"
source_repository="$(node "$upstream_reader" get source.repository)"
source_commit="$(node "$upstream_reader" get source.candidateCommit)"
patch_level="$(node "$upstream_reader" get sourceCandidate.patchLevel)"
mapfile -t wasm_modules < <(node "$upstream_reader" get sourceCandidate.wasmModules)
wasm_modules_arg="${wasm_modules[*]}"
expected_patch_sha="$(node "$upstream_reader" get sourceCandidate.patchSeriesSha256)"
actual_patch_sha="$(node "$upstream_reader" patch-series-sha256)"
patch_series_ready="$(node "$upstream_reader" get sourceCandidate.patchSeriesReady)"
emsdk_commit="$(node "$upstream_reader" get toolchain.emsdk.commit)"
emscripten_commit="$(node "$upstream_reader" get toolchain.emscripten.commit)"
qt_commit="$(node "$upstream_reader" get toolchain.qt.commit)"
qtbase_commit="$(node "$upstream_reader" get toolchain.qt.qtbaseCommit)"

if [[ "$patch_series_ready" != "true" || "$actual_patch_sha" != "$expected_patch_sha" ]]; then
  echo "The exact browser patch series must pass source admission before building." >&2
  exit 1
fi
if [[ "$wasm_modules_arg" != "calc writer impress" ]]; then
  echo "The browser candidate must include Calc, Writer and Impress." >&2
  exit 1
fi
if [[ ! "${SPELLBOOK_SOURCE_REVISION:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SPELLBOOK_SOURCE_REVISION must identify the exact public source commit." >&2
  exit 1
fi
if [[ -z "${SPELLBOOK_BROWSER_BUILD_ROOT:-}" || "$SPELLBOOK_BROWSER_BUILD_ROOT" != /* ]]; then
  echo "SPELLBOOK_BROWSER_BUILD_ROOT must be an explicit absolute directory." >&2
  exit 1
fi
if [[ -z "${SPELLBOOK_BROWSER_OUTPUT_DIR:-}" || "$SPELLBOOK_BROWSER_OUTPUT_DIR" != /* ]]; then
  echo "SPELLBOOK_BROWSER_OUTPUT_DIR must be an explicit absolute directory." >&2
  exit 1
fi
if [[ "$SPELLBOOK_BROWSER_BUILD_ROOT" == "/" || "$SPELLBOOK_BROWSER_OUTPUT_DIR" == "/" ]]; then
  echo "Build and output directories cannot be the filesystem root." >&2
  exit 1
fi
if [[ ! -f "${SPELLBOOK_EMSDK_ENV:-}" || ! -x "${SPELLBOOK_QT5DIR:-}/bin/qmake" ]]; then
  echo "The pinned Emscripten and Qt toolchain is unavailable." >&2
  exit 1
fi

source "${SPELLBOOK_EMSDK_ENV}"
export CCACHE_DIR="$SPELLBOOK_BROWSER_BUILD_ROOT/ccache"
export QT5DIR="$SPELLBOOK_QT5DIR"
parallelism="${SPELLBOOK_BROWSER_BUILD_PARALLELISM:-$(nproc)}"
if [[ ! "$parallelism" =~ ^[1-9][0-9]*$ ]]; then
  echo "SPELLBOOK_BROWSER_BUILD_PARALLELISM must be a positive integer." >&2
  exit 1
fi

mkdir -p \
  "$SPELLBOOK_BROWSER_BUILD_ROOT" \
  "$SPELLBOOK_BROWSER_OUTPUT_DIR" \
  "$CCACHE_DIR" \
  "$SPELLBOOK_BROWSER_BUILD_ROOT/tarballs"

source_root="$SPELLBOOK_BROWSER_BUILD_ROOT/source"
source_identity="$source_commit:$patch_level:$expected_patch_sha"
source_marker="$SPELLBOOK_BROWSER_BUILD_ROOT/source.identity"
if [[ -f "$source_marker" ]]; then
  if [[ "$(<"$source_marker")" != "$source_identity" ]]; then
    echo "The preserved source tree belongs to a different candidate; use a new build root." >&2
    exit 1
  fi
elif [[ -e "$source_root" ]]; then
  echo "An unowned source tree already exists at $source_root." >&2
  exit 1
else
  git init --quiet "$source_root"
  git -C "$source_root" remote add origin "$source_repository"
  git -C "$source_root" fetch --quiet --depth=1 origin "$source_commit"
  git -C "$source_root" checkout --quiet --detach FETCH_HEAD
  node "$spellbook_repo_root/services/browser-office/libreoffice/verify-source.mjs" \
    --source "$source_root"
  while IFS= read -r relative_patch; do
    patch_path="$spellbook_repo_root/services/browser-office/$relative_patch"
    git -C "$source_root" apply --check --whitespace=error-all "$patch_path"
    git -C "$source_root" apply --whitespace=error-all "$patch_path"
  done < <(node "$upstream_reader" get sourceCandidate.patches)
  git -C "$source_root" diff --check
  git -C "$source_root" -c user.name=Spellbook -c user.email=build@invalid.example \
    commit --quiet --all --message="Apply $patch_level"
  printf '%s\n' "$source_identity" > "$source_marker"
fi

source_parent="$(git -C "$source_root" rev-parse HEAD^)"
if [[ "$source_parent" != "$source_commit" ]]; then
  echo "The preserved browser source does not descend from the pinned candidate." >&2
  exit 1
fi
if [[ "$(git -C /opt/emsdk rev-parse HEAD)" != "$emsdk_commit" || \
      "$(git -C /opt/emsdk/upstream/emscripten rev-parse HEAD)" != "$emscripten_commit" || \
      "$(git -C /opt/qt5 rev-parse HEAD)" != "$qt_commit" || \
      "$(git -C /opt/qt5/qtbase rev-parse HEAD)" != "$qtbase_commit" ]]; then
  echo "The installed browser toolchain differs from upstream.json." >&2
  exit 1
fi

tarballs="$SPELLBOOK_BROWSER_BUILD_ROOT/tarballs"
native_build="$SPELLBOOK_BROWSER_BUILD_ROOT/native"
native_marker="$SPELLBOOK_BROWSER_BUILD_ROOT/native-tests.$expected_patch_sha"
if [[ ! -f "$native_marker" ]]; then
  mkdir -p "$native_build"
  if [[ ! -f "$native_build/Makefile" ]]; then
    (
      cd "$native_build"
      "$source_root/autogen.sh" \
        --with-parallelism="$parallelism" \
        --with-external-tar="$tarballs" \
        --without-java \
        --without-junit \
        --without-help \
        --disable-odk \
        --disable-online-update \
        --disable-report-builder \
        --disable-scripting \
        --disable-skia \
        --enable-release-build \
        --with-lang="en-US" \
      --with-theme=colibre
    )
  fi
  # The focused Impress tests load real ODP/PPTX documents. The native test
  # target links bundled liblangtag but does not install its registry data on
  # this pinned branch, so language initialization falls back to the invalid
  # configure prefix and aborts document loading. Materialize the declared
  # LibreOffice external package before any test starts and fail with the
  # missing prerequisite instead of a secondary ViewTabBar teardown crash.
  make -C "$native_build" ExternalPackage_liblangtag_data
  if [[ ! -s "$native_build/instdir/share/liblangtag/language-subtag-registry.xml" ]]; then
    echo "The native test installation is missing the bundled liblangtag registry." >&2
    exit 1
  fi
  failed_cppunit_tests=()
  while IFS= read -r cppunit_test; do
    if [[ ! "$cppunit_test" =~ ^(CppunitTest_[A-Za-z0-9_]+):(test[A-Za-z0-9_]+)$ ]]; then
      echo "Invalid focused CppUnit test: $cppunit_test" >&2
      exit 1
    fi
    if ! make -C "$native_build" "${BASH_REMATCH[1]}" \
      CPPUNIT_TEST_NAME="${BASH_REMATCH[2]}"; then
      failed_cppunit_tests+=("$cppunit_test")
    fi
  done < <(node "$upstream_reader" get sourceCandidate.focusedCppunitTests)
  if (( ${#failed_cppunit_tests[@]} )); then
    printf 'Failed focused CppUnit tests (%s):\n' "${#failed_cppunit_tests[@]}" >&2
    printf '  %s\n' "${failed_cppunit_tests[@]}" >&2
    exit 1
  fi
  printf 'passed\n' > "$native_marker"
fi

wasm_build="$SPELLBOOK_BROWSER_BUILD_ROOT/wasm"
wasm_configuration="LibreOfficeWASM32:$wasm_modules_arg:en-US ko:colibre:release"
wasm_configuration_sha="$(printf '%s' "$wasm_configuration" | sha256sum | cut -d' ' -f1)"
wasm_configuration_marker="$SPELLBOOK_BROWSER_BUILD_ROOT/wasm.configuration"
wasm_marker="$SPELLBOOK_BROWSER_BUILD_ROOT/wasm.$expected_patch_sha.$wasm_configuration_sha"
wasm_filesystem_marker="$SPELLBOOK_BROWSER_BUILD_ROOT/wasm-filesystem.$expected_patch_sha.$wasm_configuration_sha"
mkdir -p "$wasm_build"
if [[ ! -f "$wasm_build/Makefile" ]] || \
   [[ ! -f "$wasm_configuration_marker" ]] || \
   [[ "$(<"$wasm_configuration_marker")" != "$wasm_configuration" ]]; then
  # The Korean browser package needs the translations submodule, but a normal
  # `git submodule update` downloads the complete multi-gigabyte history. Fetch
  # only the exact gitlink commit before configure. LibreOffice's `./g clone`
  # then sees an initialized submodule and reuses it without changing the
  # source tree or weakening the pinned-commit receipt.
  git -C "$source_root" submodule sync -- translations
  git -C "$source_root" submodule update \
    --init \
    --depth=1 \
    --recommend-shallow \
    --progress \
    translations
  translations_commit="$(git -C "$source_root/translations" rev-parse HEAD)"
  translations_gitlink="$(git -C "$source_root" rev-parse HEAD:translations)"
  if [[ "$translations_commit" != "$translations_gitlink" ]]; then
    echo "The shallow translations checkout differs from the pinned gitlink." >&2
    exit 1
  fi
  (
    cd "$wasm_build"
    "$source_root/autogen.sh" \
      --with-parallelism="$parallelism" \
      --with-external-tar="$tarballs" \
      --with-distro=LibreOfficeWASM32 \
      --with-wasm-module="$wasm_modules_arg" \
      --with-build-platform-configure-options=--enable-ccache \
      --enable-ccache \
      --enable-release-build \
      --with-lang="en-US ko" \
      --with-theme=colibre
  )
  printf '%s\n' "$wasm_configuration" > "$wasm_configuration_marker"
fi
if ! grep -qx 'export ENABLE_WASM_STRIP_BASIC_DRAW_MATH_IMPRESS=' "$wasm_build/config_host.mk"; then
  echo "The configured WASM runtime still strips Impress." >&2
  exit 1
fi
if [[ ! -f "$wasm_marker" ]]; then
  make -C "$wasm_build" build
  printf 'built\n' > "$wasm_marker"
fi
if [[ ! -f "$wasm_filesystem_marker" ]]; then
  # LibreOffice's recursive top-level build may refresh the packaged data
  # after soffice.js was linked. scp2 owns AutoInstall template variables
  # required by static, so complete these dependent stages in order;
  # unchanged objects and package pre-JS are reused by gbuild.
  make -C "$wasm_build" scp2
  make -C "$wasm_build" static
  make -C "$wasm_build" desktop
fi

installation_root="$wasm_build/workdir/installation/LibreOffice/emscripten"
for artifact in soffice.js soffice.data.js.metadata soffice.wasm soffice.data; do
  if [[ ! -s "$installation_root/$artifact" ]]; then
    echo "The WASM build did not produce $artifact." >&2
    exit 1
  fi
  install -m 0644 "$installation_root/$artifact" "$SPELLBOOK_BROWSER_OUTPUT_DIR/$artifact"
done

brotli --force --quality=11 "$SPELLBOOK_BROWSER_OUTPUT_DIR/soffice.wasm"
brotli --force --quality=11 "$SPELLBOOK_BROWSER_OUTPUT_DIR/soffice.data"
node "$spellbook_repo_root/services/browser-office/libreoffice/write-build-receipt.mjs" \
  --runtime-dir "$SPELLBOOK_BROWSER_OUTPUT_DIR" \
  --output "$SPELLBOOK_BROWSER_OUTPUT_DIR/build-receipt.json"
printf 'linked\n' > "$wasm_filesystem_marker"

echo "Built $patch_level once; native tests, raw artifacts, compressed assets and receipt are in $SPELLBOOK_BROWSER_OUTPUT_DIR."
