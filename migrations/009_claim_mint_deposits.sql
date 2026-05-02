-- Migration 009: Track on-chain deposits claimed by mint quotes.
-- A blockchain outpoint can only credit one quote.

CREATE TABLE IF NOT EXISTS mint_deposits (
  id BIGSERIAL PRIMARY KEY,
  quote_id VARCHAR(64) NOT NULL REFERENCES mint_quotes(id) ON DELETE CASCADE,
  method VARCHAR(32) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  txid VARCHAR(128) NOT NULL,
  vout INTEGER NOT NULL,
  amount BIGINT NOT NULL,
  claimed_at BIGINT NOT NULL,
  issued_at BIGINT,
  UNIQUE (txid, vout)
);

CREATE INDEX IF NOT EXISTS idx_mint_deposits_quote ON mint_deposits(quote_id);
CREATE INDEX IF NOT EXISTS idx_mint_deposits_method_unit ON mint_deposits(method, unit);
