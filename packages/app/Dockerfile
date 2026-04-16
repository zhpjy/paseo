# syntax=docker/dockerfile:1.7

# Build from the repository root:
# docker build -f packages/app/Dockerfile -t paseo-web .

FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV CI=1

# Copy manifests first to keep dependency installation cacheable.
COPY package.json package-lock.json ./
COPY scripts/postinstall-patches.mjs scripts/postinstall-patches.mjs
COPY patches patches
COPY packages/app/package.json packages/app/package.json
COPY packages/highlight/package.json packages/highlight/package.json
COPY packages/expo-two-way-audio/package.json packages/expo-two-way-audio/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/website/package.json packages/website/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm ci --include-workspace-root

COPY . .

RUN npm run build:web --workspace=@getpaseo/app

FROM caddy:2-alpine AS runtime

COPY --from=build /app/packages/app/dist /srv

RUN printf '%s\n' \
  ':80 {' \
  '  root * /srv' \
  '  encode gzip zstd' \
  '  try_files {path} /index.html' \
  '  file_server' \
  '}' > /etc/caddy/Caddyfile

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
