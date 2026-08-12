// Chat Foundry — campaigns + the FIRST send-enabled path (Sprint 5).
//
// SAFETY MODEL (all must hold before any customer message goes out):
//   1. CHAT_FOUNDRY_SEND_ENABLED=true                (env kill-switch, default false)
//   2. a typed confirmation phrase that matches exactly ("SEND N MESSAGE(S)")
//   3. an explicit confirmation checkbox
//   4. eligible count within CHAT_FOUNDRY_MAX_CAMPAIGN_SIZE
//   5. per-recipient eligibility re-check at send time (allowlisted inbox + contact channel)
//   6. idempotency: a conversation that already has a chatwoot_message_id is never re-sent
// Every attempt (including blocked ones) is written to chat_campaign_events.
//
// Sprint 5 only ships a TEST-mode SINGLE send (one message, to verify the relay). The durable
// bulk sender is Sprint 6. Preview and rewrite remain entirely separate, non-sending actions.

import * as chatwoot from './chatwoot.js';
import * as compose from './cf_compose.js';
import { inboxCapability, allowedInboxIds, sendEnabled, maxCampaignSize, buildAudience, maskPhone } from './chatfoundry.js';

// PURE: the exact phrase the operator must type to confirm a send of `n` messages.
export function confirmationPhrase(n) {
  const count = Math.max(0, Number(n) || 0);
  return `SEND ${count} MESSAGE${count === 1 ? '' : 'S'}`;
}

// PURE: validate every send gate. Returns { ok, errors[] }. Never has side effects.
export function sendPreflight({ typedPhrase, expectedPhrase, confirmChecked, eligibleCount, maxSize, enabled } = {}) {
  const errors = [];
  if (!enabled) errors.push('Sending is disabled (set CHAT_FOUNDRY_SEND_ENABLED=true).');
  if (confirmChecked !== true) errors.push('The confirmation checkbox must be checked.');
  if (String(typedPhrase || '').trim() !== String(expectedPhrase || '')) {
    errors.push(`Type the exact confirmation phrase: "${expectedPhrase}".`);
  }
  const n = Number(eligibleCount) || 0;
  if (n < 1) errors.push('There are no eligible recipients to send to.');
  if (n > Number(maxSize || 0)) errors.push(`Recipient count ${n} exceeds the max campaign size (${maxSize}).`);
  return { ok: errors.length === 0, errors };
}

