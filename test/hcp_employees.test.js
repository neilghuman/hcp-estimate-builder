// HCP employees — unit tests for listEmployees (node:test), with a mocked global fetch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listEmployees } from '../src/hcp.js';

const realFetch = globalThis.fetch;

beforeEach(() => { process.env.HCP_API_KEY = 'test-key'; });
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetchOnce(payload) {
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(payload),
  });
}

test('listEmployees sorts office staff first, then alphabetical', async () => {
  mockFetchOnce({
    total_pages: 1,
    employees: [
      { id: 'p1', first_name: 'Alan', last_name: 'Weedman', role: 'field tech', active: true },
      { id: 'p2', first_name: 'Roman', last_name: 'Seipert', role: 'office staff', active: true },
      { id: 'p3', first_name: 'Bob', last_name: 'Ng', role: 'office staff', active: true },
    ],
  });
  const list = await listEmployees();
  assert.deepEqual(list.map((e) => e.name), ['Bob Ng', 'Roman Seipert', 'Alan Weedman']);
  assert.equal(list[0].id, 'p3');
});

test('listEmployees filters inactive when activeOnly', async () => {
  mockFetchOnce({
    total_pages: 1,
    employees: [
      { id: 'p1', first_name: 'Ann', last_name: 'A', role: 'office staff', active: true },
      { id: 'p2', first_name: 'Gone', last_name: 'G', role: 'office staff', active: false },
    ],
  });
  const list = await listEmployees();
  assert.deepEqual(list.map((e) => e.id), ['p1']);
});
