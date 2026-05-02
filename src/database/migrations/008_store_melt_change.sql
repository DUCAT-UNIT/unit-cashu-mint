-- Migration 008: Persist NUT-08 melt change signatures on quote status.

ALTER TABLE melt_quotes
  ADD COLUMN IF NOT EXISTS change JSONB;

INSERT INTO migrations (id, name)
VALUES (8, '008_store_melt_change')
ON CONFLICT (id) DO NOTHING;
