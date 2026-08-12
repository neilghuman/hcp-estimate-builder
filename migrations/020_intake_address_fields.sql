-- Customer Intake — split property address into HCP-shaped fields.
--
-- Housecall Pro stores customer addresses as separate street / street_line_2 / city / state / zip
-- fields (see hcp.js simplifyCustomer). The original single `address_line` text field could not be
-- mapped onto that structure (it was dumped whole into `street`, leaving city/state/zip blank in
-- HCP). These columns let the intake capture — and later a Google Places autocomplete — populate
-- the same shape HCP expects. `address_line` is kept for old rows/back-compat but is no longer
-- written to by new intakes.
ALTER TABLE customer_intakes
  ADD COLUMN IF NOT EXISTS address_street    TEXT,
  ADD COLUMN IF NOT EXISTS address_unit      TEXT,
  ADD COLUMN IF NOT EXISTS address_city      TEXT,
  ADD COLUMN IF NOT EXISTS address_state     TEXT,
  ADD COLUMN IF NOT EXISTS address_zip       TEXT,
  ADD COLUMN IF NOT EXISTS address_place_id  TEXT;
