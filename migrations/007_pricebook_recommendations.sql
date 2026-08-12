-- Phase C: dedicated customer-facing recommendations field on the price book.
--
-- Distinct from ai_scope_notes (internal scope assumptions). `recommendations` holds
-- the standalone, customer-facing consultative suggestions produced by the AI
-- enrichment pipeline's Recommendation agent (maintenance cadence, complementary
-- services, seasonal timing, preventative measures, future opportunities).

ALTER TABLE pricebook ADD COLUMN IF NOT EXISTS recommendations TEXT;
