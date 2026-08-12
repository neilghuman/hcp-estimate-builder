import xlsx from 'xlsx';
import { SITERECON_RULES, buildLayerAliasMap, normalizeLayerLabel } from './siterecon-config.js';

const NUMERIC_HEADER_HINTS = [
  'quantity',
  'qty',
  'area',
  'sqft',
  'squarefeet',
  'length',
  'feet',
  'ft',
  'count',
  'total',
];
const LAYER_HEADER_HINTS = ['layer', 'surface', 'feature', 'name', 'description', 'item'];
const DEFAULT_LINE_KIND = process.env.DEFAULT_LINE_KIND || 'labor';

export async function parseSiteReconWorkbook(pool, buffer) {
  const extraction = extractSiteReconMeasurements(buffer);
  if (extraction.errors.length) {
    return {
      options: [],
      warnings: extraction.warnings,
      errors: extraction.errors,
    };
  }

  const draft = await buildSiteReconDraft(pool, extraction);
  return {
    options: draft.options,
    warnings: [...extraction.warnings, ...draft.warnings],
    errors: [],
    siterecon: draft.siterecon,
  };
}

export async function buildSiteReconDraft(pool, extraction, config = SITERECON_RULES) {
  const warnings = [];
  const mappings = config.layerMappings || {};
  const tierOrder = config.tierOrder || ['best', 'better', 'good'];
  const tierRules = config.tierRules || {};
  const optionNames = { ...(config.defaults?.optionNames || {}) };

  const measurements = extraction.measurements.map((m) => ({ ...m }));
  applyOverlapRules(measurements, config.overlapRules || []);

  const itemIds = Array.from(new Set(
    measurements
      .filter((m) => m.status === 'mapped' && !m.suppressed)
      .map((m) => mappings[m.mappingKey]?.pricebookItemId)
      .filter((id) => Number.isFinite(Number(id))),
  ));

  const pricebookMap = await loadPricebookItems(pool, itemIds);
  const baseLines = [];

  for (const measurement of measurements) {
    if (measurement.status !== 'mapped') {
      continue;
    }
    if (measurement.suppressed) {
      measurement.status = 'suppressed';
      continue;
    }

    const mapping = mappings[measurement.mappingKey];
    if (!mapping || mapping.referenceOnly || !mapping.active) {
      measurement.status = mapping?.referenceOnly ? 'reference-only' : 'inactive';
      continue;
    }

    const itemId = Number(mapping.pricebookItemId);
    const pricebookItem = pricebookMap.get(itemId);
    if (!pricebookItem) {
      measurement.status = 'missing-pricebook-item';
      warnings.push(`Layer "${measurement.layerLabel}" mapped to item ${itemId}, but that item was not found in pricebook.`);
      continue;
    }

    const quantity = roundQuantity(measurement.quantity, config.defaults?.quantityPrecision ?? 4);
    const lineId = `${measurement.mappingKey}:${itemId}`;
    const unitPrice = Number(pricebookItem.unit_price || 0);
    const unitOfMeasure = pricebookItem.unit_of_measure || mapping.unit || null;
    const category = pricebookItem.category || mapping.category || 'Uncategorized';

    baseLines.push({
      id: lineId,
      mappingKey: measurement.mappingKey,
      layerLabel: measurement.layerLabel,
      category,
      pricebookItemId: itemId,
      lineItem: {
        name: pricebookItem.name,
        description: `SiteRecon layer: ${measurement.layerLabel}`,
        quantity,
        unitOfMeasure,
        unitPrice,
        kind: pricebookItem.kind || DEFAULT_LINE_KIND,
        taxable: true,
      },
    });
  }

  const options = buildOptionsFromBaseLines(baseLines, { tierOrder, tierRules, optionNames });

  return {
    warnings,
    options,
    siterecon: {
      rulesVersion: config.rulesVersion,
      tierOrder,
      optionNames,
      tierRules,
      measurements,
      baseLines,
    },
  };
}

export function buildOptionsFromBaseLines(baseLines, { tierOrder, tierRules, optionNames, removedLineIds = [] }) {
  const removed = new Set(removedLineIds || []);
  return tierOrder.map((tierKey, idx) => {
    const excludeCategories = new Set(tierRules[tierKey]?.excludeCategories || []);
    const lineItems = baseLines
      .filter((line) => !removed.has(line.id))
      .filter((line) => !excludeCategories.has(line.category))
      .map((line) => ({ ...line.lineItem }));

    const total = lineItems.reduce((sum, li) => sum + Number(li.quantity || 0) * Number(li.unitPrice || 0), 0);
    return {
      key: tierKey,
      name: optionNames[tierKey] || `Option ${idx + 1}`,
      message: null,
      lineItems,
      total,
    };
  });
}

