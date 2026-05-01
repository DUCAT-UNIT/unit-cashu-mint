-- Migration 005: Cashu payment method metadata
-- Adds protocol method/unit separation and NUT-26 onchain accounting.

ALTER TABLE mint_quotes
  ADD COLUMN IF NOT EXISTS method VARCHAR(32) NOT NULL DEFAULT 'unit',
  ADD COLUMN IF NOT EXISTS pubkey VARCHAR(66),
  ADD COLUMN IF NOT EXISTS amount_paid BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_issued BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mint_quotes_method_unit ON mint_quotes(method, unit);

ALTER TABLE melt_quotes
  ADD COLUMN IF NOT EXISTS method VARCHAR(32) NOT NULL DEFAULT 'unit',
  ADD COLUMN IF NOT EXISTS fee BIGINT,
  ADD COLUMN IF NOT EXISTS estimated_blocks INTEGER,
  ADD COLUMN IF NOT EXISTS outpoint TEXT;

CREATE INDEX IF NOT EXISTS idx_melt_quotes_method_unit ON melt_quotes(method, unit);

INSERT INTO migrations (id, name)
VALUES (5, '005_cashu_payment_methods')
ON CONFLICT (id) DO NOTHING;
