// Chat Foundry — durable bulk sender (Sprint 6).
//
// A DB-backed queue over chat_campaign_recipients.status:
//   pending → sending → sent | failed | skipped
// Recipients are claimed atomically with `FOR UPDATE SKIP LOCKED`, sent one at a time with rate
// limiting and retry/backoff, and stamped with chatwoot_message_id on success (idempotency — a row
// that already has a message id is never re-sent). Pause / resume / cancel are honored between
// messages. On restart, any recipient left mid-flight is quarantined (never auto-resent) so a
// customer can never be double-texted after a crash.
//
// SAFETY: starting/resuming a bulk send re-checks the full gate (CHAT_FOUNDRY_SEND_ENABLED, typed
// confirmation phrase "SEND N MESSAGES", checkbox, max size) and every recipient is re-checked for
// eligibility immediately before its message goes out.

import * as chatwoot from './chatwoot.js';
import { sendEnabled, maxCampaignSize } from './chatfoundry.js';
import { confirmationPhrase, sendPreflight, recheckRecipient } from './cf_campaigns.js';

// In-process control registry: campaignId -> { paused, canceled }. A campaign may have at most one
// active runner at a time (single-instance app; the DB status is the source of truth on restart).
const controls = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// PURE: sender tuning from env (conservative defaults).
export function sendConfig() {
  return {
    batchSize: Math.max(1, Number(process.env.CHAT_FOUNDRY_BATCH_SIZE || 25)),
    perMinute: Math.max(1, Number(process.env.CHAT_FOUNDRY_MESSAGES_PER_MINUTE || 30)),
    maxRetries: Math.max(1, Number(process.env.CHAT_FOUNDRY_MAX_RETRIES || 3)),
    retryDelayMs: Math.max(0, Number(process.env.CHAT_FOUNDRY_RETRY_DELAY || 5000)),
  };
}

// PURE: milliseconds to wait between messages to honor the per-minute rate limit.
export function perMessageDelayMs(perMinute) {
  const n = Math.max(1, Number(perMinute) || 1);
  return Math.floor(60000 / n);
}

// PURE: roll recipient status counts into a progress snapshot.
export function computeProgress(counts = {}, campaignStatus = 'unknown') {
  const sent = counts.sent || 0;
  const failed = counts.failed || 0;
  const skipped = counts.skipped || 0;
  const pending = counts.pending || 0;
  const sending = counts.sending || 0;
  const total = sent + failed + skipped + pending + sending;
  const done = sent + failed + skipped;
  return {
    status: campaignStatus,
    total,
    sent, failed, skipped, pending, sending,
    processed: done,
    remaining: pending + sending,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}

export function isRunning(campaignId) {
  return controls.has(Number(campaignId));
}

async function logEvent(pool, campaignId, actor, eventType, detail = {}, recipientId = null) {
  try {
    await pool.query(
      `INSERT INTO chat_campaign_events (campaign_id, recipient_id, actor, event_type, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [campaignId, recipientId, actor, eventType, JSON.stringify(detail)],
    );
  } catch { /* best-effort audit */ }
}

async function countEligiblePending(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_campaign_recipients
     WHERE campaign_id=$1 AND status='pending' AND eligible=TRUE AND chatwoot_message_id IS NULL`,
    [campaignId]);
  return rows[0].n;
}

// Claim up to `limit` pending recipients for this campaign (atomic, skips locked rows).
async function claimBatch(pool, campaignId, limit) {
  const { rows } = await pool.query(
    `UPDATE chat_campaign_recipients r SET status='sending'
       FROM (
         SELECT id FROM chat_campaign_recipients
         WHERE campaign_id=$1 AND status='pending' AND eligible=TRUE AND chatwoot_message_id IS NULL
         ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
       ) sub
      WHERE r.id = sub.id
      RETURNING r.*`,
    [campaignId, limit]);
  return rows;
}

// Return claimed-but-unsent rows to the queue (used on pause/cancel). Safe: they have no message id.
async function requeue(pool, ids) {
  if (!ids.length) return;
  await pool.query(
    `UPDATE chat_campaign_recipients SET status='pending'
     WHERE id = ANY($1::bigint[]) AND status='sending' AND chatwoot_message_id IS NULL`,
    [ids]);
}

async function deliverWithRetry(recipient, cfg) {
  let lastErr;
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt += 1) {
    try {
      return await chatwoot.sendMessage(recipient.conversation_id, recipient.rendered_body);
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.maxRetries) await sleep(cfg.retryDelayMs * attempt); // linear backoff
    }
  }
  throw lastErr;
}

