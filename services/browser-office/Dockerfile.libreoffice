FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY contracts ./contracts
COPY services/browser-office ./services/browser-office
COPY services/office-editor/extension/mutation-contract.generated.js ./services/office-editor/extension/mutation-contract.generated.js
COPY services/office-editor/extension/operations.js ./services/office-editor/extension/operations.js
COPY eval/public/fixtures/general-native-surface.pptx ./eval/public/fixtures/general-native-surface.pptx
RUN node services/browser-office/fetch-runtime.mjs
RUN node services/browser-office/build-harness.mjs

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.spellbook.component="browser-office"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
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
COPY --from=build /workspace/contracts ./contracts
COPY --from=build /workspace/services/browser-office ./services/browser-office
COPY services/office-session-spike/probe-assets.mjs services/office-session-spike/persistence-evidence.mjs services/office-session-spike/document-state-evidence.mjs ./services/office-session-spike/
COPY --from=build /workspace/services/office-editor/extension/mutation-contract.generated.js ./services/office-editor/extension/mutation-contract.generated.js
COPY --from=build /workspace/services/office-editor/extension/operations.js ./services/office-editor/extension/operations.js
COPY --from=build /workspace/eval/public/fixtures/general-native-surface.pptx ./eval/public/fixtures/general-native-surface.pptx
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=10 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "services/browser-office/server.mjs"]
