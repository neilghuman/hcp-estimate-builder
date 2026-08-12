// ScopeFoundry Studio — three-pane master/detail estimate workspace.
// Frontend-only. Reuses existing backend endpoints. No backend changes.

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const toNumber = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : d;
};
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => `s_${Math.random().toString(36).slice(2, 9)}`;

const FREQUENCY_OPTIONS = [
  { value: 'single', label: 'Single (one-time)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'bi-weekly', label: 'Bi-weekly' },
  { value: 'twice-monthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'every-6-months', label: 'Every 6 months' },
  { value: 'annually', label: 'Annually' },
];
const RECURRING_PER_MONTH = {
  weekly: 4.33, 'bi-weekly': 2.17, 'twice-monthly': 2, monthly: 1,
  quarterly: 1 / 3, 'every-6-months': 1 / 6, annually: 1 / 12,
};
const PRICING_MODES = [
  { value: 'calculated', label: 'Calculated (Qty × Unit)' },
  { value: 'flat', label: 'Flat rate' },
  { value: 'measurement', label: 'By measurement (Base + Sqft × Mult)' },
];
const KINDS = ['labor', 'material', 'service', 'discount', 'tax'];
// Map any external/HCP kind vocabulary (e.g. HCP's plural 'materials', pricebook synonyms)
// onto the canonical studio KINDS so pre-flight never false-blocks an import. Unknown -> 'service'.
function normalizeKind(k) {
  const s = String(k || '').trim().toLowerCase();
  const MAP = {
    materials: 'material', material: 'material',
    product: 'material', products: 'material', equipment: 'material', part: 'material', parts: 'material',
    labor: 'labor', service: 'service', services: 'service',
    discount: 'discount', tax: 'tax',
  };
  return MAP[s] || (KINDS.includes(s) ? s : 'service');
}
// Friendlier labels for the Housecall Pro line-type toggle. Both 'service' and 'labor'
// land as HCP 'labor'; 'material' lands as HCP 'materials' (see toApiKind in src/hcp.js).
const KIND_LABELS = { service: 'Service (Labor)', labor: 'Labor', material: 'Materials', discount: 'Discount', tax: 'Tax' };
// Line-type options shown in the Pricing-tab toggle. Service -> HCP labor, Materials -> HCP materials.
const KIND_TOGGLE = ['service', 'material'];
const UNITS = ['', 'ea', 'visit', 'job', 'application', 'sq ft', 'ft', 'lf', 'hr', 'day', 'yd', 'cu yd'];
const DIVISIONS = ['Washington Tree Services', 'Washington Landscaping', 'Washington Roofing', 'Washington Construction', 'Washington Pressure Washing', 'Washington Snow Removal', 'Washington Firewood'];

// User-added unit-of-measure / frequency options (persisted, merged with the built-ins above).
const LS_CUSTOM_UNITS = 'studioCustomUnits';
const LS_CUSTOM_FREQ = 'studioCustomFreq';
function loadCustomList(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }
let customUnits = loadCustomList(LS_CUSTOM_UNITS); // ['linear ft', ...]
let customFreqs = loadCustomList(LS_CUSTOM_FREQ);  // [{ value, label }, ...]
function allUnits() {
  const seen = new Set(); const out = [];
  for (const u of [...UNITS, ...customUnits]) { const k = String(u); if (seen.has(k)) continue; seen.add(k); out.push(u); }
  return out;
}
function allFrequencies() {
  const seen = new Set(); const out = [];
  for (const o of [...FREQUENCY_OPTIONS, ...customFreqs]) { if (!o || seen.has(o.value)) continue; seen.add(o.value); out.push(o); }
  return out;
}
function addCustomUnit(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (!allUnits().some((u) => String(u).toLowerCase() === v.toLowerCase())) {
    customUnits.push(v);
    localStorage.setItem(LS_CUSTOM_UNITS, JSON.stringify(customUnits));
  }
  return v;
}
function addCustomFrequency(raw) {
  const label = String(raw || '').trim();
  if (!label) return null;
  const value = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!value) return null;
  if (!allFrequencies().some((o) => o.value === value)) {
    customFreqs.push({ value, label });
    localStorage.setItem(LS_CUSTOM_FREQ, JSON.stringify(customFreqs));
  }
  return value;
}

// Human-readable expansion of a unit-of-measure code (for the chip shown next to Quantity etc.).
// Custom units (anything not in this map) display exactly as the user typed them.
const UNIT_WORDS = {
  ea: 'each', visit: 'visit', job: 'job', application: 'application',
  'sq ft': 'square feet', ft: 'feet', hr: 'hour', day: 'day',
  yd: 'yards', 'cu yd': 'cubic yards', lf: 'linear feet',
};
function unitWords(u) {
  const key = String(u || '').trim();
  if (!key) return '';
  return UNIT_WORDS[key.toLowerCase()] || key;
}
// Singular form for "cost per <unit>" verbiage on Unit Price.
const UNIT_WORDS_SINGULAR = {
  ea: 'each', visit: 'visit', job: 'job', application: 'application',
  'sq ft': 'square foot', ft: 'foot', hr: 'hour', day: 'day',
  yd: 'yard', 'cu yd': 'cubic yard', lf: 'linear foot',
};
function unitWordsSingular(u) {
  const key = String(u || '').trim();
  if (!key) return '';
  return UNIT_WORDS_SINGULAR[key.toLowerCase()] || key;
}
// Customer-facing "5 linear feet × $20.00 / linear foot" summary; calculated mode + unit set only.
function qtyUnitLabel(s) {
  if (String(s.pricingMode || 'calculated') !== 'calculated') return '';
  const uw = unitWords(s.unitOfMeasure);
  if (!uw) return '';
  const qty = `${toNumber(s.quantity, 0)} ${uw}`;
  const price = toNumber(s.unitPrice, 0);
  const sing = unitWordsSingular(s.unitOfMeasure);
  return price > 0 ? `${qty} × ${money(price)} / ${sing}` : qty;
}
// Dimensional units that warrant a measurement in the HCP service name (count-style
// units like visit/job/application/each are excluded — they'd just be noise).
const MEASURE_UNITS = new Set(['sq ft', 'ft', 'yd', 'cu yd', 'lf']);
function commaNum(n) { return toNumber(n, 0).toLocaleString('en-US'); }
// Build the " — 800 linear feet" measurement segment for the HCP service name.
// Returns '' when there's no meaningful measurement to show.
function measureNameSegment(s) {
  const mode = String(s.pricingMode || 'calculated');
  let qty = 0;
  let unit = '';
  if (mode === 'measurement') {
    qty = measurementValue(s);
    const mt = MEASURE_TYPES.find((m) => m.value === s.measureType);
    unit = mt ? mt.unit : '';
  } else if (mode === 'calculated') {
    qty = toNumber(s.quantity, 0);
    unit = s.unitOfMeasure;
    if (!MEASURE_UNITS.has(String(unit || '').toLowerCase()) || qty <= 1) return '';
  } else {
    return ''; // flat: lump sum, no measurement to show
  }
  const uw = unitWords(unit);
  if (!uw || qty <= 0) return '';
  return ` — ${commaNum(qty)} ${uw}`;
}
// Compose the customer-facing HCP line-item description (Layout A): polished customer
// description first, then exclusions and recommendations as labeled sections. Falls back
// to the internal AI-hints `description` only when no customerDescription exists, so the
// internal hints box never leaks when a real description is present.
function hcpLineDescription(s) {
  const parts = [];
  const body = String(s.customerDescription || s.description || '').trim();
  if (body) parts.push(body);
  const excl = String(s.exclusions || '').trim();
  if (excl) parts.push(`Not included: ${excl}`);
  const recs = String(s.recommendations || '').trim();
  if (recs) parts.push(`Recommendations: ${recs}`);
  return parts.join('\n\n');
}
const MEASURE_TYPES = [
  { value: '', label: '(none)', unit: '' },
  { value: 'turf', label: 'Turf (sq ft)', unit: 'sq ft' },
  { value: 'concrete', label: 'Concrete (sq ft)', unit: 'sq ft' },
  { value: 'roof', label: 'Roof (sq ft)', unit: 'sq ft' },
  { value: 'fence', label: 'Fence (linear ft)', unit: 'lf' },
  { value: 'gutter', label: 'Gutter (linear ft)', unit: 'lf' },
];

// ---------- state ----------
const SHARED_FIELDS = ['name', 'description', 'customerDescription', 'exclusions', 'category', 'tags', 'division', 'unitOfMeasure', 'kind', 'minCharge', 'maxCharge', 'calcMethod', 'internalNotes', 'crewNotes', 'estimatorNotes', 'hcpNotes', 'aiNotes', 'recommendations'];
const NUMERIC_FIELDS = ['quantity', 'unitPrice', 'flatAmount', 'basePrice', 'multiplier', 'minCharge', 'maxCharge'];

// Backend (price book / AI service) field keys -> studio service field keys.
const AI_FIELD_MAP = {
  description: 'description',
  category: 'category',
  tags: 'tags',
  internal_notes: 'internalNotes',
  crew_notes: 'crewNotes',
  estimator_notes: 'estimatorNotes',
  hcp_notes: 'hcpNotes',
  ai_scope_notes: 'aiNotes',
  exclusions: 'exclusions',
  customer_description: 'customerDescription',
  recommendations: 'recommendations',
};
// Transient AI-enrichment state per working-service id: QA scores, status, and pending suggestions.
const aiRuns = new Map();
// Active bulk-generation state (whole active package). currentId marks the row in flight.
let bulkState = { active: false, mode: null, total: 0, done: 0, currentId: null };

const state = {
  estimateName: 'Lawn Care Starter',
  division: 'Washington Landscaping',
  measurements: { turf: 8500, concrete: 1200, roof: 2400, fence: 300, gutter: 180 },
  serviceLibrary: [],      // canonical, reusable service definitions (first-class)
  templates: [],           // saved templates: snapshots of packages
  activeTemplateId: null,  // template this estimate is based on (null = ad-hoc)
  packages: [],            // working packages; each: { id, name, message, inheritsFrom, services:[own only] }
  namingScheme: 'gbb',     // package naming: 'gbb' (Good/Better/Best) | 'option' (Option #1, #2, #3)
  activePackageId: null,
  activeServiceId: null,
  activeTab: 'pricing',
  view: 'build',           // 'build' | 'compare'
  customer: null,
  serviceAddressId: null,
  billingAddressId: null,
  importSource: null,
  draftId: null,          // server-side studio_drafts.id when this estimate is an opened/saved draft
  hcpEstimate: null,      // { id, number, options, pushedAt } once pushed to Housecall Pro
};

// Full line-item model. Extended fields are studio-only and stripped before submit.
function makeService(overrides = {}) {
  const s = {
    id: uid(),
    libraryId: '',          // link to a Service Library entry (first-class services)
    name: '', description: '', customerDescription: '', exclusions: '',
    category: '', tags: '', division: '',
    unitOfMeasure: '', frequency: 'single', quantity: 1,
    unitPrice: 0, pricingMode: 'calculated', flatAmount: 0,
    measureType: '', basePrice: 0, multiplier: 0,
    minCharge: 0, maxCharge: 0, calcMethod: 'standard',
    internalNotes: '', crewNotes: '', estimatorNotes: '', hcpNotes: '', aiNotes: '',
    recommendations: '',
    kind: 'service', taxable: true,
    pricebookId: '', externalId: '', importSource: '',
    createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
    notes: '', // legacy combined notes used by backend
    ...overrides,
  };
  // Canonicalize kind so HCP/pricebook vocabulary (e.g. plural 'materials') can't trip pre-flight.
  s.kind = normalizeKind(s.kind);
  return s;
}

// ---------- persistence (library + templates only; frontend-only prototype) ----------
const LS_KEY = 'scopefoundry-studio-v1';
const LS_SCHEMA = 4; // bump when the persisted shape changes; migrateStore() upgrades older data
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ schemaVersion: LS_SCHEMA, serviceLibrary: state.serviceLibrary, templates: state.templates })); } catch (_) { /* ignore */ }
}
function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const data = migrateStore(raw);
    if (Array.isArray(data.serviceLibrary)) state.serviceLibrary = data.serviceLibrary;
    if (Array.isArray(data.templates)) state.templates = data.templates;
  } catch (_) { /* ignore */ }
}
// Upgrade any older persisted shape to the current schema. Never throws; always returns a usable object.
function migrateStore(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const from = Number(data.schemaVersion) || 1;
  if (from >= LS_SCHEMA) return data;
  const lib = Array.isArray(data.serviceLibrary) ? data.serviceLibrary : [];
  const tpls = Array.isArray(data.templates) ? data.templates : [];
  // v1 -> v2: backfill library measurement defaults + template versioning fields, and ensure stable libraryIds.
  lib.forEach((l) => {
    if (l.defaultMeasureType === undefined) l.defaultMeasureType = '';
    if (l.defaultBasePrice === undefined) l.defaultBasePrice = 0;
    if (l.defaultMultiplier === undefined) l.defaultMultiplier = 0;
    // v2 -> v3: align with price book — exclusions is now a first-class field.
    if (l.exclusions === undefined) l.exclusions = '';
    // v3 -> v4: customer-facing recommendations from the AI enrichment pipeline.
    if (l.recommendations === undefined) l.recommendations = '';
  });
  tpls.forEach((t) => {
    if (!t.baseName) t.baseName = t.name || 'Template';
    if (!t.version) t.version = 1;
    if (!t.name) t.name = `${t.baseName} v${t.version}`;
    (t.packages || []).forEach((p) => (p.services || []).forEach((s) => {
      if (s.division === undefined) s.division = '';
      if (s.measureType === undefined) s.measureType = '';
      if (s.basePrice === undefined) s.basePrice = 0;
      if (s.multiplier === undefined) s.multiplier = 0;
      if (s.exclusions === undefined) s.exclusions = '';
      if (s.recommendations === undefined) s.recommendations = '';
    }));
  });
  return { schemaVersion: LS_SCHEMA, serviceLibrary: lib, templates: tpls };
}
// Guarantee every working service has a stable definition id (libraryId) so inheritance/overrides
// never fall back to fragile name matching. Safe to call repeatedly.
function ensureLibraryIds() {
  state.packages.forEach((p) => p.services.forEach((s) => { if (!s.libraryId || !libGet(s.libraryId)) libUpsertFromService(s); }));
}


// ---------- service library (first-class) ----------
function pickShared(s) { const o = {}; SHARED_FIELDS.forEach((f) => { o[f] = s[f]; }); return o; }
function libGet(id) { return state.serviceLibrary.find((l) => l.id === id) || null; }
function libUpsertFromService(s) {
  if (s.libraryId && libGet(s.libraryId)) return s.libraryId;
  let lib = s.name ? state.serviceLibrary.find((l) => l.name.trim().toLowerCase() === String(s.name).trim().toLowerCase()) : null;
  if (!lib) {
    lib = {
      id: uid(), ...pickShared(s),
      defaultUnitPrice: toNumber(s.unitPrice, 0), defaultFrequency: s.frequency || 'single',
      defaultPricingMode: s.pricingMode || 'calculated', defaultFlatAmount: toNumber(s.flatAmount, 0),
      defaultMeasureType: s.measureType || '', defaultBasePrice: toNumber(s.basePrice, 0), defaultMultiplier: toNumber(s.multiplier, 0),
      defaultTaxable: Boolean(s.taxable),
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
    };
    state.serviceLibrary.push(lib);
  }
  s.libraryId = lib.id;
  return lib.id;
}
function libUsageCount(libraryId) {
  let n = 0;
  state.packages.forEach((p) => p.services.forEach((s) => { if (s.libraryId === libraryId) n += 1; }));
  state.templates.forEach((t) => (t.packages || []).forEach((p) => (p.services || []).forEach((s) => { if (s.libraryId === libraryId) n += 1; })));
  return n;
}
// Edit a shared field once -> update the library entry and every linked service everywhere.
function propagateShared(libraryId, field, value) {
  const lib = libGet(libraryId);
  if (lib) { lib[field] = value; lib.modifiedAt = new Date().toISOString(); }
  const apply = (s) => { if (s.libraryId === libraryId) s[field] = value; };
  state.packages.forEach((p) => p.services.forEach(apply));
  state.templates.forEach((t) => (t.packages || []).forEach((p) => (p.services || []).forEach(apply)));
}

// ---------- inheritance (packages inherit services from a parent) ----------
function getPackage(id) { return state.packages.find((p) => p.id === id) || null; }
function inheritanceChainOf(p) {
  const chain = []; const seen = new Set([p.id]); let cur = p;
  while (cur && cur.inheritsFrom) {
    const parent = getPackage(cur.inheritsFrom);
    if (!parent || seen.has(parent.id)) break;
    chain.unshift(parent); seen.add(parent.id); cur = parent;
  }
  return chain;
}
// Inheritance/override identity. Prefer the stable definition id; name is only a last-resort fallback.
function svcKey(s) { return s.libraryId || `name:${String(s.name || '').trim().toLowerCase()}`; }
// Resolved services for a package: inherited (from chain) + own; own overrides inherited by key.
function resolveServices(p) {
  const map = new Map();
  inheritanceChainOf(p).forEach((anc) => {
    anc.services.forEach((s) => { map.set(svcKey(s), { svc: s, inherited: true, sourceName: anc.name }); });
  });
  p.services.forEach((s) => { map.set(svcKey(s), { svc: s, inherited: false, sourceName: p.name }); });
  return [...map.values()];
}
function resolvedList(p) { return resolveServices(p).map((r) => r.svc); }
function canInherit(p, targetId) {
  if (!targetId) return true;
  let cur = getPackage(targetId); const seen = new Set();
  while (cur) {
    if (cur.id === p.id) return false;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.inheritsFrom ? getPackage(cur.inheritsFrom) : null;
  }
  return true;
}

