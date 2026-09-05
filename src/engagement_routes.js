import crypto from 'node:crypto';
import { buildDryRunDecision, buildHcpCanaryProjection, buildHcpReconciliationDecisions, buildIdentityReview, buildReviewExecutionPlan, compareContactAddress, completeHcpImportRun, createHcpImportRun, createReconciliationRun, engagementConfig, finishReconciliationRun, fingerprint, getHcpImportRun, recordAddressProjection, recordDryRunDecision, recordHcpImportBatch, recordReviewExecution, selectAddressBackfillCandidates, selectAddressWriteCanary, selectHcpCanaryCandidates, selectHcpImportCandidates, selectIdentityReviewCandidates, selectPrimaryHcpAddress, summarizeAddressAudit, summarizeReconciliation } from './engagement_runtime.js';
import { createCanaryContactAndLink, createExternalIdentityLink, createIdentityReview, findExternalIdentityLinkByExternalId, findOpenIdentityReview, getContactForAddressAudit, getEspoCrmInventory, listContactsWithAddresses, listDecidedIdentityReviews, updateCanaryContactAddress, updateExternalIdentityLink, updateIdentityReview, espocrmAddressWriterConfigured, espocrmConfigured, espocrmWriterConfigured, listContactsForReconciliation, listHcpIdentityLinks, listOpenIdentityReviews, listProvisionalHcpIdentityLinks } from './engagement_espocrm.js';
import { getCustomerForReconciliation, listCustomerAddresses, listCustomersForReconciliation } from './hcp.js';

