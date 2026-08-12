-- Add AI-assisted description fields to curated pricebook.

ALTER TABLE pricebook
  ADD COLUMN IF NOT EXISTS customer_description TEXT,
  ADD COLUMN IF NOT EXISTS internal_scope TEXT,
  ADD COLUMN IF NOT EXISTS exclusions TEXT,
  ADD COLUMN IF NOT EXISTS recommended_notes TEXT,
  ADD COLUMN IF NOT EXISTS ai_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_pb_ai_status ON pricebook (ai_status);
