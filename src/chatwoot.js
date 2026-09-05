// Chat Foundry — backend-only Chatwoot client.
// NEVER import this from frontend code. The API token stays server-side and is never logged.
//
// Config (env, all dedicated to Chat Foundry so the existing general-purpose token is untouched):
//   CHAT_FOUNDRY_CHATWOOT_BASE_URL   e.g. https://chat.unitedservicesnorthwest.com
//   CHAT_FOUNDRY_CHATWOOT_API_TOKEN  dedicated token (dev may use the existing token via env only)
//   CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID discovered via /api/chat-foundry/accounts, then stored in env

export class ChatwootError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ChatwootError';
    this.status = status;
  }
}

function cfg() {
  return {
    base: String(process.env.CHAT_FOUNDRY_CHATWOOT_BASE_URL || '').replace(/\/$/, ''),
    token: process.env.CHAT_FOUNDRY_CHATWOOT_API_TOKEN || '',
    accountId: String(process.env.CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID || '').trim(),
  };
}

export function chatwootConfigured() {
  const c = cfg();
  return Boolean(c.base && c.token);
}

// Non-secret status for the UI/config endpoint. Never returns the token itself.
export function chatwootStatus() {
  const c = cfg();
  return {
    baseUrl: c.base || null,
    tokenPresent: Boolean(c.token),
    accountId: c.accountId || null,
    configured: Boolean(c.base && c.token),
  };
}

async function cwFetch(pathname, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  const c = cfg();
  if (!c.base || !c.token) {
    throw new ChatwootError('Chat Foundry Chatwoot is not configured (base URL or API token missing).', 503);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${c.base}${pathname}`, {
      method,
      headers: { api_access_token: c.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ChatwootError(e.name === 'AbortError' ? 'Chatwoot request timed out.' : `Chatwoot unreachable: ${e.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new ChatwootError('Chatwoot authentication failed — check CHAT_FOUNDRY_CHATWOOT_API_TOKEN.', 502);
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const detail = data && (data.message || data.error) ? `: ${data.message || data.error}` : '';
    throw new ChatwootError(`Chatwoot API error ${resp.status}${detail}`, 502);
  }
  return data;
}

function requireAccount() {
  const c = cfg();
  if (!c.accountId) {
    throw new ChatwootError('CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID is not set. Discover it via GET /api/chat-foundry/accounts and add it to .env.', 400);
  }
  return c.accountId;
}

// Connectivity + auth check (also reports how many accounts the token can see).
export async function ping() {
  const prof = await cwFetch('/api/v1/profile');
  const accounts = (prof && prof.accounts) || [];
  return { ok: true, user: prof ? { name: prof.name || null, email: prof.email || null } : null, accountCount: accounts.length };
}

// Accounts visible to the token — used to discover the account_id to store in env.
export async function listAccounts() {
  const prof = await cwFetch('/api/v1/profile');
  const accounts = (prof && prof.accounts) || [];
  return accounts.map((a) => ({ id: a.id, name: a.name || null, role: a.role || null }));
}

export async function listInboxes() {
  const acc = requireAccount();
  const data = await cwFetch(`/api/v1/accounts/${acc}/inboxes`);
  const payload = (data && data.payload) || [];
  return payload.map((i) => ({ id: i.id, name: i.name || null, channel_type: i.channel_type || null }));
}

// Account agents, briefly cached. Used to resolve a callback owner's email server-side.
let _agentsCache = { at: 0, agents: [] };
export async function listAgents({ ttlMs = 60_000 } = {}) {
  const acc = requireAccount();
  if (Date.now() - _agentsCache.at < ttlMs && _agentsCache.agents.length) return _agentsCache.agents;
  const data = await cwFetch(`/api/v1/accounts/${acc}/agents`);
  const list = Array.isArray(data) ? data : (data && data.payload) || [];
  const agents = list.map((a) => ({ id: a.id, name: a.name || null, email: a.email || null }));
  _agentsCache = { at: Date.now(), agents };
  return agents;
}

// Chatwoot "labels" are Chat Foundry "tags". Endpoint returns objects; older versions return strings.
export async function listLabels() {
  const acc = requireAccount();
  const data = await cwFetch(`/api/v1/accounts/${acc}/labels`);
  const payload = (data && data.payload) || [];
  return payload.map((l) => (typeof l === 'string'
    ? { id: null, title: l, color: null }
    : { id: l.id ?? null, title: l.title ?? String(l), color: l.color ?? null }));
}

// One page of conversations from Chatwoot's list endpoint, filtered by status/inbox at the API level.
// Response shape is { data: { meta, payload } } (older/newer variants tolerated).
export async function listConversations({ status = 'open', inboxId = null, assigneeType = null, page = 1 } = {}) {
  const acc = requireAccount();
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (inboxId) params.set('inbox_id', String(inboxId));
  if (assigneeType) params.set('assignee_type', assigneeType);
  params.set('page', String(page));
  const raw = await cwFetch(`/api/v1/accounts/${acc}/conversations?${params.toString()}`);
  const d = raw && raw.data ? raw.data : raw;
  return { conversations: (d && d.payload) || [], meta: (d && d.meta) || {} };
}

// Flatten a Chatwoot conversation into the fields Chat Foundry needs for the audience preview.
export function normalizeConversation(c) {
  const meta = c.meta || {};
  const sender = meta.sender || {};
  const assignee = meta.assignee || null;
  const labels = Array.isArray(c.labels) ? c.labels : (Array.isArray(meta.labels) ? meta.labels : []);
  return {
    conversation_id: c.id,
    inbox_id: c.inbox_id ?? null,
    status: c.status ?? null,
    contact_id: sender.id ?? null,
    contact_name: sender.name ?? null,
    contact_identifier: sender.identifier ?? null,
    phone: sender.phone_number ?? null,
    email: sender.email ?? null,
    labels,
    assignee: assignee ? (assignee.name || assignee.email || null) : null,
    last_activity_at: c.last_activity_at ?? c.timestamp ?? null,
  };
}

// Fetch a single conversation (used to re-check status/inbox right before a send).
export async function getConversation(conversationId) {
  const acc = requireAccount();
  const raw = await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}`);
  const d = raw && raw.data ? raw.data : raw;
  return d || null;
}

// Post an OUTGOING message into a conversation. This is the only Chat Foundry call that causes a
// customer-facing message (delivered by the existing n8n Telnyx/Thumbtack outbound relays).
// Returns { id, content } for the created message; the id is stored as the idempotency key.
// Reopen a resolved/snoozed conversation so a newly-added message is visible to agents.
// Non-fatal by design: a failure here must never block the actual message send.
export async function reopenConversation(conversationId) {
  const acc = requireAccount();
  try {
    await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/toggle_status`, {
      method: 'POST',
      body: { status: 'open' },
    });
    return true;
  } catch {
    return false;
  }
}

