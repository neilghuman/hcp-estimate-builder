// Lead follow-up drip — runtime service (in-app). DB glue over the drip_* tables; the pure
// decision logic lives in ./drip.js. Sends are NOT performed here — S2 stops at enrollment,
// message resolution, and reporting. The sweep/send path is gated and added in a later sprint.
import {
  resolveMessage, resolveCategoryKey, computeNextDueAt, applyQuietHours, nestSequences,
} from './drip.js';
export function dripConfig() {
  const flag = (v, def) => String(process.env[v] ?? def).toLowerCase();
  return {
    enabled: flag('DRIP_ENABLED', 'true') !== 'false',      // routes visible
    writeEnabled: flag('DRIP_WRITE_ENABLED', 'false') === 'true', // enrollment writes
    sendEnabled: flag('DRIP_SEND_ENABLED', 'false') === 'true',   // real sends (future sprint)
    editEnabled: flag('DRIP_CONFIG_EDIT_ENABLED', 'false') === 'true', // dashboard config editing
  };
}

async function isSuppressed(pool, phone) {
  const r = await pool.query('SELECT 1 FROM drip_suppression WHERE phone_e164 = $1', [phone]);
  return r.rows.length > 0;
}

// Enroll a lead after its initial message succeeded. Idempotent on lead_ref. Caller gates on
// dripConfig().writeEnabled. Returns { status, enrollmentId }.
export async function enrollLead(pool, lead) {
  const { leadRef, source, vertical, phone, t0 } = lead;
  if (!leadRef || !phone || !t0) return { status: 'invalid' };
  if (await isSuppressed(pool, phone)) return { status: 'suppressed' };

  const seqRes = await pool.query(
    `SELECT id, max_messages, expires_after_hours, quiet_start_local, quiet_end_local, tz_default
       FROM drip_sequence
      WHERE ($1::text IS NOT NULL AND key = $1)
         OR (source = $2 AND (vertical = $3 OR ($3 IS NULL AND vertical IS NULL)))
      ORDER BY (key = $1) DESC, is_active DESC
      LIMIT 1`,
    [lead.sequenceKey || null, source || null, vertical || null],
  );
  const seq = seqRes.rows[0];
  if (!seq) return { status: 'no_sequence' };

  const stepRes = await pool.query(
    'SELECT offset_minutes FROM drip_step WHERE sequence_id = $1 AND step_index = 1 AND is_active = TRUE',
    [seq.id],
  );
  const firstOffset = stepRes.rows[0] ? Number(stepRes.rows[0].offset_minutes) : 30;

  let categoryKey = lead.categoryKey || null;
  if (!categoryKey && lead.categoryRaw) {
    const mapRes = await pool.query('SELECT category_key, source, raw_value FROM drip_category_map WHERE source = $1', [source || null]);
    categoryKey = resolveCategoryKey(mapRes.rows, source, lead.categoryRaw);
  }

  const t0Date = new Date(t0);
  const nextDue = applyQuietHours(computeNextDueAt(t0Date, firstOffset), {
    tz: lead.timeZone || seq.tz_default,
    start: seq.quiet_start_local,
    end: seq.quiet_end_local,
  });
  const expiresAt = new Date(t0Date.getTime() + Number(seq.expires_after_hours) * 3600000);

  const ins = await pool.query(
    `INSERT INTO drip_enrollment
       (sequence_id, lead_ref, conversation_id, source, vertical, channel, phone_e164,
        category_raw, category_key, time_zone, step, t0_at, next_due_at, max_messages, expires_at, first_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15)
     ON CONFLICT (lead_ref) DO NOTHING
     RETURNING id`,
    [
      seq.id, leadRef, lead.conversationId || null, source || null, vertical || null,
      lead.channel || 'sms', phone, lead.categoryRaw || null, categoryKey,
      lead.timeZone || seq.tz_default, t0Date.toISOString(), nextDue.toISOString(),
      Number(seq.max_messages), expiresAt.toISOString(), lead.firstName || null,
    ],
  );
  if (ins.rows[0]) return { status: 'enrolled', enrollmentId: ins.rows[0].id, categoryKey, nextDueAt: nextDue.toISOString() };
  return { status: 'exists' };
}

