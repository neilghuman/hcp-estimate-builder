import test from 'node:test';
import assert from 'node:assert/strict';
import { namesMateriallyDifferent, normalizeEmail, normalizePhone, resolveIdentity } from '../src/engagement_identity.js';
import { buildDryRunDecision, buildHcpCanaryProjection, buildHcpReconciliationDecisions, fingerprint, summarizeReconciliation } from '../src/engagement_runtime.js';

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