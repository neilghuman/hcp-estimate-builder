import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCallbackCommandCenter, buildCallbackQueue, createCallbackStore, createPersistedCallbackStore, findDueCallbacks, rescheduleCallback, scheduleCallback, sendReminderForCallback, updateCallbackStatus } from '../src/callbacks.js';
import { createCallbackRecord, listCallbackRecords, updateCallbackRecord } from '../src/engagement_espocrm.js';

test('scheduleCallback requires a valid contact or phone and a due time', () => {
  assert.throws(() => scheduleCallback({ reason: 'Follow-up', dueAt: null }), /contactId/i);
  assert.throws(() => scheduleCallback({ contactId: 'c-1', phone: 'not-a-phone', dueAt: '2026-09-05T12:00:00Z' }), /valid phone/i);
  assert.throws(() => scheduleCallback({ contactId: 'c-1', phone: '+12065551212', dueAt: 'not-a-date' }), /valid dueAt/i);
  assert.throws(() => scheduleCallback({ contactId: 'c-1', owner: 'agent-42', reason: 'Follow-up', dueAt: '2026-09-05T12:00:00Z' }), /timezone/i);
});

test('scheduleCallback creates a scheduled callback with normalized values', () => {
  const callback = scheduleCallback({
    contactId: 'c-1',
    phone: '(206) 555-1212',
    dueAt: '2026-09-05T12:00:00Z',
    owner: 'agent-42',
    reason: 'Follow-up on estimate',
    source: 'chatwoot',
    timezone: 'America/Los_Angeles',
  });

  assert.equal(callback.status, 'scheduled');
  assert.equal(callback.contactId, 'c-1');
  assert.equal(callback.phone, '+12065551212');
  assert.equal(callback.owner, 'agent-42');
  assert.equal(callback.reason, 'Follow-up on estimate');
  assert.equal(callback.source, 'chatwoot');
  assert.equal(callback.timezone, 'America/Los_Angeles');
  assert.match(callback.callbackNumber, /^CB-/);
  assert.ok(callback.id);
});

test('buildCallbackQueue orders the queue by the next due callback', () => {
  const queue = buildCallbackQueue([
    { id: 'b', dueAt: '2026-09-05T11:00:00Z', status: 'scheduled' },
    { id: 'a', dueAt: '2026-09-05T09:00:00Z', status: 'scheduled' },
    { id: 'c', dueAt: '2026-09-05T09:00:00Z', status: 'completed' },
  ]);

  assert.deepEqual(queue.map((item) => item.id), ['a', 'b']);
});

test('updateCallbackStatus transitions a callback through the operating lifecycle', () => {
  const callback = scheduleCallback({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });
  const updated = updateCallbackStatus(callback, 'in_progress');
  assert.equal(updated.status, 'in_progress');
  assert.ok(updated.updatedAt);

  const completed = updateCallbackStatus({ ...updated, outcome: 'resolved' }, 'completed');
  assert.equal(completed.status, 'completed');
});

test('callback store keeps the queue and status transitions in a single owner', () => {
  const store = createCallbackStore();
  const scheduled = store.create({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });
  const queue = store.listScheduled();

  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, scheduled.id);

  const updated = store.updateStatus(scheduled.id, 'in_progress');
  assert.equal(updated.status, 'in_progress');
  assert.equal(store.get(scheduled.id).status, 'in_progress');
});

test('findDueCallbacks returns the scheduled items that are due now or overdue', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const callbacks = [
    { id: 'due', status: 'scheduled', dueAt: '2026-09-05T11:30:00Z' },
    { id: 'future', status: 'scheduled', dueAt: '2026-09-05T12:30:00Z' },
    { id: 'done', status: 'completed', dueAt: '2026-09-05T09:00:00Z' },
  ];

  assert.deepEqual(findDueCallbacks(callbacks, now).map((item) => item.id), ['due']);
});

test('sendReminderForCallback records a reminder payload without re-triggering for a sent reminder', () => {
  const callback = { id: 'cb-1', status: 'scheduled', dueAt: '2026-09-05T12:00:00Z', phone: '+12065551212', owner: 'agent-42' };
  const first = sendReminderForCallback(callback);
  const second = sendReminderForCallback({ ...callback, reminderSentAt: first.reminderSentAt });

  assert.equal(first.status, 'reminder_sent');
  assert.equal(first.channel, 'sms');
  assert.ok(first.reminderSentAt);
  assert.equal(second.status, 'already_reminded');
});