// ---------- starter templates ----------
const STARTERS = {
  blank: () => ([
    pkg('Option #1', []),
  ]),
  lawncare: () => ([
    pkg('Good', [
      makeService({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45, kind: 'service' }),
      makeService({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15, kind: 'service' }),
    ]),
    pkg('Better', [
      makeService({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45, kind: 'service' }),
      makeService({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15, kind: 'service' }),
      makeService({ name: 'Fertilization', description: 'Seasonal granular fertilizer application', unitOfMeasure: 'application', frequency: 'quarterly', unitPrice: 75, kind: 'material' }),
      makeService({ name: 'Weed Control', description: 'Targeted broadleaf weed treatment', unitOfMeasure: 'application', frequency: 'monthly', unitPrice: 40, kind: 'service' }),
    ]),
    pkg('Best', [
      makeService({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45, kind: 'service' }),
      makeService({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15, kind: 'service' }),
      makeService({ name: 'Fertilization', description: 'Seasonal granular fertilizer application', unitOfMeasure: 'application', frequency: 'quarterly', unitPrice: 75, kind: 'material' }),
      makeService({ name: 'Weed Control', description: 'Targeted broadleaf weed treatment', unitOfMeasure: 'application', frequency: 'monthly', unitPrice: 40, kind: 'service' }),
      makeService({ name: 'Aeration', description: 'Core aeration to relieve soil compaction', unitOfMeasure: 'job', frequency: 'annually', unitPrice: 150, kind: 'service' }),
      makeService({ name: 'Overseeding', description: 'Premium seed blend overseed', unitOfMeasure: 'job', frequency: 'annually', unitPrice: 120, kind: 'material' }),
      makeService({ name: 'Seasonal Cleanup', description: 'Leaf and debris cleanup', unitOfMeasure: 'visit', frequency: 'quarterly', unitPrice: 200, kind: 'service' }),
    ]),
  ]),
  pressurewash: () => ([
    pkg('Good', [
      makeService({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350, kind: 'service' }),
      makeService({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150, kind: 'service' }),
    ]),
    pkg('Better', [
      makeService({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350, kind: 'service' }),
      makeService({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150, kind: 'service' }),
      makeService({ name: 'Walkway Cleaning', description: 'Clean walkways and front porch', unitOfMeasure: 'job', frequency: 'single', unitPrice: 100, kind: 'service' }),
      makeService({ name: 'Patio Cleaning', description: 'Clean rear patio surface', unitOfMeasure: 'job', frequency: 'single', unitPrice: 125, kind: 'service' }),
    ]),
    pkg('Best', [
      makeService({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350, kind: 'service' }),
      makeService({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150, kind: 'service' }),
      makeService({ name: 'Walkway Cleaning', description: 'Clean walkways and front porch', unitOfMeasure: 'job', frequency: 'single', unitPrice: 100, kind: 'service' }),
      makeService({ name: 'Patio Cleaning', description: 'Clean rear patio surface', unitOfMeasure: 'job', frequency: 'single', unitPrice: 125, kind: 'service' }),
      makeService({ name: 'Roof Soft Wash', description: 'Low-pressure roof treatment', unitOfMeasure: 'job', frequency: 'single', unitPrice: 450, kind: 'service' }),
      makeService({ name: 'Gutter Brightening', description: 'Exterior gutter cleaning and brightening', unitOfMeasure: 'job', frequency: 'single', unitPrice: 175, kind: 'service' }),
    ]),
  ]),
  windowcleaning: () => ([
    pkg('Good', [
      makeService({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180, kind: 'service' }),
    ]),
    pkg('Better', [
      makeService({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180, kind: 'service' }),
      makeService({ name: 'Interior Window Cleaning', description: 'Clean all interior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150, kind: 'service' }),
    ]),
    pkg('Best', [
      makeService({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180, kind: 'service' }),
      makeService({ name: 'Interior Window Cleaning', description: 'Clean all interior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150, kind: 'service' }),
      makeService({ name: 'Screens & Tracks', description: 'Wipe screens and clean window tracks', unitOfMeasure: 'job', frequency: 'single', unitPrice: 90, kind: 'service' }),
      makeService({ name: 'Skylight Cleaning', description: 'Clean interior and exterior skylights', unitOfMeasure: 'job', frequency: 'single', unitPrice: 120, kind: 'service' }),
    ]),
  ]),
  quickquote: () => ([
    pkg('Quote', [
      makeService({ name: 'Service', description: '', unitOfMeasure: 'job', frequency: 'single', unitPrice: 0, kind: 'service' }),
    ]),
  ]),
};
function pkg(name, services) { return { id: uid(), name, message: '', inheritsFrom: null, services }; }

// ---------- package naming schemes ----------
const GBB_NAMES = ['Good', 'Better', 'Best'];
// A name is "auto" (safe to overwrite) if it's empty or matches a scheme-generated pattern.
function isAutoPackageName(name) {
  const n = String(name || '').trim();
  return !n || GBB_NAMES.includes(n) || /^Option #\d+$/.test(n) || /^Package \d+$/.test(n);
}
function schemeName(scheme, index, total) {
  if (total <= 1) return 'Option #1';                 // a lone package always reads "Option #1"
  if (scheme === 'option') return `Option #${index + 1}`;
  return GBB_NAMES[index] || `Option #${index + 1}`;  // gbb: Good/Better/Best, then Option #N
}
// Re-apply the active scheme by position, but never clobber a name the user typed manually.
function applyNamingScheme() {
  const total = state.packages.length;
  state.packages.forEach((p, i) => { if (isAutoPackageName(p.name)) p.name = schemeName(state.namingScheme, i, total); });
}

// ---------- calculations ----------
const MEASURE_KEYS = ['turf', 'concrete', 'roof', 'fence', 'gutter'];
function measurementValue(li) { return MEASURE_KEYS.includes(li.measureType) ? toNumber(state.measurements[li.measureType], 0) : 0; }
function lineAmount(li) {
  const mode = String(li.pricingMode || 'calculated');
  if (mode === 'flat') return toNumber(li.flatAmount, 0);
  if (mode === 'measurement') return toNumber(li.basePrice, 0) + measurementValue(li) * toNumber(li.multiplier, 0);
  return toNumber(li.quantity, 0) * toNumber(li.unitPrice, 0);
}
function lineMonthly(li) {
  const amt = lineAmount(li);
  const f = String(li.frequency || 'single');
  return RECURRING_PER_MONTH[f] ? amt * RECURRING_PER_MONTH[f] : 0;
}
function packageTotal(p) { return resolvedList(p).reduce((s, li) => s + lineAmount(li), 0); }
function packageMonthly(p) { return resolvedList(p).reduce((s, li) => s + lineMonthly(li), 0); }
function getActivePackage() { return state.packages.find((p) => p.id === state.activePackageId) || null; }
function getActiveService() {
  const p = getActivePackage();
  return p ? (p.services.find((s) => s.id === state.activeServiceId) || null) : null;
}
function serviceIssues(li) {
  const issues = [];
  if (!String(li.name || '').trim()) issues.push('Name is required');
  // Quantity only drives the price in calculated mode; flat/measurement push as qty 1,
  // so a zeroed qty there isn't a real problem and shouldn't block export.
  if (String(li.pricingMode || 'calculated') === 'calculated' && toNumber(li.quantity, 0) <= 0) issues.push('Qty must be > 0');
  if (toNumber(li.unitPrice, 0) < 0) issues.push('Unit price must be ≥ 0');
  if (String(li.pricingMode) === 'flat' && toNumber(li.flatAmount, 0) < 0) issues.push('Flat amount must be ≥ 0');
  if (!KINDS.includes(normalizeKind(li.kind))) issues.push('Kind not recognized');
  return issues;
}
function freqLabel(v) { return (FREQUENCY_OPTIONS.find((f) => f.value === v) || {}).label || v; }

// ---------- render: header ----------
function renderHeader() {
  $('#estimateName').value = state.estimateName;
  const kicker = document.querySelector('.studio-estimate-kicker');
  if (kicker) kicker.textContent = state.division || 'ScopeFoundry Studio';
  const ds = $('#divisionSelect');
  if (ds && state.division) ds.value = state.division;
  const good = state.packages[0];
  const better = state.packages[1];
  const best = state.packages[2];
  const chips = [];
  state.packages.forEach((p, i) => {
    chips.push(`<div class="value-chip"><span class="chip-label">${esc(p.name || `Pkg ${i + 1}`)}</span><span class="chip-value">${money(packageTotal(p))}</span></div>`);
  });
  const combined = state.packages.reduce((s, p) => s + packageTotal(p), 0);
  chips.push(`<div class="value-chip total"><span class="chip-label">Total</span><span class="chip-value">${money(combined)}</span></div>`);
  $('#headerTotals').innerHTML = chips.join('');
  const totalBar = $('#totalBar');
  if (totalBar) totalBar.classList.toggle('hidden', state.packages.length === 0);

  const imp = $('#importStatus');
  if (state.importSource) { imp.textContent = `${state.importSource} ✓`; imp.className = 'studio-status ok'; }
  else { imp.textContent = 'No source'; imp.className = 'studio-status'; }

  const exp = $('#exportStatus');
  if (state.customer && usableAddressId()) { exp.textContent = 'HCP Ready ✓'; exp.className = 'studio-status ok'; }
  else if (state.customer) { exp.textContent = 'HCP: pick address'; exp.className = 'studio-status warn'; }
  else { exp.textContent = 'HCP: attach customer'; exp.className = 'studio-status'; }

  const ready = Boolean(state.customer && usableAddressId() && state.packages.some((p) => p.services.length));
  $('#btnDry').disabled = !ready;
  $('#btnCreate').disabled = !ready;
}
// The address HCP will use for the estimate: service when typed, otherwise billing fallback.
function usableAddressId() { return state.serviceAddressId || state.billingAddressId || null; }
// Split a customer's addresses by HCP type. Untyped customers fall back to a single chooser.
function splitAddresses(c) {
  const addrs = (c && c.addresses) || [];
  const service = addrs.filter((a) => String(a.type || '').toLowerCase() === 'service');
  const billing = addrs.filter((a) => String(a.type || '').toLowerCase() === 'billing');
  return { addrs, service, billing, untyped: !service.length && !billing.length };
}

// ---------- render: packages ----------
function renderPackages() {
  const host = $('#packageList');
  const ns = $('#namingScheme'); if (ns) ns.value = state.namingScheme;
  host.innerHTML = state.packages.map((p, i) => {
    const active = p.id === state.activePackageId ? ' active' : '';
    const resolved = resolveServices(p);
    const ownCount = p.services.length;
    const inhCount = resolved.length - ownCount;
    const others = state.packages.filter((x) => x.id !== p.id && canInherit(p, x.id));
    const inheritOpts = ['<option value="">No inheritance</option>']
      .concat(others.map((o) => `<option value="${o.id}" ${p.inheritsFrom === o.id ? 'selected' : ''}>↳ Inherit ${esc(o.name)}</option>`))
      .join('');
    return `
      <div class="pkg-card${active}" data-pkg="${p.id}">
        <input class="pkg-card-name" data-pkg-name="${p.id}" value="${esc(p.name || `Package ${i + 1}`)}" />
        <select class="pkg-inherit" data-pkg-inherit="${p.id}">${inheritOpts}</select>
        <div class="pkg-card-meta"><span>${resolved.length} service(s)</span><span>${money(packageMonthly(p))}/mo</span></div>
        ${inhCount ? `<div class="pkg-card-sub">${inhCount} inherited · ${ownCount} added here</div>` : ''}
        <div class="pkg-card-value">${money(packageTotal(p))}</div>
        <div class="pkg-card-sub">total package value</div>
        <div class="pkg-card-actions">
          <button class="pkg-mini" data-pkg-action="dupe" data-pkg="${p.id}">Duplicate</button>
          ${state.packages.length > 1 ? `<button class="pkg-mini danger" data-pkg-action="del" data-pkg="${p.id}">Delete</button>` : ''}
          ${i > 0 ? `<button class="pkg-mini" data-pkg-action="up" data-pkg="${p.id}">↑</button>` : ''}
          ${i < state.packages.length - 1 ? `<button class="pkg-mini" data-pkg-action="down" data-pkg="${p.id}">↓</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ---------- render: services ----------
function renderServices() {
  const p = getActivePackage();
  $('#servicesTitle').textContent = p ? `${p.name} — Services` : 'Services';
  const host = $('#serviceList');
  if (!p) { host.innerHTML = '<div class="editor-empty">Select a package.</div>'; $('#serviceListFoot').textContent = ''; return; }
  const filter = ($('#serviceFilter').value || '').toLowerCase().trim();
  const all = resolveServices(p);
  const rows = all.filter((r) => !filter || `${r.svc.name} ${r.svc.description} ${r.svc.category}`.toLowerCase().includes(filter));
  if (!rows.length) {
    host.innerHTML = `<div class="editor-empty">${all.length ? 'No services match your search.' : 'No services yet. Click ＋ to add one, or 📚 to pull from your library.'}</div>`;
  } else {
    host.innerHTML = rows.map((r) => {
      const s = r.svc;
      const active = (!r.inherited && s.id === state.activeServiceId) ? ' active' : '';
      const cls = r.inherited ? ' svc-inherited' : '';
      const invalid = (!r.inherited && serviceIssues(s).length) ? '<span class="svc-invalid-dot" title="Has validation issues"></span>' : '';
      const freq = String(s.frequency) === 'single' ? 'One-time' : `<span class="svc-freq-badge">${esc(freqLabel(s.frequency))}</span>`;
      const badge = r.inherited ? `<span class="svc-source-badge" title="Inherited from ${esc(r.sourceName)}">↳ ${esc(r.sourceName)}</span>` : '';
      const actions = r.inherited
        ? `<button class="pkg-mini" data-svc-action="override" data-srcid="${s.id}" title="Override in this package">Override</button>`
        : `<button class="pkg-mini" data-svc-action="dupe" data-svc="${s.id}">⧉</button><button class="pkg-mini danger" data-svc-action="del" data-svc="${s.id}">✕</button>`;
      return `
        <div class="svc-row${active}${cls}" ${r.inherited ? '' : `data-svc="${s.id}"`} ${r.inherited ? '' : 'draggable="true"'}>
          <span class="svc-drag" title="${r.inherited ? 'Inherited' : 'Drag to reorder'}">${r.inherited ? '↳' : '☰'}</span>
          <div class="svc-main">
            <div class="svc-name">${esc(s.name || 'Untitled service')} ${badge}${bulkState.active && !r.inherited && bulkState.currentId === s.id ? ' <span class="svc-ai-spin" title="Generating…">⏳</span>' : ''}</div>
            <div class="svc-sub">${freq} · ${esc(s.unitOfMeasure || 'unit')}</div>
          </div>
          ${invalid}
          <div class="svc-price">${money(lineAmount(s))}</div>
          <div class="svc-row-actions">${actions}</div>
        </div>`;
    }).join('');
  }
  const ownIssues = p.services.reduce((n, s) => n + serviceIssues(s).length, 0);
  const inh = all.filter((r) => r.inherited).length;
  $('#serviceListFoot').innerHTML = `${all.length} service(s)${inh ? ` (${inh} inherited)` : ''} · ${money(packageTotal(p))} · ${money(packageMonthly(p))}/mo`
    + (ownIssues ? ` · <span style="color:var(--err)">${ownIssues} issue(s)</span>` : ' · <span style="color:var(--ok)">no issues</span>');
}

// ---------- render: editor ----------
function renderEditor() {
  const s = getActiveService();
  const host = $('#editorBody');
  const pbBtn = $('#btnSaveToPricebook');
  if (pbBtn) {
    pbBtn.disabled = !s;
    pbBtn.textContent = s && s.pricebookId ? '📕 Update / save to price book' : '📕 Save to price book';
  }
  const genBtn = $('#btnGenerateAi');
  const rewriteBtn = $('#btnRewriteAi');
  {
    const run = s ? aiRuns.get(s.id) : null;
    const busy = !!run && ['running', 'reviewing', 'revising'].includes(run.status);
    if (genBtn) genBtn.disabled = !s || busy;
    if (rewriteBtn) rewriteBtn.disabled = !s || busy;
  }
  const nameBar = $('#editorNameBar');
  if (!s) {
    host.innerHTML = editorAddPanelHtml();
    $('#editorTitle').textContent = 'Service Editor';
    if (nameBar) nameBar.classList.add('hidden');
    renderAiStatus(null);
    return;
  }
  $('#editorTitle').textContent = s.name || 'Untitled service';
  if (nameBar) {
    nameBar.classList.remove('hidden');
    const nameInput = $('#editorNameInput');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = s.name || '';
  }
  const tab = state.activeTab;
  const f = (field) => esc(s[field] ?? '');
  const uses = s.libraryId ? libUsageCount(s.libraryId) : 1;
  const activePkgName = getActivePackage() ? getActivePackage().name : '';
  const sharedBanner = `<div class="editor-scope shared">🔗 Shared service — name, description, category &amp; notes update everywhere this service is used (${uses} place${uses === 1 ? '' : 's'}).</div>`;
  const localBanner = `<div class="editor-scope local">📍 Pricing, quantity &amp; frequency are specific to <strong>${esc(activePkgName)}</strong>.</div>`;
  let body = (tab === 'pricing') ? localBanner : (tab === 'metadata' ? '' : sharedBanner);

  if (tab === 'general') {
    body += `
      <div class="field"><label>AI Hints &amp; Context</label><textarea data-f="description" placeholder="Enter hints or context here for the AI to take into consideration when generating (e.g. scope details, materials, site conditions, tone).">${f('description')}</textarea></div>
      <div class="field"><label>Customer Description</label><textarea data-f="customerDescription">${f('customerDescription')}</textarea></div>
      <div class="field"><label>Recommendations (customer-facing)</label><textarea data-f="recommendations" placeholder="Consultative recommendations shown to the customer.">${f('recommendations')}</textarea></div>
      <div class="field"><label>Exclusions</label><textarea data-f="exclusions">${f('exclusions')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Category</label><input data-f="category" value="${f('category')}" /></div>
        <div class="field"><label>Tags (comma separated)</label><input data-f="tags" value="${f('tags')}" /></div>
      </div>`;
  } else if (tab === 'pricing') {
    const mode = String(s.pricingMode || 'calculated');
    const isFlat = mode === 'flat';
    const isMeasure = mode === 'measurement';
    const mt = MEASURE_TYPES.find((m) => m.value === s.measureType);
    const mUnit = unitWords((mt && mt.unit) || '') || 'unit';
    const uw = unitWords(s.unitOfMeasure);
    const pw = unitWordsSingular(s.unitOfMeasure);
    const mVal = measurementValue(s);
    body += `
      <div class="amount-preview"><span class="hint">Line amount${isFlat ? ' (flat)' : isMeasure ? ' (base + measure × mult)' : ' (qty × unit)'}</span><span class="amt">${money(lineAmount(s))}</span></div>
      <div class="field"><label>Housecall Pro Line Type</label>
        <div class="kind-seg">${KIND_TOGGLE.map((k) => `<label class="kind-seg-opt"><input type="radio" name="kind-${esc(s.id)}" data-f="kind" value="${k}" ${(k === s.kind || (k === 'service' && s.kind === 'labor')) ? 'checked' : ''}/><span>${esc(KIND_LABELS[k] || k)}</span></label>`).join('')}</div>
        <p class="field-hint">Sets which bucket this lands in on Housecall Pro — <strong>Materials</strong> vs <strong>Labor</strong> (a service line).</p>
      </div>
      <div class="field-row">
        <div class="field"><label>Unit of Measure</label>
          <div class="field-add-row">
            <select data-f="unitOfMeasure">${allUnits().map((u) => `<option value="${esc(u)}" ${u === s.unitOfMeasure ? 'selected' : ''}>${esc(u || '(none)')}</option>`).join('')}</select>
            <button type="button" class="field-add-btn" data-add="unit" title="Add a unit of measure">＋</button>
          </div>
          <div class="field-add-input hidden" data-add-input="unit">
            <input type="text" data-add-field="unit" placeholder="New unit (e.g. linear ft)" />
            <button type="button" class="studio-mini" data-add-save="unit">Add</button>
            <button type="button" class="studio-mini" data-add-cancel="unit">Cancel</button>
          </div>
        </div>
        <div class="field"><label>Frequency</label>
          <div class="field-add-row">
            <select data-f="frequency">${allFrequencies().map((o) => `<option value="${o.value}" ${o.value === s.frequency ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
            <button type="button" class="field-add-btn" data-add="freq" title="Add a frequency">＋</button>
          </div>
          <div class="field-add-input hidden" data-add-input="freq">
            <input type="text" data-add-field="freq" placeholder="New frequency (e.g. Every 2 weeks)" />
            <button type="button" class="studio-mini" data-add-save="freq">Add</button>
            <button type="button" class="studio-mini" data-add-cancel="freq">Cancel</button>
          </div>
        </div>
      </div>
      <div class="field"><label>Pricing Type</label><select data-f="pricingMode">${PRICING_MODES.map((o) => `<option value="${o.value}" ${o.value === s.pricingMode ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      ${(!isFlat && !isMeasure) ? `<div class="field-row">
        <div class="field ${toNumber(s.quantity, 0) <= 0 ? 'field-invalid' : ''}"><label>Quantity</label>${uw
          ? `<div class="input-unit"><input type="number" step="any" data-f="quantity" value="${toNumber(s.quantity, 0)}" /><span class="input-unit-chip">${esc(uw)}</span></div>`
          : `<input type="number" step="any" data-f="quantity" value="${toNumber(s.quantity, 0)}" />`}</div>
        <div class="field"><label>Unit Price</label>${pw
          ? `<div class="input-unit"><span class="input-unit-pre">$</span><input type="number" step="0.01" data-f="unitPrice" value="${toNumber(s.unitPrice, 0)}" /><span class="input-unit-chip">/ ${esc(pw)}</span></div>`
          : `<input type="number" step="0.01" data-f="unitPrice" value="${toNumber(s.unitPrice, 0)}" />`}</div>
      </div>` : ''}
      ${isFlat ? `<div class="field"><label>Flat Amount</label><input type="number" step="0.01" data-f="flatAmount" value="${toNumber(s.flatAmount, 0)}" /></div>` : ''}
      ${isMeasure ? `<div class="measure-box">
        <div class="field-row">
          <div class="field"><label>Measurement</label><select data-f="measureType">${MEASURE_TYPES.map((m) => `<option value="${esc(m.value)}" ${m.value === s.measureType ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Multiplier ($/${esc(mUnit)})</label><input type="number" step="0.0001" data-f="multiplier" value="${toNumber(s.multiplier, 0)}" /></div>
        </div>
        <div class="field"><label>Base Price</label><input type="number" step="0.01" data-f="basePrice" value="${toNumber(s.basePrice, 0)}" /></div>
        <div class="measure-formula">${money(toNumber(s.basePrice, 0))} base + ${mVal.toLocaleString()} ${esc(mUnit)} × $${toNumber(s.multiplier, 0)}/${esc(mUnit)} = <strong>${money(lineAmount(s))}</strong></div>
        ${!s.measureType ? '<p class="field-hint">Pick a measurement type, then set the property value in 📐 Measurements (top bar).</p>' : (mVal ? '' : `<p class="field-hint">No ${esc(mt ? mt.label : '')} value set yet — open 📐 Measurements in the top bar.</p>`)}
      </div>` : ''}
      <details class="collapse"><summary>Advanced pricing</summary><div>
        <div class="field-row">
          <div class="field"><label>Minimum Charge</label><input type="number" step="0.01" data-f="minCharge" value="${toNumber(s.minCharge, 0)}" /></div>
          <div class="field"><label>Maximum Charge</label><input type="number" step="0.01" data-f="maxCharge" value="${toNumber(s.maxCharge, 0)}" /></div>
        </div>
        <div class="field"><label>Calculation Method</label><input data-f="calcMethod" value="${f('calcMethod')}" /></div>
        <label class="studio-testmode"><input type="checkbox" data-f="taxable" ${s.taxable ? 'checked' : ''}/> Taxable</label>
      </div></details>`;
  } else if (tab === 'notes') {
    body += `
      <div class="field"><label>Internal Notes</label><textarea data-f="internalNotes">${f('internalNotes')}</textarea></div>
      <div class="field"><label>Crew Notes</label><textarea data-f="crewNotes">${f('crewNotes')}</textarea></div>
      <div class="field"><label>Estimator Notes</label><textarea data-f="estimatorNotes">${f('estimatorNotes')}</textarea></div>
      <div class="field"><label>AI Scope Generation Notes</label><textarea data-f="aiNotes">${f('aiNotes')}</textarea></div>
      <p class="field-hint">On export, these notes are combined into the Housecall Pro line note field.</p>`;
  } else if (tab === 'metadata') {
    body += `
      <div class="field"><label>Division</label><select data-f="division"><option value="">(estimate default: ${esc(state.division || '—')})</option>${DIVISIONS.map((d) => `<option value="${esc(d)}" ${d === s.division ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>Pricebook ID</label><input data-f="pricebookId" value="${f('pricebookId')}" /></div>
        <div class="field"><label>External ID</label><input data-f="externalId" value="${f('externalId')}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Import Source</label><input data-f="importSource" value="${f('importSource')}" /></div>
      </div>
      <div class="field-row field-readonly">
        <div class="field"><label>Created</label><input value="${esc((s.createdAt || '').slice(0, 10))}" readonly /></div>
        <div class="field"><label>Modified</label><input value="${esc((s.modifiedAt || '').slice(0, 10))}" readonly /></div>
      </div>
      <details class="collapse"><summary>Export settings & HCP mapping</summary><div>
        <p class="field-hint">All spreadsheet-compatible fields are preserved in this estimate object. On export, Studio maps name, description, unit, quantity, frequency, price, pricing mode, kind, taxable, and combined notes to the Housecall Pro line item. Extra fields stay attached for round-trip compatibility.</p>
      </div></details>`;
  }
  host.innerHTML = body;
  document.querySelectorAll('#editorTabs .editor-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  autoGrowEditorTextareas();
  renderAiStatus(s);
}

// Grow a textarea to fit its content (CSS min-height stays the floor; manual resize still works).
function autoGrowTextarea(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
function autoGrowEditorTextareas() {
  document.querySelectorAll('#editorBody textarea').forEach(autoGrowTextarea);
}

function renderAll() {
  renderHeader();
  renderTemplatesBar();
  renderPackages();
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#workspace').classList.add('hidden');
  $('#compareView').classList.add('hidden');
  $('#previewView').classList.add('hidden');
  if (state.view === 'compare') {
    $('#compareView').classList.remove('hidden');
    renderCompare();
  } else if (state.view === 'preview') {
    $('#previewView').classList.remove('hidden');
    renderPreview();
  } else {
    if (state.packages.length) $('#workspace').classList.remove('hidden');
    renderServices();
    renderEditor();
  }
  renderPreflight();
  renderCopyBadge();
}
function setView(v) { state.view = v; renderAll(); }

// ---------- mutations ----------
function touch(s) { s.modifiedAt = new Date().toISOString(); }
function setActivePackage(id) {
  state.activePackageId = id;
  const p = getActivePackage();
  state.activeServiceId = p && p.services[0] ? p.services[0].id : null;
  state.activeTab = 'pricing';
  renderAll();
}
function setActiveService(id) { state.activeServiceId = id; state.activeTab = 'pricing'; renderServices(); renderEditor(); }

// Copy an inherited service into the active package so it can be overridden locally.
function overrideInPackage(srcServiceId) {
  const p = getActivePackage(); if (!p) return;
  let src = null;
  inheritanceChainOf(p).forEach((anc) => { const found = anc.services.find((s) => s.id === srcServiceId); if (found) src = found; });
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src)); copy.id = uid();
  p.services.push(copy);
  state.activeServiceId = copy.id;
  state.activeTab = 'pricing';
  persist();
  renderAll();
}

// ---------- compare / diff view ----------
function renderCompare() {
  const host = $('#compareView');
  if (!state.packages.length) { host.innerHTML = '<div class="editor-empty">No packages to compare.</div>'; return; }
  const cols = state.packages.map((p) => {
    const rows = resolveServices(p);
    const items = rows.map((r) => {
      const s = r.svc;
      const mark = r.inherited ? '<span class="cmp-mark inh">✓</span>' : '<span class="cmp-mark add">＋</span>';
      const qu = qtyUnitLabel(s);
      return `<li class="${r.inherited ? 'cmp-inh' : 'cmp-add'}">${mark}<span class="cmp-name">${esc(s.name || 'Untitled')}${qu ? `<span class="cmp-unit">${esc(qu)}</span>` : ''}</span><span class="cmp-price">${money(lineAmount(s))}</span></li>`;
    }).join('');
    const inh = rows.filter((r) => r.inherited).length;
    return `
      <div class="cmp-col">
        <div class="cmp-col-head">
          <h3>${esc(p.name)}</h3>
          <div class="cmp-total">${money(packageTotal(p))}</div>
          <div class="cmp-sub">${money(packageMonthly(p))}/mo · ${rows.length} service(s)${inh ? ` · ${inh} inherited` : ''}</div>
        </div>
        <ul class="cmp-list">${items || '<li class="cmp-empty">No services</li>'}</ul>
      </div>`;
  }).join('');
  host.innerHTML = `
    <div class="cmp-legend"><span><span class="cmp-mark inh">✓</span> Inherited</span><span><span class="cmp-mark add">＋</span> Added at this tier</span></div>
    <div class="cmp-grid">${cols}</div>`;
}

// ---------- templates (server-backed via /api/studio/templates) ----------
// state.templates = active templates (dropdown). tplFeatured = homepage cards.
let tplFeatured = [];
let tplMenuOpen = false;
const tplById = (id) => state.templates.find((t) => Number(t.id) === Number(id))
  || tplFeatured.find((t) => Number(t.id) === Number(id));

// Fetch wrapper: returns parsed JSON or throws Error(message) from { error }.
async function tapiFetch(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}
const TAPI = {
  list: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return tapiFetch(`/api/studio/templates${q ? `?${q}` : ''}`).then((d) => d.templates);
  },
  get: (id) => tapiFetch(`/api/studio/templates/${id}`).then((d) => d.template),
  create: (payload) => tapiFetch('/api/studio/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((d) => d.template),
  update: (id, fields) => tapiFetch(`/api/studio/templates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }).then((d) => d.template),
  hide: (id) => tapiFetch(`/api/studio/templates/${id}/hide`, { method: 'POST' }).then((d) => d.template),
  restore: (id) => tapiFetch(`/api/studio/templates/${id}/restore`, { method: 'POST' }).then((d) => d.template),
  feature: (id, body) => tapiFetch(`/api/studio/templates/${id}/feature`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((d) => d.template),
  unfeature: (id) => tapiFetch(`/api/studio/templates/${id}/unfeature`, { method: 'POST' }).then((d) => d.template),
  reorder: (order) => tapiFetch('/api/studio/templates/homepage-order', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }).then((d) => d.templates),
  remove: (id) => tapiFetch(`/api/studio/templates/${id}`, { method: 'DELETE' }),
};

// Reload the active + featured caches from the server, then re-render.
async function refreshTemplates() {
  try {
    const [active, featured] = await Promise.all([
      TAPI.list({ status: 'active' }),
      TAPI.list({ featured: '1' }),
    ]);
    state.templates = active;
    tplFeatured = featured;
  } catch (e) {
    // Leave caches as-is on failure; surface once.
    console.warn('Template load failed:', e.message);
  }
  renderTemplatesBar();
}

function renderTemplatesBar() {
  const trigger = $('#templateTriggerLabel');
  if (trigger) {
    const active = tplById(state.activeTemplateId);
    trigger.textContent = active ? active.name : 'Ad-hoc estimate (no template)';
  }
  if (tplMenuOpen) renderTemplateMenu();
  renderFeaturedCards();
}

function renderTemplateMenu() {
  const menu = $('#templateMenu');
  if (!menu) return;
  const rows = state.templates.map((t) => `
    <div class="tpl-mrow-wrap${Number(t.id) === Number(state.activeTemplateId) ? ' active' : ''}">
      <button type="button" class="tpl-mrow" data-load="${t.id}" role="menuitem">
        <span class="tpl-mrow-name">${esc(t.name)}</span>
        ${t.is_featured_on_homepage ? '<span class="tpl-chip" title="On homepage">★ Home</span>' : ''}
      </button>
      <button type="button" class="icon-btn tpl-mrow-menu" data-tpl-menu="${t.id}" title="Template actions" aria-label="Template actions">⋯</button>
    </div>`).join('');
  menu.innerHTML = `
    <button type="button" class="tpl-mrow tpl-adhoc${state.activeTemplateId == null ? ' active' : ''}" data-load="" role="menuitem">Ad-hoc estimate (no template)</button>
    ${state.templates.length ? rows : '<div class="tpl-menu-empty">No saved templates yet. Build an estimate, then “Save as template”.</div>'}
    <div class="tpl-menu-foot">
      <button type="button" class="tpl-mrow tpl-manage" data-open-manager="1" role="menuitem">⚙ Manage templates…</button>
    </div>`;
}
function openTemplateMenu() {
  tplMenuOpen = true;
  const trig = $('#templateTrigger');
  if (trig) trig.setAttribute('aria-expanded', 'true');
  $('#templateMenu')?.classList.remove('hidden');
  renderTemplateMenu();
}
function closeTemplateMenu() {
  tplMenuOpen = false;
  const trig = $('#templateTrigger');
  if (trig) trig.setAttribute('aria-expanded', 'false');
  $('#templateMenu')?.classList.add('hidden');
  closeTplActionMenu();
}

async function saveAsTemplate() {
  const proposed = prompt('Save this estimate as a reusable template. Template name:', state.estimateName || 'New Template');
  if (proposed == null) return;
  const name = proposed.trim();
  if (!name) { flash('Template name cannot be empty.', 'err'); return; }
  const payload = {
    name,
    division: state.division,
    body: { measurements: { ...state.measurements }, packages: JSON.parse(JSON.stringify(state.packages)) },
  };
  try {
    const tpl = await TAPI.create(payload);
    state.activeTemplateId = tpl.id;
    await refreshTemplates();
    flash(`Saved “${tpl.name}”. It now appears in the Template dropdown.`, 'ok');
  } catch (e) {
    flash(e.message, 'err');
  }
}

// Load a template into the workspace. Accepts a server record (structure in .body)
// or a legacy localStorage record (structure at top level). Duplicates the contents
// so edits never mutate the stored template.
function applyTemplateRecord(tpl) {
  const srcPackages = (tpl.body && Array.isArray(tpl.body.packages)) ? tpl.body.packages : (Array.isArray(tpl.packages) ? tpl.packages : []);
  const srcMeasure = (tpl.body && tpl.body.measurements) ? tpl.body.measurements : (tpl.measurements || null);
  const idMap = {};
  const copies = srcPackages.map((p) => {
    const np = JSON.parse(JSON.stringify(p));
    idMap[np.id] = (np.id = uid());
    (np.services || []).forEach((s) => { s.id = uid(); });
    return np;
  });
  copies.forEach((np) => { if (np.inheritsFrom && idMap[np.inheritsFrom]) np.inheritsFrom = idMap[np.inheritsFrom]; });
  state.packages = copies;
  ensureLibraryIds();
  state.activeTemplateId = tpl.id;
  state.estimateName = tpl.name;
  state.division = tpl.division || state.division;
  if (srcMeasure) state.measurements = { ...state.measurements, ...srcMeasure };
  state.importSource = `Template: ${tpl.name}`;
  state.view = 'build';
  state.activePackageId = copies[0] ? copies[0].id : null;
  state.activeServiceId = copies[0] && copies[0].services[0] ? copies[0].services[0].id : null;
  $('#quickStart').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderAll();
}
async function loadTemplate(id) {
  if (id === '' || id == null) { state.activeTemplateId = null; renderTemplatesBar(); return; }
  let tpl = tplById(id);
  try {
    // Always fetch the full record (cache omits nothing here, but keep it authoritative).
    tpl = await TAPI.get(id);
  } catch (e) {
    if (!tpl) { flash(e.message, 'err'); return; }
  }
  if (!tpl) return;
  applyTemplateRecord(tpl);
}

// ---------- service library drawer ----------
let libTimer = null;
function openLibrary() {
  if (!getActivePackage()) { alert('Select a package first.'); return; }
  $('#libraryDrawer').classList.remove('hidden');
  $('#pickerBackdrop').classList.remove('hidden');
  $('#libSearch').value = '';
  renderLibraryList('');
  $('#libSearch').focus();
}
function closeLibrary() { $('#libraryDrawer').classList.add('hidden'); $('#pickerBackdrop').classList.add('hidden'); }
function renderLibraryList(q) {
  const host = $('#libResults');
  const query = String(q || '').toLowerCase().trim();
  const items = state.serviceLibrary
    .filter((l) => !query || `${l.name} ${l.category}`.toLowerCase().includes(query))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!items.length) { host.innerHTML = '<div class="hint">No library services yet. Services you add to packages are saved here automatically.</div>'; return; }
  host.innerHTML = items.map((l) => `
    <div class="picker-item" data-lib="${l.id}">
      <div class="picker-item-name">${esc(l.name)}</div>
      <div class="picker-item-meta">${esc(l.category || 'uncategorized')} · ${money(l.defaultUnitPrice || 0)} · used in ${libUsageCount(l.id)} place(s)</div>
    </div>`).join('');
}
function addLibraryToActive(libId) {
  const lib = libGet(libId); if (!lib) return;
  const svc = makeService({
    ...pickShared(lib),
    libraryId: lib.id,
    unitPrice: lib.defaultUnitPrice || 0,
    frequency: lib.defaultFrequency || 'single',
    pricingMode: lib.defaultPricingMode || 'calculated',
    flatAmount: lib.defaultFlatAmount || 0,
    measureType: lib.defaultMeasureType || '',
    basePrice: lib.defaultBasePrice || 0,
    multiplier: lib.defaultMultiplier || 0,
    taxable: lib.defaultTaxable !== false,
    importSource: 'Library',
  });
  closeLibrary();
  addServiceToActive(svc);
}

// ---------- imports (reuse existing backend endpoints) ----------
function makeServiceFromImported(li) {
  return makeService({
    name: String(li.name || 'Service'),
    description: String(li.description || ''),
    unitOfMeasure: String(li.unitOfMeasure || li.unit_of_measure || ''),
    quantity: toNumber(li.quantity, 1),
    frequency: String(li.frequency || 'single'),
    pricingMode: li.pricingMode === 'flat' ? 'flat' : 'calculated',
    flatAmount: toNumber(li.flatAmount, 0),
    unitPrice: toNumber(li.unitPrice, 0),
    kind: String(li.kind || 'service'),
    taxable: li.taxable !== false,
    internalNotes: String(li.notes || ''),
    importSource: 'Imported',
  });
}
function optionsToPackages(options) {
  return (options || []).map((opt) => {
    const services = (opt.lineItems || []).map(makeServiceFromImported);
    const p = pkg(String(opt.name || 'Option'), services);
    p.message = String(opt.message || '');
    return p;
  });
}
// Mirror app.js rebuildSiteReconOptions with default (no removed lines, no previous edits).
function sitereconToOptions(payload) {
  if (!payload) return [];
  const tierOrder = Array.isArray(payload.tierOrder) ? payload.tierOrder : ['best', 'better', 'good'];
  const tierRules = payload.tierRules || {};
  const optionNames = payload.optionNames || {};
  const baseLines = Array.isArray(payload.baseLines) ? payload.baseLines : [];
  return tierOrder.map((tierKey, idx) => {
    const excludes = new Set((tierRules[tierKey] && tierRules[tierKey].excludeCategories) || []);
    const lineItems = baseLines
      .filter((line) => !excludes.has(line.category))
      .map((line) => ({ ...(line.lineItem || {}), taxable: true }));
    return { name: optionNames[tierKey] || `Option ${idx + 1}`, message: null, lineItems };
  });
}
function loadImportedEstimate(options, opts) {
  const packages = optionsToPackages(options);
  if (!packages.length) { flash('Nothing to import \u2014 the file had no usable line items.', 'err'); return; }
  state.packages = packages;
  state.packages.forEach((p) => p.services.forEach((s) => libUpsertFromService(s)));
  ensureLibraryIds();
  state.importSource = (opts && opts.importSource) || 'Imported';
  state.estimateName = (opts && opts.estimateName) || 'Imported Estimate';
  state.activeTemplateId = null;
  state.view = 'build';
  state.activePackageId = state.packages[0].id;
  state.activeServiceId = state.packages[0].services[0] ? state.packages[0].services[0].id : null;
  state.draftId = null;
  $('#quickStart').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  persist();
  renderAll();
}
async function importFromFile(kind) {
  const input = $('#importFile');
  if (!input) return;
  input.value = '';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const endpoint = kind === 'siterecon' ? '/api/parse-siterecon' : '/api/parse';
    flash(kind === 'siterecon' ? 'Parsing SiteRecon workbook\u2026' : 'Parsing spreadsheet\u2026', '');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(endpoint, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Parse failed (${res.status})`);
      if (Array.isArray(data.errors) && data.errors.length) {
        flash('Cannot use this file: ' + data.errors.join('; '), 'err');
        return;
      }
      const options = kind === 'siterecon' ? sitereconToOptions(data.siterecon) : (data.options || []);
      if (!options.length) { flash('No options were found in that file.', 'warn'); return; }
      loadImportedEstimate(options, {
        importSource: kind === 'siterecon' ? 'SiteRecon import' : 'Spreadsheet import',
        estimateName: kind === 'siterecon' ? 'SiteRecon Estimate' : 'Imported Estimate',
      });
      const warn = Array.isArray(data.warnings) && data.warnings.length ? ` (notes: ${data.warnings.join('; ')})` : '';
      flash(`Imported ${options.length} option(s)${warn}.`, 'ok');
    } catch (e) {
      flash(e.message || 'Import failed.', 'err');
    }
  };
  input.click();
}
async function openDuplicate() {
  if (!state.customer) {
    flash('Pick a customer first (Step 1) to clone one of their estimates.', 'err');
    const cs = $('#custSearch'); if (cs) cs.focus();
    return;
  }
  $('#duplicateDrawer').classList.remove('hidden');
  $('#pickerBackdrop').classList.remove('hidden');
  const host = $('#dupResults');
  host.innerHTML = '<div class="hint">Loading recent estimates\u2026</div>';
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(state.customer.id)}/estimates`);
    if (res.status === 404) { host.innerHTML = '<div class="hint">This customer has no previous estimates to clone.</div>'; return; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    renderDuplicateList(data.estimates || []);
  } catch (e) {
    host.innerHTML = `<div class="hint">Could not load estimates: ${esc(e.message)}</div>`;
  }
}
function closeDuplicate() { $('#duplicateDrawer').classList.add('hidden'); $('#pickerBackdrop').classList.add('hidden'); }
function renderDuplicateList(estimates) {
  const host = $('#dupResults');
  if (!estimates.length) { host.innerHTML = '<div class="hint">No previous estimates found for this customer.</div>'; return; }
  host.innerHTML = estimates.map((e) => `
    <div class="picker-item" data-dup="${esc(String(e.id))}">
      <div class="picker-item-name">${esc(String(e.estimate_number || 'Estimate'))}${e.address ? ` \u2014 ${esc(e.address)}` : ''}</div>
      <div class="picker-item-meta">${money((Number(e.total) || 0) / 100)}</div>
    </div>`).join('');
  host.querySelectorAll('[data-dup]').forEach((el) => el.addEventListener('click', () => chooseDuplicate(el.dataset.dup)));
}
async function chooseDuplicate(estimateId) {
  const host = $('#dupResults');
  host.innerHTML = '<div class="hint">Cloning estimate\u2026</div>';
  try {
    const res = await fetch(`/api/estimates/${encodeURIComponent(estimateId)}/duplicate`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const options = data.options || [];
    if (!options.length) { host.innerHTML = '<div class="hint">That estimate has no line items to clone.</div>'; return; }
    closeDuplicate();
    loadImportedEstimate(options, { importSource: 'Duplicated estimate', estimateName: 'Cloned Estimate' });
    flash(`Cloned estimate into ${options.length} package(s).`, 'ok');
  } catch (e) {
    host.innerHTML = `<div class="hint">Could not clone: ${esc(e.message)}</div>`;
  }
}

function flash(text, kind) {
  const msg = $('#resultMsg');
  if (!msg) return;
  msg.className = `studio-result-msg ${kind || ''}`.trim();
  msg.textContent = text;
}

// ---------- undo + toast ----------
const undoStack = [];
function snapshotPackages() {
  return JSON.stringify({ packages: state.packages, activePackageId: state.activePackageId, activeServiceId: state.activeServiceId });
}
function pushUndo() {
  undoStack.push(snapshotPackages());
  if (undoStack.length > 25) undoStack.shift();
}
function doUndo() {
  const snap = undoStack.pop();
  if (!snap) return;
  const data = JSON.parse(snap);
  state.packages = data.packages;
  state.activePackageId = data.activePackageId;
  state.activeServiceId = data.activeServiceId;
  persist();
  renderAll();
  showToast('Restored.', null, null, 2000);
}
let toastTimer = null;
function showToast(message, actionLabel, actionFn, ms = 6000) {
  const t = $('#studioToast');
  if (!t) return;
  t.innerHTML = `<span class="toast-msg">${esc(message)}</span>${actionLabel ? `<button class="toast-action" id="toastAction">${esc(actionLabel)}</button>` : ''}`;
  t.classList.remove('hidden');
  if (actionLabel && actionFn) $('#toastAction').addEventListener('click', () => { hideToast(); actionFn(); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { const t = $('#studioToast'); if (t) t.classList.add('hidden'); }

// ---------- pre-flight export validation ----------
function preflightChecks() {
  const out = [];
  if (!state.packages.length) return out;
  if (!state.customer) out.push({ level: 'error', msg: 'No customer attached.' });
  else if (!usableAddressId()) out.push({ level: 'error', msg: 'No service or billing address selected.' });
  state.packages.forEach((p) => {
    if (!resolvedList(p).length) out.push({ level: 'error', msg: `Package “${p.name}” has no services.` });
    p.services.forEach((s) => {
      const nm = s.name || 'Untitled service';
      serviceIssues(s).forEach((iss) => out.push({ level: 'error', msg: `${p.name} › ${nm}: ${iss}.` }));
      if (lineAmount(s) === 0) out.push({ level: 'warn', msg: `${p.name} › ${nm}: line total is $0.` });
      if (!String(s.customerDescription || '').trim()) out.push({ level: 'warn', msg: `${p.name} › ${nm}: no customer description — the Housecall Pro line will fall back to internal AI hints or be blank. Generate or write one first.` });
      if (String(s.pricingMode) === 'measurement') {
        if (!s.measureType) out.push({ level: 'warn', msg: `${p.name} › ${nm}: measurement pricing with no measurement type chosen.` });
        else if (measurementValue(s) === 0) out.push({ level: 'warn', msg: `${p.name} › ${nm}: no ${s.measureType} value set in 📐 Measurements.` });
      }
    });
  });
  return out;
}
function renderPreflight() {
  const panel = $('#preflightPanel');
  if (!panel) return;
  const checks = state.packages.length ? preflightChecks() : [];
  if (!checks.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  const errs = checks.filter((c) => c.level === 'error');
  const warns = checks.filter((c) => c.level === 'warn');
  const head = errs.length
    ? `<strong class="pf-err">${errs.length} blocker${errs.length === 1 ? '' : 's'}</strong>`
    : '<strong class="pf-ok">Ready to export ✓</strong>';
  const warnHead = warns.length ? ` · <strong class="pf-warn">${warns.length} warning${warns.length === 1 ? '' : 's'}</strong>` : '';
  const items = [...errs, ...warns].slice(0, 12).map((c) => `<li class="pf-${c.level}">${esc(c.msg)}</li>`).join('');
  const more = checks.length > 12 ? `<li class="pf-more">…and ${checks.length - 12} more</li>` : '';
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="pf-head">🛫 Pre-flight: ${head}${warnHead}</div><ul class="pf-list">${items}${more}</ul>`;
}

// ---------- customer-copy rollup badge ----------
function uniqueResolvedServices() {
  const map = new Map();
  state.packages.forEach((p) => resolveServices(p).forEach((r) => { const k = svcKey(r.svc); if (!map.has(k)) map.set(k, r.svc); }));
  return [...map.values()];
}
function renderCopyBadge() {
  const badge = $('#copyBadge');
  if (!badge) return;
  const missing = uniqueResolvedServices().filter((s) => !String(s.customerDescription || '').trim());
  if (state.view !== 'build' || !state.packages.length || !missing.length) { badge.classList.add('hidden'); badge.textContent = ''; return; }
  badge.classList.remove('hidden');
  badge.textContent = `✍ ${missing.length} service${missing.length === 1 ? '' : 's'} need customer copy`;
}
function jumpToMissingCopy() {
  for (const p of state.packages) {
    const s = p.services.find((x) => !String(x.customerDescription || '').trim());
    if (s) { setActivePackage(p.id); state.activeServiceId = s.id; state.activeTab = 'general'; renderAll(); return; }
  }
}

// ---------- customer preview view ----------
function renderPreview() {
  const host = $('#previewView');
  const cards = state.packages.map((p) => {
    const rows = resolveServices(p).map((r) => r.svc);
    const lines = rows.map((s) => `
      <div class="pv-line">
        <div class="pv-line-main">
          <div class="pv-line-name">${esc(s.name || 'Service')}</div>
          ${(s.customerDescription || s.description) ? `<div class="pv-line-desc">${esc(s.customerDescription || s.description)}</div>` : '<div class="pv-line-desc warn">⚠ No customer description — this will look bare in Housecall Pro.</div>'}
          ${qtyUnitLabel(s) ? `<div class="pv-line-qty">${esc(qtyUnitLabel(s))}</div>` : ''}
          ${(s.frequency && s.frequency !== 'single') ? `<div class="pv-line-freq">${esc(freqLabel(s.frequency))}</div>` : ''}
        </div>
        <div class="pv-line-price">${money(lineAmount(s))}</div>
      </div>`).join('');
    return `
      <div class="pv-card">
        <div class="pv-card-head"><h3>${esc(p.name)}</h3><div class="pv-card-total">${money(packageTotal(p))}</div></div>
        ${packageMonthly(p) ? `<div class="pv-card-mo">${money(packageMonthly(p))} / month</div>` : ''}
        <div class="pv-lines">${lines || '<div class="pv-empty">No services</div>'}</div>
      </div>`;
  }).join('');
  host.innerHTML = `
    <div class="pv-doc">
      <div class="pv-header">
        <div class="pv-brand">United Services Northwest</div>
        <div class="pv-division">${esc(state.division || '')}</div>
        <h2 class="pv-title">${esc(state.estimateName || 'Estimate')}</h2>
        <div class="pv-customer ${state.customer ? '' : 'muted'}">${state.customer ? `Prepared for ${esc(state.customer.name)}` : 'No customer attached yet'}</div>
      </div>
      <div class="pv-grid">${cards}</div>
      <p class="pv-note">Customer-facing preview of how options &amp; descriptions will read once exported to Housecall Pro. Edit customer-facing copy in each service’s General tab.</p>
    </div>`;
}

// ---------- measurements drawer ----------
function openMeasure() {
  $('#measureDrawer').classList.remove('hidden');
  $('#pickerBackdrop').classList.remove('hidden');
  MEASURE_KEYS.forEach((k) => { const el = document.querySelector(`#measureDrawer [data-m="${k}"]`); if (el) el.value = toNumber(state.measurements[k], 0); });
}
function closeMeasure() { $('#measureDrawer').classList.add('hidden'); $('#pickerBackdrop').classList.add('hidden'); }

// ---------- boot starters ----------
function loadStarter(key) {
  const builder = STARTERS[key] || STARTERS.blank;
  state.namingScheme = 'gbb';
  state.packages = builder();
  // Register every service in the first-class library (dedupes by name).
  state.packages.forEach((p) => p.services.forEach((s) => libUpsertFromService(s)));
  // Demonstrate inheritance: each tier inherits the one before and only keeps NEW services.
  for (let i = 1; i < state.packages.length; i += 1) {
    const prev = state.packages[i - 1];
    state.packages[i].inheritsFrom = prev.id;
    const inheritedKeys = new Set(resolveServices(prev).map((r) => svcKey(r.svc)));
    state.packages[i].services = state.packages[i].services.filter((s) => !inheritedKeys.has(svcKey(s)));
  }
  state.importSource = key === 'blank' ? 'New estimate' : `Starter: ${key}`;
  state.estimateName = key === 'blank' ? 'New Estimate' : ({
    lawncare: 'Lawn Care Starter', pressurewash: 'Pressure Washing Starter', windowcleaning: 'Window Cleaning Starter', quickquote: 'Quick Quote',
  }[key] || 'New Estimate');
  state.activeTemplateId = null;
  state.view = 'build';
  state.activePackageId = state.packages[0].id;
  state.activeServiceId = state.packages[0].services[0] ? state.packages[0].services[0].id : null;
  state.draftId = null;
  $('#quickStart').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  persist();
  renderAll();
}

// ---------- submit (maps to backend payload) ----------
function toBackendOptions() {
  return state.packages.map((p) => ({
    name: p.name,
    message: p.message || null,
    lineItems: resolvedList(p).map((s) => {
      const mode = String(s.pricingMode || 'calculated');
      const amount = lineAmount(s);
      const beMode = mode === 'measurement' ? 'flat' : mode;
      return {
        name: `${s.name}${measureNameSegment(s)}`,
        description: hcpLineDescription(s),
        unitOfMeasure: s.unitOfMeasure,
        quantity: mode === 'calculated' ? toNumber(s.quantity, 0) : 1,
        frequency: s.frequency,
        unitPrice: mode === 'calculated' ? toNumber(s.unitPrice, 0) : 0,
        pricingMode: beMode,
        flatAmount: beMode === 'flat' ? amount : 0,
        kind: s.kind,
        taxable: Boolean(s.taxable),
        notes: [s.internalNotes, s.crewNotes, s.estimatorNotes, s.aiNotes, s.notes]
          .filter(Boolean).join(' | '),
      };
    }),
  }));
}
async function submit(dryRun) {
  const msg = $('#resultMsg');
  const blockers = preflightChecks().filter((c) => c.level === 'error');
  if (blockers.length) {
    renderPreflight();
    msg.className = 'studio-result-msg err';
    msg.textContent = `Can't export — ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} in the pre-flight panel.`;
    return;
  }
  // Re-push guard: HCP can't update an estimate in place, so a second Create makes a
  // brand-new estimate. Make that explicit instead of silently duplicating.
  if (!dryRun && state.hcpEstimate && state.hcpEstimate.number) {
    const ok = confirm(
      `This estimate was already pushed to Housecall Pro as #${state.hcpEstimate.number}.\n\n`
      + `Housecall Pro can't update an existing estimate, so continuing will create a NEW, separate `
      + `estimate (it won't change #${state.hcpEstimate.number}).\n\nCreate another estimate?`,
    );
    if (!ok) { msg.className = 'studio-result-msg'; msg.textContent = `Kept existing HCP estimate #${state.hcpEstimate.number}. Nothing pushed.`; return; }
  }
  msg.className = 'studio-result-msg';
  msg.textContent = dryRun ? 'Building dry run…' : 'Creating in Housecall Pro…';
  try {
    const res = await fetch('/api/estimates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: state.customer.id,
        addressId: state.serviceAddressId || state.billingAddressId,
        serviceAddressId: state.serviceAddressId,
        billingAddressId: state.billingAddressId,
        options: toBackendOptions(),
        dryRun,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    msg.className = 'studio-result-msg ok';
    if (data.dryRun) { msg.innerHTML = `Dry run — ${data.plan.length} API call(s):<pre>${esc(JSON.stringify(data.plan, null, 2))}</pre>`; return; }
    const r = data.result || {};
    state.hcpEstimate = {
      id: r.id || null,
      optionId: hcpFirstOptionId(r),
      number: r.estimate_number != null ? String(r.estimate_number) : null,
      options: Array.isArray(r.options) ? r.options.length : 0,
      pushedAt: new Date().toISOString(),
    };
    renderHcpBadge();
    const url = hcpEstimateUrl(state.hcpEstimate.optionId || r.id);
    const openLink = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open estimate ↗</a> ` : '';
    const numLabel = state.hcpEstimate.number ? `#${esc(state.hcpEstimate.number)}` : '(number pending)';
    const optCount = state.hcpEstimate.options;
    msg.innerHTML = `Created estimate ${numLabel} with ${optCount} option${optCount === 1 ? '' : 's'}. ${openLink}`
      + `<span class="hint">Pressing Create again makes a new estimate — HCP can't update in place.</span>`;
    // Persist the HCP link onto the draft so reopening shows the pushed status + guard.
    try { await saveDraft(); } catch (_) { /* link is in state regardless; draft save is best-effort */ }
  } catch (e) { msg.className = 'studio-result-msg err'; msg.textContent = e.message; }
}

// ---------- HCP push preview modal (review + edit the exact payload before it hits HCP) ----------
// HCP can't update an estimate after creation, so this modal is the last chance to review and
// tweak. The body is derived from the server dry-run so what's shown == what gets sent, then
// edited in place (money shown in dollars, stored in cents to match HCP).
let hcpPreviewModel = null;
const HCP_KIND_OPTIONS = ['labor', 'materials', 'discount', 'tax'];
const centsToDollars = (c) => (Number(c) || 0) / 100;
const dollarsToCents = (d) => Math.round((Number(d) || 0) * 100);

async function openHcpPreview() {
  const msg = $('#resultMsg');
  const blockers = preflightChecks().filter((c) => c.level === 'error');
  if (blockers.length) {
    renderPreflight();
    msg.className = 'studio-result-msg err';
    msg.textContent = `Can't push — ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} in the pre-flight panel.`;
    return;
  }
  msg.className = 'studio-result-msg';
  msg.textContent = 'Building preview…';
  try {
    const res = await fetch('/api/estimates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: state.customer.id,
        addressId: usableAddressId(),
        serviceAddressId: state.serviceAddressId,
        billingAddressId: state.billingAddressId,
        options: toBackendOptions(),
        dryRun: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not build preview');
    const body = data.plan && data.plan[0] && data.plan[0].body;
    if (!body) throw new Error('No estimate body in preview.');
    hcpPreviewModel = body;
    (hcpPreviewModel.options || []).forEach((o) => { o.line_items = o.line_items || []; });
    msg.textContent = '';
    renderHcpPreview();
    $('#hcpModalBackdrop').classList.remove('hidden');
    $('#hcpModal').classList.remove('hidden');
  } catch (e) {
    msg.className = 'studio-result-msg err';
    msg.textContent = e.message;
  }
}

function closeHcpPreview() {
  $('#hcpModalBackdrop').classList.add('hidden');
  $('#hcpModal').classList.add('hidden');
}

function hcpOptionTotalCents(opt) {
  return (opt.line_items || []).reduce((s, li) => s + (Number(li.quantity) || 0) * (Number(li.unit_price) || 0), 0);
}

// Taxability normalization for the push preview. The HCP `tax`-kind line is the tax
// charge itself (auto-handled), so it's excluded — only real service lines are counted/set.
function hcpTaxSummary() {
  let total = 0; let taxable = 0;
  for (const opt of (hcpPreviewModel?.options || [])) {
    for (const li of (opt.line_items || [])) {
      if (String(li.kind).toLowerCase() === 'tax') continue;
      total += 1;
      if (li.taxable) taxable += 1;
    }
  }
  return { total, taxable, mixed: taxable !== 0 && taxable !== total };
}

// Set `taxable` consistently on every non-tax line item across all options, then re-render.
function normalizeHcpTax(value) {
  for (const opt of (hcpPreviewModel?.options || [])) {
    for (const li of (opt.line_items || [])) {
      if (String(li.kind).toLowerCase() === 'tax') continue;
      li.taxable = value;
    }
  }
  renderHcpPreview();
}

// Refresh the normalize bar's count + mixed warning in place (used on per-row toggles
// so we don't re-render the whole table and lose focus/scroll).
function updateHcpTaxBar() {
  const bar = $('#hcpModalBody .hcp-tax-bar');
  if (!bar) return;
  const tax = hcpTaxSummary();
  bar.classList.toggle('mixed', tax.mixed);
  const status = bar.querySelector('.hcp-tax-status');
  if (status) status.textContent = `${tax.mixed ? '⚠ Mixed taxability — ' : 'Taxability: '}${tax.taxable} of ${tax.total} line${tax.total === 1 ? '' : 's'} taxable`;
}

function renderHcpPreview() {
  const bodyEl = $('#hcpModalBody');
  const m = hcpPreviewModel;
  if (!m) { bodyEl.innerHTML = '<div class="hcp-empty">Nothing to preview.</div>'; return; }
  const cust = state.customer || {};
  const addrs = cust.addresses || [];
  const aId = m.service_address_id || m.address_id;
  const a = addrs.find((x) => x.id === aId);
  const addrLabel = a ? addrLine(a) : (aId || 'no address');
  const kindOpts = (sel) => HCP_KIND_OPTIONS.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${k}</option>`).join('');
  const options = (m.options || []).map((opt, oi) => {
    const rows = (opt.line_items || []).map((li, li_i) => `
      <tr data-li="${li_i}">
        <td class="col-name"><input data-f="name" value="${esc(li.name || '')}" /></td>
        <td class="col-desc"><input data-f="description" value="${esc(li.description || '')}" /></td>
        <td class="col-qty"><input class="num" data-f="quantity" type="number" step="any" value="${esc(String(li.quantity ?? 1))}" /></td>
        <td class="col-price"><input class="num" data-f="unit_price" type="number" step="0.01" value="${esc(centsToDollars(li.unit_price).toFixed(2))}" /></td>
        <td class="col-kind"><select data-f="kind">${kindOpts(li.kind)}</select></td>
        <td class="col-tax"><input data-f="taxable" type="checkbox" ${li.taxable ? 'checked' : ''} /></td>
        <td class="col-amt">${money(centsToDollars((Number(li.quantity) || 0) * (Number(li.unit_price) || 0)))}</td>
        <td class="col-del"><button class="hcp-li-del" data-act="del-li" title="Remove line">✕</button></td>
      </tr>`).join('');
    return `
      <div class="hcp-opt" data-oi="${oi}">
        <div class="hcp-opt-head">
          <input class="hcp-opt-name" data-f="opt-name" value="${esc(opt.name || '')}" placeholder="Option name" />
          <span class="hcp-opt-total">${money(centsToDollars(hcpOptionTotalCents(opt)))}</span>
          ${m.options.length > 1 ? '<button class="hcp-li-del" data-act="del-opt" title="Remove option">🗑</button>' : ''}
        </div>
        <table class="hcp-li-table">
          <thead><tr><th>Name</th><th>Description</th><th>Qty</th><th>Unit $</th><th>Kind</th><th>Tax</th><th>Amount</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="hcp-empty">No line items.</td></tr>'}</tbody>
        </table>
        <div class="hcp-opt-actions"><button class="studio-mini" data-act="add-li">+ Add line item</button></div>
      </div>`;
  }).join('');
  const tax = hcpTaxSummary();
  const taxBar = `
    <div class="hcp-tax-bar${tax.mixed ? ' mixed' : ''}">
      <span class="hcp-tax-status">${tax.mixed ? '⚠ Mixed taxability — ' : 'Taxability: '}${tax.taxable} of ${tax.total} line${tax.total === 1 ? '' : 's'} taxable</span>
      <span class="hcp-tax-actions">
        <button class="studio-mini" data-act="tax-all">Make all taxable</button>
        <button class="studio-mini" data-act="tax-none">Make none taxable</button>
      </span>
    </div>`;
  bodyEl.innerHTML = `
    <div class="hcp-cust"><strong>${esc(cust.name || 'Customer')}</strong> · ${esc(addrLabel)}</div>
    ${taxBar}
    ${options || '<div class="hcp-empty">No options.</div>'}
    <div class="hcp-opt-actions"><button class="studio-mini" data-act="add-opt">+ Add option</button></div>`;
}

function onHcpInput(e) {
  const el = e.target;
  const f = el.dataset.f;
  if (!f || !hcpPreviewModel) return;
  const optEl = el.closest('.hcp-opt');
  if (!optEl) return;
  const oi = Number(optEl.dataset.oi);
  const opt = hcpPreviewModel.options[oi];
  if (!opt) return;
  if (f === 'opt-name') { opt.name = el.value; return; }
  const tr = el.closest('tr[data-li]');
  if (!tr) return;
  const li = opt.line_items[Number(tr.dataset.li)];
  if (!li) return;
  if (f === 'name') li.name = el.value;
  else if (f === 'description') li.description = el.value;
  else if (f === 'quantity') li.quantity = Number(el.value) || 0;
  else if (f === 'unit_price') li.unit_price = dollarsToCents(el.value);
  else if (f === 'kind') li.kind = el.value;
  else if (f === 'taxable') { li.taxable = el.checked; updateHcpTaxBar(); }
  if (f === 'quantity' || f === 'unit_price') {
    const amtCell = tr.querySelector('.col-amt');
    if (amtCell) amtCell.textContent = money(centsToDollars((Number(li.quantity) || 0) * (Number(li.unit_price) || 0)));
    const totEl = optEl.querySelector('.hcp-opt-total');
    if (totEl) totEl.textContent = money(centsToDollars(hcpOptionTotalCents(opt)));
  }
}

function onHcpClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !hcpPreviewModel) return;
  const act = btn.dataset.act;
  if (act === 'tax-all') { normalizeHcpTax(true); return; }
  if (act === 'tax-none') { normalizeHcpTax(false); return; }
  if (act === 'add-opt') {
    hcpPreviewModel.options.push({ name: `Option ${hcpPreviewModel.options.length + 1}`, message_from_pro: undefined, line_items: [] });
    renderHcpPreview(); return;
  }
  const optEl = btn.closest('.hcp-opt');
  if (!optEl) return;
  const oi = Number(optEl.dataset.oi);
  if (act === 'add-li') {
    hcpPreviewModel.options[oi].line_items.push({ name: 'New line item', description: '', quantity: 1, unit_of_measure: undefined, unit_price: 0, kind: 'labor', taxable: false });
    renderHcpPreview(); return;
  }
  if (act === 'del-opt') {
    if (hcpPreviewModel.options.length <= 1) { showToast('An estimate needs at least one option.', null, null, 3000); return; }
    hcpPreviewModel.options.splice(oi, 1);
    renderHcpPreview(); return;
  }
  if (act === 'del-li') {
    const tr = btn.closest('tr[data-li]');
    if (!tr) return;
    hcpPreviewModel.options[oi].line_items.splice(Number(tr.dataset.li), 1);
    renderHcpPreview(); return;
  }
}

async function pushHcpPreview() {
  const m = hcpPreviewModel;
  if (!m || !(m.options || []).length) { showToast('Nothing to push.', null, null, 3000); return; }
  if (!m.options.some((o) => (o.line_items || []).length)) { showToast('Add at least one line item before pushing.', null, null, 3000); return; }
  if (state.hcpEstimate && state.hcpEstimate.number) {
    const ok = confirm(
      `This estimate was already pushed to Housecall Pro as #${state.hcpEstimate.number}.\n\n`
      + `Housecall Pro can't update an existing estimate, so pushing again creates a NEW, separate `
      + `estimate (it won't change #${state.hcpEstimate.number}).\n\nPush a new estimate?`,
    );
    if (!ok) return;
  }
  const pushBtn = $('#hcpModalPush');
  const prev = pushBtn.textContent;
  pushBtn.disabled = true; pushBtn.textContent = 'Pushing…';
  try {
    const res = await fetch('/api/estimates/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: m }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Push failed');
    const r = data.result || {};
    state.hcpEstimate = {
      id: r.id || null,
      optionId: hcpFirstOptionId(r),
      number: r.estimate_number != null ? String(r.estimate_number) : null,
      options: Array.isArray(r.options) ? r.options.length : 0,
      pushedAt: new Date().toISOString(),
    };
    renderHcpBadge();
    closeHcpPreview();
    const msg = $('#resultMsg');
    msg.className = 'studio-result-msg ok';
    const url = hcpEstimateUrl(state.hcpEstimate.optionId || r.id);
    const openLink = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open estimate ↗</a> ` : '';
    const numLabel = state.hcpEstimate.number ? `#${esc(state.hcpEstimate.number)}` : '(number pending)';
    const optCount = state.hcpEstimate.options;
    msg.innerHTML = `Created estimate ${numLabel} with ${optCount} option${optCount === 1 ? '' : 's'}. ${openLink}`
      + `<span class="hint">Pushing again makes a new estimate — HCP can't update in place.</span>`;
    const toastNum = state.hcpEstimate.number ? `#${state.hcpEstimate.number} ` : '';
    if (url) showToast(`Created HCP estimate ${toastNum}✓`, 'Open ↗', () => window.open(url, '_blank', 'noopener'));
    else showToast(`Created Housecall Pro estimate ${toastNum}✓`);
    try { await saveDraft(); } catch (_) { /* link is in state regardless */ }
  } catch (e) {
    showToast('Push failed: ' + (e.message || 'unknown error'), null, null, 7000);
  } finally {
    pushBtn.disabled = false; pushBtn.textContent = prev;
  }
}

// ---------- drafts (server-side, numbered, retrievable) ----------
let draftsTimer = null;
function buildDraftSnapshot() {
  return {
    estimateName: state.estimateName,
    division: state.division,
    measurements: state.measurements,
    packages: state.packages,
    namingScheme: state.namingScheme,
    activePackageId: state.activePackageId,
    activeServiceId: state.activeServiceId,
    activeTemplateId: state.activeTemplateId,
    view: state.view,
    customer: state.customer,
    serviceAddressId: state.serviceAddressId,
    billingAddressId: state.billingAddressId,
    importSource: state.importSource,
    hcpEstimate: state.hcpEstimate || null,
  };
}
function updateDraftButton() {
  const btn = $('#btnSaveDraft');
  if (btn) btn.textContent = state.draftId ? `💾 Save Draft #${state.draftId}` : '💾 Save Draft';
}
// Direct deep link to an estimate in the Housecall Pro web app.
// HCP's web app keys the estimate page off an OPTION id (e.g. best_…/est_…),
// not the estimate (csr_…) id, so we link via the first option's id.
const HCP_WEB_ESTIMATE_BASE = 'https://pro.housecallpro.com/app/estimates';
function hcpFirstOptionId(rec) {
  const opts = rec && rec.options;
  return (Array.isArray(opts) && opts[0] && opts[0].id) ? opts[0].id : null;
}
function hcpEstimateUrl(id) {
  return id ? `${HCP_WEB_ESTIMATE_BASE}/${encodeURIComponent(id)}` : null;
}

// Persistent badge showing the Housecall Pro estimate this Studio estimate was pushed as.
// HCP can't update an estimate in place, so this is the link back to the created record.
function renderHcpBadge() {
  const el = $('#hcpLinkBadge');
  if (!el) return;
  const e = state.hcpEstimate;
  if (e && e.number) {
    const url = hcpEstimateUrl(e.optionId || e.id);
    const label = `✓ Pushed to HCP as #${esc(String(e.number))}`;
    el.innerHTML = url
      ? `${label} <a href="${esc(url)}" target="_blank" rel="noopener" class="studio-hcp-link">Open ↗</a>`
      : label;
    el.title = `Estimate ${e.id || ''} · pushed ${e.pushedAt ? relativeTime(e.pushedAt) : ''}. Pressing Create again makes a NEW estimate — HCP can't update in place.`;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}
async function saveDraft() {
  if (!state.packages.length) { flash('Nothing to save yet — start an estimate first.', 'warn'); return; }
  const body = { name: state.estimateName, division: state.division, snapshot: buildDraftSnapshot() };
  try {
    let draft;
    if (state.draftId) {
      const res = await fetch(`/api/studio/drafts/${state.draftId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 404) { state.draftId = null; return saveDraft(); } // draft was deleted elsewhere → create fresh
        throw new Error(data.error || 'Save failed');
      }
      draft = data.draft;
      showToast(`Draft #${draft.id} updated ✓`, 'Save as new copy', saveDraftAsNew);
    } else {
      draft = await createDraftRequest(body);
      showToast(`Saved as Draft #${draft.id} ✓`);
    }
    state.draftId = draft.id;
    updateDraftButton();
  } catch (e) {
    flash('Could not save draft: ' + (e.message || 'storage error'), 'err');
  }
}
async function saveDraftAsNew() {
  if (!state.packages.length) { flash('Nothing to save yet — start an estimate first.', 'warn'); return; }
  try {
    const draft = await createDraftRequest({ name: state.estimateName, division: state.division, snapshot: buildDraftSnapshot() });
    state.draftId = draft.id;
    updateDraftButton();
    showToast(`Saved as Draft #${draft.id} ✓`);
    if (!$('#draftsDrawer').classList.contains('hidden')) renderDraftsList();
  } catch (e) {
    flash('Could not save draft: ' + (e.message || 'storage error'), 'err');
  }
}
async function createDraftRequest(body) {
  const res = await fetch('/api/studio/drafts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Save failed');
  return data.draft;
}
function openDrafts() {
  $('#draftsDrawer').classList.remove('hidden');
  $('#pickerBackdrop').classList.remove('hidden');
  renderDraftsList();
}
function closeDrafts() { $('#draftsDrawer').classList.add('hidden'); $('#pickerBackdrop').classList.add('hidden'); }
async function renderDraftsList() {
  const host = $('#draftsResults');
  host.innerHTML = '<div class="hint">Loading drafts…</div>';
  try {
    const res = await fetch('/api/studio/drafts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load drafts');
    const drafts = data.drafts || [];
    if (!drafts.length) { host.innerHTML = '<div class="hint">No saved drafts yet. Use “Save current as new draft” above to create one.</div>'; return; }
    host.innerHTML = drafts.map((d) => `
      <div class="draft-item${d.id === state.draftId ? ' is-current' : ''}" data-draft="${d.id}" data-name="${esc(d.name || 'Untitled estimate')}">
        <div class="draft-item-main" data-draft-open="${d.id}">
          <div class="draft-item-name">#${d.id} · ${esc(d.name || 'Untitled estimate')}${d.id === state.draftId ? ' <span class="draft-current-tag">open</span>' : ''}</div>
          <div class="draft-item-meta">${esc(d.division || 'No division')} · ${d.package_count} package(s) · saved ${esc(relativeTime(d.updated_at))}</div>
        </div>
        <div class="draft-item-actions">
          <button class="studio-mini" data-draft-open="${d.id}">Open</button>
          <button class="studio-mini" data-draft-rename="${d.id}">Rename</button>
          <button class="studio-mini" data-draft-dup="${d.id}">Duplicate</button>
          <button class="studio-mini danger" data-draft-del="${d.id}">Delete</button>
        </div>
      </div>`).join('');
  } catch (e) {
    host.innerHTML = `<div class="hint">${esc(e.message || 'Could not load drafts')}</div>`;
  }
}
function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'recently';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} day(s) ago`;
  return new Date(t).toLocaleDateString();
}
async function openDraftById(id) {
  try {
    const res = await fetch(`/api/studio/drafts/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not open draft');
    applyDraft(data.draft);
    closeDrafts();
    showToast(`Opened Draft #${data.draft.id}`);
  } catch (e) {
    flash(e.message || 'Could not open draft', 'err');
  }
}
function applyDraft(draft) {
  const snap = draft.snapshot || {};
  state.estimateName = snap.estimateName || draft.name || 'Untitled estimate';
  state.division = snap.division || state.division;
  state.measurements = snap.measurements || state.measurements;
  state.packages = Array.isArray(snap.packages) ? snap.packages : [];
  state.namingScheme = snap.namingScheme === 'option' ? 'option' : 'gbb';
  state.activeTemplateId = snap.activeTemplateId || null;
  state.view = snap.view || 'build';
  state.activePackageId = snap.activePackageId || (state.packages[0] ? state.packages[0].id : null);
  state.activeServiceId = snap.activeServiceId || null;
  state.customer = snap.customer || null;
  state.serviceAddressId = snap.serviceAddressId || null;
  state.billingAddressId = snap.billingAddressId || null;
  state.importSource = snap.importSource || 'Draft';
  state.draftId = draft.id;
  state.hcpEstimate = snap.hcpEstimate || null;
  state.packages.forEach((p) => p.services.forEach((s) => { if (!s.libraryId || !libGet(s.libraryId)) libUpsertFromService(s); }));
  ensureLibraryIds();
  $('#quickStart').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  updateDraftButton();
  renderHcpBadge();
  persist();
  renderAll();
}
async function renameDraftById(id) {
  const item = document.querySelector(`.draft-item[data-draft="${id}"]`);
  if (!item) return;
  const main = item.querySelector('.draft-item-main');
  if (!main) return;
  const current = item.dataset.name || '';
  main.removeAttribute('data-draft-open'); // disable open-on-click while editing
  main.innerHTML = `
    <div class="draft-rename">
      <input type="text" class="studio-input draft-rename-input" value="${esc(current)}" maxlength="120" />
      <div class="draft-rename-actions">
        <button class="studio-mini" data-draft-save="${id}">Save</button>
        <button class="studio-mini" data-draft-cancel="${id}">Cancel</button>
      </div>
    </div>`;
  const input = main.querySelector('.draft-rename-input');
  input.focus(); input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRenameDraft(id, input.value); }
    else if (e.key === 'Escape') { e.preventDefault(); renderDraftsList(); }
  });
}
async function commitRenameDraft(id, value) {
  const name = String(value || '').trim();
  if (!name) { renderDraftsList(); return; }
  try {
    const res = await fetch(`/api/studio/drafts/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rename failed');
    if (id === state.draftId) { state.estimateName = name; renderHeader(); }
    renderDraftsList();
  } catch (e) { flash(e.message || 'Rename failed', 'err'); renderDraftsList(); }
}
async function duplicateDraftById(id) {
  try {
    const res = await fetch(`/api/studio/drafts/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load draft');
    const src = data.draft;
    const copy = await createDraftRequest({
      name: `${src.name || 'Untitled estimate'} (copy)`, division: src.division, snapshot: src.snapshot,
    });
    showToast(`Duplicated as Draft #${copy.id}`);
    renderDraftsList();
  } catch (e) { flash(e.message || 'Duplicate failed', 'err'); }
}
async function deleteDraftById(id) {
  if (!confirm(`Delete draft #${id}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/studio/drafts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    if (id === state.draftId) { state.draftId = null; updateDraftButton(); }
    renderDraftsList();
  } catch (e) { flash(e.message || 'Delete failed', 'err'); }
}
// On load, offer to resume the most recent draft.
async function offerResumeDraft() {
  try {
    const res = await fetch('/api/studio/drafts');
    if (!res.ok) return;
    const data = await res.json();
    const latest = (data.drafts || [])[0];
    if (!latest) return;
    showToast(`Resume Draft #${latest.id} · ${latest.name || 'Untitled estimate'}?`, 'Resume', () => openDraftById(latest.id), 12000);
  } catch (_) { /* drafts are optional; ignore */ }
}

let custTimer = null;
async function runCustomerSearch(q) {
  const ul = $('#custResults');
  ul.classList.remove('hidden');
  ul.innerHTML = '<li>Searching…</li>';
  try {
    const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    if (!data.customers.length) { ul.innerHTML = '<li>No matches.</li>'; return; }
    ul.innerHTML = '';
    data.customers.forEach((c) => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${esc(c.name)}</strong> <span class="email">${esc(c.email || '')} ${esc(c.mobile || '')}</span>`;
      li.addEventListener('click', () => chooseCustomer(c));
      ul.appendChild(li);
    });
  } catch (e) { ul.innerHTML = `<li>${esc(e.message)}</li>`; }
}
function chooseCustomer(c) {
  state.customer = c;
  setDefaultAddresses(c);
  $('#custResults').classList.add('hidden');
  $('#custSearch').value = '';
  renderCustomerChip();
  renderProperty();
  renderHeader();
}
function setDefaultAddresses(c) {
  const { addrs, service, billing, untyped } = splitAddresses(c);
  if (untyped) {
    // No service/billing typing on this customer — treat the first address as the service location.
    state.serviceAddressId = addrs[0] ? addrs[0].id : null;
    state.billingAddressId = null;
    return;
  }
  // Pull ONLY the service-typed address into service, ONLY the billing-typed into billing.
  state.serviceAddressId = service[0] ? service[0].id : null;
  state.billingAddressId = billing[0] ? billing[0].id : null;
}
function clearCustomer() {
  state.customer = null;
  state.serviceAddressId = null;
  state.billingAddressId = null;
  $('#custSearch').value = '';
  renderCustomerChip();
  renderProperty();
  renderHeader();
  $('#custSearch').focus();
}
function renderCustomerChip() {
  const c = state.customer;
  const box = $('#customerBox');
  const chip = $('#customerChip');
  const changeBtn = $('#custChange');
  if (!c) {
    box.classList.remove('hidden');
    chip.classList.add('hidden');
    changeBtn.classList.add('hidden');
    return;
  }
  box.classList.add('hidden');
  chip.classList.remove('hidden');
  changeBtn.classList.remove('hidden');
  $('#custAvatar').textContent = (c.name || '?').trim().charAt(0) || '·';
  $('#custName').textContent = c.name || 'Customer';
  const meta = [c.email, c.mobile].filter(Boolean).join(' · ');
  $('#custMeta').textContent = meta || 'No contact details';
}
function addrLine(a) { return `${a.line || ''}${a.type ? ` (${a.type})` : ''}`.trim(); }
function renderProperty() {
  const c = state.customer;
  const empty = $('#propertyEmpty');
  const summary = $('#propertySummary');
  const notice = $('#addressNotice');
  const changeBtn = $('#propertyChange');
  if (!c) {
    empty.classList.remove('hidden');
    summary.classList.add('hidden');
    notice.classList.add('hidden');
    changeBtn.classList.add('hidden');
    return;
  }
  const addrs = (c && c.addresses) || [];
  if (!addrs.length) {
    empty.classList.add('hidden');
    summary.classList.add('hidden');
    notice.classList.remove('hidden');
    changeBtn.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  notice.classList.add('hidden');
  summary.classList.remove('hidden');
  changeBtn.classList.remove('hidden');
  const svc = addrs.find((a) => a.id === state.serviceAddressId);
  const bill = addrs.find((a) => a.id === state.billingAddressId);
  if (svc) $('#propServiceLine').innerHTML = esc(addrLine(svc));
  else if (bill) $('#propServiceLine').innerHTML = '<em>Billing address used (no service address on file)</em>';
  else $('#propServiceLine').innerHTML = '<em>Not set</em>';
  $('#propBillingLine').innerHTML = bill ? esc(addrLine(bill)) : '<em>None on file</em>';
}

// ---------- property / address modal ----------
let propModalSel = { service: null, billing: null };
function openPropertyModal() {
  if (!state.customer) { flash('Attach a customer first.', 'err'); return; }
  propModalSel = { service: state.serviceAddressId, billing: state.billingAddressId };
  renderPropertyModalBody();
  $('#propertyModalBackdrop').classList.remove('hidden');
  $('#propertyModal').classList.remove('hidden');
}
function closePropertyModal() {
  $('#propertyModalBackdrop').classList.add('hidden');
  $('#propertyModal').classList.add('hidden');
}
function renderPropertyModalBody() {
  const body = $('#propertyModalBody');
  const { addrs, service, billing, untyped } = splitAddresses(state.customer);
  if (!addrs.length) {
    body.innerHTML = '<div class="modal-empty">This customer has no address in Housecall Pro. Add one in Housecall Pro first, then re-select the customer.</div>';
    $('#propertyModalSave').disabled = true;
    return;
  }
  $('#propertyModalSave').disabled = false;
  const row = (group, a, checked) => `
    <label class="addr-radio">
      <input type="radio" name="modal-${group}" value="${esc(a.id)}" ${checked ? 'checked' : ''} />
      <span class="addr-radio-text">
        <span class="addr-radio-line">${esc(a.line || '')}</span>
        ${a.type ? `<span class="addr-radio-type">${esc(a.type)}</span>` : ''}
      </span>
    </label>`;
  // Untyped customers: one chooser, the picked address becomes the service location.
  if (untyped) {
    const rows = addrs.map((a) => row('service', a, a.id === propModalSel.service)).join('');
    body.innerHTML = `
      <div class="modal-section">
        <h4>Service address</h4>
        <p class="modal-note">This customer has no service/billing typing in Housecall Pro — choose the address to use.</p>
        ${rows}
      </div>`;
    return;
  }
  // Service section: ONLY service-typed addresses.
  const svcSection = service.length
    ? service.map((a) => row('service', a, a.id === propModalSel.service)).join('')
    : '<p class="modal-note">No service address on file — the billing address below will be used as the service location.</p>';
  // Billing section: ONLY billing-typed addresses (plus a none option).
  const billNone = `
    <label class="addr-radio">
      <input type="radio" name="modal-billing" value="" ${!propModalSel.billing ? 'checked' : ''} />
      <span class="addr-radio-text"><span class="addr-radio-line">— None —</span></span>
    </label>`;
  const billSection = billing.length
    ? billNone + billing.map((a) => row('billing', a, a.id === propModalSel.billing)).join('')
    : '<p class="modal-note">No billing address on file.</p>';
  body.innerHTML = `
    <div class="modal-section"><h4>Service address</h4>${svcSection}</div>
    <div class="modal-section"><h4>Billing address</h4>${billSection}</div>`;
}
function savePropertyModal() {
  state.serviceAddressId = propModalSel.service || null;
  state.billingAddressId = propModalSel.billing || null;
  closePropertyModal();
  renderProperty();
  renderHeader();
}

// ---------- service picker ----------
let pickerTimer = null;
let editorAddTimer = null;
// Shared price-book result markup (used by the slide-out picker AND the inline editor add panel).
function pickItemsHtml(items) {
  return items.map((it) => `
    <div class="picker-item" data-pick='${esc(JSON.stringify({
      name: it.name, description: it.description || '', unit: it.unit_of_measure || '',
      price: (Number(it.unit_price) || 0) / 100, kind: it.kind || 'service',
      taxable: it.taxable ? 1 : 0, pricebookId: String(it.id || ''), category: it.category || '',
      customerDescription: it.customer_description || '', exclusions: it.exclusions || '',
      tags: Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || ''),
      internalNotes: it.internal_notes || '', crewNotes: it.crew_notes || '',
      estimatorNotes: it.estimator_notes || '', hcpNotes: it.hcp_notes || '',
      aiNotes: it.ai_scope_notes || '',
      recommendations: it.recommendations || '',
    }))}'>
      <div class="picker-item-top">
        <div class="picker-item-name">${esc(it.name)}</div>
        <span class="picker-item-tag" title="From your price book">📕 Price book</span>
      </div>
      <div class="picker-item-meta">${money((Number(it.unit_price) || 0) / 100)} / ${esc(it.unit_of_measure || 'unit')}${it.category ? ` · ${esc(it.category)}` : ''}</div>
    </div>`).join('');
}
// Shared "add a service from a price-book pick payload" (used by both entry points).
function addServiceFromPick(jsonStr) {
  const d = JSON.parse(jsonStr);
  addServiceToActive(makeService({
    name: d.name, description: d.description, customerDescription: d.customerDescription || '',
    exclusions: d.exclusions || '', tags: d.tags || '',
    unitOfMeasure: d.unit, unitPrice: d.price,
    kind: d.kind, taxable: d.taxable === 1, pricebookId: d.pricebookId, category: d.category,
    internalNotes: d.internalNotes || '', crewNotes: d.crewNotes || '',
    estimatorNotes: d.estimatorNotes || '', hcpNotes: d.hcpNotes || '', aiNotes: d.aiNotes || '',
    recommendations: d.recommendations || '',
    importSource: 'Pricebook',
  }));
}
// Inline add panel shown in the empty Service Editor (mirrors the picker drawer).
function editorAddPanelHtml() {
  return `
    <div class="editor-add">
      <div class="editor-add-head">
        <div class="editor-add-title">Add a service</div>
        <p class="hint">Search your price book and pick a match — or create a new service from whatever you type.</p>
      </div>
      <div class="editor-add-search">
        <span class="editor-add-search-icon">🔍</span>
        <input type="text" id="editorAddSearch" class="studio-input" placeholder="Search or name a new service…" autocomplete="off" />
        <button class="studio-btn editor-add-lib" id="editorAddLibrary" title="Pull from your library">📚</button>
      </div>
      <div class="editor-add-results" id="editorAddResults">${editorAddResultsHtml('', [])}</div>
    </div>`;
}
// Results markup for the inline panel: a "create new" action (when there's text) + price-book matches.
// items === null => search in flight; [] with q.length<2 => keep-typing hint.
function editorAddResultsHtml(q, items) {
  if (!q) return '<div class="hint">📕 Start typing to search your price book — or name a brand-new service.</div>';
  const createBtn = `<button class="editor-add-create" id="editorAddCreate" data-create-name="${esc(q)}">＋ Create “${esc(q)}” as a new service</button>`;
  let body;
  if (q.length < 2) body = '<div class="hint">Keep typing to search your price book…</div>';
  else if (items === null) body = '<div class="hint">Searching…</div>';
  else if (!items.length) body = '<div class="hint">No price-book matches — create it as a new service above.</div>';
  else body = pickItemsHtml(items);
  return createBtn + body;
}
async function runEditorAddSearch(q) {
  const host = $('#editorAddResults');
  if (!host) return;
  host.innerHTML = editorAddResultsHtml(q, null);
  try {
    const res = await fetch(`/api/pricebook/search?q=${encodeURIComponent(q)}&limit=15`);
    const data = await res.json();
    const items = data.results || [];
    host.innerHTML = editorAddResultsHtml(q, items);
  } catch (e) { host.innerHTML = `<div class="hint">Search error: ${esc(e.message)}</div>`; }
}
function openPicker() {
  if (!getActivePackage()) { alert('Select a package first.'); return; }
  $('#servicePicker').classList.remove('hidden');
  $('#pickerBackdrop').classList.remove('hidden');
  $('#pickerSearch').value = '';
  $('#pickerResults').innerHTML = '<div class="hint">Type at least 2 characters to search, or add a blank custom service.</div>';
  $('#pickerSearch').focus();
}
function closePicker() { $('#servicePicker').classList.add('hidden'); $('#pickerBackdrop').classList.add('hidden'); }
async function runPickerSearch(q) {
  const host = $('#pickerResults');
  host.innerHTML = '<div class="hint">Searching…</div>';
  try {
    const res = await fetch(`/api/pricebook/search?q=${encodeURIComponent(q)}&limit=15`);
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) { host.innerHTML = '<div class="hint">No matching services.</div>'; return; }
    host.innerHTML = pickItemsHtml(items);
  } catch (e) { host.innerHTML = `<div class="hint">Search error: ${esc(e.message)}</div>`; }
}
function addServiceToActive(svc) {
  const p = getActivePackage();
  if (!p) return;
  libUpsertFromService(svc);
  p.services.push(svc);
  state.activeServiceId = svc.id;
  state.activeTab = 'pricing';
  closePicker();
  persist();
  renderAll();
}

// ---------- save to price book ----------
// The price book stores a single unit_price (cents). Pick the most meaningful base price
// for the service's pricing mode so the saved item reflects what the estimator sees.
function servicePriceDollars(s) {
  const mode = String(s.pricingMode || 'calculated');
  if (mode === 'flat') return toNumber(s.flatAmount, 0);
  if (mode === 'measurement') return toNumber(s.basePrice, 0);
  return toNumber(s.unitPrice, 0);
}
// Unit of measure is only meaningful (and required) for per-unit pricing.
function pbUomRequired(s) { return String(s.pricingMode || 'calculated') === 'calculated'; }
function serviceToPricebookPayload(s) {
  return {
    name: String(s.name || '').trim(),
    category: String(s.category || '').trim(),
    description: s.description || '',
    customer_description: s.customerDescription || '',
    exclusions: s.exclusions || '',
    unit_price: Math.round(servicePriceDollars(s) * 100),
    unit_of_measure: s.unitOfMeasure || '',
    kind: s.kind || 'service',
    taxable: Boolean(s.taxable),
    tags: String(s.tags || ''),
    internal_notes: s.internalNotes || s.notes || '',
    crew_notes: s.crewNotes || '',
    estimator_notes: s.estimatorNotes || '',
    hcp_notes: s.hcpNotes || '',
    ai_scope_notes: s.aiNotes || '',
    recommendations: s.recommendations || '',
    // legacy combined notes kept for any older consumer
    notes: s.internalNotes || s.notes || '',
  };
}
let pbCategories = null;
async function loadPbCategories() {
  if (pbCategories) return pbCategories;
  try { const r = await fetch('/api/pricebook/categories'); const d = await r.json(); pbCategories = Array.isArray(d.categories) ? d.categories.filter(Boolean) : []; }
  catch { pbCategories = []; }
  return pbCategories;
}

// Set a field on a service, respecting shared-library propagation.
function setServiceField(s, field, val) {
  if (SHARED_FIELDS.includes(field)) {
    if (!s.libraryId) libUpsertFromService(s);
    propagateShared(s.libraryId, field, val);
  } else {
    s[field] = val;
  }
}

// Commit a new unit-of-measure / frequency typed into the inline ＋ add box, then select it.
function commitFieldAdd(kind) {
  const wrap = $(`#editorBody [data-add-input="${kind}"]`);
  const input = wrap && wrap.querySelector('[data-add-field]');
  const raw = input ? input.value : '';
  const s = getActiveService();
  let val;
  if (kind === 'unit') val = addCustomUnit(raw);
  else if (kind === 'freq') val = addCustomFrequency(raw);
  if (val == null) { flash(kind === 'unit' ? 'Enter a unit name first.' : 'Enter a frequency name first.', 'warn'); return; }
  if (s) {
    setServiceField(s, kind === 'unit' ? 'unitOfMeasure' : 'frequency', val);
    touch(s); persist();
  }
  renderEditor();
  renderHeader(); renderPackages(); renderServices(); renderPreflight(); renderCopyBadge();
}

// Fill studio fields from an AI field object, but only those captured as empty (never
// overwrites user content). Records each applied value in run.aiDraft for the merge rule.
function applyAiFields(s, fields, wasEmpty, aiDraft) {
  let filled = 0;
  for (const [gk, sf] of Object.entries(AI_FIELD_MAP)) {
    if (!wasEmpty[sf]) continue;
    let v = fields[gk];
    if (sf === 'tags') v = Array.isArray(v) ? v.join(', ') : (v || '');
    v = String(v ?? '').trim();
    if (!v) continue;
    setServiceField(s, sf, v);
    aiDraft[sf] = v;
    filled++;
  }
  return filled;
}

// Merge rule for QA-approved revisions: auto-apply when the field is untouched since the AI
// last wrote it; otherwise stash a non-destructive "Apply?" suggestion (chip in the status strip).
function offerAiUpdate(s, run, sf, value) {
  const next = String(value || '').trim();
  if (!next) return;
  const current = String(s[sf] ?? '').trim();
  const lastApplied = String(run.aiDraft[sf] ?? '').trim();
  if (current === lastApplied) {
    setServiceField(s, sf, next);
    run.aiDraft[sf] = next;
    delete run.suggestions[sf];
  } else if (next !== current) {
    run.suggestions[sf] = next;
  }
}

// Re-render the editor (textareas + status strip) only when this service is still active.
function refreshActiveEditor(s) {
  if (state.activeServiceId === s.id) renderEditor();
  else renderAiStatus(getActiveService());
}

function handleEnrichEvent(s, run, wasEmpty, event, data) {
  switch (event) {
    case 'fields':
    case 'architect_done':
    case 'token':
      return; // first draft already applied from the /start response
    case 'qa':
      run.qa = data || null;
      run.status = data && data.will_revise ? 'revising' : 'reviewing';
      refreshActiveEditor(s);
      return;
    case 'architect_revised':
      run.status = 'revising';
      refreshActiveEditor(s);
      return; // the paired customer_description event carries the revised text
    case 'customer_description':
      run.custCount = (run.custCount || 0) + 1;
      if (run.custCount <= 1) return; // initial draft — already applied
      offerAiUpdate(s, run, 'customerDescription', data && data.value);
      touch(s); persist(); refreshActiveEditor(s);
      return;
    case 'recommendation':
      offerAiUpdate(s, run, 'recommendations', data && data.value);
      touch(s); persist(); refreshActiveEditor(s);
      return;
    case 'category_audit':
    case 'pricing_review':
    case 'compliance_review':
    case 'duplicate_finder':
      run.reviews = run.reviews || {};
      run.reviews[event] = data || null;
      refreshActiveEditor(s);
      return;
    case 'done': {
      const f = (data && data.fields) || {};
      for (const [gk, sf] of Object.entries(AI_FIELD_MAP)) {
        if (!wasEmpty[sf]) continue;
        if (String(s[sf] ?? '').trim()) continue; // already filled
        let v = f[gk];
        if (sf === 'tags') v = Array.isArray(v) ? v.join(', ') : (v || '');
        v = String(v ?? '').trim();
        if (!v) continue;
        setServiceField(s, sf, v);
        run.aiDraft[sf] = v;
      }
      if (data && data.qa) run.qa = data.qa;
      if (data && data.reviews) run.reviews = Object.assign(run.reviews || {}, data.reviews);
      touch(s); persist(); refreshActiveEditor(s);
      return;
    }
    case 'error':
      throw new Error((data && data.message) || 'Generate failed');
  }
}

// Read the run's reattachable SSE stream and dispatch each event.
async function streamEnrichRun(s, run, wasEmpty) {
  const res = await fetch(`/api/pricebook/enrich/${encodeURIComponent(run.runId)}/stream`);
  if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = 'message';
      let dataStr = '';
      block.split('\n').forEach((line) => {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      });
      let payload = {};
      try { payload = dataStr ? JSON.parse(dataStr) : {}; } catch { payload = {}; }
      handleEnrichEvent(s, run, wasEmpty, ev, payload);
    }
  }
}

// Generate enriched fields for the active service via the async AI pipeline.
// mode 'fill' (default): only fills fields that are currently EMPTY (never overwrites your text).
// mode 'rewrite': only rewrites fields that ALREADY have text (regenerates/refines existing content).
async function generateServiceAI(mode = 'fill', opts = {}) {
  const rewrite = mode === 'rewrite';
  const s = opts.service || getActiveService();
  if (!s) return;
  const interactive = !opts.service; // active-editor button flow vs. a bulk run
  if (interactive && bulkState.active) { flash('Bulk generation in progress…', 'warn'); return; }
  if (!String(s.name || '').trim()) { if (interactive) flash('Give the service a name before generating.', 'err'); return; }
  const sid = s.id;
  const btn = interactive ? $(rewrite ? '#btnRewriteAi' : '#btnGenerateAi') : null;
  const orig = btn ? btn.textContent : '';
  const busyIcon = rewrite ? '♻️' : '✨';
  const busyWord = rewrite ? 'Rewriting' : 'Generating';
  const startedAt = Date.now();
  let timer = null;
  if (btn) {
    btn.classList.add('busy'); btn.disabled = true; btn.textContent = `${busyIcon} ${busyWord}…`;
    timer = setInterval(() => { btn.textContent = `${busyIcon} ${busyWord}… ${Math.round((Date.now() - startedAt) / 1000)}s`; }, 500);
  }

  // Eligibility snapshot: fill mode targets empty fields, rewrite mode targets fields that have text.
  // The same map gates the whole pipeline (architect draft, QA revisions, recommendations).
  const wasEmpty = {};
  Object.values(AI_FIELD_MAP).forEach((sf) => {
    const hasText = !!String(s[sf] ?? '').trim();
    wasEmpty[sf] = rewrite ? hasText : !hasText;
  });

  const run = { status: 'running', qa: null, suggestions: {}, aiDraft: {}, reviews: {}, error: '', custCount: 0, runId: '' };
  aiRuns.set(sid, run);
  renderAiStatus(s);

  const stopBtn = () => {
    if (timer) clearInterval(timer);
    if (btn) { btn.classList.remove('busy'); btn.disabled = false; btn.textContent = orig; }
  };

  try {
    const categories = await loadPbCategories();
    const ctx = {
      name: s.name,
      category: s.category || '',
      description: s.description || '',
      unitOfMeasure: s.unitOfMeasure || '',
      frequency: s.frequency || '',
      quantity: toNumber(s.quantity, 1),
      pricingMode: s.pricingMode || 'calculated',
      unitPrice: toNumber(s.unitPrice, 0),
      flatAmount: toNumber(s.flatAmount, 0),
      basePrice: toNumber(s.basePrice, 0),
      multiplier: toNumber(s.multiplier, 0),
      measureValue: measurementValue(s),
      measureUnit: (MEASURE_TYPES.find((m) => m.value === s.measureType) || {}).unit || '',
      lineAmount: lineAmount(s),
      categories,
    };

    // 1) Start the run; the Architect's first draft returns once ready.
    const startRes = await fetch('/api/pricebook/enrich/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    const startData = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startData.ok || !startData.runId) {
      throw new Error(startData.error || `Generate failed (${startRes.status})`);
    }
    run.runId = startData.runId;
    const filled = applyAiFields(s, startData.fields || {}, wasEmpty, run.aiDraft);
    run.status = 'reviewing';
    touch(s); persist(); refreshActiveEditor(s);

    // 2) Reattach to the run's SSE stream for QA review, revisions, and recommendations.
    await streamEnrichRun(s, run, wasEmpty);

    // Bulk rewrite auto-applies any staged "Apply?" suggestions (rewrite stages the customer
    // description/recommendations). Shared fields then propagate to same-library rows in other
    // options automatically, so the identical verbiage is reused with no extra AI calls.
    if (opts.autoApply) applyPendingSuggestions(s, run);

    run.status = 'done';
    refreshActiveEditor(s);
    if (interactive) {
      const verb = rewrite ? 'rewrote' : 'filled';
      const noun = rewrite ? 'field' : 'empty field';
      showToast(filled ? `AI draft ready ✓ — ${verb} ${filled} ${noun}${filled === 1 ? '' : 's'}` : 'AI draft ready ✓');
    }
  } catch (e) {
    run.status = 'error';
    run.error = e.message || 'Generate failed';
    refreshActiveEditor(s);
    if (interactive) flash(run.error, 'err');
    else throw e; // let the bulk loop count failures and continue
  } finally {
    stopBtn();
  }
}

// ---------- bulk AI generation (active package) ----------
function hasEmptyAiField(s) {
  return Object.values(AI_FIELD_MAP).some((sf) => !String(s[sf] ?? '').trim());
}

// Flush a run's staged "Apply?" suggestions onto the service. setServiceField propagates shared
// fields to every same-library row across all options, so other packages reuse the verbiage free.
function applyPendingSuggestions(s, run) {
  for (const [sf, val] of Object.entries(run.suggestions || {})) {
    const v = String(val ?? '').trim();
    if (!v) continue;
    setServiceField(s, sf, v);
    run.aiDraft[sf] = v;
  }
  run.suggestions = {};
}

function updateBulkButtons() {
  const fill = $('#btnBulkFill'); const rew = $('#btnBulkRewrite');
  if (!fill || !rew) return;
  if (bulkState.active) {
    const activeBtn = bulkState.mode === 'rewrite' ? rew : fill;
    const otherBtn = bulkState.mode === 'rewrite' ? fill : rew;
    activeBtn.classList.add('busy'); activeBtn.disabled = true; activeBtn.textContent = `${bulkState.done}/${bulkState.total}`;
    otherBtn.disabled = true;
  } else {
    fill.disabled = false; rew.disabled = false;
    fill.classList.remove('busy'); rew.classList.remove('busy');
    fill.textContent = '✨'; rew.textContent = '♻️';
  }
}

// Run the per-row pipeline across every OWN service in the active package, sequentially.
//  fill   -> only rows that still have an empty AI field (skips complete rows to save tokens).
//  rewrite-> every named row; regenerates and auto-applies. Same-name rows in OTHER options get
//            the identical verbiage via shared-field propagation (no extra AI calls).
async function bulkGenerateAI(mode) {
  if (bulkState.active) return;
  const rewrite = mode === 'rewrite';
  const p = getActivePackage();
  if (!p) { flash('Select a package first.', 'warn'); return; }
  let targets = p.services.filter((s) => String(s.name || '').trim());
  if (!rewrite) targets = targets.filter(hasEmptyAiField);
  if (!targets.length) {
    showToast(rewrite ? 'No named services to rewrite in this package.' : 'Every service here already has content — nothing to fill.');
    return;
  }
  if (rewrite && !window.confirm(`Rewrite all ${targets.length} service(s) in “${p.name}” with AI? This regenerates existing descriptions.`)) return;

  bulkState = { active: true, mode, total: targets.length, done: 0, currentId: null };
  updateBulkButtons();
  showToast(`Starting bulk ${rewrite ? 'rewrite' : 'fill'} — ${targets.length} service(s)…`);
  let ok = 0; let failed = 0;
  for (const s of targets) {
    bulkState.currentId = s.id;
    renderServices();
    try {
      await generateServiceAI(mode, { service: s, autoApply: rewrite });
      ok += 1;
    } catch (_) {
      failed += 1;
    }
    bulkState.done += 1;
    updateBulkButtons();
    renderPackages(); renderServices(); renderPreflight();
    await new Promise((r) => setTimeout(r, 400)); // throttle the single-GPU AI service
  }
  bulkState = { active: false, mode: null, total: 0, done: 0, currentId: null };
  updateBulkButtons();
  renderServices();
  showToast(`Bulk ${rewrite ? 'rewrite' : 'fill'} complete — ${ok} updated${failed ? `, ${failed} failed` : ''}.`);
}

// Short labels for the five QA dimensions shown in the status strip.
const QA_DIM_SHORT = {
  accuracy: 'Accuracy',
  completeness: 'Completeness',
  clarity: 'Clarity',
  professionalism: 'Professionalism',
  recommendation_quality: 'Recommendations',
};
const AI_STATUS_LABEL = {
  running: 'Drafting…',
  reviewing: 'QA reviewing…',
  revising: 'Revising…',
  done: 'Complete',
  error: 'Error',
};
const AI_SUGGEST_LABEL = { customerDescription: 'Customer Description', recommendations: 'Recommendations' };

function aiStatusHtml(run) {
  const statusLabel = AI_STATUS_LABEL[run.status] || run.status;
  let html = `<div class="ai-status-row"><span class="ai-chip ai-chip-${esc(run.status)}">${esc(statusLabel)}</span>`;
  if (run.qa) {
    const qa = run.qa;
    const verdict = qa.approved ? 'approved' : (qa.will_revise ? 'will revise' : 'needs review');
    const pass = qa.iteration ? ` · pass ${qa.iteration}/${qa.max_iterations || qa.iteration}` : '';
    html += `<span class="ai-qa-overall ${qa.approved ? 'ok' : 'warn'}">QA ${Math.round(qa.overall)}/100 · ${esc(verdict)}${pass}</span>`;
  }
  html += `</div>`;
  if (run.qa && run.qa.scores) {
    const dims = Object.entries(run.qa.scores)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `<span class="ai-dim"><span class="ai-dim-k">${esc(QA_DIM_SHORT[k] || k)}</span><span class="ai-dim-v">${Math.round(Number(v))}</span></span>`)
      .join('');
    if (dims) html += `<div class="ai-qa-dims">${dims}</div>`;
  }
  for (const [sf, val] of Object.entries(run.suggestions || {})) {
    html += `<div class="ai-suggest"><span class="ai-suggest-txt">QA suggested an improved <strong>${esc(AI_SUGGEST_LABEL[sf] || sf)}</strong>.</span>`
      + `<button type="button" class="ai-mini ai-apply" data-apply-field="${esc(sf)}">Apply</button>`
      + `<button type="button" class="ai-mini ai-dismiss" data-dismiss-field="${esc(sf)}">Dismiss</button></div>`;
  }
  html += reviewerHtml(run);
  if (run.status === 'error' && run.error) html += `<div class="ai-status-err">${esc(run.error)}</div>`;
  return html;
}

// Advisory reviewer chips (Category Auditor / Pricing / Compliance / Duplicate Finder).
function reviewBlock(label, assessment, items, notes, dismissKey) {
  const cls = assessment === 'concern' ? 'concern' : (assessment === 'review' ? 'warn' : 'ok');
  const mark = assessment === 'ok' ? '\u2713 looks good' : esc(assessment);
  let html = `<div class="ai-review ai-review-${cls}"><span class="ai-review-k">${esc(label)}</span><span class="ai-review-v">${mark}</span>`;
  if (dismissKey) html += `<button type="button" class="ai-mini ai-dismiss" data-dismiss-review="${esc(dismissKey)}">Dismiss</button>`;
  html += `</div>`;
  const list = (items || []).filter(Boolean);
  if (list.length) html += `<ul class="ai-review-list">${list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  else if (notes) html += `<div class="ai-review-note">${esc(notes)}</div>`;
  return html;
}

function reviewerHtml(run) {
  const r = run.reviews || {};
  let html = '';
  const ca = r.category_audit;
  if (ca) {
    if (ca.correct) {
      html += `<div class="ai-review ai-review-ok"><span class="ai-review-k">Category</span><span class="ai-review-v">\u2713 ${esc(ca.current_category || 'confirmed')}</span></div>`;
    } else if (ca.suggested_category) {
      const path = (ca.suggested_parent && ca.suggested_parent.toLowerCase() !== ca.suggested_category.toLowerCase())
        ? `${ca.suggested_parent} / ${ca.suggested_category}` : ca.suggested_category;
      html += `<div class="ai-review ai-review-warn"><span class="ai-review-k">Category</span>`
        + `<span class="ai-review-v">suggests <strong>${esc(path)}</strong>${ca.is_new ? ' (new)' : ''}</span>`
        + `<button type="button" class="ai-mini ai-apply" data-apply-category="${esc(ca.suggested_category)}">Use</button>`
        + `<button type="button" class="ai-mini ai-dismiss" data-dismiss-review="category_audit">Dismiss</button></div>`;
      if (ca.reasoning) html += `<div class="ai-review-note">${esc(ca.reasoning)}</div>`;
    }
  }
  const pr = r.pricing_review;
  if (pr && pr.assessment) html += reviewBlock('Pricing', pr.assessment, pr.issues, pr.notes, pr.assessment === 'ok' ? '' : 'pricing_review');
  const cr = r.compliance_review;
  if (cr && cr.assessment) {
    const items = [...(cr.issues || []), ...(cr.required_disclaimers || []).map((d) => `Disclaimer: ${d}`)];
    html += reviewBlock('Compliance', cr.assessment, items, cr.notes, cr.assessment === 'ok' ? '' : 'compliance_review');
  }
  const df = r.duplicate_finder;
  if (df && Array.isArray(df.matches) && df.matches.length) {
    html += `<div class="ai-review ai-review-warn"><span class="ai-review-k">Possible duplicate</span><span class="ai-review-v">review</span>`
      + `<button type="button" class="ai-mini ai-dismiss" data-dismiss-review="duplicate_finder">Dismiss</button></div>`;
    html += `<ul class="ai-review-list">` + df.matches.map((m) => {
      const label = `${esc(m.name)}${m.category ? ` (${esc(m.category)})` : ''}${m.similarity != null ? ` \u2014 ${Math.round(m.similarity * 100)}% match` : ''}`;
      const hasId = m.id != null && String(m.id) !== '';
      const openBtn = hasId
        ? ` <button type="button" class="ai-mini ai-open-pb" data-open-pb-item="${esc(String(m.id))}">Open</button>`
        : '';
      return `<li>${label}${openBtn}</li>`;
    }).join('') + `</ul>`;
    if (df.notes) html += `<div class="ai-review-note">${esc(df.notes)}</div>`;
  }
  return html;
}

// Render the AI enrichment status strip for a service (or hide it when there is no run).
function renderAiStatus(s) {
  const host = $('#aiStatus');
  if (!host) return;
  const run = s ? aiRuns.get(s.id) : null;
  if (!run) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = aiStatusHtml(run);
}

async function pbNameExists(name, excludeId) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return false;
  try {
    const r = await fetch(`/api/pricebook/search?q=${encodeURIComponent(name)}&limit=25`);
    const d = await r.json();
    return (d.results || []).some((it) => String(it.name || '').trim().toLowerCase() === norm && String(it.id) !== String(excludeId || ''));
  } catch { return false; }
}
async function openPricebookSaveModal() {
  const s = getActiveService();
  if (!s) return;
  if (!String(s.name || '').trim()) { flash('Give the service a name before saving to the price book.', 'err'); return; }
  const p = serviceToPricebookPayload(s);
  const hasExisting = Boolean(s.pricebookId);
  const isZero = (Number(p.unit_price) || 0) <= 0;
  const needUom = pbUomRequired(s);
  const cats = await loadPbCategories();
  const curCat = String(s.category || '').trim();
  const catOptions = cats.map((c) => `<option value="${esc(c)}" ${c.toLowerCase() === curCat.toLowerCase() ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const catIsKnown = cats.some((c) => c.toLowerCase() === curCat.toLowerCase());
  const uomOptions = UNITS.filter(Boolean).map((u) => `<option value="${esc(u)}" ${u === s.unitOfMeasure ? 'selected' : ''}>${esc(u)}</option>`).join('');
  $('#pbModalBody').innerHTML = `
    <p class="modal-note">${hasExisting
      ? `This service is linked to price-book item <strong>#${esc(s.pricebookId)}</strong>. Update it, or save a separate new item.`
      : 'This will create a new item in your price book.'}</p>
    <div class="pb-preview">
      <div class="pb-preview-row"><span>Name</span><strong>${esc(p.name)}</strong></div>
      <div class="pb-preview-row"><span>Unit price</span><strong>${money(p.unit_price / 100)}${needUom ? '' : (p.unit_of_measure ? ` / ${esc(p.unit_of_measure)}` : '')}</strong></div>
      <div class="pb-preview-row"><span>Kind</span><strong>${esc(p.kind)}</strong></div>
    </div>
    <div id="pbDupWarn" class="modal-empty hidden"></div>
    <div class="field">
      <label>Category <span class="pb-req">*</span></label>
      <select id="pbCategory">
        <option value="">Select a category…</option>
        ${catOptions}
        ${(curCat && !catIsKnown) ? `<option value="${esc(curCat)}" selected>${esc(curCat)}</option>` : ''}
        <option value="__new__">➕ Add new category…</option>
      </select>
    </div>
    <div class="field hidden" id="pbNewCategoryWrap">
      <label>New category name <span class="pb-req">*</span></label>
      <input id="pbNewCategory" type="text" placeholder="e.g. Turf Care" />
    </div>
    ${needUom ? `<div class="field">
      <label>Unit of measure <span class="pb-req">*</span></label>
      <select id="pbUom"><option value="">Select a unit…</option>${uomOptions}</select>
    </div>` : ''}
    <label class="studio-testmode pb-check"><input type="checkbox" id="pbTaxable" ${s.taxable ? 'checked' : ''}/> Taxable</label>
    ${isZero ? `<label class="studio-testmode pb-check pb-warn-check"><input type="checkbox" id="pbZeroConfirm"/> Save this as a $0.00 item</label>` : ''}`;
  $('#pbModalActions').innerHTML = `
    <button class="studio-btn" id="pbModalCancel">Cancel</button>
    ${hasExisting ? '<button class="studio-btn" id="pbSaveNew">Save as new</button><button class="studio-btn primary" id="pbUpdate">Update existing</button>'
      : '<button class="studio-btn primary" id="pbSaveNew">Save as new item</button>'}`;
  $('#pbModalHint').textContent = 'Writes to your Postgres price book.';
  $('#pbModalHint').classList.remove('err');
  $('#pbCategory').addEventListener('change', (e) => {
    $('#pbNewCategoryWrap').classList.toggle('hidden', e.target.value !== '__new__');
    if (e.target.value === '__new__') $('#pbNewCategory').focus();
  });
  $('#pbModalBackdrop').classList.remove('hidden');
  $('#pbModal').classList.remove('hidden');
  // Async duplicate-name check (warn, don't block).
  pbNameExists(p.name, s.pricebookId).then((dup) => {
    const el = $('#pbDupWarn');
    if (!el) return;
    if (dup) { el.textContent = `⚠ An item named “${p.name}” already exists. Use “Update existing” to avoid a duplicate, or continue to save a copy.`; el.classList.remove('hidden'); }
    else { el.classList.add('hidden'); }
  });
}
function closePricebookSaveModal() {
  $('#pbModalBackdrop').classList.add('hidden');
  $('#pbModal').classList.add('hidden');
}
async function savePricebookItem(mode) {
  const s = getActiveService();
  if (!s) return;
  const hint = $('#pbModalHint');
  const fail = (msg) => { hint.classList.add('err'); hint.textContent = msg; };
  hint.classList.remove('err');

  // Resolve & validate the gating fields.
  const catSel = $('#pbCategory');
  let category = catSel ? catSel.value : '';
  if (category === '__new__') category = ($('#pbNewCategory')?.value || '').trim();
  category = String(category || '').trim();
  if (!category) { fail('Choose or enter a category.'); return; }

  let uom = s.unitOfMeasure || '';
  if (pbUomRequired(s)) {
    uom = ($('#pbUom')?.value || '').trim();
    if (!uom) { fail('Select a unit of measure.'); return; }
  }

  const payload = serviceToPricebookPayload(s);
  payload.category = category;
  payload.unit_of_measure = uom;
  payload.taxable = Boolean($('#pbTaxable')?.checked);

  if ((Number(payload.unit_price) || 0) <= 0 && !$('#pbZeroConfirm')?.checked) {
    fail('Confirm saving a $0.00 item.'); return;
  }

  $('#pbModalActions').querySelectorAll('button').forEach((b) => (b.disabled = true));
  hint.textContent = 'Saving…';
  try {
    const isUpdate = mode === 'update' && s.pricebookId;
    const url = isUpdate ? `/api/pricebook/${encodeURIComponent(s.pricebookId)}` : '/api/pricebook';
    const res = await fetch(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
    // Sync the modal's choices back onto the working service.
    s.category = category;
    s.unitOfMeasure = uom;
    s.taxable = payload.taxable;
    s.pricebookId = String(data.id || s.pricebookId);
    s.importSource = 'Pricebook';
    s.modifiedAt = new Date().toISOString();
    pbCategories = null; // refresh on next open (a new category may have been added)
    closePricebookSaveModal();
    renderAll();
    showToast(isUpdate ? `Updated price book #${s.pricebookId} ✓` : `Saved to price book #${s.pricebookId} ✓`);
  } catch (e) {
    fail(e.message || 'Save failed');
    $('#pbModalActions').querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}


// ---------- drag & drop reorder ----------
let dragId = null;
function onServiceDragStart(e) {
  const row = e.target.closest('.svc-row'); if (!row) return;
  dragId = row.dataset.svc; row.classList.add('dragging');
}
function onServiceDragOver(e) {
  e.preventDefault();
  const row = e.target.closest('.svc-row');
  document.querySelectorAll('.svc-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
  if (row && row.dataset.svc !== dragId) row.classList.add('drop-target');
}
function onServiceDrop(e) {
  e.preventDefault();
  const row = e.target.closest('.svc-row');
  document.querySelectorAll('.svc-row.dragging,.svc-row.drop-target').forEach((r) => r.classList.remove('dragging', 'drop-target'));
  if (!row || !dragId) return;
  const p = getActivePackage(); if (!p) return;
  const from = p.services.findIndex((s) => s.id === dragId);
  const to = p.services.findIndex((s) => s.id === row.dataset.svc);
  if (from < 0 || to < 0 || from === to) { dragId = null; return; }
  const [moved] = p.services.splice(from, 1);
  p.services.splice(to, 0, moved);
  dragId = null;
  renderServices();
}

// ---------- events ----------
function wireEvents() {
  // theme handled by theme.js

  $('#estimateName').addEventListener('input', (e) => { state.estimateName = e.target.value; });

  document.querySelectorAll('.studio-starter').forEach((b) => b.addEventListener('click', () => loadStarter(b.dataset.starter)));
  document.querySelectorAll('.studio-source-card').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.starter) loadStarter(b.dataset.starter);
    else if (b.dataset.import === 'siterecon') importFromFile('siterecon');
    else if (b.dataset.import === 'spreadsheet') importFromFile('spreadsheet');
    else if (b.dataset.import === 'duplicate') openDuplicate();
    else if (b.dataset.nav) window.location.href = b.dataset.nav;
  }));

  // packages
  $('#addPackage').addEventListener('click', () => {
    const np = pkg('', []); state.packages.push(np);
    applyNamingScheme(); // names the new package (and any other auto-named ones) by position
    setActivePackage(np.id);
  });
  $('#namingScheme').addEventListener('change', (e) => {
    state.namingScheme = e.target.value === 'option' ? 'option' : 'gbb';
    applyNamingScheme();
    renderAll();
  });
  $('#packageList').addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-pkg-action]');
    if (actBtn) {
      e.stopPropagation();
      const id = actBtn.dataset.pkg; const i = state.packages.findIndex((p) => p.id === id);
      const action = actBtn.dataset.pkgAction;
      if (action === 'dupe') { const c = JSON.parse(JSON.stringify(state.packages[i])); c.id = uid(); c.name = `${c.name} copy`; c.services.forEach((s) => { s.id = uid(); }); state.packages.splice(i + 1, 0, c); }
      else if (action === 'del') { if (state.packages.length > 1) { const nm = state.packages[i].name; pushUndo(); state.packages.splice(i, 1); if (state.activePackageId === id) setActivePackage(state.packages[0].id); showToast(`Deleted package “${nm}”.`, 'Undo', doUndo); } }
      else if (action === 'up' && i > 0) { [state.packages[i - 1], state.packages[i]] = [state.packages[i], state.packages[i - 1]]; }
      else if (action === 'down' && i < state.packages.length - 1) { [state.packages[i + 1], state.packages[i]] = [state.packages[i], state.packages[i + 1]]; }
      renderAll();
      return;
    }
    const card = e.target.closest('[data-pkg]');
    if (card) setActivePackage(card.dataset.pkg);
  });
  $('#packageList').addEventListener('input', (e) => {
    const nameEl = e.target.closest('[data-pkg-name]');
    if (!nameEl) return;
    const p = state.packages.find((x) => x.id === nameEl.dataset.pkgName);
    if (p) { p.name = e.target.value; renderHeader(); renderTemplatesBar(); $('#servicesTitle').textContent = `${p.name} — Services`; }
  });
  $('#packageList').addEventListener('change', (e) => {
    const inh = e.target.closest('[data-pkg-inherit]');
    if (!inh) return;
    const p = getPackage(inh.dataset.pkgInherit);
    if (!p) return;
    const target = e.target.value || null;
    if (target && !canInherit(p, target)) { alert('That would create an inheritance loop.'); renderPackages(); return; }
    p.inheritsFrom = target;
    persist();
    renderAll();
  });

  // services
  $('#addService').addEventListener('click', openPicker);
  $('#serviceFilter').addEventListener('input', renderServices);
  const list = $('#serviceList');
  list.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-svc-action]');
    if (actBtn) {
      e.stopPropagation();
      const p = getActivePackage(); if (!p) return;
      if (actBtn.dataset.svcAction === 'override') { overrideInPackage(actBtn.dataset.srcid); return; }
      const id = actBtn.dataset.svc; const i = p.services.findIndex((s) => s.id === id);
      if (actBtn.dataset.svcAction === 'dupe') { const c = JSON.parse(JSON.stringify(p.services[i])); c.id = uid(); c.name = `${c.name} copy`; p.services.splice(i + 1, 0, c); state.activeServiceId = c.id; }
      else if (actBtn.dataset.svcAction === 'del') { const nm = p.services[i] ? p.services[i].name || 'service' : 'service'; pushUndo(); p.services.splice(i, 1); if (state.activeServiceId === id) state.activeServiceId = p.services[0] ? p.services[0].id : null; showToast(`Deleted “${nm}”.`, 'Undo', doUndo); }
      persist();
      renderAll();
      return;
    }
    const row = e.target.closest('[data-svc]');
    if (row) setActiveService(row.dataset.svc);
  });
  list.addEventListener('dragstart', onServiceDragStart);
  list.addEventListener('dragover', onServiceDragOver);
  list.addEventListener('drop', onServiceDrop);

  // editor tabs
  $('#editorTabs').addEventListener('click', (e) => {
    const t = e.target.closest('.editor-tab'); if (!t) return;
    state.activeTab = t.dataset.tab; renderEditor();
  });
  // pinned service name (lives above the tabs, edits the shared name on any tab)
  $('#editorNameInput').addEventListener('input', (e) => {
    const s = getActiveService(); if (!s) return;
    const val = e.target.value;
    if (!s.libraryId) libUpsertFromService(s);
    propagateShared(s.libraryId, 'name', val);
    touch(s);
    persist();
    $('#editorTitle').textContent = val || 'Untitled service';
    renderHeader(); renderPackages(); renderServices(); renderPreflight(); renderCopyBadge();
  });
  // inline add panel (shown in the empty editor) — mirrors the picker drawer
  $('#editorBody').addEventListener('click', (e) => {
    const create = e.target.closest('#editorAddCreate');
    if (create) { addServiceToActive(makeService({ name: (create.dataset.createName || '').trim() || 'New service', kind: 'service' })); return; }
    if (e.target.closest('#editorAddLibrary')) { openLibrary(); return; }
    const pick = e.target.closest('#editorAddResults [data-pick]');
    if (pick) { addServiceFromPick(pick.dataset.pick); return; }
  });
  // Add-new unit-of-measure / frequency option (＋ buttons next to those dropdowns)
  $('#editorBody').addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-add]');
    if (openBtn) {
      const kind = openBtn.dataset.add;
      const wrap = $(`#editorBody [data-add-input="${kind}"]`);
      if (wrap) { wrap.classList.remove('hidden'); const inp = wrap.querySelector('[data-add-field]'); if (inp) { inp.value = ''; inp.focus(); } }
      return;
    }
    const cancelBtn = e.target.closest('[data-add-cancel]');
    if (cancelBtn) {
      const wrap = $(`#editorBody [data-add-input="${cancelBtn.dataset.addCancel}"]`);
      if (wrap) wrap.classList.add('hidden');
      return;
    }
    const saveBtn = e.target.closest('[data-add-save]');
    if (saveBtn) { commitFieldAdd(saveBtn.dataset.addSave); return; }
  });
  $('#editorBody').addEventListener('keydown', (e) => {
    const inp = e.target.closest('[data-add-field]'); if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); commitFieldAdd(inp.dataset.addField); }
    else if (e.key === 'Escape') { const wrap = inp.closest('[data-add-input]'); if (wrap) wrap.classList.add('hidden'); }
  });
  $('#editorBody').addEventListener('input', (e) => {
    const search = e.target.closest('#editorAddSearch'); if (!search) return;
    const q = search.value.trim(); clearTimeout(editorAddTimer);
    const host = $('#editorAddResults'); if (!host) return;
    if (q.length < 2) { host.innerHTML = editorAddResultsHtml(q, []); return; }
    host.innerHTML = editorAddResultsHtml(q, null);
    editorAddTimer = setTimeout(() => runEditorAddSearch(q), 250);
  });
  // editor inputs (auto-save)
  $('#editorBody').addEventListener('input', (e) => {
    const el = e.target.closest('[data-f]'); if (!el) return;
    const s = getActiveService(); if (!s) return;
    const field = el.dataset.f;
    let val = el.type === 'checkbox' ? el.checked : el.value;
    if (NUMERIC_FIELDS.includes(field)) val = toNumber(val, 0);
    if (SHARED_FIELDS.includes(field)) {
      if (!s.libraryId) libUpsertFromService(s);
      propagateShared(s.libraryId, field, val);
    } else {
      s[field] = val;
    }
    touch(s);
    persist();
    // Light updates without losing focus
    renderHeader(); renderPackages(); renderServices(); renderPreflight(); renderCopyBadge();
    if (el.tagName === 'TEXTAREA') autoGrowTextarea(el);
    if (field === 'pricingMode' || field === 'taxable' || field === 'measureType' || field === 'unitOfMeasure') renderEditor();
    else {
      const amt = $('#editorBody .amount-preview .amt');
      if (amt) amt.textContent = money(lineAmount(s));
      if (field === 'basePrice' || field === 'multiplier') {
        const mf = $('#editorBody .measure-formula');
        if (mf) {
          const mt = MEASURE_TYPES.find((m) => m.value === s.measureType);
          mf.innerHTML = `${money(toNumber(s.basePrice, 0))} base + ${measurementValue(s).toLocaleString()} ${esc((mt && mt.unit) || '')} × $${toNumber(s.multiplier, 0)}/${esc((mt && mt.unit) || 'unit')} = <strong>${money(lineAmount(s))}</strong>`;
        }
      }
      $('#editorTitle').textContent = s.name || 'Untitled service';
    }
  });

  // customer
  $('#custSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim(); clearTimeout(custTimer);
    if (q.length < 2) { $('#custResults').classList.add('hidden'); return; }
    custTimer = setTimeout(() => runCustomerSearch(q), 250);
  });
  $('#custChange').addEventListener('click', clearCustomer);

  // property / address modal
  $('#propertyChange').addEventListener('click', openPropertyModal);
  $('#propertyModalClose').addEventListener('click', closePropertyModal);
  $('#propertyModalCancel').addEventListener('click', closePropertyModal);
  $('#propertyModalBackdrop').addEventListener('click', closePropertyModal);
  $('#propertyModalSave').addEventListener('click', savePropertyModal);
  $('#propertyModalBody').addEventListener('change', (e) => {
    const el = e.target.closest('input[type="radio"]'); if (!el) return;
    if (el.name === 'modal-service') propModalSel.service = el.value || null;
    else if (el.name === 'modal-billing') propModalSel.billing = el.value || null;
  });

  $('#btnDry').addEventListener('click', () => submit(true));
  $('#btnSaveDraft').addEventListener('click', saveDraft);
  $('#btnPreview').addEventListener('click', () => setView('preview'));
  $('#btnCreate').addEventListener('click', openHcpPreview);

  // HCP push preview modal
  $('#hcpModalBody').addEventListener('input', onHcpInput);
  $('#hcpModalBody').addEventListener('change', onHcpInput);
  $('#hcpModalBody').addEventListener('click', onHcpClick);
  $('#hcpModalClose').addEventListener('click', closeHcpPreview);
  $('#hcpModalCancel').addEventListener('click', closeHcpPreview);
  $('#hcpModalBackdrop').addEventListener('click', closeHcpPreview);
  $('#hcpModalSaveDraft').addEventListener('click', () => saveDraft());
  $('#hcpModalPush').addEventListener('click', pushHcpPreview);

  // drafts
  $('#btnDrafts').addEventListener('click', openDrafts);
  $('#draftsClose').addEventListener('click', closeDrafts);
  $('#draftsSaveNew').addEventListener('click', saveDraftAsNew);
  $('#draftsResults').addEventListener('click', (e) => {
    const save = e.target.closest('[data-draft-save]');
    if (save) {
      const item = save.closest('.draft-item');
      const input = item && item.querySelector('.draft-rename-input');
      commitRenameDraft(Number(save.dataset.draftSave), input ? input.value : '');
      return;
    }
    const cancel = e.target.closest('[data-draft-cancel]');
    if (cancel) { renderDraftsList(); return; }
    const rename = e.target.closest('[data-draft-rename]');
    if (rename) { renameDraftById(Number(rename.dataset.draftRename)); return; }
    const open = e.target.closest('[data-draft-open]');
    if (open) { openDraftById(Number(open.dataset.draftOpen)); return; }
    const dup = e.target.closest('[data-draft-dup]');
    if (dup) { duplicateDraftById(Number(dup.dataset.draftDup)); return; }
    const del = e.target.closest('[data-draft-del]');
    if (del) { deleteDraftById(Number(del.dataset.draftDel)); return; }
  });

  // picker
  $('#pickerClose').addEventListener('click', closePicker);
  $('#pickerBackdrop').addEventListener('click', () => { closePicker(); closeLibrary(); closeMeasure(); closeDuplicate(); closeDrafts(); });
  $('#pickerSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim(); clearTimeout(pickerTimer);
    if (q.length < 2) { $('#pickerResults').innerHTML = '<div class="hint">Type at least 2 characters…</div>'; return; }
    pickerTimer = setTimeout(() => runPickerSearch(q), 250);
  });
  $('#pickerResults').addEventListener('click', (e) => {
    const item = e.target.closest('[data-pick]'); if (!item) return;
    addServiceFromPick(item.dataset.pick);
  });
  $('#pickerAddBlank').addEventListener('click', () => addServiceToActive(makeService({ name: 'New service', kind: 'service' })));

  // save to price book
  $('#btnGenerateAi').addEventListener('click', () => generateServiceAI('fill'));
  $('#btnRewriteAi').addEventListener('click', () => generateServiceAI('rewrite'));
  $('#btnBulkFill').addEventListener('click', () => bulkGenerateAI('fill'));
  $('#btnBulkRewrite').addEventListener('click', () => bulkGenerateAI('rewrite'));
  const aiStatusEl = $('#aiStatus');
  if (aiStatusEl) aiStatusEl.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('[data-apply-field]');
    const dismissBtn = e.target.closest('[data-dismiss-field]');
    const applyCat = e.target.closest('[data-apply-category]');
    const dismissReview = e.target.closest('[data-dismiss-review]');
    const openPb = e.target.closest('[data-open-pb-item]');
    if (openPb) {
      const pid = openPb.dataset.openPbItem;
      if (pid) window.open(`/pricebook.html?item=${encodeURIComponent(pid)}`, 'pricebookAdmin');
      return;
    }
    if (!applyBtn && !dismissBtn && !applyCat && !dismissReview) return;
    const s = getActiveService(); if (!s) return;
    const run = aiRuns.get(s.id); if (!run) return;
    if (applyBtn) {
      const sf = applyBtn.dataset.applyField;
      const val = run.suggestions[sf];
      if (val) { setServiceField(s, sf, val); run.aiDraft[sf] = val; }
      delete run.suggestions[sf];
      touch(s); persist(); renderEditor();
    } else if (applyCat) {
      const val = applyCat.dataset.applyCategory;
      if (val) setServiceField(s, 'category', val);
      if (run.reviews && run.reviews.category_audit) {
        run.reviews.category_audit = { ...run.reviews.category_audit, correct: true, current_category: val };
      }
      touch(s); persist(); renderEditor();
    } else if (dismissReview) {
      if (run.reviews) delete run.reviews[dismissReview.dataset.dismissReview];
      renderAiStatus(s);
    } else {
      delete run.suggestions[dismissBtn.dataset.dismissField];
      renderAiStatus(s);
    }
  });
  $('#btnSaveToPricebook').addEventListener('click', openPricebookSaveModal);
  $('#pbModalClose').addEventListener('click', closePricebookSaveModal);
  $('#pbModalBackdrop').addEventListener('click', closePricebookSaveModal);
  $('#pbModalActions').addEventListener('click', (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'pbModalCancel') closePricebookSaveModal();
    else if (id === 'pbUpdate') savePricebookItem('update');
    else if (id === 'pbSaveNew') savePricebookItem('new');
  });

  // view toggle
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // templates (dropdown + management wired in initTemplateManagement())
  $('#btnSaveTemplate').addEventListener('click', saveAsTemplate);

  // service library drawer
  $('#btnLibrary').addEventListener('click', openLibrary);
  $('#libClose').addEventListener('click', closeLibrary);
  $('#libSearch').addEventListener('input', (e) => { const q = e.target.value; clearTimeout(libTimer); libTimer = setTimeout(() => renderLibraryList(q), 120); });
  $('#libResults').addEventListener('click', (e) => { const it = e.target.closest('[data-lib]'); if (it) addLibraryToActive(it.dataset.lib); });

  // division
  const divSel = $('#divisionSelect');
  divSel.innerHTML = DIVISIONS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  divSel.value = state.division;
  divSel.addEventListener('change', (e) => { state.division = e.target.value; renderHeader(); if (state.view === 'preview') renderPreview(); });

  // measurements drawer
  $('#btnMeasure').addEventListener('click', openMeasure);
  $('#measureClose').addEventListener('click', closeMeasure);
  $('#dupClose').addEventListener('click', closeDuplicate);
  $('#measureDrawer').addEventListener('input', (e) => {
    const el = e.target.closest('[data-m]'); if (!el) return;
    state.measurements[el.dataset.m] = toNumber(el.value, 0);
    renderHeader(); renderPackages(); renderServices(); renderEditor(); renderPreflight();
  });

  // customer-copy rollup badge
  $('#copyBadge').addEventListener('click', jumpToMissingCopy);

  // warn before losing unsaved working packages (not persisted across refresh)
  window.addEventListener('beforeunload', (e) => {
    if (state.packages.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // keyboard: Esc closes drawers
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); closeLibrary(); closeMeasure(); closeDuplicate(); closeDrafts(); closePropertyModal(); closePricebookSaveModal(); } });
}

