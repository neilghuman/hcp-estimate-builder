import crypto from 'node:crypto';
import { normalizeEmail, normalizePhone, resolveIdentity } from './engagement_identity.js';
import { resolveBrand } from './brands.js';

export function fingerprint(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : null;
}

export function engagementConfig() {
  return {
    configured: Boolean(process.env.ENGAGEMENT_API_KEY),
    identityWritesEnabled: String(process.env.ENGAGEMENT_IDENTITY_WRITES_ENABLED || 'false').toLowerCase() === 'true',
    reconciliationEnabled: String(process.env.ENGAGEMENT_RECONCILIATION_ENABLED || 'false').toLowerCase() === 'true',
    chatwootWebhookEnabled: String(process.env.ENGAGEMENT_CHATWOOT_WEBHOOK_ENABLED || 'false').toLowerCase() === 'true',
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

export function deriveBrandRelationships(tags) {
  const brands = [];
  for (const tag of tags || []) {
    const brand = resolveBrand(tag);
    if (brand && !brands.includes(brand.key)) brands.push(brand.key);
  }
  // HCP appends tags, so the last recognized brand tag is the most recent context.
  return { brandRelationships: brands, primaryBrand: brands.length ? brands[brands.length - 1] : null };
}

export function buildHcpCanaryProjection(customer) {
  const firstName = String(customer?.firstName || '').trim();
  const lastName = String(customer?.lastName || '').trim();
  const phone = (customer?.phones || []).map((value) => normalizePhone(value, { defaultCountry: engagementConfig().defaultPhoneCountry })).find(Boolean) || null;
  const email = normalizeEmail(customer?.email);
  const externalId = String(customer?.id || '').trim();
  const sourceAccountId = String(process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID || '').trim();
  if (!externalId) throw Object.assign(new Error('HCP customer ID is required.'), { status: 422 });
  if (!sourceAccountId) throw Object.assign(new Error('ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID is not configured.'), { status: 503 });
  if (!firstName && !lastName) throw Object.assign(new Error('A customer name is required for the Contact canary.'), { status: 422 });
  if (!phone && !email) throw Object.assign(new Error('A valid HCP phone number or email is required for the Contact canary.'), { status: 422 });
  const { brandRelationships, primaryBrand } = deriveBrandRelationships(customer?.tags);
  return {
    contact: {
      firstName: firstName || 'Unknown',
      lastName: lastName || 'Customer',
      phoneNumber: phone,
      emailAddress: email,
      ...(brandRelationships.length ? { brandRelationships } : {}),
      ...(primaryBrand ? { primaryBrand } : {}),
    },
    link: {
      name: `HousecallPro:${externalId}`,
      sourceSystem: 'HousecallPro',
      sourceAccountId,
      externalId,
      linkStatus: 'Provisional',
      matchingEvidence: { source: 'hcp-canary', phonePresent: Boolean(phone), emailPresent: Boolean(email) },
    },
  };
}

export function selectHcpCanaryCandidates(customers, contacts, { limit = 10, maxLimit = 10 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || maxLimit, 1), maxLimit);
  const selected = [];
  const skipped = {};
  const candidates = Array.isArray(contacts) ? contacts.slice() : [];
  for (const customer of customers || []) {
    if (selected.length >= cappedLimit) break;
    const result = resolveIdentity({ ...customer, sourceSystem: 'housecall_pro' }, {
      contacts: candidates,
      defaultCountry: engagementConfig().defaultPhoneCountry,
    });
    if (result.outcome !== 'net_new') {
      skipped[result.outcome] = (skipped[result.outcome] || 0) + 1;
      continue;
    }
    try {
      const projection = buildHcpCanaryProjection(customer);
      selected.push({ customer, projection });
      // Later source records in this batch must see this identity and cannot create a duplicate.
      candidates.push({ id: `pending:${customer.id}`, firstName: projection.contact.firstName, lastName: projection.contact.lastName, phoneNumber: projection.contact.phoneNumber, emailAddress: projection.contact.emailAddress });
    } catch (error) {
      const key = error.status === 422 ? 'malformed_or_no_key' : 'invalid_candidate';
      skipped[key] = (skipped[key] || 0) + 1;
    }
  }
  return { selected, skipped, limit: cappedLimit };
}

function normalizeAddressPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeHcpAddress(address) {
  if (!address || !address.street || !address.city || !address.state || !address.zip) return null;
  return {
    id: String(address.id || ''),
    type: String(address.type || '').toLowerCase(),
    street: String(address.street).trim(),
    city: String(address.city).trim(),
    state: String(address.state).trim(),
    postalCode: String(address.zip).trim(),
    country: String(address.country || 'US').trim(),
  };
}

export function selectPrimaryHcpAddress(addresses) {
  const complete = (addresses || []).map(normalizeHcpAddress).filter(Boolean);
  const services = complete.filter((address) => address.type === 'service');
  const billings = complete.filter((address) => address.type === 'billing');
  if (billings.length === 1) return { status: 'selected_billing_fallback', address: billings[0] };
  if (billings.length > 1) return { status: 'ambiguous_multiple_billing_addresses', address: null };
  if (services.length === 1) return { status: 'selected_service_fallback', address: services[0] };
  if (services.length > 1 || complete.length > 1) return { status: 'ambiguous_multiple_service_addresses', address: null };
  return { status: 'no_complete_address', address: null };
}

export function compareContactAddress(contact, hcpAddress) {
  if (!hcpAddress) return { status: 'no_candidate' };
  const crm = {
    street: String(contact?.addressStreet || '').trim(),
    city: String(contact?.addressCity || '').trim(),
    state: String(contact?.addressState || '').trim(),
    postalCode: String(contact?.addressPostalCode || '').trim(),
    country: String(contact?.addressCountry || '').trim(),
  };
  const crmBlank = Object.values(crm).every((value) => !value);
  if (crmBlank) return { status: 'crm_blank', candidate: hcpAddress };
  const matches = normalizeAddressPart(crm.street) === normalizeAddressPart(hcpAddress.street)
    && normalizeAddressPart(crm.city) === normalizeAddressPart(hcpAddress.city)
    && normalizeAddressPart(crm.state) === normalizeAddressPart(hcpAddress.state)
    && normalizeAddressPart(crm.postalCode) === normalizeAddressPart(hcpAddress.postalCode);
  return { status: matches ? 'match' : 'conflict', candidate: hcpAddress };
}

export function summarizeAddressAudit(rows) {
  const counts = { total: 0, crm_blank: 0, match: 0, conflict: 0, no_complete_address: 0, ambiguous_multiple_billing_addresses: 0, ambiguous_multiple_service_addresses: 0 };
  const examples = [];
  for (const row of rows || []) {
    counts.total += 1;
    const selection = selectPrimaryHcpAddress(row.addresses);
    const outcome = selection.address ? compareContactAddress(row.contact, selection.address).status : selection.status;
    counts[outcome] = (counts[outcome] || 0) + 1;
    examples.push({ contactId: row.contactId, linkId: row.linkId, outcome, addressType: selection.address?.type || null, hcpAddressIdHash: selection.address?.id ? fingerprint(selection.address.id) : null });
  }
  return { counts, examples };
}

export function selectAddressWriteCanary(rows, { limit = 10, maxLimit = 10 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || maxLimit, 1), maxLimit);
  const selected = [];
  const skipped = {};
  for (const row of rows || []) {
    if (selected.length >= cappedLimit) break;
    const selection = selectPrimaryHcpAddress(row.addresses);
    const comparison = selection.address ? compareContactAddress(row.contact, selection.address) : { status: selection.status };
    if (comparison.status !== 'crm_blank') {
      skipped[comparison.status] = (skipped[comparison.status] || 0) + 1;
      continue;
    }
    selected.push({ ...row, address: selection.address });
  }
  return { selected, skipped, limit: cappedLimit };
}

