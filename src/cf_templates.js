// Chat Foundry — message template library (CRUD + immutable version history).
// Raw SQL over the shared pg pool (matches the repo's pricebook.js pattern). Prior versions
// are never overwritten: every body change appends a new row to chat_message_template_versions.

export const TEMPLATE_CATEGORIES = [
  'Estimate follow-up', 'Unresolved lead follow-up', 'Appointment scheduling', 'Quote reminder',
  'Customer check-in', 'Payment reminder', 'Seasonal promotion', 'Service update', 'Review request',
  'General announcement', 'Custom',
];

// PURE: validate + normalize template input. Returns { ok, errors, value }.
export function validateTemplateInput(input = {}) {
  const errors = [];
  const name = String(input.name || '').trim();
  if (!name) errors.push('Name is required.');
  if (name.length > 200) errors.push('Name must be 200 characters or fewer.');
  const body = String(input.body || '');
  if (!body.trim()) errors.push('Message body is required.');
  const category = TEMPLATE_CATEGORIES.includes(String(input.category)) ? String(input.category) : 'Custom';
  const tags = sanitizeTags(input.tags);
  return {
    ok: errors.length === 0,
    errors,
    value: {
      name,
      description: String(input.description || '').trim(),
      category,
      tags,
      body,
      notes: String(input.notes || '').trim(),
      approved: input.approved === true,
    },
  };
}

// PURE: normalize tags into a de-duped, trimmed, lowercase string array.
export function sanitizeTags(tags) {
  const arr = Array.isArray(tags)
    ? tags
    : String(tags || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw || '').trim().toLowerCase();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function rowToTemplate(r) {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    category: r.category,
    tags: r.tags || [],
    body: r.body,
    status: r.status,
    current_version: r.current_version,
    approved: r.approved,
    notes: r.notes,
    created_by: r.created_by,
    updated_by: r.updated_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    archived_at: r.archived_at,
  };
}

export async function listTemplates(pool, { search = '', category = '', tag = '', includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push(`status = 'active'`);
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (tag) { params.push(String(tag).toLowerCase()); where.push(`$${params.length} = ANY(tags)`); }
  if (search) { params.push(`%${search.toLowerCase()}%`); where.push(`(lower(name) LIKE $${params.length} OR lower(body) LIKE $${params.length} OR lower(description) LIKE $${params.length})`); }
  const sql = `SELECT * FROM chat_message_templates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows.map(rowToTemplate);
}

export async function getTemplate(pool, id) {
  const { rows } = await pool.query('SELECT * FROM chat_message_templates WHERE id = $1', [id]);
  if (!rows.length) return null;
  const t = rowToTemplate(rows[0]);
  t.versions = await listVersions(pool, id);
  return t;
}

export async function createTemplate(pool, input, actor) {
  const v = validateTemplateInput(input);
  if (!v.ok) { const e = new Error(v.errors.join(' ')); e.status = 400; throw e; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO chat_message_templates (name, description, category, tags, body, notes, approved, current_version, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8) RETURNING *`,
      [v.value.name, v.value.description, v.value.category, v.value.tags, v.value.body, v.value.notes, v.value.approved, actor],
    );
    const tpl = rows[0];
    await client.query(
      `INSERT INTO chat_message_template_versions (template_id, version_number, body, change_note, created_by)
       VALUES ($1, 1, $2, 'Initial version', $3)`,
      [tpl.id, v.value.body, actor],
    );
    await client.query('COMMIT');
    return getTemplate(pool, tpl.id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateTemplate(pool, id, input, actor) {
  const existing = await getTemplate(pool, id);
  if (!existing) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  const v = validateTemplateInput({ ...existing, ...input });
  if (!v.ok) { const e = new Error(v.errors.join(' ')); e.status = 400; throw e; }
  const bodyChanged = v.value.body !== existing.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let nextVersion = existing.current_version;
    if (bodyChanged) {
      nextVersion = existing.current_version + 1;
      await client.query(
        `INSERT INTO chat_message_template_versions (template_id, version_number, body, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, nextVersion, v.value.body, String(input.change_note || 'Edited'), actor],
      );
    }
    const { rows } = await client.query(
      `UPDATE chat_message_templates
         SET name=$1, description=$2, category=$3, tags=$4, body=$5, notes=$6, approved=$7,
             current_version=$8, updated_by=$9, updated_at=NOW()
       WHERE id=$10 RETURNING id`,
      [v.value.name, v.value.description, v.value.category, v.value.tags, v.value.body, v.value.notes, v.value.approved, nextVersion, actor, id],
    );
    await client.query('COMMIT');
    return getTemplate(pool, rows[0].id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function duplicateTemplate(pool, id, actor) {
  const src = await getTemplate(pool, id);
  if (!src) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  return createTemplate(pool, { ...src, name: `${src.name} (copy)`, approved: false }, actor);
}

export async function setArchived(pool, id, archived, actor) {
  const { rows } = await pool.query(
    `UPDATE chat_message_templates
       SET status=$1, archived_at=$2, updated_by=$3, updated_at=NOW()
     WHERE id=$4 RETURNING id`,
    [archived ? 'archived' : 'active', archived ? new Date() : null, actor, id],
  );
  if (!rows.length) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  return getTemplate(pool, id);
}

export async function deleteTemplate(pool, id) {
  const { rowCount } = await pool.query('DELETE FROM chat_message_templates WHERE id = $1', [id]);
  if (!rowCount) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  return { deleted: true, id: Number(id) };
}

export async function listVersions(pool, id) {
  const { rows } = await pool.query(
    'SELECT id, version_number, body, change_note, created_by, created_at FROM chat_message_template_versions WHERE template_id = $1 ORDER BY version_number DESC',
    [id],
  );
  return rows;
}

// Restore a prior version by appending it as a NEW version (history is never rewritten).
export async function restoreVersion(pool, id, versionId, actor) {
  const existing = await getTemplate(pool, id);
  if (!existing) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  const { rows: vr } = await pool.query(
    'SELECT * FROM chat_message_template_versions WHERE id = $1 AND template_id = $2', [versionId, id],
  );
  if (!vr.length) { const e = new Error('Version not found.'); e.status = 404; throw e; }
  const src = vr[0];
  return updateTemplate(pool, id, { body: src.body, change_note: `Restored from v${src.version_number}` }, actor);
}
