// Lead follow-up drip — HTTP routes. Read endpoints are open; enrollment/suppression writes are
// gated behind DRIP_WRITE_ENABLED (like the intake writes). No sends happen here (future sprint).
import { dripConfig, dripReport, getEnrollments, enrollLead, addSuppression, getSequencesDetailed,
  updateMessage, getMessageHistory, setSequenceActive, isDripPaused, setDripPaused } from './drip_runtime.js';
import { sweepOnce, realDripChatwoot, ensurePendingLabel } from './drip_sweep.js';
import { validateMessage, smsSegments } from './drip.js';
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

  app.put('/api/drip/message/:id', requireEdit, async (req, res) => {
    const { body, includeOptout, isActive, changedBy } = req.body || {};
    // Server-side validation mirrors the UI; hard errors block the save.
    if (body != null || includeOptout != null) {
      const issues = validateMessage(body != null ? body : '', { includeOptout: Boolean(includeOptout) });
      const blocking = issues.filter((i) => i.level === 'error');
      if (body != null && blocking.length) return res.status(422).json({ error: blocking[0].message, issues });
    }
    try {
      const out = await updateMessage(pool, Number(req.params.id), { body, includeOptout, isActive, changedBy });
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json({ ...out, segments: smsSegments(out.message.body) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/drip/sequence/:id', requireEdit, async (req, res) => {
    try {
      const out = await setSequenceActive(pool, Number(req.params.id), Boolean(req.body?.isActive));
      if (out.status === 'not_found') return res.status(404).json(out);
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/report', async (_req, res) => {
    try { res.json(await dripReport(pool)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/drip/enrollments', async (req, res) => {
    try { res.json({ enrollments: await getEnrollments(pool, { status: req.query.status || null }) }); }
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

  app.post('/api/drip/suppress', async (req, res) => {
    if (!dripConfig().writeEnabled) return res.status(403).json({ error: 'DRIP_WRITE_ENABLED is off' });
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
