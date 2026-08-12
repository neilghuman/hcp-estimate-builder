-- Curated pricebook: replaces the HCP-extracted table with a clean, admin-managed schema.
-- Drop old table and recreate with new columns.

DROP TABLE IF EXISTS pricebook;

CREATE TABLE pricebook (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      TEXT NOT NULL DEFAULT 'General',
  name          TEXT NOT NULL,
  description   TEXT,
  unit_price    BIGINT NOT NULL DEFAULT 0,  -- cents
  unit_of_measure TEXT,
  kind          TEXT NOT NULL DEFAULT 'labor',
  taxable       BOOLEAN NOT NULL DEFAULT FALSE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 0,
  notes         TEXT,  -- internal only, never sent to HCP
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pb_category ON pricebook (category);
CREATE INDEX IF NOT EXISTS idx_pb_active    ON pricebook (active);
CREATE INDEX IF NOT EXISTS idx_pb_sort      ON pricebook (category, sort_order, name);
