const conversationId = new URLSearchParams(location.search).get('conversationId');
const form = document.querySelector('#form');
const message = document.querySelector('#message');
let idempotencyKey = crypto.randomUUID();

function show(text, kind = '') { message.textContent = text; message.className = `message ${kind}`; }
function fmt(value) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function load() {
  if (!conversationId || !/^\d+$/.test(conversationId)) { show('Open this panel from a Chatwoot conversation.', 'error'); return; }
  const data = await request(`/api/engagement/callback-panel/${conversationId}`);
  document.querySelector('#customer').textContent = [data.customer.name, data.customer.phone, data.customer.email].filter(Boolean).join(' | ') || 'Unnamed customer';
  if (data.crmUrl) { const link = document.querySelector('#crmLink'); link.href = data.crmUrl; link.hidden = false; }
  if (data.identity.outcome !== 'auto_confirmed') { const notice = document.querySelector('#identity'); notice.textContent = 'Customer identity needs review before a callback can be scheduled.'; notice.hidden = false; return; }
  if (!data.callbackWritesEnabled) { const notice = document.querySelector('#identity'); notice.textContent = 'Callback scheduling is temporarily unavailable.'; notice.hidden = false; return; }
  form.hidden = false;
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
    const callback = await request(`/api/engagement/callback-panel/${conversationId}/callbacks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey }, body: JSON.stringify({ owner: document.querySelector('#owner').value, dueAt: document.querySelector('#dueAt').value, timezone: document.querySelector('#timezone').value, reason: document.querySelector('#reason').value }) });
    show(`${callback.replayed ? 'Existing' : 'Scheduled'} callback ${callback.callback.callbackNumber}.`, 'success');
    if (callback.crmUrl) { const link = document.querySelector('#crmLink'); link.href = callback.crmUrl; link.textContent = 'Open CRM Callback'; link.hidden = false; }
    form.reset(); idempotencyKey = crypto.randomUUID();
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

load().catch((error) => show(error.message, 'error'));