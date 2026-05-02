FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM deps AS prod-deps

RUN npm prune --omit=dev

FROM node:22-bookworm-slim

LABEL "tee.launch_policy.allow_env_override"="GCP_PROJECT_ID,GCP_WORKLOAD_IDENTITY_AUDIENCE,GCP_ATTESTATION_TOKEN_AUDIENCE,CONFIDENTIAL_SPACE_TOKEN_SOCKET,MINT_ENV_SECRET_RESOURCE,KMS_KEY_NAME,DOMAIN_NAME,TLS_EMAIL,PORT,CADDY_ENABLED,CADDY_STORAGE_SECRET_RESOURCE,CADDY_STORAGE_SYNC_INTERVAL_SECONDS,CADDY_STORAGE_MAX_BYTES,DB_HOST,DB_PORT,DB_NAME,DB_USER,DB_SSLMODE"
LABEL "tee.launch_policy.log_redirect"="always"

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=3338
ENV KEY_ENCRYPTION_MODE=gcp-confidential-space-kms
ENV CONFIDENTIAL_SPACE_TOKEN_SOCKET=/run/container_launcher/teeserver.sock
ENV GCP_ATTESTATION_TOKEN_AUDIENCE=https://sts.googleapis.com
ENV CADDY_ENABLED=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    debian-keyring \
    debian-archive-keyring \
    apt-transport-https \
    gnupg \
    gzip \
    tar \
  && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends caddy \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts/gcp-confidential-space-env.mjs ./scripts/gcp-confidential-space-env.mjs
COPY scripts/gcp-confidential-space-caddy-storage.mjs ./scripts/gcp-confidential-space-caddy-storage.mjs
COPY gcp-confidential-space/entrypoint.sh /entrypoint.sh
COPY gcp-confidential-space/Caddyfile /etc/caddy/Caddyfile

RUN chmod +x /entrypoint.sh \
  && mkdir -p /run/ducat-mint /data/caddy /config/caddy

EXPOSE 80 443 3338

ENTRYPOINT ["/entrypoint.sh"]
