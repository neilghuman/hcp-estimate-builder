-- Studio drafts: server-side, numbered, work-in-progress estimates saved from the Studio.
-- The IDENTITY id is the human-referenceable draft number (#1, #2, …); it is never reused.
CREATE TABLE IF NOT EXISTS studio_drafts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'Untitled estimate',
  division    TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_drafts_updated_at ON studio_drafts (updated_at DESC);
