-- Studio templates: server-side, reusable estimate templates saved from the Studio.
-- Replaces the previous localStorage-only prototype (state.templates). The estimate
-- structure (division, measurements, packages) lives in the JSONB `body`; management
-- metadata (status, homepage feature) lives in dedicated columns.
--
-- Backward compatibility: existing localStorage templates are imported once by the
-- Studio frontend (POST /api/studio/templates) on first load after this ships.
CREATE TABLE IF NOT EXISTS studio_templates (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  division                 TEXT,
  category                 TEXT,
  body                     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { measurements, packages }
  status                   TEXT NOT NULL DEFAULT 'active',        -- active | hidden
  is_featured_on_homepage  BOOLEAN NOT NULL DEFAULT FALSE,
  homepage_icon            TEXT,
  homepage_description     TEXT,
  homepage_sort_order      INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_templates_status ON studio_templates (status);
CREATE INDEX IF NOT EXISTS idx_studio_templates_homepage
  ON studio_templates (is_featured_on_homepage, homepage_sort_order);
