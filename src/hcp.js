// Minimal Housecall Pro API client for the estimate builder.
// Auth: Authorization: Token <api_key>  (NOTE: prefix is "Token", not Bearer).

const BASE = 'https://api.housecallpro.com';

const MONEY_IN_CENTS = String(process.env.HCP_MONEY_IN_CENTS ?? 'true') === 'true';

function authHeaders() {
  const key = process.env.HCP_API_KEY;
  if (!key) throw new Error('HCP_API_KEY is not set. Copy .env.example to .env and fill it in.');
  return { Authorization: `Token ${key}`, accept: 'application/json' };
}

// Convert a dollar amount (what humans type in the sheet) to the unit HCP expects.
export function toApiMoney(dollars) {
  const n = Number(dollars) || 0;
  return MONEY_IN_CENTS ? Math.round(n * 100) : n;
}

// HCP line-item `kind` enum (verified: an unknown kind like 'service' is silently
// coerced to 'labor' by HCP). The Studio model uses 'service'/'material'; map them
// to the values HCP actually accepts so the kind isn't lost on the pushed estimate.
const HCP_KINDS = new Set(['labor', 'materials', 'discount', 'tax']);
const KIND_MAP = { service: 'labor', material: 'materials', materials: 'materials', labor: 'labor', discount: 'discount', tax: 'tax' };
export function toApiKind(kind) {
  const k = String(kind || '').toLowerCase().trim();
  return KIND_MAP[k] || (HCP_KINDS.has(k) ? k : 'labor');
}

// HCP's create line-item payload has no cadence field, so recurring frequency is
// otherwise lost. We append the cadence to the line-item name (per-visit price kept)
// so the customer-facing estimate reads e.g. "Lawn Mowing (Weekly)".
const FREQUENCY_LABELS = {
  weekly: 'Weekly', 'bi-weekly': 'Bi-weekly', 'twice-monthly': 'Twice a month',
  monthly: 'Monthly', quarterly: 'Quarterly', 'every-6-months': 'Every 6 months', annually: 'Annually',
};
function cadenceSuffix(frequency) {
  const label = FREQUENCY_LABELS[String(frequency || '').toLowerCase()];
  return label ? ` (${label})` : '';
}

// Map a Studio line item to the HCP create line-item shape.
// IMPORTANT: flat / measurement priced items carry their dollar value in
// `flatAmount` (the Studio sets `unitPrice` to 0 for those modes). Reading only
// `unitPrice` would push those line items to HCP at $0.00.
function toApiLineItem(li) {
  const isFlat = String(li.pricingMode || '') === 'flat';
  const dollars = isFlat ? li.flatAmount : li.unitPrice;
  const quantity = isFlat ? 1 : li.quantity;
  return {
    name: `${li.name}${cadenceSuffix(li.frequency)}`,
    description: li.description || undefined,
    quantity,
    unit_of_measure: li.unitOfMeasure || li.unit_of_measure || undefined,
    unit_price: toApiMoney(dollars),
    kind: toApiKind(li.kind),
    taxable: li.taxable,
  };
}

// Build the nested HCP create-estimate request body from Studio options.
function buildEstimateBody({ customerId, addressId, serviceAddressId, billingAddressId, options }) {
  const body = {
    customer_id: customerId,
    address_id: serviceAddressId || addressId || billingAddressId,
    options: options.map((opt) => ({
      name: opt.name,
      message_from_pro: opt.message || undefined,
      line_items: (opt.lineItems || []).map((li) => toApiLineItem(li)),
    })),
  };
  if (serviceAddressId) body.service_address_id = serviceAddressId;
  if (billingAddressId) body.billing_address_id = billingAddressId;
  return body;
}

