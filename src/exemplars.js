// Phase R1: RAG + Learning loop — exemplar corpus read/write helpers.
//
// Reuses the Duplicate Finder's embedding stack (Ollama nomic-embed-text, 768-dim) from
// pricebook.js. We embed BY a service's INPUT characteristics (name + category + hints) and
// retrieve the most similar APPROVED past outputs, so generation can be grounded in the
// company's own best descriptions as few-shot STYLE references.
//
// Everything here is best-effort: a failure (Ollama down, no corpus yet) must NEVER block a
// save or a generation — it just degrades to today's behaviour (no examples).
import { embedText } from './pricebook.js';

const T = 'service_exemplars';

const exemplarsEnabled = () =>
  String(process.env.RAG_EXEMPLARS_ENABLED ?? 'true').toLowerCase() !== 'false';
const exemplarsK = () => {
  const n = Number(process.env.RAG_EXEMPLARS_K);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
};
const exemplarsMaxDistance = () => {
  const n = Number(process.env.RAG_EXEMPLARS_MAX_DISTANCE);
  return Number.isFinite(n) ? n : 0.35;
};
const exemplarsMinQa = () => {
  const n = Number(process.env.RAG_EXEMPLARS_MIN_QA);
  return Number.isFinite(n) ? n : 90;
};
const humanBonus = () => {
  const n = Number(process.env.RAG_EXEMPLARS_HUMAN_BONUS);
  return Number.isFinite(n) ? n : 15;
};

function toVectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).join(',')}]`;
}

// Text we retrieve BY: the input characteristics, NOT the polished output. Kept in the same
// shape for both the live query and stored exemplars so they share one vector space.
export function exemplarSourceText({ name, category, hints, description } = {}) {
  return [
    String(name || '').trim(),
    String(category || '').trim(),
    String(hints || description || '').trim(),
  ]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 2000);
}

// Upsert one exemplar from an approved/written service. `item` is a pricebook row (human path)
// or a synthesized row from an enrichment run (backfill path). Requires a non-empty
// customer_description (only finished outputs become exemplars). Never throws.
export async function upsertExemplar(
  pool,
  item,
  { source = 'human_edit', qualityScore = null, runId = null } = {}
) {
  try {
    if (!exemplarsEnabled() || !item) return;
    const customerDescription = String(item.customer_description || '').trim();
    const name = String(item.name || '').trim();
    if (!customerDescription || !name) return;

    const sourceText = exemplarSourceText({
      name,
      category: item.category,
      hints: item.description, // internal "what it includes" / AI hints
    });
    if (!sourceText) return;

    const vec = await embedText(sourceText);
    if (!vec) return;

    const baseQa = qualityScore == null ? exemplarsMinQa() : Number(qualityScore);
    const quality = baseQa + (source === 'human_edit' ? humanBonus() : 0);

    const inputContext = JSON.stringify({
      name,
      category: item.category || null,
      unitOfMeasure: item.unit_of_measure || null,
      description: item.description || null,
      estimator_notes: item.estimator_notes || null,
      ai_scope_notes: item.ai_scope_notes || null,
    });

    const conflict =
      item.id != null
        ? 'ON CONFLICT (pricebook_id) WHERE pricebook_id IS NOT NULL'
        : 'ON CONFLICT (source_run_id) WHERE source_run_id IS NOT NULL';

    await pool.query(
      `INSERT INTO ${T}
         (source_run_id, pricebook_id, name, category, unit_of_measure, input_context,
          embedding, embedding_source, customer_description, recommendations, description,
          quality_score, status, source)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::vector,$8,$9,$10,$11,$12,'approved',$13)
       ${conflict}
       DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         unit_of_measure = EXCLUDED.unit_of_measure,
         input_context = EXCLUDED.input_context,
         embedding = EXCLUDED.embedding,
         embedding_source = EXCLUDED.embedding_source,
         customer_description = EXCLUDED.customer_description,
         recommendations = EXCLUDED.recommendations,
         description = EXCLUDED.description,
         quality_score = EXCLUDED.quality_score,
         source = EXCLUDED.source,
         status = 'approved',
         updated_at = NOW()`,
      [
        runId,
        item.id ?? null,
        name,
        item.category || null,
        item.unit_of_measure || null,
        inputContext,
        toVectorLiteral(vec),
        sourceText,
        customerDescription,
        item.recommendations || null,
        item.description || null,
        quality,
        source,
      ]
    );
  } catch (err) {
    console.warn(`⚠ upsertExemplar skipped: ${err.message}`);
  }
}

// Retrieve up to k approved exemplars most similar to the given service's INPUT. Prefers
// same-category matches, ranks by cosine similarity × quality weight, and only returns
// matches within RAG_EXEMPLARS_MAX_DISTANCE. Returns [] on any failure or empty corpus.
export async function findExemplars(
  pool,
  { name, category, hints, description, excludeId = null, k } = {}
) {
  try {
    if (!exemplarsEnabled()) return [];
    const limit = k && k > 0 ? k : exemplarsK();
    const sourceText = exemplarSourceText({ name, category, hints, description });
    if (!sourceText) return [];

    let vec = null;
    try {
      vec = await embedText(sourceText);
    } catch (err) {
      console.warn(`⚠ Exemplar query embed failed: ${err.message}`);
    }
    if (!vec) return [];

    const { rows } = await pool.query(
      `SELECT id, name, category, customer_description, recommendations, quality_score,
              (embedding <=> $1::vector) AS distance,
              (category IS NOT NULL AND category = $2) AS same_category
       FROM ${T}
       WHERE status = 'approved'
         AND embedding IS NOT NULL
         AND ($3::bigint IS NULL OR pricebook_id IS NULL OR pricebook_id <> $3::bigint)
         AND (embedding <=> $1::vector) <= $4::float
       ORDER BY (category IS NOT NULL AND category = $2) DESC,
                ((1 - (embedding <=> $1::vector)) * (COALESCE(quality_score, 90) / 100.0)) DESC
       LIMIT $5`,
      [toVectorLiteral(vec), category || null, excludeId, exemplarsMaxDistance(), limit]
    );

    // Best-effort usage telemetry (fire-and-forget).
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      pool
        .query(
          `UPDATE ${T} SET usage_count = usage_count + 1, last_retrieved_at = NOW() WHERE id = ANY($1::bigint[])`,
          [ids]
        )
        .catch(() => {});
    }

    return rows.map((r) => ({
      name: r.name,
      category: r.category,
      customerDescription: r.customer_description,
      recommendations: r.recommendations,
      qualityScore: r.quality_score == null ? null : Number(r.quality_score),
      distance: Number(Number(r.distance).toFixed(3)),
    }));
  } catch (err) {
    console.warn(`⚠ findExemplars failed: ${err.message}`);
    return [];
  }
}
