-- Operational callback fields required for ownership, SLA, and reschedule history.

ALTER TABLE callback_records
  ADD COLUMN IF NOT EXISTS callback_number TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS rescheduled_to_callback_id TEXT,
  ADD COLUMN IF NOT EXISTS rescheduled_from_callback_id TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS callback_records_callback_number_key
  ON callback_records (callback_number)
  WHERE callback_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS callback_records_rescheduled_to_idx
  ON callback_records (rescheduled_to_callback_id)
  WHERE rescheduled_to_callback_id IS NOT NULL;