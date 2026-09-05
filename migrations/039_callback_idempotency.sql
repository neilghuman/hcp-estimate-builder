ALTER TABLE callback_records
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS callback_records_idempotency_key
  ON callback_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;