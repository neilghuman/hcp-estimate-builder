// Customer Intake System — service module.
//
// Sprint 1 scope: scaffolding + the durable draft store (create / read / update / list) and a
// non-secret config endpoint. NO Housecall Pro calls and NO notifications yet — those arrive in
// later sprints (lookup, customer create + tags, estimate + private notes, SMS via Chatwoot).
//
// Design notes:
//   - Every intake is one `customer_intakes` row that progresses draft -> submitting -> completed.
//   - Reporting dimensions live in first-class columns; everything else rides in the `data` JSONB,
//     so future reports and features slot in without schema rewrites.
//   - Pure helpers are exported separately from the route wiring so they can be unit-tested.

import { listEmployees, searchCustomers, getCustomer, listTags, createCustomer, ensureCustomerAddress, applyCustomerTag, createEmptyEstimate, appendCustomerNote } from './hcp.js';
import * as chatwoot from './chatwoot.js';
import * as email from './email.js';
import { resolveBrand, brandsStatus } from './brands.js';

// Columns a client may set on a draft. Anything not in this list is ignored (defence in depth:
// the UPDATE only ever interpolates names from this allowlist, never client-provided keys).
export const DRAFT_COLUMNS = [
  'created_by', 'created_by_hcp_id',
  'hcp_customer_id', 'customer_is_new',
  'first_name', 'last_name', 'phone', 'email', 'company', 'secondary_phone',
  'address_line', 'address_street', 'address_unit', 'address_city', 'address_state', 'address_zip',
  'address_place_id', 'address_notes',
  'customer_tag',
  // Discovery: universal questions (Sprint 1 revised schema).
  'project_description', 'buying_priority', 'buying_stage',
  'getting_estimates', 'budget', 'photos_provided',
  'contact_time', 'additional_notes',
  // Server-managed outcome columns (written by the gated apply/notify actions).
  'hcp_estimate_id', 'hcp_estimate_option_id', 'hcp_estimate_number',
  'hcp_customer_url', 'hcp_estimate_url', 'notify_status', 'notify_error',
  // Brand-routed customer communications (SMS + email) outcomes.
  'resolved_brand', 'chatwoot_inbox_id', 'chatwoot_contact_id', 'chatwoot_conversation_id',
  'customer_sms_status', 'customer_sms_at', 'customer_sms_error',
  'customer_email_status', 'customer_email_at', 'customer_email_error',
];

export const INTAKE_STATUSES = ['draft', 'submitting', 'completed', 'failed'];

// === Sprint 1: Discovery Questions Schema ===
// Universal questions that apply across all services.
// Each question: id (key), text, type (textarea/text/select/pills), required, placeholder, options[], showWhen (for S2 conditionals).
export const DISCOVERY_QUESTIONS = [
  // Sprint 1 Revised: 9 questions (merged Q1+Q3, removed Q10, reworded Q11)
  {
    id: 'project_description',
    text: 'Tell us about your project and when you\'d like it completed.',
    type: 'textarea',
    required: true,
    placeholder: 'Describe what you need and your ideal timeline...',
  },
  {
    id: 'buying_priority',
    text: 'What matters most to you when selecting a contractor?',
    type: 'select',
    required: true,
    placeholder: 'Select what matters most',
    options: [
      { label: 'Quality of work', value: 'quality' },
      { label: 'Price / value for money', value: 'price' },
      { label: 'Warranty / guarantee', value: 'warranty' },
      { label: 'Reputation / trusted company', value: 'reputation' },
      { label: 'Speed / get it done fast', value: 'speed' },
      { label: 'Not sure', value: 'not-sure' },
    ],
  },
  {
    id: 'buying_stage',
    text: 'Where are you in the process of moving forward?',
    type: 'select',
    required: true,
    placeholder: 'Select your stage',
    options: [
      { label: 'Ready to move forward', value: 'ready' },
      { label: 'Comparing different options', value: 'comparing' },
      { label: 'Planning / setting budget', value: 'planning' },
      { label: 'Still researching', value: 'researching' },
    ],
  },
  {
    id: 'getting_estimates',
    text: 'Are you getting estimates from other companies? If so, can you share your other estimate schedules so we don\'t book you at the same time?',
    type: 'select',
    required: true,
    placeholder: 'Select an option',
    options: [
      { label: 'Yes, I\'m comparing estimates', value: 'yes' },
      { label: 'No, just getting one from you', value: 'no' },
      { label: 'Planning to get more estimates', value: 'planning' },
    ],
  },
  {
    id: 'budget',
    text: 'What\'s your budget range?',
    type: 'text',
    required: false,
    placeholder: 'e.g. around $5,000, or not sure yet (optional)',
  },
  {
    id: 'photos_provided',
    text: 'Do you have any photos of the project?',
    type: 'select',
    required: false,
    placeholder: 'Select an option',
    help_text: 'If so, you\'ll receive a text message after the call that you can simply reply to with any photos you\'d prefer to share.',
    options: [
      { label: 'Yes, I have photos', value: 'yes' },
      { label: 'No, I don\'t have any', value: 'no' },
    ],
  },
  {
    id: 'contact_time',
    text: 'What is the best time for us to contact you via telephone?',
    type: 'select',
    required: true,
    placeholder: 'Select preferred time',
    options: [
      { label: 'Morning (8am - 12pm)', value: 'morning' },
      { label: 'Afternoon (12pm - 5pm)', value: 'afternoon' },
      { label: 'Evening (5pm - 8pm)', value: 'evening' },
      { label: 'Anytime works', value: 'anytime' },
    ],
  },
  {
    id: 'additional_notes',
    text: 'Anything else we should know?',
    type: 'textarea',
    required: false,
    placeholder: 'Additional details, concerns, or questions (optional)...',
  },
];

export function intakeEnabled() {
  // Feature flag — default ON. Set INTAKE_ENABLED=false to hide the API (nav is static).
  return String(process.env.INTAKE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

// Write gate for anything that MUTATES Housecall Pro (Sprint 4+). Default OFF so testing never
// creates/updates real records; the operator flips INTAKE_WRITE_ENABLED=true deliberately.
export function intakeWriteEnabled() {
  return String(process.env.INTAKE_WRITE_ENABLED ?? 'false').toLowerCase() === 'true';
}

// Normalise a client patch into { columns: {allowed scalar cols}, data: {leftovers} }.
// Pure + side-effect free so it can be unit-tested without a DB.
export function splitPatch(patch) {
  const columns = {};
  const data = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'data' && v && typeof v === 'object') {
      Object.assign(data, v);
    } else if (DRAFT_COLUMNS.includes(k)) {
      columns[k] = v;
    } else {
      // Unknown keys are preserved in the JSONB snapshot rather than dropped.
      data[k] = v;
    }
  }
  return { columns, data };
}

const RETURNING = '*';

