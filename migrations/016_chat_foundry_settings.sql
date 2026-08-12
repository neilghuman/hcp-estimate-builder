-- Chat Foundry — runtime settings (operator-toggleable, DB-persisted). Sprint: settings toggles.
-- Applied automatically on server startup by initializeDatabase().
--
-- Lets an operator flip "live sending" and the inbox allowlist from the UI instead of editing .env
-- and rebuilding the container. Environment variables remain the DEFAULT; a row here overrides them.
-- Keys used:
--   send_enabled      -> {"enabled": true|false}
--   allowed_inbox_ids -> {"ids": [2,4,5,6, ...]}
CREATE TABLE IF NOT EXISTS chat_foundry_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
