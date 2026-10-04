# syntax=docker/dockerfile:1

# Build context is the repository root:
#   docker build -f apps/server/Dockerfile -t lmcs-server .
#
# The image contains the bundled server (dist/bin.mjs), the web client
# (dist/client), and the runtime dependencies the bundle keeps external
# (node-pty and friends). Provider CLIs are deliberately not baked in; see
# docs/operations/docker.md.

FROM node:24-bookworm-slim AS build

# node-pty has no Linux prebuild and compiles from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /src
COPY . .

# Only the trees the server build needs. This skips the desktop workspace,
# which keeps the Electron download out of the image build.
RUN --mount=type=cache,id=lmcs-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter lmcs-agent \
      --filter 'lmcs...' \
      --filter '@lmcstools/web...' \
      --filter '@lmcstools/scripts...'

RUN pnpm --filter @lmcstools/web run build \
    && node apps/server/scripts/cli.ts build

FROM node:24-bookworm-slim AS run

# git and ssh back checkpointing and git remotes for mounted workspaces.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/*

ENV LMCS_HOME=/data \
    LMCS_HOST=0.0.0.0 \
    LMCS_PORT=13773 \
    LMCS_DISABLE_AUTO_UPDATE=1 \
    NODE_ENV=production

WORKDIR /app
# The built tree is copied whole so pnpm's relative symlinks into the root
# store keep resolving; no install or toolchain runs in this stage.
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/server/package.json ./apps/server/package.json

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 13773

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "const s=require('node:net').connect(13773,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"]

CMD ["node", "apps/server/dist/bin.mjs", "serve"]
