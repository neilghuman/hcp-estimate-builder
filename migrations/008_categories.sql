-- Phase E: two-level service category taxonomy.
--
-- A self-referential `categories` table holds a parent -> child tree. Existing
-- pricebook.category strings remain the source of truth on each row (kept as plain
-- text; an optional FK can be added later); this table gives the taxonomy structure
-- the Category Auditor agent and the UI can reason about.
--
-- Seeded from the curated 2-level mapping approved for United Services Northwest.
-- Top-level groups whose name also appears verbatim as a pricebook category
-- (Irrigation, Hardscape & Drainage, Snow & Ice) act as top-level leaves.

CREATE TABLE IF NOT EXISTS categories (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id   BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Top-level names must be unique; (parent, name) pairs must be unique among children.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_top_name
  ON categories (name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_child_name
  ON categories (parent_id, name) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id);

-- Seed top-level groups (parent_id NULL).
INSERT INTO categories (name, sort_order) VALUES
  ('Turf & Lawn Care', 10),
  ('Landscaping', 20),
  ('Tree Services', 30),
  ('Exterior Cleaning', 40),
  ('Cleanup & Hauling', 50),
  ('Irrigation', 60),
  ('Hardscape & Drainage', 70),
  ('Snow & Ice', 80),
  ('Maintenance Plans', 90),
  ('General & Admin', 100)
ON CONFLICT DO NOTHING;

-- Seed children, resolving each parent by name.
INSERT INTO categories (parent_id, name, sort_order)
SELECT p.id, c.name, c.sort_order
FROM (VALUES
  ('Turf & Lawn Care', 'Turf Care', 1),
  ('Turf & Lawn Care', 'Mowing', 2),
  ('Turf & Lawn Care', 'Blade Edging', 3),
  ('Turf & Lawn Care', 'Weed Control - Hand', 4),
  ('Landscaping', 'General Landscaping', 1),
  ('Landscaping', 'Bed & Mulch', 2),
  ('Landscaping', 'Mulch Care', 3),
  ('Landscaping', 'Shrubs & Hedges', 4),
  ('Landscaping', 'Seasonal Enhancements', 5),
  ('Tree Services', 'Trees', 1),
  ('Exterior Cleaning', 'Pressure Washing & Exterior', 1),
  ('Exterior Cleaning', 'Power Blowing', 2),
  ('Cleanup & Hauling', 'Clean Up', 1),
  ('Cleanup & Hauling', 'Cleanup & Haul', 2),
  ('Cleanup & Hauling', 'Policing', 3),
  ('Maintenance Plans', 'Commercial Maintenance', 1),
  ('General & Admin', 'General', 1),
  ('General & Admin', 'Traveling', 2)
) AS c(parent_name, name, sort_order)
JOIN categories p ON p.name = c.parent_name AND p.parent_id IS NULL
ON CONFLICT DO NOTHING;
