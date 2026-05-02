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

if [[ -z "${DATABASE_URL:-}" ]]; then
  : "${DB_HOST:?DATABASE_URL or DB_HOST is required}"
  : "${DB_PASSWORD:?DB_PASSWORD is required when DATABASE_URL is not set}"

  export DB_USER="${DB_USER:-mintuser}"
  export DB_PORT="${DB_PORT:-5432}"
  export DB_NAME="${DB_NAME:-mintdb}"
  export DB_SSLMODE="${DB_SSLMODE:-disable}"
  export DATABASE_URL="$(
    node --input-type=module <<'NODE'
const user = process.env.DB_USER
const password = process.env.DB_PASSWORD
const host = process.env.DB_HOST
const port = process.env.DB_PORT
const database = process.env.DB_NAME
const sslmode = process.env.DB_SSLMODE

if (!user || !password || !host || !port || !database) {
  throw new Error('DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, and DB_NAME are required')
}

const url = new URL(`postgresql://${host}:${port}/${database}`)
url.username = user
url.password = password
if (sslmode) {
  url.searchParams.set('sslmode', sslmode)
}

console.log(url.toString())
NODE
  )"
fi

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
