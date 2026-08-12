// Studio templates — backend unit tests (node:test, zero-dep).
// Pure helpers are tested directly; DB functions are tested against a recording
// mock pool that asserts the SQL/behavior without a live Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanName, validateTemplateInput, isDuplicateName, nextSortOrder, hideFields, rowToTemplate,
  createTemplate, updateTemplate, hideTemplate, restoreTemplate, featureTemplate,
  unfeatureTemplate, reorderHomepage, deleteTemplate, listTemplates, getTemplate,
} from '../src/studio_templates.js';

// --- mock pool -------------------------------------------------------------
// responder(sql, params) -> { rows } | { rows, rowCount }. Records every call.
function makePool(responder) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    const r = responder(sql, params) || {};
    return { rows: r.rows || [], rowCount: r.rowCount != null ? r.rowCount : (r.rows ? r.rows.length : 0) };
  };
  const pool = {
    calls,
    query: run,
    connect: async () => ({ query: run, release() {} }),
  };
  return pool;
}

const sampleRow = (over = {}) => ({
  id: 7, name: 'Estimate Follow-Up', description: 'desc', division: 'landscaping',
  category: 'Custom', body: { measurements: {}, packages: [] }, status: 'active',
  is_featured_on_homepage: false, homepage_icon: null, homepage_description: null,
  homepage_sort_order: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

// --- PURE ------------------------------------------------------------------
test('cleanName trims and stringifies', () => {
  assert.equal(cleanName('  Foo  '), 'Foo');
  assert.equal(cleanName(null), '');
});

test('validateTemplateInput accepts a valid template and normalizes body', () => {
  const v = validateTemplateInput({ name: '  Roof Quote  ', body: { packages: [{ id: 'p' }] } });
  assert.ok(v.ok);
  assert.equal(v.value.name, 'Roof Quote');
  assert.deepEqual(v.value.body.packages, [{ id: 'p' }]);
  assert.deepEqual(v.value.body.measurements, {});
});

test('validateTemplateInput rejects an empty name', () => {
  const v = validateTemplateInput({ name: '   ' });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /name is required/i);
});

test('validateTemplateInput rejects an over-long name', () => {
  const v = validateTemplateInput({ name: 'x'.repeat(201) });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /200 characters/);
});

test('isDuplicateName is case-insensitive and excludes self', () => {
  const others = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
  assert.equal(isDuplicateName('alpha', others), true);
  assert.equal(isDuplicateName('ALPHA', others, 1), false); // same row excluded
  assert.equal(isDuplicateName('Gamma', others), false);
});

test('nextSortOrder returns max+1 or 0', () => {
  assert.equal(nextSortOrder([]), 0);
  assert.equal(nextSortOrder([0, 1, 2]), 3);
  assert.equal(nextSortOrder([5, 2, 9]), 10);
});

test('hideFields encodes the "hide also unfeatures" rule', () => {
  assert.deepEqual(hideFields(), { status: 'hidden', is_featured_on_homepage: false, homepage_sort_order: null });
});

test('rowToTemplate maps types and defaults', () => {
  const t = rowToTemplate(sampleRow({ homepage_sort_order: '3', is_featured_on_homepage: true }));
  assert.equal(t.id, 7);
  assert.equal(t.homepage_sort_order, 3);
  assert.equal(t.is_featured_on_homepage, true);
});

// --- DB: create ------------------------------------------------------------
test('createTemplate rejects empty name (400)', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await assert.rejects(() => createTemplate(pool, { name: '' }), (e) => e.status === 400);
});

test('createTemplate rejects a duplicate name (409)', async () => {
  const pool = makePool((sql) => {
    if (sql.includes('SELECT id, name')) return { rows: [{ id: 1, name: 'Dup' }] };
    return { rows: [sampleRow()] };
  });
  await assert.rejects(() => createTemplate(pool, { name: 'dup', body: {} }), (e) => e.status === 409);
});