// ===================================================================
// Template management: action menus, modals, homepage cards, migration
// ===================================================================

// Curated emoji icon set for homepage cards (stable identifier = the emoji char).
const TPL_ICONS = [
  { c: '📋', k: 'clipboard list estimate default' }, { c: '🌿', k: 'landscaping plant leaf lawn' },
  { c: '🌳', k: 'tree services' }, { c: '🌲', k: 'evergreen tree' }, { c: '🏠', k: 'house home' },
  { c: '🏡', k: 'house home garden' }, { c: '🧱', k: 'brick construction wall' }, { c: '🔨', k: 'hammer construction' },
  { c: '🛠️', k: 'tools repair' }, { c: '🪚', k: 'saw wood cut' }, { c: '🚿', k: 'pressure wash shower' },
  { c: '💧', k: 'water wash clean' }, { c: '🪟', k: 'window cleaning glass' }, { c: '❄️', k: 'snow removal winter ice' },
  { c: '🔥', k: 'firewood fire heat' }, { c: '🪵', k: 'wood log firewood lumber' }, { c: '🌱', k: 'seed grow lawn sprout' },
  { c: '🍂', k: 'leaf fall cleanup autumn' }, { c: '🚜', k: 'tractor equipment machine' }, { c: '⚡', k: 'fast quick electric' },
  { c: '💼', k: 'business commercial' }, { c: '📦', k: 'package box bundle' }, { c: '💰', k: 'money price quote cost' },
  { c: '⭐', k: 'star favorite featured' }, { c: '🧾', k: 'receipt invoice bill' }, { c: '📐', k: 'measure ruler' },
  { c: '🧹', k: 'clean sweep broom' }, { c: '🪴', k: 'plant potted garden' }, { c: '🌸', k: 'flower garden bloom' },
  { c: '☀️', k: 'sun summer warm' },
];

