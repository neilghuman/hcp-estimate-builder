import crypto from 'node:crypto';
import { resolveIdentity } from './engagement_identity.js';

export function fingerprint(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : null;
}

export function engagementConfig() {
  return {
    configured: Boolean(process.env.ENGAGEMENT_API_KEY),
    identityWritesEnabled: String(process.env.ENGAGEMENT_IDENTITY_WRITES_ENABLED || 'false').toLowerCase() === 'true',
    reconciliationEnabled: String(process.env.ENGAGEMENT_RECONCILIATION_ENABLED || 'false').toLowerCase() === 'true',
    defaultPhoneCountry: String(process.env.ENGAGEMENT_DEFAULT_PHONE_COUNTRY || 'US').toUpperCase(),
  };
}

export function summarizeReconciliation(customers, contacts) {
  const counts = { total: 0, auto_confirmed: 0, provisional: 0, identity_review: 0, net_new: 0, malformed_or_no_key: 0, field_conflict: 0 };
  const examples = [];
  for (const customer of customers || []) {
    const result = resolveIdentity({ ...customer, sourceSystem: 'housecall_pro' }, { contacts, defaultCountry: engagementConfig().defaultPhoneCountry });
    counts.total += 1;
    counts[result.outcome] += 1;
    if (result.outcome !== 'auto_confirmed' && examples.length < 20) {
      examples.push({ externalIdHash: fingerprint(customer.id), outcome: result.outcome, reason: result.reason || null, candidateCount: (result.candidateContactIds || []).length, conflicts: result.conflicts || {} });
    }
  }
  return { counts, examples };
}

export function buildHcpReconciliationDecisions(customers, contacts) {
  return (customers || []).map((customer) => buildDryRunDecision({
    sourceSystem: 'housecall_pro',
    sourceEventId: String(customer.id),
    eventType: 'identity.hcp_reconciliation',
    record: customer,
    contacts,
  }));
}

export async function createReconciliationRun(pool, sourceSystem = 'housecall_pro') {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO identity_reconciliation_runs (id, source_system, status) VALUES ($1, $2, $3)', [id, sourceSystem, 'running']);
  return id;
}

export async function finishReconciliationRun(pool, runId, { counts = {}, errorCode = null } = {}) {
  await pool.query(`
    UPDATE identity_reconciliation_runs
    SET status = $2, counts = $3::jsonb, error_code = $4, completed_at = NOW()
    WHERE id = $1
  `, [runId, errorCode ? 'failed' : 'complete', JSON.stringify(counts), errorCode]);
}

export function buildDryRunDecision({ sourceSystem, sourceEventId, eventType = 'identity.dry_run', record, contacts, existingLink }) {
  const source = String(sourceSystem || '').trim().toLowerCase();
  const eventId = String(sourceEventId || '').trim();
  if (!source) throw Object.assign(new Error('sourceSystem is required.'), { status: 422 });
  if (!eventId) throw Object.assign(new Error('sourceEventId is required.'), { status: 422 });
  const result = resolveIdentity({ ...record, sourceSystem: source }, {
    contacts: Array.isArray(contacts) ? contacts : [],
    existingLink,
    defaultCountry: engagementConfig().defaultPhoneCountry,
  });
  return {
    sourceSystem: source,
    sourceEventId: eventId,
    eventType: String(eventType || 'identity.dry_run'),
    normalizedPhoneHash: fingerprint(result.phone),
    normalizedEmailHash: fingerprint(result.email),
    correlationId: crypto.randomUUID(),
    result,
  };
}

export async function recordDryRunDecision(pool, decision) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`
      INSERT INTO integration_events (
        source_system, source_event_id, event_type, terminal_status, normalized_phone_hash,
        normalized_email_hash, target_contact_id, correlation_id, reconciliation_run_id, processed_at
      ) VALUES ($1, $2, $3, 'processed', $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (source_system, source_event_id) DO NOTHING
      RETURNING id
    `, [
      decision.sourceSystem, decision.sourceEventId, decision.eventType,
      decision.normalizedPhoneHash, decision.normalizedEmailHash,
      decision.result.contactId || null, decision.correlationId, decision.reconciliationRunId || null,
    ]);
    if (!inserted.rowCount) {
      const existing = await client.query(`
        SELECT e.id, e.correlation_id, a.outcome, a.link_status, a.match_type, a.decision_reason
        FROM integration_events e
        LEFT JOIN identity_resolution_audits a ON a.integration_event_id = e.id
        WHERE e.source_system = $1 AND e.source_event_id = $2
      `, [decision.sourceSystem, decision.sourceEventId]);
      await client.query('COMMIT');
      return { replayed: true, event: existing.rows[0] };
    }
    const eventId = inserted.rows[0].id;
    await client.query(`
      INSERT INTO identity_resolution_audits (
        integration_event_id, outcome, link_status, candidate_contact_ids, conflict_fields,
        match_type, decision_reason
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
    `, [
      eventId, decision.result.outcome, decision.result.linkStatus || null,
      JSON.stringify(decision.result.candidateContactIds || []), JSON.stringify(decision.result.conflicts || {}),
      decision.result.match || null, decision.result.reason || null,
    ]);
    await client.query('COMMIT');
    return { replayed: false, event: { id: eventId, correlationId: decision.correlationId }, result: decision.result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}