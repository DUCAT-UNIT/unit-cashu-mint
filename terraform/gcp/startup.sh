#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${project_id}"
REPO_URL="${repo_url}"
REPO_REF="${repo_ref}"
DOMAIN_NAME="${domain_name}"
TLS_EMAIL="${tls_email}"
MINT_ENV_SECRET_ID="${mint_env_secret_id}"
DB_PASSWORD="${db_password}"
APP_KMS_KEY_NAME="${app_kms_key_name}"
REQUIRE_CONFIDENTIAL_VM_ATTESTATION="${require_confidential_vm_attestation}"
CONFIDENTIAL_INSTANCE_TYPE="${confidential_instance_type}"
APP_DIR="/opt/ducat-mint"
ENV_DIR="/etc/ducat-mint"
ENV_FILE="$ENV_DIR/mint.env"

exec > >(tee -a /var/log/ducat-mint-startup.log) 2>&1

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  postgresql \
  postgresql-contrib \
  python3

install -d -m 0755 "$ENV_DIR"

install_node() {
  if command -v node >/dev/null 2>&1 && node --version | grep -Eq '^v22\.([4-9]|[1-9][0-9])\.'; then
    return
  fi

  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return
  fi

  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
}

metadata_token() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

assert_confidential_vm() {
  if [ "$REQUIRE_CONFIDENTIAL_VM_ATTESTATION" != "true" ]; then
    return
  fi

  local token
  token="$(metadata_token)"
  PROJECT_ID="$PROJECT_ID" SECRET_TOKEN="$token" EXPECTED_CONFIDENTIAL_INSTANCE_TYPE="$CONFIDENTIAL_INSTANCE_TYPE" python3 - <<'PY'
import json
import os
import urllib.request

token = os.environ["SECRET_TOKEN"]
project = os.environ["PROJECT_ID"]
expected_type = os.environ["EXPECTED_CONFIDENTIAL_INSTANCE_TYPE"]

def metadata(path: str) -> str:
    request = urllib.request.Request(
        f"http://metadata.google.internal/computeMetadata/v1/{path}",
        headers={"Metadata-Flavor": "Google"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode("utf-8")

zone = metadata("instance/zone").rsplit("/", 1)[-1]
name = metadata("instance/name")
url = f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances/{name}"
request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
with urllib.request.urlopen(request, timeout=30) as response:
    instance = json.load(response)

confidential = instance.get("confidentialInstanceConfig") or {}
shielded = instance.get("shieldedInstanceConfig") or {}
actual_type = confidential.get("confidentialInstanceType", "")
checks = {
    "confidential_compute": confidential.get("enableConfidentialCompute") is True,
    "confidential_type": not expected_type or actual_type == expected_type,
    "secure_boot": shielded.get("enableSecureBoot") is True,
    "vtpm": shielded.get("enableVtpm") is True,
    "integrity_monitoring": shielded.get("enableIntegrityMonitoring") is True,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit(f"Confidential VM attestation gate failed: {failed}")

print(
    "Confidential VM attestation gate passed "
    f"(type={actual_type}, secure_boot={shielded.get('enableSecureBoot')}, "
    f"vtpm={shielded.get('enableVtpm')}, integrity={shielded.get('enableIntegrityMonitoring')})"
)
PY
}

fetch_secret() {
  local token
  token="$(metadata_token)"
  PROJECT_ID="$PROJECT_ID" MINT_ENV_SECRET_ID="$MINT_ENV_SECRET_ID" SECRET_TOKEN="$token" python3 - <<'PY'
import base64
import json
import os
import shlex
import urllib.request

project = os.environ["PROJECT_ID"]
secret = os.environ["MINT_ENV_SECRET_ID"]
token = os.environ["SECRET_TOKEN"]
url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{secret}/versions/latest:access"
request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
with urllib.request.urlopen(request, timeout=30) as response:
    payload = json.load(response)["payload"]["data"]
raw = base64.b64decode(payload).decode("utf-8")
for line in raw.splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    print(f"{key}={shlex.quote(value)}")
PY
}

setup_postgres() {
  systemctl enable --now postgresql
  sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mintuser') THEN
    CREATE USER mintuser WITH PASSWORD '$DB_PASSWORD';
  ELSE
    ALTER USER mintuser WITH PASSWORD '$DB_PASSWORD';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE mintdb OWNER mintuser'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mintdb')\gexec
GRANT ALL PRIVILEGES ON DATABASE mintdb TO mintuser;
SQL
}

deploy_app() {
  if [ ! -d "$APP_DIR/.git" ]; then
    git clone "$REPO_URL" "$APP_DIR"
  fi

  cd "$APP_DIR"
  git fetch --all --tags
  git checkout "$REPO_REF"
  if git rev-parse --verify "origin/$REPO_REF" >/dev/null 2>&1; then
    git reset --hard "origin/$REPO_REF"
  fi
  npm ci
  npm run build

  fetch_secret > "$ENV_FILE"
  cat >> "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3338
DATABASE_URL=postgresql://mintuser:$${DB_PASSWORD}@127.0.0.1:5432/mintdb
KEY_ENCRYPTION_MODE=gcp-kms
KMS_KEY_NAME=$APP_KMS_KEY_NAME
EOF
  chmod 0600 "$ENV_FILE"

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  npm run migrate

  cat >/etc/systemd/system/ducat-mint.service <<EOF
[Unit]
Description=Ducat Cashu Mint
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable ducat-mint
  systemctl restart ducat-mint
}

configure_proxy() {
  cat >/etc/caddy/Caddyfile <<EOF
{
  email $TLS_EMAIL
}

$DOMAIN_NAME {
  reverse_proxy 127.0.0.1:3338
}
EOF

  systemctl enable --now caddy
  systemctl reload caddy
}

install_node
install_caddy
assert_confidential_vm
setup_postgres
deploy_app
configure_proxy

echo "Ducat mint startup completed"
