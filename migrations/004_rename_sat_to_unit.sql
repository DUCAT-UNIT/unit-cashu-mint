-- Migration 004: Rename 'sat' unit to 'unit' across all tables
-- The Runes backend now identifies as 'unit' (not 'sat') to match the mobile app

UPDATE keysets SET unit = 'unit' WHERE unit = 'sat';
UPDATE mint_quotes SET unit = 'unit' WHERE unit = 'sat';
UPDATE melt_quotes SET unit = 'unit' WHERE unit = 'sat';
UPDATE mint_utxos SET unit = 'unit' WHERE unit = 'sat';

-- Update the default on mint_utxos column
ALTER TABLE mint_utxos ALTER COLUMN unit SET DEFAULT 'unit';

INSERT INTO migrations (id, name)
VALUES (4, '004_rename_sat_to_unit')
ON CONFLICT (id) DO NOTHING;
