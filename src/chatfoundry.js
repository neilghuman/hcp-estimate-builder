// Chat Foundry — route registration (Sprint 1: read-only Chatwoot discovery + config).
//
// Safety model (RBAC deferred — option B): send/retry/pause/resume/cancel operations
// (added in later sprints) are gated behind Basic Auth + CHAT_FOUNDRY_SEND_ENABLED +
// a typed confirmation phrase + confirmation checkbox + audit logging + a max campaign size.
// This module is structured so a real RBAC layer can wrap it later without rewrites.
//
// Outbound eligibility is decided by an explicit INBOX-ID allowlist
// (CHAT_FOUNDRY_ALLOWED_INBOX_IDS) — never by inbox name or channel type, since our
// verified outbound path is the n8n Telnyx/Thumbtack relays on API inboxes.

import * as chatwoot from './chatwoot.js';
import * as templates from './cf_templates.js';
import * as compose from './cf_compose.js';
import * as rewrite from './cf_rewrite.js';
import * as campaigns from './cf_campaigns.js';
import * as sender from './cf_sender.js';
import * as history from './cf_history.js';
import * as settings from './cf_settings.js';
// Best-effort actor for audit fields: the Basic Auth user if present, else 'operator'.
// (RBAC deferred — option B. Structured so a real user model can replace this later.)
export function actor(req) {
  try {
    const hdr = (req && req.headers && req.headers.authorization) || '';
    const [, b64] = hdr.split(' ');
    if (b64) {
      const [u] = Buffer.from(b64, 'base64').toString().split(':');
      if (u) return u;
    }
  } catch { /* ignore */ }
  return 'operator';
}

// Effective values now come from the DB-backed settings cache (env vars are the fallback default),
// so operators can toggle them from the UI without editing .env or restarting.
export function allowedInboxIds() {
  return settings.effectiveAllowedInboxIds();
}

export function sendEnabled() {
  return settings.effectiveSendEnabled();
}

export function maxCampaignSize() {
  return Number(process.env.CHAT_FOUNDRY_MAX_CAMPAIGN_SIZE || 500);
}

// Decide whether an inbox may receive proactive outbound messages.
// Sprint 1 gates purely on the inbox-ID allowlist; later sprints add relay/test-status checks.
export function inboxCapability(inbox) {
  const allow = allowedInboxIds();
  if (!allow.length) {
    return { outbound_allowed: false, eligibility: 'inbox not allowlisted', skip_reason: 'No inboxes are allowlisted yet (set CHAT_FOUNDRY_ALLOWED_INBOX_IDS).' };
  }
  if (!allow.includes(Number(inbox.id))) {
    return { outbound_allowed: false, eligibility: 'inbox not allowlisted', skip_reason: `Inbox ${inbox.id} is not in the outbound allowlist.` };
  }
  return { outbound_allowed: true, eligibility: 'eligible', skip_reason: null };
}

export const CONVERSATION_STATUSES = ['open', 'pending', 'snoozed', 'resolved', 'all'];

// Mask a phone/identifier for display: keep last 4, hide the rest.
export function maskPhone(p) {
  const s = String(p || '');
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 4) return s ? '••••' : '';
  return `••• ••• ${digits.slice(-4)}`;
}

