// HCP Estimate Builder — local web portal.
// Upload an Excel/CSV of multi-option estimates, pick a customer, push to HCP.

import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import pg from 'pg';

import { parseEstimateWorkbook } from './src/parse.js';
import { parseSiteReconWorkbook } from './src/siterecon.js';
import { searchCustomers, getCustomer, createEstimate, createEstimateFromBody, buildCreatePlan, listEstimatesByCustomer, getEstimateForDuplication } from './src/hcp.js';
import { createEstimateViaN8n, isN8nConfigured } from './src/n8n.js';
import { listItems, listCategories, listCategoryTree, listCategoryPaths, getPriceContext, createCategory, updateCategory, deleteCategory, getItem, createItem, updateItem, deleteItem, importItems, generateTemplate, generatePricebookCsvTemplate, exportPricebookCsv, exportPricebookSqlBackup, generateAIForItem, searchItems, findDuplicateCandidates } from './src/pricebook.js';
import { findExemplars } from './src/exemplars.js';
import { listDrafts, getDraft, createDraft, updateDraft, deleteDraft } from './src/drafts.js';
import { listTemplates, getTemplate, createTemplate, updateTemplate, hideTemplate, restoreTemplate, featureTemplate, unfeatureTemplate, reorderHomepage, deleteTemplate } from './src/studio_templates.js';
import { registerChatFoundryRoutes } from './src/chatfoundry.js';
import { recoverInterrupted } from './src/cf_sender.js';
import { loadSettings as loadChatFoundrySettings } from './src/cf_settings.js';
import { registerIntakeRoutes, recoverInterruptedIntakes } from './src/intake.js';
// Load .env (tiny loader; avoids an extra dependency).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));
const PRICEBOOK_BACKUP_DIR = process.env.PRICEBOOK_BACKUP_DIR || path.join(__dirname, 'backups', 'pricebook');
fs.mkdirSync(PRICEBOOK_BACKUP_DIR, { recursive: true });

// ScopeFoundry AI microservice (LangGraph). Node proxies enrichment requests to it.
const SCOPEFOUNDRY_AI_BASE = (process.env.SCOPEFOUNDRY_AI_BASE || 'http://127.0.0.1:8200').replace(/\/$/, '');

// Postgres pool for pricebook.
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'jobber-postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'hcp',
  user: process.env.DB_USER || 'hcp_writer',
  password: process.env.DB_PASSWORD || '',
});

// Initialize DB on startup (create table if not exists).
await initializeDatabase(pool);

async function initializeDatabase(pool) {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await pool.query('SELECT filename FROM schema_migrations');
  const done = new Set(applied.rows.map((r) => r.filename));

  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    try {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`✓ Migration applied: ${file}`);
    } catch (err) {
      console.warn(`⚠ Migration warning (${file}): ${err.message}`);
    }
  }
}

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';
const CREATE_PROVIDER = String(process.env.ESTIMATE_CREATE_PROVIDER || 'direct').toLowerCase();
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 30_000);
const CUSTOMER_CACHE_TTL_MS = Number(process.env.CUSTOMER_CACHE_TTL_MS || 60_000);

const app = express();
app.use(express.json({ limit: '2mb' }));

const searchCache = new Map();
const customerCache = new Map();

// Optional HTTP Basic Auth gate.
const USER = process.env.PORTAL_USER;
const PASS = process.env.PORTAL_PASS;
if (USER && PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [, b64] = hdr.split(' ');
    const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (u === USER && p === PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="HCP Estimate Builder"').status(401).send('Auth required.');
  });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

// Chat Foundry — bulk messaging console (Chatwoot). Read-only discovery in Sprint 1.
registerChatFoundryRoutes(app, pool);

// Customer Intake System — office-staff intake wizard (HCP-integrated in later sprints).
registerIntakeRoutes(app, pool);

// Customer Intake — quarantine any intake left mid-submit by a restart (idempotent; re-submit resumes).
recoverInterruptedIntakes(pool).then((r) => {
  if (r.recovered) console.log(`✓ Customer Intake: recovered ${r.recovered} interrupted submit(s) -> failed`);
}).catch(() => {});

