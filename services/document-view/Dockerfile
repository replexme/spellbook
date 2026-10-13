# The browser document view: the document engine compiled to WebAssembly (engine/, formats/)
# and the page that shows documents and runs the AI's edits (apps/office), served as a
# static site. The web app embeds it; only SPELLBOOK_APP_ORIGIN may frame it.
# Build from the repository root:
#   docker build -f services/document-view/Dockerfile --build-arg SPELLBOOK_APP_ORIGIN=https://app.example .

FROM rust:1.92-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS wasm
WORKDIR /src
COPY rust-toolchain.toml ./
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock ./
# The wasm-bindgen program must match the wasm-bindgen crate in Cargo.lock.
RUN version="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/, ""); print; exit}' Cargo.lock)" \
    && cargo install wasm-bindgen-cli --version "$version" --locked
COPY engine ./engine
COPY formats ./formats
RUN cargo build --release --locked -p present-engine-wasm -p present-idml-wasm --lib --target wasm32-unknown-unknown \
    && wasm-bindgen --target web --out-dir /glue target/wasm32-unknown-unknown/release/present_engine_wasm.wasm \
    && wasm-bindgen --target web --out-dir /glue target/wasm32-unknown-unknown/release/present_idml_wasm.wasm

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS site
ARG SPELLBOOK_APP_ORIGIN=http://localhost:3000
WORKDIR /src
COPY engine/vendor ./engine/vendor
COPY apps/office ./apps/office
COPY --from=wasm /glue /glue
RUN node apps/office/build.mjs --out /site --glue /glue --host-origins "$SPELLBOOK_APP_ORIGIN" --cache /tmp/font-cache

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
LABEL org.spellbook.component="document-view"
ARG SPELLBOOK_APP_ORIGIN=http://localhost:3000
ENV SPELLBOOK_APP_ORIGIN=$SPELLBOOK_APP_ORIGIN
COPY services/document-view/Caddyfile /etc/caddy/Caddyfile
COPY --from=site /site /srv
EXPOSE 4173