export async function sendMessage(conversationId, content) {
  const acc = requireAccount();
  const text = String(content || '').trim();
  if (!text) throw new ChatwootError('Cannot send an empty message.', 400);
  const data = await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/messages`, {
    method: 'POST',
    body: { content: text, message_type: 'outgoing', private: false },
  });
  return { id: data && (data.id ?? (data.data && data.data.id)) ? (data.id ?? data.data.id) : null, content: text };
}

// Fetch a conversation's messages (drip sweep uses this to detect human replies).
export async function getConversationMessages(conversationId) {
  const acc = requireAccount();
  const raw = await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/messages`);
  return (raw && (raw.payload || (raw.data && raw.data.payload))) || [];
}

// Post an internal-only private note (never delivered to the customer). Used for
// employee-facing callback reminders on the conversation.
export async function postPrivateNote(conversationId, content) {
  const acc = requireAccount();
  const text = String(content || '').trim();
  if (!text) throw new ChatwootError('Cannot post an empty private note.', 400);
  const data = await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/messages`, {
    method: 'POST',
    body: { content: text, message_type: 'outgoing', private: true, content_attributes: { automation: 'callback-reminder' } },
  });
  return { id: data && (data.id ?? (data.data && data.data.id)) ? (data.id ?? data.data.id) : null, content: text };
}

// Replace a conversation's labels (Chatwoot's labels API sets the full list).
export async function setConversationLabels(conversationId, labels) {
  const acc = requireAccount();
  await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/labels`, {
    method: 'POST',
    body: { labels: Array.isArray(labels) ? labels : [] },
  });
  return true;
}

