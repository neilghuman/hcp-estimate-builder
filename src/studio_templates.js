// Studio templates — server-side reusable estimate templates (CRUD + hide/restore +
// homepage featuring + ordering). Raw SQL over the shared pg pool, matching the
// drafts.js / cf_templates.js patterns in this repo.
//
// Structure of the estimate lives in the JSONB `body` ({ measurements, packages });
// management state lives in dedicated columns (status, is_featured_on_homepage, …).

// ---------------------------------------------------------------------------
// PURE helpers (no DB, no DOM) — unit-tested directly.
// ---------------------------------------------------------------------------

export function cleanName(name) {
  return String(name == null ? '' : name).trim();
}

// Validate + normalize create/update input. Returns { ok, errors, value }.
export function validateTemplateInput(input = {}) {
  const errors = [];
  const name = cleanName(input.name);
  if (!name) errors.push('Template name is required.');
  if (name.length > 200) errors.push('Template name must be 200 characters or fewer.');

  let body = input.body;
  if (body == null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    errors.push('Template body must be an object.');
    body = {};
  }
  const normalizedBody = {
    measurements: (body.measurements && typeof body.measurements === 'object') ? body.measurements : {},
    packages: Array.isArray(body.packages) ? body.packages : [],
  };

  return {
    ok: errors.length === 0,
    errors,
    value: {
      name,
      description: cleanName(input.description),
      division: input.division ? String(input.division) : null,
      category: input.category ? String(input.category) : null,
      body: normalizedBody,
    },
  };
}

// True when `name` (case-insensitive) already belongs to a DIFFERENT template.
export function isDuplicateName(name, others = [], excludeId = null) {
  const target = cleanName(name).toLowerCase();
  if (!target) return false;
  return others.some((t) => Number(t.id) !== Number(excludeId) && cleanName(t.name).toLowerCase() === target);
}

// Next homepage_sort_order given the currently-used orders (max + 1, or 0).
export function nextSortOrder(existingOrders = []) {
  const nums = existingOrders.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 0;
}

// Business rule: hiding a template also removes it from the homepage.
// Returns the column changes to apply (pure — used by tests and mirrored in SQL).
export function hideFields() {
  return { status: 'hidden', is_featured_on_homepage: false, homepage_sort_order: null };
}

export function rowToTemplate(r) {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description || '',
    division: r.division || null,
    category: r.category || null,
    body: r.body || { measurements: {}, packages: [] },
    status: r.status,
    is_featured_on_homepage: r.is_featured_on_homepage === true,
    homepage_icon: r.homepage_icon || null,
    homepage_description: r.homepage_description || null,
    homepage_sort_order: r.homepage_sort_order == null ? null : Number(r.homepage_sort_order),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const err = (msg, status) => Object.assign(new Error(msg), { status });

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

// List templates. status: 'active' (default) | 'hidden' | 'all'. featured: only homepage.
export async function listTemplates(pool, { status = 'active', search = '', featured = false } = {}) {
  const where = [];
  const params = [];
  if (featured) {
    where.push(`is_featured_on_homepage = TRUE`);
    where.push(`status = 'active'`);
  } else if (status && status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(lower(name) LIKE $${params.length} OR lower(description) LIKE $${params.length} OR lower(coalesce(category,'')) LIKE $${params.length})`);
  }
  const orderBy = featured
    ? 'ORDER BY homepage_sort_order ASC NULLS LAST, updated_at DESC'
    : 'ORDER BY updated_at DESC';
  const sql = `SELECT * FROM studio_templates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${orderBy}`;
  const { rows } = await pool.query(sql, params);
  return rows.map(rowToTemplate);
}

export async function getTemplate(pool, id) {
  const { rows } = await pool.query('SELECT * FROM studio_templates WHERE id = $1', [Number(id)]);
  if (!rows.length) return null;
  return rowToTemplate(rows[0]);
}

// Names of all templates (for duplicate detection).
async function allNames(pool) {
  const { rows } = await pool.query('SELECT id, name FROM studio_templates');
  return rows;
}

export async function createTemplate(pool, input) {
  const v = validateTemplateInput(input);
  if (!v.ok) throw err(v.errors.join(' '), 400);
  if (isDuplicateName(v.value.name, await allNames(pool))) {
    throw err(`A template named "${v.value.name}" already exists. Choose a different name.`, 409);
  }
  const { rows } = await pool.query(
    `INSERT INTO studio_templates (name, description, division, category, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.value.name, v.value.description, v.value.division, v.value.category, v.value.body],
  );
  return rowToTemplate(rows[0]);
}

// Rename / edit details. Accepts: name, description, division, category,
// homepage_icon, homepage_description. Does NOT create a duplicate.
export async function updateTemplate(pool, id, fields = {}) {
  const existing = await getTemplate(pool, id);
  if (!existing) throw err('Template not found.', 404);

  const sets = [];
  const vals = [];
  let i = 1;

  if (fields.name !== undefined) {
    const name = cleanName(fields.name);
    if (!name) throw err('Template name is required.', 400);
    if (name.length > 200) throw err('Template name must be 200 characters or fewer.', 400);
    if (isDuplicateName(name, await allNames(pool), id)) {
      throw err(`A template named "${name}" already exists. Choose a different name.`, 409);
    }
    sets.push(`name = $${i++}`); vals.push(name);
  }
  if (fields.description !== undefined) { sets.push(`description = $${i++}`); vals.push(cleanName(fields.description)); }
  if (fields.division !== undefined) { sets.push(`division = $${i++}`); vals.push(fields.division ? String(fields.division) : null); }
  if (fields.category !== undefined) { sets.push(`category = $${i++}`); vals.push(fields.category ? String(fields.category) : null); }
  if (fields.homepage_icon !== undefined) { sets.push(`homepage_icon = $${i++}`); vals.push(fields.homepage_icon ? String(fields.homepage_icon) : null); }
  if (fields.homepage_description !== undefined) { sets.push(`homepage_description = $${i++}`); vals.push(fields.homepage_description ? String(fields.homepage_description) : null); }

  if (!sets.length) return existing;
  vals.push(Number(id));
  const { rows } = await pool.query(
    `UPDATE studio_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    vals,
  );
  return rowToTemplate(rows[0]);
}

// Hide a template (removes it from the dropdown AND the homepage). Recoverable.
export async function hideTemplate(pool, id) {
  const { rows } = await pool.query(
    `UPDATE studio_templates
       SET status = 'hidden', is_featured_on_homepage = FALSE, homepage_sort_order = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id)],
  );
  if (!rows.length) throw err('Template not found.', 404);
  return rowToTemplate(rows[0]);
}