// Chat Foundry — hydrate the DB-backed settings cache (live-sending switch + inbox allowlist)
// so the operator's UI toggles survive restarts and override the .env defaults.
loadChatFoundrySettings(pool).then((s) => {
  console.log(`✓ Chat Foundry settings loaded: sending=${s.sendEnabled ? 'ON' : 'off'} (${s.sendSource}), allowlist=[${s.allowedInboxIds.join(',')}] (${s.inboxSource})`);
}).catch(() => {});

// Chat Foundry — recover any bulk send interrupted by a restart (quarantines mid-flight recipients
// so a customer is never double-texted, and pauses interrupted campaigns for operator review).
recoverInterrupted(pool).then((r) => {
  if (r.quarantined || r.pausedCampaigns) {
    console.log(`✓ Chat Foundry recovery: paused ${r.pausedCampaigns} campaign(s), quarantined ${r.quarantined} mid-send recipient(s)`);
  }
}).catch(() => {});

// Parse an uploaded workbook into grouped options (no HCP calls).
app.post('/api/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const result = parseEstimateWorkbook(req.file.buffer);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: `Could not parse file: ${e.message}` });
  }
});

// Parse SiteRecon workbook into measurements + generated estimate options.
app.post('/api/parse-siterecon', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const result = await parseSiteReconWorkbook(pool, req.file.buffer);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: `Could not parse SiteRecon file: ${e.message}` });
  }
});

