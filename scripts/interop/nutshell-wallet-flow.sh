#!/usr/bin/env bash
set -euo pipefail

MINT_URL="${MINT_URL:-http://127.0.0.1:3338}"
MELT_INVOICE="${MELT_INVOICE:-lnbcrt620n1pn0r3vepp5zljn7g09fsyeahl4rnhuy0xax2puhua5r3gspt7ttlfrley6valqdqqcqzzsxqyz5vqsp577h763sel3q06tfnfe75kvwn5pxn344sd5vnays65f9wfgx4fpzq9qxpqysgqg3re9afz9rwwalytec04pdhf9mvh3e2k4r877tw7dr4g0fvzf9sny5nlfggdy6nduy2dytn06w50ls34qfldgsj37x0ymxam0a687mspp0ytr8}"
NUTSHELL_REPO="${NUTSHELL_REPO:-https://github.com/cashubtc/nutshell.git}"
NUTSHELL_REF="${NUTSHELL_REF:-main}"
WORKDIR="${WORKDIR:-$(pwd)/.interop/nutshell}"

mkdir -p "$WORKDIR"

if [[ -n "${CASHU_BIN:-}" ]]; then
  CASHU=( "$CASHU_BIN" )
else
  NUTSHELL_SRC="$WORKDIR/repo"
  if [[ ! -d "$NUTSHELL_SRC/.git" ]]; then
    git clone --depth 1 --branch "$NUTSHELL_REF" "$NUTSHELL_REPO" "$NUTSHELL_SRC" 2>/dev/null || \
      git clone --depth 1 "$NUTSHELL_REPO" "$NUTSHELL_SRC"
  fi
  python -m pip install -e "$NUTSHELL_SRC"
  python -m pip install 'marshmallow<4'
  CASHU=( cashu )
fi

WALLET_DIR="$WORKDIR/wallet"
rm -rf "$WALLET_DIR"
mkdir -p "$WALLET_DIR"

export CASHU_DIR="$WALLET_DIR"
BASE_ARGS=( --host "$MINT_URL" --unit sat --wallet interop --tests --yes )

QUOTE_OUTPUT="$("${CASHU[@]}" "${BASE_ARGS[@]}" invoice 128 --no-check)"
QUOTE_ID="$(printf '%s\n' "$QUOTE_OUTPUT" | sed -nE 's/.*--id ([[:alnum:]_-]+).*/\1/p' | tail -1)"
if [[ -z "$QUOTE_ID" ]]; then
  echo "$QUOTE_OUTPUT"
  echo "Could not parse Nutshell mint quote id" >&2
  exit 1
fi

"${CASHU[@]}" "${BASE_ARGS[@]}" invoice 128 --id "$QUOTE_ID"
"${CASHU[@]}" "${BASE_ARGS[@]}" balance > "$WORKDIR/balance-after-mint.txt"
"${CASHU[@]}" "${BASE_ARGS[@]}" send 21 --force-swap > "$WORKDIR/send-token.txt"
"${CASHU[@]}" "${BASE_ARGS[@]}" pay "$MELT_INVOICE" --yes
"${CASHU[@]}" "${BASE_ARGS[@]}" balance > "$WORKDIR/balance-after-melt.txt"

echo "Nutshell interop flow passed against $MINT_URL"