// Resolve the message that WOULD be sent for an enrollment's current step (no send performed).
export async function resolveNextMessage(pool, enrollment) {
  const seqRes = await pool.query('SELECT variant_strategy FROM drip_sequence WHERE id = $1', [enrollment.sequence_id]);
  const strategy = seqRes.rows[0]?.variant_strategy || 'random';
  const msgRes = await pool.query(
    `SELECT m.category_key, m.variant, m.body, m.weight, m.is_active
       FROM drip_message m
       JOIN drip_step st ON st.id = m.step_id
      WHERE st.sequence_id = $1 AND st.step_index = $2`,
    [enrollment.sequence_id, enrollment.step],
  );
  return resolveMessage(msgRes.rows, { categoryKey: enrollment.category_key, strategy });
}

export async function getEnrollments(pool, { status = null, limit = 100 } = {}) {
  const r = await pool.query(
    `SELECT id, lead_ref, source, vertical, category_key, phone_e164, step, status,
            t0_at, next_due_at, attempts, exit_reason
       FROM drip_enrollment
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY next_due_at NULLS LAST
      LIMIT $2`,
    [status, limit],
  );
  return r.rows;
}

export async function dripReport(pool) {
  const byStatus = await pool.query('SELECT status, count(*)::int AS n FROM drip_enrollment GROUP BY status');
  const byExit = await pool.query("SELECT exit_reason, count(*)::int AS n FROM drip_enrollment WHERE exit_reason IS NOT NULL GROUP BY exit_reason");
  const sequences = await pool.query('SELECT key, name, source, vertical, is_active FROM drip_sequence ORDER BY key');
  return {
    byStatus: byStatus.rows,
    byExit: byExit.rows,
    sequences: sequences.rows,
    stepStats: await dripStepStats(pool),
  };
}

export async function addSuppression(pool, phone, reason, source) {
  await pool.query(
    'INSERT INTO drip_suppression (phone_e164, reason, source) VALUES ($1,$2,$3) ON CONFLICT (phone_e164) DO NOTHING',
    [phone, reason || null, source || null],
  );
  return { status: 'suppressed', phone };
}

// ---- Sweep DB helpers --------------------------------------------------------

export async function getDue(pool, now = new Date(), limit = 50) {
  const r = await pool.query(
    `SELECT id, sequence_id, lead_ref, conversation_id, source, vertical, phone_e164,
            category_key, first_name, time_zone, step, t0_at, attempts, max_messages, expires_at, status
       FROM drip_enrollment
      WHERE status = 'active' AND next_due_at IS NOT NULL AND next_due_at <= $1
      ORDER BY next_due_at
      LIMIT $2`,
    [new Date(now).toISOString(), limit],
  );
  return r.rows;
}

export async function getSequence(pool, id) {
  const r = await pool.query(
    'SELECT id, max_messages, expires_after_hours, quiet_start_local, quiet_end_local, tz_default, variant_strategy FROM drip_sequence WHERE id = $1',
    [id],
  );
  return r.rows[0] || null;
}

export async function getSteps(pool, sequenceId) {
  const r = await pool.query(
    'SELECT step_index, offset_minutes, is_active FROM drip_step WHERE sequence_id = $1 ORDER BY step_index',
    [sequenceId],
  );
  return r.rows;
}

export async function isPhoneSuppressed(pool, phone) {
  return isSuppressed(pool, phone);
}

// Atomic per-step claim via the delivery log's unique idem_key. Returns true if this call won.
export async function claimStep(pool, enrollment, idemKey) {
  const r = await pool.query(
    `INSERT INTO drip_delivery_log (enrollment_id, lead_ref, step, idem_key, status)
     VALUES ($1,$2,$3,$4,'sending')
     ON CONFLICT (idem_key) DO NOTHING
     RETURNING id`,
    [enrollment.id, enrollment.lead_ref, enrollment.step, idemKey],
  );
  return r.rows.length > 0;
}

