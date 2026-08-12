-- Phase R1: RAG + Learning loop — curated exemplar corpus.
--
-- A clean, deduped, embedded retrieval corpus of APPROVED service outputs. Separate from the
-- noisy operational ai_enrichment_runs so semantic retrieval stays fast and high-signal.
--
-- We embed BY the input characteristics (name + category + hints) so "services like this one"
-- surface, and we store the approved OUTPUT (customer_description / recommendations) to inject
-- as few-shot STYLE references during generation. Embeddings are nomic-embed-text (768-dim),
-- same model/index strategy as the Duplicate Finder (migration 009).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS service_exemplars (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_run_id        TEXT,                 -- ai_enrichment_runs.id (nullable; backfill path)
  pricebook_id         BIGINT,               -- originating price-book item (nullable; human path)

  name                 TEXT NOT NULL,
  category             TEXT,
  unit_of_measure      TEXT,

  -- Input characteristics we retrieve BY:
  input_context        JSONB,
  embedding            vector(768),
  embedding_source     TEXT,                 -- exact text that produced `embedding`

  -- Approved output we inject as a few-shot example:
  customer_description TEXT,
  recommendations      TEXT,
  description          TEXT,                 -- internal "what it includes"

  -- Quality / provenance for ranking + curation:
  quality_score        NUMERIC,             -- blended QA + human bonus
  status               TEXT NOT NULL DEFAULT 'approved',  -- approved | candidate | rejected
  source               TEXT NOT NULL,        -- human_edit | qa_auto | backfill

  usage_count          INT DEFAULT 0,
  last_retrieved_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One exemplar per saved price-book item (human path upserts on re-save).
CREATE UNIQUE INDEX IF NOT EXISTS idx_exemplars_pricebook
  ON service_exemplars (pricebook_id) WHERE pricebook_id IS NOT NULL;
-- One exemplar per enrichment run (backfill path is idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS idx_exemplars_run
  ON service_exemplars (source_run_id) WHERE source_run_id IS NOT NULL;

-- HNSW cosine index for top-k semantic retrieval (no training step; great on small tables).
CREATE INDEX IF NOT EXISTS idx_exemplars_embedding_hnsw
  ON service_exemplars USING hnsw (embedding vector_cosine_ops);
-- Status + category for the approved/same-category pre-filter.
CREATE INDEX IF NOT EXISTS idx_exemplars_status_cat
  ON service_exemplars (status, category);
