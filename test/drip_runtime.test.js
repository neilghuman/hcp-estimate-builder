// Drip runtime service — unit tests with a mock pool (no real DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollLead, resolveNextMessage, dripConfig } from '../src/drip_runtime.js';

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const h of handlers) if (h.match.test(sql)) return h.rows(params);
      return { rows: [] };
    },
  };
}

const SEQ_ROW = {
  id: 5, max_messages: 7, expires_after_hours: 168,
  quiet_start_local: '08:00', quiet_end_local: '20:00', tz_default: 'America/Los_Angeles',
};

test('enrollLead: suppressed phone is not enrolled', async () => {
  const pool = mockPool([
    { match: /FROM drip_suppression/, rows: () => ({ rows: [{ x: 1 }] }) },
  ]);
  const res = await enrollLead(pool, { leadRef: 'c1', source: 'google_lsa', vertical: 'tree', phone: '+12065550100', t0: '2026-08-14T18:00:00Z' });
  assert.equal(res.status, 'suppressed');
});

test('enrollLead: happy path enrolls, maps category, computes next_due', async () => {
  const pool = mockPool([
    { match: /FROM drip_suppression/, rows: () => ({ rows: [] }) },
    { match: /FROM drip_sequence\s+WHERE/, rows: () => ({ rows: [SEQ_ROW] }) },
    { match: /FROM drip_step/, rows: () => ({ rows: [{ offset_minutes: 30 }] }) },
    { match: /FROM drip_category_map/, rows: () => ({ rows: [{ category_key: 'stump_grinding', source: 'thumbtack', raw_value: 'Tree Stump Grinding and Removal' }] }) },
    { match: /INSERT INTO drip_enrollment/, rows: () => ({ rows: [{ id: 99 }] }) },
  ]);
  const res = await enrollLead(pool, {
    leadRef: 'c2', source: 'thumbtack', vertical: 'tree', phone: '+12065550101', firstName: 'Sarah',
    categoryRaw: 'Tree Stump Grinding and Removal', t0: '2026-08-14T18:00:00Z', // 11:00 PDT
  });
  assert.equal(res.status, 'enrolled');
  assert.equal(res.enrollmentId, 99);
  assert.equal(res.categoryKey, 'stump_grinding');
  assert.ok(res.nextDueAt); // +30m, inside contact hours -> ~11:30 PDT
  const insert = pool.calls.find((c) => /INSERT INTO drip_enrollment/.test(c.sql));
  assert.ok(insert.params.includes('Sarah')); // first_name captured
});

test('enrollLead: no matching sequence', async () => {
  const pool = mockPool([
    { match: /FROM drip_suppression/, rows: () => ({ rows: [] }) },
    { match: /FROM drip_sequence\s+WHERE/, rows: () => ({ rows: [] }) },
  ]);
  const res = await enrollLead(pool, { leadRef: 'c3', source: 'x', vertical: 'y', phone: '+12065550102', t0: '2026-08-14T18:00:00Z' });
  assert.equal(res.status, 'no_sequence');
});

test('enrollLead: duplicate (ON CONFLICT no row) reports exists', async () => {
  const pool = mockPool([
    { match: /FROM drip_suppression/, rows: () => ({ rows: [] }) },
    { match: /FROM drip_sequence\s+WHERE/, rows: () => ({ rows: [SEQ_ROW] }) },
    { match: /FROM drip_step/, rows: () => ({ rows: [{ offset_minutes: 30 }] }) },
    { match: /INSERT INTO drip_enrollment/, rows: () => ({ rows: [] }) },
  ]);
  const res = await enrollLead(pool, { leadRef: 'c4', source: 'google_lsa', vertical: 'landscaping', phone: '+12065550103', t0: '2026-08-14T18:00:00Z' });
  assert.equal(res.status, 'exists');
});

test('enrollLead: missing required fields is invalid', async () => {
  const pool = mockPool([]);
  assert.equal((await enrollLead(pool, { source: 'google_lsa' })).status, 'invalid');
});

test('resolveNextMessage: picks the category-specific variant', async () => {
  const pool = mockPool([
    { match: /variant_strategy FROM drip_sequence/, rows: () => ({ rows: [{ variant_strategy: 'random' }] }) },
    { match: /FROM drip_message/, rows: () => ({ rows: [
      { category_key: null, variant: 'A', body: 'default', weight: 1, is_active: true },
      { category_key: 'stump_grinding', variant: 'A', body: 'stump specific', weight: 1, is_active: true },
    ] }) },
  ]);
  const msg = await resolveNextMessage(pool, { sequence_id: 5, step: 1, category_key: 'stump_grinding' });
  assert.equal(msg.body, 'stump specific');
});

test('dripConfig: sends and writes default OFF', () => {
  const prev = { w: process.env.DRIP_WRITE_ENABLED, s: process.env.DRIP_SEND_ENABLED };
  delete process.env.DRIP_WRITE_ENABLED;
  delete process.env.DRIP_SEND_ENABLED;
  try {
    const c = dripConfig();
    assert.equal(c.writeEnabled, false);
    assert.equal(c.sendEnabled, false);
    assert.equal(c.enabled, true);
  } finally {
    if (prev.w !== undefined) process.env.DRIP_WRITE_ENABLED = prev.w;
    if (prev.s !== undefined) process.env.DRIP_SEND_ENABLED = prev.s;
  }
});
