import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReminderNote, conversationIdFromSource, selectDueReminders } from '../src/reminders.js';

test('conversationIdFromSource extracts the numeric id only from conversation sources', () => {
  assert.equal(conversationIdFromSource('chatwoot:conversation:60'), '60');
  assert.equal(conversationIdFromSource('chatwoot:conversation:abc'), null);
  assert.equal(conversationIdFromSource('housecall_pro:customer:9'), null);
  assert.equal(conversationIdFromSource(''), null);
  assert.equal(conversationIdFromSource(null), null);
});

test('selectDueReminders returns open, un-reminded, conversation-linked callbacks within the lead time', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const lead = 15 * 60 * 1000;
  const callbacks = [
    { id: 'due-soon', status: 'scheduled', source: 'chatwoot:conversation:1', reminderSentAt: null, dueAt: '2026-09-05T12:10:00Z' },
    { id: 'overdue', status: 'overdue', source: 'chatwoot:conversation:2', reminderSentAt: null, dueAt: '2026-09-05T11:00:00Z' },
    { id: 'too-far', status: 'scheduled', source: 'chatwoot:conversation:3', reminderSentAt: null, dueAt: '2026-09-05T13:00:00Z' },
    { id: 'already', status: 'scheduled', source: 'chatwoot:conversation:4', reminderSentAt: '2026-09-05T11:59:00Z', dueAt: '2026-09-05T12:05:00Z' },
    { id: 'completed', status: 'completed', source: 'chatwoot:conversation:5', reminderSentAt: null, dueAt: '2026-09-05T12:05:00Z' },
    { id: 'no-conv', status: 'scheduled', source: 'housecall_pro:customer:6', reminderSentAt: null, dueAt: '2026-09-05T12:05:00Z' },
  ];
  const due = selectDueReminders(callbacks, now, lead);
  assert.deepEqual(due.map((c) => c.id), ['overdue', 'due-soon']);
});

test('buildReminderNote includes customer, owner, reason and callback number', () => {
  const note = buildReminderNote({
    callbackNumber: 'CB-ABC',
    phone: '+12065551212',
    owner: 'Neil Ghuman',
    reason: 'Follow-up on estimate',
    dueAt: '2026-09-05T20:00:00Z',
  });
  assert.match(note, /Callback due/);
  assert.match(note, /\+12065551212/);
  assert.match(note, /Neil Ghuman/);
  assert.match(note, /Follow-up on estimate/);
  assert.match(note, /\[CB-ABC\]/);
});