// Restore a hidden template back to the dropdown.
export async function restoreTemplate(pool, id) {
  const { rows } = await pool.query(
    `UPDATE studio_templates SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [Number(id)],
  );
  if (!rows.length) throw err('Template not found.', 404);
  return rowToTemplate(rows[0]);
}

// Feature a template on the homepage. Blocks hidden templates (must restore first).
export async function featureTemplate(pool, id, { icon = null, description = null } = {}) {
  const existing = await getTemplate(pool, id);
  if (!existing) throw err('Template not found.', 404);
  if (existing.status !== 'active') {
    throw err('Restore this template before adding it to the homepage.', 409);
  }
  let sortOrder = existing.homepage_sort_order;
  if (!existing.is_featured_on_homepage || sortOrder == null) {
    const { rows: orderRows } = await pool.query(
      `SELECT homepage_sort_order FROM studio_templates WHERE is_featured_on_homepage = TRUE`,
    );
    sortOrder = nextSortOrder(orderRows.map((r) => r.homepage_sort_order));
  }
  const { rows } = await pool.query(
    `UPDATE studio_templates
       SET is_featured_on_homepage = TRUE,
           homepage_icon = COALESCE($2, homepage_icon),
           homepage_description = COALESCE($3, homepage_description),
           homepage_sort_order = $4,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id), icon ? String(icon) : null, description ? String(description) : null, sortOrder],
  );
  return rowToTemplate(rows[0]);
}

// Remove a template from the homepage (does NOT hide or delete it).
export async function unfeatureTemplate(pool, id) {
  const { rows } = await pool.query(
    `UPDATE studio_templates
       SET is_featured_on_homepage = FALSE, homepage_sort_order = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id)],
  );
  if (!rows.length) throw err('Template not found.', 404);
  return rowToTemplate(rows[0]);
}

// Persist homepage card order. orderedIds = template ids in display order.
export async function reorderHomepage(pool, orderedIds = []) {
  if (!Array.isArray(orderedIds)) throw err('An ordered list of template ids is required.', 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < orderedIds.length; idx++) {
      await client.query(
        `UPDATE studio_templates SET homepage_sort_order = $2, updated_at = NOW()
         WHERE id = $1 AND is_featured_on_homepage = TRUE`,
        [Number(orderedIds[idx]), idx],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return listTemplates(pool, { featured: true });
}

// Permanently delete a template. Removes the row (and its homepage reference with it).
export async function deleteTemplate(pool, id) {
  const { rowCount } = await pool.query('DELETE FROM studio_templates WHERE id = $1', [Number(id)]);
  if (!rowCount) throw err('Template not found.', 404);
}
