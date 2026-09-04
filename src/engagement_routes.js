import crypto from 'node:crypto';
import { buildDryRunDecision, buildHcpReconciliationDecisions, createReconciliationRun, engagementConfig, finishReconciliationRun, recordDryRunDecision, summarizeReconciliation } from './engagement_runtime.js';
import { getEspoCrmInventory, espocrmConfigured, listContactsForReconciliation } from './engagement_espocrm.js';
import { listCustomersForReconciliation } from './hcp.js';

function credentialsMatch(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function registerEngagementRoutes(app, pool) {
  app.get('/api/integrations/identity/config', (_req, res) => {
    const config = engagementConfig();
    res.json({ configured: config.configured, identityWritesEnabled: config.identityWritesEnabled, reconciliationEnabled: config.reconciliationEnabled, espocrmConfigured: espocrmConfigured(), defaultPhoneCountry: config.defaultPhoneCountry });
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
}