FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm AS caddy-build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src/caddy
RUN git init \
  && git remote add origin https://github.com/caddyserver/caddy.git \
  && git fetch --depth=1 origin refs/tags/v2.11.7:refs/tags/v2.11.7 \
  && test "$(git rev-parse 'v2.11.7^{commit}')" = 72dd0fb067f6d7826c7f79907670ba4a713bfe37 \
  && git checkout --detach 72dd0fb067f6d7826c7f79907670ba4a713bfe37 \
  && go mod edit -require=golang.org/x/net@v0.60.0 \
  && go mod download golang.org/x/net@v0.60.0 \
  && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -mod=readonly -trimpath \
    -ldflags '-s -w -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.7-security-20261023' \
    -o /caddy ./cmd/caddy

FROM node:22.23.4-bookworm-slim AS node-base

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates gzip tar \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@11.21.1 --ignore-scripts --no-audit --no-fund \
  && mkdir -p /tmp/security-npm \
  && cd /tmp/security-npm \
  && npm pack --ignore-scripts ip-address@10.7.4 \
  && tar -xzf ip-address-10.7.4.tgz \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && mv package /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && rm -rf /tmp/security-npm

FROM node-base AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM deps AS prod-deps

RUN npm prune --omit=dev

FROM node-base

LABEL "tee.launch_policy.allow_env_override"="GCP_PROJECT_ID,GCP_WORKLOAD_IDENTITY_AUDIENCE,GCP_ATTESTATION_TOKEN_AUDIENCE,CONFIDENTIAL_SPACE_TOKEN_SOCKET,MINT_ENV_SECRET_RESOURCE,KMS_KEY_NAME,DOMAIN_NAME,TLS_EMAIL,PORT,CADDY_ENABLED,CADDY_STORAGE_SECRET_RESOURCE,CADDY_STORAGE_SYNC_INTERVAL_SECONDS,CADDY_STORAGE_MAX_BYTES,DB_HOST,DB_PORT,DB_NAME,DB_USER,DB_SSLMODE"
LABEL "tee.launch_policy.log_redirect"="always"

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=3338
ENV KEY_ENCRYPTION_MODE=gcp-confidential-space-kms
ENV CONFIDENTIAL_SPACE_TOKEN_SOCKET=/run/container_launcher/teeserver.sock
ENV GCP_ATTESTATION_TOKEN_AUDIENCE=https://sts.googleapis.com
ENV CADDY_ENABLED=true

COPY --from=caddy-build /caddy /usr/bin/caddy

WORKDIR /app

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts/gcp-confidential-space-env.mjs ./scripts/gcp-confidential-space-env.mjs
COPY scripts/gcp-confidential-space-caddy-storage.mjs ./scripts/gcp-confidential-space-caddy-storage.mjs
COPY gcp-confidential-space/entrypoint.sh /entrypoint.sh
COPY gcp-confidential-space/Caddyfile /etc/caddy/Caddyfile

# The entrypoint invokes Node directly; package managers are build-only tools.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
  && chmod +x /entrypoint.sh \
  && mkdir -p /run/ducat-mint /data/caddy /config/caddy

EXPOSE 80 443 3338

ENTRYPOINT ["/entrypoint.sh"]
