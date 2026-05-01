-- Migration 006: Expand keyset ID columns for NUT-02 v2 IDs.
-- V2 keyset IDs are 33-byte hex strings: "01" plus a 32-byte SHA256 digest.

ALTER TABLE proofs DROP CONSTRAINT IF EXISTS proofs_keyset_id_fkey;

ALTER TABLE keysets
  ALTER COLUMN id TYPE VARCHAR(66);

ALTER TABLE proofs
  ALTER COLUMN keyset_id TYPE VARCHAR(66);

ALTER TABLE proofs
  ADD CONSTRAINT proofs_keyset_id_fkey
  FOREIGN KEY (keyset_id) REFERENCES keysets(id);

INSERT INTO migrations (id, name)
VALUES (6, '006_expand_keyset_id_for_nut02_v2')
ON CONFLICT (id) DO NOTHING;
