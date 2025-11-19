-- Increase transaction_id field size to accommodate longer IDs
ALTER TABLE proofs ALTER COLUMN transaction_id TYPE VARCHAR(128);
