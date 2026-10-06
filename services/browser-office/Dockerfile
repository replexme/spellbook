# The selected pinned distribution must be staged locally before this image is built.
# This build bundles host JavaScript only; no engine/WASM compilation or download.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY contracts ./contracts
COPY services/browser-office ./services/browser-office
COPY services/office-session-spike ./services/office-session-spike
COPY services/office-editor/extension ./services/office-editor/extension
COPY apps/web/src/lib/local-ai-connector.ts apps/web/src/lib/ai-connector-config.ts ./apps/web/src/lib/
COPY apps/web/src/design-system ./apps/web/src/design-system
COPY LICENSES ./LICENSES
RUN node services/browser-office/onlyoffice/build-workspace.mjs
RUN node --input-type=module -e "import {admitSelectedOnlyOffice} from './services/browser-office/engine-selection.mjs'; await admitSelectedOnlyOffice('services/browser-office/onlyoffice/distribution');"
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.spellbook.component="browser-office"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
WORKDIR /app
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade --yes \
    && rm -rf \
      /var/lib/apt/lists/* \
      /opt/yarn-v1.22.22 \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
COPY --from=build /workspace/services/browser-office ./services/browser-office
COPY --from=build /workspace/services/office-session-spike ./services/office-session-spike
COPY --from=build /workspace/apps/web/src/design-system ./apps/web/src/design-system
USER node
EXPOSE 4173 4174 4175
HEALTHCHECK --interval=10s --timeout=5s --retries=10 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "services/browser-office/serve.mjs"]
