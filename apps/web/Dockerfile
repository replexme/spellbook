FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @spellbook/web... --filter spellbook
COPY contracts ./contracts
COPY services/document-resources ./services/document-resources
COPY services/browser-office/external-raster.mjs ./services/browser-office/external-raster.mjs
COPY apps/web ./apps/web
RUN pnpm --filter @spellbook/web build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
LABEL org.spellbook.component="web"
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0
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
      /usr/local/bin/yarnpkg \
    && mkdir -p /data \
    && chown node:node /data
COPY --from=build /workspace/apps/web/.next/standalone ./
COPY --from=build /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
