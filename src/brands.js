// Centralized brand / inbox routing for the Customer Intake automation.
//
// This is the ONE place that maps an intake tag to a brand, its Chatwoot SMS inbox, and its
// email identity. Adding or changing a brand should only require editing this file (or setting
// the matching env overrides) — never the automation code that consumes it.
//
// Chatwoot inbox IDs are configuration, not secrets (the API token is the secret and lives in
// CHAT_FOUNDRY_CHATWOOT_API_TOKEN). Defaults below are the discovered brand SMS inboxes; each can
// be overridden per deploy via env so staging/prod can differ without a code change.
//
// Per-brand env overrides (all optional):
//   INTAKE_BRAND_<KEY>_INBOX_ID     Chatwoot inbox id used to text the customer
//   INTAKE_BRAND_<KEY>_EMAIL_FROM   From address for this brand's confirmation email
//   INTAKE_BRAND_<KEY>_REPLY_TO     Reply-To for this brand's confirmation email
// where <KEY> is the brand key upper-cased with dashes as underscores (e.g. PRESSURE_WASHING).
// Global fallbacks: INTAKE_EMAIL_FROM, INTAKE_EMAIL_REPLY_TO.

// tags[] are matched case-insensitively against the intake's customer_tag (handles "Tree"/"Trees").
const BRANDS = [
  { key: 'trees',            tags: ['tree', 'trees'],                                          company: 'Washington Tree Services',     inboxId: 13 },
  { key: 'landscaping',      tags: ['landscaping'],                                            company: 'Washington Landscaping',       inboxId: 7 },
  { key: 'roofing',          tags: ['roofing'],                                                company: 'Washington Roofing',           inboxId: 14 },
  { key: 'construction',     tags: ['construction'],                                           company: 'Washington Construction',      inboxId: 17 },
  { key: 'pressure-washing', tags: ['pressure washing', 'pressure-washing', 'pressurewashing'], company: 'Washington Pressure Washing', inboxId: null },
  { key: 'firewood',         tags: ['firewood'],                                               company: 'Washington Firewood',          inboxId: null },
];

function envKey(brandKey) {
  return brandKey.toUpperCase().replace(/-/g, '_');
}

// Resolve an intake tag to its fully-resolved brand config (inbox + email identity), applying
// env overrides. Returns null when the tag matches no configured brand.
export function resolveBrand(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return null;
  const b = BRANDS.find((br) => br.tags.includes(t));
  if (!b) return null;

  const K = envKey(b.key);
  const inboxId = Number(process.env[`INTAKE_BRAND_${K}_INBOX_ID`] || b.inboxId || 0) || null;
  const emailFrom = process.env[`INTAKE_BRAND_${K}_EMAIL_FROM`] || process.env.INTAKE_EMAIL_FROM || null;
  const replyTo = process.env[`INTAKE_BRAND_${K}_REPLY_TO`] || process.env.INTAKE_EMAIL_REPLY_TO || null;

  return { key: b.key, company: b.company, inboxId, emailFrom, replyTo };
}

// Non-secret snapshot of brand comms readiness for the config endpoint / diagnostics.
export function brandsStatus() {
  return BRANDS.map((b) => {
    const r = resolveBrand(b.tags[0]);
    return { key: b.key, company: b.company, smsReady: Boolean(r && r.inboxId), emailReady: Boolean(r && r.emailFrom) };
  });
}

export { BRANDS };