test('createTemplate inserts and returns a mapped template', async () => {
  const pool = makePool((sql) => {
    if (sql.includes('SELECT id, name')) return { rows: [] };
    if (sql.startsWith('INSERT')) return { rows: [sampleRow({ name: 'New' })] };
    return { rows: [] };
  });
  const t = await createTemplate(pool, { name: 'New', body: { packages: [] } });
  assert.equal(t.name, 'New');
  const insert = pool.calls.find((c) => c.sql.startsWith('INSERT'));
  assert.ok(insert, 'an INSERT was issued');
});

test('createTemplate accepts a legacy localStorage-shaped body (migration path)', async () => {
  const pool = makePool((sql) => {
    if (sql.includes('SELECT id, name')) return { rows: [] };
    if (sql.startsWith('INSERT')) return { rows: [sampleRow()] };
    return { rows: [] };
  });
  const legacy = { name: 'Legacy', body: { measurements: { turf: 100 }, packages: [{ id: 'p', services: [] }] } };
  const t = await createTemplate(pool, legacy);
  assert.ok(t.id);
});

// --- DB: rename / update ---------------------------------------------------
test('updateTemplate rename rejects empty name (400)', async () => {
  const pool = makePool((sql) => (sql.startsWith('SELECT * FROM studio_templates WHERE id') ? { rows: [sampleRow()] } : { rows: [] }));
  await assert.rejects(() => updateTemplate(pool, 7, { name: '  ' }), (e) => e.status === 400);
});

test('updateTemplate rename rejects a duplicate name (409)', async () => {
  const pool = makePool((sql) => {
    if (sql.startsWith('SELECT * FROM studio_templates WHERE id')) return { rows: [sampleRow()] };
    if (sql.includes('SELECT id, name')) return { rows: [{ id: 9, name: 'Taken' }] };
    return { rows: [] };
  });
  await assert.rejects(() => updateTemplate(pool, 7, { name: 'taken' }), (e) => e.status === 409);
});

test('updateTemplate renames and preserves id (updates row, records UPDATE)', async () => {
  const pool = makePool((sql) => {
    if (sql.startsWith('SELECT * FROM studio_templates WHERE id')) return { rows: [sampleRow()] };
    if (sql.includes('SELECT id, name')) return { rows: [{ id: 7, name: 'Estimate Follow-Up' }] };
    if (sql.startsWith('UPDATE')) return { rows: [sampleRow({ name: 'Renamed' })] };
    return { rows: [] };
  });
  const t = await updateTemplate(pool, 7, { name: 'Renamed' });
  assert.equal(t.id, 7);
  assert.equal(t.name, 'Renamed');
  const upd = pool.calls.find((c) => c.sql.startsWith('UPDATE'));
  assert.match(upd.sql, /updated_at = NOW\(\)/);
});

// --- DB: hide / restore ----------------------------------------------------
test('hideTemplate sets hidden AND removes homepage placement', async () => {
  const pool = makePool(() => ({ rows: [sampleRow({ status: 'hidden', is_featured_on_homepage: false, homepage_sort_order: null })] }));
  const t = await hideTemplate(pool, 7);
  assert.equal(t.status, 'hidden');
  assert.equal(t.is_featured_on_homepage, false);
  const upd = pool.calls[0];
  assert.match(upd.sql, /status = 'hidden'/);
  assert.match(upd.sql, /is_featured_on_homepage = FALSE/);
  assert.match(upd.sql, /homepage_sort_order = NULL/);
});

test('hideTemplate throws 404 when the row is missing', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await assert.rejects(() => hideTemplate(pool, 999), (e) => e.status === 404);
});

test('restoreTemplate returns it to active', async () => {
  const pool = makePool(() => ({ rows: [sampleRow({ status: 'active' })] }));
  const t = await restoreTemplate(pool, 7);
  assert.equal(t.status, 'active');
  assert.match(pool.calls[0].sql, /status = 'active'/);
});

// --- DB: feature / unfeature ----------------------------------------------
test('featureTemplate blocks a hidden template (409)', async () => {
  const pool = makePool((sql) => (sql.startsWith('SELECT * FROM studio_templates WHERE id') ? { rows: [sampleRow({ status: 'hidden' })] } : { rows: [] }));
  await assert.rejects(() => featureTemplate(pool, 7, { icon: '🌿' }), (e) => e.status === 409);
});