export function extractSiteReconMeasurements(buffer, config = SITERECON_RULES) {
  const warnings = [];
  const errors = [];
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { measurements: [], warnings, errors: ['The file has no sheets.'] };
  }

  const sheet = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) {
    return { measurements: [], warnings, errors: ['The SiteRecon workbook appears to be empty.'] };
  }

  const structure = detectStructure(rows);
  if (!structure.detected) {
    warnings.push('Could not detect SiteRecon headers confidently. Used fallback row scanning.');
  }

  const aliases = buildLayerAliasMap(config);
  const mappings = config.layerMappings || {};
  const quantities = new Map();

  const startAt = structure.headerRowIndex + 1;
  for (let i = Math.max(startAt, 0); i < rows.length; i++) {
    const row = rows[i];
    const extracted = extractRow(row, structure);
    if (!extracted) {
      continue;
    }

    const mappingKey = aliases.get(normalizeLayerLabel(extracted.layerLabel));
    if (!mappingKey) {
      warnings.push(`Row ${i + 1}: Unmapped layer "${extracted.layerLabel}" skipped.`);
      continue;
    }

    const current = quantities.get(mappingKey) || 0;
    quantities.set(mappingKey, current + extracted.quantity);
  }

  const measurements = Array.from(quantities.entries()).map(([mappingKey, quantity]) => {
    const mapping = mappings[mappingKey] || {};
    return {
      mappingKey,
      layerLabel: mapping.labels?.[0] || mappingKey,
      quantity,
      unit: mapping.unit || null,
      status: mapping.referenceOnly ? 'reference-only' : 'mapped',
      suppressed: false,
      suppressedBy: null,
      suppressionRuleId: null,
    };
  });

  if (!measurements.length) {
    errors.push('No mapped SiteRecon layers were found in this workbook.');
  }

  return { measurements, warnings, errors };
}

function applyOverlapRules(measurements, rules) {
  const byKey = new Map(measurements.map((m) => [m.mappingKey, m]));

  for (const rule of rules) {
    const pivot = byKey.get(rule.ifPresent);
    if (!pivot || Number(pivot.quantity || 0) <= 0) {
      continue;
    }

    for (const suppressedKey of rule.suppress || []) {
      const target = byKey.get(suppressedKey);
      if (!target || Number(target.quantity || 0) <= 0) {
        continue;
      }
      target.suppressed = true;
      target.suppressedBy = pivot.mappingKey;
      target.suppressionRuleId = rule.id;
    }
  }
}

function detectStructure(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i].map((cell) => normalizeLayerLabel(cell));
    const layerCol = row.findIndex((c) => LAYER_HEADER_HINTS.includes(c));
    const qtyCol = row.findIndex((c) => NUMERIC_HEADER_HINTS.includes(c));

    if (layerCol >= 0 && qtyCol >= 0) {
      return {
        detected: true,
        headerRowIndex: i,
        layerCol,
        qtyCol,
      };
    }
  }

  return {
    detected: false,
    headerRowIndex: -1,
    layerCol: -1,
    qtyCol: -1,
  };
}

function extractRow(row, structure) {
  if (!row || !row.length) {
    return null;
  }

  if (structure.detected) {
    const layerLabel = String(row[structure.layerCol] || '').trim();
    const quantity = parseNumber(row[structure.qtyCol]);
    if (!layerLabel || quantity === null || quantity <= 0) {
      return null;
    }
    return { layerLabel, quantity };
  }

  const cells = row.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!cells.length) {
    return null;
  }

  let layerLabel = null;
  let quantity = null;
  for (const cell of cells) {
    if (!layerLabel && !isNumericCell(cell)) {
      layerLabel = cell;
      continue;
    }
    if (quantity === null) {
      const n = parseNumber(cell);
      if (n !== null) quantity = n;
    }
  }

  if (!layerLabel || quantity === null || quantity <= 0) {
    return null;
  }
  return { layerLabel, quantity };
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isNumericCell(value) {
  return parseNumber(value) !== null;
}

function roundQuantity(value, precision) {
  const p = Math.max(0, Number(precision) || 0);
  const factor = 10 ** p;
  return Math.round(Number(value || 0) * factor) / factor;
}

async function loadPricebookItems(pool, itemIds) {
  if (!itemIds.length) {
    return new Map();
  }

  const { rows } = await pool.query(
    `SELECT id, name, category, unit_price, unit_of_measure, kind, taxable
     FROM pricebook
     WHERE id = ANY($1::int[])`,
    [itemIds],
  );

  return new Map(rows.map((row) => [Number(row.id), row]));
}