export async function createDraft(pool, { createdBy = null, createdById = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO customer_intakes (created_by, created_by_hcp_id) VALUES ($1, $2) RETURNING ${RETURNING}`,
    [createdBy, createdById],
  );
  return rows[0];
}

// Look up by numeric id or by public_id UUID (the id used in URLs / idempotency).
export async function getIntake(pool, idOrPublicId) {
  const asNum = Number(idOrPublicId);
  const byNum = Number.isInteger(asNum) && String(asNum) === String(idOrPublicId);
  const { rows } = await pool.query(
    byNum
      ? `SELECT * FROM customer_intakes WHERE id = $1`
      : `SELECT * FROM customer_intakes WHERE public_id = $1`,
    [idOrPublicId],
  );
  return rows[0] || null;
}

// Patch a draft: whitelisted scalar columns + a shallow JSONB merge into `data`.
export async function updateDraft(pool, idOrPublicId, patch) {
  const existing = await getIntake(pool, idOrPublicId);
  if (!existing) {
    const err = new Error('Intake draft not found');
    err.status = 404;
    throw err;
  }
  const { columns, data } = splitPatch(patch);

  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(columns)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (Object.keys(data).length) {
    params.push(JSON.stringify(data));
    sets.push(`data = data || $${params.length}::jsonb`);
  }
  sets.push('updated_at = NOW()');

  params.push(existing.id);
  const { rows } = await pool.query(
    `UPDATE customer_intakes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${RETURNING}`,
    params,
  );
  return rows[0];
}

export async function listIntakes(pool, { status = null, limit = 25 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const { rows } = status
    ? await pool.query(
        `SELECT * FROM customer_intakes WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, lim],
      )
    : await pool.query(
        `SELECT * FROM customer_intakes ORDER BY created_at DESC LIMIT $1`,
        [lim],
      );
  return rows;
}

// Recover intakes left mid-submit by a restart. Steps are idempotent, so we mark them 'failed'
// (resumable) rather than auto-resuming — a customer is never double-created/-texted without intent.
export async function recoverInterruptedIntakes(pool) {
  const { rowCount } = await pool.query(
    `UPDATE customer_intakes
        SET status = 'failed',
            error = COALESCE(error, 'Interrupted by a restart mid-submit; re-submit to resume.'),
            updated_at = NOW()
      WHERE status = 'submitting'`,
  );
  return { recovered: rowCount || 0 };
}

// Best-effort staff attribution (simple, per decision #2). Falls back to the Basic Auth user.
export function staffName(req, bodyName) {
  const fromBody = String(bodyName || '').trim();
  if (fromBody) return fromBody.slice(0, 120);
  try {
    const hdr = (req && req.headers && req.headers.authorization) || '';
    const [, b64] = hdr.split(' ');
    if (b64) {
      const [u] = Buffer.from(b64, 'base64').toString().split(':');
      if (u) return u;
    }
  } catch { /* ignore */ }
  return null;
}

// --- Sprint 2: customer lookup + dedupe --------------------------------------
// Ordered lookup keys, per spec: phone > email > name. Pure so it can be unit-tested.
export function buildLookupAttempts({ phone, email, first_name, last_name } = {}) {
  const attempts = [];
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 7) attempts.push({ by: 'phone', term: digits });
  const em = String(email || '').trim();
  if (em && /.+@.+\..+/.test(em)) attempts.push({ by: 'email', term: em });
  const name = [first_name, last_name].filter(Boolean).join(' ').trim();
  if (name.length >= 3) attempts.push({ by: 'name', term: name });
  return attempts;
}

// Try each key in priority order; return the first that yields matches. `searchFn` is injected
// (hcp.searchCustomers in production) so this is testable without a live HCP.
export async function lookupCustomer(fields, searchFn) {
  for (const a of buildLookupAttempts(fields)) {
    const customers = await searchFn(a.term);
    if (customers && customers.length) return { matchedBy: a.by, term: a.term, customers };
  }
  return { matchedBy: null, term: null, customers: [] };
}

// Map a simplified HCP customer onto draft columns when the staff links an existing record.
// This is what prevents duplicate creation downstream: hcp_customer_id is set + customer_is_new=false.
export function customerToDraftPatch(c) {
  const addr = (c.addresses && c.addresses[0]) || null;
  return {
    hcp_customer_id: c.id,
    customer_is_new: false,
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    phone: c.mobile || null,
    email: c.email || null,
    company: c.company || null,
    address_line: addr ? addr.line : null,
    address_street: addr ? addr.street : null,
    address_unit: addr ? addr.unit : null,
    address_city: addr ? addr.city : null,
    address_state: addr ? addr.state : null,
    address_zip: addr ? addr.zip : null,
  };
}

// --- Sprint 3: customer info validation --------------------------------------
export const REQUIRED_CUSTOMER_FIELDS = [
  'first_name', 'last_name', 'phone', 'email',
  'address_street', 'address_city', 'address_state', 'address_zip',
];

