// Lead follow-up drip — HTTP routes. Read endpoints are open; enrollment/suppression writes are
// gated behind DRIP_WRITE_ENABLED (like the intake writes). No sends happen here (future sprint).
import { dripConfig, dripReport, getEnrollments, enrollLead, addSuppression, getSequencesDetailed,
  updateMessage, getMessageHistory, setSequenceActive, isDripPaused, setDripPaused,
  addCategoryMap, deleteCategoryMap, updateStep, addMessage, deleteMessage, updateSequence,
  revertMessage, getSuppressions, removeSuppression, createSequence, addStep, deleteStep,
  getTemplates, getTemplateGroup, updateTemplate, getTemplateHistory, revertTemplate, resolveAutoreply,
  createTemplate, setTemplateCategory, setTemplateActive, deleteTemplate } from './drip_runtime.js';
import { sweepOnce, realDripChatwoot, ensurePendingLabel } from './drip_sweep.js';
import { validateMessage, smsSegments, validateCategoryMap, validateVariant, validateSequenceSettings,
  validateSequenceCreate, validateTemplateBody, validateTemplateCreate } from './drip.js';
import * as cw from './chatwoot.js';

export function registerDripRoutes(app, pool) {
  app.get('/api/drip/config', (_req, res) => res.json(dripConfig()));

  app.get('/api/drip/sequences', async (_req, res) => {
    try { res.json(await getSequencesDetailed(pool)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Config editing (gated behind DRIP_CONFIG_EDIT_ENABLED) ----
  const requireEdit = (_req, res, next) => {
    if (!dripConfig().editEnabled) return res.status(403).json({ error: 'DRIP_CONFIG_EDIT_ENABLED is off' });
    next();
  };

  app.get('/api/drip/pause', async (_req, res) => {
    try { res.json({ paused: await isDripPaused(pool) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/pause', requireEdit, async (req, res) => {
    try { res.json(await setDripPaused(pool, Boolean(req.body?.paused), req.body?.changedBy)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/message/:id/history', async (req, res) => {
    try { res.json({ history: await getMessageHistory(pool, Number(req.params.id)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/message/:id/revert', requireEdit, async (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) return res.status(422).json({ error: 'A numeric version is required.' });
    try {
      const out = await revertMessage(pool, Number(req.params.id), version, req.body?.changedBy);
      if (out.status === 'version_not_found') return res.status(404).json({ error: `Version ${version} not found for this message.` });
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/suppressions', async (_req, res) => {
    try { res.json({ suppressions: await getSuppressions(pool) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/drip/suppress', requireEdit, async (req, res) => {
    const phone = req.body?.phone || req.query?.phone;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    try {
      const out = await removeSuppression(pool, String(phone));
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/message/:id', requireEdit, async (req, res) => {
    const { body, includeOptout, isActive, weight, changedBy } = req.body || {};
    // Server-side validation mirrors the UI; hard errors block the save.
    if (body != null || includeOptout != null) {
      const issues = validateMessage(body != null ? body : '', { includeOptout: Boolean(includeOptout) });
      const blocking = issues.filter((i) => i.level === 'error');
      if (body != null && blocking.length) return res.status(422).json({ error: blocking[0].message, issues });
    }
    try {
      const out = await updateMessage(pool, Number(req.params.id), { body, includeOptout, isActive, weight, changedBy });
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json({ ...out, segments: smsSegments(out.message.body) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/message', requireEdit, async (req, res) => {
    const { stepId, categoryKey, variant, body, includeOptout, weight, changedBy } = req.body || {};
    if (!stepId) return res.status(422).json({ error: 'stepId is required.' });
    const v = validateVariant(variant);
    if (!v.ok) return res.status(422).json({ error: v.error });
    const issues = validateMessage(body, { includeOptout: Boolean(includeOptout) });
    const blocking = issues.filter((i) => i.level === 'error');
    if (blocking.length) return res.status(422).json({ error: blocking[0].message, issues });
    try {
      const out = await addMessage(pool, { stepId: Number(stepId), categoryKey: categoryKey || null, variant: v.value, body, includeOptout, weight, changedBy });
      if (out.status === 'not_found') return res.status(404).json({ error: 'Step not found.' });
      if (out.status === 'conflict') return res.status(409).json({ error: `Variant "${v.value}" already exists for this step/category.` });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/drip/message/:id', requireEdit, async (req, res) => {
    try {
      const out = await deleteMessage(pool, Number(req.params.id));
      if (out.status === 'not_found') return res.status(404).json(out);
      if (out.status === 'last_in_group') return res.status(409).json({ error: 'Cannot delete the step\'s only default message.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/sequence/:id', requireEdit, async (req, res) => {
    const patch = req.body || {};
    try {
      // Activation toggle and settings edits share the route.
      if (patch.isActive != null && Object.keys(patch).filter((k) => k !== 'changedBy').length === 1) {
        const out = await setSequenceActive(pool, Number(req.params.id), Boolean(patch.isActive));
        if (out.status === 'not_found') return res.status(404).json(out);
        return res.json(out);
      }
      const v = validateSequenceSettings(patch);
      if (!v.ok) return res.status(422).json({ error: v.error });
      const out = await updateSequence(pool, Number(req.params.id), v.value);
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/step/:id', requireEdit, async (req, res) => {
    const { offsetMinutes } = req.body || {};
    if (offsetMinutes != null && (!Number.isFinite(Number(offsetMinutes)) || Number(offsetMinutes) < 0)) {
      return res.status(422).json({ error: 'offsetMinutes must be a number >= 0.' });
    }
    try {
      const out = await updateStep(pool, Number(req.params.id), req.body || {});
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/taxonomy', requireEdit, async (req, res) => {
    const v = validateCategoryMap(req.body || {});
    if (!v.ok) return res.status(422).json({ error: v.error });
    try { res.json(await addCategoryMap(pool, v.value)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/drip/taxonomy/:id', requireEdit, async (req, res) => {
    try {
      const out = await deleteCategoryMap(pool, Number(req.params.id));
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/sequence', requireEdit, async (req, res) => {
    const idv = validateSequenceCreate(req.body || {});
    if (!idv.ok) return res.status(422).json({ error: idv.error });
    const hasSettings = ['maxMessages', 'expiresAfterHours', 'quietStart', 'quietEnd', 'variantStrategy']
      .some((k) => req.body?.[k] != null);
    let settings = {};
    if (hasSettings) {
      const sv = validateSequenceSettings(req.body || {});
      if (!sv.ok) return res.status(422).json({ error: sv.error });
      settings = sv.value;
    }
    try {
      const out = await createSequence(pool, idv.value, settings);
      if (out.status === 'conflict') return res.status(409).json({ error: `A sequence with key "${idv.value.key}" already exists.` });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/step', requireEdit, async (req, res) => {
    const { sequenceId, stepIndex, offsetMinutes, body, includeOptout } = req.body || {};
    if (!sequenceId) return res.status(422).json({ error: 'sequenceId is required.' });
    if (!Number.isInteger(Number(stepIndex)) || Number(stepIndex) < 0) return res.status(422).json({ error: 'stepIndex must be a whole number >= 0.' });
    if (!Number.isFinite(Number(offsetMinutes)) || Number(offsetMinutes) < 0) return res.status(422).json({ error: 'offsetMinutes must be a number >= 0.' });
    if (body != null && String(body).trim()) {
      const issues = validateMessage(body, { includeOptout: Boolean(includeOptout) }).filter((i) => i.level === 'error');
      if (issues.length) return res.status(422).json({ error: issues[0].message });
    }
    try {
      const out = await addStep(pool, req.body || {});
      if (out.status === 'not_found') return res.status(404).json({ error: 'Sequence not found.' });
      if (out.status === 'conflict') return res.status(409).json({ error: `Step ${stepIndex} already exists in this sequence.` });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/drip/step/:id', requireEdit, async (req, res) => {
    try {
      const out = await deleteStep(pool, Number(req.params.id));
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Auto-reply templates (welcome copy; n8n reads a group, dashboard edits) ----
  app.get('/api/drip/templates', async (_req, res) => {
    try { res.json({ templates: await getTemplates(pool) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/templates/:group', async (req, res) => {
    try { res.json(await getTemplateGroup(pool, req.params.group)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Taxonomy-driven pick: n8n passes the raw lead category, gets back the matching template body
  // (or the group's 'generic' fallback). Ties auto-replies to the same drip_category_map as drips.
  app.get('/api/drip/autoreply/:group/resolve', async (req, res) => {
    try { res.json(await resolveAutoreply(pool, req.params.group, req.query.category)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/template/:key/history', async (req, res) => {
    try { res.json({ history: await getTemplateHistory(pool, req.params.key) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/template', requireEdit, async (req, res) => {
    const v = validateTemplateCreate(req.body || {});
    if (!v.ok) return res.status(422).json({ error: v.error });
    try {
      const out = await createTemplate(pool, v.value);
      if (out.status === 'exists') return res.status(409).json({ error: 'A template with that group and sub key already exists.' });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/template/:key/category', requireEdit, async (req, res) => {
    try {
      const out = await setTemplateCategory(pool, req.params.key, req.body?.categoryKey);
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/template/:key/active', requireEdit, async (req, res) => {
    try {
      const out = await setTemplateActive(pool, req.params.key, req.body?.isActive);
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/drip/template/:key', requireEdit, async (req, res) => {
    try {
      const out = await deleteTemplate(pool, req.params.key);
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/template/:key', requireEdit, async (req, res) => {
    const v = validateTemplateBody(req.body?.body);
    if (!v.ok) return res.status(422).json({ error: v.error });
    try {
      const out = await updateTemplate(pool, req.params.key, v.value, req.body?.changedBy);
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/template/:key/revert', requireEdit, async (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) return res.status(422).json({ error: 'A numeric version is required.' });
    try {
      const out = await revertTemplate(pool, req.params.key, version, req.body?.changedBy);
      if (out.status === 'version_not_found') return res.status(404).json({ error: `Version ${version} not found.` });
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/report', async (_req, res) => {
    try { res.json(await dripReport(pool)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/enrollments', async (req, res) => {
    try { res.json({ enrollments: await getEnrollments(pool, { status: req.query.status || null, source: req.query.source || null }) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/enroll', async (req, res) => {
    if (!dripConfig().writeEnabled) return res.status(403).json({ error: 'DRIP_WRITE_ENABLED is off' });
    try {
      const body = req.body || {};
      const result = await enrollLead(pool, body);
      if (result.status === 'enrolled' && body.conversationId) {
        try { await ensurePendingLabel(cw, body.conversationId); } catch { /* non-fatal: label is best-effort */ }
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/suppress', requireEdit, async (req, res) => {
    const { phone, reason, source } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    try { res.json(await addSuppression(pool, phone, reason, source)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual sweep trigger. Dry-run by default; a real (sending) run requires ?dryRun=false AND
  // DRIP_SEND_ENABLED. Dry-run still reads conversations to show what WOULD be sent/exited.
  app.post('/api/drip/sweep', async (req, res) => {
    const wantSend = req.query.dryRun === 'false';
    if (wantSend && !dripConfig().sendEnabled) return res.status(403).json({ error: 'DRIP_SEND_ENABLED is off' });
    try {
      const results = await sweepOnce(pool, { chatwoot: realDripChatwoot(cw), dryRun: !wantSend });
      res.json({ dryRun: !wantSend, count: results.length, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