function fmtDate(s) {
  try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}

// ---- per-template action menu (floating) ----
let tplActionMenuEl = null;
function closeTplActionMenu() { if (tplActionMenuEl) { tplActionMenuEl.remove(); tplActionMenuEl = null; } }
function openTplActionMenu(anchor, tpl) {
  closeTplActionMenu();
  const featured = tpl.is_featured_on_homepage;
  const hidden = tpl.status === 'hidden';
  const items = [];
  if (!hidden) items.push(['load', 'Load template']);
  items.push(['rename', 'Rename']);
  items.push(['edit', 'Edit details']);
  if (!hidden) {
    if (featured) { items.push(['home-edit', 'Edit homepage card']); items.push(['unfeature', 'Remove from homepage']); }
    else items.push(['feature', 'Add to homepage']);
  }
  if (hidden) items.push(['restore', 'Restore to dropdown']);
  else items.push(['hide', 'Hide from dropdown']);
  items.push(['delete', 'Delete', 'danger']);

  const el = document.createElement('div');
  el.className = 'tpl-actionmenu';
  el.innerHTML = items.map(([act, label, cls]) => `<button type="button" class="tpl-action ${cls || ''}" data-act="${act}">${esc(label)}</button>`).join('');
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8))}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    e.stopPropagation();
    const act = b.dataset.act;
    closeTplActionMenu();
    handleTplAction(act, tpl);
  });
  tplActionMenuEl = el;
}
function handleTplAction(act, tpl) {
  switch (act) {
    case 'load': closeTemplateMenu(); loadTemplate(tpl.id); break;
    case 'rename': renameTemplateFlow(tpl); break;
    case 'edit': editDetailsFlow(tpl); break;
    case 'feature': case 'home-edit': addToHomepageFlow(tpl); break;
    case 'unfeature': unfeatureFlow(tpl); break;
    case 'hide': hideTemplateFlow(tpl); break;
    case 'restore': restoreTemplateFlow(tpl); break;
    case 'delete': deleteTemplateFlow(tpl); break;
  }
}

