-- Increase transaction_id field size to accommodate longer IDs
ALTER TABLE proofs ALTER COLUMN transaction_id TYPE VARCHAR(128);

INSERT INTO migrations (id, name)
VALUES (2, '002_fix_transaction_id_length')
ON CONFLICT (id) DO NOTHING;