export function isContactAddressBlank(contact) {
  return !(contact?.addressStreet || contact?.addressCity || contact?.addressState || contact?.addressPostalCode || contact?.addressCountry);
}

export function selectAddressBackfillCandidates(links, contactsById, { limit = 100, maxLimit = 200 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || maxLimit, 1), maxLimit);
  const selected = [];
  const skipped = {};
  const lookup = contactsById instanceof Map ? contactsById : new Map(Object.entries(contactsById || {}));
  for (const link of links || []) {
    if (selected.length >= cap) break;
    const contact = lookup.get(String(link.contactId));
    if (!contact) { skipped.contact_missing = (skipped.contact_missing || 0) + 1; continue; }
    if (!isContactAddressBlank(contact)) { skipped.has_address = (skipped.has_address || 0) + 1; continue; }
    selected.push({ contactId: String(link.contactId), linkId: String(link.id), externalId: String(link.externalId) });
  }
  return { selected, skipped, limit: cap };
}

export function selectBrandBackfillCandidates(links, customersByExternalId, contactsById, { limit = 200, maxLimit = 400 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || maxLimit, 1), maxLimit);
  const customers = customersByExternalId instanceof Map ? customersByExternalId : new Map(Object.entries(customersByExternalId || {}));
  const contacts = contactsById instanceof Map ? contactsById : new Map(Object.entries(contactsById || {}));
  const selected = [];
  const skipped = {};
  for (const link of links || []) {
    if (selected.length >= cap) break;
    const customer = customers.get(String(link.externalId));
    if (!customer) { skipped.customer_missing = (skipped.customer_missing || 0) + 1; continue; }
    const { brandRelationships, primaryBrand } = deriveBrandRelationships(customer.tags);
    if (!brandRelationships.length) { skipped.no_brand_tags = (skipped.no_brand_tags || 0) + 1; continue; }
    const contact = contacts.get(String(link.contactId));
    const current = Array.isArray(contact?.brandRelationships) ? contact.brandRelationships : [];
    const missing = brandRelationships.filter((brand) => !current.includes(brand));
    const needsPrimary = Boolean(primaryBrand) && !contact?.primaryBrand;
    if (!missing.length && !needsPrimary) { skipped.already_current = (skipped.already_current || 0) + 1; continue; }
    // Union only; a sync never removes an existing brand relationship.
    const union = Array.from(new Set([...current, ...brandRelationships]));
    selected.push({ contactId: String(link.contactId), linkId: String(link.id), brandRelationships: union, primaryBrand: contact?.primaryBrand || primaryBrand });
  }
  return { selected, skipped, limit: cap };
}

