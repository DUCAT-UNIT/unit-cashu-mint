#!/usr/bin/env bash
set -euo pipefail

MINT_URL="${MINT_URL:-http://127.0.0.1:3338}"
CDK_REPO="${CDK_REPO:-https://github.com/cashubtc/cdk.git}"
CDK_REF="${CDK_REF:-main}"
WORKDIR="${WORKDIR:-$(pwd)/.interop/upstream-cdk}"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

git clone --depth 1 --branch "$CDK_REF" "$CDK_REPO" "$WORKDIR/repo" 2>/dev/null || \
  git clone --depth 1 "$CDK_REPO" "$WORKDIR/repo"

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

cd "$WORKDIR/repo"
mkdir -p "$WORKDIR/itest"

export CDK_TEST_MINT_URL="$MINT_URL"
export CDK_ITESTS_DIR="$WORKDIR/itest"

cargo test -p cdk-integration-tests --test happy_path_mint_wallet -- --test-threads 1
