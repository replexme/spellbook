# Build the same selected browser distribution and host bundle used by the editor.
# The vendor distribution is staged locally; this stage does not compile WASM.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS office
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .dockerignore docker-compose.yml ./
RUN pnpm install --frozen-lockfile
COPY contracts ./contracts
COPY services/browser-office ./services/browser-office
COPY services/document-resources ./services/document-resources
COPY services/office-session-spike ./services/office-session-spike
COPY services/office-editor/extension ./services/office-editor/extension
COPY apps/web/src/lib/local-ai-connector.ts apps/web/src/lib/ai-connector-config.ts ./apps/web/src/lib/
COPY apps/web/src/design-system ./apps/web/src/design-system
COPY LICENSES ./LICENSES
RUN node services/browser-office/onlyoffice/build-workspace.mjs \
    && node --input-type=module -e "import {admitSelectedOnlyOffice} from './services/browser-office/engine-selection.mjs'; await admitSelectedOnlyOffice('services/browser-office/onlyoffice/distribution');" \
    && chmod -R a+rX services/browser-office

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
      --runtime "$runtime_id" --self-contained true
RUN case "$TARGETARCH" in \
      amd64) runtime_id=linux-x64 ;; \
      arm64) runtime_id=linux-arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && dotnet publish services/document-worker/tools/Spellbook.Document.Tool/Spellbook.Document.Tool.csproj \
      --configuration Release --output /app/tool --no-restore \
      --runtime "$runtime_id" --self-contained true

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime
LABEL org.spellbook.component="document-worker"
RUN apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates chromium fonts-dejavu-core libicu76 libgssapi-krb5-2 libssl3t64 tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /data /tmp/spellbook-user && chown -R 1000:1000 /data /tmp/spellbook-user
COPY --from=build /app/publish .
COPY --from=build /app/tool ./tool
COPY --from=office /usr/local/bin/node /usr/local/bin/node
COPY --from=office /workspace/node_modules ./node_modules
COPY --from=office /workspace/services/browser-office ./services/browser-office
COPY --from=office /workspace/services/document-resources ./services/document-resources
COPY --from=office /workspace/services/office-session-spike ./services/office-session-spike
COPY --from=office /workspace/apps/web/src/design-system ./apps/web/src/design-system
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0 \
    SPELLBOOK_RENDER_TIME_ZONE=Asia/Seoul \
    SPELLBOOK_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    HOME=/tmp/spellbook-user
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["./Spellbook.Document.Worker"]
