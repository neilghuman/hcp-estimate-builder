// Lead follow-up drip — HTTP routes. Read endpoints are open; enrollment/suppression writes are
// gated behind DRIP_WRITE_ENABLED (like the intake writes). No sends happen here (future sprint).
import { dripConfig, dripReport, getEnrollments, enrollLead, addSuppression } from './drip_runtime.js';
import { sweepOnce, realDripChatwoot, ensurePendingLabel } from './drip_sweep.js';
import * as cw from './chatwoot.js';

export function registerDripRoutes(app, pool) {
  app.get('/api/drip/config', (_req, res) => res.json(dripConfig()));

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
