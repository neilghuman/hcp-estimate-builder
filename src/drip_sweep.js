// Lead follow-up drip — sweep. Pure planners (planStep, planAfterSend) decide what to do; the
// impure sweepOnce applies it. Sends go out only when the injected chatwoot adapter actually
// posts (real adapter is gated by DRIP_SEND_ENABLED at the call site). Everything is re-checked
// immediately before each send.
import { evaluateStop, applyQuietHours, computeNextDueAt, buildIdemKey, resolveMessage, renderBody } from './drip.js';
import {
  getDue, getSequence, getSteps, isPhoneSuppressed, claimStep, markDelivery,
  exitEnrollment, deferEnrollment, applyAfterSend, isDripPaused,
} from './drip_runtime.js';

function quietOpts(enrollment, sequence) {
  return {
    tz: enrollment.time_zone || sequence?.tz_default || 'America/Los_Angeles',
    start: sequence?.quiet_start_local || '08:00',
    end: sequence?.quiet_end_local || '20:00',
  };
}

// Decide the action for one due enrollment. Pure. Order: hard stops -> quiet hours -> send.
export function planStep(enrollment, { conv, suppressed = false, now = new Date(), sequence = {} } = {}) {
  const nowMs = new Date(now).getTime();
  if (suppressed) return { action: 'exit', reason: 'suppressed' };
  if (enrollment.expires_at && nowMs >= new Date(enrollment.expires_at).getTime()) return { action: 'exit', reason: 'expired' };
  if (Number(enrollment.attempts) >= Number(enrollment.max_messages)) return { action: 'exit', reason: 'max_reached' };
  const stop = evaluateStop(conv, { since: enrollment.t0_at });
  if (stop) return { action: 'exit', reason: stop };
  const allowed = applyQuietHours(new Date(now), quietOpts(enrollment, sequence));
  if (allowed.getTime() > nowMs) return { action: 'defer', nextDueAt: allowed.toISOString() };
  return { action: 'send' };
}

// After a successful send, either advance to the next active step or complete. Pure.
export function planAfterSend(enrollment, { steps = [], now = new Date(), sequence = {} } = {}) {
  const nextStep = Number(enrollment.step) + 1;
  const attempts = Number(enrollment.attempts) + 1;
  if (attempts >= Number(enrollment.max_messages)) return { status: 'completed', reason: 'max_reached' };
  const stepRow = steps.find((s) => Number(s.step_index) === nextStep && s.is_active !== false);
  if (!stepRow) return { status: 'completed', reason: 'sequence_end' };
  const due = applyQuietHours(computeNextDueAt(enrollment.t0_at, stepRow.offset_minutes), quietOpts(enrollment, sequence));
  if (enrollment.expires_at && due.getTime() > new Date(enrollment.expires_at).getTime()) {
    return { status: 'completed', reason: 'expired' };
  }
  return { status: 'active', step: nextStep, nextDueAt: due.toISOString() };
}

function renderVars(enrollment) {
  const business = enrollment.vertical === 'tree' ? 'Washington Tree Services'
    : enrollment.vertical === 'landscaping' ? 'Washington Landscaping' : 'our team';
  const service = enrollment.category_key ? String(enrollment.category_key).replace(/_/g, ' ') : 'your project';
  return { name: enrollment.first_name || 'there', service, Business: business };
}

async function resolveMessageFor(pool, enrollment) {
  const seqRes = await pool.query('SELECT variant_strategy FROM drip_sequence WHERE id = $1', [enrollment.sequence_id]);
  const strategy = seqRes.rows[0]?.variant_strategy || 'random';
  const msgRes = await pool.query(
    `SELECT m.id, m.category_key, m.variant, m.body, m.weight, m.is_active
       FROM drip_message m JOIN drip_step st ON st.id = m.step_id
      WHERE st.sequence_id = $1 AND st.step_index = $2`,
    [enrollment.sequence_id, enrollment.step],
  );
  return resolveMessage(msgRes.rows, { categoryKey: enrollment.category_key, strategy });
}

