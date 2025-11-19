-- Initial database schema for Ducat Mint
-- This migration creates all the necessary tables for the Cashu mint

-- Keysets table: Stores mint keysets for different denominations
CREATE TABLE IF NOT EXISTS keysets (
  id VARCHAR(14) PRIMARY KEY,
  unit VARCHAR(10) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  private_keys JSONB NOT NULL,
  public_keys JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  deactivated_at BIGINT
);

CREATE INDEX idx_keysets_active ON keysets(active) WHERE active = true;
CREATE INDEX idx_keysets_rune ON keysets(rune_id);

-- Mint quotes table: Tracks mint quote requests (deposits)
CREATE TABLE IF NOT EXISTS mint_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount INTEGER NOT NULL,
  unit VARCHAR(10) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL, -- Deposit address
  state VARCHAR(20) NOT NULL, -- UNPAID, PAID, ISSUED
  expiry BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);

CREATE INDEX idx_mint_quotes_state ON mint_quotes(state);
CREATE INDEX idx_mint_quotes_expiry ON mint_quotes(expiry);

-- Melt quotes table: Tracks melt quote requests (withdrawals)
CREATE TABLE IF NOT EXISTS melt_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount INTEGER NOT NULL,
  unit VARCHAR(10) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL, -- Destination address
  fee_reserve INTEGER NOT NULL,
  state VARCHAR(20) NOT NULL, -- UNPAID, PENDING, PAID
  expiry BIGINT NOT NULL,
  txid VARCHAR(64),
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);

CREATE INDEX idx_melt_quotes_state ON melt_quotes(state);
CREATE INDEX idx_melt_quotes_expiry ON melt_quotes(expiry);

-- Proofs table: Tracks spent proofs to prevent double-spending
CREATE TABLE IF NOT EXISTS proofs (
  Y VARCHAR(66) PRIMARY KEY, -- Hash of the secret (Y = hash_to_curve(secret))
  keyset_id VARCHAR(14) NOT NULL,
  amount INTEGER NOT NULL,
  C VARCHAR(66) NOT NULL, -- The blinded signature
  spent BOOLEAN NOT NULL DEFAULT false,
  spent_at BIGINT,
  transaction_id VARCHAR(100),
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_proofs_spent ON proofs(spent);
CREATE INDEX idx_proofs_keyset ON proofs(keyset_id);
CREATE INDEX idx_proofs_transaction ON proofs(transaction_id);

-- Mint UTXOs table: Tracks the mint's UTXO reserves for Runes
CREATE TABLE IF NOT EXISTS mint_utxos (
  txid VARCHAR(64) NOT NULL,
  vout INTEGER NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  amount TEXT NOT NULL,  -- bigint as string (JavaScript doesn't support bigint in JSON)
  address VARCHAR(100) NOT NULL,
  value INTEGER NOT NULL,  -- sats value of the UTXO
  spent BOOLEAN NOT NULL DEFAULT false,
  spent_in_txid VARCHAR(64),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (txid, vout)
);

CREATE INDEX idx_mint_utxos_rune ON mint_utxos(rune_id, spent);
CREATE INDEX idx_mint_utxos_address ON mint_utxos(address);
CREATE INDEX idx_mint_utxos_spent ON mint_utxos(spent) WHERE spent = false;

-- Comments for documentation
COMMENT ON TABLE keysets IS 'Stores mint keysets for signing blind signatures';
COMMENT ON TABLE mint_quotes IS 'Tracks mint quote requests (user deposits)';
COMMENT ON TABLE melt_quotes IS 'Tracks melt quote requests (user withdrawals)';
COMMENT ON TABLE proofs IS 'Tracks spent proofs to prevent double-spending';
COMMENT ON TABLE mint_utxos IS 'Tracks the mint UTXO reserves for Runes backing';

COMMENT ON COLUMN mint_utxos.amount IS 'Amount of runes in this UTXO (stored as string to handle bigint)';
COMMENT ON COLUMN mint_utxos.value IS 'Bitcoin sats value of the UTXO';
COMMENT ON COLUMN proofs.Y IS 'Hash of the secret to prevent revealing the actual secret';