// ---- generic modal builder (reuses .studio-modal design system) ----
function buildModal({ title, bodyHtml, actionsHtml, wide }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'studio-modal-backdrop tpl-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = `studio-modal tpl-modal${wide ? ' wide' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', title);
  modal.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn tpl-modal-x" title="Close" aria-label="Close">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${actionsHtml}</div>`;
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
  const close = () => { backdrop.remove(); modal.remove(); };
  backdrop.addEventListener('click', close);
  modal.querySelector('.tpl-modal-x').addEventListener('click', close);
  return { backdrop, modal, close, q: (s) => modal.querySelector(s) };
}

// ---- flows ----
function renameTemplateFlow(tpl) {
  const m = buildModal({
    title: 'Rename template',
    bodyHtml: `
      <label class="field"><span>Template name</span>
        <input type="text" id="tplRenameInput" value="${esc(tpl.name)}" maxlength="200" autocomplete="off" />
      </label>
      <div class="tpl-form-error hidden" id="tplRenameErr"></div>`,
    actionsHtml: `<button class="studio-btn" data-x>Cancel</button><button class="studio-btn primary" id="tplRenameSave">Save</button>`,
  });
  m.q('[data-x]').addEventListener('click', m.close);
  const input = m.q('#tplRenameInput');
  input.focus(); input.select();
  const save = async () => {
    const name = input.value.trim();
    const errEl = m.q('#tplRenameErr');
    if (!name) { errEl.textContent = 'Name cannot be empty.'; errEl.classList.remove('hidden'); return; }
    try {
      await TAPI.update(tpl.id, { name });
      m.close();
      if (Number(state.activeTemplateId) === Number(tpl.id)) state.estimateName = name;
      await refreshTemplates(); await refreshManagerIfOpen();
      if (Number(state.activeTemplateId) === Number(tpl.id)) renderAll();
      flash(`Renamed to “${name}”.`, 'ok');
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  };
  m.q('#tplRenameSave').addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

function editDetailsFlow(tpl) {
  const divOpts = DIVISIONS.map((d) => `<option value="${esc(d)}"${d === tpl.division ? ' selected' : ''}>${esc(d)}</option>`).join('');
  const m = buildModal({
    title: 'Edit details',
    bodyHtml: `
      <label class="field"><span>Name</span><input type="text" id="tplEdName" value="${esc(tpl.name)}" maxlength="200" autocomplete="off" /></label>
      <label class="field"><span>Description</span><textarea id="tplEdDesc" rows="2">${esc(tpl.description || '')}</textarea></label>
      <label class="field"><span>Division</span><select id="tplEdDiv"><option value="">—</option>${divOpts}</select></label>
      <label class="field"><span>Category (optional)</span><input type="text" id="tplEdCat" value="${esc(tpl.category || '')}" autocomplete="off" /></label>
      <div class="tpl-form-error hidden" id="tplEdErr"></div>`,
    actionsHtml: `<button class="studio-btn" data-x>Cancel</button><button class="studio-btn primary" id="tplEdSave">Save</button>`,
  });
  m.q('[data-x]').addEventListener('click', m.close);
  m.q('#tplEdSave').addEventListener('click', async () => {
    const name = m.q('#tplEdName').value.trim();
    const errEl = m.q('#tplEdErr');
    if (!name) { errEl.textContent = 'Name cannot be empty.'; errEl.classList.remove('hidden'); return; }
    try {
      await TAPI.update(tpl.id, { name, description: m.q('#tplEdDesc').value, division: m.q('#tplEdDiv').value || null, category: m.q('#tplEdCat').value || null });
      m.close();
      if (Number(state.activeTemplateId) === Number(tpl.id)) state.estimateName = name;
      await refreshTemplates(); await refreshManagerIfOpen();
      if (Number(state.activeTemplateId) === Number(tpl.id)) renderAll();
      flash('Details saved.', 'ok');
    } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
  });
}

function addToHomepageFlow(tpl) {
  const editing = tpl.is_featured_on_homepage;
  let selectedIcon = tpl.homepage_icon || '📋';
  const m = buildModal({
    title: editing ? 'Edit homepage card' : 'Add to homepage',
    wide: true,
    bodyHtml: `
      <div class="tpl-home-grid">
        <div class="tpl-home-form">
          <label class="field"><span>Icon</span></label>
          <input type="text" id="tplIconSearch" class="studio-input" placeholder="Search icons…" autocomplete="off" />
          <div class="tpl-icon-grid" id="tplIconGrid"></div>
          <label class="field"><span>Short description (optional)</span>
            <textarea id="tplHomeDesc" rows="3" placeholder="Send a follow-up message to customers with an outstanding estimate.">${esc(tpl.homepage_description || '')}</textarea>
          </label>
        </div>
        <div class="tpl-home-preview">
          <span class="tpl-preview-label">Homepage card preview</span>
          <div class="studio-featured-card preview" id="tplPreviewCard"></div>
        </div>
      </div>`,
    actionsHtml: `<button class="studio-btn" data-x>Cancel</button><button class="studio-btn primary" id="tplHomeSave">${editing ? 'Save changes' : 'Add to homepage'}</button>`,
  });
  m.q('[data-x]').addEventListener('click', m.close);
  const grid = m.q('#tplIconGrid');
  const renderIcons = (q) => {
    const term = (q || '').trim().toLowerCase();
    const list = TPL_ICONS.filter((i) => !term || i.k.includes(term) || i.c === term);
    grid.innerHTML = list.map((i) => `<button type="button" class="tpl-icon${i.c === selectedIcon ? ' sel' : ''}" data-icon="${i.c}" title="${esc(i.k)}">${i.c}</button>`).join('')
      || '<div class="tpl-icon-empty">No icons match.</div>';
  };
  const renderPreview = () => {
    const desc = m.q('#tplHomeDesc').value.trim();
    m.q('#tplPreviewCard').innerHTML = `
      <span class="fc-icon" aria-hidden="true">${esc(selectedIcon)}</span>
      <div class="fc-name">${esc(tpl.name)}</div>
      ${desc ? `<div class="fc-desc">${esc(desc)}</div>` : ''}
      <div class="fc-open">Open Template →</div>`;
  };
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-icon]'); if (!b) return;
    selectedIcon = b.dataset.icon;
    renderIcons(m.q('#tplIconSearch').value); renderPreview();
  });
  m.q('#tplIconSearch').addEventListener('input', (e) => renderIcons(e.target.value));
  m.q('#tplHomeDesc').addEventListener('input', renderPreview);
  renderIcons(''); renderPreview();
  m.q('#tplHomeSave').addEventListener('click', async () => {
    try {
      const description = m.q('#tplHomeDesc').value.trim();
      await TAPI.feature(tpl.id, { icon: selectedIcon, description });
      m.close();
      await refreshTemplates(); await refreshManagerIfOpen();
      flash(editing ? `Updated “${tpl.name}” homepage card.` : `Added “${tpl.name}” to the homepage.`, 'ok');
    } catch (e) { flash(e.message, 'err'); }
  });
}