// Customer search (proxies HCP).
app.get('/api/customers', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ customers: [] });
  try {
    const key = q.toLowerCase();
    const cached = getCached(searchCache, key);
    if (cached) return res.json({ customers: cached });

    const customers = await searchCustomers(q);
    setCached(searchCache, key, customers, SEARCH_CACHE_TTL_MS);
    res.json({ customers });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/customers/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const cached = getCached(customerCache, id);
    if (cached) return res.json(cached);

    const customer = await getCustomer(id);
    setCached(customerCache, id, customer, CUSTOMER_CACHE_TTL_MS);
    res.json(customer);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// List a customer's recent estimates (used by the "Duplicate" flow).
app.get('/api/customers/:id/estimates', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const estimates = await listEstimatesByCustomer(id);
    if (!estimates.length) return res.status(404).json({ error: 'No estimates found for this customer.' });
    res.json({ estimates });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Fetch a single estimate and return its options for cloning.
app.get('/api/estimates/:id/duplicate', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const options = await getEstimateForDuplication(id);
    if (!options || !options.length) return res.status(404).json({ error: 'Estimate has no options to duplicate.' });
    res.json({ options });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Create the estimate (dryRun returns the planned API calls without sending).
app.post('/api/estimates', async (req, res) => {
  const { customerId, addressId, serviceAddressId, billingAddressId, options, dryRun } = req.body || {};
  const effectiveAddressId = serviceAddressId || addressId || billingAddressId;
  if (!customerId) return res.status(400).json({ error: 'customerId is required.' });
  if (!effectiveAddressId) return res.status(400).json({ error: 'A service or billing address is required.' });
  if (!Array.isArray(options) || !options.length) return res.status(400).json({ error: 'options are required.' });

  if (dryRun) {
    return res.json({
      dryRun: true,
      plan: buildCreatePlan({
        customerId,
        addressId: effectiveAddressId,
        serviceAddressId,
        billingAddressId,
        options,
      }),
    });
  }
  try {
    const provider = (CREATE_PROVIDER === 'n8n' || (CREATE_PROVIDER === 'auto' && isN8nConfigured()))
      ? 'n8n'
      : 'direct';

    const payload = {
      customerId,
      addressId: effectiveAddressId,
      serviceAddressId,
      billingAddressId,
      options,
    };

    if (provider === 'n8n') {
      const data = await createEstimateViaN8n(payload);
      const result = data?.result || data;
      return res.json({ dryRun: false, provider, result });
    }

    const result = await createEstimate(payload);
    res.json({ dryRun: false, provider, result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// Push an already-reviewed/edited HCP body (from the preview modal) directly to HCP.
// This bypasses the Studio->HCP transform so what the user sees in the preview is exactly
// what gets created. Always goes direct to HCP (no n8n) and returns the new estimate number.
app.post('/api/estimates/confirm', async (req, res) => {
  const body = req.body && req.body.body;
  try {
    const result = await createEstimateFromBody(body);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// --- Pricebook CRUD -----------------------------------------------------------

app.get('/api/pricebook', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listItems(pool, { includeInactive });
    res.json({ items, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pricebook/categories', async (req, res) => {
  try {
    res.json({ categories: await listCategories(pool) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Category taxonomy (two-level tree) management ------------------------
app.get('/api/categories/tree', async (req, res) => {
  try {
    res.json({ tree: await listCategoryTree(pool), paths: await listCategoryPaths(pool) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', async (req, res) => {
  try {
    res.status(201).json({ category: await createCategory(pool, req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.patch('/api/categories/:id', async (req, res) => {
  try {
    res.json({ category: await updateCategory(pool, Number(req.params.id), req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/categories/:id', async (req, res) => {
  try {
    await deleteCategory(pool, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// --- Studio drafts (server-side, numbered work-in-progress estimates) ----------
app.get('/api/studio/drafts', async (_req, res) => {
  try {
    res.json({ drafts: await listDrafts(pool) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/studio/drafts/:id', async (req, res) => {
  try {
    res.json({ draft: await getDraft(pool, Number(req.params.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/drafts', async (req, res) => {
  try {
    res.status(201).json({ draft: await createDraft(pool, req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/studio/drafts/:id', async (req, res) => {
  try {
    res.json({ draft: await updateDraft(pool, Number(req.params.id), req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/studio/drafts/:id', async (req, res) => {
  try {
    await deleteDraft(pool, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// --- Studio templates: server-side reusable templates + homepage management ---
app.get('/api/studio/templates', async (req, res) => {
  try {
    const status = req.query.featured === '1' ? 'active' : (req.query.status || 'active');
    res.json({ templates: await listTemplates(pool, {
      status,
      search: req.query.search || '',
      featured: req.query.featured === '1',
    }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/studio/templates/:id', async (req, res) => {
  try {
    const tpl = await getTemplate(pool, Number(req.params.id));
    if (!tpl) return res.status(404).json({ error: 'Template not found.' });
    res.json({ template: tpl });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/templates', async (req, res) => {
  try {
    res.status(201).json({ template: await createTemplate(pool, req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Persist homepage card order. Registered before :id so 'homepage-order' isn't captured as an id.
app.patch('/api/studio/templates/homepage-order', async (req, res) => {
  try {
    const order = (req.body && req.body.order) || [];
    res.json({ templates: await reorderHomepage(pool, order) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.patch('/api/studio/templates/:id', async (req, res) => {
  try {
    res.json({ template: await updateTemplate(pool, Number(req.params.id), req.body || {}) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/templates/:id/hide', async (req, res) => {
  try {
    res.json({ template: await hideTemplate(pool, Number(req.params.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/templates/:id/restore', async (req, res) => {
  try {
    res.json({ template: await restoreTemplate(pool, Number(req.params.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/templates/:id/feature', async (req, res) => {
  try {
    const { icon = null, description = null } = req.body || {};
    res.json({ template: await featureTemplate(pool, Number(req.params.id), { icon, description }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/studio/templates/:id/unfeature', async (req, res) => {
  try {
    res.json({ template: await unfeatureTemplate(pool, Number(req.params.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/studio/templates/:id', async (req, res) => {
  try {
    await deleteTemplate(pool, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/pricebook/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
    if (!query) return res.json({ results: [] });
    
    if (!pool) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    
    const results = await searchItems(pool, query, { limit });
    res.json({ results });
  } catch (e) { 
    console.error('Search error:', e);
    res.status(500).json({ error: e.message || 'Search failed' }); 
  }
});

app.get('/api/pricebook/backups', (_req, res) => {
  try {
    res.json({ backups: listPricebookBackupFiles() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pricebook/backups/create', async (_req, res) => {
  try {
    const filename = makePricebookBackupFilename();
    const fullPath = path.join(PRICEBOOK_BACKUP_DIR, filename);
    const sql = await exportPricebookSqlBackup(pool);
    fs.writeFileSync(fullPath, sql, 'utf8');
    const stat = fs.statSync(fullPath);
    res.status(201).json({
      ok: true,
      backup: {
        filename,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      },
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/pricebook/backups/:filename/download', (req, res) => {
  try {
    const filename = sanitizeBackupFilename(req.params.filename);
    const fullPath = path.join(PRICEBOOK_BACKUP_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Backup not found.' });
    }
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/pricebook/backups/:filename/restore', async (req, res) => {
  try {
    const filename = sanitizeBackupFilename(req.params.filename);
    const fullPath = path.join(PRICEBOOK_BACKUP_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Backup not found.' });
    }

    const preRestoreFilename = makePreRestoreBackupFilename(filename);
    const preRestorePath = path.join(PRICEBOOK_BACKUP_DIR, preRestoreFilename);
    const currentSql = await exportPricebookSqlBackup(pool);
    fs.writeFileSync(preRestorePath, currentSql, 'utf8');

    const sql = fs.readFileSync(fullPath, 'utf8');
    await pool.query(sql);
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('pricebook', 'id'), COALESCE((SELECT MAX(id) FROM pricebook), 1), EXISTS (SELECT 1 FROM pricebook))`
    );
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM pricebook');
    res.json({
      ok: true,
      restoredFrom: filename,
      preRestoreBackup: preRestoreFilename,
      count: count.rows[0].count,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/pricebook/:id', async (req, res) => {
  try {
    res.json(await getItem(pool, req.params.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/pricebook', async (req, res) => {
  try {
    res.status(201).json(await createItem(pool, req.body));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/pricebook/:id', async (req, res) => {
  try {
    res.json(await updateItem(pool, req.params.id, req.body));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/pricebook/:id', async (req, res) => {
  try {
    await deleteItem(pool, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/pricebook/:id/generate-ai', async (req, res) => {
  try {
    const fields = Array.isArray(req.body?.fields) ? req.body.fields : undefined;
    if (fields && !fields.length) {
      return res.status(400).json({ error: 'Select at least one AI field to update.' });
    }
    const item = await generateAIForItem(pool, req.params.id, { fields });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// --- ScopeFoundry AI (LangGraph microservice) proxy ----------------------
// These forward to the Python enrichment service. Categories are loaded from
// Postgres here (the Python service is stateless) before forwarding.
app.post('/api/pricebook/enrich', async (req, res) => {
  try {
    const ctx = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    if (!Array.isArray(ctx.categories) || !ctx.categories.length) {
      try { ctx.categories = await listCategories(pool); } catch { ctx.categories = []; }
    }
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: `AI service unreachable: ${e.message}` });
  }
});

// Streaming (SSE) proxy: pipes the Python service's event-stream straight through.
app.post('/api/pricebook/enrich/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
  };
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const ctx = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    if (!Array.isArray(ctx.categories) || !ctx.categories.length) {
      try { ctx.categories = await listCategories(pool); } catch { ctx.categories = []; }
    }
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/enrich/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      send('error', { message: `AI service returned ${upstream.status}` });
      return res.end();
    }
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', reject);
      nodeStream.on('end', resolve);
      nodeStream.pipe(res, { end: false });
    });
  } catch (e) {
    if (!controller.signal.aborted) send('error', { message: e.message || 'Enrich failed' });
  } finally {
    res.end();
  }
});

// --- Phase B async job model (Architect -> QA revision loop) -------------------
// Start a run: returns { runId, fields } once the Architect draft is ready (~12s).// QA + revisions continue server-side; watch progress via the SSE route below.
app.post('/api/pricebook/enrich/start', async (req, res) => {
  try {
    const ctx = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    if (!Array.isArray(ctx.categories) || !ctx.categories.length) {
      try { ctx.categories = await listCategories(pool); } catch { ctx.categories = []; }
    }
    // Taxonomy for the Category Auditor reviewer (Python service is stateless).
    if (!Array.isArray(ctx.categoryPaths) || !ctx.categoryPaths.length) {
      try { ctx.categoryPaths = await listCategoryPaths(pool); } catch { ctx.categoryPaths = []; }
    }
    // Peer pricing stats for the Pricing Reviewer (advisory outlier detection).
    if (!ctx.priceContext && ctx.category) {
      try { ctx.priceContext = await getPriceContext(pool, ctx.category); } catch { /* optional */ }
    }
    // Existing-item candidates for the Duplicate Finder (pg_trgm + pgvector). Advisory.
    if (!Array.isArray(ctx.duplicateCandidates)) {
      try {
        ctx.duplicateCandidates = await findDuplicateCandidates(pool, {
          name: ctx.name,
          description: ctx.description || ctx.customer_description,
        });
      } catch { ctx.duplicateCandidates = []; }
    }
    // RAG: top-k approved exemplars (same embedding stack) injected as few-shot STYLE
    // references into the Architect prompt. Empty corpus => no examples => today's behaviour.
    if (!Array.isArray(ctx.retrievedExamples)) {
      try {
        ctx.retrievedExamples = await findExemplars(pool, {
          name: ctx.name,
          category: ctx.category,
          hints: ctx.description || ctx.customer_description,
          unitOfMeasure: ctx.unitOfMeasure,
          excludeId: ctx.serviceId || ctx.service_id,
        });
      } catch { ctx.retrievedExamples = []; }
    }
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/enrich/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: `AI service unreachable: ${e.message}` });
  }
});

// Standalone Category Auditor for the admin price book (single field, no full enrich).
app.post('/api/pricebook/audit-category', async (req, res) => {
  try {
    const ctx = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    if (!Array.isArray(ctx.categoryPaths) || !ctx.categoryPaths.length) {
      try { ctx.categoryPaths = await listCategoryPaths(pool); } catch { ctx.categoryPaths = []; }
    }
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/audit/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: `AI service unreachable: ${e.message}` });
  }
});

// Standalone Pricing + Compliance + Duplicate reviewers for the admin price book.
app.post('/api/pricebook/review-item', async (req, res) => {
  try {
    const ctx = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    const name = String(ctx.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Service name is required.' });
    // Peer pricing stats for the Pricing Reviewer (advisory outlier detection).
    if (!ctx.priceContext && ctx.category) {
      try { ctx.priceContext = await getPriceContext(pool, ctx.category); } catch { /* optional */ }
    }
    // Existing-item candidates for the Duplicate Finder (pg_trgm + pgvector), excluding self.
    if (!Array.isArray(ctx.duplicateCandidates)) {
      try {
        ctx.duplicateCandidates = await findDuplicateCandidates(pool, {
          name,
          description: ctx.description || ctx.customer_description,
          excludeId: ctx.id != null && ctx.id !== '' ? Number(ctx.id) : null,
        });
      } catch { ctx.duplicateCandidates = []; }
    }
    // Pricing basis for build_price_summary (unit price arrives in DOLLARS from the modal).
    const dollars = Number(ctx.unitPrice);
    if (Number.isFinite(dollars)) {
      ctx.pricingMode = 'calculated';
      ctx.quantity = 1;
      ctx.lineAmount = dollars;
    }
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/review/item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: `AI service unreachable: ${e.message}` });
  }
});

// Reattachable SSE stream for a run: live qa/revision/done events (or a terminal
// snapshot if the run already finished). Safe to (re)connect at any time by runId.
app.get('/api/pricebook/enrich/:runId/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
  };
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const runId = encodeURIComponent(req.params.runId);
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/enrich/${runId}/stream`, {
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      send('error', { message: `AI service returned ${upstream.status}` });
      return res.end();
    }
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', reject);
      nodeStream.on('end', resolve);
      nodeStream.pipe(res, { end: false });
    });
  } catch (e) {
    if (!controller.signal.aborted) send('error', { message: e.message || 'Stream failed' });
  } finally {
    res.end();
  }
});

// Current status snapshot for a run (in-memory if active, else from Postgres).
app.get('/api/pricebook/enrich/:runId', async (req, res) => {
  try {
    const runId = encodeURIComponent(req.params.runId);
    const upstream = await fetch(`${SCOPEFOUNDRY_AI_BASE}/enrich/${runId}`);
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: `AI service unreachable: ${e.message}` });
  }
});

// --- Bulk AI generation queue -------------------------------------------
const bulkQueue = { running: false, total: 0, completed: 0, failed: 0, current: null, errors: [] };

app.get('/api/pricebook/generate-ai-all/status', (_req, res) => {
  res.json({ ...bulkQueue });
});

app.post('/api/pricebook/generate-ai-all', async (req, res) => {
  if (bulkQueue.running) return res.json({ started: false, reason: 'already running', ...bulkQueue });

  const { rows } = await pool.query(
    `SELECT id FROM pricebook WHERE ai_status = 'pending' OR ai_status = 'error' ORDER BY sort_order, name`
  );
  if (!rows.length) return res.json({ started: false, reason: 'no pending items', ...bulkQueue });

  bulkQueue.running = true;
  bulkQueue.total = rows.length;
  bulkQueue.completed = 0;
  bulkQueue.failed = 0;
  bulkQueue.current = null;
  bulkQueue.errors = [];

  res.json({ started: true, total: rows.length });

  // Run sequentially in the background (do not await)
  (async () => {
    for (const { id } of rows) {
      bulkQueue.current = id;
      try {
        await generateAIForItem(pool, id);
        bulkQueue.completed++;
      } catch (e) {
        bulkQueue.failed++;
        bulkQueue.errors.push({ id, error: e.message });
      }
    }
    bulkQueue.running = false;
    bulkQueue.current = null;
  })();
});

app.post('/api/pricebook/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const replace = req.body.replace === 'true';
    const result = await importItems(pool, req.file.buffer, { replace });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/pricebook/template/download.csv', (_req, res) => {
  const csv = generatePricebookCsvTemplate();
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="ScopeFoundry-Pricebook-Template.csv"');
  res.send(csv);
});

app.get('/api/pricebook/export/download.csv', async (_req, res) => {
  try {
    const csv = await exportPricebookCsv(pool);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="ScopeFoundry-Pricebook-Export.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pricebook/backup/download.sql', async (_req, res) => {
  try {
    const sql = await exportPricebookSqlBackup(pool);
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="ScopeFoundry-Pricebook-Backup.sql"');
    res.send(sql);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Template download (uses curated pricebook).
app.get('/api/template/download', async (req, res) => {
  try {
    const buf = await generateTemplate(pool);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="ScopeFoundry-Estimate-Import-Template.xlsx"');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy sync endpoint (no-op now).
app.listen(PORT, HOST, () => {
  console.log(`\n  HCP Estimate Builder`);
  console.log(`  http://${HOST}:${PORT}/`);
  console.log(`  Bind: ${HOST} ${HOST === '127.0.0.1' ? '(localhost only)' : '(reachable on this network — keep it firewalled)'}`);
  console.log(`  Create provider: ${CREATE_PROVIDER}`);
  if (USER && PASS) console.log('  Basic Auth: ENABLED');
  console.log('');
});

// --- tiny .env loader --------------------------------------------------------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function makePricebookBackupFilename() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `pricebook-${yyyy}${mm}${dd}-${hh}${mi}${ss}.sql`;
}
function makePreRestoreBackupFilename(targetFilename) {
  const base = makePricebookBackupFilename().replace(/\.sql$/i, '');
  const target = String(targetFilename || '').replace(/\.sql$/i, '');
  return `${base}-pre-restore-from-${target}.sql`;
}

function sanitizeBackupFilename(name) {
  const file = path.basename(String(name || '').trim());
  if (!/^pricebook-\d{8}-\d{6}\.sql$/i.test(file)) {
    throw Object.assign(new Error('Invalid backup filename.'), { status: 400 });
  }
  return file;
}

function listPricebookBackupFiles() {
  return fs.readdirSync(PRICEBOOK_BACKUP_DIR)
    .filter((name) => /^pricebook-\d{8}-\d{6}\.sql$/i.test(name))
    .map((name) => {
      const fullPath = path.join(PRICEBOOK_BACKUP_DIR, name);
      const stat = fs.statSync(fullPath);
      return {
        filename: name,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

function getCached(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function setCached(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}
