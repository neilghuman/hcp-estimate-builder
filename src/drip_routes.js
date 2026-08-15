// Lead follow-up drip — HTTP routes. Read endpoints are open; enrollment/suppression writes are
// gated behind DRIP_WRITE_ENABLED (like the intake writes). No sends happen here (future sprint).
import { dripConfig, dripReport, getEnrollments, enrollLead, addSuppression } from './drip_runtime.js';

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
    try { res.json(await enrollLead(pool, req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/drip/suppress', async (req, res) => {
    if (!dripConfig().writeEnabled) return res.status(403).json({ error: 'DRIP_WRITE_ENABLED is off' });
    const { phone, reason, source } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    try { res.json(await addSuppression(pool, phone, reason, source)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