// The runner loop. Fire-and-forget; updates the DB as the single source of truth.
async function runCampaign(pool, campaignId, actor) {
  const cfg = sendConfig();
  const perMsg = perMessageDelayMs(cfg.perMinute);
  const control = controls.get(campaignId);
  try {
    while (true) {
      if (control.canceled) { await finish(pool, campaignId, 'canceled', actor); return; }
      if (control.paused) { await finish(pool, campaignId, 'paused', actor); return; }

      const batch = await claimBatch(pool, campaignId, cfg.batchSize);
      if (!batch.length) { await finish(pool, campaignId, 'completed', actor); return; }

      for (let i = 0; i < batch.length; i += 1) {
        if (control.canceled || control.paused) {
          await requeue(pool, batch.slice(i).map((r) => r.id));
          await finish(pool, campaignId, control.canceled ? 'canceled' : 'paused', actor);
          return;
        }
        const r = batch[i];
        const check = recheckRecipient(r);
        if (!check.ok) {
          await pool.query(`UPDATE chat_campaign_recipients SET status='skipped', skip_reason=$1 WHERE id=$2`, [check.reason, r.id]);
          await pool.query(`UPDATE chat_campaigns SET skipped_count = skipped_count + 1, updated_at=NOW() WHERE id=$1`, [campaignId]);
          continue;
        }
        try {
          const sent = await deliverWithRetry(r, cfg);
          await pool.query(
            `UPDATE chat_campaign_recipients SET status='sent', chatwoot_message_id=$1, sent_at=NOW(), error=NULL WHERE id=$2`,
            [sent.id, r.id]);
          await pool.query(`UPDATE chat_campaigns SET sent_count = sent_count + 1, updated_at=NOW() WHERE id=$1`, [campaignId]);
        } catch (e) {
          await pool.query(`UPDATE chat_campaign_recipients SET status='failed', error=$1 WHERE id=$2`, [String(e.message).slice(0, 500), r.id]);
          await pool.query(`UPDATE chat_campaigns SET failed_count = failed_count + 1, updated_at=NOW() WHERE id=$1`, [campaignId]);
          await logEvent(pool, campaignId, actor, 'error', { recipient: r.id, message: e.message }, r.id);
        }
        if (i < batch.length - 1) await sleep(perMsg); // rate limit between messages
      }
      await sleep(perMsg);
    }
  } catch (e) {
    await logEvent(pool, campaignId, actor, 'runner_error', { message: e.message });
    await pool.query(`UPDATE chat_campaigns SET status='paused', updated_at=NOW() WHERE id=$1`, [campaignId]).catch(() => {});
  } finally {
    controls.delete(campaignId);
  }
}

async function finish(pool, campaignId, status, actor) {
  const completed = status === 'completed' || status === 'canceled';
  await pool.query(
    `UPDATE chat_campaigns SET status=$1, updated_at=NOW(), completed_at=${completed ? 'NOW()' : 'completed_at'} WHERE id=$2`,
    [status, campaignId]);
  await logEvent(pool, campaignId, actor, status === 'completed' ? 'completed' : status, {});
}

