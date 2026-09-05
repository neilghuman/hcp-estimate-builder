import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTimestamp, highWater, selectLiveSyncWork } from '../src/engagement_livesync.js';

process.env.ENGAGEMENT_HCP_SOURCE_ACCOUNT_ID = 'hcp-production-shared';

const T1 = '2026-09-01T10:00:00Z';
const T2 = '2026-09-01T11:00:00Z';
const T3 = '2026-09-01T12:00:00Z';

function customer(id, ts, { phone = null, email = null, first = 'Test', last = 'Person' } = {}) {
  return { id, updatedAt: ts, firstName: first, lastName: last, phones: phone ? [phone] : [], email };
}

function contact(id, { phone = null, email = null, first = 'Test', last = 'Person' } = {}) {
  return { id, firstName: first, lastName: last, phoneNumber: phone, emailAddress: email };
}

test('effectiveTimestamp prefers updatedAt then createdAt', () => {
  assert.equal(effectiveTimestamp({ updatedAt: T2, createdAt: T1 }), T2);
  assert.equal(effectiveTimestamp({ createdAt: T1 }), T1);
  assert.equal(effectiveTimestamp({}), null);
});

test('highWater returns the lexicographic max ISO timestamp', () => {
  assert.equal(highWater([T1, T3, T2]), T3);
  assert.equal(highWater([]), null);
});

test('first run initializes the cursor to the high-water mark and imports nothing', () => {
  const customers = [customer('c1', T1, { phone: '206-593-3301' }), customer('c2', T3, { phone: '206-593-3302' })];
  const work = selectLiveSyncWork(customers, [], { cursor: null });
  assert.equal(work.firstRun, true);
  assert.equal(work.nextCursor, T3);
  assert.deepEqual(work.imports, []);
  assert.deepEqual(work.reviews, []);
});

test('net_new customers changed after the cursor become imports and advance the cursor', () => {
  const customers = [customer('c1', T2, { phone: '206-593-3311', email: 'a@example.com' })];
  const work = selectLiveSyncWork(customers, [], { cursor: T1 });
  assert.equal(work.firstRun, false);
  assert.equal(work.imports.length, 1);
  assert.equal(work.imports[0].customer.id, 'c1');
  assert.equal(work.imports[0].projection.link.externalId, 'c1');
  assert.equal(work.reviews.length, 0);
  assert.equal(work.nextCursor, T2);
});

test('customers not changed since the cursor are ignored', () => {
  const customers = [customer('old', T1, { phone: '206-593-3399' })];
  const work = selectLiveSyncWork(customers, [], { cursor: T2 });
  assert.equal(work.examined, 0);
  assert.equal(work.imports.length, 0);
  assert.equal(work.nextCursor, T2);
});

test('single-identifier match against an existing contact is queued for review, not imported', () => {
  const contacts = [contact('crm-1', { phone: '206-593-3320', first: 'Dana', last: 'Reyes' })];
  const customers = [customer('c9', T2, { phone: '206-593-3320', first: 'Different', last: 'Name' })];
  const work = selectLiveSyncWork(customers, contacts, { cursor: T1 });
  assert.equal(work.imports.length, 0);
  assert.equal(work.reviews.length, 1);
  assert.equal(work.reviews[0].customer.id, 'c9');
  assert.equal(work.nextCursor, T2);
});

test('a two-identifier auto-confirmed match writes nothing but still advances the cursor', () => {
  const contacts = [contact('crm-2', { phone: '206-593-3330', email: 'match@example.com', first: 'Sam', last: 'Lee' })];
  const customers = [customer('c5', T2, { phone: '206-593-3330', email: 'match@example.com', first: 'Sam', last: 'Lee' })];
  const work = selectLiveSyncWork(customers, contacts, { cursor: T1 });
  assert.equal(work.imports.length, 0);
  assert.equal(work.reviews.length, 0);
  assert.equal(work.skipped.auto_confirmed, 1);
  assert.equal(work.nextCursor, T2);
});

test('an existing external link is skipped and does not create a duplicate Contact', () => {
  const customers = [customer('c7', T2, { phone: '206-593-3340', email: 'linked@example.com' })];
  const work = selectLiveSyncWork(customers, [], { cursor: T1, existingLinkSourceIds: new Set(['c7']) });
  assert.equal(work.imports.length, 0);
  assert.equal(work.skipped.existing_external_link, 1);
  assert.equal(work.nextCursor, T2);
});

test('an open review for the same source id is not re-queued', () => {
  const contacts = [contact('crm-3', { phone: '206-593-3350' })];
  const customers = [customer('c8', T2, { phone: '206-593-3350', first: 'Other', last: 'Human' })];
  const work = selectLiveSyncWork(customers, contacts, { cursor: T1, existingReviewSourceIds: new Set(['c8']) });
  assert.equal(work.reviews.length, 0);
  assert.equal(work.skipped.existing_open_review, 1);
});

test('the write budget caps a tick and holds the cursor behind the unprocessed customer', () => {
  const customers = [
    customer('c1', T2, { phone: '206-593-3361', email: 'one@example.com' }),
    customer('c2', T3, { phone: '206-593-3362', email: 'two@example.com' }),
  ];
  const work = selectLiveSyncWork(customers, [], { cursor: T1, batchLimit: 1 });
  assert.equal(work.imports.length, 1);
  assert.equal(work.imports[0].customer.id, 'c1');
  assert.equal(work.nextCursor, T2);
  assert.equal(work.remaining, 1);
});

test('a same-tick duplicate identity resolves against the pending contact instead of creating twice', () => {
  const customers = [
    customer('dup1', T2, { phone: '206-593-3370', email: 'dup@example.com', first: 'Jo', last: 'Kim' }),
    customer('dup2', T3, { phone: '206-593-3370', email: 'dup@example.com', first: 'Jo', last: 'Kim' }),
  ];
  const work = selectLiveSyncWork(customers, [], { cursor: T1, batchLimit: 10 });
  assert.equal(work.imports.length, 1);
  // The second one matches the pending seed on both identifiers -> auto-confirmed, no second Contact.
  assert.equal(work.reviews.length, 0);
});