export async function recordAddressProjection(pool, { contactId, linkId, addressId }) {
  const sourceEventId = `address-canary:${linkId}:${fingerprint(addressId)}`;
  await pool.query(`
    INSERT INTO integration_events (
      source_system, source_event_id, event_type, terminal_status, target_contact_id, correlation_id, processed_at
    ) VALUES ($1, $2, $3, 'processed', $4, $5, NOW())
    ON CONFLICT (source_system, source_event_id) DO NOTHING
  `, ['housecall_pro', sourceEventId, 'identity.address_canary', contactId, crypto.randomUUID()]);
}

export function selectIdentityReviewCandidates(customers, contacts, { limit = 10, existingSourceIds = new Set() } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const reviewable = new Set(['provisional', 'identity_review', 'field_conflict']);
  const selected = [];
  const skipped = {};
  for (const customer of customers || []) {
    if (existingSourceIds.has(String(customer.id))) {
      skipped.existing_open_review = (skipped.existing_open_review || 0) + 1;
      continue;
    }
    if (selected.length >= cappedLimit) break;
    const result = resolveIdentity({ ...customer, sourceSystem: 'housecall_pro' }, {
      contacts,
      defaultCountry: engagementConfig().defaultPhoneCountry,
    });
    if (!reviewable.has(result.outcome)) {
      skipped[result.outcome] = (skipped[result.outcome] || 0) + 1;
      continue;
    }
    selected.push({ customer, result });
  }
  return { selected, skipped, limit: cappedLimit };
}

export function buildIdentityReview(customer, result) {
  const sourceAccountId = String(process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID || '').trim();
  if (!sourceAccountId) throw Object.assign(new Error('ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID is not configured.'), { status: 503 });
  return {
    name: `HCP identity review: ${fingerprint(customer.id).slice(0, 12)}`,
    sourceSystem: 'HousecallPro',
    sourceAccountId,
    externalId: String(customer.id),
    hcpCustomerId: String(customer.id),
    reviewStatus: 'Open',
    candidateContactId: result.contactId || null,
    conflictSummary: result.outcome,
    matchingEvidence: {
      outcome: result.outcome,
      reason: result.reason || null,
      candidateContactIds: result.candidateContactIds || [],
      conflicts: result.conflicts || {},
    },
  };
}

export function selectHcpImportCandidates(customers, contacts, { limit = 25, existingSourceIds = new Set() } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const selected = [];
  const skipped = {};
  const candidates = Array.isArray(contacts) ? contacts.slice() : [];
  for (const customer of customers || []) {
    if (existingSourceIds.has(String(customer.id))) {
      skipped.existing_external_link = (skipped.existing_external_link || 0) + 1;
      continue;
    }
    const result = resolveIdentity({ ...customer, sourceSystem: 'housecall_pro' }, {
      contacts: candidates,
      defaultCountry: engagementConfig().defaultPhoneCountry,
    });
    if (result.outcome !== 'net_new') {
      skipped[result.outcome] = (skipped[result.outcome] || 0) + 1;
      continue;
    }
    if (selected.length >= cappedLimit) continue;
    try {
      const projection = buildHcpCanaryProjection(customer);
      selected.push({ customer, projection });
      candidates.push({ id: `pending:${customer.id}`, firstName: projection.contact.firstName, lastName: projection.contact.lastName, phoneNumber: projection.contact.phoneNumber, emailAddress: projection.contact.emailAddress });
    } catch (error) {
      const key = error.status === 422 ? 'malformed_or_no_key' : 'invalid_candidate';
      skipped[key] = (skipped[key] || 0) + 1;
    }
  }
  return { selected, skipped, limit: cappedLimit };
}

