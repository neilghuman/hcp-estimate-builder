import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewExecutionPlan, deriveBrandRelationships, isContactAddressBlank, selectAddressBackfillCandidates, selectBrandBackfillCandidates } from '../src/engagement_runtime.js';

const SOURCE_ACCOUNT = 'hcp-production-shared';
process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = SOURCE_ACCOUNT;

const baseReview = {
  id: 'rev-1',
  reviewStatus: 'Open',
  sourceAccountId: SOURCE_ACCOUNT,
  externalId: 'cus_abc',
  candidateContactId: 'crm-9',
};

test('LinkExisting builds a Confirmed link to the candidate contact', () => {
  const plan = buildReviewExecutionPlan({ ...baseReview, decision: 'LinkExisting' });
  assert.equal(plan.action, 'link');
  assert.equal(plan.contactId, 'crm-9');
  assert.equal(plan.link.contactId, 'crm-9');
  assert.equal(plan.link.linkStatus, 'Confirmed');
  assert.equal(plan.link.externalId, 'cus_abc');
  assert.equal(plan.link.sourceSystem, 'HousecallPro');
  assert.equal(plan.reviewUpdate.reviewStatus, 'Linked');
});

test('LinkExisting requires a candidate contact', () => {
  assert.throws(
    () => buildReviewExecutionPlan({ ...baseReview, candidateContactId: null, decision: 'LinkExisting' }),
    /candidateContactId/,
  );
});

test('CreateNew projects a new Contact plus a Confirmed link from the HCP customer', () => {
  const plan = buildReviewExecutionPlan(
    { ...baseReview, decision: 'CreateNew' },
    { id: 'cus_abc', firstName: 'Dylan', lastName: 'Ghuman', email: 'dylan@example.com', phones: ['206-593-3336'] },
  );
  assert.equal(plan.action, 'create');
  assert.equal(plan.contact.firstName, 'Dylan');
  assert.equal(plan.contact.lastName, 'Ghuman');
  assert.equal(plan.link.linkStatus, 'Confirmed');
  assert.equal(plan.link.externalId, 'cus_abc');
  assert.equal(plan.reviewUpdate.reviewStatus, 'Created');
});

test('Separate creates a new Contact and records what it was separated from', () => {
  const plan = buildReviewExecutionPlan(
    { ...baseReview, decision: 'Separate' },
    { id: 'cus_abc', firstName: 'Jamie', lastName: 'Rivera', phones: ['206-555-0123'] },
  );
  assert.equal(plan.action, 'create');
  assert.equal(plan.link.matchingEvidence.separatedFrom, 'crm-9');
  assert.equal(plan.reviewUpdate.reviewStatus, 'Separate');
});

test('Defer only advances the review status, no writes', () => {
  const plan = buildReviewExecutionPlan({ ...baseReview, decision: 'Defer' });
  assert.equal(plan.action, 'defer');
  assert.equal(plan.reviewUpdate.reviewStatus, 'Deferred');
  assert.equal(plan.contact, undefined);
  assert.equal(plan.link, undefined);
});

test('a review without a decision is not executable', () => {
  assert.throws(() => buildReviewExecutionPlan({ ...baseReview, decision: '' }), /no decision/);
});

test('a review that is not Open or InReview is rejected', () => {
  assert.throws(
    () => buildReviewExecutionPlan({ ...baseReview, reviewStatus: 'Linked', decision: 'LinkExisting' }),
    /not actionable/,
  );
});

test('an unknown decision is rejected', () => {
  assert.throws(() => buildReviewExecutionPlan({ ...baseReview, decision: 'Frobnicate' }), /Unknown review decision/);
});

test('isContactAddressBlank detects empty vs populated addresses', () => {
  assert.equal(isContactAddressBlank({}), true);
  assert.equal(isContactAddressBlank({ addressCity: 'Seattle' }), false);
});

test('address backfill selects only blank contacts, caps, and reports skips', () => {
  const links = [
    { id: 'l1', contactId: 'c1', externalId: 'cus_1' },
    { id: 'l2', contactId: 'c2', externalId: 'cus_2' },
    { id: 'l3', contactId: 'c3', externalId: 'cus_3' },
    { id: 'l4', contactId: 'c4', externalId: 'cus_4' },
  ];
  const byId = new Map([
    ['c1', { id: 'c1' }],
    ['c2', { id: 'c2', addressStreet: '1 Main St' }],
    ['c3', { id: 'c3' }],
  ]);
  const batch = selectAddressBackfillCandidates(links, byId, { limit: 1, maxLimit: 200 });
  assert.equal(batch.selected.length, 1);
  assert.equal(batch.selected[0].contactId, 'c1');
  assert.equal(batch.limit, 1);

  const all = selectAddressBackfillCandidates(links, byId, { maxLimit: 200 });
  assert.deepEqual(all.selected.map((c) => c.contactId), ['c1', 'c3']);
  assert.equal(all.skipped.has_address, 1);
  assert.equal(all.skipped.contact_missing, 1);
});

test('deriveBrandRelationships maps recognized brand tags and ignores non-brand tags', () => {
  const r = deriveBrandRelationships(['Website Lead', 'Tree', 'Landscaping', 'Lessen']);
  assert.deepEqual(r.brandRelationships, ['trees', 'landscaping']);
  assert.equal(r.primaryBrand, 'landscaping');
  assert.deepEqual(deriveBrandRelationships([]).brandRelationships, []);
  assert.equal(deriveBrandRelationships(['Website Lead']).primaryBrand, null);
});

test('brand backfill unions brands, never removes, and skips already-current contacts', () => {
  const links = [
    { id: 'l1', contactId: 'c1', externalId: 'cus_1' },
    { id: 'l2', contactId: 'c2', externalId: 'cus_2' },
    { id: 'l3', contactId: 'c3', externalId: 'cus_3' },
    { id: 'l4', contactId: 'c4', externalId: 'cus_4' },
  ];
  const customers = new Map([
    ['cus_1', { id: 'cus_1', tags: ['Tree'] }],
    ['cus_2', { id: 'cus_2', tags: ['Website Lead'] }],
    ['cus_3', { id: 'cus_3', tags: ['Landscaping'] }],
    ['cus_4', { id: 'cus_4', tags: ['Roofing'] }],
  ]);
  const contacts = new Map([
    ['c1', { id: 'c1', brandRelationships: [] }],
    ['c3', { id: 'c3', brandRelationships: ['landscaping'], primaryBrand: 'landscaping' }],
    ['c4', { id: 'c4', brandRelationships: ['construction'], primaryBrand: 'construction' }],
  ]);
  const batch = selectBrandBackfillCandidates(links, customers, contacts, { maxLimit: 400 });
  assert.equal(batch.skipped.no_brand_tags, 1);
  assert.equal(batch.skipped.already_current, 1);
  const c1 = batch.selected.find((c) => c.contactId === 'c1');
  assert.deepEqual(c1.brandRelationships, ['trees']);
  assert.equal(c1.primaryBrand, 'trees');
  const c4 = batch.selected.find((c) => c.contactId === 'c4');
  assert.deepEqual(c4.brandRelationships.sort(), ['construction', 'roofing']);
  assert.equal(c4.primaryBrand, 'construction');
});
