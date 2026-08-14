// Pure helpers for the lead follow-up drip. No I/O — the dashboard preview and the runtime
// selection both rely on the same category-resolution and message-selection logic.

// Map a raw platform value (Thumbtack category name / Google LSA service slug) to a canonical
// category_key using the drip_category_map rows. Case-insensitive. Returns null when unmapped.
export function resolveCategoryKey(mapRows, source, rawValue) {
  if (!rawValue) return null;
  const raw = String(rawValue).trim().toLowerCase();
  for (const r of mapRows || []) {
    if (String(r.source) === String(source) && String(r.raw_value).trim().toLowerCase() === raw) {
      return r.category_key;
    }
  }
  return null;
}

function weightedPick(rows, rng) {
  const w = (r) => (Number(r.weight) > 0 ? Number(r.weight) : 1);
  const total = rows.reduce((n, r) => n + w(r), 0);
  let t = (typeof rng === 'function' ? rng() : Math.random()) * total;
  for (const r of rows) {
    t -= w(r);
    if (t < 0) return r;
  }
  return rows[rows.length - 1];
}

// Select one message from candidate rows for a single step. Category-specific rows win over the
// vertical default (category_key === null). Among the chosen set, pick a variant by strategy.
export function resolveMessage(candidates, { categoryKey = null, strategy = 'random', rng = Math.random, index = 0 } = {}) {
  const active = (candidates || []).filter((c) => c && c.is_active !== false && c.body);
  if (active.length === 0) return null;
  const specific = categoryKey ? active.filter((c) => c.category_key === categoryKey) : [];
  const pool = specific.length > 0 ? specific : active.filter((c) => c.category_key == null);
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  if (strategy === 'round_robin') {
    const sorted = [...pool].sort((a, b) => String(a.variant).localeCompare(String(b.variant)));
    return sorted[(((Number(index) || 0) % sorted.length) + sorted.length) % sorted.length];
  }
  return weightedPick(pool, rng); // 'random' | 'weighted_ab'
}

// Substitute {name}/{service}/{Business} etc. Unknown placeholders are left intact.
export function renderBody(body, vars = {}) {
  return String(body || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
