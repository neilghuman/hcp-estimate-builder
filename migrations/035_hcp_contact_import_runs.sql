-- Customer Engagement Platform - resumable HCP Contact import runner.

CREATE TABLE IF NOT EXISTS hcp_contact_import_runs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 50),
  created_count INTEGER NOT NULL DEFAULT 0,
  existing_count INTEGER NOT NULL DEFAULT 0,
  reviewable_count INTEGER NOT NULL DEFAULT 0,
  malformed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hcp_contact_import_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES hcp_contact_import_runs(id) ON DELETE RESTRICT,
  batch_number INTEGER NOT NULL,
  selected_count INTEGER NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  skipped_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (run_id, batch_number)
);

CREATE INDEX IF NOT EXISTS hcp_contact_import_runs_status_idx ON hcp_contact_import_runs (status, updated_at DESC);