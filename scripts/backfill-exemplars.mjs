// Backfill the service_exemplars corpus from approved AI enrichment runs (Phase R1, RAG).
//
// Seeds the retrieval corpus so RAG has signal before any new human saves accumulate. Walks
// ai_enrichment_runs where the QA approved the output (or qa_overall >= RAG_EXEMPLARS_MIN_QA)
// and upserts one exemplar per run (idempotent on source_run_id).
//
// Usage:  node scripts/backfill-exemplars.mjs [--all] [--min-qa=90]
//   default: approved runs OR qa_overall >= min-qa, skipping runs already exemplified
//   --all  : re-embed/refresh every eligible run
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { upsertExemplar } from '../src/exemplars.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const force = process.argv.includes('--all');
const minQaArg = process.argv.find((a) => a.startsWith('--min-qa='));
const minQa = minQaArg ? Number(minQaArg.split('=')[1]) : Number(process.env.RAG_EXEMPLARS_MIN_QA || 90);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'jobber-postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'hcp',
  user: process.env.DB_USER || 'hcp_writer',
  password: process.env.DB_PASSWORD || '',
});

// Map an enrichment run (input ctx + output fields) onto the shape upsertExemplar expects.
function runToItem(run) {
  const input = run.input || {};
  const output = run.output || {};
  return {
    id: null, // run-based exemplar: conflict target is source_run_id
    name: String(input.name || output.name || '').trim(),
    category: output.category || input.category || null,
    unit_of_measure: input.unitOfMeasure || input.unit_of_measure || null,
    description: output.description || input.description || null,
    estimator_notes: output.estimator_notes || null,
    ai_scope_notes: output.ai_scope_notes || null,
    customer_description: output.customer_description || null,
    recommendations: output.recommendations || null,
  };
}

async function main() {
  const { rows } = await pool.query(
    `SELECT r.id, r.input, r.output, r.qa_overall, r.approved
     FROM ai_enrichment_runs r
     WHERE r.output IS NOT NULL
       AND (r.approved = TRUE OR r.qa_overall >= $1)
       AND (r.output ->> 'customer_description') IS NOT NULL
       AND length(trim(r.output ->> 'customer_description')) > 0
       ${force ? '' : 'AND NOT EXISTS (SELECT 1 FROM service_exemplars e WHERE e.source_run_id = r.id)'}
     ORDER BY r.updated_at DESC`,
    [minQa]
  );

  let done = 0, skipped = 0, failed = 0;
  for (const run of rows) {
    const item = runToItem(run);
    if (!item.name || !item.customer_description) { skipped += 1; continue; }
    try {
      await upsertExemplar(pool, item, {
        source: 'qa_auto',
        runId: run.id,
        qualityScore: run.qa_overall != null ? Number(run.qa_overall) : minQa,
      });
      done += 1;
      if (done % 25 === 0) console.log(`  …exemplified ${done} runs`);
    } catch (err) {
      failed += 1;
      console.warn(`  ⚠ run=${run.id}: ${err.message}`);
    }
  }
  console.log(`Done. exemplified=${done} skipped=${skipped} failed=${failed} eligible=${rows.length} (min-qa=${minQa})`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
