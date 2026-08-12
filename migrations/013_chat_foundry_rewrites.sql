-- Chat Foundry — LLM rewrite audit log (Sprint 4).
-- Applied automatically on server startup by initializeDatabase().
--
-- Every rewrite suggestion is recorded here (a preview action — never a send). The operator's
-- accept/reject decision is written back so we retain a full audit trail of what the LLM proposed
-- and what a human chose to keep. Note: template_id is intentionally NOT a foreign key so rewrite
-- history survives template deletion.
CREATE TABLE IF NOT EXISTS chat_message_rewrites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id BIGINT,                             -- optional source template (no FK on purpose)
  actor TEXT,                                     -- operator (Basic Auth user or 'operator')
  model TEXT NOT NULL DEFAULT '',                 -- LLM model that produced the rewrite
  tone TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  original_body TEXT NOT NULL DEFAULT '',
  rewritten_body TEXT NOT NULL DEFAULT '',
  placeholder_warning TEXT,                       -- non-null if placeholders drifted
  accepted BOOLEAN,                               -- NULL = undecided, TRUE/FALSE = operator decision
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cf_rewrites_template ON chat_message_rewrites (template_id);
CREATE INDEX IF NOT EXISTS idx_cf_rewrites_created ON chat_message_rewrites (created_at DESC);
