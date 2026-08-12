-- Chat Foundry — message templates + version history.
-- Applied automatically on server startup by initializeDatabase().

CREATE TABLE IF NOT EXISTS chat_message_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Custom',
  tags TEXT[] NOT NULL DEFAULT '{}',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',        -- active | archived
  current_version INT NOT NULL DEFAULT 1,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cf_templates_status ON chat_message_templates (status);
CREATE INDEX IF NOT EXISTS idx_cf_templates_category ON chat_message_templates (category);

-- Immutable version history — prior versions are never overwritten.
CREATE TABLE IF NOT EXISTS chat_message_template_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES chat_message_templates (id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  change_note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_cf_versions_template ON chat_message_template_versions (template_id);
