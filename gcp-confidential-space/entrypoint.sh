#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[confidential-space] $*"
}

shutdown() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "${CADDY_PID:-}" ]]; then
    kill "$CADDY_PID" 2>/dev/null || true
  fi
}
trap shutdown EXIT INT TERM

: "${GCP_WORKLOAD_IDENTITY_AUDIENCE:?GCP_WORKLOAD_IDENTITY_AUDIENCE is required}"
: "${MINT_ENV_SECRET_RESOURCE:?MINT_ENV_SECRET_RESOURCE is required}"
: "${KMS_KEY_NAME:?KMS_KEY_NAME is required}"

ENV_FILE="/run/ducat-mint/mint.env"

log "Fetching runtime environment through Confidential Space attestation"
node /app/scripts/gcp-confidential-space-env.mjs > "$ENV_FILE"
chmod 0600 "$ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export NODE_ENV="production"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3338}"
export KEY_ENCRYPTION_MODE="gcp-confidential-space-kms"
export KMS_KEY_NAME="$KMS_KEY_NAME"
export GCP_WORKLOAD_IDENTITY_AUDIENCE="$GCP_WORKLOAD_IDENTITY_AUDIENCE"
export GCP_ATTESTATION_TOKEN_AUDIENCE="${GCP_ATTESTATION_TOKEN_AUDIENCE:-https://sts.googleapis.com}"
export CONFIDENTIAL_SPACE_TOKEN_SOCKET="${CONFIDENTIAL_SPACE_TOKEN_SOCKET:-/run/container_launcher/teeserver.sock}"

log "Running database migrations"
node dist/scripts/migrate.js

log "Starting mint server on ${HOST}:${PORT}"
node dist/server.js &
APP_PID=$!

if [[ "${CADDY_ENABLED:-true}" == "true" ]]; then
  : "${DOMAIN_NAME:?DOMAIN_NAME is required when CADDY_ENABLED=true}"
  : "${TLS_EMAIL:?TLS_EMAIL is required when CADDY_ENABLED=true}"

  log "Starting Caddy for ${DOMAIN_NAME}"
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
  CADDY_PID=$!
  wait -n "$APP_PID" "$CADDY_PID"
else
  wait "$APP_PID"
fi
