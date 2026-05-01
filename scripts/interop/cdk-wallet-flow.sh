#!/usr/bin/env bash
set -euo pipefail

MINT_URL="${MINT_URL:-http://127.0.0.1:3338}"
MELT_INVOICE="${MELT_INVOICE:-lnbcrt620n1pn0r3vepp5zljn7g09fsyeahl4rnhuy0xax2puhua5r3gspt7ttlfrley6valqdqqcqzzsxqyz5vqsp577h763sel3q06tfnfe75kvwn5pxn344sd5vnays65f9wfgx4fpzq9qxpqysgqg3re9afz9rwwalytec04pdhf9mvh3e2k4r877tw7dr4g0fvzf9sny5nlfggdy6nduy2dytn06w50ls34qfldgsj37x0ymxam0a687mspp0ytr8}"
CDK_REPO="${CDK_REPO:-https://github.com/cashubtc/cdk.git}"
CDK_REF="${CDK_REF:-main}"
WORKDIR="${WORKDIR:-$(pwd)/.interop/cdk}"

mkdir -p "$WORKDIR"

if [[ -n "${CDK_BIN:-}" ]]; then
  CDK="$CDK_BIN"
else
  CDK_SRC="$WORKDIR/repo"
  if [[ ! -d "$CDK_SRC/.git" ]]; then
    git clone --depth 1 --branch "$CDK_REF" "$CDK_REPO" "$CDK_SRC" 2>/dev/null || \
      git clone --depth 1 "$CDK_REPO" "$CDK_SRC"
  fi
  cargo build --manifest-path "$CDK_SRC/Cargo.toml" -p cdk-cli --no-default-features
  CDK="$CDK_SRC/target/debug/cdk-cli"
fi

WALLET_DIR="$WORKDIR/wallet"
rm -rf "$WALLET_DIR"
mkdir -p "$WALLET_DIR"

CDK_ARGS=( "$CDK" --work-dir "$WALLET_DIR" --unit sat --non-interactive )

"${CDK_ARGS[@]}" mint-info "$MINT_URL" > "$WORKDIR/mint-info.json"
"${CDK_ARGS[@]}" mint "$MINT_URL" 128 --method bolt11 --wait-duration 5
"${CDK_ARGS[@]}" balance > "$WORKDIR/balance-after-mint.txt"

TOKEN_OUTPUT="$("${CDK_ARGS[@]}" send --amount 21 --mint-url "$MINT_URL")"
if [[ "$TOKEN_OUTPUT" != *cashu* ]]; then
  echo "$TOKEN_OUTPUT"
  echo "CDK send did not produce a cashu token" >&2
  exit 1
fi

"${CDK_ARGS[@]}" melt --mint-url "$MINT_URL" --invoice "$MELT_INVOICE"
"${CDK_ARGS[@]}" balance > "$WORKDIR/balance-after-melt.txt"

echo "CDK interop flow passed against $MINT_URL"
