#!/usr/bin/env bash
set -euo pipefail

MINT_URL="${MINT_URL:-http://127.0.0.1:3338}"
CASHU_TS_REPO="${CASHU_TS_REPO:-https://github.com/cashubtc/cashu-ts.git}"
CASHU_TS_REF="${CASHU_TS_REF:-main}"
WORKDIR="${WORKDIR:-$(pwd)/.interop/upstream-cashu-ts}"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

git clone --depth 1 --branch "$CASHU_TS_REF" "$CASHU_TS_REPO" "$WORKDIR/repo" 2>/dev/null || \
  git clone --depth 1 "$CASHU_TS_REPO" "$WORKDIR/repo"

cd "$WORKDIR/repo"

for i in {1..90}; do
  if curl -fsS "$MINT_URL/v1/info" >/dev/null; then
    break
  fi
  if [[ "$i" == "90" ]]; then
    echo "Timed out waiting for mint at $MINT_URL" >&2
    exit 1
  fi
  sleep 1
done

npm ci
npm run compile
npm run test-integration