export function buildReviewExecutionPlan(review, hcpCustomer) {
  const decision = String(review?.decision || '').trim();
  const status = String(review?.reviewStatus || '').trim();
  if (!decision) throw Object.assign(new Error('Review has no decision to execute.'), { status: 422 });
  if (!['Open', 'InReview'].includes(status)) throw Object.assign(new Error(`Review is not actionable (status ${status || 'unknown'}).`), { status: 409 });
  const sourceAccountId = String(review.sourceAccountId || process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID || '').trim();
  const externalId = String(review.externalId || '').trim();
  if (!sourceAccountId) throw Object.assign(new Error('sourceAccountId is missing for the review.'), { status: 503 });
  if (!externalId) throw Object.assign(new Error('externalId is missing for the review.'), { status: 422 });
  const evidence = { source: 'identity_review', reviewId: review.id || null, decision };
  const baseLink = { name: `HousecallPro:${externalId}`, sourceSystem: 'HousecallPro', sourceAccountId, externalId, linkStatus: 'Confirmed' };

  if (decision === 'Defer') {
    return { action: 'defer', reviewUpdate: { reviewStatus: 'Deferred' } };
  }
  if (decision === 'LinkExisting') {
    const contactId = String(review.candidateContactId || '').trim();
    if (!contactId) throw Object.assign(new Error('LinkExisting requires a candidateContactId on the review.'), { status: 422 });
    return {
      action: 'link',
      contactId,
      link: { ...baseLink, contactId, matchingEvidence: evidence },
      reviewUpdate: { reviewStatus: 'Linked' },
    };
  }
  if (decision === 'CreateNew' || decision === 'Separate') {
    const projection = buildHcpCanaryProjection(hcpCustomer);
    projection.link.linkStatus = 'Confirmed';
    projection.link.matchingEvidence = {
      ...projection.link.matchingEvidence,
      ...evidence,
      ...(decision === 'Separate' ? { separatedFrom: review.candidateContactId || null } : {}),
    };
    return {
      action: 'create',
      contact: projection.contact,
      link: projection.link,
      reviewUpdate: { reviewStatus: decision === 'Separate' ? 'Separate' : 'Created' },
    };
  }
  throw Object.assign(new Error(`Unknown review decision: ${decision}.`), { status: 422 });
}

export async function recordReviewExecution(pool, { reviewId, contactId, decision, sourceSystem = 'housecall_pro' }) {
  await pool.query(`
    INSERT INTO integration_events (
      source_system, source_event_id, event_type, terminal_status, target_contact_id, correlation_id, processed_at
    ) VALUES ($1, $2, $3, 'processed', $4, $5, NOW())
    ON CONFLICT (source_system, source_event_id) DO NOTHING
  `, [sourceSystem, `review:${reviewId}`, `identity.review.${String(decision || 'unknown').toLowerCase()}`, contactId || null, crypto.randomUUID()]);
}

export async function createHcpImportRun(pool, batchSize) {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO hcp_contact_import_runs (id, status, batch_size) VALUES ($1, $2, $3)', [id, 'running', batchSize]);
  return { id, status: 'running', batchSize };
}

export async function getHcpImportRun(pool, runId) {
  const result = await pool.query('SELECT * FROM hcp_contact_import_runs WHERE id = $1', [runId]);
  return result.rows[0] || null;
}

export async function recordHcpImportBatch(pool, { runId, selectedCount, createdCount, skippedCounts, errorCode = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query('SELECT batch_number FROM hcp_contact_import_batches WHERE run_id = $1 ORDER BY batch_number DESC LIMIT 1 FOR UPDATE', [runId]);
    const batchNumber = Number(previous.rows[0]?.batch_number || 0) + 1;
    await client.query(`
      INSERT INTO hcp_contact_import_batches (run_id, batch_number, selected_count, created_count, skipped_counts, status, error_code, completed_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
    `, [runId, batchNumber, selectedCount, createdCount, JSON.stringify(skippedCounts || {}), errorCode ? 'failed' : 'complete', errorCode]);
    await client.query(`
      UPDATE hcp_contact_import_runs
      SET created_count = created_count + $2,
          existing_count = existing_count + $3,
          reviewable_count = reviewable_count + $4,
          malformed_count = malformed_count + $5,
          error_code = $6,
          updated_at = NOW()
      WHERE id = $1
    `, [runId, createdCount, Number(skippedCounts?.existing_external_link || 0), Number(skippedCounts?.provisional || 0) + Number(skippedCounts?.identity_review || 0) + Number(skippedCounts?.field_conflict || 0), Number(skippedCounts?.malformed_or_no_key || 0), errorCode]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeHcpImportRun(pool, runId) {
  await pool.query(`
    UPDATE hcp_contact_import_runs
    SET status = 'complete', completed_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND status = 'running'
  `, [runId]);
}