-- Customer Engagement Platform - fuzzy duplicate contact sweep audit.
-- Per-run record of the EspoCRM contact near-duplicate scan. The sweep only queues suspected
-- clusters to IdentityReview (idempotent via cluster hash); it never merges contacts.
CREATE TABLE IF NOT EXISTS fuzzy_dedup_runs (
  id                UUID PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  contacts_scanned  INTEGER NOT NULL DEFAULT 0,
  clusters_found    INTEGER NOT NULL DEFAULT 0,
  reviews_created   INTEGER NOT NULL DEFAULT 0,
  reviews_existing  INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fuzzy_dedup_runs_started_idx ON fuzzy_dedup_runs (started_at DESC);
