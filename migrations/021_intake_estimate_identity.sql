-- Customer Intake — capture the full identity of the estimate created from an intake.
--
-- The HCP web app deep-links to an estimate by its OPTION id, not the estimate (csr_...) id,
-- so the option id must be stored to build a working "open this estimate" link. The estimate
-- number is stored too so staff can reference it without a second API round-trip.
ALTER TABLE customer_intakes
  ADD COLUMN IF NOT EXISTS hcp_estimate_option_id TEXT,
  ADD COLUMN IF NOT EXISTS hcp_estimate_number    TEXT;