async function hcp(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || res.statusText;
    const err = new Error(`HCP ${method} ${path} -> ${res.status} ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export { hcp };

// --- Customers ---------------------------------------------------------------

export async function searchCustomers(q, { pageSize = 15 } = {}) {
  const data = await hcp(`/customers?q=${encodeURIComponent(q)}&page_size=${pageSize}`);
  const customers = data.customers || [];
  return customers.map(simplifyCustomer);
}

export async function getCustomer(id) {
  const c = await hcp(`/customers/${encodeURIComponent(id)}`);
  return simplifyCustomer(c);
}

function simplifyCustomer(c) {
  return {
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '(no name)',
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    email: c.email || null,
    mobile: c.mobile_number || c.home_number || c.work_number || null,
    company: c.company || null,
    addresses: (c.addresses || []).map((a) => ({
      id: a.id,
      type: a.type,
      street: a.street || null,
      unit: a.street_line_2 || null,
      city: a.city || null,
      state: a.state || null,
      zip: a.zip || null,
      line: [a.street, a.street_line_2, a.city, a.state, a.zip].filter(Boolean).join(', '),
    })),
  };
}

// --- Employees ---------------------------------------------------------------
// Used to attribute an intake to a real HCP user (dropdown, not free text), so
// "Created By" always matches Housecall Pro and can drive per-staff reporting.

function simplifyEmployee(e) {
  return {
    id: e.id,
    name: [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || '(no name)',
    role: e.role || null,
    active: e.active !== false,
  };
}

// Return all employees (paging through HCP), simplified. Optionally keep active only.
export async function listEmployees({ activeOnly = true, pageSize = 100, maxPages = 20 } = {}) {
  const out = [];
  let page = 1;
  for (; page <= maxPages; page += 1) {
    const data = await hcp(`/employees?page=${page}&page_size=${pageSize}`);
    const batch = (data.employees || []).map(simplifyEmployee);
    out.push(...batch);
    const totalPages = Number(data.total_pages || 1);
    if (page >= totalPages) break;
  }
  const list = activeOnly ? out.filter((e) => e.active) : out;
  // Office staff first (they take intakes), then everyone else; alphabetical within each.
  return list.sort((a, b) => {
    const ao = /office/i.test(a.role || '') ? 0 : 1;
    const bo = /office/i.test(b.role || '') ? 0 : 1;
    return ao - bo || a.name.localeCompare(b.name);
  });
}

// --- Tags --------------------------------------------------------------------
export async function listTags({ pageSize = 100, maxPages = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await hcp(`/tags?page=${page}&page_size=${pageSize}`);
    out.push(...(data.tags || []));
    if (page >= Number(data.total_pages || 1)) break;
  }
  return out.map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
}

// Merge a tag name into an existing tag-name array (idempotent). Pure.
export function unionTags(existing, name) {
  const tags = Array.isArray(existing) ? existing.slice() : [];
  if (name && !tags.includes(name)) tags.push(name);
  return tags;
}

// --- Customer create + tag application (WRITES) ------------------------------
export async function createCustomer(payload) {
  const created = await hcp('/customers', { method: 'POST', body: payload });
  return simplifyCustomer(created);
}

// Apply a tag by name to an existing customer: read current tags, union, write back.
export async function applyCustomerTag(customerId, tagName) {
  const current = await hcp(`/customers/${encodeURIComponent(customerId)}`);
  const tags = unionTags(current.tags, tagName);
  const updated = await hcp(`/customers/${encodeURIComponent(customerId)}`, { method: 'PUT', body: { tags } });
  return updated.tags || tags;
}

// Append text to a customer's private notes (HCP customer.notes), never overwriting existing content.
// `marker` makes the append idempotent: if the current notes already contain it, we skip the write.
export async function appendCustomerNote(customerId, noteText, marker) {
  const current = await hcp(`/customers/${encodeURIComponent(customerId)}`);
  const existing = typeof current.notes === 'string' ? current.notes : '';
  if (marker && existing.includes(marker)) return { appended: false, notes: existing };
  const combined = existing.trim() ? `${existing.trimEnd()}\n\n${noteText}` : noteText;
  const updated = await hcp(`/customers/${encodeURIComponent(customerId)}`, { method: 'PUT', body: { notes: combined } });
  return { appended: true, notes: (typeof updated.notes === 'string' ? updated.notes : combined) };
}

// Create an estimate with the intake summary injected as a line item. The summary renders as a
// $0 labor item so it's visible to the estimator/crew (the line items section, not a separate
// "Summary of Work" block). Returns the option id as well: the HCP web app deep-links to an
// estimate by OPTION id, not by the estimate (csr_...) id, so callers need it to build a working link.
export async function createEmptyEstimate({ customerId, addressId, optionName = 'Estimate', summary = null }) {
  const lineItems = [];
  if (summary) {
    lineItems.push({
      name: 'Customer Intake Summary',
      description: summary,
      quantity: 1,
      unit_price: 0,
      kind: 'labor',
      taxable: false,
    });
  }
  const body = { customer_id: customerId, options: [{ name: optionName, line_items: lineItems }] };
  if (addressId) body.address_id = addressId;
  const est = await hcp('/estimates', { method: 'POST', body });
  const firstOption = (est.options || [])[0] || null;
  return {
    id: est.id,
    estimate_number: est.estimate_number,
    option_id: firstOption ? firstOption.id : null,
  };
}

// --- Estimates ---------------------------------------------------------------
// HCP structure is nested: Estimate -> Options[] -> Line Items[].
// NOTE: the exact create payload is verified against the live API before the
// first real push (see scripts in README). createEstimate stages the calls so
// each level maps to its REST sub-resource.

export function buildCreatePlan({ customerId, addressId, serviceAddressId, billingAddressId, options }) {
  // HCP requires options and line_items in the initial estimate create payload.
  const body = buildEstimateBody({ customerId, addressId, serviceAddressId, billingAddressId, options });

  return [{
    step: 'create-estimate',
    method: 'POST',
    path: '/estimates',
    body,
  }];
}

export async function createEstimate({ customerId, addressId, serviceAddressId, billingAddressId, options }) {
  const body = buildEstimateBody({ customerId, addressId, serviceAddressId, billingAddressId, options });

  const estimate = await hcp('/estimates', {
    method: 'POST',
    body,
  });
  const createdOptions = (estimate.options || []).map((opt) => ({ id: opt.id, name: opt.name }));

  return {
    id: estimate.id,
    estimate_number: estimate.estimate_number,
    options: createdOptions,
  };
}

// Push an already-finalized HCP create body (as reviewed/edited in the preview modal)
// straight to HCP without re-deriving it from Studio options. The body is expected to be
// the exact { customer_id, address_id, options:[{ name, message_from_pro, line_items[] }] }
// shape that buildEstimateBody produces; unit_price stays in the units HCP expects (cents).
export async function createEstimateFromBody(body) {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('A Housecall Pro estimate body is required.'), { status: 400 });
  }
  if (!body.customer_id) throw Object.assign(new Error('customer_id is required.'), { status: 400 });
  if (!body.address_id) throw Object.assign(new Error('address_id is required.'), { status: 400 });
  if (!Array.isArray(body.options) || !body.options.length) {
    throw Object.assign(new Error('At least one option is required.'), { status: 400 });
  }

  const estimate = await hcp('/estimates', { method: 'POST', body });
  const createdOptions = (estimate.options || []).map((opt) => ({ id: opt.id, name: opt.name }));

  return {
    id: estimate.id,
    estimate_number: estimate.estimate_number,
    options: createdOptions,
  };
}

// Fetch recent estimates for a customer.
export async function listEstimatesByCustomer(customerId, { limit = 10 } = {}) {
  const data = await hcp(`/estimates?page=1&page_size=${limit}`);
  const estimates = (data.estimates || []).filter((e) => e.customer && e.customer.id === customerId);
  return estimates.slice(0, limit).map((e) => ({
    id: e.id,
    estimate_number: e.estimate_number,
    address: e.address ? `${e.address.street}, ${e.address.city}` : '',
    options: (e.options || []).map((o) => ({ id: o.id, name: o.name, total: o.total_amount })),
    total: (e.options || []).reduce((s, o) => s + (o.total_amount || 0), 0),
  }));
}

// Fetch a single estimate by ID and convert to options for re-use.
export async function getEstimateForDuplication(estimateId) {
  const e = await hcp(`/estimates/${encodeURIComponent(estimateId)}`);
  if (!e || !e.options || !e.options.length) return null;

  const options = [];
  for (const opt of e.options) {
    const lineItems = opt.line_items || [];
    const lines = lineItems.map((li) => ({
      name: li.name,
      description: li.description || '',
      quantity: li.quantity || 1,
      unitOfMeasure: li.unit_of_measure || '',
      frequency: 'single',
      unitPrice: MONEY_IN_CENTS ? Math.floor((li.unit_price || 0) / 100) : (li.unit_price || 0),
      pricingMode: 'calculated',
      flatAmount: 0,
      kind: li.kind || 'labor',
      taxable: li.taxable || false,
      notes: '',
    }));
    options.push({
      name: opt.name || `Option ${options.length + 1}`,
      message: opt.message_from_pro || null,
      lineItems: lines,
    });
  }

  return options;
}
