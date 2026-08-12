// Backfill pgvector embeddings for existing pricebook rows (Phase E5 Duplicate Finder).
// Usage:  node scripts/backfill-embeddings.mjs [--all]
//   default: only rows missing an embedding or whose source text changed
//   --all  : re-embed every active row
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { embeddingSourceText, embedText } from '../src/pricebook.js';

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

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'jobber-postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'hcp',
  user: process.env.DB_USER || 'hcp_writer',
  password: process.env.DB_PASSWORD || '',
});

function toVectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).join(',')}]`;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, name, description, embedding_source, (embedding IS NOT NULL) AS has_embedding
     FROM pricebook WHERE active = TRUE ORDER BY id`
  );
  let done = 0, skipped = 0, failed = 0;
  for (const item of rows) {
    const source = embeddingSourceText(item);
    if (!source) { skipped += 1; continue; }
    if (!force && item.has_embedding && item.embedding_source === source) { skipped += 1; continue; }
    try {
      const vec = await embedText(source);
      await pool.query(
        `UPDATE pricebook SET embedding = $1::vector, embedding_source = $2, embedding_updated_at = NOW() WHERE id = $3`,
        [toVectorLiteral(vec), source, item.id]
      );
      done += 1;
      if (done % 25 === 0) console.log(`  …embedded ${done} rows`);
    } catch (err) {
      failed += 1;
      console.warn(`  ⚠ id=${item.id} (${item.name}): ${err.message}`);
    }
  }
  console.log(`Done. embedded=${done} skipped=${skipped} failed=${failed} total=${rows.length}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
