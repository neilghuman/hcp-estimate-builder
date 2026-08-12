-- Drop legacy price book columns now that all reads/writes use the aligned columns.
-- Migration 004 added internal_notes/estimator_notes/ai_scope_notes and backfilled them
-- from notes/internal_scope/recommended_notes. This re-runs the backfill defensively
-- (in case any row still has a null canonical value with legacy data) and then drops the
-- legacy columns. Take a fresh SQL backup before applying in production.

UPDATE pricebook SET
  internal_notes = COALESCE(internal_notes, notes),
  estimator_notes = COALESCE(estimator_notes, internal_scope),
  ai_scope_notes = COALESCE(ai_scope_notes, recommended_notes)
WHERE internal_notes IS NULL
   OR estimator_notes IS NULL
   OR ai_scope_notes IS NULL;

ALTER TABLE pricebook DROP COLUMN IF EXISTS notes;
ALTER TABLE pricebook DROP COLUMN IF EXISTS internal_scope;
ALTER TABLE pricebook DROP COLUMN IF EXISTS recommended_notes;
