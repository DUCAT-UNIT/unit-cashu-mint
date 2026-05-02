-- Migration 008: Persist NUT-08 melt change signatures on quote status.

ALTER TABLE melt_quotes
  ADD COLUMN IF NOT EXISTS change JSONB;