// Normalise a US phone to 10 digits (tolerating a leading country code). Pure.
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  const valid = ten.length === 10;
  return { digits: ten, valid, e164: valid ? `+1${ten}` : null };
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// Field-level validation. Returns { valid, errors: { field: message } }. Pure.
export function validateCustomer(f = {}) {
  const errors = {};
  const req = (k, label) => { if (!String(f[k] || '').trim()) errors[k] = `${label} is required.`; };
  req('first_name', 'First name');
  req('last_name', 'Last name');
  req('address_street', 'Street address');
  req('address_city', 'City');
  req('address_state', 'State');
  req('address_zip', 'ZIP code');
  if (String(f.address_zip || '').trim() && !/^\d{5}$/.test(String(f.address_zip).trim())) {
    errors.address_zip = 'Enter a valid 5-digit ZIP code.';
  }

  if (!String(f.phone || '').trim()) errors.phone = 'Phone is required.';
  else if (!normalizePhone(f.phone).valid) errors.phone = 'Enter a valid 10-digit US phone.';

  if (!String(f.email || '').trim()) errors.email = 'Email is required.';
  else if (!isValidEmail(f.email)) errors.email = 'Enter a valid email address.';

  // Optional, but if provided it must be a valid phone.
  if (String(f.secondary_phone || '').trim() && !normalizePhone(f.secondary_phone).valid) {
    errors.secondary_phone = 'Enter a valid 10-digit US phone.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Combine field validation with the create-vs-reuse decision. The customer step is only "complete"
// when the fields are valid AND staff have either linked an existing customer or marked it new. Pure.
export function customerStepStatus(row = {}) {
  const v = validateCustomer(row);
  const decisionMade = Boolean(row.hcp_customer_id) || row.customer_is_new === true;
  const reasons = [];
  if (!v.valid) reasons.push('Complete the required customer fields.');
  if (!decisionMade) reasons.push('Choose an existing customer or mark this as a new customer.');
  return { valid: v.valid, errors: v.errors, decisionMade, complete: v.valid && decisionMade, reasons };
}

// --- Sprint 4: HCP customer create + tag (WRITES) ----------------------------
// Build the HCP create-customer payload from a draft row. Pure.
export function buildCustomerCreatePayload(row = {}) {
  const payload = {
    first_name: row.first_name || undefined,
    last_name: row.last_name || undefined,
    email: row.email || undefined,
    mobile_number: normalizePhone(row.phone).digits || undefined,
    company: row.company || undefined,
    notifications_enabled: false,
  };
  const secondary = normalizePhone(row.secondary_phone);
  if (secondary.valid) payload.home_number = secondary.digits;
  if (row.customer_tag) payload.tags = [row.customer_tag];
  if (row.address_street) {
    payload.addresses = [{
      street: row.address_street,
      street_line_2: row.address_unit || undefined,
      city: row.address_city || undefined,
      state: row.address_state || undefined,
      zip: row.address_zip || undefined,
      country: 'US',
      type: 'service',
    }];
  }
  return payload;
}

// --- Sprint 5: discovery questions (config-driven) ---------------------------
// One schema drives BOTH server validation and the UI, so questions are easy to add/reorder.
// `showIf` makes a question conditional; conditional questions are only required when visible.
export const OFFICE_FINAL_ESTIMATE_SCRIPT =
  "That's completely understandable. Most of our customers compare a few companies before making a " +
  'decision. If it\'s okay with you, would you mind scheduling us as your final estimate? We\'ve found ' +
  'that being the final estimate allows us to review the options you\'ve already received, answer any ' +
  'remaining questions, explain any differences between proposals, and make sure you have all the ' +
  "information you need to make the best decision for your property. Our goal isn't simply to give " +
  'another estimate — we want to help you make the right decision.';

// A question is only in play when its showIf condition (if any) is satisfied. Pure.
export function isQuestionVisible(q, row = {}) {
  if (!q.showIf) return true;
  return String(row[q.showIf.key] ?? '') === q.showIf.equals;
}

// Validate discovery answers using new sprint 1 revised schema. Pure.
export function validateDiscovery(row = {}) {
  const errors = {};
  
  // Check required discovery questions
  const requiredQuestions = DISCOVERY_QUESTIONS.filter(q => q.required);
  for (const q of requiredQuestions) {
    const val = String(row[q.id] || '').trim();
    if (!val) {
      errors[q.id] = `${q.text} is required.`;
    }
  }
  
  return { valid: Object.keys(errors).length === 0, errors };
}

export function discoveryStepStatus(row = {}) {
  const v = validateDiscovery(row);
  return { valid: v.valid, errors: v.errors, complete: v.valid, reasons: v.valid ? [] : ['Answer the required discovery questions.'] };
}

// --- Sprint 4: estimate URL deep-link builder ----------------------------------
// Build the direct HCP estimate deep-link. HCP deep-links use the OPTION id, not estimate id.
// Pure.
export function buildEstimateUrl(optionId) {
  if (!optionId) return null;
  return `https://pro.housecallpro.com/app/estimates/${encodeURIComponent(optionId)}`;
}

// --- Sprint 6: estimate placeholder + private notes --------------------------
// Idempotency marker embedded in the note so re-running never double-appends. Pure.
export function intakeNoteMarker(row = {}) {
  return `[intake:${row.public_id}]`;
}

function noteVal(v) {
  return (v === null || v === undefined || String(v).trim() === '') ? '—' : String(v);
}

// Build the formatted Private Notes block for an intake. Pure (date injectable for tests).
export function buildIntakeNote(row = {}, { now = new Date() } = {}) {
  return [
    `Customer Intake ${intakeNoteMarker(row)}`,
    `Project & Timeline: ${noteVal(row.project_description)}`,
    `What Matters Most: ${noteVal(row.buying_priority)}`,
    `Buying Stage: ${noteVal(row.buying_stage)}`,
    `Getting Other Estimates: ${noteVal(row.getting_estimates)}`,
    `Budget: ${noteVal(row.budget)}`,
    `Has Photos: ${noteVal(row.photos_provided)}`,
    `Best Contact Time: ${noteVal(row.contact_time)}`,
    `Additional Notes: ${noteVal(row.additional_notes)}`,
    `Created By: ${noteVal(row.created_by)}`,
    `Date: ${now.toISOString()}`,
  ].join('\n');
}

// --- Estimate "Summary of Work" ----------------------------------------------
// The estimate is what an estimator or crew member actually opens, so the whole intake is
// rendered into it as plain-text Question/Answer pairs under readable headings. Deliberately
// NOT a field dump: no keys, ids, JSON or API values ever reach this text.
//
// Question wording comes from DISCOVERY_QUESTIONS so the schema stays the single source of
// truth; SUMMARY_QUESTION_TEXT only overrides the few labels that read as form captions rather
// than as something you would say to a customer.
const SUMMARY_QUESTION_TEXT = {
  project_description: 'What is the project and ideal timeline?',
  buying_priority: 'What matters most when choosing a contractor?',
  buying_stage: 'Where are they in the decision process?',
  getting_estimates: 'Are they getting other estimates (and can they share schedules)?',
  budget: 'What budget range do they have in mind?',
  photos_provided: 'Will they be sending photos of the project?',
  contact_time: 'When is the best time to reach them by phone?',
  additional_notes: 'Anything else we should know?',
};

// Which discovery questions belong under which heading, in the order they should print.
const SUMMARY_DISCOVERY_SECTIONS = [
  { title: 'CUSTOMER REQUEST', keys: ['project_description'] },
  { title: 'DECISION & BUDGET', keys: ['buying_priority', 'buying_stage', 'getting_estimates', 'budget'] },
  { title: 'SCHEDULING & FOLLOW-UP', keys: ['contact_time', 'photos_provided'] },
  { title: 'ADDITIONAL NOTES', keys: ['additional_notes'] },
];

// Format a US phone for humans; fall back to whatever was entered if it isn't 10 digits.
function summaryPhone(raw) {
  const { digits, valid } = normalizePhone(raw);
  if (!valid) return String(raw || '').trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function summaryAddressLines(row) {
  const street = [row.address_street, row.address_unit].filter(Boolean).join(' ');
  const cityLine = [
    [row.address_city, row.address_state].filter(Boolean).join(', '),
    row.address_zip,
  ].filter(Boolean).join(' ');
  return [street, cityLine].filter(Boolean).join('\n');
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

// One "Question:/Answer:" pair. Returns null when the answer is blank and the question is
// optional, so unanswered optional questions don't pad the summary with noise.
function summaryPair(question, answer, { required = false } = {}) {
  if (!hasValue(answer)) {
    if (!required) return null;
    return `Question: ${question}\nAnswer: Not provided`;
  }
  return `Question: ${question}\nAnswer: ${String(answer).trim()}`;
}

function summarySection(title, pairs) {
  const body = pairs.filter(Boolean);
  if (!body.length) return null;
  return `${title}\n${'-'.repeat(title.length)}\n\n${body.join('\n\n')}`;
}

// Build the estimate's Summary of Work for an intake. Pure (date injectable for tests).
export function buildEstimateSummary(row = {}, { now = new Date() } = {}) {
  const sections = [];

  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ');
  sections.push(summarySection('CUSTOMER', [
    summaryPair('Who is the customer?', customerName, { required: true }),
    summaryPair('What company do they represent?', row.company),
    summaryPair('What is the best phone number?', summaryPhone(row.phone), { required: true }),
    summaryPair('Is there a secondary phone number?', summaryPhone(row.secondary_phone)),
    summaryPair('What is their email address?', row.email, { required: true }),
    summaryPair('Which service line is this for?', row.customer_tag),
  ]));

  sections.push(summarySection('SERVICE ADDRESS', [
    summaryPair('Where is the work located?', summaryAddressLines(row), { required: true }),
    summaryPair('Are there any access notes (gate code, parking, etc.)?', row.address_notes),
  ]));

  for (const section of SUMMARY_DISCOVERY_SECTIONS) {
    const pairs = [];
    for (const key of section.keys) {
      const q = DISCOVERY_QUESTIONS.find((x) => x.id === key);
      if (!q || q.type === 'info') continue;
      // Conditional questions that were never shown to the customer are not "relevant".
      if (!isQuestionVisible(q, row)) continue;
      pairs.push(summaryPair(SUMMARY_QUESTION_TEXT[key] || q.text, row[key], { required: Boolean(q.required) }));
    }
    sections.push(summarySection(section.title, pairs));
  }

  const header = [
    'CUSTOMER INTAKE SUMMARY',
    `Taken ${formatSummaryDate(now)}${hasValue(row.created_by) ? ` by ${String(row.created_by).trim()}` : ''}`,
  ].join('\n');

  return [header, ...sections.filter(Boolean)].join('\n\n\n');
}

function formatSummaryDate(now) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Los_Angeles',
  }).format(now);
}

// --- Sprint 7: SMS notification (via Chatwoot) -------------------------------// Office recipients for the intake notification (E.164). Neil by default; Roman omitted for now.
export function notifyRecipients() {
  const raw = process.env.INTAKE_NOTIFY_NUMBERS || '2064581885';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => normalizePhone(s).e164 || s);
}

