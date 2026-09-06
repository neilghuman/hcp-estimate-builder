let conversationId = new URLSearchParams(location.search).get('conversationId');
let currentAgent = null;
let panelData = null;
const requestedTab = new URLSearchParams(location.search).get('tab') === 'task' ? 'task' : 'callback';
let activeTab = requestedTab;
const callbackForm = document.querySelector('#callbackForm');
const taskForm = document.querySelector('#taskForm');
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

function customerFields() {
  return { firstName: document.querySelector('#firstName').value, lastName: document.querySelector('#lastName').value };
}

function suggestedContactText(contact) {
  return [contact?.name, contact?.phone, contact?.email].filter(Boolean).join(' | ');
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
  callbackForm.hidden = tab !== 'callback' || !panelData?.callbackWritesEnabled;
  taskForm.hidden = tab !== 'task' || !panelData?.customerTasksEnabled;
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
  panelData = data;
  document.querySelector('#customer').textContent = [data.customer.name, data.customer.phone, data.customer.email].filter(Boolean).join(' | ') || 'Unnamed customer';
  const crmLink = document.querySelector('#crmLink');
  crmLink.href = '#';
  crmLink.textContent = 'Open CRM Contact';
  crmLink.hidden = true;
  if (data.crmUrl) { crmLink.href = data.crmUrl; crmLink.hidden = false; }
  const firstName = document.querySelector('#firstName');
  const lastName = document.querySelector('#lastName');
  const confirmCustomer = document.querySelector('#confirmCustomer');
  confirmCustomer.hidden = true;
  document.querySelector('#customerNameField').hidden = true;
  firstName.value = data.customer.firstName || '';
  lastName.value = data.customer.lastName || '';
  firstName.required = false;
  lastName.required = false;
  firstName.readOnly = false;
  lastName.readOnly = false;
  if (data.identity.outcome === 'net_new') {
    document.querySelector('#customerNameField').hidden = false;
    firstName.required = true;
    lastName.required = true;
    firstName.readOnly = false;
    lastName.readOnly = false;
  } else if (data.identity.outcome === 'provisional' && data.suggestedContact) {
    document.querySelector('#confirmText').textContent = `This looks like ${suggestedContactText(data.suggestedContact)}. Link this Chatwoot conversation to that CRM customer to create callbacks or tasks.`;
    confirmCustomer.hidden = false;
    return;
  } else if (data.identity.outcome !== 'auto_confirmed') { const notice = document.querySelector('#identity'); notice.textContent = 'Customer identity needs review before a follow-up can be created.'; notice.hidden = false; return; }
  else if (data.customer.firstName || data.customer.lastName) {
    document.querySelector('#customerNameField').hidden = false;
    firstName.required = false;
    lastName.required = false;
    firstName.readOnly = true;
    lastName.readOnly = true;
  }
  if (!data.callbackWritesEnabled && !data.customerTasksEnabled) { const notice = document.querySelector('#identity'); notice.textContent = 'Customer follow-up tools are temporarily unavailable.'; notice.hidden = false; return; }
  document.querySelector('#tabs').hidden = false;
  document.querySelector('[data-tab="callback"]').hidden = !data.callbackWritesEnabled;
  document.querySelector('[data-tab="task"]').hidden = !data.customerTasksEnabled;
  activeTab = requestedTab === 'task' && data.customerTasksEnabled ? 'task' : (data.callbackWritesEnabled ? 'callback' : 'task');
  setTab(activeTab);
  const owner = document.querySelector('#owner'); owner.textContent = `Owner: ${data.owner}`; owner.hidden = false;
  const taskOwner = document.querySelector('#taskOwner'); taskOwner.textContent = `Owner: ${data.owner}`; taskOwner.hidden = false;
  if (data.clickToCallEnabled && data.customer.phone) {
    const callBtn = document.querySelector('#callBtn');
    callBtn.hidden = false;
    callBtn.onclick = async () => {
      callBtn.disabled = true;
      show(`Calling ${data.customer.phone} via 3CX...`);
      try {
        await request(apiPath(`/api/engagement/callback-panel/${conversationId}/call`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: currentAgent }) });
        show(`Call started to ${data.customer.phone}.`, 'success');
      } catch (error) { show(error.message, 'error'); }
      finally { callBtn.disabled = false; }
    };
  }
  if (data.callbacks.length) {
    document.querySelector('#openCallbacks').hidden = false;
    const list = document.querySelector('#callbackList');
    list.innerHTML = '';
    for (const callback of data.callbacks) {
      const item = document.createElement('li');
      item.textContent = `${callback.callbackNumber}: ${fmt(callback.dueAt)} - ${callback.reason}`;
      list.appendChild(item);
    }
  }
}

document.querySelector('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  setTab(button.dataset.tab);
});

document.querySelector('#confirmCustomerBtn').addEventListener('click', async () => {
  const button = document.querySelector('#confirmCustomerBtn');
  button.disabled = true;
  show('Linking customer...');
  try {
    const result = await request(apiPath(`/api/engagement/callback-panel/${conversationId}/link-customer`), { method: 'POST', headers: { 'content-type': 'application/json' } });
    show('Customer linked. Loading follow-up tools...', 'success');
    if (result.crmUrl) { const link = document.querySelector('#crmLink'); link.href = result.crmUrl; link.textContent = 'Open CRM Contact'; link.hidden = false; }
    await load();
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

callbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#submit');
  button.disabled = true;
  show('Scheduling...');
  try {
    const callback = await request(apiPath(`/api/engagement/callback-panel/${conversationId}/callbacks`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey }, body: JSON.stringify({ ...customerFields(), dueAt: document.querySelector('#dueAt').value, reason: document.querySelector('#reason').value, agent: currentAgent }) });
    show(`${callback.replayed ? 'Existing' : 'Scheduled'} callback ${callback.callback.callbackNumber}.`, 'success');
    if (callback.crmUrl) { const link = document.querySelector('#crmLink'); link.href = callback.crmUrl; link.textContent = 'Open CRM Callback'; link.hidden = false; }
    callbackForm.reset(); idempotencyKey = newIdempotencyKey();
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#taskSubmit');
  button.disabled = true;
  show('Creating task...');
  try {
    const result = await request(apiPath(`/api/engagement/callback-panel/${conversationId}/tasks`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...customerFields(), title: document.querySelector('#taskTitle').value, dueAt: document.querySelector('#taskDueAt').value, details: document.querySelector('#taskDetails').value, agent: currentAgent }) });
    show('Task created in CRM.', 'success');
    if (result.crmUrl) { const link = document.querySelector('#crmLink'); link.href = result.crmUrl; link.textContent = 'Open CRM Task'; link.hidden = false; }
    taskForm.reset();
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

load().catch((error) => show(error.message, 'error'));