async function unfeatureFlow(tpl) {
  try {
    await TAPI.unfeature(tpl.id);
    await refreshTemplates(); await refreshManagerIfOpen();
    flash(`Removed “${tpl.name}” from the homepage.`, 'ok');
  } catch (e) { flash(e.message, 'err'); }
}

function hideTemplateFlow(tpl) {
  const m = buildModal({
    title: 'Hide template',
    bodyHtml: `<p class="tpl-confirm-text">Hide “${esc(tpl.name)}” from the dropdown? You can restore it later from Template Management.</p>`,
    actionsHtml: `<button class="studio-btn" data-x>Cancel</button><button class="studio-btn primary" id="tplHideOk">Hide from dropdown</button>`,
  });
  m.q('[data-x]').addEventListener('click', m.close);
  m.q('#tplHideOk').addEventListener('click', async () => {
    try {
      await TAPI.hide(tpl.id);
      if (Number(state.activeTemplateId) === Number(tpl.id)) state.activeTemplateId = null;
      m.close();
      await refreshTemplates(); await refreshManagerIfOpen();
      flash(`“${tpl.name}” hidden. Restore it anytime from Template Management.`, 'ok');
    } catch (e) { flash(e.message, 'err'); }
  });
}

async function restoreTemplateFlow(tpl) {
  try {
    await TAPI.restore(tpl.id);
    await refreshTemplates(); await refreshManagerIfOpen();
    flash(`Restored “${tpl.name}” to the dropdown.`, 'ok');
  } catch (e) { flash(e.message, 'err'); }
}

