// Lead follow-up drip — runtime service (in-app). DB glue over the drip_* tables; the pure
// decision logic lives in ./drip.js. Sends are NOT performed here — S2 stops at enrollment,
// message resolution, and reporting. The sweep/send path is gated and added in a later sprint.
import {
  resolveMessage, resolveCategoryKey, computeNextDueAt, applyQuietHours,
} from './drip.js';

export function dripConfig() {
  const flag = (v, def) => String(process.env[v] ?? def).toLowerCase();
  return {
    enabled: flag('DRIP_ENABLED', 'true') !== 'false',      // routes visible
    writeEnabled: flag('DRIP_WRITE_ENABLED', 'false') === 'true', // enrollment writes
    sendEnabled: flag('DRIP_SEND_ENABLED', 'false') === 'true',   // real sends (future sprint)
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
        category_raw, category_key, time_zone, step, t0_at, next_due_at, max_messages, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14)
     ON CONFLICT (lead_ref) DO NOTHING
     RETURNING id`,
    [
      seq.id, leadRef, lead.conversationId || null, source || null, vertical || null,
      lead.channel || 'sms', phone, lead.categoryRaw || null, categoryKey,
      lead.timeZone || seq.tz_default, t0Date.toISOString(), nextDue.toISOString(),
      Number(seq.max_messages), expiresAt.toISOString(),
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
  };
}

export async function addSuppression(pool, phone, reason, source) {
  await pool.query(
    'INSERT INTO drip_suppression (phone_e164, reason, source) VALUES ($1,$2,$3) ON CONFLICT (phone_e164) DO NOTHING',
    [phone, reason || null, source || null],
  );
  return { status: 'suppressed', phone };
}