// Start (or resume) a bulk send. Enforces the full gate before launching the runner.
export async function startCampaign(pool, campaignId, { typedPhrase = '', confirmChecked = false, resume = false } = {}, actor) {
  const id = Number(campaignId);
  if (controls.has(id)) { const e = new Error('This campaign is already sending.'); e.status = 409; throw e; }

  const { rows } = await pool.query('SELECT * FROM chat_campaigns WHERE id=$1', [id]);
  const campaign = rows[0];
  if (!campaign) { const e = new Error('Campaign not found.'); e.status = 404; throw e; }
  if (['completed', 'canceled', 'sending'].includes(campaign.status) && !resume) {
    const e = new Error(`Cannot start a ${campaign.status} campaign.`); e.status = 409; throw e;
  }

  const eligible = await countEligiblePending(pool, id);
  const expectedPhrase = confirmationPhrase(eligible);
  const pre = sendPreflight({ typedPhrase, expectedPhrase, confirmChecked, eligibleCount: eligible, maxSize: maxCampaignSize(), enabled: sendEnabled() });
  if (!pre.ok) {
    await logEvent(pool, id, actor, 'send_blocked', { mode: resume ? 'resume' : 'send', errors: pre.errors });
    const e = new Error(pre.errors.join(' ')); e.status = 400; throw e;
  }

  controls.set(id, { paused: false, canceled: false });
  await pool.query(`UPDATE chat_campaigns SET status='sending', started_at=COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1`, [id]);
  await logEvent(pool, id, actor, resume ? 'resumed' : 'send_started', { eligible });

  // Fire and forget — the DB is the source of truth; the HTTP request returns immediately.
  runCampaign(pool, id, actor).catch(() => {});
  return { started: true, eligible, confirmPhrase: expectedPhrase };
}

export async function pauseCampaign(pool, campaignId, actor) {
  const id = Number(campaignId);
  const control = controls.get(id);
  if (control) { control.paused = true; await logEvent(pool, id, actor, 'pause_requested', {}); return { paused: true }; }
  // No active runner (e.g. after a restart) — persist the paused state directly.
  const { rowCount } = await pool.query(`UPDATE chat_campaigns SET status='paused', updated_at=NOW() WHERE id=$1 AND status='sending'`, [id]);
  await logEvent(pool, id, actor, 'pause_requested', { noRunner: true });
  return { paused: rowCount > 0 };
}

export async function cancelCampaign(pool, campaignId, actor) {
  const id = Number(campaignId);
  const control = controls.get(id);
  if (control) { control.canceled = true; await logEvent(pool, id, actor, 'cancel_requested', {}); return { canceling: true }; }
  await pool.query(`UPDATE chat_campaigns SET status='canceled', completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND status IN ('paused','ready','sending')`, [id]);
  await logEvent(pool, id, actor, 'canceled', { noRunner: true });
  return { canceled: true };
}

export async function progress(pool, campaignId) {
  const id = Number(campaignId);
  const { rows: cr } = await pool.query('SELECT status FROM chat_campaigns WHERE id=$1', [id]);
  if (!cr.length) { const e = new Error('Campaign not found.'); e.status = 404; throw e; }
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM chat_campaign_recipients WHERE campaign_id=$1 GROUP BY status`, [id]);
  const counts = rows.reduce((a, r) => { a[r.status] = r.n; return a; }, {});
  const snap = computeProgress(counts, cr[0].status);
  snap.active = isRunning(id);
  return snap;
}

// Restart recovery: quarantine any recipient left mid-send so it is NEVER auto-resent (a customer
// must never be double-texted after a crash), and move interrupted campaigns to 'paused'.
export async function recoverInterrupted(pool) {
  try {
    const q = await pool.query(
      `UPDATE chat_campaign_recipients
         SET status='failed', error='Interrupted mid-send during a restart — verify in Chatwoot before resending.'
       WHERE status='sending'`);
    const c = await pool.query(
      `UPDATE chat_campaigns SET status='paused', updated_at=NOW() WHERE status='sending' RETURNING id`);
    if (q.rowCount || c.rowCount) {
      for (const row of c.rows) await logEvent(pool, row.id, 'system', 'recovered', { quarantined_recipients: q.rowCount });
    }
    return { quarantined: q.rowCount, pausedCampaigns: c.rowCount };
  } catch {
    return { quarantined: 0, pausedCampaigns: 0 };
  }
}
