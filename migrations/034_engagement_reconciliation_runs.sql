-- Customer Engagement Platform - Sprint 0 read-only HCP reconciliation runs.

CREATE TABLE IF NOT EXISTS identity_reconciliation_runs (
  id UUID PRIMARY KEY,
  source_system TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE integration_events
  ADD COLUMN IF NOT EXISTS reconciliation_run_id UUID REFERENCES identity_reconciliation_runs(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS integration_events_reconciliation_run_idx ON integration_events (reconciliation_run_id);