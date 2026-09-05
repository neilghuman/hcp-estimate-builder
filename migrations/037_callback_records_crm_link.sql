-- Durable linkage from the integration callback record to its EspoCRM Callback.

ALTER TABLE callback_records
  ADD COLUMN IF NOT EXISTS crm_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS callback_records_crm_id_key
  ON callback_records (crm_id)
  WHERE crm_id IS NOT NULL;