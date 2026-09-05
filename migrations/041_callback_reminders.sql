-- Delivery audit + per-stage dedup for callback reminders (lead / due).
CREATE TABLE IF NOT EXISTS callback_reminders (
  callback_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'chatwoot_private_note',
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (callback_id, stage)
);
CREATE INDEX IF NOT EXISTS callback_reminders_sent_at_idx ON callback_reminders (sent_at);
