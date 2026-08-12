-- Customer Intake — Sprint 9: reporting foundation.
-- Applied automatically on server startup by initializeDatabase().
--
-- No new columns are needed — the reporting dimensions were designed into 017. This adds a
-- submitted_at index and a convenience view so the future reporting layer (close rate by lead source,
-- time-to-estimate, final-estimate outcome, etc.) can query without re-deriving joins/math each time.
CREATE INDEX IF NOT EXISTS customer_intakes_submitted_at_idx ON customer_intakes (submitted_at);

CREATE OR REPLACE VIEW intake_report AS
SELECT
  id,
  public_id,
  status,
  created_by,
  created_by_hcp_id,
  customer_tag,
  lead_source,
  timeframe,
  budget,
  getting_other_bids,
  final_estimate_response,
  decision_factor,
  hcp_customer_id,
  hcp_estimate_id,
  notify_status,
  created_at,
  submitted_at,
  EXTRACT(EPOCH FROM (submitted_at - created_at)) / 60.0 AS minutes_to_submit
FROM customer_intakes;