// PURE: given normalized conversations + filter options, return audience rows with eligibility
// and a summary. No network — unit-tested directly.
//   opts: { tags:[], contactSearch:'', excludeNoChannel:true, maxRecipients:0 }
export function buildAudience(normalized, opts = {}) {
  const tags = (opts.tags || []).map((t) => String(t));
  const search = String(opts.contactSearch || '').trim().toLowerCase();
  const excludeNoChannel = opts.excludeNoChannel !== false;
  const maxRecipients = Number(opts.maxRecipients || 0);

  // 1) audience membership: must carry ALL selected tags + match the contact search
  const matched = normalized.filter((r) => {
    const labels = (r.labels || []).map(String);
    if (!tags.every((t) => labels.includes(t))) return false;
    if (search) {
      const hay = `${r.contact_name || ''} ${r.contact_identifier || ''} ${r.phone || ''} ${r.email || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // 2) sort newest-activity first so the max-recipients cap keeps the freshest conversations
  matched.sort((a, b) => new Date(b.last_activity_at || 0) - new Date(a.last_activity_at || 0));

  // 3) annotate eligibility
  let eligibleSoFar = 0;
  const rows = matched.map((r) => {
    const cap = inboxCapability({ id: r.inbox_id });
    const hasChannel = Boolean(r.phone || r.contact_identifier);
    let eligibility = 'eligible';
    let skip_reason = null;
    let eligible = true;
    if (!cap.outbound_allowed) {
      eligible = false; eligibility = cap.eligibility; skip_reason = cap.skip_reason;
    } else if (excludeNoChannel && !hasChannel) {
      eligible = false; eligibility = 'no valid contact channel'; skip_reason = 'Contact has no phone or channel identifier.';
    } else if (maxRecipients > 0 && eligibleSoFar >= maxRecipients) {
      eligible = false; eligibility = 'exceeds max recipients'; skip_reason = `Beyond the max of ${maxRecipients}.`;
    }
    if (eligible) eligibleSoFar += 1;
    return { ...r, phone_masked: maskPhone(r.phone || r.contact_identifier), eligible, eligibility, skip_reason };
  });

  const byReason = {};
  for (const r of rows) if (!r.eligible) byReason[r.eligibility] = (byReason[r.eligibility] || 0) + 1;
  const eligibleCount = rows.filter((r) => r.eligible).length;
  return {
    rows,
    summary: { matched: rows.length, eligible: eligibleCount, skipped: rows.length - eligibleCount, byReason },
  };
}


export function registerChatFoundryRoutes(app, pool) {
  // Non-secret config snapshot for the UI (never returns the token value).
  app.get('/api/chat-foundry/config', (_req, res) => {
    const cw = chatwoot.chatwootStatus();
    res.json({
      chatwoot: cw,
      sendEnabled: sendEnabled(),
      maxCampaignSize: maxCampaignSize(),
      allowedInboxIds: allowedInboxIds(),
    });
  });

  // ---- Runtime settings toggles (DB-persisted): live-sending switch + inbox allowlist. ----
  app.get('/api/chat-foundry/settings', (_req, res) => res.json(settings.settingsView()));

  // Turn live sending on/off. Arming (enabled=true) requires the exact confirmation phrase.
  app.post('/api/chat-foundry/settings/sending', async (req, res) => {
    try {
      const b = req.body || {};
      const view = await settings.setSendEnabled(pool, b.enabled === true, String(b.confirm || ''), actor(req));
      res.json(view);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Add/remove a single inbox from the outbound allowlist.
  app.post('/api/chat-foundry/settings/inbox', async (req, res) => {
    try {
      const b = req.body || {};
      const view = await settings.setInboxAllowed(pool, Number(b.inboxId), b.allowed === true, actor(req));
      res.json(view);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Connectivity + auth check.
  app.get('/api/chat-foundry/health', async (_req, res) => {
    try {
      res.json(await chatwoot.ping());
    } catch (e) {
      res.status(e.status || 502).json({ ok: false, error: e.message });
    }
  });

  // Discover accounts the token can see (to choose CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID).
  app.get('/api/chat-foundry/accounts', async (_req, res) => {
    try {
      res.json({ accounts: await chatwoot.listAccounts() });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Inboxes, annotated with outbound capability (allowlist-based).
  app.get('/api/chat-foundry/inboxes', async (_req, res) => {
    try {
      const inboxes = await chatwoot.listInboxes();
      res.json({ inboxes: inboxes.map((i) => ({ ...i, ...inboxCapability(i) })) });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Tags (Chatwoot labels).
  app.get('/api/chat-foundry/tags', async (_req, res) => {
    try {
      res.json({ tags: await chatwoot.listLabels() });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Audience preview (READ-ONLY). Never sends. Pages Chatwoot conversations for the chosen
  // status + inbox, then filters by tags (AND) + contact search and annotates eligibility.
  app.post('/api/chat-foundry/audience/preview', async (req, res) => {
    try {
      const b = req.body || {};
      const status = CONVERSATION_STATUSES.includes(String(b.status)) ? String(b.status) : 'open';
      const inboxId = b.inboxId ? Number(b.inboxId) : null;
      const tags = Array.isArray(b.tags) ? b.tags : [];
      const contactSearch = String(b.contactSearch || '');
      const excludeNoChannel = b.excludeNoChannel !== false;
      const maxRecipients = Number(b.maxRecipients || 0);
      const page = Math.max(1, Number(b.page || 1));
      const perPage = Math.min(200, Math.max(1, Number(b.perPage || 50)));

      const MAX_PAGES = Number(process.env.CHAT_FOUNDRY_PREVIEW_MAX_PAGES || 40);
      const normalized = [];
      let scannedPages = 0;
      let truncated = false;
      for (let p = 1; p <= MAX_PAGES; p += 1) {
        const { conversations } = await chatwoot.listConversations({ status, inboxId, page: p });
        scannedPages = p;
        if (!conversations.length) break;
        for (const c of conversations) normalized.push(chatwoot.normalizeConversation(c));
        if (conversations.length < 25) break; // last page (Chatwoot pages by 25)
        if (p === MAX_PAGES) truncated = true;
      }

      const { rows, summary } = buildAudience(normalized, { tags, contactSearch, excludeNoChannel, maxRecipients });
      const totalRows = rows.length;
      const start = (page - 1) * perPage;
      const pageRows = rows.slice(start, start + perPage);

      res.json({
        filters: { status, inboxId, tags, contactSearch, excludeNoChannel, maxRecipients },
        summary: { ...summary, scanned: normalized.length, scannedPages, truncated },
        page, perPage, totalRows,
        rows: pageRows,
      });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // ---- Message library (templates + immutable version history) ----
  app.get('/api/chat-foundry/templates', async (req, res) => {
    try {
      const list = await templates.listTemplates(pool, {
        search: String(req.query.search || ''),
        category: String(req.query.category || ''),
        tag: String(req.query.tag || ''),
        includeArchived: String(req.query.includeArchived || '') === 'true',
      });
      res.json({ templates: list, categories: templates.TEMPLATE_CATEGORIES });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/templates', async (req, res) => {
    try { res.status(201).json(await templates.createTemplate(pool, req.body || {}, actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/templates/:id', async (req, res) => {
    try {
      const t = await templates.getTemplate(pool, Number(req.params.id));
      if (!t) return res.status(404).json({ error: 'Template not found.' });
      res.json(t);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.put('/api/chat-foundry/templates/:id', async (req, res) => {
    try { res.json(await templates.updateTemplate(pool, Number(req.params.id), req.body || {}, actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/templates/:id/duplicate', async (req, res) => {
    try { res.status(201).json(await templates.duplicateTemplate(pool, Number(req.params.id), actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/templates/:id/archive', async (req, res) => {
    try { res.json(await templates.setArchived(pool, Number(req.params.id), true, actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/templates/:id/restore', async (req, res) => {
    try { res.json(await templates.setArchived(pool, Number(req.params.id), false, actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Hard delete requires an explicit confirm flag.
  app.delete('/api/chat-foundry/templates/:id', async (req, res) => {
    if (String(req.query.confirm || '') !== 'true') return res.status(400).json({ error: 'Deletion requires ?confirm=true.' });
    try { res.json(await templates.deleteTemplate(pool, Number(req.params.id))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/templates/:id/versions', async (req, res) => {
    try { res.json({ versions: await templates.listVersions(pool, Number(req.params.id)) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/templates/:id/versions/:versionId/restore', async (req, res) => {
    try { res.json(await templates.restoreVersion(pool, Number(req.params.id), Number(req.params.versionId), actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---- Compose (placeholders) + LLM rewrite (Sprint 4). Both are PREVIEW-only: never send. ----

  // Supported merge fields for the editor's "insert field" helper.
  app.get('/api/chat-foundry/compose/fields', (_req, res) => {
    res.json({
      fields: compose.PLACEHOLDER_FIELDS.map((f) => ({ key: f.key, label: f.label, example: f.example })),
    });
  });

  // Render a draft body against a few real sample recipients and report which would be BLOCKED
  // because a placeholder can't be resolved. READ-ONLY: pulls at most one page of conversations
  // and never posts anything back to Chatwoot.
  app.post('/api/chat-foundry/compose/preview', async (req, res) => {
    try {
      const b = req.body || {};
      const body = String(b.body || '');
      if (!body.trim()) return res.status(400).json({ error: 'Message body is required.' });
      const status = CONVERSATION_STATUSES.includes(String(b.status)) ? String(b.status) : 'open';
      const inboxId = b.inboxId ? Number(b.inboxId) : null;
      const tags = Array.isArray(b.tags) ? b.tags.map(String) : [];
      const sampleSize = Math.min(20, Math.max(1, Number(b.sampleSize || 5)));

      // Static analysis works even without Chatwoot configured.
      const analysis = compose.analyzeTemplate(body);

      let recipients = [];
      let sampled = 0;
      if (chatwoot.chatwootConfigured()) {
        const MAX_PAGES = Number(process.env.CHAT_FOUNDRY_PREVIEW_MAX_PAGES || 40);
        for (let p = 1; p <= MAX_PAGES && recipients.length < sampleSize; p += 1) {
          const { conversations } = await chatwoot.listConversations({ status, inboxId, page: p });
          if (!conversations.length) break;
          for (const c of conversations) {
            const n = chatwoot.normalizeConversation(c);
            const labels = (n.labels || []).map(String);
            if (tags.length && !tags.every((t) => labels.includes(t))) continue;
            recipients.push(n);
            if (recipients.length >= sampleSize) break;
          }
          if (conversations.length < 25) break;
        }
        sampled = recipients.length;
      }

      const preview = compose.composePreview(body, recipients);
      res.json({
        chatwootConfigured: chatwoot.chatwootConfigured(),
        analysis,
        sampled,
        ...preview,
      });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Suggest an LLM rewrite (side-by-side accept/reject in the UI). Logs the suggestion to the
  // rewrite audit table with accepted = NULL. NEVER sends a message.
  app.post('/api/chat-foundry/rewrite', async (req, res) => {
    try {
      const b = req.body || {};
      const body = String(b.body || '');
      const instruction = String(b.instruction || '');
      const tone = rewrite.normalizeTone(b.tone);
      const templateId = b.templateId ? Number(b.templateId) : null;
      const result = await rewrite.rewriteMessage({ body, instruction, tone });
      let id = null;
      try {
        const { rows } = await pool.query(
          `INSERT INTO chat_message_rewrites (template_id, actor, model, tone, instruction, original_body, rewritten_body, placeholder_warning)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [templateId, actor(req), result.model, tone, instruction, body, result.rewritten, result.placeholder_warning],
        );
        id = Number(rows[0].id);
      } catch { /* audit is best-effort; never block a rewrite preview on the log write */ }
      res.json({ id, tone, model: result.model, original: body, rewritten: result.rewritten, placeholder_warning: result.placeholder_warning });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Record the operator's accept/reject decision for a prior rewrite suggestion (audit trail).
  app.post('/api/chat-foundry/rewrite/:id/decision', async (req, res) => {
    try {
      const accepted = req.body && req.body.accepted === true;
      const { rowCount } = await pool.query(
        `UPDATE chat_message_rewrites SET accepted = $1, decided_at = NOW() WHERE id = $2`,
        [accepted, Number(req.params.id)],
      );
      if (!rowCount) return res.status(404).json({ error: 'Rewrite not found.' });
      res.json({ id: Number(req.params.id), accepted });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ---- Campaigns + TEST-mode single send (Sprint 5). The ONLY endpoints that can message a
  // customer live behind the full send gate: CHAT_FOUNDRY_SEND_ENABLED + typed phrase + checkbox
  // + max size + per-recipient recheck + idempotency. Create/materialize never send. ----

  app.get('/api/chat-foundry/campaigns', async (_req, res) => {
    try { res.json({ campaigns: await campaigns.listCampaigns(pool), sendEnabled: sendEnabled(), maxCampaignSize: maxCampaignSize() }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/campaigns', async (req, res) => {
    try {
      const b = req.body || {};
      const filters = {
        status: CONVERSATION_STATUSES.includes(String(b.status)) ? String(b.status) : 'open',
        inboxId: b.inboxId ? Number(b.inboxId) : null,
        tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
        contactSearch: String(b.contactSearch || ''),
        excludeNoChannel: b.excludeNoChannel !== false,
        maxRecipients: Number(b.maxRecipients || 0),
      };
      const c = await campaigns.createCampaign(pool, { name: b.name, body: b.body, filters, templateId: b.templateId ? Number(b.templateId) : null }, actor(req));
      res.status(201).json(c);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/campaigns/:id', async (req, res) => {
    try {
      const c = await campaigns.getCampaign(pool, Number(req.params.id));
      if (!c) return res.status(404).json({ error: 'Campaign not found.' });
      // Surface the confirmation phrases the operator must type (1 for a test, N for a full send).
      const pendingEligible = (c.recipient_counts && c.recipient_counts.pending) || 0;
      res.json({
        ...c,
        testConfirmPhrase: campaigns.confirmationPhrase(1),
        sendConfirmPhrase: campaigns.confirmationPhrase(pendingEligible),
        pendingEligible,
        running: sender.isRunning(c.id),
        sendEnabled: sendEnabled(),
        maxCampaignSize: maxCampaignSize(),
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Build the recipient list from Chatwoot (read + render only — never sends).
  app.post('/api/chat-foundry/campaigns/:id/materialize', async (req, res) => {
    try { res.json(await campaigns.materializeRecipients(pool, Number(req.params.id), actor(req))); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // TEST-mode SINGLE send. Requires the full send gate in the request body.
  app.post('/api/chat-foundry/campaigns/:id/test-send', async (req, res) => {
    try {
      const b = req.body || {};
      const result = await campaigns.testSend(pool, Number(req.params.id), {
        conversationId: b.conversationId ? Number(b.conversationId) : null,
        typedPhrase: String(b.confirmPhrase || ''),
        confirmChecked: b.confirmChecked === true,
      }, actor(req));
      res.json(result);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---- Durable bulk sender (Sprint 6). Start/resume run the full send gate; the runner is
  // fire-and-forget and the DB is the source of truth. Progress is polled; pause/resume/cancel
  // are honored between messages. ----

  app.post('/api/chat-foundry/campaigns/:id/send', async (req, res) => {
    try {
      const b = req.body || {};
      const result = await sender.startCampaign(pool, Number(req.params.id), {
        typedPhrase: String(b.confirmPhrase || ''),
        confirmChecked: b.confirmChecked === true,
      }, actor(req));
      res.json(result);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/campaigns/:id/resume', async (req, res) => {
    try {
      const b = req.body || {};
      const result = await sender.startCampaign(pool, Number(req.params.id), {
        typedPhrase: String(b.confirmPhrase || ''),
        confirmChecked: b.confirmChecked === true,
        resume: true,
      }, actor(req));
      res.json(result);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/campaigns/:id/pause', async (req, res) => {
    try { res.json(await sender.pauseCampaign(pool, Number(req.params.id), actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/chat-foundry/campaigns/:id/cancel', async (req, res) => {
    try { res.json(await sender.cancelCampaign(pool, Number(req.params.id), actor(req))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/campaigns/:id/progress', async (req, res) => {
    try { res.json(await sender.progress(pool, Number(req.params.id))); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---- Campaign history, recipient drill-down, audit log, CSV export (Sprint 7). Read-only. ----

  app.get('/api/chat-foundry/campaigns/:id/recipients', async (req, res) => {
    try {
      res.json(await history.listRecipients(pool, Number(req.params.id), {
        status: String(req.query.status || ''),
        page: Number(req.query.page || 1),
        perPage: Number(req.query.perPage || 50),
      }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/campaigns/:id/events', async (req, res) => {
    try { res.json({ events: await history.listEvents(pool, Number(req.params.id), { limit: Number(req.query.limit || 200) }) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/chat-foundry/campaigns/:id/recipients.csv', async (req, res) => {
    try {
      const rows = await history.recipientsForExport(pool, Number(req.params.id), { status: String(req.query.status || '') });
      const csv = history.recipientsToCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="campaign-${Number(req.params.id)}-recipients.csv"`);
      res.send(csv);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}
