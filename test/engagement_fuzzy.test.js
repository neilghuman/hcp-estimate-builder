import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDuplicateReview, findDuplicateClusters, nameSimilarity, scoreContactPair } from '../src/engagement_fuzzy.js';

function contact(id, { phone = null, email = null, first = 'Test', last = 'Person' } = {}) {
  return { id, firstName: first, lastName: last, phoneNumber: phone, emailAddress: email };
}

function key(id, { phone = null, email = null, tokens = [] } = {}) {
  return { id, phone, email, tokens };
}

test('nameSimilarity is 1 for identical names and high for typos', () => {
  assert.equal(nameSimilarity(['john', 'smith'], ['john', 'smith']), 1);
  assert.ok(nameSimilarity(['jon', 'smith'], ['john', 'smith']) >= 0.8);
});

test('nameSimilarity is low for unrelated names', () => {
  assert.ok(nameSimilarity(['john', 'smith'], ['maria', 'garcia']) < 0.5);
});

test('scoreContactPair flags a shared identifier when a name token matches (nickname/typo)', () => {
  const score = scoreContactPair(
    key('a', { phone: '+12065933301', tokens: ['robert', 'lee'] }),
    key('b', { phone: '+12065933301', tokens: ['bob', 'lee'] }),
  );
  assert.equal(score.phoneMatch, true);
  assert.equal(score.sharedToken, true);
  assert.equal(score.suspect, true);
});

test('scoreContactPair does NOT flag a shared household phone with different names', () => {
  const score = scoreContactPair(
    key('a', { phone: '+12065933301', tokens: ['bob', 'jones'] }),
    key('b', { phone: '+12065933301', tokens: ['alice', 'smith'] }),
  );
  assert.equal(score.phoneMatch, true);
  assert.equal(score.suspect, false);
});

test('scoreContactPair does NOT flag identical names with no shared identifier', () => {
  const score = scoreContactPair(
    key('a', { phone: '+12065933301', tokens: ['john', 'smith'] }),
    key('b', { email: 'john@example.com', tokens: ['john', 'smith'] }),
  );
  assert.equal(score.suspect, false);
});

test('two contacts sharing a phone with similar names form one cluster', () => {
  const contacts = [
    contact('c1', { phone: '206-593-3301', first: 'John', last: 'Smith' }),
    contact('c2', { phone: '206-593-3301', first: 'Jon', last: 'Smith' }),
    contact('c3', { phone: '206-593-3399', first: 'Unrelated', last: 'Person' }),
  ];
  const clusters = findDuplicateClusters(contacts, { defaultCountry: 'US' });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].contactIds, ['c1', 'c2']);
  assert.equal(clusters[0].pairs.length, 1);
});

test('a shared email with similar names forms a cluster', () => {
  const contacts = [
    contact('e1', { email: 'Dana.Reyes@example.com', first: 'Dana', last: 'Reyes' }),
    contact('e2', { email: 'dana.reyes@example.com', first: 'Dana', last: 'Reyes' }),
  ];
  const clusters = findDuplicateClusters(contacts, { defaultCountry: 'US' });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].contactIds, ['e1', 'e2']);
});

test('duplicates are unioned transitively across phone and email links', () => {
  const contacts = [
    contact('a', { phone: '206-593-3310', first: 'Robert', last: 'Lee' }),
    contact('b', { phone: '206-593-3310', email: 'rlee@example.com', first: 'Bob', last: 'Lee' }),
    contact('c', { email: 'rlee@example.com', first: 'Bobby', last: 'Lee' }),
  ];
  const clusters = findDuplicateClusters(contacts, { defaultCountry: 'US' });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].contactIds, ['a', 'b', 'c']);
});

test('unrelated contacts produce no clusters', () => {
  const contacts = [
    contact('x', { phone: '206-593-3320', first: 'Amy', last: 'North' }),
    contact('y', { email: 'ben@example.com', first: 'Ben', last: 'West' }),
  ];
  assert.deepEqual(findDuplicateClusters(contacts, { defaultCountry: 'US' }), []);
});

test('cluster keys are stable regardless of input order', () => {
  const a = contact('c1', { phone: '206-593-3330', first: 'Kim', last: 'Vo' });
  const b = contact('c2', { phone: '206-593-3330', first: 'Kim', last: 'Vo' });
  const one = findDuplicateClusters([a, b], { defaultCountry: 'US' })[0];
  const two = findDuplicateClusters([b, a], { defaultCountry: 'US' })[0];
  assert.equal(one.clusterKey, two.clusterKey);
});

test('buildDuplicateReview is idempotent-keyed and never targets a merge', () => {
  const contacts = [
    contact('c1', { phone: '206-593-3340', first: 'Pat', last: 'Ng' }),
    contact('c2', { phone: '206-593-3340', first: 'Pat', last: 'Ng' }),
  ];
  const cluster = findDuplicateClusters(contacts, { defaultCountry: 'US' })[0];
  const byId = new Map(contacts.map((c) => [String(c.id), c]));
  const review = buildDuplicateReview(cluster, byId);
  assert.equal(review.externalId, cluster.clusterKey);
  assert.equal(review.reviewStatus, 'Open');
  assert.equal(review.conflictSummary, 'fuzzy_duplicate');
  assert.equal(review.candidateContactId, 'c1');
  assert.deepEqual(review.matchingEvidence.contactIds, ['c1', 'c2']);
  assert.equal(review.matchingEvidence.type, 'fuzzy_duplicate');
});
