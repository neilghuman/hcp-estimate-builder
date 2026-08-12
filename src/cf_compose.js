// Chat Foundry — compose engine (Sprint 4): merge-field placeholders + per-recipient rendering.
//
// Pure functions only (no network, no DB) so they are directly unit-testable. The compose
// step NEVER sends: it renders a preview and reports which recipients would be BLOCKED because
// a required placeholder cannot be resolved (or an unknown/unsupported field was used).

// Supported merge fields. `derive` maps a normalized Chatwoot conversation → the field value.
// A field resolves only when derive() returns a non-empty string.
export const PLACEHOLDER_FIELDS = [
  { key: 'first_name', label: 'First name', example: 'Sam', derive: (c) => firstName(c.contact_name) },
  { key: 'full_name', label: 'Full name', example: 'Sam Rivera', derive: (c) => clean(c.contact_name) },
  { key: 'phone_last4', label: 'Phone (last 4)', example: '4821', derive: (c) => last4(c.phone || c.contact_identifier) },
  { key: 'email', label: 'Email', example: 'sam@example.com', derive: (c) => clean(c.email) },
  { key: 'agent', label: 'Assigned agent', example: 'Jordan', derive: (c) => firstName(c.assignee) },
];

const FIELD_MAP = new Map(PLACEHOLDER_FIELDS.map((f) => [f.key, f]));
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}
function firstName(v) {
  const s = clean(v);
  return s ? s.split(/\s+/)[0] : null;
}
function last4(v) {
  const digits = String(v == null ? '' : v).replace(/[^\d]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// PURE: unique placeholder keys used in a template body (in order of first appearance).
export function extractPlaceholders(body) {
  const seen = new Set();
  const out = [];
  for (const m of String(body || '').matchAll(TOKEN_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// PURE: static analysis of a template body, independent of any recipient.
// Returns which known fields it uses and which tokens reference unsupported fields.
export function analyzeTemplate(body) {
  const used = extractPlaceholders(body);
  const known = used.filter((k) => FIELD_MAP.has(k));
  const unknown = used.filter((k) => !FIELD_MAP.has(k));
  return { used, known, unknown, hasUnknown: unknown.length > 0 };
}

// PURE: build the merge context for one recipient from a normalized conversation.
export function buildRecipientContext(conv = {}) {
  const ctx = {};
  for (const f of PLACEHOLDER_FIELDS) ctx[f.key] = f.derive(conv);
  return ctx;
}

// PURE: substitute known, resolved fields into the body; leave unresolved/unknown tokens intact.
// Returns { text, resolved:{key:value}, unresolved:[keys], unknown:[keys] }.
export function resolvePlaceholders(body, context = {}) {
  const resolved = {};
  const unresolved = [];
  const unknown = [];
  const text = String(body || '').replace(TOKEN_RE, (whole, key) => {
    if (!FIELD_MAP.has(key)) {
      if (!unknown.includes(key)) unknown.push(key);
      return whole;
    }
    const val = context[key];
    if (val == null || String(val) === '') {
      if (!unresolved.includes(key)) unresolved.push(key);
      return whole;
    }
    resolved[key] = String(val);
    return String(val);
  });
  return { text, resolved, unresolved, unknown };
}

// PURE: render a template for one recipient. `blocked` = the message must NOT be sent because a
// referenced placeholder is unknown or could not be resolved for this recipient.
export function renderForRecipient(body, conv = {}) {
  const ctx = buildRecipientContext(conv);
  const r = resolvePlaceholders(body, ctx);
  const blocked = r.unresolved.length > 0 || r.unknown.length > 0;
  return {
    conversation_id: conv.conversation_id ?? null,
    contact_name: conv.contact_name || null,
    text: r.text,
    resolved: r.resolved,
    unresolved: r.unresolved,
    unknown: r.unknown,
    blocked,
    block_reason: blocked
      ? (r.unknown.length
        ? `Unsupported field(s): ${r.unknown.join(', ')}`
        : `Missing value(s): ${r.unresolved.join(', ')}`)
      : null,
  };
}

// PURE: render a body across sample recipients and summarize. Never sends.
export function composePreview(body, recipients = []) {
  const template = analyzeTemplate(body);
  const samples = recipients.map((c) => renderForRecipient(body, c));
  const blocked = samples.filter((s) => s.blocked).length;
  return {
    template,
    samples,
    summary: { total: samples.length, renderable: samples.length - blocked, blocked },
  };
}