function deleteTemplateFlow(tpl) {
  const m = buildModal({
    title: 'Delete template',
    bodyHtml: `<p class="tpl-confirm-text danger">Permanently delete “${esc(tpl.name)}”? This cannot be undone — the template and its homepage card will be removed.</p>`,
    actionsHtml: `<button class="studio-btn" data-x>Cancel</button><button class="studio-btn danger" id="tplDelOk">Delete permanently</button>`,
  });
  m.q('[data-x]').addEventListener('click', m.close);
  m.q('#tplDelOk').addEventListener('click', async () => {
    try {
      await TAPI.remove(tpl.id);
      if (Number(state.activeTemplateId) === Number(tpl.id)) state.activeTemplateId = null;
      m.close();
      await refreshTemplates(); await refreshManagerIfOpen();
      flash(`Deleted “${tpl.name}”.`, 'ok');
    } catch (e) { flash(e.message, 'err'); }
  });
}

// ---- Template Management screen ----
let managerModal = null;
let managerState = null;
let managerCache = [];
async function loadManagerCache() {
  try { managerCache = await TAPI.list({ status: 'all' }); } catch (_) { managerCache = []; }
}
async function refreshManagerIfOpen() { if (managerModal) { await loadManagerCache(); renderManagerTable(); } }
function renderManagerTable() {
  if (!managerModal) return;
  const { tab, search } = managerState;
  managerModal.modal.querySelectorAll('.tpl-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const q = (search || '').trim().toLowerCase();
  let rows = managerCache.slice();
  if (tab === 'active') rows = rows.filter((t) => t.status === 'active');
  else if (tab === 'hidden') rows = rows.filter((t) => t.status === 'hidden');
  else if (tab === 'homepage') rows = rows.filter((t) => t.is_featured_on_homepage);
  if (q) rows = rows.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q));
  const body = managerModal.q('#tplMgrRows');
  if (!rows.length) { body.innerHTML = `<tr><td colspan="5" class="tpl-mgr-empty">No templates in this view.</td></tr>`; return; }
  body.innerHTML = rows.map((t) => `<tr>
    <td class="tpl-mgr-name">${esc(t.name)}</td>
    <td><span class="tpl-badge ${t.status}">${t.status === 'hidden' ? 'Hidden' : 'Active'}</span></td>
    <td>${t.is_featured_on_homepage ? '<span class="tpl-badge home">Yes</span>' : '<span class="tpl-muted">No</span>'}</td>
    <td class="tpl-mgr-date">${t.updated_at ? fmtDate(t.updated_at) : ''}</td>
    <td class="tpl-mgr-actions"><button type="button" class="icon-btn" data-tpl-menu="${t.id}" title="Actions" aria-label="Actions">⋯</button></td>
  </tr>`).join('');
}
async function openTemplateManager(tab = 'active') {
  managerState = { tab, search: '' };
  const m = buildModal({
    title: 'Template Management',
    wide: true,
    bodyHtml: `
      <div class="tpl-mgr">
        <div class="tpl-mgr-top">
          <input type="text" id="tplMgrSearch" class="studio-input" placeholder="Search templates…" autocomplete="off" />
          <div class="tpl-mgr-tabs" role="tablist">
            <button class="tpl-tab" data-tab="active" role="tab">Active</button>
            <button class="tpl-tab" data-tab="hidden" role="tab">Hidden</button>
            <button class="tpl-tab" data-tab="homepage" role="tab">Homepage</button>
          </div>
        </div>
        <div class="tpl-mgr-tablewrap">
          <table class="tpl-mgr-table">
            <thead><tr><th>Template</th><th>Status</th><th>Homepage</th><th>Updated</th><th></th></tr></thead>
            <tbody id="tplMgrRows"></tbody>
          </table>
        </div>
      </div>`,
    actionsHtml: `<button class="studio-btn" data-x>Close</button>`,
  });
  managerModal = m;
  const close = () => { m.close(); managerModal = null; closeTplActionMenu(); };
  m.q('[data-x]').addEventListener('click', close);
  m.backdrop.addEventListener('click', () => { managerModal = null; });
  m.modal.querySelector('.tpl-modal-x').addEventListener('click', () => { managerModal = null; });
  m.modal.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { managerState.tab = tabBtn.dataset.tab; renderManagerTable(); return; }
    const mb = e.target.closest('[data-tpl-menu]');
    if (mb) { e.stopPropagation(); const tpl = managerCache.find((t) => Number(t.id) === Number(mb.dataset.tplMenu)); if (tpl) openTplActionMenu(mb, tpl); }
  });
  m.q('#tplMgrSearch').addEventListener('input', (e) => { managerState.search = e.target.value; renderManagerTable(); });
  await loadManagerCache();
  renderManagerTable();
}

