-- Customer Intake — Sprint 1 revised discovery schema.
-- The discovery questions were redesigned to a customer-centric set with new field ids.
-- Promote the new reporting dimensions to first-class columns (the pre-existing `problem`,
-- `timeframe`, `getting_other_bids`, etc. columns from 017 are left in place, now unused).
-- Idempotent: safe to re-run.
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS project_description TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS buying_priority     TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS buying_stage        TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS getting_estimates   TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS photos_provided     TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS contact_time        TEXT;