// Process all due enrollments once. chatwoot adapter: { getSnapshot, send, removeLabel }.
// dryRun=true evaluates + reports without any Chatwoot write or DB mutation.
export async function sweepOnce(pool, { chatwoot, now = new Date(), dryRun = false, limit = 50 } = {}) {
  // Global runtime pause is a dashboard kill switch; a real (sending) sweep no-ops while paused.
  if (!dryRun && await isDripPaused(pool)) return [{ action: 'paused' }];
  const due = await getDue(pool, now, limit);
  const results = [];
  for (const e of due) {
    const conv = e.conversation_id && chatwoot ? await chatwoot.getSnapshot(e.conversation_id) : null;
    // Safety: if we can't read the conversation we can't verify stop conditions -> never send.
    if (e.conversation_id && chatwoot && !conv) { results.push({ id: e.id, action: 'skip_no_snapshot' }); continue; }
    const suppressed = await isPhoneSuppressed(pool, e.phone_e164);
    const sequence = await getSequence(pool, e.sequence_id);
    const decision = planStep(e, { conv, suppressed, now, sequence });

    if (decision.action === 'exit') {
      if (!dryRun) {
        await exitEnrollment(pool, e.id, decision.reason);
        if (e.conversation_id && chatwoot) { try { await chatwoot.removeLabel(e.conversation_id); } catch { /* non-fatal */ } }
      }
      results.push({ id: e.id, action: 'exit', reason: decision.reason });
      continue;
    }
    if (decision.action === 'defer') {
      if (!dryRun) await deferEnrollment(pool, e.id, decision.nextDueAt);
      results.push({ id: e.id, action: 'defer', nextDueAt: decision.nextDueAt });
      continue;
    }

    const message = await resolveMessageFor(pool, e);
    if (!message) {
      if (!dryRun) await exitEnrollment(pool, e.id, 'no_message');
      results.push({ id: e.id, action: 'exit', reason: 'no_message' });
      continue;
    }
    const body = renderBody(message.body, renderVars(e));
    if (dryRun) { results.push({ id: e.id, action: 'would_send', step: e.step, body }); continue; }

    const idem = buildIdemKey(e.lead_ref, e.step);
    if (!(await claimStep(pool, e, idem, { messageId: message.id, variant: message.variant }))) { results.push({ id: e.id, action: 'skip_claimed' }); continue; }
    try {
      const sent = await chatwoot.send(e.conversation_id, body, e.step);
      await markDelivery(pool, idem, { status: 'sent', providerMessageId: sent && sent.id });
      const after = planAfterSend(e, { steps: await getSteps(pool, e.sequence_id), now, sequence });
      await applyAfterSend(pool, e.id, after, now);
      results.push({ id: e.id, action: 'sent', step: e.step, after: after.status });
    } catch (err) {
      await markDelivery(pool, idem, { status: 'failed', errorCode: String(err.message).slice(0, 200) });
      // Treat a failed send as a permanent delivery failure so the claimed step can't get stuck
      // re-claiming forever. (Retry-with-backoff is a future enhancement.)
      await exitEnrollment(pool, e.id, 'undeliverable');
      if (e.conversation_id && chatwoot) { try { await chatwoot.removeLabel(e.conversation_id); } catch { /* non-fatal */ } }
      results.push({ id: e.id, action: 'exit', reason: 'undeliverable', error: err.message });
    }
  }
  return results;
}

// Add the pending-callback label to a conversation (idempotent union with existing labels).
export async function ensurePendingLabel(cw, convId, label = 'A_pending_callback') {
  const conv = await cw.getConversation(convId);
  const labels = new Set(conv?.labels || []);
  if (labels.has(label)) return false;
  labels.add(label);
  await cw.setConversationLabels(convId, [...labels]);
  return true;
}

// Real Chatwoot adapter over src/chatwoot.js. Only constructed when sends are enabled.
export function realDripChatwoot(cw) {
  return {
    async getSnapshot(convId) {
      const conv = await cw.getConversation(convId);
      const messages = await cw.getConversationMessages(convId);
      return { status: conv?.status, labels: conv?.labels || [], messages };
    },
    async send(convId, body, step) {
      return cw.postDripMessage(convId, body, { step });
    },
    async removeLabel(convId) {
      const conv = await cw.getConversation(convId);
      const labels = (conv?.labels || []).filter((l) => l !== 'A_pending_callback');
      return cw.setConversationLabels(convId, labels);
    },
  };
}

// Background sweep loop. Started only when DRIP_SWEEP_ENABLED (server.js gates this).
export function startDripSweep(pool, cw, { intervalMs = 60000 } = {}) {
  const chatwoot = realDripChatwoot(cw);
  const tick = async () => {
    try { await sweepOnce(pool, { chatwoot, dryRun: false }); }
    catch (e) { console.warn('drip sweep error:', e.message); }
  };
  return setInterval(tick, intervalMs);
}

