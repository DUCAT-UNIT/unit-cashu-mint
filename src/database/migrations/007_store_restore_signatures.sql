-- Migration 007: Persist blind signatures for NUT-09 restore.

CREATE TABLE IF NOT EXISTS issued_signatures (
  B_ VARCHAR(66) PRIMARY KEY,
  keyset_id VARCHAR(66) NOT NULL REFERENCES keysets(id),
  amount BIGINT NOT NULL,
  C_ VARCHAR(66) NOT NULL,
  dleq JSONB,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issued_signatures_keyset ON issued_signatures(keyset_id);

INSERT INTO migrations (id, name)
VALUES (7, '007_store_restore_signatures')
ON CONFLICT (id) DO NOTHING;