export async function markDelivery(pool, idemKey, { status, providerMessageId = null, errorCode = null } = {}) {
  await pool.query(
    'UPDATE drip_delivery_log SET status = $2, provider_message_id = $3, error_code = $4 WHERE idem_key = $1',
    [idemKey, status, providerMessageId, errorCode],
  );
}

export async function exitEnrollment(pool, id, reason) {
  await pool.query(
    "UPDATE drip_enrollment SET status = 'exited', exit_reason = $2, updated_at = now() WHERE id = $1",
    [id, reason],
  );
}

export async function deferEnrollment(pool, id, nextDueAt) {
  await pool.query(
    'UPDATE drip_enrollment SET next_due_at = $2, updated_at = now() WHERE id = $1',
    [id, nextDueAt],
  );
}

// Apply a post-send outcome: either advance to the next step or complete.
export async function applyAfterSend(pool, id, after, sentAt = new Date()) {
  if (after.status === 'completed') {
    await pool.query(
      "UPDATE drip_enrollment SET status = 'completed', exit_reason = $2, attempts = attempts + 1, last_message_at = $3, next_due_at = NULL, updated_at = now() WHERE id = $1",
      [id, after.reason, new Date(sentAt).toISOString()],
    );
  } else {
    await pool.query(
      'UPDATE drip_enrollment SET step = $2, next_due_at = $3, attempts = attempts + 1, last_message_at = $4, updated_at = now() WHERE id = $1',
      [id, after.step, after.nextDueAt, new Date(sentAt).toISOString()],
    );
  }
}

// Full config tree (sequences -> steps -> messages) + taxonomy, for the read-only dashboard.
export async function getSequencesDetailed(pool) {
  const seq = await pool.query(
    `SELECT id, key, name, source, vertical, channel, is_active, max_messages, expires_after_hours,
            quiet_start_local, quiet_end_local, tz_default, variant_strategy
       FROM drip_sequence ORDER BY key`,
  );
  const steps = await pool.query(
    'SELECT id, sequence_id, step_index, offset_minutes, label, is_active FROM drip_step ORDER BY sequence_id, step_index',
  );
  const msgs = await pool.query(
    `SELECT id, step_id, category_key, variant, body, include_optout, weight, is_active, version
       FROM drip_message ORDER BY step_id, category_key NULLS FIRST, variant`,
  );
  const taxonomy = await pool.query(
    'SELECT id, category_key, source, raw_value FROM drip_category_map ORDER BY category_key, source, raw_value',
  );
  return {
    sequences: nestSequences(seq.rows, steps.rows, msgs.rows),
    taxonomy: taxonomy.rows,
  };
}

// ---- Config editing (dashboard, gated) ---------------------------------------

// Update a single message. A body change is versioned: the prior body is copied to
// drip_message_history and the version bumps. Flag-only changes do not bump the version.
export async function updateMessage(pool, id, { body, includeOptout, isActive, changedBy } = {}) {
  const cur = (await pool.query('SELECT id, body, include_optout, is_active, version FROM drip_message WHERE id = $1', [id])).rows[0];
  if (!cur) return { status: 'not_found' };

  const nextBody = body != null ? String(body) : cur.body;
  const bodyChanged = body != null && nextBody !== cur.body;
  const nextOptout = includeOptout != null ? Boolean(includeOptout) : cur.include_optout;
  const nextActive = isActive != null ? Boolean(isActive) : cur.is_active;

  if (bodyChanged) {
    await pool.query(
      'INSERT INTO drip_message_history (message_id, body, version, changed_by) VALUES ($1,$2,$3,$4)',
      [id, cur.body, cur.version, changedBy || 'dashboard'],
    );
  }
  const nextVersion = bodyChanged ? Number(cur.version) + 1 : cur.version;
  const upd = await pool.query(
    `UPDATE drip_message
        SET body = $2, include_optout = $3, is_active = $4, version = $5,
            updated_by = $6, updated_at = now()
      WHERE id = $1
      RETURNING id, step_id, category_key, variant, body, include_optout, weight, is_active, version, updated_by`,
    [id, nextBody, nextOptout, nextActive, nextVersion, changedBy || 'dashboard'],
  );
  return { status: 'updated', message: upd.rows[0], versioned: bodyChanged };
}

