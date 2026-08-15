// Drip sweep — unit tests. Pure planners + sweepOnce with mock pool + mock chatwoot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStep, planAfterSend, sweepOnce } from '../src/drip_sweep.js';

const NOON_PDT = new Date('2026-08-14T19:00:00Z'); // 12:00 America/Los_Angeles
const SEQ = { tz_default: 'America/Los_Angeles', quiet_start_local: '08:00', quiet_end_local: '20:00' };

const baseEnrollment = {
  id: 1, sequence_id: 5, lead_ref: 'c1', conversation_id: '900', vertical: 'tree',
  phone_e164: '+12065550100', category_key: 'stump_grinding', time_zone: 'America/Los_Angeles',
  step: 1, t0_at: '2026-08-14T18:00:00Z', attempts: 1, max_messages: 7,
  expires_at: '2026-08-21T18:00:00Z', status: 'active',
};
const openConv = { status: 'open', labels: ['A_pending_callback'], messages: [{ message_type: 1, private: false, content_attributes: { automation: 'drip' } }] };

test('planStep: suppressed exits', () => {
  assert.deepEqual(planStep(baseEnrollment, { conv: openConv, suppressed: true, now: NOON_PDT, sequence: SEQ }), { action: 'exit', reason: 'suppressed' });
});

test('planStep: expired exits', () => {
  const e = { ...baseEnrollment, expires_at: '2026-08-14T00:00:00Z' };
  assert.equal(planStep(e, { conv: openConv, now: NOON_PDT, sequence: SEQ }).reason, 'expired');
});

test('planStep: max_reached exits', () => {
  const e = { ...baseEnrollment, attempts: 7 };
  assert.equal(planStep(e, { conv: openConv, now: NOON_PDT, sequence: SEQ }).reason, 'max_reached');
});

test('planStep: human reply exits', () => {
  const conv = { status: 'open', labels: ['A_pending_callback'], messages: [{ message_type: 0 }] };
  assert.equal(planStep(baseEnrollment, { conv, now: NOON_PDT, sequence: SEQ }).reason, 'human_response');
});

test('planStep: outside contact hours defers', () => {
  const midnight = new Date('2026-08-14T08:00:00Z'); // 01:00 PDT
  const d = planStep(baseEnrollment, { conv: openConv, now: midnight, sequence: SEQ });
  assert.equal(d.action, 'defer');
  assert.ok(new Date(d.nextDueAt) > midnight);
});

test('planStep: inside hours + no stop = send', () => {
  assert.deepEqual(planStep(baseEnrollment, { conv: openConv, now: NOON_PDT, sequence: SEQ }), { action: 'send' });
});

const STEPS = [
  { step_index: 1, offset_minutes: 30, is_active: true },
  { step_index: 2, offset_minutes: 120, is_active: true },
];

test('planAfterSend: advances to the next active step', () => {
  const r = planAfterSend(baseEnrollment, { steps: STEPS, now: NOON_PDT, sequence: SEQ });
  assert.equal(r.status, 'active');
  assert.equal(r.step, 2);
  assert.ok(r.nextDueAt);
});

test('planAfterSend: no next step completes (sequence_end)', () => {
  const e = { ...baseEnrollment, step: 2 };
  assert.deepEqual(planAfterSend(e, { steps: STEPS, now: NOON_PDT, sequence: SEQ }), { status: 'completed', reason: 'sequence_end' });
});

test('planAfterSend: hitting max completes', () => {
  const e = { ...baseEnrollment, attempts: 6 }; // +1 = 7 = max
  assert.equal(planAfterSend(e, { steps: STEPS, now: NOON_PDT, sequence: SEQ }).reason, 'max_reached');
});

// ---- sweepOnce with mocks ----

function mockPool(routes) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const r of routes) if (r.match.test(sql)) return r.rows(params);
      return { rows: [] };
    },
  };
}

function sweepRoutes(enrollment) {
  return [
    { match: /FROM drip_enrollment\s+WHERE status = 'active'/, rows: () => ({ rows: [enrollment] }) },
    { match: /FROM drip_suppression/, rows: () => ({ rows: [] }) },
    { match: /variant_strategy FROM drip_sequence/, rows: () => ({ rows: [{ variant_strategy: 'random' }] }) },
    { match: /FROM drip_sequence WHERE id/, rows: () => ({ rows: [{ ...SEQ, max_messages: 7, expires_after_hours: 168 }] }) },
    { match: /FROM drip_message/, rows: () => ({ rows: [{ category_key: 'stump_grinding', variant: 'A', body: 'Hi {name}, {service}.', weight: 1, is_active: true }] }) },
    { match: /INSERT INTO drip_delivery_log/, rows: () => ({ rows: [{ id: 1 }] }) },
    { match: /FROM drip_step WHERE sequence_id/, rows: () => ({ rows: STEPS }) },
    { match: /UPDATE drip_/, rows: () => ({ rows: [] }) },
  ];
}

test('sweepOnce dryRun reports would_send without sending or claiming', async () => {
  const pool = mockPool(sweepRoutes(baseEnrollment));
  const chatwoot = { getSnapshot: async () => openConv, send: async () => { throw new Error('should not send'); }, removeLabel: async () => {} };
  const res = await sweepOnce(pool, { chatwoot, now: NOON_PDT, dryRun: true });
  assert.equal(res[0].action, 'would_send');
  assert.equal(pool.calls.some((c) => /INSERT INTO drip_delivery_log/.test(c.sql)), false);
});

test('sweepOnce sends, marks delivery, advances', async () => {
  const pool = mockPool(sweepRoutes(baseEnrollment));
  let sent = null;
  const chatwoot = { getSnapshot: async () => openConv, send: async (cid, body, step) => { sent = { cid, body, step }; return { id: 'm1' }; }, removeLabel: async () => {} };
  const res = await sweepOnce(pool, { chatwoot, now: NOON_PDT, dryRun: false });
  assert.equal(res[0].action, 'sent');
  assert.equal(sent.cid, '900');
  assert.equal(sent.body, 'Hi there, stump grinding.'); // rendered
  assert.ok(pool.calls.some((c) => /UPDATE drip_delivery_log/.test(c.sql)));
});

test('sweepOnce exits + removes label on human reply', async () => {
  const conv = { status: 'open', labels: ['A_pending_callback'], messages: [{ message_type: 0 }] };
  const pool = mockPool(sweepRoutes(baseEnrollment));
  let removed = false;
  const chatwoot = { getSnapshot: async () => conv, send: async () => { throw new Error('no'); }, removeLabel: async () => { removed = true; } };
  const res = await sweepOnce(pool, { chatwoot, now: NOON_PDT, dryRun: false });
  assert.equal(res[0].action, 'exit');
  assert.equal(res[0].reason, 'human_response');
  assert.equal(removed, true);
});

test('sweepOnce skips when the conversation snapshot cannot be read', async () => {
  const pool = mockPool(sweepRoutes(baseEnrollment));
  const chatwoot = { getSnapshot: async () => null, send: async () => ({ id: 'x' }), removeLabel: async () => {} };
  const res = await sweepOnce(pool, { chatwoot, now: NOON_PDT, dryRun: false });
  assert.equal(res[0].action, 'skip_no_snapshot');
});
