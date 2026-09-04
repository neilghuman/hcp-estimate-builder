-- Customer Engagement Platform - Sprint 0 identity gateway foundation.
-- These tables store idempotency and sanitized decision evidence only. EspoCRM remains the
-- customer system of record; this database never becomes a second Contact store.

CREATE TABLE IF NOT EXISTS integration_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  terminal_status TEXT NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  normalized_phone_hash TEXT,
  normalized_email_hash TEXT,
  target_contact_id TEXT,
  sanitized_error_code TEXT,
  correlation_id TEXT NOT NULL,
  UNIQUE (source_system, source_event_id)
);

CREATE INDEX IF NOT EXISTS integration_events_received_at_idx ON integration_events (received_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_status_idx ON integration_events (terminal_status, received_at DESC);

CREATE TABLE IF NOT EXISTS identity_resolution_audits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_event_id BIGINT NOT NULL REFERENCES integration_events(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('auto_confirmed', 'provisional', 'identity_review', 'net_new', 'malformed_or_no_key', 'field_conflict')),
  link_status TEXT,
  candidate_contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  match_type TEXT,
  decision_reason TEXT,
  actor TEXT NOT NULL DEFAULT 'system:dry-run',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_event_id)
);

CREATE INDEX IF NOT EXISTS identity_resolution_audits_outcome_idx ON identity_resolution_audits (outcome, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  last_error_code TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_outbox_pending_idx ON integration_outbox (status, available_at);