test('callback store can filter by owner and complete with an outcome', () => {
  const store = createCallbackStore();
  const first = store.create({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });
  const second = store.create({ contactId: 'c-2', phone: '206-555-1213', dueAt: '2026-09-05T12:05:00Z', owner: 'agent-99', reason: 'Check-in', timezone: 'America/Los_Angeles' });

  const ownerQueue = store.listByOwner('agent-42');
  assert.equal(ownerQueue.length, 1);
  assert.equal(ownerQueue[0].id, first.id);

  const completed = store.complete(second.id, 'resolved');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome, 'resolved');
});

test('persisted callback store round-trips records through a db-backed adapter', async () => {
  const rows = new Map();
  const pool = {
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO callback_records')) {
        const id = String(params[0]);
        if (params.length === 14) {
          rows.set(id, {
            id,
            callback_number: params[1],
            contact_id: params[2],
            phone: params[3],
            due_at: params[4],
            timezone: params[5],
            owner: params[6],
            reason: params[7],
            source: params[8],
            status: params[9],
            rescheduled_from_callback_id: params[10],
            created_at: params[11],
            updated_at: params[12],
            payload: JSON.parse(params[13] || '{}'),
          });
          return { rows: [{ id }] };
        }
        rows.set(id, {
          id,
          callback_number: params[1],
          contact_id: params[2],
          phone: params[3],
          due_at: params[4],
          timezone: params[5],
          owner: params[6],
          reason: params[7],
          source: params[8],
          status: params[9],
          outcome: params[10],
          reminder_sent_at: params[11],
          rescheduled_to_callback_id: params[12],
          rescheduled_from_callback_id: params[13],
          completed_at: params[14],
          completed_by: params[15],
          crm_id: null,
          created_at: params[16],
          updated_at: params[17],
          payload: JSON.parse(params[18] || '{}'),
        });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('SELECT * FROM callback_records WHERE owner = $1')) {
        return { rows: [...rows.values()].filter((row) => row.owner === params[0]) };
      }
      if (sql.startsWith('SELECT * FROM callback_records WHERE id = $1')) {
        const row = rows.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE callback_records SET')) {
        const id = String(params[0]);
        const current = rows.get(id) || {};
        if (sql.includes('crm_id = $2')) {
          rows.set(id, { ...current, id, crm_id: params[1], updated_at: params[2] });
          return { rows: [{ id }] };
        }
        if (sql.includes('rescheduled_to_callback_id = $3')) {
          rows.set(id, { ...current, id, status: params[1], rescheduled_to_callback_id: params[2], updated_at: params[3] });
          return { rows: [{ id }] };
        }
        rows.set(id, {
          ...current,
          id,
          owner: params[1] ?? current.owner,
          reminder_sent_at: params[1] ?? current.reminder_sent_at,
          status: params[1] ?? current.status,
          outcome: params[2] ?? current.outcome,
          updated_at: params[3] ?? current.updated_at,
        });
        return { rows: [{ id }] };
      }
      return { rows: [] };
    },
  };

  const store = createPersistedCallbackStore({ pool, table: 'callback_records' });
  const created = await store.create({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });

  assert.equal(created.owner, 'agent-42');
  assert.equal((await store.listByOwner('agent-42')).length, 1);
  const fetched = await store.get(created.id);
  assert.equal(fetched.id, created.id);
  const crmLinked = await store.setCrmId(created.id, 'crm-cb-1');
  assert.equal(crmLinked.crmId, 'crm-cb-1');
  assert.equal((await store.get(created.id)).crmId, 'crm-cb-1');
  const updated = await store.complete(created.id, 'resolved');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.outcome, 'resolved');
  assert.equal(updated.completedBy, 'agent-42');
  assert.ok(updated.completedAt);
});

