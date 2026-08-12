-- Customer Intake System — Sprint 1: data foundation.
-- Applied automatically on server startup by initializeDatabase().
--
-- One row per intake. The table is intentionally wide up front so later sprints and the future
-- reporting layer (close rate by lead source, avg job value, final-estimate outcome, time-to-estimate,
-- competing bids, etc.) can be built WITHOUT schema rewrites. First-class columns hold the reporting
-- dimensions; `data` (JSONB) is the full-form source of truth for anything not promoted to a column.
--
-- Lifecycle: draft -> submitting -> completed | failed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customer_intakes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      UUID NOT NULL DEFAULT gen_random_uuid(),   -- stable id for URLs + submit idempotency
  status         TEXT NOT NULL DEFAULT 'draft',             -- draft | submitting | completed | failed
  created_by     TEXT,                                      -- office staff name/initials (simple attribution)

  -- Customer (Step 2). hcp_customer_id is set once the customer is found or created (Sprint 2/4).
  hcp_customer_id  TEXT,
  customer_is_new  BOOLEAN,
  first_name       TEXT,
  last_name        TEXT,
  phone            TEXT,
  email            TEXT,
  company          TEXT,
  secondary_phone  TEXT,
  address_line     TEXT,
  address_notes    TEXT,

  -- Tag (Step 3).
  customer_tag     TEXT,

  -- Discovery reporting dimensions (Step 4) — promoted for fast reporting.
  problem                  TEXT,
  timeframe                TEXT,
  getting_other_bids       TEXT,   -- Yes | No | Unsure
  final_estimate_response  TEXT,   -- Agreed | Declined | Unsure | Not Applicable
  anyone_visited           TEXT,   -- Yes | No
  companies_visited        INTEGER,
  written_estimates        TEXT,   -- Yes | No
  decision_factor          TEXT,
  budget                   TEXT,
  pictures                 TEXT,   -- Yes | No
  lead_source              TEXT,
  callback_time            TEXT,
  callback_time_detail     TEXT,
  additional_notes         TEXT,

  -- Full-form snapshot (source of truth for anything not promoted above; keeps us schema-stable).
  data JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- HCP outcome (Sprint 4/6) + notification outcome (Sprint 7). Stored for reporting + idempotency.
  hcp_estimate_id    TEXT,
  hcp_customer_url   TEXT,
  hcp_estimate_url   TEXT,
  notify_status      TEXT,   -- pending | sent | failed | skipped
  notify_error       TEXT,

  submitted_at   TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_intakes_public_id_idx ON customer_intakes (public_id);
CREATE INDEX IF NOT EXISTS customer_intakes_status_idx        ON customer_intakes (status);
CREATE INDEX IF NOT EXISTS customer_intakes_created_at_idx     ON customer_intakes (created_at DESC);
CREATE INDEX IF NOT EXISTS customer_intakes_lead_source_idx    ON customer_intakes (lead_source);
CREATE INDEX IF NOT EXISTS customer_intakes_hcp_customer_idx   ON customer_intakes (hcp_customer_id);
CREATE INDEX IF NOT EXISTS customer_intakes_customer_tag_idx   ON customer_intakes (customer_tag);