test('featureTemplate assigns the next sort order for a new feature', async () => {
  const pool = makePool((sql) => {
    if (sql.startsWith('SELECT * FROM studio_templates WHERE id')) return { rows: [sampleRow({ is_featured_on_homepage: false })] };
    if (sql.includes('homepage_sort_order FROM studio_templates WHERE is_featured')) return { rows: [{ homepage_sort_order: 0 }, { homepage_sort_order: 1 }] };
    if (sql.startsWith('UPDATE')) return { rows: [sampleRow({ is_featured_on_homepage: true, homepage_sort_order: 2, homepage_icon: '🌿' })] };
    return { rows: [] };
  });
  const t = await featureTemplate(pool, 7, { icon: '🌿', description: 'Follow up' });
  assert.equal(t.is_featured_on_homepage, true);
  assert.equal(t.homepage_sort_order, 2);
  const upd = pool.calls.find((c) => c.sql.startsWith('UPDATE'));
  assert.equal(upd.params[3], 2); // sortOrder param
});

test('unfeatureTemplate clears homepage placement without hiding', async () => {
  const pool = makePool(() => ({ rows: [sampleRow({ is_featured_on_homepage: false, status: 'active' })] }));
  const t = await unfeatureTemplate(pool, 7);
  assert.equal(t.is_featured_on_homepage, false);
  assert.equal(t.status, 'active');
  assert.match(pool.calls[0].sql, /is_featured_on_homepage = FALSE/);
});

// --- DB: reorder -----------------------------------------------------------
test('reorderHomepage persists order by index within a transaction', async () => {
  const pool = makePool((sql) => {
    if (sql.includes('SELECT * FROM studio_templates')) return { rows: [] }; // final list
    return { rows: [] };
  });
  await reorderHomepage(pool, [30, 10, 20]);
  const updates = pool.calls.filter((c) => c.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map((u) => u.params), [[30, 0], [10, 1], [20, 2]]);
  assert.ok(pool.calls.some((c) => c.sql === 'BEGIN'));
  assert.ok(pool.calls.some((c) => c.sql === 'COMMIT'));
});

test('reorderHomepage rejects a non-array (400)', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await assert.rejects(() => reorderHomepage(pool, 'nope'), (e) => e.status === 400);
});

// --- DB: delete ------------------------------------------------------------
test('deleteTemplate removes the row', async () => {
  const pool = makePool(() => ({ rowCount: 1 }));
  await deleteTemplate(pool, 7);
  assert.match(pool.calls[0].sql, /^DELETE FROM studio_templates/);
});

test('deleteTemplate throws 404 when nothing was deleted', async () => {
  const pool = makePool(() => ({ rowCount: 0 }));
  await assert.rejects(() => deleteTemplate(pool, 999), (e) => e.status === 404);
});

// --- DB: list --------------------------------------------------------------
test('listTemplates filters active by default and excludes hidden', async () => {
  const pool = makePool(() => ({ rows: [sampleRow()] }));
  await listTemplates(pool, {});
  assert.match(pool.calls[0].sql, /WHERE status = \$1/);
  assert.deepEqual(pool.calls[0].params, ['active']);
});

test('listTemplates featured filters to homepage + active, ordered by sort order', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await listTemplates(pool, { featured: true });
  assert.match(pool.calls[0].sql, /is_featured_on_homepage = TRUE/);
  assert.match(pool.calls[0].sql, /ORDER BY homepage_sort_order ASC/);
});

test('listTemplates hidden view returns hidden rows', async () => {
  const pool = makePool(() => ({ rows: [sampleRow({ status: 'hidden' })] }));
  const rows = await listTemplates(pool, { status: 'hidden' });
  assert.equal(rows[0].status, 'hidden');
  assert.deepEqual(pool.calls[0].params, ['hidden']);
});

test('getTemplate returns null when missing', async () => {
  const pool = makePool(() => ({ rows: [] }));
  assert.equal(await getTemplate(pool, 123), null);
});
