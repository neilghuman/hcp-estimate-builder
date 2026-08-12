// Parse an uploaded Excel/CSV into grouped estimate options.
// One row = one line item. The `option` column groups rows into HCP options.
//
// Column headers are matched case/space/punctuation-insensitively, with
// synonyms, so the sheet can be tweaked without touching code.

import xlsx from 'xlsx';

const DEFAULT_LINE_KIND = process.env.DEFAULT_LINE_KIND || 'labor';

// Map many possible header spellings to our canonical field names.
const HEADER_SYNONYMS = {
  option: ['option', 'package', 'tier', 'group', 'optionname'],
  optionMessage: ['optionmessage', 'message', 'optionmsg', 'msg', 'optiondescription', 'optionnote'],
  name: ['linename', 'name', 'item', 'lineitem', 'service', 'product', 'title'],
  description: ['description', 'desc', 'details', 'detail', 'notes', 'note'],
  quantity: ['quantity', 'qty', 'count', 'units'],
  unitOfMeasure: ['unitofmeasure', 'uom', 'unit', 'measure', 'measurementunit'],
  frequency: ['frequency', 'freq', 'recurrence', 'billingfrequency', 'schedule', 'cadence'],
  pricingMode: ['pricingmode', 'pricing', 'pricetype', 'pricemode', 'ratetype'],
  flatAmount: ['flatamount', 'flat', 'flatrate', 'flatprice', 'fixedamount', 'fixedprice', 'override', 'overrideamount'],
  unitPrice: ['unitprice', 'price', 'rate', 'amount', 'cost', 'unitcost'],
  kind: ['kind', 'type', 'category'],
  taxable: ['taxable', 'tax', 'istaxable'],
};

const FREQUENCY_VALUES = new Set([
  'single', 'weekly', 'bi-weekly', 'twice-monthly', 'monthly', 'quarterly', 'every-6-months', 'annually',
]);

const FREQUENCY_ALIASES = {
  single: 'single', onetime: 'single', once: 'single', 'one-time': 'single', '': 'single',
  weekly: 'weekly', week: 'weekly',
  biweekly: 'bi-weekly', 'bi-weekly': 'bi-weekly', everyotherweek: 'bi-weekly', fortnightly: 'bi-weekly',
  twicemonthly: 'twice-monthly', 'twice-monthly': 'twice-monthly', twiceamonth: 'twice-monthly', semimonthly: 'twice-monthly',
  monthly: 'monthly', month: 'monthly',
  quarterly: 'quarterly', quarter: 'quarterly',
  every6months: 'every-6-months', 'every-6-months': 'every-6-months', semiannually: 'every-6-months', biannually: 'every-6-months',
  annually: 'annually', annual: 'annually', yearly: 'annually', year: 'annually',
};

function normalizeFrequency(v) {
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw) return 'single';
  if (FREQUENCY_VALUES.has(raw)) return raw;
  const key = raw.replace(/[^a-z0-9-]/g, '');
  if (FREQUENCY_ALIASES[key]) return FREQUENCY_ALIASES[key];
  if (FREQUENCY_ALIASES[raw]) return FREQUENCY_ALIASES[raw];
  return 'single';
}

function normalizePricingMode(v) {
  const raw = String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (['flat', 'flatrate', 'fixed', 'override'].includes(raw)) return 'flat';
  return 'calculated';
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderMap(rawHeaders) {
  const map = {};
  const normalized = rawHeaders.map((h, i) => ({ i, n: normalizeHeader(h) }));
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) {
    const hit = normalized.find((col) => syns.includes(col.n));
    if (hit) map[field] = hit.i;
  }
  return map;
}

function parseBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  return ['yes', 'y', 'true', 't', '1', 'taxable'].includes(s);
}

function parseNumber(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

// Returns { options: [...], warnings: [...], errors: [...] }
export function parseEstimateWorkbook(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { options: [], warnings: [], errors: ['The file has no sheets.'] };

  const sheet = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (rows.length < 2) {
    return { options: [], warnings: [], errors: ['The sheet needs a header row and at least one line item.'] };
  }

  const headerMap = buildHeaderMap(rows[0]);
  const errors = [];
  const warnings = [];

  if (headerMap.name === undefined) errors.push('Missing a line-item name column (e.g. "line_name" or "name").');
  if (headerMap.unitPrice === undefined) errors.push('Missing a price column (e.g. "unit_price" or "price").');
  if (headerMap.option === undefined) {
    warnings.push('No "option" column found — all line items will go into a single option named "Option #1".');
  }
  if (errors.length) return { options: [], warnings, errors };

  const cell = (row, field) => (headerMap[field] === undefined ? '' : row[headerMap[field]]);

  // Group rows into options, preserving first-seen order.
  const order = [];
  const byOption = new Map();

  rows.slice(1).forEach((row, idx) => {
    const rowNum = idx + 2; // 1-based, plus header
    const name = String(cell(row, 'name') ?? '').trim();
    const isEmpty = row.every((c) => String(c ?? '').trim() === '');
    if (isEmpty) return;
    if (!name) {
      warnings.push(`Row ${rowNum}: skipped (no line-item name).`);
      return;
    }

    const optName = String(cell(row, 'option') ?? '').trim() || 'Option #1';
    if (!byOption.has(optName)) {
      order.push(optName);
      byOption.set(optName, { name: optName, message: '', lineItems: [] });
    }
    const opt = byOption.get(optName);

    const optMsg = String(cell(row, 'optionMessage') ?? '').trim();
    if (optMsg && !opt.message) opt.message = optMsg;

    const unitPrice = parseNumber(cell(row, 'unitPrice'), null);
    if (unitPrice === null) warnings.push(`Row ${rowNum}: price is empty or not a number — using 0.`);

    const pricingMode = normalizePricingMode(cell(row, 'pricingMode'));
    opt.lineItems.push({
      name,
      description: String(cell(row, 'description') ?? '').trim() || null,
      quantity: parseNumber(cell(row, 'quantity'), 1),
      unitOfMeasure: String(cell(row, 'unitOfMeasure') ?? '').trim() || null,
      frequency: normalizeFrequency(cell(row, 'frequency')),
      pricingMode,
      flatAmount: parseNumber(cell(row, 'flatAmount'), 0),
      unitPrice: unitPrice ?? 0,
      kind: String(cell(row, 'kind') ?? '').trim() || DEFAULT_LINE_KIND,
      taxable: headerMap.taxable === undefined ? false : parseBool(cell(row, 'taxable')),
    });
  });

  const options = order.map((n) => {
    const o = byOption.get(n);
    const total = o.lineItems.reduce(
      (s, li) => s + (li.pricingMode === 'flat' ? li.flatAmount : li.quantity * li.unitPrice),
      0,
    );
    return { ...o, total };
  });

  if (!options.length) errors.push('No usable line items found.');

  return { options, warnings, errors };
}