// Message version history (newest first), for revert.
export async function getMessageHistory(pool, id) {
  const r = await pool.query(
    'SELECT id, body, version, changed_by, changed_at FROM drip_message_history WHERE message_id = $1 ORDER BY version DESC',
    [id],
  );
  return r.rows;
}

export async function setSequenceActive(pool, id, isActive) {
  const r = await pool.query(
    'UPDATE drip_sequence SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING id, key, is_active',
    [id, Boolean(isActive)],
  );
  return r.rows[0] ? { status: 'updated', sequence: r.rows[0] } : { status: 'not_found' };
}

// Global runtime pause (kill switch), stored in drip_setting.
export async function isDripPaused(pool) {
  const r = await pool.query("SELECT value FROM drip_setting WHERE key = 'paused'");
  return r.rows[0] ? String(r.rows[0].value) === 'true' : false;
}

export async function setDripPaused(pool, paused, changedBy) {
  await pool.query(
    `INSERT INTO drip_setting (key, value, updated_by, updated_at) VALUES ('paused', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [paused ? 'true' : 'false', changedBy || 'dashboard'],
  );
  return { paused: Boolean(paused) };
}

// Taxonomy: map a raw platform value to a canonical category_key. Upserts on (source, raw_value).
export async function addCategoryMap(pool, { categoryKey, source, rawValue }) {
  const r = await pool.query(
    `INSERT INTO drip_category_map (category_key, source, raw_value) VALUES ($1,$2,$3)
     ON CONFLICT (source, raw_value) DO UPDATE SET category_key = EXCLUDED.category_key
     RETURNING id, category_key, source, raw_value`,
    [categoryKey, source, rawValue],
  );
  return { status: 'saved', row: r.rows[0] };
}

export async function deleteCategoryMap(pool, id) {
  const r = await pool.query('DELETE FROM drip_category_map WHERE id = $1 RETURNING id', [id]);
  return r.rows[0] ? { status: 'deleted', id: r.rows[0].id } : { status: 'not_found' };
}

// Edit a step's timing / active flag. offset_minutes must be >= 0.
export async function updateStep(pool, id, { offsetMinutes, isActive } = {}) {
  const cur = (await pool.query('SELECT id, offset_minutes, is_active FROM drip_step WHERE id = $1', [id])).rows[0];
  if (!cur) return { status: 'not_found' };
  const nextOffset = offsetMinutes != null ? Math.max(0, Math.round(Number(offsetMinutes))) : cur.offset_minutes;
  const nextActive = isActive != null ? Boolean(isActive) : cur.is_active;
  const r = await pool.query(
    'UPDATE drip_step SET offset_minutes = $2, is_active = $3, updated_at = now() WHERE id = $1 RETURNING id, sequence_id, step_index, offset_minutes, is_active',
    [id, nextOffset, nextActive],
  );
  return { status: 'updated', step: r.rows[0] };
}

// Per-step delivery counts (sent) keyed by sequence, for dashboard analytics.
export async function dripStepStats(pool) {
  const r = await pool.query(
    `SELECT s.key AS sequence_key, dl.step, count(*)::int AS sent
       FROM drip_delivery_log dl
       JOIN drip_enrollment e ON e.lead_ref = dl.lead_ref
       JOIN drip_sequence s ON s.id = e.sequence_id
      WHERE dl.status = 'sent'
      GROUP BY s.key, dl.step
      ORDER BY s.key, dl.step`,
  );
  return r.rows;
}