export function notifyInboxId() {
  const v = Number(process.env.INTAKE_NOTIFY_INBOX_ID || 0);
  return v > 0 ? v : null;
}

// Build an SMS notification for the office about a new intake, including estimate link and summary.
// Pure function with safe fallbacks for missing data.
export function buildNotificationSms(row = {}, {  } = {}) {
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ') || '(no name)';
  const tag = row.customer_tag || 'Service';
  const location = [row.address_city, row.address_state].filter(Boolean).join(', ') || '(no location)';
  
  // Build the header with customer + service + location
  const header = `${customerName} • ${tag} • ${location}`;
  
  // Add key summary details (project, budget)
  const summaryParts = [];
  if (row.project_description) summaryParts.push(`Project: ${String(row.project_description).split('\n')[0]}`); // first line only
  if (row.budget) summaryParts.push(`Budget: ${row.budget}`);
  const summary = summaryParts.length ? summaryParts.join(' | ') : '';
  
  // Add estimate link if available
  const estimateLink = row.hcp_estimate_url ? `\n${row.hcp_estimate_url}` : '';
  
  // Combine: header, summary, and link
  const message = [header, summary, estimateLink].filter(Boolean).join('\n');
  return message;
}

// --- Sprint 5: structured error logging & context tracking -----------------
// Log intake operations with full context for debugging and audit.
// Each log includes: intake public_id, HCP IDs, stage, error details, timestamp.
export function logIntakeError(row, stage, error, context = {}) {
  const details = {
    timestamp: new Date().toISOString(),
    intake_id: row?.public_id,
    intake_db_id: row?.id,
    hcp_customer_id: row?.hcp_customer_id || null,
    hcp_estimate_id: row?.hcp_estimate_id || null,
    hcp_estimate_option_id: row?.hcp_estimate_option_id || null,
    estimate_number: row?.hcp_estimate_number || null,
    stage,
    error_message: error?.message || String(error),
    error_status: error?.status || null,
    error_body: error?.body || null,
    ...context,
  };
  // In production, this would go to a structured logging service (e.g., CloudWatch, Datadog).
  // For now, log to console with a marker so it's easily grep-able.
  console.error('[INTAKE_ERROR]', JSON.stringify(details));
  return details;
}

// --- Sprint 8: submit orchestration — shared, idempotent service steps -------
// Each step is safe to re-run: it reuses an already-set id / marker instead of creating duplicates.

// Ensure the customer exists in HCP (link / reuse-found / create) and apply the tag. Idempotent.
export async function ensureCustomer(pool, row, { tag = row.customer_tag || null } = {}) {
  let action;
  let hcpId;
  let tags = null;

  if (row.hcp_customer_id) {
    action = 'link-existing';
    hcpId = row.hcp_customer_id;
    if (tag) tags = await applyCustomerTag(hcpId, tag);
  } else {
    const lk = await lookupCustomer(row, (t) => searchCustomers(t));
    if (lk.customers && lk.customers.length) {
      action = 'reuse-found';
      hcpId = lk.customers[0].id;
      if (tag) tags = await applyCustomerTag(hcpId, tag);
    } else {
      action = 'create';
      const payload = buildCustomerCreatePayload({ ...row, customer_tag: tag });
      const created = await createCustomer(payload);
      hcpId = created.id;
      tags = payload.tags || null;
    }
  }
  // The intake address must reach HCP even for a pre-existing customer. Addresses are a
  // separate sub-resource; a failure here must not lose an otherwise good submission.
  let address = null;
  try {
    address = await syncIntakeAddress(row, hcpId);
  } catch (e) {
    logIntakeError(row, 'customer_address_sync', e, { hcp_customer_id: hcpId });
  }

  await updateDraft(pool, row.id, { hcp_customer_id: hcpId, customer_is_new: false, customer_tag: tag });
  return { action, hcp_customer_id: hcpId, tags, hcp_address_id: address ? address.id : null };
}

// Push the intake's address to HCP and return the matching HCP address (idempotent).
async function syncIntakeAddress(row, hcpId) {
  if (!row.address_street) return null;
  return ensureCustomerAddress(hcpId, {
    street: row.address_street,
    unit: row.address_unit,
    city: row.address_city,
    state: row.address_state,
    zip: row.address_zip,
  });
}

