// Chatwoot notify — unit tests for ensureConversationForPhone (mocked fetch).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureConversationForPhone } from '../src/chatwoot.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.CHAT_FOUNDRY_CHATWOOT_BASE_URL = 'https://cw.test';
  process.env.CHAT_FOUNDRY_CHATWOOT_API_TOKEN = 'tok';
  process.env.CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID = '1';
});
afterEach(() => { globalThis.fetch = realFetch; });

function mockRoutes(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    const r = routes.find((x) => x.method === method && url.includes(x.path));
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(r ? r.res : {}) };
  };
  return calls;
}

test('ensureConversationForPhone creates a contact then a conversation when none exists', async () => {
  const calls = mockRoutes([
    { method: 'GET', path: '/contacts/search', res: { payload: [] } },
    { method: 'POST', path: '/contacts', res: { payload: { contact: { id: 55 }, contact_inbox: { source_id: 'src1' } } } },
    { method: 'GET', path: '/contacts/55/conversations', res: { payload: [] } },
    { method: 'POST', path: '/conversations', res: { id: 900 } },
  ]);
  const res = await ensureConversationForPhone('+12064581885', { inboxId: 3, name: 'Neil' });
  assert.equal(res.conversationId, 900);
  assert.equal(res.contactId, 55);
  const conv = calls.find((c) => c.method === 'POST' && c.url.includes('/conversations'));
  assert.equal(conv.body.inbox_id, 3);
  assert.equal(conv.body.contact_id, 55);
  assert.equal(conv.body.source_id, 'src1');
});

test('ensureConversationForPhone reuses an existing contact + inbox source_id', async () => {
  const calls = mockRoutes([
    { method: 'GET', path: '/contacts/search', res: { payload: [{ id: 77, contact_inboxes: [{ inbox: { id: 3 }, source_id: 'srcX' }] }] } },
    { method: 'GET', path: '/contacts/77/conversations', res: { payload: [] } },
    { method: 'POST', path: '/conversations', res: { id: 901 } },
  ]);
  const res = await ensureConversationForPhone('+12064581885', { inboxId: 3 });
  assert.equal(res.conversationId, 901);
  assert.equal(res.contactId, 77);
  // no contact creation happened
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/contacts')), false);
  const conv = calls.find((c) => c.method === 'POST' && c.url.includes('/conversations'));
  assert.equal(conv.body.source_id, 'srcX');
});

test('ensureConversationForPhone reuses the contact\'s existing conversation in the inbox (no new conversation)', async () => {
  const calls = mockRoutes([
    { method: 'GET', path: '/contacts/search', res: { payload: [{ id: 77, contact_inboxes: [{ inbox: { id: 3 }, source_id: 'srcX' }] }] } },
    // Most-recent-first, mixed inboxes; the resolver must pick the inbox-3 one and not create a new conversation.
    { method: 'GET', path: '/contacts/77/conversations', res: { payload: [
      { id: 950, inbox_id: 9, status: 'open' },
      { id: 942, inbox_id: 3, status: 'open' },
      { id: 930, inbox_id: 3, status: 'open' },
    ] } },
  ]);
  const res = await ensureConversationForPhone('+12064581885', { inboxId: 3 });
  assert.equal(res.conversationId, 942);
  assert.equal(res.contactId, 77);
  // no NEW conversation was created (the create endpoint ends with /conversations)
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/conversations')), false);
  // an already-open conversation is not reopened
  assert.equal(calls.some((c) => c.url.includes('/toggle_status')), false);
});

test('ensureConversationForPhone reopens a reused conversation that was resolved', async () => {
  const calls = mockRoutes([
    { method: 'GET', path: '/contacts/search', res: { payload: [{ id: 77, contact_inboxes: [{ inbox: { id: 3 }, source_id: 'srcX' }] }] } },
    { method: 'GET', path: '/contacts/77/conversations', res: { payload: [
      { id: 942, inbox_id: 3, status: 'resolved' },
    ] } },
  ]);
  const res = await ensureConversationForPhone('+12064581885', { inboxId: 3 });
  assert.equal(res.conversationId, 942);
  // reused (no new conversation created)
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/conversations')), false);
  // reopened via toggle_status on the reused conversation
  const reopen = calls.find((c) => c.method === 'POST' && c.url.includes('/conversations/942/toggle_status'));
  assert.ok(reopen, 'expected a toggle_status call on conversation 942');
  assert.equal(reopen.body.status, 'open');
});

test('ensureConversationForPhone requires an inbox', async () => {
  await assert.rejects(() => ensureConversationForPhone('+12064581885', {}), /inbox/i);
});
