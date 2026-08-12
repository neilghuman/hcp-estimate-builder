// Studio drafts — server-side persistence for work-in-progress estimates built in the Studio.
// Drafts are numbered by their IDENTITY id (never reused) so they can be referenced by humans.

const LIST_COLS = `
  id, name, division, status,
  COALESCE(jsonb_array_length(snapshot->'packages'), 0) AS package_count,
  created_at, updated_at
`;

function cleanName(name, fallback = 'Untitled estimate') {
  const clean = String(name == null ? '' : name).trim();
  return clean || fallback;
}

// Lightweight list for the drafts drawer (omits the full snapshot to keep payloads small).
export async function listDrafts(pool) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS} FROM studio_drafts ORDER BY updated_at DESC`
  );
  return rows;
}

export async function getDraft(pool, id) {
  const { rows } = await pool.query(`SELECT * FROM studio_drafts WHERE id = $1`, [id]);
  if (!rows.length) throw Object.assign(new Error('Draft not found'), { status: 404 });
  return rows[0];
}

export async function createDraft(pool, { name, division = null, status = 'open', snapshot } = {}) {
  if (snapshot == null || typeof snapshot !== 'object') {
    throw Object.assign(new Error('A draft snapshot is required.'), { status: 400 });
  }
  const { rows } = await pool.query(
    `INSERT INTO studio_drafts (name, division, status, snapshot)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [cleanName(name), division || null, String(status || 'open'), snapshot]
  );
  return rows[0];
}

export async function updateDraft(pool, id, fields = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); vals.push(cleanName(fields.name)); }
  if (fields.division !== undefined) { sets.push(`division = $${i++}`); vals.push(fields.division || null); }
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); vals.push(String(fields.status || 'open')); }
  if (fields.snapshot !== undefined) {
    if (fields.snapshot == null || typeof fields.snapshot !== 'object') {
      throw Object.assign(new Error('A draft snapshot is required.'), { status: 400 });
    }
    sets.push(`snapshot = $${i++}`); vals.push(fields.snapshot);
  }
  if (!sets.length) return getDraft(pool, id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE studio_drafts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) throw Object.assign(new Error('Draft not found'), { status: 404 });
  return rows[0];
}

export async function deleteDraft(pool, id) {
  const { rowCount } = await pool.query(`DELETE FROM studio_drafts WHERE id = $1`, [id]);
  if (!rowCount) throw Object.assign(new Error('Draft not found'), { status: 404 });
}
