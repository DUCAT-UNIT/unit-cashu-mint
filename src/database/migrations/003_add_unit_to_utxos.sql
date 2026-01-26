-- Migration 003: Add unit column to mint_utxos for multi-unit support
-- This allows tracking UTXOs for both BTC and Runes

-- Add unit column with default 'sat' for backwards compatibility
ALTER TABLE mint_utxos ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'sat';

-- Update existing index to include unit
DROP INDEX IF EXISTS idx_mint_utxos_rune;
CREATE INDEX IF NOT EXISTS idx_mint_utxos_unit_spent ON mint_utxos(unit, spent);
CREATE INDEX IF NOT EXISTS idx_mint_utxos_rune_unit ON mint_utxos(rune_id, unit, spent);

-- Record this migration
INSERT INTO migrations (id, name) VALUES (3, '003_add_unit_to_utxos')
ON CONFLICT (id) DO NOTHING;
