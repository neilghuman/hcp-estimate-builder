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

// ---- Scheduling & quiet hours ------------------------------------------------

export function computeNextDueAt(t0, offsetMinutes) {
  return new Date(new Date(t0).getTime() + Number(offsetMinutes) * 60000);
}

export function buildIdemKey(leadRef, step) {
  return `${leadRef}:${step}`;
}

export function parseHHMM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Minutes to add so a send lands inside [start,end) local wall-clock. 0 if already inside.
export function quietHoursDelayMinutes(curMin, startMin, endMin) {
  if (curMin >= startMin && curMin < endMin) return 0;
  if (curMin < startMin) return startMin - curMin;
  return (1440 - curMin) + startMin; // past the window -> next day's start
}

export function localMinutesInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

// If date is outside permitted contact hours in tz, defer to the next window start.
export function applyQuietHours(date, { tz = 'America/Los_Angeles', start = '08:00', end = '20:00' } = {}) {
  const delay = quietHoursDelayMinutes(localMinutesInTz(date, tz), parseHHMM(start), parseHHMM(end));
  return delay === 0 ? date : new Date(date.getTime() + delay * 60000);
}

// Normalize a Chatwoot message timestamp to epoch ms. Chatwoot uses unix SECONDS for created_at;
// tolerate ms and ISO strings too. Returns null when unknown.
function msgTimeMs(m) {
  const v = m.created_at ?? m.createdAt;
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // seconds vs ms
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

// ---- Stop-condition evaluation (Chatwoot-anchored) ---------------------------
// conv: { status, labels[], messages[] }. Returns an exit reason string or null (continue).
// A drip's own outbound send is tagged content_attributes.automation === automationKey and is
// NOT treated as a human response. `since` (enrollment T0) excludes the triggering inbound lead and
// the initial welcome — only human/agent activity AFTER we started the drip counts as a response.
export function evaluateStop(conv, { pendingLabel = 'A_pending_callback', automationKey = 'drip', since = null } = {}) {
  if (!conv) return null;
  if (String(conv.status || '').toLowerCase() === 'resolved') return 'resolved';
  if (!(conv.labels || []).includes(pendingLabel)) return 'label_removed';
  const sinceMs = since != null ? new Date(since).getTime() : null;
  const human = (conv.messages || []).some((m) => {
    if (sinceMs != null) {
      const ts = msgTimeMs(m);
      if (ts != null && ts <= sinceMs) return false; // pre-enrollment activity (lead/welcome) — ignore
    }
    const t = m.message_type;
    const incoming = t === 0 || String(t) === 'incoming';
    const outgoing = t === 1 || String(t) === 'outgoing';
    if (incoming) return true;
    if (outgoing && m.private !== true) {
      const auto = m.content_attributes && m.content_attributes.automation;
      return auto !== automationKey; // human/agent reply, not our own drip send
    }
    return false;
  });
  return human ? 'human_response' : null;
}

// ---- Read-model assembly (dashboard) -----------------------------------------
// Nest flat sequence/step/message rows into a display tree. Pure so it can be unit tested.
export function nestSequences(seqRows = [], stepRows = [], msgRows = []) {
  const msgByStep = new Map();
  for (const m of msgRows) {
    const arr = msgByStep.get(m.step_id) || [];
    arr.push({
      category_key: m.category_key ?? null,
      variant: m.variant,
      body: m.body,
      include_optout: m.include_optout,
      weight: m.weight,
      is_active: m.is_active,
    });
    msgByStep.set(m.step_id, arr);
  }
  const stepsBySeq = new Map();
  for (const s of stepRows) {
    const arr = stepsBySeq.get(s.sequence_id) || [];
    arr.push({
      id: s.id,
      step_index: s.step_index,
      offset_minutes: s.offset_minutes,
      label: s.label ?? null,
      is_active: s.is_active,
      messages: (msgByStep.get(s.id) || []).sort((a, b) => {
        const ac = a.category_key || '';
        const bc = b.category_key || '';
        return ac.localeCompare(bc) || String(a.variant).localeCompare(String(b.variant));
      }),
    });
    stepsBySeq.set(s.sequence_id, arr);
  }
  return seqRows.map((q) => ({
    ...q,
    steps: (stepsBySeq.get(q.id) || []).sort((a, b) => a.step_index - b.step_index),
  }));
}

