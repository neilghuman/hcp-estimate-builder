-- Customer Intake — internal sales-team notification after a successful submit.
-- Records the per-channel status/timestamp for the sales@<brand> notification email so it is
-- idempotent (never re-sent on refresh/retry) and auditable. Idempotent: safe to re-run.
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS sales_notify_status TEXT;      -- pending | sent | failed | skipped
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS sales_notify_at     TIMESTAMPTZ;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS sales_notify_error  TEXT;