// Ensure an estimate exists with the intake summary injected as a line item. Idempotent
// (skips if hcp_estimate_id already set). The summary is formatted as "Question:/Answer:" pairs.
// Catches and logs errors at each stage (lookup, summary build, estimate create).
export async function ensureEstimate(pool, row) {
  if (row.hcp_estimate_id) {
    return {
      estimate_id: row.hcp_estimate_id,
      estimate_option_id: row.hcp_estimate_option_id || null,
      estimate_number: row.hcp_estimate_number || null,
      created: false,
    };
  }

  // Bind the estimate to the address the intake actually captured, not merely the
  // customer's first address (which may be a stale one — HCP addresses are append-only).
  let addressId;
  try {
    const addr = await syncIntakeAddress(row, row.hcp_customer_id);
    if (addr) addressId = addr.id;
  } catch (e) {
    logIntakeError(row, 'estimate_address', e, { hcp_customer_id: row.hcp_customer_id });
  }
  if (!addressId) {
    try {
      const customer = await getCustomer(row.hcp_customer_id);
      addressId = (customer.addresses && customer.addresses[0] && customer.addresses[0].id) || undefined;
    } catch (e) {
      logIntakeError(row, 'estimate_lookup', e, { trying: 'fetch customer for address' });
      throw new Error(`Could not fetch customer ${row.hcp_customer_id}: ${e.message}`);
    }
  }

  let summary;
  try {
    summary = buildEstimateSummary(row);
  } catch (e) {
    logIntakeError(row, 'summary_build', e, { intake_fields_count: Object.keys(row).length });
    throw new Error(`Could not build estimate summary: ${e.message}`);
  }

  let est;
  try {
    est = await createEmptyEstimate({
      customerId: row.hcp_customer_id,
      addressId,
      optionName: row.customer_tag || 'Estimate',
      summary,
    });
  } catch (e) {
    logIntakeError(row, 'estimate_create', e, { summary_length: summary?.length || 0 });
    throw new Error(`HCP estimate creation failed: ${e.message}`);
  }

  if (!est.id || !est.option_id) {
    logIntakeError(row, 'estimate_validate', new Error('Missing response fields'), { response: est });
    throw new Error(`HCP response missing estimate or option ID`);
  }

  // Build the estimate deep-link URL
  let estimateUrl;
  try {
    estimateUrl = buildEstimateUrl(est.option_id);
  } catch (e) {
    logIntakeError(row, 'estimate_url_build', e, { option_id: est.option_id });
    estimateUrl = null; // non-fatal; estimate created even if URL building fails
  }

  try {
    await updateDraft(pool, row.id, {
      hcp_estimate_id: est.id,
      hcp_estimate_option_id: est.option_id || null,
      hcp_estimate_number: est.estimate_number == null ? null : String(est.estimate_number),
      hcp_estimate_url: estimateUrl,
    });
  } catch (e) {
    logIntakeError(row, 'estimate_persist', e, { estimate_id: est.id, option_id: est.option_id });
    throw new Error(`Could not persist estimate to intake draft: ${e.message}`);
  }

  return {
    estimate_id: est.id,
    estimate_option_id: est.option_id || null,
    estimate_number: est.estimate_number,
    estimate_url: estimateUrl,
    created: true,
  };
}

// Append the intake summary to the customer's private notes. Idempotent (marker-guarded).
// Catches and logs errors during note append.
export async function ensureNotes(pool, row, { now } = {}) {
  const note = buildIntakeNote(row, now ? { now } : {});
  let res;
  try {
    res = await appendCustomerNote(row.hcp_customer_id, note, intakeNoteMarker(row));
  } catch (e) {
    logIntakeError(row, 'notes_append', e, { note_length: note.length });
    throw new Error(`Could not append intake note to customer ${row.hcp_customer_id}: ${e.message}`);
  }
  return { appended: res.appended };
}

// Send the office notification. Non-fatal: records notify_status and never throws to the caller.
export async function runNotify(pool, row) {
  const recipients = notifyRecipients();
  const inbox = notifyInboxId();
  if (!chatwoot.chatwootConfigured() || !inbox) {
    const why = !inbox ? 'no notify inbox configured' : 'chatwoot not configured';
    await updateDraft(pool, row.id, { notify_status: 'skipped', notify_error: why });
    return { status: 'skipped', results: [] };
  }
  const message = buildNotificationSms(row, {});
  const results = [];
  for (const to of recipients) {
    try {
      const { conversationId } = await chatwoot.ensureConversationForPhone(to, { inboxId: inbox, name: 'Office Notify' });
      const msg = await chatwoot.sendMessage(conversationId, message);
      results.push({ to, ok: true, conversationId, messageId: msg.id });
    } catch (e) {
      results.push({ to, ok: false, error: e.message });
    }
  }
  const anyOk = results.some((r) => r.ok);
  const allOk = results.length > 0 && results.every((r) => r.ok);
  const errText = results.filter((r) => !r.ok).map((r) => `${r.to}: ${r.error}`).join('; ') || null;
  const status = allOk ? 'sent' : (anyOk ? 'partial' : 'failed');
  await updateDraft(pool, row.id, { notify_status: status, notify_error: errText });
  return { status, results };
}

// --- Customer communications: branded SMS + confirmation email ---------------
// Both channels are brand-routed (via src/brands.js), idempotent (skip if already sent), and
// NON-FATAL: they record their own status and never throw into the submit pipeline, so a comms
// failure can never lose or duplicate a successfully created intake.