test('persisted callback store reschedules as linked records', async () => {
  const rows = new Map();
  const pool = {
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO callback_records')) {
        const id = String(params[0]);
        rows.set(id, {
          id,
          callback_number: params[1],
          contact_id: params[2],
          phone: params[3],
          due_at: params[4],
          timezone: params[5],
          owner: params[6],
          reason: params[7],
          source: params[8],
          status: params[9],
          rescheduled_to_callback_id: params.length === 14 ? null : params[12],
          rescheduled_from_callback_id: params.length === 14 ? params[10] : params[13],
          created_at: params.length === 14 ? params[11] : params[16],
          updated_at: params.length === 14 ? params[12] : params[17],
        });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('SELECT * FROM callback_records WHERE id = $1')) {
        const row = rows.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE callback_records SET status = $2, rescheduled_to_callback_id = $3')) {
        const current = rows.get(String(params[0]));
        rows.set(String(params[0]), { ...current, status: params[1], rescheduled_to_callback_id: params[2], updated_at: params[3] });
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    },
  };
  const store = createPersistedCallbackStore({ pool });
  const created = await store.create({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });
  const result = await store.reschedule(created.id, { dueAt: '2026-09-06T12:00:00Z' });

  assert.equal((await store.get(created.id)).rescheduledToCallbackId, result.replacement.id);
  assert.equal((await store.get(result.replacement.id)).rescheduledFromCallbackId, created.id);
});

test('rescheduling preserves the original callback and creates a linked replacement', () => {
  const callback = scheduleCallback({ contactId: 'c-1', phone: '206-555-1212', dueAt: '2026-09-05T12:00:00Z', owner: 'agent-42', reason: 'Follow-up', timezone: 'America/Los_Angeles' });
  const result = rescheduleCallback(callback, { dueAt: '2026-09-06T12:00:00Z' });

  assert.equal(result.previous.status, 'rescheduled');
  assert.equal(result.previous.rescheduledToCallbackId, result.replacement.id);
  assert.equal(result.replacement.rescheduledFromCallbackId, callback.id);
  assert.equal(result.replacement.owner, callback.owner);
});

test('command center separates upcoming, due-soon, overdue, and exception work', () => {
  const dashboard = buildCallbackCommandCenter([
    { id: 'soon', owner: 'agent-42', status: 'scheduled', dueAt: '2026-09-05T12:10:00Z' },
    { id: 'later', owner: 'agent-42', status: 'scheduled', dueAt: '2026-09-05T18:00:00Z' },
    { id: 'late', owner: 'agent-42', status: 'overdue', dueAt: '2026-09-05T11:00:00Z' },
  ], '2026-09-05T12:00:00Z');

  assert.deepEqual(dashboard.dueSoon.map((callback) => callback.id), ['soon']);
  assert.deepEqual(dashboard.upcoming.map((callback) => callback.id), ['soon', 'later']);
  assert.deepEqual(dashboard.overdue.map((callback) => callback.id), ['late']);
  assert.deepEqual(dashboard.exceptions.map((callback) => callback.id), ['late']);
});

test('EspoCRM callback adapter creates and lists callback records', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/api/v1/Callback') && init.method === 'POST') {
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 'cb-crm-1', status: 'scheduled', owner: 'agent-42', phone: '+12065551212' }),
      };
    }
    if (String(url).includes('/api/v1/Callback/') && init.method === 'PUT') {
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 'cb-crm-1', status: init.body ? JSON.parse(init.body).status || 'scheduled' : 'scheduled', owner: init.body ? JSON.parse(init.body).owner || 'agent-42' : 'agent-42', phone: '+12065551212' }),
      };
    }
    if (String(url).includes('/api/v1/Callback?')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ list: [{ id: 'cb-crm-1', status: 'scheduled', owner: 'agent-42', phone: '+12065551212' }], total: 1 }),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    process.env.ENGAGEMENT_ESPOCRM_BASE_URL = 'https://crm.test';
    process.env.ENGAGEMENT_ESPOCRM_API_KEY = 'reader-key';
    process.env.ENGAGEMENT_ESPOCRM_WRITER_API_KEY = 'writer-key';

    const created = await createCallbackRecord({
      contactId: 'c-1',
      phone: '+12065551212',
      dueAt: '2026-09-05T12:00:00Z',
      owner: 'agent-42',
      reason: 'Follow-up',
      status: 'scheduled',
    });

    assert.equal(created.id, 'cb-crm-1');
    assert.equal(created.owner, 'agent-42');

    const updated = await updateCallbackRecord('cb-crm-1', { owner: 'agent-99', status: 'completed', outcome: 'resolved' });
    assert.equal(updated.owner, 'agent-99');
    assert.equal(updated.status, 'completed');

    const rows = await listCallbackRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phone, '+12065551212');
    assert.equal(calls[0].method, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
