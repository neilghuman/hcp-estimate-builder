-- Chat Foundry — campaigns + recipients + events (Sprint 5: first send-enabled path).
-- Applied automatically on server startup by initializeDatabase().
--
-- A campaign snapshots a message body + audience filters. Recipients are materialized (one row
-- per Chatwoot conversation) with the per-recipient rendered body and an eligibility decision.
-- Sending is gated (Basic Auth + CHAT_FOUNDRY_SEND_ENABLED + typed confirmation + max size) and
-- writes chatwoot_message_id so a conversation can never be double-sent within a campaign.

CREATE TABLE IF NOT EXISTS chat_campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  template_id BIGINT,                              -- optional source template (no FK on purpose)
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | ready | testing | sending | paused | completed | canceled
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { status, inboxId, tags[], contactSearch, excludeNoChannel, maxRecipients }
  total_recipients INT NOT NULL DEFAULT 0,
  eligible_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  test_sent_count INT NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  materialized_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cf_campaigns_status ON chat_campaigns (status);

-- One row per targeted conversation. UNIQUE(campaign_id, conversation_id) is the idempotency guard.
CREATE TABLE IF NOT EXISTS chat_campaign_recipients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES chat_campaigns (id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL,
  inbox_id BIGINT,
  contact_id BIGINT,
  contact_name TEXT,
  phone TEXT,
  rendered_body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | sent | failed | skipped
  eligible BOOLEAN NOT NULL DEFAULT TRUE,
  skip_reason TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,          -- TRUE if delivered via a TEST send
  chatwoot_message_id BIGINT,                      -- set on successful send (idempotency)
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_cf_recipients_campaign ON chat_campaign_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_cf_recipients_status ON chat_campaign_recipients (campaign_id, status);

-- Append-only audit of everything that happens to a campaign (create, materialize, test-send, …).
CREATE TABLE IF NOT EXISTS chat_campaign_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES chat_campaigns (id) ON DELETE CASCADE,
  recipient_id BIGINT,
  actor TEXT,
  event_type TEXT NOT NULL,                         -- created | materialized | test_send | send_blocked | error | …
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cf_events_campaign ON chat_campaign_events (campaign_id, created_at);
