-- Align pricebook columns with the Studio service model.
-- Step 1 of 2 (staged): ADD new columns + backfill from legacy.
-- Legacy columns (notes, internal_scope, recommended_notes) are intentionally
-- KEPT so existing CSV/SQL backups still restore. They are dropped later in 005.

ALTER TABLE pricebook
  ADD COLUMN IF NOT EXISTS internal_notes  TEXT,
  ADD COLUMN IF NOT EXISTS crew_notes      TEXT,
  ADD COLUMN IF NOT EXISTS estimator_notes TEXT,
  ADD COLUMN IF NOT EXISTS hcp_notes       TEXT,
  ADD COLUMN IF NOT EXISTS ai_scope_notes  TEXT,
  ADD COLUMN IF NOT EXISTS tags            TEXT[] NOT NULL DEFAULT '{}';

-- Backfill new columns from legacy ones (only where the new column is still empty).
UPDATE pricebook
   SET internal_notes  = COALESCE(internal_notes,  notes),
       estimator_notes = COALESCE(estimator_notes, internal_scope),
       ai_scope_notes  = COALESCE(ai_scope_notes,  recommended_notes)
 WHERE internal_notes IS NULL
    OR estimator_notes IS NULL
    OR ai_scope_notes IS NULL;

CREATE INDEX IF NOT EXISTS idx_pb_tags ON pricebook USING GIN (tags);
