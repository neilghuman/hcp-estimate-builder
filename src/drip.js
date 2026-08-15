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
      id: m.id,
      category_key: m.category_key ?? null,
      variant: m.variant,
      body: m.body,
      include_optout: m.include_optout,
      weight: m.weight,
      is_active: m.is_active,
      version: m.version,
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

// ---- SMS segmentation + message validation (dashboard editing) ----------------

// GSM 03.38 basic character set (each = 1 septet) and extension set (each = 2 septets).
const GSM_BASIC = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡'
    + 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà').split(''),
);
const GSM_EXT = new Set('^{}\\[~]|€'.split(''));

// Estimate SMS encoding + segment count for a body. Placeholders ({name}) are counted literally,
// so the real length shifts slightly at send — treated as an estimate in the UI.
export function smsSegments(text) {
  const s = String(text || '');
  const chars = Array.from(s);
  let gsm = true;
  let septets = 0;
  for (const c of chars) {
    if (GSM_BASIC.has(c)) { septets += 1; }
    else if (GSM_EXT.has(c)) { septets += 2; }
    else { gsm = false; break; }
  }
  if (gsm) {
    const units = septets;
    const segments = units === 0 ? 0 : (units <= 160 ? 1 : Math.ceil(units / 153));
    const perSegment = segments <= 1 ? 160 : 153;
    return { encoding: 'GSM-7', units, segments, perSegment, remaining: segments === 0 ? 160 : segments * perSegment - units };
  }
  const units = chars.length; // UCS-2 counts code points here (close enough for estimate)
  const segments = units === 0 ? 0 : (units <= 70 ? 1 : Math.ceil(units / 67));
  const perSegment = segments <= 1 ? 70 : 67;
  return { encoding: 'UCS-2', units, segments, perSegment, remaining: segments === 0 ? 70 : segments * perSegment - units };
}

// Validate a message body against opt-out/quality rules. Returns [{ level, code, message }].
// level 'error' should block a save; 'warn' is advisory.
export function validateMessage(body, { includeOptout = false } = {}) {
  const issues = [];
  const text = String(body || '');
  const trimmed = text.trim();
  if (!trimmed) {
    issues.push({ level: 'error', code: 'empty', message: 'Message body cannot be empty.' });
    return issues;
  }
  const hasStop = /\bstop\b/i.test(text);
  if (includeOptout && !hasStop) {
    issues.push({ level: 'error', code: 'optout_missing', message: 'This message is marked as carrying an opt-out, but the body has no "STOP" instruction.' });
  }
  if (!includeOptout && hasStop) {
    issues.push({ level: 'warn', code: 'optout_mismatch', message: 'Body mentions "STOP" but the opt-out flag is off — set the flag so it is tracked as a consent message.' });
  }
  const { segments } = smsSegments(text);
  if (segments >= 3) {
    issues.push({ level: 'warn', code: 'long', message: `This is ${segments} SMS segments — consider shortening to keep it to 1–2.` });
  }
  const unknown = (text.match(/\{(\w+)\}/g) || []).filter((p) => !['{name}', '{service}', '{Business}'].includes(p));
  if (unknown.length) {
    issues.push({ level: 'warn', code: 'placeholder', message: `Unknown placeholder(s): ${[...new Set(unknown)].join(', ')}. Only {name}, {service}, {Business} are substituted.` });
  }
  return issues;
}

export const TAXONOMY_SOURCES = ['thumbtack', 'google_lsa', 'any'];

// Validate + normalize a category-map row. Returns { ok, value?, error? }.
export function validateCategoryMap({ categoryKey, source, rawValue } = {}) {
  const key = String(categoryKey || '').trim().toLowerCase();
  const src = String(source || '').trim().toLowerCase();
  const raw = String(rawValue || '').trim();
  if (!key) return { ok: false, error: 'Category key is required.' };
  if (!/^[a-z0-9_]+$/.test(key)) return { ok: false, error: 'Category key may only contain lowercase letters, numbers, and underscores.' };
  if (!TAXONOMY_SOURCES.includes(src)) return { ok: false, error: `Source must be one of: ${TAXONOMY_SOURCES.join(', ')}.` };
  if (!raw) return { ok: false, error: 'Raw value is required.' };
  return { ok: true, value: { categoryKey: key, source: src, rawValue: raw } };
}

