-- Phase E5: Duplicate Finder infrastructure
-- pg_trgm for cheap name-similarity pre-filter; pgvector for semantic confirmation.
-- Embeddings are nomic-embed-text (768-dim) generated via Ollama and backfilled by
-- scripts/backfill-embeddings.mjs (and kept fresh on item create/update).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE pricebook ADD COLUMN IF NOT EXISTS embedding vector(768);
-- Snapshot of the exact text that produced `embedding`, so backfill can skip unchanged rows.
ALTER TABLE pricebook ADD COLUMN IF NOT EXISTS embedding_source TEXT;
ALTER TABLE pricebook ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

-- Trigram GIN index for fast fuzzy name matching (pre-filter candidate retrieval).
CREATE INDEX IF NOT EXISTS idx_pricebook_name_trgm ON pricebook USING gin (name gin_trgm_ops);

-- HNSW index for cosine similarity (works well on small tables, no training step).
CREATE INDEX IF NOT EXISTS idx_pricebook_embedding_hnsw
  ON pricebook USING hnsw (embedding vector_cosine_ops);
