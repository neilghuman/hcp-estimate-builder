// Customer Engagement Platform - incremental HCP -> EspoCRM live sync.
//
// Pure selection core + thin DB helpers for a scheduled catch-up of NEW/CHANGED
// Housecall Pro customers. Clean `net_new` customers become EspoCRM Contacts;
// `provisional` / ambiguous / `field_conflict` customers are queued to IdentityReview.
// It NEVER auto-merges. All writes reuse the existing gated canary projection helpers,
// so this module inherits every identity guardrail already in place.
//
// Cursor model: the state row holds the Housecall Pro `updated_at` high-water mark that
// has been fully processed. The first run only initializes the cursor (imports nothing) so
// enabling the poller cannot mass-create the entire back catalogue; existing customers are
// backfilled deliberately via the bounded /imports/hcp/batch endpoint under owner control.

import crypto from 'node:crypto';
import { resolveIdentity } from './engagement_identity.js';
import { buildHcpCanaryProjection, engagementConfig } from './engagement_runtime.js';

const REVIEWABLE_OUTCOMES = new Set(['provisional', 'identity_review', 'field_conflict']);

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

// Effective change time for a reconciliation-shaped HCP customer.
export function effectiveTimestamp(customer) {
  return customer?.updatedAt || customer?.createdAt || null;
}

// Lexicographic max over ISO-8601 UTC timestamps (same format sorts correctly as strings).
export function highWater(timestamps) {
  let max = null;
  for (const ts of timestamps || []) {
    if (ts && (max === null || ts > max)) max = ts;
  }
  return max;
}

// Decide, purely, what a single sweep tick should do. Returns the net_new customers to
// import, the reviewable customers to queue, and the next high-water cursor. A combined
// write budget (`batchLimit`) keeps the cursor monotonic: it only advances past customers
// the tick fully handled, so nothing is ever skipped when a tick is capped.
export function selectLiveSyncWork(customers, contacts, {
  cursor = null,
  batchLimit = 25,
  existingLinkSourceIds = new Set(),
  existingReviewSourceIds = new Set(),
  now = new Date(),
} = {}) {
  const cappedLimit = Math.min(Math.max(Number(batchLimit) || 25, 1), 50);
  const rows = (customers || [])
    .map((customer) => ({ customer, ts: effectiveTimestamp(customer) }))
    .filter((row) => row.ts);

  // First run: initialize the high-water cursor and import nothing.
  if (!cursor) {
    const nextCursor = highWater(rows.map((row) => row.ts)) || new Date(now).toISOString();
    return { firstRun: true, nextCursor, imports: [], reviews: [], skipped: {}, examined: 0, remaining: 0 };
  }

  const changed = rows
    .filter((row) => row.ts >= cursor)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const imports = [];
  const reviews = [];
  const skipped = {};
  const candidatePool = Array.isArray(contacts) ? contacts.slice() : [];
  let nextCursor = cursor;
  let examined = 0;

  for (const { customer, ts } of changed) {
    // Budget spent: stop before touching this customer so the cursor stays behind it.
    if (imports.length + reviews.length >= cappedLimit) break;
    const sourceId = String(customer.id);
    const result = resolveIdentity({ ...customer, sourceSystem: 'housecall_pro' }, {
      contacts: candidatePool,
      defaultCountry: engagementConfig().defaultPhoneCountry,
    });
    examined += 1;

    if (result.outcome === 'net_new') {
      if (existingLinkSourceIds.has(sourceId)) { bump(skipped, 'existing_external_link'); nextCursor = ts; continue; }
      try {
        const projection = buildHcpCanaryProjection(customer);
        imports.push({ customer, projection });
        // Seed the running candidate set so a same-tick duplicate resolves as a match, not a second create.
        candidatePool.push({ id: `pending:${sourceId}`, firstName: projection.contact.firstName, lastName: projection.contact.lastName, phoneNumber: projection.contact.phoneNumber, emailAddress: projection.contact.emailAddress });
        nextCursor = ts;
      } catch (error) {
        bump(skipped, error.status === 422 ? 'malformed_or_no_key' : 'invalid_candidate');
        nextCursor = ts;
      }
      continue;
    }

    if (REVIEWABLE_OUTCOMES.has(result.outcome)) {
      if (existingReviewSourceIds.has(sourceId)) { bump(skipped, 'existing_open_review'); nextCursor = ts; continue; }
      reviews.push({ customer, result });
      nextCursor = ts;
      continue;
    }

    // auto_confirmed / malformed_or_no_key -> nothing to write, safe to advance.
    bump(skipped, result.outcome);
    nextCursor = ts;
  }

  return { firstRun: false, nextCursor, imports, reviews, skipped, examined, remaining: changed.length - examined };
}

// --- state + audit persistence ----------------------------------------------

export async function getLiveSyncState(pool) {
  const result = await pool.query('SELECT cursor_updated_at, initialized_at, last_run_at FROM hcp_live_sync_state WHERE id = TRUE');
  const row = result.rows[0];
  return {
    cursor: row?.cursor_updated_at || null,
    initializedAt: row?.initialized_at || null,
    lastRunAt: row?.last_run_at || null,
  };
}

export async function saveLiveSyncCursor(pool, cursor, { initialized = false } = {}) {
  await pool.query(`
    INSERT INTO hcp_live_sync_state (id, cursor_updated_at, initialized_at, last_run_at, updated_at)
    VALUES (TRUE, $1, CASE WHEN $2 THEN NOW() ELSE NULL END, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      cursor_updated_at = EXCLUDED.cursor_updated_at,
      initialized_at = COALESCE(hcp_live_sync_state.initialized_at, EXCLUDED.initialized_at),
      last_run_at = NOW(),
      updated_at = NOW()
  `, [cursor, initialized]);
}

export async function createLiveSyncRun(pool, { firstRun = false, cursorBefore = null } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO hcp_live_sync_runs (id, status, first_run, cursor_before) VALUES ($1, $2, $3, $4)',
    [id, 'running', Boolean(firstRun), cursorBefore],
  );
  return id;
}

export async function completeLiveSyncRun(pool, runId, { cursorAfter = null, examined = 0, created = 0, queued = 0, failed = 0, skipped = {} } = {}) {
  await pool.query(`
    UPDATE hcp_live_sync_runs
    SET status = 'complete', cursor_after = $2, examined_count = $3, created_count = $4,
        queued_count = $5, failed_count = $6, skipped_counts = $7::jsonb, completed_at = NOW()
    WHERE id = $1
  `, [runId, cursorAfter, examined, created, queued, failed, JSON.stringify(skipped || {})]);
}

export async function failLiveSyncRun(pool, runId, errorCode = 'live_sync_failed') {
  await pool.query(
    "UPDATE hcp_live_sync_runs SET status = 'failed', error_code = $2, completed_at = NOW() WHERE id = $1",
    [runId, errorCode],
  );
}
