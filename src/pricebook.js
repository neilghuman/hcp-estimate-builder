import xlsx from 'xlsx';
import { upsertExemplar } from './exemplars.js';

const T = 'pricebook';
const AI_FIELD_KEYS = ['description', 'estimator_notes', 'exclusions', 'ai_scope_notes'];

// Read lazily at call time: server.js loads .env AFTER this module is imported,
// so reading these at module-load would capture stale defaults (ES imports are hoisted).
const ollamaBase = () => String(process.env.OLLAMA_API_BASE || 'http://10.0.10.102:11434').replace(/\/$/, '');
const ollamaModel = () => String(process.env.OLLAMA_MODEL || 'llama3.1:latest');
// How long Ollama keeps the model resident after a request (avoids cold-load stalls between clicks).
const ollamaKeepAlive = () => process.env.OLLAMA_KEEP_ALIVE || '30m';
// Embedding model for duplicate detection (768-dim). Must be pulled into Ollama.
const ollamaEmbedModel = () => String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text');

// Duplicate Finder thresholds (env-tunable against real near-dupes). A candidate qualifies when
// its trigram name similarity is >= DUP_TRGM_MIN OR its embedding cosine distance is <= DUP_COSINE_MAX.
// With the lowercase embedding fix in place, unrelated service names sit around cosine 0.50 (distance
// ~0.50) while true near-dupes score 0.90+ (distance <= 0.10), so a 0.20 distance cap (>= 0.80 cosine
// similarity) cleanly separates real duplicates from coincidental matches.
const dupTrgmMin = () => { const n = Number(process.env.DUP_TRGM_MIN); return Number.isFinite(n) ? n : 0.25; };
const dupCosineMax = () => { const n = Number(process.env.DUP_COSINE_MAX); return Number.isFinite(n) ? n : 0.20; };

// Canonical text we embed for a pricebook item — name carries most of the duplicate signal,
// description adds disambiguation. Kept stable so backfill can skip unchanged rows.
export function embeddingSourceText({ name, description } = {}) {
  return [String(name || '').trim(), String(description || '').trim()]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 2000);
}

// Returns a 768-dim embedding array for `text`, or null if Ollama is unreachable.
// NOTE: the input is lowercased before embedding. Ollama's nomic-embed-text tokenizer maps
// capitalized tokens to [UNK], which collapses any Title-Case input (e.g. "Pressure Washing")
// to a constant garbage vector — making unrelated items look 100% identical. Lowercasing
// restores a real, discriminative embedding (verified: unrelated ~0.50, true dupes 0.90+).
export async function embedText(text) {
  const input = String(text || '').trim().toLowerCase();
  if (!input) return null;
  const resp = await fetch(`${ollamaBase()}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaEmbedModel(), prompt: input, keep_alive: ollamaKeepAlive() }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Ollama embed error ${resp.status}: ${raw.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Ollama embed: invalid JSON response'); }
  const vec = parsed && Array.isArray(parsed.embedding) ? parsed.embedding : null;
  if (!vec || !vec.length) throw new Error('Ollama embed: empty embedding');
  return vec;
}

// pgvector literal: '[0.1,0.2,...]'
function toVectorLiteral(vec) {
  return `[${vec.map((n) => Number(n)).join(',')}]`;
}

// Best-effort: compute + persist an item's embedding. Never throws (writes must not fail
// just because Ollama is down). Skips when the source text is unchanged.
export async function refreshItemEmbedding(pool, item) {
  try {
    if (!item || !item.id) return;
    const source = embeddingSourceText(item);
    if (!source) return;
    if (item.embedding_source && item.embedding_source === source && item.embedding) return;
    const vec = await embedText(source);
    if (!vec) return;
    await pool.query(
      `UPDATE ${T} SET embedding = $1::vector, embedding_source = $2, embedding_updated_at = NOW() WHERE id = $3`,
      [toVectorLiteral(vec), source, item.id]
    );
  } catch (err) {
    console.warn(`⚠ Embedding refresh skipped for item ${item?.id}: ${err.message}`);
  }
}

// Duplicate Finder candidate retrieval: pg_trgm name pre-filter + pgvector cosine confirm.
// Embeds the draft, then returns the most similar existing pricebook items. Returns []
// on any failure (advisory feature — must never block enrichment).
export async function findDuplicateCandidates(pool, { name, description, excludeId = null, limit = 6 } = {}) {
  try {
    const source = embeddingSourceText({ name, description });
    if (!source) return [];
    let vec = null;
    try { vec = await embedText(source); } catch (err) { console.warn(`⚠ Duplicate embed failed: ${err.message}`); }
    const nameText = String(name || '').trim();
    const trgmMin = dupTrgmMin();
    const cosineMax = dupCosineMax();
    const params = [nameText, excludeId, limit, trgmMin];
    let vectorSelect = 'NULL::float AS cosine_sim';
    let vectorWhere = '';
    let orderExpr = 'similarity(name, $1)';
    if (vec) {
      params.push(toVectorLiteral(vec)); // $5
      params.push(cosineMax); // $6
      vectorSelect = '1 - (embedding <=> $5::vector) AS cosine_sim';
      vectorWhere = 'OR (embedding IS NOT NULL AND (embedding <=> $5::vector) <= $6::float)';
      orderExpr = 'GREATEST(similarity(name, $1), CASE WHEN embedding IS NULL THEN 0 ELSE 1 - (embedding <=> $5::vector) END)';
    }
    const { rows } = await pool.query(
      `SELECT id, name, category, unit_price, unit_of_measure,
              similarity(name, $1) AS trgm_sim,
              ${vectorSelect}
       FROM ${T}
       WHERE active = TRUE
         AND ($2::bigint IS NULL OR id <> $2::bigint)
         AND (similarity(name, $1) >= $4::float ${vectorWhere})
       ORDER BY ${orderExpr} DESC
       LIMIT $3`,
      params
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      unitPrice: r.unit_price,
      unitOfMeasure: r.unit_of_measure,
      trgmSim: r.trgm_sim == null ? null : Number(Number(r.trgm_sim).toFixed(3)),
      cosineSim: r.cosine_sim == null ? null : Number(Number(r.cosine_sim).toFixed(3)),
    }));
  } catch (err) {
    console.warn(`⚠ findDuplicateCandidates failed: ${err.message}`);
    return [];
  }
}

export async function listItems(pool, { includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = TRUE';
  const { rows } = await pool.query(
    `SELECT id, category, name, description, customer_description, exclusions,
            unit_price, unit_of_measure, kind, taxable, active, sort_order,
            ai_status, internal_notes, crew_notes, estimator_notes, hcp_notes,
            ai_scope_notes, tags, recommendations, created_at, updated_at
     FROM ${T}
     ${where}
     ORDER BY category, sort_order, name`
  );
  return rows;
}

export async function listCategories(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT category FROM ${T} WHERE active = TRUE ORDER BY category`
  );
  return rows.map((r) => r.category);
}