// ---- homepage featured cards (rendered into #featuredTemplates on quickStart) ----
function renderFeaturedCards() {
  const host = $('#featuredTemplates');
  if (!host) return;
  if (!tplFeatured.length) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = `
    <h3 class="studio-featured-title">Featured templates</h3>
    <div class="studio-featured-grid">${tplFeatured.map((t) => {
      const icon = t.homepage_icon || '📋';
      const desc = t.homepage_description || t.description || '';
      const meta = [t.category, t.updated_at ? `Updated ${fmtDate(t.updated_at)}` : ''].filter(Boolean).join(' · ');
      return `<div class="studio-featured-card" data-load-card="${t.id}" draggable="true" title="Open “${esc(t.name)}”">
        <button type="button" class="icon-btn fc-menu" data-tpl-menu="${t.id}" title="Card actions" aria-label="Card actions">⋯</button>
        <span class="fc-icon" aria-hidden="true">${esc(icon)}</span>
        <div class="fc-name">${esc(t.name)}</div>
        ${desc ? `<div class="fc-desc">${esc(desc)}</div>` : ''}
        ${meta ? `<div class="fc-meta">${esc(meta)}</div>` : ''}
        <div class="fc-open">Open Template →</div>
      </div>`;
    }).join('')}</div>`;
}

let fcDragId = null;
function onFcDragStart(e) { const c = e.target.closest('[data-load-card]'); if (!c) return; fcDragId = c.dataset.loadCard; c.classList.add('dragging'); }
function onFcDragOver(e) {
  e.preventDefault();
  const c = e.target.closest('[data-load-card]');
  document.querySelectorAll('.studio-featured-card.drop-target').forEach((x) => x.classList.remove('drop-target'));
  if (c && c.dataset.loadCard !== fcDragId) c.classList.add('drop-target');
}
function onFcDragEnd() {
  document.querySelectorAll('.studio-featured-card.dragging,.studio-featured-card.drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
  fcDragId = null;
}
async function onFcDrop(e) {
  e.preventDefault();
  const c = e.target.closest('[data-load-card]');
  document.querySelectorAll('.studio-featured-card.dragging,.studio-featured-card.drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
  if (!c || !fcDragId) { fcDragId = null; return; }
  const from = tplFeatured.findIndex((t) => Number(t.id) === Number(fcDragId));
  const to = tplFeatured.findIndex((t) => Number(t.id) === Number(c.dataset.loadCard));
  fcDragId = null;
  if (from < 0 || to < 0 || from === to) return;
  const arr = tplFeatured.slice();
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  tplFeatured = arr;
  renderFeaturedCards();
  try { await TAPI.reorder(tplFeatured.map((t) => t.id)); }
  catch (err) { flash(err.message, 'err'); await refreshTemplates(); }
}

// ---- one-time localStorage -> server migration ----
async function migrateLocalTemplates() {
  const FLAG = 'scopefoundry-studio-templates-migrated';
  if (localStorage.getItem(FLAG) === '1') return;
  let legacy = [];
  try { const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); if (Array.isArray(raw.templates)) legacy = raw.templates; } catch (_) { /* ignore */ }
  if (!legacy.length) { localStorage.setItem(FLAG, '1'); return; }
  let imported = 0;
  for (const t of legacy) {
    try {
      await TAPI.create({
        name: t.name || t.baseName || 'Imported template',
        division: t.division || null,
        body: { measurements: t.measurements || {}, packages: Array.isArray(t.packages) ? t.packages : [] },
      });
      imported++;
    } catch (_) { /* duplicate/invalid — skip; legacy data kept in localStorage as backup */ }
  }
  localStorage.setItem(FLAG, '1');
  if (imported) flash(`Imported ${imported} saved template${imported === 1 ? '' : 's'} to the server.`, 'ok');
}

// ---- wiring ----
function initTemplateManagement() {
  const trig = $('#templateTrigger');
  if (trig) trig.addEventListener('click', (e) => { e.stopPropagation(); tplMenuOpen ? closeTemplateMenu() : openTemplateMenu(); });
  const menu = $('#templateMenu');
  if (menu) menu.addEventListener('click', (e) => {
    const mbtn = e.target.closest('[data-tpl-menu]');
    if (mbtn) { e.stopPropagation(); const tpl = tplById(mbtn.dataset.tplMenu); if (tpl) openTplActionMenu(mbtn, tpl); return; }
    const mgr = e.target.closest('[data-open-manager]');
    if (mgr) { closeTemplateMenu(); openTemplateManager('active'); return; }
    const load = e.target.closest('[data-load]');
    if (load) { closeTemplateMenu(); loadTemplate(load.dataset.load); }
  });
  const fc = $('#featuredTemplates');
  if (fc) {
    fc.addEventListener('click', (e) => {
      const menuBtn = e.target.closest('[data-tpl-menu]');
      if (menuBtn) { e.stopPropagation(); const tpl = tplById(menuBtn.dataset.tplMenu); if (tpl) openTplActionMenu(menuBtn, tpl); return; }
      const card = e.target.closest('[data-load-card]');
      if (card) loadTemplate(card.dataset.loadCard);
    });
    fc.addEventListener('dragstart', onFcDragStart);
    fc.addEventListener('dragover', onFcDragOver);
    fc.addEventListener('drop', onFcDrop);
    fc.addEventListener('dragend', onFcDragEnd);
  }
  // Click-away + Esc close the dropdown/action menus.
  document.addEventListener('click', (e) => {
    if (tplMenuOpen && !e.target.closest('#templateDropdown') && !e.target.closest('.tpl-actionmenu')) closeTemplateMenu();
    if (tplActionMenuEl && !e.target.closest('.tpl-actionmenu') && !e.target.closest('[data-tpl-menu]')) closeTplActionMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTemplateMenu(); closeTplActionMenu(); } });
}

restore();
renderTemplatesBar();
wireEvents();
initTemplateManagement();
updateDraftButton();
offerResumeDraft();
(async () => { await migrateLocalTemplates(); await refreshTemplates(); })();

