-- Drip S10: dashboard-editable copy store for the n8n AUTO-REPLIES (the T0 welcome messages),
-- so all outbound copy (welcome + drip follow-ups) lives in one place. n8n reads these at send
-- time and falls back to its baked-in strings if the fetch fails. Body-change is versioned.
-- Rows are populated from the live n8n workflows (exact copy incl. emojis) after deploy.

CREATE TABLE IF NOT EXISTS drip_template (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,       -- e.g. 'autoreply_tt_tree.stump'
  group_key    TEXT NOT NULL,              -- e.g. 'autoreply_tt_tree' (n8n fetches a whole group)
  sub_key      TEXT NOT NULL,              -- e.g. 'stump' | 'generic' | 'neutral' | 'in_hours'
  label        TEXT,
  body         TEXT NOT NULL,
  version      INT NOT NULL DEFAULT 1,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drip_template_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_key TEXT NOT NULL,
  body        TEXT NOT NULL,
  version     INT NOT NULL,
  changed_by  TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
