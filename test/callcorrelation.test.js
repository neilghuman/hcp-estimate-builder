import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCallActivity, callDirectionToEspo, callStatusToEspo, selectCallLinks } from '../src/callcorrelation.js';

test('callStatusToEspo maps 3CX statuses to EspoCRM Call status', () => {
  assert.equal(callStatusToEspo('answered'), 'Held');
  assert.equal(callStatusToEspo('voicemail'), 'Held');
  assert.equal(callStatusToEspo('missed'), 'Not Held');
  assert.equal(callStatusToEspo('no_answer'), 'Not Held');
  assert.equal(callStatusToEspo(''), 'Not Held');
});

test('callDirectionToEspo maps direction', () => {
  assert.equal(callDirectionToEspo('inbound'), 'Inbound');
  assert.equal(callDirectionToEspo('outbound'), 'Outbound');
  assert.equal(callDirectionToEspo('internal'), 'Outbound');
});

test('selectCallLinks keeps only calls at/after the callback was scheduled', () => {
  const callback = { id: 'cb1', createdAt: '2026-09-05T12:00:00Z', dueAt: '2026-09-05T13:00:00Z' };
  const events = [
    { threecx_call_id: 'a', call_started_at: '2026-09-05T11:00:00Z' },
    { threecx_call_id: 'b', call_started_at: '2026-09-05T12:30:00Z' },
    { threecx_call_id: 'c', call_started_at: '2026-09-05T14:00:00Z' },
    { threecx_call_id: null, call_started_at: '2026-09-05T14:00:00Z' },
  ];
  const links = selectCallLinks(callback, events);
  assert.deepEqual(links.map((l) => l.callEvent.threecx_call_id), ['b', 'c']);
});

test('buildCallActivity shapes the EspoCRM Call payload with recording + callback link', () => {
  const callback = { callbackNumber: 'CB-1', owner: 'Neil Ghuman', phone: '+12065551212', contactId: 'contact-1', crmId: 'crmcb-1' };
  const ev = {
    threecx_call_id: 't1', normalized_phone: '+12065551212', direction: 'outbound', call_status: 'answered',
    call_started_at: '2026-09-05T20:00:00Z', ended_at: '2026-09-05T20:05:00Z', talk_duration: 300,
    recording_url: 'https://rec/1', transcription: 'hello world',
  };
  const call = buildCallActivity(ev, callback, { assignedUserId: 'user-1' });
  assert.equal(call.status, 'Held');
  assert.equal(call.direction, 'Outbound');
  assert.equal(call.duration, 300);
  assert.equal(call.parentType, 'Contact');
  assert.equal(call.parentId, 'contact-1');
  assert.equal(call.callbackId, 'crmcb-1');
  assert.equal(call.assignedUserId, 'user-1');
  assert.match(call.description, /Recording: https:\/\/rec\/1/);
  assert.match(call.description, /Transcript: hello world/);
});
