-- Migration 001: Initial schema
-- Creates tables for keysets, quotes, proofs, and UTXOs

-- Keysets table
CREATE TABLE IF NOT EXISTS keysets (
  id VARCHAR(14) PRIMARY KEY,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  private_keys JSONB NOT NULL,  -- Encrypted: {1: "hex", 2: "hex", ...}
  public_keys JSONB NOT NULL,   -- {1: "hex", 2: "hex", ...}
  input_fee_ppk INTEGER DEFAULT 0,
  final_expiry BIGINT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keysets_active ON keysets(active, unit);
CREATE INDEX IF NOT EXISTS idx_keysets_rune ON keysets(rune_id);

-- Mint quotes
CREATE TABLE IF NOT EXISTS mint_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount BIGINT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL,  -- Deposit address
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNPAID', 'PAID', 'ISSUED')),
  expiry BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  txid VARCHAR(64),
  vout INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mint_quotes_state ON mint_quotes(state, expiry);
CREATE INDEX IF NOT EXISTS idx_mint_quotes_request ON mint_quotes(request);
CREATE INDEX IF NOT EXISTS idx_mint_quotes_txid ON mint_quotes(txid);

-- Melt quotes
CREATE TABLE IF NOT EXISTS melt_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount BIGINT NOT NULL,
  fee_reserve BIGINT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL,  -- Destination address
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNPAID', 'PENDING', 'PAID')),
  expiry BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  txid VARCHAR(64),
  fee_paid BIGINT
);

CREATE INDEX IF NOT EXISTS idx_melt_quotes_state ON melt_quotes(state, expiry);
CREATE INDEX IF NOT EXISTS idx_melt_quotes_txid ON melt_quotes(txid);

-- Proofs (spent tracking)
CREATE TABLE IF NOT EXISTS proofs (
  Y VARCHAR(66) PRIMARY KEY,  -- hash_to_curve(secret) in hex
  keyset_id VARCHAR(14) NOT NULL REFERENCES keysets(id),
  amount BIGINT NOT NULL,
  secret TEXT NOT NULL,
  C VARCHAR(66) NOT NULL,  -- Signature point in hex
  witness TEXT,
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNSPENT', 'PENDING', 'SPENT')),
  spent_at BIGINT,
  transaction_id VARCHAR(64)  -- Quote ID or swap ID
);

CREATE INDEX IF NOT EXISTS idx_proofs_state ON proofs(state);
CREATE INDEX IF NOT EXISTS idx_proofs_keyset ON proofs(keyset_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proofs_secret ON proofs(secret);  -- Backup double-spend check

-- Mint UTXOs (reserve tracking)
CREATE TABLE IF NOT EXISTS mint_utxos (
  txid VARCHAR(64) NOT NULL,
  vout INTEGER NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  amount BIGINT NOT NULL,
  address VARCHAR(100) NOT NULL,
  spent BOOLEAN NOT NULL DEFAULT false,
  spent_in_txid VARCHAR(64),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (txid, vout)
);

CREATE INDEX IF NOT EXISTS idx_mint_utxos_rune ON mint_utxos(rune_id, spent);
CREATE INDEX IF NOT EXISTS idx_mint_utxos_address ON mint_utxos(address);

-- Create migration tracking table
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Record this migration
INSERT INTO migrations (id, name) VALUES (1, '001_initial');
