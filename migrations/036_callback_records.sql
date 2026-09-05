-- Callback queue and lifecycle records for Sprint 1 operational tracking.

CREATE TABLE IF NOT EXISTS callback_records (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  phone TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  owner TEXT,
  reason TEXT,
  source TEXT,
  status TEXT NOT NULL,
  outcome TEXT,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS callback_records_owner_due_idx
  ON callback_records (owner, due_at DESC);

CREATE INDEX IF NOT EXISTS callback_records_status_due_idx
  ON callback_records (status, due_at ASC);
