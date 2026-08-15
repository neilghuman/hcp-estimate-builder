-- Tie auto-reply templates to the canonical drip category taxonomy.
-- Adds an optional category_key to drip_template so a template can be selected by the SAME
-- category resolved from drip_category_map that the drip sequences use (single taxonomy).
ALTER TABLE drip_template ADD COLUMN IF NOT EXISTS category_key TEXT;

-- Backfill the one priced auto-reply we have today: Thumbtack tree stump grinding.
UPDATE drip_template
   SET category_key = 'stump_grinding'
 WHERE template_key = 'autoreply_tt_tree.stump'
   AND category_key IS NULL;
