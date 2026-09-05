-- Idempotent link between a callback and the 3CX call(s) correlated to it,
-- and the EspoCRM Call activity created for each. One row per (callback, 3CX call).
CREATE TABLE IF NOT EXISTS callback_calls (
  callback_id TEXT NOT NULL,
  threecx_call_id TEXT NOT NULL,
  crm_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (callback_id, threecx_call_id)
);