// --- Category taxonomy (two-level parent -> child tree) ----------------------

// Nested tree of active categories: [{ id, name, sortOrder, children: [...] }].
export async function listCategoryTree(pool) {
  const { rows } = await pool.query(
    `SELECT id, parent_id, name, sort_order, active
     FROM categories WHERE active = TRUE
     ORDER BY parent_id NULLS FIRST, sort_order, name`
  );
  const byId = new Map();
  const roots = [];
  for (const r of rows) {
    byId.set(r.id, { id: r.id, name: r.name, sortOrder: r.sort_order, children: [] });
  }
  for (const r of rows) {
    const node = byId.get(r.id);
    if (r.parent_id != null && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(node);
    else roots.push(node);
  }
  return roots;
}

// Flat "Parent / Child" path labels for prompts/logging (top-level leaves => just the name).
export async function listCategoryPaths(pool) {
  const tree = await listCategoryTree(pool);
  const paths = [];
  for (const parent of tree) {
    if (parent.children.length) {
      for (const child of parent.children) paths.push(`${parent.name} / ${child.name}`);
    } else {
      paths.push(parent.name);
    }
  }
  return paths;
}

// Peer pricing stats for a category, in DOLLARS (unit_price is stored in cents).
// Used by the Pricing Reviewer agent to judge outliers. Returns null if no peers.
export async function getPriceContext(pool, category) {
  const cat = String(category || '').trim();
  if (!cat) return null;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            MIN(unit_price) AS min_c,
            MAX(unit_price) AS max_c,
            ROUND(AVG(unit_price))::int AS avg_c,
            MODE() WITHIN GROUP (ORDER BY unit_of_measure) AS common_uom
     FROM ${T}
     WHERE active = TRUE AND category = $1 AND unit_price IS NOT NULL`,
    [cat]
  );
  const r = rows[0];
  if (!r || !r.count) return null;
  const toDollars = (c) => (c == null ? null : Math.round(Number(c)) / 100);
  return {
    category: cat,
    count: r.count,
    min: toDollars(r.min_c),
    avg: toDollars(r.avg_c),
    max: toDollars(r.max_c),
    commonUom: r.common_uom || '',
  };
}

export async function createCategory(pool, { name, parentId = null, sortOrder = 0 } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('Category name is required.'), { status: 400 });
  const pid = parentId === '' || parentId == null ? null : Number(parentId);
  const { rows } = await pool.query(
    `INSERT INTO categories (parent_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *`,
    [pid, clean, Number(sortOrder) || 0]
  );
  return rows[0];
}

export async function updateCategory(pool, id, fields = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (fields.name !== undefined) {
    const clean = String(fields.name || '').trim();
    if (!clean) throw Object.assign(new Error('Category name is required.'), { status: 400 });
    sets.push(`name = $${i++}`);
    vals.push(clean);
  }
  if (fields.parentId !== undefined) {
    sets.push(`parent_id = $${i++}`);
    vals.push(fields.parentId === '' || fields.parentId == null ? null : Number(fields.parentId));
  }
  if (fields.sortOrder !== undefined) {
    sets.push(`sort_order = $${i++}`);
    vals.push(Number(fields.sortOrder) || 0);
  }
  if (fields.active !== undefined) {
    sets.push(`active = $${i++}`);
    vals.push(Boolean(fields.active));
  }
  if (!sets.length) return getCategory(pool, id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE categories SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) throw Object.assign(new Error('Not found'), { status: 404 });
  return rows[0];
}

export async function getCategory(pool, id) {
  const { rows } = await pool.query(`SELECT * FROM categories WHERE id = $1`, [id]);
  if (!rows.length) throw Object.assign(new Error('Not found'), { status: 404 });
  return rows[0];
}

export async function deleteCategory(pool, id) {
  // Children are re-parented to top-level (ON DELETE SET NULL handles the FK).
  const { rowCount } = await pool.query(`DELETE FROM categories WHERE id = $1`, [id]);
  if (!rowCount) throw Object.assign(new Error('Not found'), { status: 404 });
}

export async function getItem(pool, id) {
  const { rows } = await pool.query(`SELECT * FROM ${T} WHERE id = $1`, [id]);
  if (!rows.length) throw Object.assign(new Error('Not found'), { status: 404 });
  return rows[0];
}

export async function createItem(pool, fields) {
  const payload = normalizePayload(fields);
  validate(payload);
  const { rows } = await pool.query(
    `INSERT INTO ${T} (
      category, name, description, customer_description, exclusions,
      unit_price, unit_of_measure, kind, taxable, active, sort_order,
      ai_status, internal_notes, crew_notes, estimator_notes, hcp_notes,
      ai_scope_notes, tags, recommendations
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,
    [
      payload.category,
      payload.name,
      payload.description,
      payload.customer_description,
      payload.exclusions,
      payload.unit_price,
      payload.unit_of_measure,
      payload.kind,
      payload.taxable,
      payload.active,
      payload.sort_order,
      payload.ai_status,
      payload.internal_notes,
      payload.crew_notes,
      payload.estimator_notes,
      payload.hcp_notes,
      payload.ai_scope_notes,
      payload.tags,
      payload.recommendations,
    ]
  );
  await refreshItemEmbedding(pool, rows[0]);
  // RAG learning loop: a saved item with a written customer description becomes a
  // human-approved exemplar for future generations (best-effort, never blocks the save).
  await upsertExemplar(pool, rows[0], { source: 'human_edit' });
  return rows[0];
}

export async function updateItem(pool, id, fields) {
  const payload = normalizePayload(fields);
  validate(payload);
  const { rows } = await pool.query(
    `UPDATE ${T}
     SET category=$1, name=$2, description=$3, customer_description=$4,
         exclusions=$5, unit_price=$6, unit_of_measure=$7,
         kind=$8, taxable=$9, active=$10, sort_order=$11, ai_status=$12,
         internal_notes=$13, crew_notes=$14, estimator_notes=$15, hcp_notes=$16,
         ai_scope_notes=$17, tags=$18, recommendations=$19, updated_at=NOW()
     WHERE id=$20
     RETURNING *`,
    [
      payload.category,
      payload.name,
      payload.description,
      payload.customer_description,
      payload.exclusions,
      payload.unit_price,
      payload.unit_of_measure,
      payload.kind,
      payload.taxable,
      payload.active,
      payload.sort_order,
      payload.ai_status,
      payload.internal_notes,
      payload.crew_notes,
      payload.estimator_notes,
      payload.hcp_notes,
      payload.ai_scope_notes,
      payload.tags,
      payload.recommendations,
      id,
    ]
  );
  if (!rows.length) throw Object.assign(new Error('Not found'), { status: 404 });
  await refreshItemEmbedding(pool, rows[0]);
  // RAG learning loop: refresh this item's exemplar with the latest human-approved content.
  await upsertExemplar(pool, rows[0], { source: 'human_edit' });
  return rows[0];
}

export async function deleteItem(pool, id) {
  const { rowCount } = await pool.query(`DELETE FROM ${T} WHERE id = $1`, [id]);
  if (!rowCount) throw Object.assign(new Error('Not found'), { status: 404 });
}

export async function importItems(pool, buffer, { replace = false } = {}) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) throw new Error('No rows found in file.');

  if (replace) {
    await pool.query(`TRUNCATE ${T} RESTART IDENTITY`);
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const [idx, r] of rows.entries()) {
    const name = String(r.name || r.Name || r.line_name || '').trim();
    if (!name) throw new Error(`Row ${idx + 2}: name is required.`);

    const payload = normalizePayload({
      category: r.category || r.Category || 'General',
      name,
      description: r.description || r.Description || '',
      customer_description: r.customer_description || r['customer description'] || r.ai_description || r['AI description'] || '',
      internal_scope: r.internal_scope || r['internal scope'] || '',
      exclusions: r.exclusions || '',
      recommended_notes: r.recommended_notes || r['recommended notes'] || '',
      unit_price: parsePrice(r.unit_price || r.price || r.Price || 0),
      unit_of_measure: r.unit_of_measure || r.uom || '',
      kind: r.kind || r.Kind || 'labor',
      taxable: parseBool(r.taxable || r.Taxable),
      sort_order: Number(r.sort_order || 0) || 0,
      notes: r.notes || r.Notes || '',
      ai_status: r.ai_status || (r['AI description'] ? 'complete' : 'pending'),
      internal_notes: r.internal_notes || r['internal notes'] || '',
      crew_notes: r.crew_notes || r['crew notes'] || '',
      estimator_notes: r.estimator_notes || r['estimator notes'] || '',
      hcp_notes: r.hcp_notes || r['hcp notes'] || r['HCP notes'] || '',
      ai_scope_notes: r.ai_scope_notes || r['ai scope notes'] || r['AI scope notes'] || '',
      tags: r.tags || r.Tags || '',
      recommendations: r.recommendations || r.Recommendations || '',
    });

    validate(payload);

    const idRaw = String(r.id ?? r.ID ?? '').trim();
    if (!replace && idRaw) {
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) {
        skipped++;
        continue;
      }

      const updateResult = await pool.query(
        `UPDATE ${T}
         SET category=$1, name=$2, description=$3, customer_description=$4,
             exclusions=$5, unit_price=$6, unit_of_measure=$7,
             kind=$8, taxable=$9, active=$10, sort_order=$11, ai_status=$12,
             internal_notes=$13, crew_notes=$14, estimator_notes=$15, hcp_notes=$16,
             ai_scope_notes=$17, tags=$18, recommendations=$19, updated_at=NOW()
         WHERE id=$20`,
        [
          payload.category,
          payload.name,
          payload.description,
          payload.customer_description,
          payload.exclusions,
          payload.unit_price,
          payload.unit_of_measure,
          payload.kind,
          payload.taxable,
          payload.active,
          payload.sort_order,
          payload.ai_status,
          payload.internal_notes,
          payload.crew_notes,
          payload.estimator_notes,
          payload.hcp_notes,
          payload.ai_scope_notes,
          payload.tags,
          payload.recommendations,
          id,
        ]
      );

      if (updateResult.rowCount) {
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    await pool.query(
      `INSERT INTO ${T} (
        category, name, description, customer_description, exclusions,
        unit_price, unit_of_measure, kind, taxable, active, sort_order,
        ai_status, internal_notes, crew_notes, estimator_notes, hcp_notes,
        ai_scope_notes, tags, recommendations
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        payload.category,
        payload.name,
        payload.description,
        payload.customer_description,
        payload.exclusions,
        payload.unit_price,
        payload.unit_of_measure,
        payload.kind,
        payload.taxable,
        payload.active,
        payload.sort_order,
        payload.ai_status,
        payload.internal_notes,
        payload.crew_notes,
        payload.estimator_notes,
        payload.hcp_notes,
        payload.ai_scope_notes,
        payload.tags,
        payload.recommendations,
      ]
    );
    inserted++;
  }

  return { imported: rows.length, inserted, updated, skipped };
}

export async function generateTemplate(pool) {
  let items = [];
  try {
    items = await listItems(pool);
  } catch {
    items = [];
  }

  const wb = xlsx.utils.book_new();
  const templateRows = [
    ['option', 'option_message', 'line_name', 'description', 'unit_of_measure', 'quantity', 'frequency', 'unit_price', 'pricing_mode', 'flat_amount', 'kind', 'taxable'],
    ['Better', 'Enhanced package', 'Lawn Mowing', 'Weekly mowing service', 'visit', 1, 'weekly', 12000, 'calculated', 0, 'labor', 'no'],
    ['Best', 'Full property care', 'Lawn Mowing', 'Weekly mowing service', 'visit', 1, 'weekly', 12000, 'calculated', 0, 'labor', 'no'],
    ['Best', '', 'Spring Cleanup', 'One-time seasonal cleanup (flat rate)', 'job', 1, 'single', 0, 'flat', 45000, 'labor', 'no'],
  ];

  const ws = xlsx.utils.aoa_to_sheet(templateRows);
  ws['!cols'] = [14, 30, 24, 34, 18, 10, 16, 12, 14, 12, 12, 10].map((w) => ({ wch: w }));
  if (!ws['!dataValidation']) ws['!dataValidation'] = [];
  if (items.length) {
    ws['!dataValidation'].push({
      type: 'list',
      formula1: `Pricebook!$B$2:$B$${items.length + 1}`,
      sqref: 'C2:C500',
    });
  }
  xlsx.utils.book_append_sheet(wb, ws, 'Import Template');

  const pbRows = [
    ['Category', 'Name', 'Description', 'Unit Price (¢)', 'Unit', 'Kind', 'Taxable'],
    ...items.map((i) => [
      i.category,
      i.name,
      i.customer_description || i.description || '',
      i.unit_price,
      i.unit_of_measure || '',
      i.kind,
      i.taxable ? 'yes' : 'no',
    ]),
  ];
  const wsPb = xlsx.utils.aoa_to_sheet(pbRows);
  wsPb['!cols'] = [18, 28, 36, 14, 12, 10, 10].map((w) => ({ wch: w }));
  wsPb.hidden = true;
  xlsx.utils.book_append_sheet(wb, wsPb, 'Pricebook');

  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function generatePricebookCsvTemplate() {
  const header = [
    'id',
    'category',
    'name',
    'description',
    'unit_price',
    'unit_of_measure',
    'kind',
    'taxable',
    'sort_order',
    'AI description',
    'exclusions',
    'ai_status',
    'internal_notes',
    'crew_notes',
    'estimator_notes',
    'hcp_notes',
    'ai_scope_notes',
    'tags',
    'recommendations',
  ];

  const sampleRows = [
    [
      '',
      'Turf Care',
      'Weekly Lawn Mowing',
      'Weekly mowing and cleanup of clippings.',
      '12000',
      'visit',
      'labor',
      'no',
      '10',
      '',
      '',
      'pending',
      'Core recurring service.',
      '',
      '',
      '',
      '',
      'recurring, mowing',
      '',
    ],
    [
      '',
      'Bed & Mulch',
      'Mulch Installation',
      'Install and spread mulch in designated bed areas.',
      '200',
      'sq ft',
      'materials',
      'yes',
      '20',
      'Mulch installation for designated bed areas with clean edges and even depth.',
      'Does not include weed barrier, fabric replacement, or plant installation unless listed.',
      'complete',
      'Confirm bed square footage and target depth before install.',
      'Wear gloves; rake to even 2-3 inch depth; keep mulch off plant crowns.',
      'Verify access for wheelbarrow and material drop location.',
      'Customer prefers dark brown mulch.',
      'Recommend seasonal bed weeding as an add-on service.',
      'mulch, beds, seasonal',
      'Schedule mulch top-ups each spring to maintain depth, color, and weed suppression.',
    ],
  ];

  const lines = [header, ...sampleRows].map((row) => row.map(csvEscape).join(','));
  return lines.join('\n') + '\n';
}

export async function exportPricebookCsv(pool) {
  const items = await listItems(pool, { includeInactive: true });
  const header = [
    'id',
    'category',
    'name',
    'description',
    'unit_price',
    'unit_of_measure',
    'kind',
    'taxable',
    'active',
    'sort_order',
    'AI description',
    'exclusions',
    'ai_status',
    'internal_notes',
    'crew_notes',
    'estimator_notes',
    'hcp_notes',
    'ai_scope_notes',
    'tags',
    'recommendations',
  ];

  const rows = items.map((i) => [
    i.id,
    i.category || '',
    i.name || '',
    i.description || '',
    i.unit_price ?? '',
    i.unit_of_measure || '',
    i.kind || '',
    i.taxable ? 'yes' : 'no',
    i.active ? 'yes' : 'no',
    i.sort_order ?? 0,
    i.customer_description || '',
    i.exclusions || '',
    i.ai_status || 'pending',
    i.internal_notes || '',
    i.crew_notes || '',
    i.estimator_notes || '',
    i.hcp_notes || '',
    i.ai_scope_notes || '',
    Array.isArray(i.tags) ? i.tags.join(', ') : (i.tags || ''),
    i.recommendations || '',
  ]);

  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

export async function exportPricebookSqlBackup(pool) {
  const { rows } = await pool.query(
    `SELECT id, category, name, description, customer_description, exclusions,
            unit_price, unit_of_measure, kind, taxable, active, sort_order,
            ai_status, internal_notes, crew_notes, estimator_notes, hcp_notes,
            ai_scope_notes, tags, recommendations, created_at, updated_at
     FROM ${T}
     ORDER BY id`
  );

  const columns = [
    'id',
    'category',
    'name',
    'description',
    'customer_description',
    'exclusions',
    'unit_price',
    'unit_of_measure',
    'kind',
    'taxable',
    'active',
    'sort_order',
    'ai_status',
    'internal_notes',
    'crew_notes',
    'estimator_notes',
    'hcp_notes',
    'ai_scope_notes',
    'tags',
    'recommendations',
    'created_at',
    'updated_at',
  ];

  const statements = [
    '-- ScopeFoundry pricebook backup',
    `-- Generated: ${new Date().toISOString()}`,
    'BEGIN;',
    'TRUNCATE pricebook RESTART IDENTITY;',
  ];

  for (const row of rows) {
    const values = columns.map((column) => sqlLiteral(row[column]));
    statements.push(
      `INSERT INTO pricebook (${columns.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${values.join(', ')});`
    );
  }

  statements.push(
    `SELECT setval(pg_get_serial_sequence('pricebook', 'id'), COALESCE((SELECT MAX(id) FROM pricebook), 1), EXISTS (SELECT 1 FROM pricebook));`
  );
  statements.push('COMMIT;');
  return statements.join('\n') + '\n';
}

export async function generateAIForItem(pool, id, { fields } = {}) {
  const item = await getItem(pool, id);
  const selectedFields = normalizeAiFields(fields);
  const selectedFieldSet = new Set(selectedFields);

  await pool.query(`UPDATE ${T} SET ai_status = 'generating', updated_at = NOW() WHERE id = $1`, [id]);

  const system = 'You write clear, professional landscaping estimate descriptions for Washington Landscaping. Return JSON only.';
  const requestedKeys = selectedFields.map((field) =>
    field === 'description' ? 'customer_description' : field
  );
  const fieldInstructions = [];
  if (selectedFieldSet.has('description')) {
    fieldInstructions.push('- customer_description must be present and non-empty.');
    fieldInstructions.push('- Rewrite/upgrade the current description into polished customer-facing language.');
  }
  if (selectedFieldSet.has('estimator_notes')) {
    fieldInstructions.push('- estimator_notes must be present and non-empty.');
    fieldInstructions.push('- estimator_notes should be practical crew/estimator guidance.');
  }
  if (selectedFieldSet.has('exclusions')) {
    fieldInstructions.push('- exclusions must be present and non-empty.');
    fieldInstructions.push('- exclusions should state what is not included unless separately listed.');
  }
  if (selectedFieldSet.has('ai_scope_notes')) {
    fieldInstructions.push('- ai_scope_notes must be present and non-empty.');
    fieldInstructions.push('- ai_scope_notes should provide one practical recommendation, upsell, or planning note.');
  }
  const user = [
    'Create or refresh AI fields for this line item.',
    `Service name: ${item.name}`,
    `Category: ${item.category || ''}`,
    `Current customer description: ${item.description || ''}`,
    `Current estimator notes: ${item.estimator_notes || ''}`,
    `Current exclusions: ${item.exclusions || ''}`,
    `Current AI scope notes: ${item.ai_scope_notes || ''}`,
    `Unit: ${item.unit_of_measure || ''}`,
    `Unit price cents: ${item.unit_price || 0}`,
    item.internal_notes ? `Internal notes: ${item.internal_notes}` : '',
    `Update only these fields: ${selectedFields.join(', ')}`,
    '',
    'Rules:',
    '- Keep each field concise and useful for an estimate workflow.',
    '- Return only the requested keys and do not include any extra keys.',
    ...fieldInstructions,
    '',
    'Return JSON only with keys:',
    JSON.stringify(Object.fromEntries(requestedKeys.map((key) => [key, '']))),
  ].filter(Boolean).join('\n');

  try {
    const resp = await fetch(`${ollamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel(),
        stream: false,
        keep_alive: ollamaKeepAlive(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    const raw = await resp.text();
    if (!resp.ok) {
      throw new Error(`Ollama error ${resp.status}: ${raw.slice(0, 400)}`);
    }

    const payload = safeParseJson(extractContent(raw));
    const fallbackDescription = `${item.name || 'Service'}${item.unit_of_measure ? ` (${item.unit_of_measure})` : ''} for this property.`
      .replace(/\s+/g, ' ')
      .trim();

    const fallbackEstimatorNotes = [
      'Confirm site conditions, measurements, access, material needs, and cleanup requirements before starting work.',
      item.internal_notes ? `Reference internal notes: ${item.internal_notes}` : '',
    ].filter(Boolean).join(' ');

    const fallbackExclusions = 'Does not include additional repairs, unforeseen site conditions, disposal overages, or extra materials unless separately listed.';
    const fallbackAiScopeNotes = 'Confirm final field measurements, site access, and any add-on needs before approval or scheduling.';

    const currentDescription = String(item.customer_description || item.description || '').trim();
    const currentEstimatorNotes = String(item.estimator_notes || '').trim();
    const currentExclusions = String(item.exclusions || '').trim();
    const currentAiScopeNotes = String(item.ai_scope_notes || '').trim();

    const customerDescription = selectedFieldSet.has('description')
      ? String(payload.customer_description || '').trim() || currentDescription || fallbackDescription
      : currentDescription || null;
    const estimatorNotes = selectedFieldSet.has('estimator_notes')
      ? String(payload.estimator_notes || '').trim() || currentEstimatorNotes || fallbackEstimatorNotes
      : currentEstimatorNotes || null;
    const exclusions = selectedFieldSet.has('exclusions')
      ? String(payload.exclusions || '').trim() || currentExclusions || fallbackExclusions
      : currentExclusions || null;
    const aiScopeNotes = selectedFieldSet.has('ai_scope_notes')
      ? String(payload.ai_scope_notes || '').trim() || currentAiScopeNotes || fallbackAiScopeNotes
      : currentAiScopeNotes || null;

    const { rows } = await pool.query(
      `UPDATE ${T}
       SET customer_description = $1,
           description = $1,
           estimator_notes = $2,
           exclusions = $3,
           ai_scope_notes = $4,
           ai_status = 'complete',
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [customerDescription || null, estimatorNotes || null, exclusions || null, aiScopeNotes || null, id]
    );

    return rows[0];
  } catch (err) {
    await pool.query(`UPDATE ${T} SET ai_status = 'failed', updated_at = NOW() WHERE id = $1`, [id]);
    throw err;
  }
}

function normalizeAiFields(fields) {
  if (fields === undefined) return [...AI_FIELD_KEYS];
  if (!Array.isArray(fields)) {
    throw Object.assign(new Error('AI fields must be an array.'), { status: 400 });
  }

  const normalized = [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))];
  const invalid = normalized.filter((field) => !AI_FIELD_KEYS.includes(field));
  if (invalid.length) {
    throw Object.assign(new Error(`Invalid AI field selection: ${invalid.join(', ')}`), { status: 400 });
  }
  if (!normalized.length) {
    throw Object.assign(new Error('Select at least one AI field to update.'), { status: 400 });
  }
  return normalized;
}

function normalizePayload(fields = {}) {
  const category = String(fields.category || 'General').trim() || 'General';
  const name = String(fields.name || '').trim();
  const customerDescription = nullableText(fields.customer_description);
  const description = nullableText(fields.description) || customerDescription;

  // New canonical note fields, falling back to legacy column names when absent.
  const internalNotes = nullableText(fields.internal_notes ?? fields.notes);
  const estimatorNotes = nullableText(fields.estimator_notes ?? fields.internal_scope);
  const aiScopeNotes = nullableText(fields.ai_scope_notes ?? fields.recommended_notes);
  const crewNotes = nullableText(fields.crew_notes);
  const hcpNotes = nullableText(fields.hcp_notes);
  const tags = parseTags(fields.tags);

  return {
    category,
    name,
    description,
    customer_description: customerDescription,
    exclusions: nullableText(fields.exclusions),
    unit_price: Number(fields.unit_price),
    unit_of_measure: nullableText(fields.unit_of_measure),
    kind: String(fields.kind || 'labor').trim() || 'labor',
    taxable: parseBool(fields.taxable),
    active: fields.active !== false,
    sort_order: Number(fields.sort_order || 0) || 0,
    ai_status: String(fields.ai_status || 'pending').trim() || 'pending',
    // New columns.
    internal_notes: internalNotes,
    crew_notes: crewNotes,
    estimator_notes: estimatorNotes,
    hcp_notes: hcpNotes,
    ai_scope_notes: aiScopeNotes,
    tags,
    recommendations: nullableText(fields.recommendations),
  };
}

// Accepts an array of tags or a comma/semicolon-separated string. Returns string[].
function parseTags(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((t) => String(t || '').trim()).filter(Boolean))];
  }
  const s = String(value ?? '').trim();
  if (!s) return [];
  return [...new Set(s.split(/[,;]/).map((t) => t.trim()).filter(Boolean))];
}

function validate({ name, unit_price }) {
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  if (unit_price === undefined || unit_price === null || Number.isNaN(Number(unit_price))) {
    throw Object.assign(new Error('unit_price is required (integer cents)'), { status: 400 });
  }
}

function parsePrice(val) {
  const n = Number(String(val).replace(/[^0-9.-]/g, ''));
  if (String(val).includes('.') || (n > 0 && n < 1000)) return Math.round(n * 100);
  return Math.round(n);
}

function parseBool(val) {
  return /^(1|true|yes|y|t)$/i.test(String(val ?? '').trim());
}

function nullableText(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[,"\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) {
    if (!value.length) return "ARRAY[]::text[]";
    const items = value.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
    return `ARRAY[${items}]::text[]`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;

  const text = String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(text) && !/^0\d+/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function extractContent(raw) {
  const root = safeParseJson(raw);
  const content = root?.message?.content ?? root?.response ?? raw;
  return String(content || '').trim();
}

function safeParseJson(text) {
  const cleaned = String(text || '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) {
      return JSON.parse(fence[1]);
    }
    throw new Error('Could not parse AI JSON output.');
  }
}

// Semantic search: find pricebook items matching a natural language query
export async function searchItems(pool, query, { limit = 10 } = {}) {
  if (!query || typeof query !== 'string') {
    return [];
  }

  const allItems = await listItems(pool, { includeInactive: false });
  
  // Score each item based on keyword match (fast, reliable)
  const scored = allItems.map((item) => ({
    ...item,
    score: computeKeywordScore(query, item),
  }));
  
  // Sort by score (descending) and limit
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

// Compute keyword match score (0-100)
function computeKeywordScore(query, item) {
  const q = query.toLowerCase();
  const name = String(item.name || '').toLowerCase();
  const desc = String(item.description || '').toLowerCase();
  const category = String(item.category || '').toLowerCase();
  
  let score = 0;
  
  // Exact match in name = 100
  if (name === q) return 100;
  
  // Name contains query = 80
  if (name.includes(q)) score = Math.max(score, 80);
  
  // Query words match name words = 70
  const queryWords = q.split(/\s+/).filter(Boolean);
  const nameWords = name.split(/\s+/).filter(Boolean);
  const nameMatches = queryWords.filter((w) => nameWords.some((nw) => nw.startsWith(w)));
  if (nameMatches.length === queryWords.length) score = Math.max(score, 70);
  
  // Description contains query = 50
  if (desc.includes(q)) score = Math.max(score, 50);
  
  // Query words found in description = 40
  const descMatches = queryWords.filter((w) => desc.includes(w));
  if (descMatches.length > 0) score = Math.max(score, 40);
  
  // Category match = 30
  if (category.includes(q) || queryWords.some((w) => category.includes(w))) score = Math.max(score, 30);
  
  return score;
}

// Compute semantic similarity using Ollama (0-100)
async function computeSemanticScore(query, item) {
  const itemText = [
    item.name,
    item.description,
    item.customer_description,
    item.category,
  ].filter(Boolean).join(' ');
  
  if (!itemText.trim()) return 0;
  
  try {
    // Use Ollama to score semantic relevance
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
    
    const resp = await fetch(`${ollamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel(),
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'You are a semantic relevance scorer. Return a JSON object with a single key "score" (0-100 integer). 0 = no relevance, 100 = perfect match.',
          },
          {
            role: 'user',
            content: `Query: "${query}"\n\nService: ${itemText}\n\nHow semantically relevant is this service to the query? Return only JSON: {"score": <number>}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!resp.ok) return 0;
    
    const data = await resp.json();
    const content = String(data.message?.content || '').trim();
    const parsed = safeParseJson(content);
    const score = Number(parsed.score ?? 0);
    
    return Math.max(0, Math.min(100, score)); // Clamp to 0-100
  } catch (err) {
    // Semantic scoring failed, return 0 to fall back to keyword
    return 0;
  }
}

// Legacy exports kept for compatibility with existing references.
export const getPricebook = (pool) => listItems(pool);
export async function recordPricebookUsage() {}