async function logEvent(pool, campaignId, actor, eventType, detail = {}, recipientId = null) {
  try {
    await pool.query(
      `INSERT INTO chat_campaign_events (campaign_id, recipient_id, actor, event_type, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [campaignId, recipientId, actor, eventType, JSON.stringify(detail)],
    );
  } catch { /* audit is best-effort; never block the operation on a log write */ }
}

function rowToCampaign(r) {
  return {
    id: Number(r.id),
    name: r.name,
    template_id: r.template_id != null ? Number(r.template_id) : null,
    body: r.body,
    status: r.status,
    filters: r.filters || {},
    total_recipients: r.total_recipients,
    eligible_count: r.eligible_count,
    sent_count: r.sent_count,
    failed_count: r.failed_count,
    skipped_count: r.skipped_count,
    test_sent_count: r.test_sent_count,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    materialized_at: r.materialized_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
  };
}

export async function listCampaigns(pool) {
  const { rows } = await pool.query('SELECT * FROM chat_campaigns ORDER BY created_at DESC LIMIT 100');
  return rows.map(rowToCampaign);
}

export async function getCampaign(pool, id) {
  const { rows } = await pool.query('SELECT * FROM chat_campaigns WHERE id = $1', [Number(id)]);
  if (!rows.length) return null;
  const campaign = rowToCampaign(rows[0]);
  const { rows: byStatus } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM chat_campaign_recipients WHERE campaign_id = $1 GROUP BY status', [campaign.id]);
  campaign.recipient_counts = byStatus.reduce((a, r) => { a[r.status] = r.n; return a; }, {});
  const { rows: sample } = await pool.query(
    `SELECT id, conversation_id, inbox_id, contact_name, phone, status, eligible, skip_reason, is_test, chatwoot_message_id, sent_at
       FROM chat_campaign_recipients WHERE campaign_id = $1 ORDER BY eligible DESC, id ASC LIMIT 25`, [campaign.id]);
  campaign.sample_recipients = sample.map((r) => ({ ...r, phone_masked: maskPhone(r.phone) }));
  return campaign;
}

export async function createCampaign(pool, { name, body, filters = {}, templateId = null } = {}, actor) {
  const text = String(body || '').trim();
  if (!text) { const e = new Error('Campaign message body is required.'); e.status = 400; throw e; }
  const { rows } = await pool.query(
    `INSERT INTO chat_campaigns (name, template_id, body, filters, created_by, status)
     VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
    [String(name || 'Untitled campaign').slice(0, 200), templateId, text, JSON.stringify(filters || {}), actor],
  );
  const campaign = rowToCampaign(rows[0]);
  await logEvent(pool, campaign.id, actor, 'created', { name: campaign.name, templateId });
  return getCampaign(pool, campaign.id);
}

// Fetch the audience from Chatwoot, render the body per recipient, decide eligibility, and write
// one recipient row per conversation. Idempotent while the campaign has not started sending.
export async function materializeRecipients(pool, id, actor) {
  const campaign = await getCampaign(pool, id);
  if (!campaign) { const e = new Error('Campaign not found.'); e.status = 404; throw e; }
  if (['sending', 'completed', 'canceled'].includes(campaign.status)) {
    const e = new Error(`Cannot re-materialize a ${campaign.status} campaign.`); e.status = 409; throw e;
  }
  if (!chatwoot.chatwootConfigured()) { const e = new Error('Chatwoot is not configured.'); e.status = 503; throw e; }

  const f = campaign.filters || {};
  const status = f.status || 'open';
  const inboxId = f.inboxId ? Number(f.inboxId) : null;
  const tags = Array.isArray(f.tags) ? f.tags : [];
  const contactSearch = String(f.contactSearch || '');
  const excludeNoChannel = f.excludeNoChannel !== false;
  const maxRecipients = Number(f.maxRecipients || 0);

  const MAX_PAGES = Number(process.env.CHAT_FOUNDRY_PREVIEW_MAX_PAGES || 40);
  const normalized = [];
  for (let p = 1; p <= MAX_PAGES; p += 1) {
    const { conversations } = await chatwoot.listConversations({ status, inboxId, page: p });
    if (!conversations.length) break;
    for (const c of conversations) normalized.push(chatwoot.normalizeConversation(c));
    if (conversations.length < 25) break;
  }

  const { rows: audience } = buildAudience(normalized, { tags, contactSearch, excludeNoChannel, maxRecipients });

  // Render + fold in placeholder-block decisions.
  const recipients = audience.map((r) => {
    const rendered = compose.renderForRecipient(campaign.body, r);
    let eligible = r.eligible;
    let skip_reason = r.skip_reason;
    if (eligible && rendered.blocked) { eligible = false; skip_reason = rendered.block_reason; }
    return {
      conversation_id: r.conversation_id,
      inbox_id: r.inbox_id,
      contact_id: r.contact_id,
      contact_name: r.contact_name,
      phone: r.phone || r.contact_identifier || null,
      rendered_body: rendered.text,
      eligible,
      skip_reason: eligible ? null : skip_reason,
      status: eligible ? 'pending' : 'skipped',
    };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chat_campaign_recipients WHERE campaign_id = $1', [campaign.id]);
    for (const r of recipients) {
      await client.query(
        `INSERT INTO chat_campaign_recipients
           (campaign_id, conversation_id, inbox_id, contact_id, contact_name, phone, rendered_body, status, eligible, skip_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (campaign_id, conversation_id) DO NOTHING`,
        [campaign.id, r.conversation_id, r.inbox_id, r.contact_id, r.contact_name, r.phone, r.rendered_body, r.status, r.eligible, r.skip_reason],
      );
    }
    const eligibleCount = recipients.filter((r) => r.eligible).length;
    const skippedCount = recipients.length - eligibleCount;
    await client.query(
      `UPDATE chat_campaigns
         SET total_recipients=$1, eligible_count=$2, skipped_count=$3, status='ready', materialized_at=NOW(), updated_at=NOW()
       WHERE id=$4`,
      [recipients.length, eligibleCount, skippedCount, campaign.id],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logEvent(pool, campaign.id, actor, 'materialized', { total: recipients.length, scanned: normalized.length });
  return getCampaign(pool, campaign.id);
}

// Re-check one recipient right before sending. Returns { ok, reason }.
export function recheckRecipient(recipient) {
  if (!recipient) return { ok: false, reason: 'Recipient not found.' };
  if (recipient.chatwoot_message_id) return { ok: false, reason: 'Already sent (idempotency guard).' };
  if (recipient.status === 'sent') return { ok: false, reason: 'Already sent.' };
  if (recipient.eligible === false) return { ok: false, reason: recipient.skip_reason || 'Recipient is not eligible.' };
  const cap = inboxCapability({ id: recipient.inbox_id });
  if (!cap.outbound_allowed) return { ok: false, reason: cap.skip_reason };
  if (!recipient.phone) return { ok: false, reason: 'Contact has no phone/channel identifier.' };
  return { ok: true, reason: null };
}

// TEST-mode SINGLE send. Fully gated. Sends exactly one message and records its chatwoot_message_id.
export async function testSend(pool, id, { conversationId = null, typedPhrase = '', confirmChecked = false } = {}, actor) {
  const campaign = await getCampaign(pool, id);
  if (!campaign) { const e = new Error('Campaign not found.'); e.status = 404; throw e; }

  // Gate: a test send is always exactly one message.
  const expectedPhrase = confirmationPhrase(1);
  const pre = sendPreflight({
    typedPhrase, expectedPhrase, confirmChecked,
    eligibleCount: 1, maxSize: maxCampaignSize(), enabled: sendEnabled(),
  });
  if (!pre.ok) {
    await logEvent(pool, campaign.id, actor, 'send_blocked', { mode: 'test', errors: pre.errors });
    const e = new Error(pre.errors.join(' ')); e.status = 400; throw e;
  }

  // Claim one pending, eligible, not-yet-sent recipient inside a transaction (row lock).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const where = conversationId
      ? 'campaign_id = $1 AND conversation_id = $2'
      : 'campaign_id = $1 AND status = \'pending\' AND eligible = TRUE AND chatwoot_message_id IS NULL';
    const params = conversationId ? [campaign.id, Number(conversationId)] : [campaign.id];
    const { rows } = await client.query(
      `SELECT * FROM chat_campaign_recipients WHERE ${where} ORDER BY id ASC LIMIT 1 FOR UPDATE`, params);
    const recipient = rows[0];

    const check = recheckRecipient(recipient);
    if (!check.ok) {
      await client.query('ROLLBACK');
      await logEvent(pool, campaign.id, actor, 'send_blocked', { mode: 'test', reason: check.reason, conversationId }, recipient ? Number(recipient.id) : null);
      const e = new Error(check.reason); e.status = recipient ? 422 : 404; throw e;
    }

    // Deliver (network call while holding the row lock — acceptable for a single test message).
    let sent;
    try {
      sent = await chatwoot.sendMessage(recipient.conversation_id, recipient.rendered_body);
    } catch (sendErr) {
      await client.query(
        `UPDATE chat_campaign_recipients SET status='failed', error=$1 WHERE id=$2`,
        [String(sendErr.message).slice(0, 500), recipient.id]);
      await client.query('UPDATE chat_campaigns SET failed_count = failed_count + 1, updated_at=NOW() WHERE id=$1', [campaign.id]);
      await client.query('COMMIT');
      await logEvent(pool, campaign.id, actor, 'error', { mode: 'test', message: sendErr.message }, Number(recipient.id));
      const e = new Error(`Send failed: ${sendErr.message}`); e.status = sendErr.status || 502; throw e;
    }

    await client.query(
      `UPDATE chat_campaign_recipients
         SET status='sent', is_test=TRUE, chatwoot_message_id=$1, sent_at=NOW(), error=NULL
       WHERE id=$2`,
      [sent.id, recipient.id]);
    await client.query(
      `UPDATE chat_campaigns SET test_sent_count = test_sent_count + 1, status='testing', started_at=COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1`,
      [campaign.id]);
    await client.query('COMMIT');

    await logEvent(pool, campaign.id, actor, 'test_send', { conversation_id: recipient.conversation_id, chatwoot_message_id: sent.id }, Number(recipient.id));
    return {
      ok: true,
      recipient: { id: Number(recipient.id), conversation_id: recipient.conversation_id, contact_name: recipient.contact_name, phone_masked: maskPhone(recipient.phone) },
      chatwoot_message_id: sent.id,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* already committed/rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}