function credentialsMatch(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function registerEngagementRoutes(app, pool) {
  app.get('/api/integrations/identity/config', (_req, res) => {
    const config = engagementConfig();
    res.json({ configured: config.configured, identityWritesEnabled: config.identityWritesEnabled, reconciliationEnabled: config.reconciliationEnabled, espocrmConfigured: espocrmConfigured(), espocrmWriterConfigured: espocrmWriterConfigured(), espocrmAddressWriterConfigured: espocrmAddressWriterConfigured(), defaultPhoneCountry: config.defaultPhoneCountry });
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

  app.post('/api/integrations/identity/canary/hcp-reviews', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    try {
      const [customers, contacts, openReviews] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation(), listOpenIdentityReviews()]);
      const existingSourceIds = new Set(openReviews
        .filter((review) => review.sourceSystem === 'HousecallPro' && review.sourceAccountId === process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID)
        .map((review) => String(review.externalId)));
      const batch = selectIdentityReviewCandidates(customers, contacts, { limit: req.body?.limit, existingSourceIds });
      const created = [];
      const existing = [];
      for (const candidate of batch.selected) {
        const review = buildIdentityReview(candidate.customer, candidate.result);
        const open = await findOpenIdentityReview(review);
        if (open) {
          existing.push({ identityReviewId: open.id, hcpCustomerIdHash: fingerprint(candidate.customer.id), outcome: candidate.result.outcome });
          continue;
        }
        const inserted = await createIdentityReview(review);
        created.push({ identityReviewId: inserted.id, hcpCustomerIdHash: fingerprint(candidate.customer.id), outcome: candidate.result.outcome });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, created, existing, skipped: batch.skipped });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  });

  app.post('/api/integrations/identity/reviews/execute', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    const requestedReviewId = req.body?.reviewId ? String(req.body.reviewId) : null;
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 50);
    try {
      const decided = await listDecidedIdentityReviews();
      const targets = (requestedReviewId ? decided.filter((review) => review.id === requestedReviewId) : decided).slice(0, limit);
      const executed = [];
      const failed = [];
      for (const review of targets) {
        try {
          const needsCustomer = ['CreateNew', 'Separate'].includes(review.decision);
          const hcpCustomer = needsCustomer ? await getCustomerForReconciliation(review.externalId) : null;
          const plan = buildReviewExecutionPlan(review, hcpCustomer);
          let contactId = plan.contactId || null;
          let externalIdentityLinkId = null;
          if (plan.action === 'link') {
            const existing = await findExternalIdentityLinkByExternalId({ sourceSystem: 'HousecallPro', externalId: review.externalId });
            if (!existing) {
              const link = await createExternalIdentityLink(plan.link);
              externalIdentityLinkId = link.id;
            } else if (String(existing.contactId) === String(plan.contactId)) {
              if (existing.linkStatus !== 'Confirmed') await updateExternalIdentityLink(existing.id, { linkStatus: 'Confirmed' });
              externalIdentityLinkId = existing.id;
            } else {
              throw Object.assign(new Error(`externalId is already linked to a different contact (${existing.contactId}); manual review required.`), { status: 409 });
            }
          } else if (plan.action === 'create') {
            const created = await createCanaryContactAndLink({ contact: plan.contact, link: plan.link, skipDuplicateCheck: true });
            contactId = created.contactId;
            externalIdentityLinkId = created.linkId;
          }
          await updateIdentityReview(review.id, { ...plan.reviewUpdate, decidedAt: new Date().toISOString() });
          await recordReviewExecution(pool, { reviewId: review.id, contactId, decision: review.decision });
          executed.push({ reviewId: review.id, action: plan.action, decision: review.decision, hcpCustomerIdHash: fingerprint(review.externalId), contactId, externalIdentityLinkId });
        } catch (error) {
          failed.push({ reviewId: review.id, decision: review.decision, error: error.message, status: error.status || 500 });
        }
      }
      return res.status(failed.length && !executed.length ? 502 : 201).json({ executed, failed, count: executed.length });
    } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  });

  app.post('/api/integrations/identity/imports/hcp/batch', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    const requestedBatchSize = Math.min(Math.max(Number(req.body?.batchSize) || 25, 1), 50);
    let run = null;
    try {
      run = req.body?.runId ? await getHcpImportRun(pool, String(req.body.runId)) : await createHcpImportRun(pool, requestedBatchSize);
      if (!run) return res.status(404).json({ error: 'Import run not found.' });
      if (run.status !== 'running') return res.status(409).json({ error: `Import run is ${run.status}.`, runId: run.id });
      const batchSize = Number(run.batch_size || run.batchSize || requestedBatchSize);
      const [customers, contacts, links] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation(), listHcpIdentityLinks()]);
      const existingSourceIds = new Set(links.map((link) => String(link.externalId)));
      const batch = selectHcpImportCandidates(customers, contacts, { limit: batchSize, existingSourceIds });
      const created = [];
      const failed = [];
      for (const candidate of batch.selected) {
        try {
          const decision = buildDryRunDecision({ sourceSystem: 'housecall_pro', sourceEventId: `import:${run.id}:${candidate.customer.id}`, record: candidate.customer, contacts });
          const result = await createCanaryContactAndLink({ ...candidate.projection, skipDuplicateCheck: true });
          decision.sourceEventId = `import:${run.id}:${fingerprint(candidate.customer.id)}`;
          decision.result.contactId = result.contactId;
          await recordDryRunDecision(pool, decision);
          created.push({ hcpCustomerIdHash: fingerprint(candidate.customer.id), contactId: result.contactId, externalIdentityLinkId: result.linkId });
        } catch (error) {
          failed.push({ hcpCustomerIdHash: fingerprint(candidate.customer.id), error: error.message, status: error.status || 500 });
        }
      }
      await recordHcpImportBatch(pool, { runId: run.id, selectedCount: batch.selected.length, createdCount: created.length, skippedCounts: batch.skipped });
      const complete = batch.selected.length === 0;
      if (complete) await completeHcpImportRun(pool, run.id);
      return res.status(201).json({ runId: run.id, batchSize, created, failed, skipped: batch.skipped, complete });
    } catch (error) {
      if (run?.id) await recordHcpImportBatch(pool, { runId: run.id, selectedCount: 0, createdCount: 0, skippedCounts: {}, errorCode: 'batch_failed' }).catch(() => {});
      return res.status(error.status || 500).json({ error: error.message, runId: run?.id || null });
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

  app.post('/api/integrations/identity/canary/hcp-addresses', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    let stage = 'load_candidates';
    try {
      const links = await listProvisionalHcpIdentityLinks();
      const rows = await Promise.all(links.map(async (link) => ({
        contactId: link.contactId,
        linkId: link.id,
        contact: await getContactForAddressAudit(link.contactId),
        addresses: await listCustomerAddresses(link.externalId),
      })));
      const batch = selectAddressWriteCanary(rows, { limit: req.body?.limit });
      const updated = [];
      for (const candidate of batch.selected) {
        stage = `update:${candidate.contactId}`;
        const contact = await updateCanaryContactAddress(candidate.contactId, candidate.address);
        stage = `verify:${candidate.contactId}`;
        const verification = compareContactAddress(contact, candidate.address);
        if (verification.status !== 'match') throw new Error(`Contact address read-back did not match for ${candidate.contactId}.`);
        stage = `audit:${candidate.contactId}`;
        await recordAddressProjection(pool, { contactId: candidate.contactId, linkId: candidate.linkId, addressId: candidate.address.id });
        updated.push({ contactId: candidate.contactId, linkId: candidate.linkId, addressType: candidate.address.type, hcpAddressIdHash: fingerprint(candidate.address.id) });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, updated, skipped: batch.skipped });
    } catch (error) {
      console.error('[ENGAGEMENT_ADDRESS_CANARY_FAILED]', { stage, message: error.message });
      return res.status(error.status || 500).json({ error: error.message, stage });
    }
  });

  app.post('/api/integrations/identity/canary/hcp-addresses-25', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    let stage = 'load_candidates';
    try {
      const links = await listProvisionalHcpIdentityLinks();
      const rows = await Promise.all(links.map(async (link) => ({
        contactId: link.contactId,
        linkId: link.id,
        contact: await getContactForAddressAudit(link.contactId),
        addresses: await listCustomerAddresses(link.externalId),
      })));
      const batch = selectAddressWriteCanary(rows, { limit: req.body?.limit, maxLimit: 25 });
      const updated = [];
      for (const candidate of batch.selected) {
        stage = `update:${candidate.contactId}`;
        const contact = await updateCanaryContactAddress(candidate.contactId, candidate.address);
        stage = `verify:${candidate.contactId}`;
        const verification = compareContactAddress(contact, candidate.address);
        if (verification.status !== 'match') throw new Error(`Contact address read-back did not match for ${candidate.contactId}.`);
        stage = `audit:${candidate.contactId}`;
        await recordAddressProjection(pool, { contactId: candidate.contactId, linkId: candidate.linkId, addressId: candidate.address.id });
        updated.push({ contactId: candidate.contactId, linkId: candidate.linkId, addressType: candidate.address.type, hcpAddressIdHash: fingerprint(candidate.address.id) });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, updated, skipped: batch.skipped });
    } catch (error) {
      console.error('[ENGAGEMENT_ADDRESS_CANARY_FAILED]', { stage, message: error.message });
      return res.status(error.status || 500).json({ error: error.message, stage });
    }
  });

  app.post('/api/integrations/identity/canary/hcp-addresses-100', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    let stage = 'load_candidates';
    try {
      const links = await listProvisionalHcpIdentityLinks();
      const rows = await Promise.all(links.map(async (link) => ({
        contactId: link.contactId,
        linkId: link.id,
        contact: await getContactForAddressAudit(link.contactId),
        addresses: await listCustomerAddresses(link.externalId),
      })));
      const batch = selectAddressWriteCanary(rows, { limit: req.body?.limit, maxLimit: 100 });
      const updated = [];
      for (const candidate of batch.selected) {
        stage = `update:${candidate.contactId}`;
        const contact = await updateCanaryContactAddress(candidate.contactId, candidate.address);
        stage = `verify:${candidate.contactId}`;
        const verification = compareContactAddress(contact, candidate.address);
        if (verification.status !== 'match') throw new Error(`Contact address read-back did not match for ${candidate.contactId}.`);
        stage = `audit:${candidate.contactId}`;
        await recordAddressProjection(pool, { contactId: candidate.contactId, linkId: candidate.linkId, addressId: candidate.address.id });
        updated.push({ contactId: candidate.contactId, linkId: candidate.linkId, addressType: candidate.address.type, hcpAddressIdHash: fingerprint(candidate.address.id) });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, updated, skipped: batch.skipped });
    } catch (error) {
      console.error('[ENGAGEMENT_ADDRESS_CANARY_FAILED]', { stage, message: error.message });
      return res.status(error.status || 500).json({ error: error.message, stage });
    }
  });

  app.post('/api/integrations/identity/canary/hcp-addresses-bulk', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    let stage = 'load_candidates';
    try {
      const [links, contacts] = await Promise.all([listProvisionalHcpIdentityLinks(), listContactsWithAddresses()]);
      const byId = new Map(contacts.map((contact) => [String(contact.id), contact]));
      const batch = selectAddressBackfillCandidates(links, byId, { limit: req.body?.limit, maxLimit: 200 });
      const updated = [];
      const skipped = { ...batch.skipped };
      for (const candidate of batch.selected) {
        stage = `addresses:${candidate.contactId}`;
        const selection = selectPrimaryHcpAddress(await listCustomerAddresses(candidate.externalId));
        if (!selection.address) { skipped[selection.status] = (skipped[selection.status] || 0) + 1; continue; }
        stage = `update:${candidate.contactId}`;
        const contact = await updateCanaryContactAddress(candidate.contactId, selection.address);
        stage = `verify:${candidate.contactId}`;
        if (compareContactAddress(contact, selection.address).status !== 'match') throw new Error(`Contact address read-back did not match for ${candidate.contactId}.`);
        stage = `audit:${candidate.contactId}`;
        await recordAddressProjection(pool, { contactId: candidate.contactId, linkId: candidate.linkId, addressId: selection.address.id });
        updated.push({ contactId: candidate.contactId, linkId: candidate.linkId, addressType: selection.address.type, hcpAddressIdHash: fingerprint(selection.address.id) });
      }
      return res.status(201).json({ canary: true, requestedLimit: batch.limit, updated, skipped });
    } catch (error) {
      console.error('[ENGAGEMENT_ADDRESS_BULK_FAILED]', { stage, message: error.message });
      return res.status(error.status || 500).json({ error: error.message, stage });
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

  app.post('/api/integrations/identity/canary/hcp-batch-25', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    try {
      const [customers, contacts] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation()]);
      const batch = selectHcpCanaryCandidates(customers, contacts, { limit: req.body?.limit, maxLimit: 25 });
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
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, contactId: error.contactId || null }); }
  });

  app.post('/api/integrations/identity/canary/hcp-batch-100', requireIntegrationAuth, async (req, res) => {
    if (!engagementConfig().identityWritesEnabled) return res.status(403).json({ error: 'ENGAGEMENT_IDENTITY_WRITES_ENABLED is off.' });
    try {
      const [customers, contacts] = await Promise.all([listCustomersForReconciliation(), listContactsForReconciliation()]);
      const batch = selectHcpCanaryCandidates(customers, contacts, { limit: req.body?.limit, maxLimit: 100 });
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
    } catch (error) { return res.status(error.status || 500).json({ error: error.message, contactId: error.contactId || null }); }
  });
}