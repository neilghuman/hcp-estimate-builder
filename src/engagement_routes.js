import crypto from 'node:crypto';
import { buildDryRunDecision, buildHcpCanaryProjection, buildHcpReconciliationDecisions, createReconciliationRun, engagementConfig, finishReconciliationRun, fingerprint, recordDryRunDecision, selectHcpCanaryCandidates, summarizeAddressAudit, summarizeReconciliation } from './engagement_runtime.js';
import { createCanaryContactAndLink, getContactForAddressAudit, getEspoCrmInventory, espocrmConfigured, espocrmWriterConfigured, listContactsForReconciliation, listProvisionalHcpIdentityLinks } from './engagement_espocrm.js';
import { getCustomerForReconciliation, listCustomerAddresses, listCustomersForReconciliation } from './hcp.js';

function credentialsMatch(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function registerEngagementRoutes(app, pool) {
  app.get('/api/integrations/identity/config', (_req, res) => {
    const config = engagementConfig();
    res.json({ configured: config.configured, identityWritesEnabled: config.identityWritesEnabled, reconciliationEnabled: config.reconciliationEnabled, espocrmConfigured: espocrmConfigured(), espocrmWriterConfigured: espocrmWriterConfigured(), defaultPhoneCountry: config.defaultPhoneCountry });
  });

  const requireIntegrationAuth = (req, res, next) => {
    if (!engagementConfig().configured) return res.status(503).json({ error: 'ENGAGEMENT_API_KEY is not configured.' });
    if (!credentialsMatch(req.get('x-engagement-api-key'), process.env.ENGAGEMENT_API_KEY)) return res.status(401).json({ error: 'Integration authentication failed.' });
    return next();
  };

  app.get('/api/integrations/espocrm/inventory', requireIntegrationAuth, async (_req, res) => {
    try { return res.json(await getEspoCrmInventory()); }
    catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  });

  app.post('/api/integrations/identity/reconcile/hcp', requireIntegrationAuth, async (_req, res) => {
    if (!engagementConfig().reconciliationEnabled) return res.status(403).json({ error: 'ENGAGEMENT_RECONCILIATION_ENABLED is off.' });
    let runId = null;
    try {
      const [customers, contacts] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation()]);
      const report = summarizeReconciliation(customers, contacts);
      runId = await createReconciliationRun(pool);
      const decisions = buildHcpReconciliationDecisions(customers, contacts);
      for (const decision of decisions) {
        decision.reconciliationRunId = runId;
        decision.sourceEventId = `run:${runId}:${decision.sourceEventId}`;
        await recordDryRunDecision(pool, decision);
      }
      await finishReconciliationRun(pool, runId, { counts: report.counts });
      return res.json({ dryRun: true, sourceSystem: 'housecall_pro', runId, ...report });
    } catch (error) {
      if (runId) await finishReconciliationRun(pool, runId, { errorCode: 'reconciliation_failed' }).catch(() => {});
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/integrations/identity/audit-addresses/hcp-canaries', requireIntegrationAuth, async (_req, res) => {
    if (!engagementConfig().reconciliationEnabled) return res.status(403).json({ error: 'ENGAGEMENT_RECONCILIATION_ENABLED is off.' });
    try {
      const links = await listProvisionalHcpIdentityLinks();
      const rows = await Promise.all(links.map(async (link) => ({
        contactId: link.contactId,
        linkId: link.id,
        contact: await getContactForAddressAudit(link.contactId),
        addresses: await listCustomerAddresses(link.externalId),
      })));
      return res.json({ dryRun: true, sourceSystem: 'housecall_pro', scope: 'provisional_identity_links', ...summarizeAddressAudit(rows) });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  });

  app.post('/api/integrations/identity/dry-run', requireIntegrationAuth, async (req, res) => {
    try {
      const decision = buildDryRunDecision(req.body || {});
      const stored = await recordDryRunDecision(pool, decision);
      return res.status(stored.replayed ? 200 : 201).json({
        dryRun: true,
        replayed: stored.replayed,
        result: stored.replayed ? stored.event : stored.result,
        correlationId: stored.replayed ? stored.event.correlation_id : stored.event.correlationId,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/integrations/identity/canary/hcp/:customerId', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    try {
      const customer = await getCustomerForReconciliation(req.params.customerId);
      const contacts = await listContactsForReconciliation();
      const decision = buildDryRunDecision({ sourceSystem: 'housecall_pro', sourceEventId: `canary:${customer.id}`, record: customer, contacts });
      if (decision.result.outcome !== 'net_new') return res.status(409).json({ error: `Canary requires a net_new HCP customer; resolver returned ${decision.result.outcome}.`, result: decision.result });
      const created = await createCanaryContactAndLink(buildHcpCanaryProjection(customer));
      decision.sourceEventId = `canary:${fingerprint(customer.id)}`;
      decision.result.contactId = created.contactId;
      await recordDryRunDecision(pool, decision);
      return res.status(201).json({ canary: true, hcpCustomerIdHash: fingerprint(customer.id), contactId: created.contactId, externalIdentityLinkId: created.linkId, linkStatus: 'Provisional' });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message, contactId: error.contactId || null });
    }
  });

  app.post('/api/integrations/identity/canary/hcp-batch', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    try {
      const [customers, contacts] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation()]);
      const batch = selectHcpCanaryCandidates(customers, contacts, { limit: req.body?.limit });
      const created = [];
      for (const candidate of batch.selected) {
        const decision = buildDryRunDecision({ sourceSystem: 'housecall_pro', sourceEventId: `canary:${candidate.customer.id}`, record: candidate.customer, contacts });
        const result = await createCanaryContactAndLink(candidate.projection);
        decision.sourceEventId = `canary:${fingerprint(candidate.customer.id)}`;
        decision.result.contactId = result.contactId;
        await recordDryRunDecision(pool, decision);
        created.push({ hcpCustomerIdHash: fingerprint(candidate.customer.id), contactId: result.contactId, externalIdentityLinkId: result.linkId });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, created, skipped: batch.skipped });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message, contactId: error.contactId || null });
    }
  });
}