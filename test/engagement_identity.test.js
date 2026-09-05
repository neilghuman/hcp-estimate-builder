import test from 'node:test';
import assert from 'node:assert/strict';
import { namesMateriallyDifferent, normalizeEmail, normalizePhone, resolveIdentity } from '../src/engagement_identity.js';
import { buildDryRunDecision, buildHcpCanaryProjection, buildHcpReconciliationDecisions, buildIdentityReview, compareContactAddress, fingerprint, selectAddressWriteCanary, selectHcpCanaryCandidates, selectIdentityReviewCandidates, selectPrimaryHcpAddress, summarizeAddressAudit, summarizeReconciliation } from '../src/engagement_runtime.js';

const contact = {
  id: 'crm-1',
  firstName: 'Jane',
  lastName: 'Doe',
  phoneNumbers: ['(206) 555-1212'],
  emailAddresses: ['Jane.Doe@example.com'],
};

test('canonicalizes valid identity keys without changing their display values', () => {
  assert.equal(normalizePhone('206-555-1212'), '+12065551212');
  assert.equal(normalizePhone('206'), null);
  assert.equal(normalizeEmail(' Jane.Doe@Example.COM '), 'jane.doe@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('external identity link takes precedence over identifier matching', () => {
  const result = resolveIdentity({ phone: '999-999-9999' }, { existingLink: { contactId: 'crm-linked' } });
  assert.deepEqual(result, { outcome: 'auto_confirmed', contactId: 'crm-linked', linkStatus: 'confirmed', match: 'external_link' });
});

test('two identifiers supporting one contact auto-confirm', () => {
  const result = resolveIdentity({ sourceSystem: 'housecall_pro', firstName: 'Jane', lastName: 'Doe', phone: '+1 206 555 1212', email: 'jane.doe@example.com' }, { contacts: [contact] });
  assert.equal(result.outcome, 'auto_confirmed');
  assert.equal(result.contactId, 'crm-1');
});

test('a single matching identifier becomes provisional when no field conflicts', () => {
  const result = resolveIdentity({ sourceSystem: 'chatwoot', phone: '+12065551212' }, { contacts: [contact] });
  assert.equal(result.outcome, 'provisional');
  assert.equal(result.match, 'phone');
});

test('a secondary source phone can resolve a contact match', () => {
  const result = resolveIdentity({ sourceSystem: 'housecall_pro', phones: ['425-555-0100', '206-555-1212'] }, { contacts: [contact] });
  assert.equal(result.outcome, 'provisional');
  assert.equal(result.match, 'phone');
});

test('a different supplied value is surfaced as a field conflict', () => {
  const result = resolveIdentity({ phone: '+12065551212', email: 'other@example.com' }, { contacts: [contact] });
  assert.equal(result.outcome, 'field_conflict');
  assert.equal(result.conflicts.email, true);
});

test('different contacts matched by different identifiers require review', () => {
  const result = resolveIdentity({ phone: '+12065551212', email: 'other@example.com' }, {
    contacts: [contact, { id: 'crm-2', email: 'other@example.com' }],
  });
  assert.equal(result.outcome, 'identity_review');
  assert.deepEqual(result.candidateContactIds.sort(), ['crm-1', 'crm-2']);
});

test('an HCP two-identifier match with a material name difference requires review', () => {
  const result = resolveIdentity({ sourceSystem: 'housecall_pro', firstName: 'John', lastName: 'Smith', phone: '+12065551212', email: 'jane.doe@example.com' }, { contacts: [contact] });
  assert.equal(result.outcome, 'identity_review');
  assert.equal(result.reason, 'hcp_name_mismatch');
});

test('unknown and malformed identities have distinct safe outcomes', () => {
  assert.equal(resolveIdentity({ phone: '+12065551212' }).outcome, 'net_new');
  assert.equal(resolveIdentity({ phone: 'extension 42', email: 'bad' }).outcome, 'malformed_or_no_key');
  assert.equal(namesMateriallyDifferent('Jane Doe', 'Jane Doe'), false);
  assert.equal(namesMateriallyDifferent('Jane Doe', 'John Smith'), true);
});

test('dry-run decisions store only fingerprints of normalized identity keys', () => {
  const decision = buildDryRunDecision({
    sourceSystem: 'housecall_pro', sourceEventId: 'cus_123', record: { phone: '206-555-1212' }, contacts: [contact],
  });
  assert.equal(decision.result.outcome, 'provisional');
  assert.equal(decision.normalizedPhoneHash, fingerprint('+12065551212'));
  assert.equal(decision.normalizedPhoneHash.includes('2065551212'), false);
  assert.equal(decision.normalizedEmailHash, null);
});

test('dry-run decisions require a source and source event identifier', () => {
  assert.throws(() => buildDryRunDecision({ sourceEventId: '1', record: {} }), /sourceSystem is required/);
  assert.throws(() => buildDryRunDecision({ sourceSystem: 'chatwoot', record: {} }), /sourceEventId is required/);
});

test('reconciliation reports aggregate outcomes and redact external identifiers', () => {
  const report = summarizeReconciliation([
    { id: 'cus-confirmed', firstName: 'Jane', lastName: 'Doe', phone: '+12065551212', email: 'jane.doe@example.com' },
    { id: 'cus-review', phone: '206-555-1212', email: 'other@example.com' },
  ], [contact, { id: 'crm-2', email: 'other@example.com' }]);
  assert.deepEqual(report.counts, { total: 2, auto_confirmed: 1, provisional: 0, identity_review: 1, net_new: 0, malformed_or_no_key: 0, field_conflict: 0 });
  assert.equal(report.examples[0].outcome, 'identity_review');
  assert.equal(report.examples[0].externalIdHash, fingerprint('cus-review'));
});

test('HCP reconciliation decisions use the source customer ID only as an opaque event key', () => {
  const decisions = buildHcpReconciliationDecisions([{ id: 'cus_opaque', phone: '206-555-1212' }], [contact]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].sourceSystem, 'housecall_pro');
  assert.equal(decisions[0].sourceEventId, 'cus_opaque');
  assert.equal(decisions[0].result.outcome, 'provisional');
  assert.equal(decisions[0].normalizedPhoneHash, fingerprint('+12065551212'));
});

