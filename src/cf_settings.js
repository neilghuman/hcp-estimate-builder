// Chat Foundry — runtime settings (DB-persisted, operator-toggleable). No process restart needed.
//
// The env vars CHAT_FOUNDRY_SEND_ENABLED and CHAT_FOUNDRY_ALLOWED_INBOX_IDS are the DEFAULTS. When
// an operator flips a toggle in the UI, we persist an override row in chat_foundry_settings and keep
// a synchronous in-memory cache so the rest of the code (buildAudience, inboxCapability, the sender)
// can keep reading these values synchronously. The cache is hydrated from the DB at startup.
//
// SAFETY: arming live sending (turning it ON) requires the exact confirmation phrase. Turning it OFF
// is always allowed with no confirmation — moving toward "safer" never needs a ceremony.

export const SEND_CONFIRM_PHRASE = 'ENABLE SENDING';

// null = "no override, use the env default". Otherwise the override wins.
let sendOverride = null;   // boolean | null
let inboxOverride = null;  // number[] | null

function envSendEnabled() {
  return String(process.env.CHAT_FOUNDRY_SEND_ENABLED || 'false').toLowerCase() === 'true';
}
function envInboxIds() {
  return String(process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
}

// Effective (override-or-env) values — synchronous, safe to call anywhere.
export function effectiveSendEnabled() {
  return sendOverride === null ? envSendEnabled() : sendOverride;
}
export function effectiveAllowedInboxIds() {
  return inboxOverride === null ? envInboxIds() : inboxOverride.slice();
}

// PURE: add/remove an inbox id from a list (dedup, numeric, sorted).
export function nextInboxList(current, id, allowed) {
  const set = new Set((current || []).map(Number).filter((n) => Number.isFinite(n)));
  const n = Number(id);
  if (allowed) set.add(n); else set.delete(n);
  return [...set].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

export function settingsView() {
  return {
    sendEnabled: effectiveSendEnabled(),
    sendSource: sendOverride === null ? 'env' : 'db',
    allowedInboxIds: effectiveAllowedInboxIds(),
    inboxSource: inboxOverride === null ? 'env' : 'db',
    confirmPhrase: SEND_CONFIRM_PHRASE,
  };
}

// Hydrate the cache from the DB at startup (falls back to env if the table is missing).
export async function loadSettings(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM chat_foundry_settings WHERE key IN ('send_enabled','allowed_inbox_ids')`);
    for (const r of rows) {
      if (r.key === 'send_enabled') sendOverride = !!(r.value && r.value.enabled);
      if (r.key === 'allowed_inbox_ids' && r.value && Array.isArray(r.value.ids)) {
        inboxOverride = r.value.ids.map(Number).filter((n) => Number.isFinite(n));
      }
    }
  } catch { /* table not created yet — keep using env defaults */ }
  return settingsView();
}

async function upsert(pool, key, value, actor) {
  await pool.query(
    `INSERT INTO chat_foundry_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(value), actor]);
}

export async function setSendEnabled(pool, enabled, confirmPhrase, actor) {
  const on = enabled === true;
  if (on && String(confirmPhrase || '').trim() !== SEND_CONFIRM_PHRASE) {
    const e = new Error(`To arm live sending, type the confirmation phrase exactly: "${SEND_CONFIRM_PHRASE}".`);
    e.status = 400; throw e;
  }
  await upsert(pool, 'send_enabled', { enabled: on }, actor);
  sendOverride = on;
  return settingsView();
}

export async function setInboxAllowed(pool, inboxId, allowed, actor) {
  const id = Number(inboxId);
  if (!Number.isFinite(id)) { const e = new Error('Invalid inbox id.'); e.status = 400; throw e; }
  const ids = nextInboxList(effectiveAllowedInboxIds(), id, allowed === true);
  await upsert(pool, 'allowed_inbox_ids', { ids }, actor);
  inboxOverride = ids;
  return settingsView();
}
