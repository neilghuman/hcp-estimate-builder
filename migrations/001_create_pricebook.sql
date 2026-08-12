-- ScopeFoundry Pricebook Table
-- Stores extracted line items from HCP estimates to prevent duplicates

CREATE TABLE IF NOT EXISTS pricebook (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  unit_price BIGINT NOT NULL,
  unit_of_measure TEXT,
  kind TEXT DEFAULT 'labor',
  taxable BOOLEAN DEFAULT FALSE,
  source_estimate_id TEXT,
  usage_count INT DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, unit_price)
);

CREATE INDEX IF NOT EXISTS idx_pricebook_name ON pricebook (name);
CREATE INDEX IF NOT EXISTS idx_pricebook_last_synced ON pricebook (last_synced_at DESC);