// Post an outgoing message tagged as an automated drip send. The tag
// (content_attributes.automation) lets the sweep tell its own sends apart from a human reply.
export async function postDripMessage(conversationId, content, { step } = {}) {
  const acc = requireAccount();
  const text = String(content || '').trim();
  if (!text) throw new ChatwootError('Cannot send an empty message.', 400);
  const data = await cwFetch(`/api/v1/accounts/${acc}/conversations/${Number(conversationId)}/messages`, {
    method: 'POST',
    body: { content: text, message_type: 'outgoing', private: false, content_attributes: { automation: 'drip', step } },
  });
  return { id: data && (data.id ?? (data.data && data.data.id)) ? (data.id ?? data.data.id) : null, content: text };
}

// Find-or-create a conversation to a phone number in the given inbox, returning its id.
// Used for proactive notifications (e.g. texting the office). Delivery is handled by the existing
// n8n Telnyx outbound relay once an outgoing message is posted to the conversation.
export async function ensureConversationForPhone(phoneNumber, { inboxId, name } = {}) {
  const acc = requireAccount();
  const inbox = Number(inboxId);
  if (!inbox) throw new ChatwootError('No Chatwoot inbox configured for notifications (INTAKE_NOTIFY_INBOX_ID).', 400);
  const phone = String(phoneNumber || '').trim();
  if (!phone) throw new ChatwootError('A phone number is required.', 400);

  // 1) Find an existing contact by phone.
  const search = await cwFetch(`/api/v1/accounts/${acc}/contacts/search?q=${encodeURIComponent(phone)}`);
  const found = (search && (search.payload || (search.data && search.data.payload))) || [];
  let contact = found[0] || null;
  let sourceId = null;

  if (contact) {
    const ci = (contact.contact_inboxes || []).find((x) => Number((x.inbox && x.inbox.id) ?? x.inbox_id) === inbox);
    sourceId = ci && ci.source_id ? ci.source_id : null;
    if (!sourceId) {
      const made = await cwFetch(`/api/v1/accounts/${acc}/contacts/${contact.id}/contact_inboxes`, { method: 'POST', body: { inbox_id: inbox } });
      sourceId = (made && (made.source_id || (made.payload && made.payload.source_id))) || null;
    }
  } else {
    // 2) Create the contact in the inbox (Chatwoot returns a contact_inbox with a source_id).
    const created = await cwFetch(`/api/v1/accounts/${acc}/contacts`, { method: 'POST', body: { inbox_id: inbox, name: name || phone, phone_number: phone } });
    const payload = (created && (created.payload || created.data)) || created || {};
    contact = payload.contact || payload;
    const ci = payload.contact_inbox || (contact.contact_inboxes && contact.contact_inboxes[0]) || null;
    sourceId = ci && ci.source_id ? ci.source_id : null;
  }

  // 3) Reuse the contact's existing conversation in this inbox if one exists; otherwise open a new
  //    one. SMS is a single thread per phone number, so posting each outbound message to a brand-new
  //    conversation would fragment the thread. Matches the inbound Telnyx->Chatwoot relay, which
  //    threads incoming messages into the most recent conversation for the contact in this inbox.
  let cid = null;
  try {
    const list = await cwFetch(`/api/v1/accounts/${acc}/contacts/${contact.id}/conversations`);
    const convs = (list && (list.payload || (list.data && list.data.payload))) || [];
    const existing = convs.find((c) => Number(c.inbox_id) === inbox);
    cid = existing ? existing.id : null;
    // A reused conversation that was resolved should reopen now that we're adding a new message
    // (phone/SMS threads only — Thumbtack is handled by separate n8n workflows and is untouched).
    if (existing && existing.status === 'resolved') {
      await reopenConversation(cid);
    }
  } catch {
    // Non-fatal: fall through to creating a new conversation if the lookup fails.
  }

  if (!cid) {
    const conv = await cwFetch(`/api/v1/accounts/${acc}/conversations`, {
      method: 'POST',
      body: { inbox_id: inbox, contact_id: contact.id, source_id: sourceId },
    });
    cid = conv && (conv.id ?? (conv.payload && conv.payload.id) ?? (conv.data && conv.data.id));
  }
  return { conversationId: cid, contactId: contact.id };
}


