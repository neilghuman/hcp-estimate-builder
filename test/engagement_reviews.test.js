import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewExecutionPlan } from '../src/engagement_runtime.js';

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