function intakeFirstName(row) {
  return String(row.first_name || '').trim() || 'there';
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Branded customer SMS. Pure. Deliberately makes no promise about a specific contact time.
export function buildCustomerSms(row = {}, brand = null) {
  const company = (brand && brand.company) || 'our team';
  const first = intakeFirstName(row);
  // Blank lines between each paragraph so the text is easy to read on a phone.
  return [
    `Hello ${first}, thank you for choosing ${company}! We've received your information and will pass it along to one of our estimators, who will be in touch with you.`,
    '',
    '',
    "If you have any photos of the project you'd like us to see, simply reply to this text with them.",
    '',
    '',
    'We look forward to working with you!',
  ].join('\n');
}

// Branded confirmation email (subject + responsive HTML + plain-text fallback). Pure.
export function buildConfirmationEmail(row = {}, brand = null) {
  const company = (brand && brand.company) || 'our team';
  const first = intakeFirstName(row);
  const subject = `We've received your request — ${company}`;

  const text = [
    `Hi ${first},`,
    '',
    `Thank you for contacting ${company}.`,
    '',
    'We\'ve received your project information and will pass it along to one of our estimators. Someone from our team will be in touch with you to discuss your project and next steps.',
    '',
    'Have photos of the project?',
    "We've also sent you a text message from our company phone number. If you have any photos that would help us better understand the project, simply reply to that text message and attach the photos. There's no need to email the photos separately.",
    '',
    'We appreciate the opportunity to help and look forward to working with you.',
    '',
    company,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
        <tr><td style="background:#0f2f21;padding:20px 28px;">
          <div style="color:#ffffff;font-size:18px;font-weight:700;">${escHtml(company)}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#0f2f21;">We've received your request</h1>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Hi ${escHtml(first)},</p>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Thank you for contacting <strong>${escHtml(company)}</strong>. We've received your project information and will pass it along to one of our estimators. Someone from our team will be in touch with you to discuss your project and next steps.</p>
          <div style="margin:18px 0;padding:16px 18px;background:#f0f7f3;border-radius:8px;border:1px solid #d6e7de;">
            <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#0f2f21;">Have photos of the project?</p>
            <p style="margin:0;font-size:14px;line-height:1.6;">We've also sent you a text message from our company phone number. If you have any photos that would help us better understand the project, simply reply to that text message and attach the photos. There's no need to email the photos separately.</p>
          </div>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">We appreciate the opportunity to help and look forward to working with you.</p>
          <p style="margin:18px 0 0;font-size:15px;font-weight:700;color:#0f2f21;">${escHtml(company)}</p>
        </td></tr>
      </table>
      <p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#9aa8b6;line-height:1.5;">This is a confirmation of your request. If you didn't contact ${escHtml(company)}, you can ignore this email.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

// Text the customer a branded confirmation from the correct brand's Chatwoot inbox. Idempotent
// (skips when already sent) and non-fatal. Records the resolved brand + reused/created Chatwoot
// contact/conversation and the send status/timestamp.
export async function runCustomerSms(pool, row) {
  if (row.customer_sms_status === 'sent') return { status: 'sent', skipped: true };

  const brand = resolveBrand(row.customer_tag);
  const phone = normalizePhone(row.phone).e164 || (row.phone ? String(row.phone).trim() : '');
  let status = 'skipped';
  let error = null;
  let contactId = null;
  let conversationId = null;

  if (!brand) error = `no brand configured for tag "${row.customer_tag || ''}"`;
  else if (!brand.inboxId) error = `no Chatwoot inbox configured for ${brand.company}`;
  else if (!chatwoot.chatwootConfigured()) error = 'chatwoot not configured';
  else if (!phone) error = 'no customer phone number';
  else {
    try {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || phone;
      const conv = await chatwoot.ensureConversationForPhone(phone, { inboxId: brand.inboxId, name });
      conversationId = conv.conversationId;
      contactId = conv.contactId;
      await chatwoot.sendMessage(conversationId, buildCustomerSms(row, brand));
      status = 'sent';
    } catch (e) {
      status = 'failed';
      error = e.message;
      logIntakeError(row, 'customer_sms', e, { inbox: brand.inboxId });
    }
  }

  await updateDraft(pool, row.id, {
    resolved_brand: brand ? brand.company : null,
    chatwoot_inbox_id: brand && brand.inboxId ? brand.inboxId : null,
    chatwoot_contact_id: contactId != null ? String(contactId) : null,
    chatwoot_conversation_id: conversationId != null ? String(conversationId) : null,
    customer_sms_status: status,
    customer_sms_at: status === 'sent' ? new Date().toISOString() : null,
    customer_sms_error: error,
  });
  return { status, error, conversationId, contactId };
}

// Email the customer a branded confirmation. Idempotent (skips when already sent) and non-fatal.
export async function runCustomerEmail(pool, row) {
  if (row.customer_email_status === 'sent') return { status: 'sent', skipped: true };

  const brand = resolveBrand(row.customer_tag);
  const to = String(row.email || '').trim();
  let status = 'skipped';
  let error = null;

  if (!brand) error = `no brand configured for tag "${row.customer_tag || ''}"`;
  else if (!isValidEmail(to)) error = 'no valid customer email';
  else if (!email.emailConfigured()) error = 'email not configured';
  else if (!brand.emailFrom) error = `no From address configured for ${brand.company}`;
  else {
    try {
      const msg = buildConfirmationEmail(row, brand);
      const from = `"${brand.company}" <${brand.emailFrom}>`;
      await email.sendEmail({ from, to, replyTo: brand.replyTo, subject: msg.subject, html: msg.html, text: msg.text });
      status = 'sent';
    } catch (e) {
      status = 'failed';
      error = e.message;
      logIntakeError(row, 'customer_email', e);
    }
  }

  await updateDraft(pool, row.id, {
    resolved_brand: brand ? brand.company : (row.resolved_brand || null),
    customer_email_status: status,
    customer_email_at: status === 'sent' ? new Date().toISOString() : null,
    customer_email_error: error,
  });
  return { status, error };
}

export function registerIntakeRoutes(app, pool) {
  // Guard: when the feature flag is off, the whole API returns 404.
  app.use('/api/intake', (req, res, next) => {
    if (!intakeEnabled()) return res.status(404).json({ error: 'Customer Intake is disabled.' });
    next();
  });

  // Non-secret config snapshot for the UI.
  app.get('/api/intake/config', (_req, res) => {
    res.json({
      enabled: intakeEnabled(),
      writeEnabled: intakeWriteEnabled(),
      version: 1,
      statuses: INTAKE_STATUSES,
      notify: { configured: chatwoot.chatwootConfigured(), inbox: Boolean(notifyInboxId()), recipients: notifyRecipients().length },
      comms: { chatwoot: chatwoot.chatwootConfigured(), email: email.emailConfigured(), brands: brandsStatus() },
      googleMapsKey: process.env.GOOGLE_MAPS_KEY || '',
    });
  });

  // Office-staff options — real HCP employees so "Created By" always matches Housecall Pro.
  app.get('/api/intake/staff', async (_req, res) => {
    try {
      res.json({ staff: await listEmployees() });
    } catch (e) {
      res.status(e.status || 502).json({ error: `Could not load HCP staff: ${e.message}` });
    }
  });

  // Create a new draft (optionally stamping the office staff name).
  app.post('/api/intake/drafts', async (req, res) => {
    try {
      const b = req.body || {};
      const createdBy = staffName(req, b.created_by);
      const row = await createDraft(pool, { createdBy, createdById: b.created_by_hcp_id || null });
      res.status(201).json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Fetch a draft by id or public_id.
  app.get('/api/intake/drafts/:id', async (req, res) => {
    try {
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Patch a draft (whitelisted columns + JSONB merge).
  app.patch('/api/intake/drafts/:id', async (req, res) => {
    try {
      const row = await updateDraft(pool, req.params.id, req.body || {});
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Recent drafts (for a future "resume intake" list; handy for testing now).
  app.get('/api/intake/drafts', async (req, res) => {
    try {
      const rows = await listIntakes(pool, { status: req.query.status, limit: req.query.limit });
      res.json({ intakes: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 9: reporting foundation (read-only aggregates over intake_report) ----
  app.get('/api/intake/report', async (_req, res) => {
    try {
      const [byStatus, byEstimates, timing] = await Promise.all([
        pool.query('SELECT status, COUNT(*)::int AS n FROM customer_intakes GROUP BY status ORDER BY n DESC'),
        pool.query("SELECT COALESCE(getting_estimates, '(n/a)') AS getting_estimates, COUNT(*)::int AS n FROM customer_intakes GROUP BY 1 ORDER BY n DESC"),
        pool.query('SELECT ROUND(AVG(minutes_to_submit)::numeric, 1) AS avg_minutes_to_submit, COUNT(*)::int AS completed FROM intake_report WHERE submitted_at IS NOT NULL'),
      ]);
      res.json({
        byStatus: byStatus.rows,
        byGettingEstimates: byEstimates.rows,
        timing: timing.rows[0] || { avg_minutes_to_submit: null, completed: 0 },
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 2: customer lookup + dedupe (read-only against HCP) ----

  // Prioritized search (phone > email > name). Returns matches; never creates anything.
  app.get('/api/intake/lookup', async (req, res) => {
    try {
      const result = await lookupCustomer(req.query, (t) => searchCustomers(t));
      res.json(result);
    } catch (e) {
      res.status(e.status || 502).json({ error: `Customer lookup failed: ${e.message}` });
    }
  });

  // Link a draft to an existing HCP customer (loads their details, blocks duplicate creation).
  app.post('/api/intake/drafts/:id/link-customer', async (req, res) => {
    try {
      const hcpId = (req.body || {}).hcp_customer_id;
      if (!hcpId) return res.status(400).json({ error: 'hcp_customer_id is required.' });
      const customer = await getCustomer(hcpId);
      if (!customer) return res.status(404).json({ error: 'HCP customer not found.' });
      const row = await updateDraft(pool, req.params.id, customerToDraftPatch(customer));
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Mark the draft as a brand-new customer (unlinks any prior match; creation happens in Sprint 4).
  app.post('/api/intake/drafts/:id/new-customer', async (req, res) => {
    try {
      const row = await updateDraft(pool, req.params.id, { hcp_customer_id: null, customer_is_new: true });
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 3: customer info validation (authoritative, server-side) ----

  // Validate the stored draft's customer step (fields + create-vs-reuse decision). Read-only.
  app.get('/api/intake/drafts/:id/customer-status', async (req, res) => {
    try {
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });
      res.json(customerStepStatus(row));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 4: HCP customer create + tag (gated writes) ----

  // Available customer tags (from HCP; read-only).
  app.get('/api/intake/tags', async (_req, res) => {
    try {
      res.json({ tags: await listTags() });
    } catch (e) {
      res.status(e.status || 502).json({ error: `Could not load HCP tags: ${e.message}` });
    }
  });

  // Apply the customer to Housecall Pro: create (if new) or reuse/link an existing record, then tag.
  // dryRun returns the plan without writing. Real writes require INTAKE_WRITE_ENABLED + confirm:true.
  app.post('/api/intake/drafts/:id/apply-customer', async (req, res) => {
    try {
      const b = req.body || {};
      const dryRun = b.dryRun === true || String(req.query.dryRun || '') === '1';
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });

      const tag = b.tag != null ? String(b.tag) : (row.customer_tag || null);
      const working = { ...row, customer_tag: tag };
      const status = customerStepStatus(working);
      if (!status.complete) return res.status(400).json({ error: 'Customer step incomplete.', reasons: status.reasons });

      // Decide the action. For a "new" customer, re-check HCP first (idempotency: reuse a late match).
      let action;
      let payload = null;
      let reuseCustomerId = null;
      if (working.hcp_customer_id) {
        action = 'link-existing';
      } else {
        const lk = await lookupCustomer(working, (t) => searchCustomers(t));
        if (lk.customers && lk.customers.length) { action = 'reuse-found'; reuseCustomerId = lk.customers[0].id; }
        else { action = 'create'; payload = buildCustomerCreatePayload(working); }
      }
      const plan = { action, tag, willApplyTag: Boolean(tag), payload, reuseCustomerId };

      if (dryRun) return res.json({ dryRun: true, writeEnabled: intakeWriteEnabled(), plan });

      // Gate real writes.
      if (!intakeWriteEnabled()) {
        return res.status(403).json({ error: 'HCP writes are disabled (set INTAKE_WRITE_ENABLED=true).', gate: 'writes-disabled', plan });
      }
      if (b.confirm !== true) {
        return res.status(400).json({ error: 'Confirmation required (confirm:true).', plan });
      }

      const r = await ensureCustomer(pool, working, { tag });
      res.json({ ok: true, action: r.action, hcp_customer_id: r.hcp_customer_id, tags: r.tags, row: await getIntake(pool, req.params.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 5: discovery questions (read-only schema + validation) ----

  // Config-driven question schema (drives the UI). Includes the office final-estimate script.
  app.get('/api/intake/discovery-schema', (_req, res) => {
    res.json({ questions: DISCOVERY_QUESTIONS });
  });

  // Validate the stored draft's discovery answers (conditional required honoured).
  app.get('/api/intake/drafts/:id/discovery-status', async (req, res) => {
    try {
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });
      res.json(discoveryStepStatus(row));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 6: estimate placeholder + private notes (gated writes) ----

  // Create the empty estimate placeholder with intake summary injected. dryRun previews the plan;
  // real writes need the gate + confirm. Returns the direct HCP estimate link.
  // Errors at each stage are captured and logged with full context.
  app.post('/api/intake/drafts/:id/apply-estimate', async (req, res) => {
    try {
      const b = req.body || {};
      const dryRun = b.dryRun === true || String(req.query.dryRun || '') === '1';
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });
      if (!row.hcp_customer_id) return res.status(400).json({ error: 'Apply the customer to Housecall Pro first.' });

      const disc = discoveryStepStatus(row);
      if (!disc.complete) return res.status(400).json({ error: 'Discovery incomplete.', reasons: disc.reasons });

      const note = buildIntakeNote(row);
      const plan = { willCreateEstimate: !row.hcp_estimate_id, willAppendNote: true, notePreview: note };
      if (dryRun) return res.json({ dryRun: true, writeEnabled: intakeWriteEnabled(), plan });

      if (!intakeWriteEnabled()) return res.status(403).json({ error: 'HCP writes are disabled (set INTAKE_WRITE_ENABLED=true).', gate: 'writes-disabled', plan });
      if (b.confirm !== true) return res.status(400).json({ error: 'Confirmation required (confirm:true).', plan });

      let est;
      try {
        est = await ensureEstimate(pool, row);
      } catch (e) {
        logIntakeError(row, 'apply_estimate_ensure', e);
        return res.status(502).json({ error: `Estimate creation failed: ${e.message}`, stage: 'estimate', details: e.body });
      }

      let notes;
      try {
        notes = await ensureNotes(pool, row);
      } catch (e) {
        logIntakeError(row, 'apply_estimate_notes', e, { estimate_created: true });
        // Log but don't fail: notes are informational, not critical. Estimate already created.
        notes = { appended: false };
      }

      let estimateUrl;
      try {
        estimateUrl = buildEstimateUrl(est.estimate_option_id);
        if (!estimateUrl) throw new Error('Failed to build estimate URL from option_id');
      } catch (e) {
        logIntakeError(row, 'apply_estimate_url', e, { option_id: est.estimate_option_id });
        // Log but include partial success: estimate was created, just can't deep-link yet.
        estimateUrl = null;
      }

      const updated = await getIntake(pool, req.params.id);
      res.json({
        ok: true,
        hcp_estimate_id: est.estimate_id,
        hcp_estimate_option_id: est.estimate_option_id,
        estimate_number: est.estimate_number,
        estimate_url: estimateUrl,
        note_appended: notes.appended,
        row: updated,
      });
    } catch (e) {
      const row = await getIntake(pool, req.params.id).catch(() => null);
      logIntakeError(row, 'apply_estimate_outer', e);
      res.status(e.status || 500).json({ error: `Estimate apply failed: ${e.message}`, stage: 'unknown' });
    }
  });

  // --- Sprint 7: SMS notification via Chatwoot (gated writes) ----

  // Notify the office (Neil) about a new intake. dryRun previews recipients + message; a real send
  // needs the write gate + confirm, and posts an outgoing Chatwoot message (delivered by n8n/Telnyx).
  app.post('/api/intake/drafts/:id/notify', async (req, res) => {
    try {
      const b = req.body || {};
      const dryRun = b.dryRun === true || String(req.query.dryRun || '') === '1';
      const row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });

      const recipients = notifyRecipients();
      const message = buildNotificationSms(row, {});
      const plan = { recipients, message, chatwootConfigured: chatwoot.chatwootConfigured(), inboxConfigured: Boolean(notifyInboxId()) };
      if (dryRun) return res.json({ dryRun: true, writeEnabled: intakeWriteEnabled(), plan });

      if (!intakeWriteEnabled()) return res.status(403).json({ error: 'HCP/SMS writes are disabled (set INTAKE_WRITE_ENABLED=true).', gate: 'writes-disabled', plan });
      if (b.confirm !== true) return res.status(400).json({ error: 'Confirmation required (confirm:true).', plan });
      if (!chatwoot.chatwootConfigured()) return res.status(400).json({ error: 'Chatwoot is not configured.' });
      if (!notifyInboxId()) return res.status(400).json({ error: 'Set INTAKE_NOTIFY_INBOX_ID to an SMS-capable Chatwoot inbox.' });

      const out = await runNotify(pool, row);
      res.json({ ok: out.status !== 'failed', status: out.status, results: out.results, row: await getIntake(pool, req.params.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- Sprint 8: submit orchestration (gated, idempotent, partial-failure aware) ----

  // Run the whole intake to HCP in order: customer -> tag -> estimate -> notes -> SMS.
  // Idempotent (reuses existing ids/marker), guards against double-submit, and records completed/failed.
  app.post('/api/intake/drafts/:id/submit', async (req, res) => {
    try {
      const b = req.body || {};
      const dryRun = b.dryRun === true || String(req.query.dryRun || '') === '1';
      let row = await getIntake(pool, req.params.id);
      if (!row) return res.status(404).json({ error: 'Intake draft not found' });

      const cs = customerStepStatus(row);
      const ds = discoveryStepStatus(row);
      if (!cs.complete || !ds.complete) {
        return res.status(400).json({ error: 'Intake incomplete.', reasons: [...cs.reasons, ...ds.reasons] });
      }

      const plan = {
        customer: row.hcp_customer_id ? 'link-existing' : 'create-or-reuse',
        tag: row.customer_tag || null,
        estimate: row.hcp_estimate_id ? 'exists' : 'create',
        notes: 'append',
        sms: { recipients: notifyRecipients(), ready: chatwoot.chatwootConfigured() && Boolean(notifyInboxId()) },
        customerComms: (() => {
          const brand = resolveBrand(row.customer_tag);
          return {
            brand: brand ? brand.company : null,
            sms: Boolean(brand && brand.inboxId && chatwoot.chatwootConfigured() && (row.customer_sms_status !== 'sent')),
            email: Boolean(brand && brand.emailFrom && email.emailConfigured() && (row.customer_email_status !== 'sent')),
          };
        })(),
      };
      if (dryRun) return res.json({ dryRun: true, writeEnabled: intakeWriteEnabled(), status: row.status, plan });

      if (!intakeWriteEnabled()) return res.status(403).json({ error: 'HCP/SMS writes are disabled (set INTAKE_WRITE_ENABLED=true).', gate: 'writes-disabled', plan });
      if (b.confirm !== true) return res.status(400).json({ error: 'Confirmation required (confirm:true).', plan });

      // Idempotent double-submit guard.
      if (row.status === 'completed') return res.json({ ok: true, alreadyCompleted: true, status: 'completed', row });
      const claim = await pool.query(
        `UPDATE customer_intakes SET status = 'submitting', updated_at = NOW() WHERE id = $1 AND status <> 'submitting' RETURNING id`,
        [row.id],
      );
      if (!claim.rowCount) return res.status(409).json({ error: 'A submit is already in progress for this intake.' });

      const steps = [];
      try {
        const c = await ensureCustomer(pool, row, { tag: row.customer_tag || null });
        steps.push({ step: 'customer', ok: true, ...c });
        row = await getIntake(pool, row.id);

        const e = await ensureEstimate(pool, row);
        steps.push({ step: 'estimate', ok: true, ...e });
        row = await getIntake(pool, row.id);

        const n = await ensureNotes(pool, row);
        steps.push({ step: 'notes', ok: true, ...n });

        // SMS is non-fatal: a failed notification must not fail a completed intake.
        const s = await runNotify(pool, row);
        steps.push({ step: 'sms', ok: s.status !== 'failed', status: s.status, results: s.results });
        row = await getIntake(pool, row.id);

        // Branded customer communications — both non-fatal and idempotent (skip if already sent).
        const csms = await runCustomerSms(pool, row);
        steps.push({ step: 'customer_sms', ok: csms.status !== 'failed', status: csms.status });
        row = await getIntake(pool, row.id);

        const cemail = await runCustomerEmail(pool, row);
        steps.push({ step: 'customer_email', ok: cemail.status !== 'failed', status: cemail.status });

        await pool.query(`UPDATE customer_intakes SET status = 'completed', submitted_at = NOW(), error = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
        res.json({ ok: true, status: 'completed', steps, row: await getIntake(pool, row.id) });
      } catch (stepErr) {
        // A required step failed: mark failed and return partial progress (safe to re-submit — completed
        // steps are skipped via the already-set ids/marker).
        await pool.query(`UPDATE customer_intakes SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [row.id, stepErr.message]);
        steps.push({ step: 'error', ok: false, error: stepErr.message });
        res.status(500).json({ ok: false, status: 'failed', steps, error: stepErr.message, row: await getIntake(pool, row.id) });
      }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}
