// HCP write helpers — unit tests for appendCustomerNote + createEmptyEstimate (mocked fetch).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendCustomerNote, createEmptyEstimate } from '../src/hcp.js';

const realFetch = globalThis.fetch;
beforeEach(() => { process.env.HCP_API_KEY = 'test-key'; });
afterEach(() => { globalThis.fetch = realFetch; });

function mockSequence(handlers) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const h = handlers.shift();
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(h) };
  };
  return calls;
}

test('appendCustomerNote appends when marker absent (read then PUT)', async () => {
  const calls = mockSequence([{ notes: 'Existing note.' }, { notes: 'Existing note.\n\nNEW' }]);
  const res = await appendCustomerNote('cus_1', 'NEW', '[intake:p1]');
  assert.equal(res.appended, true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  assert.match(calls[1].body.notes, /Existing note\.\n\nNEW/);
});

test('appendCustomerNote is idempotent when marker already present (no PUT)', async () => {
  const calls = mockSequence([{ notes: 'Prior\n\nCustomer Intake [intake:p1]\nProblem: x' }]);
  const res = await appendCustomerNote('cus_1', 'anything', '[intake:p1]');
  assert.equal(res.appended, false);
  assert.equal(calls.length, 1); // only the GET; never wrote
});

test('appendCustomerNote handles empty existing notes', async () => {
  const calls = mockSequence([{ notes: null }, { notes: 'NEW' }]);
  const res = await appendCustomerNote('cus_1', 'NEW', '[intake:p2]');
  assert.equal(res.appended, true);
  assert.equal(calls[1].body.notes, 'NEW'); // no leading separator
});

test('createEmptyEstimate posts one option with no line items', async () => {
  const calls = mockSequence([{ id: 'est_1', estimate_number: '1042' }]);
  const res = await createEmptyEstimate({ customerId: 'cus_1', addressId: 'adr_1', optionName: 'Tree' });
  assert.equal(res.id, 'est_1');
  assert.equal(res.estimate_number, '1042');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.customer_id, 'cus_1');
  assert.equal(calls[0].body.address_id, 'adr_1');
  assert.deepEqual(calls[0].body.options, [{ name: 'Tree', line_items: [] }]);
});

test('createEmptyEstimate omits address_id when not provided', async () => {
  const calls = mockSequence([{ id: 'est_2', estimate_number: '1043' }]);
  await createEmptyEstimate({ customerId: 'cus_1' });
  assert.equal('address_id' in calls[0].body, false);
  assert.equal(calls[0].body.options[0].name, 'Estimate');
});
