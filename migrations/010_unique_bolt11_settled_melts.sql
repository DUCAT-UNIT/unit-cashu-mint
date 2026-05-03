-- Migration 010: Prevent duplicate settled bolt11 melt requests.
-- A bolt11 invoice should only be in-flight or paid once.

CREATE UNIQUE INDEX IF NOT EXISTS idx_melt_quotes_bolt11_settled_request_unique
  ON melt_quotes (method, unit, request)
  WHERE method = 'bolt11' AND state IN ('PENDING', 'PAID');

INSERT INTO migrations (id, name)
VALUES (10, '010_unique_bolt11_settled_melts')
ON CONFLICT (id) DO NOTHING;
