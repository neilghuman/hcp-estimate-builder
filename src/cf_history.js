// Chat Foundry — campaign history, recipient drill-down, and CSV export (Sprint 7). Read-only.
//
// These endpoints never send anything. They let an operator inspect what a campaign did: browse
// past campaigns, page/filter the full recipient list, read the append-only audit log, and export
// recipients as CSV for reconciliation.

import { maskPhone } from './chatfoundry.js';

const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

// PURE: escape a single CSV cell (RFC 4180 — wrap in quotes and double any embedded quotes).
export function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// PURE: render recipient rows to a CSV document (with a header row).
export function recipientsToCsv(rows = []) {
  const cols = ['conversation_id', 'contact_name', 'phone', 'inbox_id', 'status', 'eligible', 'skip_reason', 'is_test', 'chatwoot_message_id', 'sent_at', 'error'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvCell(r[c])).join(','));
  }
  return lines.join('\r\n');
}

// Paged, optionally status-filtered recipient list for the drill-down table (phone masked).
export async function listRecipients(pool, id, { status = '', page = 1, perPage = 50 } = {}) {
  const campaignId = Number(id);
  const p = Math.max(1, Number(page) || 1);
  const per = Math.min(200, Math.max(1, Number(perPage) || 50));
  const where = ['campaign_id = $1'];
  const params = [campaignId];
  if (RECIPIENT_STATUSES.includes(String(status))) { params.push(status); where.push(`status = $${params.length}`); }
  const whereSql = where.join(' AND ');

  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM chat_campaign_recipients WHERE ${whereSql}`, params);
  const total = cnt[0].n;
  const { rows } = await pool.query(
    `SELECT id, conversation_id, inbox_id, contact_name, phone, status, eligible, skip_reason, is_test, chatwoot_message_id, sent_at, error
       FROM chat_campaign_recipients WHERE ${whereSql}
      ORDER BY id ASC LIMIT ${per} OFFSET ${(p - 1) * per}`, params);
  return {
    total, page: p, perPage: per,
    rows: rows.map((r) => ({ ...r, phone_masked: maskPhone(r.phone) })),
  };
}

// All recipients (optionally status-filtered) with REAL phone numbers, for CSV export.
export async function recipientsForExport(pool, id, { status = '' } = {}) {
  const campaignId = Number(id);
  const where = ['campaign_id = $1'];
  const params = [campaignId];
  if (RECIPIENT_STATUSES.includes(String(status))) { params.push(status); where.push(`status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT conversation_id, contact_name, phone, inbox_id, status, eligible, skip_reason, is_test, chatwoot_message_id, sent_at, error
       FROM chat_campaign_recipients WHERE ${where.join(' AND ')} ORDER BY id ASC`, params);
  return rows;
}

// Append-only audit trail for a campaign (most recent first).
export async function listEvents(pool, id, { limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, recipient_id, actor, event_type, detail, created_at
       FROM chat_campaign_events WHERE campaign_id = $1 ORDER BY id DESC LIMIT $2`,
    [Number(id), Math.min(500, Math.max(1, Number(limit) || 200))]);
  return rows;
}
