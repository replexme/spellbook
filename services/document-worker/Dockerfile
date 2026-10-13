# The document worker: safety scan, element graph and save checks (.NET), with previews and the
# font check from the document engine's programs present-pptx and present-idml (engine/,
# formats/), drawn with the fallback fonts the browser document view uses. No office suite.
# Build from the repository root: docker build -f services/document-worker/Dockerfile .

FROM rust:1.92-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS engine
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY engine ./engine
COPY formats ./formats
RUN cargo build --release --locked -p present-pptx --bin present-pptx -p present-idml --bin present-idml \
    && cp target/release/present-pptx target/release/present-idml /usr/local/bin/

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS fonts
WORKDIR /src
COPY apps/office/fonts.mjs apps/office/fonts.lock.json ./apps/office/
RUN node apps/office/fonts.mjs /fonts /licenses --cache /tmp/font-cache

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-noble AS build
ARG TARGETARCH
WORKDIR /src
COPY services/document-worker/Spellbook.Document.Worker.slnx ./services/document-worker/
COPY services/document-worker/src/Spellbook.Document.Core/Spellbook.Document.Core.csproj ./services/document-worker/src/Spellbook.Document.Core/
COPY services/document-worker/src/Spellbook.Document.Worker/Spellbook.Document.Worker.csproj ./services/document-worker/src/Spellbook.Document.Worker/
COPY services/document-worker/tools/Spellbook.Document.Tool/Spellbook.Document.Tool.csproj ./services/document-worker/tools/Spellbook.Document.Tool/
COPY services/document-worker/tests/Spellbook.Document.Tests/Spellbook.Document.Tests.csproj ./services/document-worker/tests/Spellbook.Document.Tests/
RUN case "$TARGETARCH" in \
      amd64) runtime_id=linux-x64 ;; \
      arm64) runtime_id=linux-arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && dotnet restore services/document-worker/Spellbook.Document.Worker.slnx --runtime "$runtime_id"
COPY services/document-worker/ ./services/document-worker/
RUN case "$TARGETARCH" in \
      amd64) runtime_id=linux-x64 ;; \
      arm64) runtime_id=linux-arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && dotnet publish services/document-worker/src/Spellbook.Document.Worker/Spellbook.Document.Worker.csproj \
      --configuration Release --output /app/publish --no-restore \
      --runtime "$runtime_id" --self-contained true \
    && dotnet publish services/document-worker/tools/Spellbook.Document.Tool/Spellbook.Document.Tool.csproj \
      --configuration Release --output /app/tool --no-restore \
      --runtime "$runtime_id" --self-contained true

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime
LABEL org.spellbook.component="document-worker"
RUN apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl libicu76 libgssapi-krb5-2 libssl3t64 tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /data && chown -R 1000:1000 /data
COPY --from=build /app/publish .
COPY --from=build /app/tool ./tool
COPY --from=engine /usr/local/bin/present-pptx /usr/local/bin/present-idml /app/
COPY --from=fonts /fonts /app/fonts
COPY --from=fonts /licenses /usr/share/doc/spellbook-fonts
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0 \
    SPELLBOOK_PPTX_ENGINE=/app/present-pptx \
    SPELLBOOK_IDML_ENGINE=/app/present-idml \
    SPELLBOOK_ENGINE_FONTS=/app/fonts
USER 1000:1000
# The engines run in the final image, also on a blurred shadow: threaded drawing (switched on
# when both engines are built together) once crashed on every one.
RUN /app/present-pptx blank /tmp/check.pptx \
    && /app/present-pptx render-all /tmp/check.pptx /tmp/check 1280 --fonts /app/fonts | grep -q slide-1.png \
    && printf '%s' '{"expectedVersion":0,"requestId":"check","commands":[{"op":"add_shape","slide":1,"preset":"rect","x":100,"y":100,"width":200,"height":100,"fill":"2563EB"},{"op":"set_shape_shadow","slide":1,"shapeId":4,"enabled":true,"blur":8}]}' > /tmp/shadow.json \
    && /app/present-pptx apply /tmp/check.pptx /tmp/shadow.json /tmp/shadow.pptx >/dev/null \
    && /app/present-pptx render-all /tmp/shadow.pptx /tmp/shadow 1280 --fonts /app/fonts | grep -q slide-1.png \
    && /app/present-idml blank /tmp/check.idml \
    && /app/present-idml render-all /tmp/check.idml /tmp/idml 1280 --fonts /app/fonts | grep -q page-1.png \
    && rm -rf /tmp/check /tmp/check.pptx /tmp/shadow /tmp/shadow.pptx /tmp/shadow.json /tmp/idml /tmp/check.idml
EXPOSE 8080
ENTRYPOINT ["./Spellbook.Document.Worker"]