test('HCP canary projection has a minimal Contact and immutable source link', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const projection = buildHcpCanaryProjection({ id: 'cus_123', firstName: 'Jane', lastName: 'Doe', phones: ['206-555-1212'], email: 'Jane@example.com' });
  assert.deepEqual(projection.contact, { firstName: 'Jane', lastName: 'Doe', phoneNumber: '+12065551212', emailAddress: 'jane@example.com' });
  assert.equal(projection.link.sourceSystem, 'HousecallPro');
  assert.equal(projection.link.sourceAccountId, 'hcp-production-shared');
  assert.equal(projection.link.linkStatus, 'Provisional');
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('HCP canary projection rejects missing source account, name, and identity key', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  delete process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  assert.throws(() => buildHcpCanaryProjection({ id: 'cus_123', firstName: 'Jane', phones: ['206-555-1212'] }), /SOURCE_ACCOUNT_ID/);
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  assert.throws(() => buildHcpCanaryProjection({ id: 'cus_123', phones: ['206-555-1212'] }), /name is required/);
  assert.throws(() => buildHcpCanaryProjection({ id: 'cus_123', firstName: 'Jane', phones: ['extension 1'] }), /phone number or email/);
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('a successful canary decision can retain its net-new outcome and created Contact ID', () => {
  const decision = buildDryRunDecision({ sourceSystem: 'housecall_pro', sourceEventId: 'canary:hash', record: { phone: '206-555-1212' }, contacts: [] });
  assert.equal(decision.result.outcome, 'net_new');
  decision.result.contactId = 'crm-created';
  assert.equal(decision.result.contactId, 'crm-created');
});

test('HCP batch canary selects only net-new candidates and caps creates at ten', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const customers = Array.from({ length: 12 }, (_value, index) => ({ id: `cus_${index}`, firstName: `Person${index}`, phones: [`206-555-${String(1000 + index).slice(-4)}`] }));
  const batch = selectHcpCanaryCandidates(customers, [], { limit: 50 });
  assert.equal(batch.limit, 10);
  assert.equal(batch.selected.length, 10);
  assert.deepEqual(batch.skipped, {});
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('expanded HCP batch selector permits at most twenty-five creates', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const customers = Array.from({ length: 30 }, (_value, index) => ({ id: `cus-expanded-${index}`, firstName: `Person${index}`, phones: [`206-555-${String(2000 + index).slice(-4)}`] }));
  const batch = selectHcpCanaryCandidates(customers, [], { limit: 50, maxLimit: 25 });
  assert.equal(batch.limit, 25);
  assert.equal(batch.selected.length, 25);
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('larger HCP batch selector permits at most one hundred creates', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const customers = Array.from({ length: 120 }, (_value, index) => ({ id: `cus-large-${index}`, firstName: `Person${index}`, phones: [`206-555-${String(3000 + index).slice(-4)}`] }));
  const batch = selectHcpCanaryCandidates(customers, [], { limit: 200, maxLimit: 100 });
  assert.equal(batch.limit, 100);
  assert.equal(batch.selected.length, 100);
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('HCP batch canary skips records that match a Contact or lack a usable identity', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const batch = selectHcpCanaryCandidates([
    { id: 'existing', firstName: 'Jane', phones: ['206-555-1212'] },
    { id: 'invalid', firstName: 'No Key', phones: ['extension 3'] },
    { id: 'new', firstName: 'New', phones: ['425-555-0100'] },
  ], [contact]);
  assert.equal(batch.selected.length, 1);
  assert.equal(batch.selected[0].customer.id, 'new');
  assert.deepEqual(batch.skipped, { provisional: 1, malformed_or_no_key: 1 });
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});

test('address selection prefers one billing address, then falls back to one service address', () => {
  const service = { id: 'adr-service', type: 'service', street: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' };
  const billing = { id: 'adr-billing', type: 'billing', street: '2 Main St', city: 'Seattle', state: 'WA', zip: '98102', country: 'US' };
  assert.equal(selectPrimaryHcpAddress([billing, service]).status, 'selected_billing_fallback');
  assert.equal(selectPrimaryHcpAddress([billing]).status, 'selected_billing_fallback');
  assert.equal(selectPrimaryHcpAddress([service]).status, 'selected_service_fallback');
  assert.equal(selectPrimaryHcpAddress([service, { ...service, id: 'adr-service-2' }]).status, 'ambiguous_multiple_service_addresses');
  assert.equal(selectPrimaryHcpAddress([billing, { ...billing, id: 'adr-billing-2' }]).status, 'ambiguous_multiple_billing_addresses');
});

test('address comparison only permits a blank CRM address or reports an exact match', () => {
  const candidate = selectPrimaryHcpAddress([{ id: 'adr-1', type: 'service', street: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }]).address;
  assert.equal(compareContactAddress({}, candidate).status, 'crm_blank');
  assert.equal(compareContactAddress({ addressStreet: '1  Main St', addressCity: 'Seattle', addressState: 'WA', addressPostalCode: '98101' }, candidate).status, 'match');
  assert.equal(compareContactAddress({ addressStreet: '9 Other St', addressCity: 'Seattle', addressState: 'WA', addressPostalCode: '98101' }, candidate).status, 'conflict');
});

test('address audit summarizes selected, blank, and ambiguous address states without raw values', () => {
  const report = summarizeAddressAudit([
    { contactId: 'crm-1', linkId: 'link-1', contact: {}, addresses: [{ id: 'adr-1', type: 'billing', street: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101' }] },
    { contactId: 'crm-2', linkId: 'link-2', contact: {}, addresses: [{ id: 'adr-2', type: 'service', street: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101' }, { id: 'adr-3', type: 'service', street: '2 Main St', city: 'Seattle', state: 'WA', zip: '98102' }] },
  ]);
  assert.equal(report.counts.crm_blank, 1);
  assert.equal(report.counts.ambiguous_multiple_service_addresses, 1);
  assert.equal(report.examples[0].hcpAddressIdHash, fingerprint('adr-1'));
  assert.equal(JSON.stringify(report).includes('1 Main St'), false);
});

test('address write canary selects only blank unambiguous Contacts and caps at ten', () => {
  const service = { id: 'adr-1', type: 'service', street: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101' };
  const rows = [
    { contactId: 'crm-blank', linkId: 'link-blank', contact: {}, addresses: [service] },
    { contactId: 'crm-conflict', linkId: 'link-conflict', contact: { addressStreet: '9 Other St', addressCity: 'Seattle', addressState: 'WA', addressPostalCode: '98101' }, addresses: [service] },
    { contactId: 'crm-ambiguous', linkId: 'link-ambiguous', contact: {}, addresses: [service, { ...service, id: 'adr-2' }] },
  ];
  const batch = selectAddressWriteCanary(rows, { limit: 25 });
  assert.equal(batch.limit, 10);
  assert.equal(batch.selected.length, 1);
  assert.equal(batch.selected[0].contactId, 'crm-blank');
  assert.deepEqual(batch.skipped, { conflict: 1, ambiguous_multiple_service_addresses: 1 });
});

test('expanded address backfill selector permits at most twenty-five writes', () => {
  const rows = Array.from({ length: 30 }, (_value, index) => ({
    contactId: `crm-${index}`,
    linkId: `link-${index}`,
    contact: {},
    addresses: [{ id: `adr-${index}`, type: 'billing', street: `${index} Main St`, city: 'Seattle', state: 'WA', zip: '98101' }],
  }));
  const batch = selectAddressWriteCanary(rows, { limit: 50, maxLimit: 25 });
  assert.equal(batch.limit, 25);
  assert.equal(batch.selected.length, 25);
});

test('IdentityReview selection is capped and excludes safe net-new and malformed outcomes', () => {
  const batch = selectIdentityReviewCandidates([
    { id: 'review', phone: '206-555-1212' },
    { id: 'new', phone: '425-555-0100' },
    { id: 'malformed', phone: 'extension 3' },
  ], [contact], { limit: 50 });
  assert.equal(batch.limit, 10);
  assert.equal(batch.selected.length, 1);
  assert.equal(batch.selected[0].result.outcome, 'provisional');
  assert.equal(batch.skipped.net_new, 1);
  assert.equal(batch.skipped.malformed_or_no_key, 1);
});

test('IdentityReview payload contains decision evidence but no raw phone or email', () => {
  const original = process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID;
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';
  const review = buildIdentityReview({ id: 'cus_123' }, { outcome: 'field_conflict', contactId: 'crm-1', conflicts: { phone: true } });
  assert.equal(review.reviewStatus, 'Open');
  assert.equal(review.candidateContactId, 'crm-1');
  assert.equal(review.conflictSummary, 'field_conflict');
  assert.equal(JSON.stringify(review).includes('206-555'), false);
  process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = original;
});