-- Customer Intake — Sprint 1 follow-up: attribute intakes to a real Housecall Pro user.
-- Applied automatically on server startup by initializeDatabase().
--
-- The office-staff selector is a dropdown of HCP employees (not free text), so we also store the
-- HCP employee id alongside the display name for accurate per-staff reporting / future estimator
-- assignment.
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS created_by_hcp_id TEXT;
CREATE INDEX IF NOT EXISTS customer_intakes_created_by_hcp_idx ON customer_intakes (created_by_hcp_id);
