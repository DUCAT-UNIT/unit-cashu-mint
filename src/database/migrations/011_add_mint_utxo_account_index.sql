-- Migration 011: Track mint derivation account index for Runes UTXOs.
-- Existing rows are canonical mint address reserves and remain account index 0.

ALTER TABLE mint_utxos
  ADD COLUMN IF NOT EXISTS account_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mint_utxos_account_index
  ON mint_utxos(account_index, spent);

INSERT INTO migrations (id, name)
VALUES (11, '011_add_mint_utxo_account_index')
ON CONFLICT (id) DO NOTHING;
