-- Customer Engagement Platform - incremental HCP -> EspoCRM live sync.
-- Scheduled catch-up of NEW/CHANGED Housecall Pro customers: clean net_new -> Contact,
-- ambiguous/provisional/conflict -> IdentityReview. Never auto-merges. Gated OFF by default.
--
-- Single-row cursor holding the Housecall Pro `updated_at` high-water mark that has been
-- fully processed. The very first run initializes the cursor and imports nothing (existing
-- customers are backfilled via the bounded /imports/hcp/batch endpoint under owner control).
CREATE TABLE IF NOT EXISTS hcp_live_sync_state (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  cursor_updated_at TEXT,
  initialized_at  TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-tick audit of what the live sync examined and wrote.
CREATE TABLE IF NOT EXISTS hcp_live_sync_runs (
  id              UUID PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  first_run       BOOLEAN NOT NULL DEFAULT FALSE,
  cursor_before   TEXT,
  cursor_after    TEXT,
  examined_count  INTEGER NOT NULL DEFAULT 0,
  created_count   INTEGER NOT NULL DEFAULT 0,
  queued_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS hcp_live_sync_runs_started_idx ON hcp_live_sync_runs (started_at DESC);
