let conversationId = new URLSearchParams(location.search).get('conversationId');
let currentAgent = null;
const form = document.querySelector('#form');
const message = document.querySelector('#message');
function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let idempotencyKey = newIdempotencyKey();

function show(text, kind = '') { message.textContent = text; message.className = `message ${kind}`; }
function fmt(value) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function apiPath(path) {
  return location.pathname.startsWith('/callback-panel/') ? `/callback-panel${path}` : path;
}

function dashboardContext(event) {
  try {
    const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (message?.event !== 'appContext') return;
    const data = message.data || {};
    conversationId = String(data.conversation?.id || '');
    currentAgent = data.currentAgent || null;
    load().catch((error) => show(error.message, 'error'));
  } catch { /* Ignore unrelated postMessage traffic. */ }
}

window.addEventListener('message', dashboardContext);
if (window.parent !== window) window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*');

async function load() {
  if (!conversationId || !/^\d+$/.test(conversationId)) { show('Open this panel from a Chatwoot conversation.', 'error'); return; }
  if (!currentAgent?.id || !(currentAgent.name || currentAgent.email)) { show('Loading Chatwoot agent context...', ''); return; }
  const params = new URLSearchParams({ agentId: currentAgent.id, agentName: currentAgent.name || currentAgent.email });
  const data = await request(apiPath(`/api/engagement/callback-panel/${conversationId}?${params}`));
  document.querySelector('#customer').textContent = [data.customer.name, data.customer.phone, data.customer.email].filter(Boolean).join(' | ') || 'Unnamed customer';
  if (data.crmUrl) { const link = document.querySelector('#crmLink'); link.href = data.crmUrl; link.hidden = false; }
  if (data.identity.outcome === 'net_new') {
    document.querySelector('#customerNameField').hidden = false;
    document.querySelector('#firstName').required = true;
    document.querySelector('#lastName').required = true;
  } else if (data.identity.outcome !== 'auto_confirmed') { const notice = document.querySelector('#identity'); notice.textContent = 'Customer identity needs review before a callback can be scheduled.'; notice.hidden = false; return; }
  if (!data.callbackWritesEnabled) { const notice = document.querySelector('#identity'); notice.textContent = 'Callback scheduling is temporarily unavailable.'; notice.hidden = false; return; }
  form.hidden = false;
  const owner = document.querySelector('#owner'); owner.textContent = `Owner: ${data.owner}`; owner.hidden = false;
  if (data.clickToCallEnabled && data.customer.phone) {
    const callBtn = document.querySelector('#callBtn');
    callBtn.hidden = false;
    callBtn.onclick = async () => {
      callBtn.disabled = true;
      show(`Calling ${data.customer.phone} via 3CX...`);
      try {
        await request(apiPath(`/api/engagement/callback-panel/${conversationId}/call`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        show(`Call started to ${data.customer.phone}.`, 'success');
      } catch (error) { show(error.message, 'error'); }
      finally { callBtn.disabled = false; }
    };
  }
  if (data.callbacks.length) {
    document.querySelector('#openCallbacks').hidden = false;
    const list = document.querySelector('#callbackList');
    for (const callback of data.callbacks) {
      const item = document.createElement('li');
      item.textContent = `${callback.callbackNumber}: ${fmt(callback.dueAt)} - ${callback.reason}`;
      list.appendChild(item);
    }
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#submit');
  button.disabled = true;
  show('Scheduling...');
  try {
    const callback = await request(apiPath(`/api/engagement/callback-panel/${conversationId}/callbacks`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey }, body: JSON.stringify({ firstName: document.querySelector('#firstName').value, lastName: document.querySelector('#lastName').value, dueAt: document.querySelector('#dueAt').value, reason: document.querySelector('#reason').value, agent: currentAgent }) });
    show(`${callback.replayed ? 'Existing' : 'Scheduled'} callback ${callback.callback.callbackNumber}.`, 'success');
    if (callback.crmUrl) { const link = document.querySelector('#crmLink'); link.href = callback.crmUrl; link.textContent = 'Open CRM Callback'; link.hidden = false; }
    form.reset(); idempotencyKey = newIdempotencyKey();
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

load().catch((error) => show(error.message, 'error'));