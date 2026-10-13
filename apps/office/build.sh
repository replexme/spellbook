#!/usr/bin/env bash
# Builds the engine for the browser and the document view site.
#   apps/office/build.sh <out-dir> <host-origin,...>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:?out dir}"; origins="${2:?host origins}"
# wasm-bindgen-cli must match the wasm-bindgen crate in Cargo.lock:
#   cargo install wasm-bindgen-cli --version <that version> --locked
bindgen="${WASM_BINDGEN:-wasm-bindgen}"
want="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/, ""); print; exit}' "$root/Cargo.lock")"
"$bindgen" --version | grep -q " $want$" || { echo "wasm-bindgen $want is required (WASM_BINDGEN or PATH)" >&2; exit 1; }
cargo build --release --locked -p present-engine-wasm -p present-idml-wasm --lib --target wasm32-unknown-unknown --manifest-path "$root/Cargo.toml"
glue="$(mktemp -d)"
trap 'rm -rf "$glue"' EXIT
"$bindgen" --target web --out-dir "$glue" "$root/target/wasm32-unknown-unknown/release/present_engine_wasm.wasm"
"$bindgen" --target web --out-dir "$glue" "$root/target/wasm32-unknown-unknown/release/present_idml_wasm.wasm"
node "$here/build.mjs" --out "$out" --glue "$glue" --host-origins "$origins"
