// Chat Foundry — Sprint 1 front-end (read-only discovery). No sending here.
const $ = (sel) => document.querySelector(sel);

function flash(text, kind = '') {
  const el = $('#msg');
  el.textContent = text;
  el.className = `msg${kind ? ' ' + kind : ''}`;
  el.hidden = false;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function loadConfig() {
  const box = $('#configBox');
  try {
    const c = await getJson('/api/chat-foundry/config');
    const cw = c.chatwoot || {};
    const rows = [
      ['Chatwoot base URL', cw.baseUrl || '<em>not set</em>'],
      ['API token', cw.tokenPresent ? '✅ present' : '❌ missing'],
      ['Account ID', cw.accountId || '<em>not set — discover below</em>'],
      ['Configured', cw.configured ? '✅ yes' : '❌ no'],
      ['Sending enabled', c.sendEnabled ? '🟢 enabled' : '🔒 disabled (CHAT_FOUNDRY_SEND_ENABLED=false)'],
      ['Max campaign size', esc(c.maxCampaignSize)],
      ['Allowlisted inbox IDs', (c.allowedInboxIds && c.allowedInboxIds.length) ? esc(c.allowedInboxIds.join(', ')) : '<em>none set</em>'],
    ];
    box.innerHTML = `<table class="cf-table"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table>`;
    updateGuideSafety(c);
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">Could not load config: ${esc(e.message)}</span>`;
  }
}

// Live safety banner in the Start-here guide: reflect the actual send flag + inbox allowlist.
function updateGuideSafety(c) {
  const el = $('#guideSafety');
  if (!el) return;
  const allowed = (c.allowedInboxIds && c.allowedInboxIds.length) ? c.allowedInboxIds.length : 0;
  if (!c.sendEnabled || allowed === 0) {
    el.className = 'cf-safety locked';
    el.innerHTML = '🔒 <strong>Safe mode.</strong> Sending is disabled'
      + (allowed === 0 ? ' and no inbox is allowlisted' : '')
      + ' — every Send button is intentionally locked, so you can explore freely with zero risk.';
  } else {
    el.className = 'cf-safety live';
    el.innerHTML = `⚠ <strong>Live sending is ON</strong> for ${allowed} allowlisted inbox(es). Always send a single test before a bulk send.`;
  }
}

// Collapse/expand the onboarding guide (remembered across visits).
function initGuideToggle() {
  const btn = $('#btnToggleGuide');
  const body = $('#guideBody');
  if (!btn || !body) return;
  const collapsed = localStorage.getItem('cf-guide-hidden') === '1';
  const apply = (hide) => { body.hidden = hide; btn.textContent = hide ? 'Show guide' : 'Hide guide'; };
  apply(collapsed);
  btn.addEventListener('click', () => {
    const hide = !body.hidden;
    apply(hide);
    localStorage.setItem('cf-guide-hidden', hide ? '1' : '0');
  });
}

async function checkHealth() {
  const box = $('#configBox');
  try {
    const h = await getJson('/api/chat-foundry/health');
    flash(`Connected to Chatwoot ✓ (${h.accountCount} account${h.accountCount === 1 ? '' : 's'} visible${h.user && h.user.name ? `, as ${h.user.name}` : ''}).`, 'ok');
  } catch (e) {
    flash(`Connection failed: ${e.message}`, 'err');
  }
  await loadConfig();
}

// ---- Live-sending switch + per-inbox allowlist toggles (DB-backed settings) ----
async function loadSettingsUI() {
  try { applySettingsView(await getJson('/api/chat-foundry/settings')); } catch (_) { /* ignore */ }
}
function applySettingsView(s) {
  const sw = $('#sendSwitch');
  const st = $('#sendSwitchState');
  if (sw) sw.checked = !!s.sendEnabled;
  if (st) st.textContent = s.sendEnabled
    ? `🔴 ON — armed (${s.allowedInboxIds.length} inbox${s.allowedInboxIds.length === 1 ? '' : 'es'} allowlisted)`
    : '🔒 OFF — Safe mode (nothing can send)';
  if ($('#sendModalPhraseHint')) $('#sendModalPhraseHint').textContent = s.confirmPhrase || 'ENABLE SENDING';
}
function onSendSwitchChange() {
  const sw = $('#sendSwitch');
  if (sw.checked) { sw.checked = false; openSendModal(); }   // arming needs the modal
  else { setSending(false, ''); }                            // disabling is instant + safe
}
function openSendModal() {
  $('#sendModalPhrase').value = '';
  $('#sendModalConfirm').disabled = true;
  $('#sendModal').hidden = false;
  $('#sendModalPhrase').focus();
}
function closeSendModal() { $('#sendModal').hidden = true; }
async function setSending(enabled, confirmPhrase) {
  try {
    const s = await postJson('/api/chat-foundry/settings/sending', { enabled, confirm: confirmPhrase });
    applySettingsView(s);
    flash(enabled ? '🔴 Live sending is now ARMED — sends still need an allowlisted inbox + per-send confirmation.' : '🔒 Safe mode on — sending disabled.', enabled ? 'err' : 'ok');
    loadConfig(); loadInboxes(); loadSendState();
  } catch (e) { flash(e.message, 'err'); loadSettingsUI(); }
}
async function toggleInboxAllowed(inboxId, allowed) {
  try {
    const s = await postJson('/api/chat-foundry/settings/inbox', { inboxId, allowed });
    applySettingsView(s);
    flash(`Inbox ${inboxId} ${allowed ? 'added to' : 'removed from'} the allowlist.`, 'ok');
    loadInboxes(); loadConfig();
  } catch (e) { flash(e.message, 'err'); loadInboxes(); }
}
function initSendControls() {
  const sw = $('#sendSwitch');
  if (sw) sw.addEventListener('change', onSendSwitchChange);
  const phrase = $('#sendModalPhrase');
  if (phrase) phrase.addEventListener('input', () => {
    $('#sendModalConfirm').disabled = phrase.value.trim() !== ($('#sendModalPhraseHint').textContent || 'ENABLE SENDING');
  });
  const cancel = $('#sendModalCancel');
  if (cancel) cancel.addEventListener('click', () => { closeSendModal(); loadSettingsUI(); });
  const confirmBtn = $('#sendModalConfirm');
  if (confirmBtn) confirmBtn.addEventListener('click', () => { const p = $('#sendModalPhrase').value; closeSendModal(); setSending(true, p); });
  const modal = $('#sendModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) { closeSendModal(); loadSettingsUI(); } });
}

async function discoverAccounts() {
  const box = $('#accountsBox');
  box.textContent = 'Loading…';
  try {
    const { accounts } = await getJson('/api/chat-foundry/accounts');
    if (!accounts.length) { box.innerHTML = '<em>No accounts visible to this token.</em>'; return; }
    box.innerHTML = `<table class="cf-table"><thead><tr><th>Account ID</th><th>Name</th><th>Role</th></tr></thead><tbody>${
      accounts.map((a) => `<tr><td><code>${esc(a.id)}</code></td><td>${esc(a.name)}</td><td>${esc(a.role || '')}</td></tr>`).join('')
    }</tbody></table><p class="field-hint">Copy the correct ID into <code>CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID</code> in <code>.env</code>.</p>`;
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
  }
}

function capBadge(inbox) {
  if (inbox.outbound_allowed) return '<span class="cf-badge cf-badge-ok">eligible</span>';
  return `<span class="cf-badge cf-badge-skip" title="${esc(inbox.skip_reason || '')}">${esc(inbox.eligibility || 'not allowed')}</span>`;
}

async function loadInboxes() {
  const box = $('#inboxesBox');
  box.textContent = 'Loading…';
  try {
    const { inboxes } = await getJson('/api/chat-foundry/inboxes');
    if (!inboxes.length) { box.innerHTML = '<em>No inboxes returned.</em>'; return; }
    box.innerHTML = `<table class="cf-table"><thead><tr><th>ID</th><th>Name</th><th>Channel</th><th>Allowlisted</th><th>Outbound</th></tr></thead><tbody>${
      inboxes.map((i) => `<tr>
        <td><code>${esc(i.id)}</code></td>
        <td>${esc(i.name)}</td>
        <td>${esc(i.channel_type || '')}</td>
        <td><label class="cf-inbox-toggle"><input type="checkbox" data-inbox="${esc(i.id)}" ${i.outbound_allowed ? 'checked' : ''} /> allow</label></td>
        <td>${capBadge(i)}</td>
      </tr>`).join('')
    }</tbody></table><p class="field-hint">Tick an inbox to add it to the outbound allowlist (saved instantly, no restart).</p>`;
    box.querySelectorAll('input[data-inbox]').forEach((cb) => cb.addEventListener('change', () => toggleInboxAllowed(Number(cb.dataset.inbox), cb.checked)));
    // Populate the audience inbox filter.
    const sel = $('#fInbox');
    if (sel) {
      sel.innerHTML = '<option value="">All allowlisted</option>' +
        inboxes.map((i) => `<option value="${esc(i.id)}">#${esc(i.id)} · ${esc(i.name)}${i.outbound_allowed ? '' : ' (skip)'}</option>`).join('');
    }
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
  }
}

async function loadTags() {
  const box = $('#tagsBox');
  box.textContent = 'Loading…';
  try {
    const { tags } = await getJson('/api/chat-foundry/tags');
    if (!tags.length) { box.innerHTML = '<em>No tags/labels found.</em>'; $('#fTags').innerHTML = '<em>No tags.</em>'; return; }
    box.innerHTML = tags.map((t) => `<span class="cf-tag">${esc(t.title)}</span>`).join(' ');
    const chks = tags.map((t) => `<label class="cf-tagchk"><input type="checkbox" value="${esc(t.title)}" /> ${esc(t.title)}</label>`).join(' ');
    $('#fTags').innerHTML = chks;
    if ($('#kTags')) $('#kTags').innerHTML = chks;
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
  }
}

// ---- Audience preview (read-only) ----
let cwBase = null, cwAccount = null, lastPreview = null, audPage = 1;

async function loadLinks() {
  try {
    const c = await getJson('/api/chat-foundry/config');
    cwBase = c.chatwoot && c.chatwoot.baseUrl;
    cwAccount = c.chatwoot && c.chatwoot.accountId;
  } catch (_) { /* ignore */ }
}
function convUrl(id) { return (cwBase && cwAccount) ? `${cwBase}/app/accounts/${cwAccount}/conversations/${id}` : null; }
function selectedTags() { return [...document.querySelectorAll('#fTags input:checked')].map((i) => i.value); }
function currentFilters(page = 1) {
  return {
    inboxId: $('#fInbox').value || null,
    status: $('#fStatus').value,
    tags: selectedTags(),
    contactSearch: $('#fSearch').value,
    excludeNoChannel: $('#fExcludeNoChannel').checked,
    maxRecipients: Number($('#fMax').value || 0),
    page,
    perPage: 50,
  };
}
function elBadge(row) {
  return row.eligible
    ? '<span class="cf-badge cf-badge-ok">eligible</span>'
    : `<span class="cf-badge cf-badge-skip" title="${esc(row.skip_reason || '')}">${esc(row.eligibility)}</span>`;
}
function renderAudience(data) {
  const s = data.summary;
  $('#audienceCount').innerHTML = `<strong>${s.eligible}</strong> eligible of <strong>${s.matched}</strong> matching ${esc(data.filters.status)} conversation${s.matched === 1 ? '' : 's'}${s.skipped ? ` · ${s.skipped} skipped` : ''}${s.truncated ? ' · ⚠ scan truncated (narrow filters)' : ''}`;
  if (!data.rows.length) {
    $('#audienceTable').innerHTML = '<em>No conversations match these filters.</em>';
    $('#btnPrev').hidden = true; $('#btnNext').hidden = true; $('#btnExportCsv').hidden = true; $('#pagerInfo').textContent = '';
    return;
  }
  const body = data.rows.map((r) => `<tr class="${r.eligible ? '' : 'cf-row-skip'}">
    <td><input type="checkbox" ${r.eligible ? 'checked' : 'disabled'} /></td>
    <td>${esc(r.contact_name || '')}</td>
    <td>${esc(r.contact_identifier || '')}</td>
    <td>${esc(r.phone_masked || '')}</td>
    <td>${convUrl(r.conversation_id) ? `<a href="${convUrl(r.conversation_id)}" target="_blank" rel="noopener">#${esc(r.conversation_id)} ↗</a>` : '#' + esc(r.conversation_id)}</td>
    <td>${esc(r.inbox_id)}</td>
    <td>${(r.labels || []).map((l) => `<span class="cf-tag">${esc(l)}</span>`).join(' ')}</td>
    <td>${esc(r.status || '')}</td>
    <td>${esc(r.assignee || '')}</td>
    <td>${esc(r.last_activity_at || '')}</td>
    <td>${elBadge(r)}</td>
    <td class="cf-reason">${esc(r.skip_reason || '')}</td>
  </tr>`).join('');
  $('#audienceTable').innerHTML = `<div class="cf-table-wrap"><table class="cf-table cf-aud"><thead><tr>
    <th></th><th>Contact</th><th>Identifier</th><th>Phone</th><th>Conv</th><th>Inbox</th><th>Tags</th><th>Status</th><th>Assignee</th><th>Last activity</th><th>Outbound</th><th>Reason</th>
  </tr></thead><tbody>${body}</tbody></table></div>`;
  const totalPages = Math.max(1, Math.ceil(data.totalRows / data.perPage));
  $('#pagerInfo').textContent = `Page ${data.page} / ${totalPages} · showing ${data.rows.length} of ${data.totalRows}`;
  $('#btnPrev').hidden = data.page <= 1;
  $('#btnNext').hidden = data.page >= totalPages;
  $('#btnExportCsv').hidden = false;
}
async function refreshAudience(page = 1) {
  const btn = $('#btnRefreshAudience');
  btn.disabled = true; btn.textContent = 'Loading…';
  $('#audienceTable').textContent = 'Querying Chatwoot…';
  try {
    const r = await fetch('/api/chat-foundry/audience/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentFilters(page)),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    lastPreview = data; audPage = data.page;
    renderAudience(data);
  } catch (e) {
    $('#audienceTable').innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
    $('#audienceCount').textContent = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Refresh Audience';
  }
}
function exportCsv() {
  if (!lastPreview || !lastPreview.rows.length) return;
  const cols = ['conversation_id', 'contact_name', 'contact_identifier', 'phone_masked', 'inbox_id', 'status', 'assignee', 'last_activity_at', 'eligible', 'eligibility', 'skip_reason', 'labels'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = lastPreview.rows.map((r) => cols.map((c) => q(c === 'labels' ? (r.labels || []).join('|') : r[c])).join(','));
  const blob = new Blob([cols.join(',') + '\n' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'chat-foundry-audience.csv'; a.click(); URL.revokeObjectURL(a.href);
}

$('#btnHealth').addEventListener('click', checkHealth);
$('#btnAccounts').addEventListener('click', discoverAccounts);
$('#btnInboxes').addEventListener('click', loadInboxes);
$('#btnTags').addEventListener('click', loadTags);
$('#btnRefreshAudience').addEventListener('click', () => refreshAudience(1));
$('#btnPrev').addEventListener('click', () => refreshAudience(audPage - 1));
$('#btnNext').addEventListener('click', () => refreshAudience(audPage + 1));
$('#btnExportCsv').addEventListener('click', exportCsv);

// ---- Message library ----
let TEMPLATE_CATEGORIES = [];

async function loadTemplates() {
  const box = $('#templatesBox');
  box.textContent = 'Loading…';
  try {
    const params = new URLSearchParams();
    if ($('#tSearch').value.trim()) params.set('search', $('#tSearch').value.trim());
    if ($('#tCategory').value) params.set('category', $('#tCategory').value);
    if ($('#tArchived').checked) params.set('includeArchived', 'true');
    const data = await getJson('/api/chat-foundry/templates?' + params.toString());
    TEMPLATE_CATEGORIES = data.categories || TEMPLATE_CATEGORIES;
    populateCategorySelects();
    const list = data.templates || [];
    if (!list.length) { box.innerHTML = '<em>No templates yet. Click “New template”.</em>'; return; }
    box.innerHTML = `<table class="cf-table"><thead><tr><th>Name</th><th>Category</th><th>Tags</th><th>v</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${
      list.map((t) => `<tr>
        <td>${esc(t.name)}${t.approved ? ' <span class="cf-badge cf-badge-ok">approved</span>' : ''}</td>
        <td>${esc(t.category)}</td>
        <td>${(t.tags || []).map((x) => `<span class="cf-tag">${esc(x)}</span>`).join(' ')}</td>
        <td>${esc(t.current_version)}</td>
        <td>${esc(t.status)}</td>
        <td>${esc((t.updated_at || '').slice(0, 10))}</td>
        <td class="cf-row-actions">
          <button data-act="edit" data-id="${t.id}">Edit</button>
          <button data-act="dup" data-id="${t.id}">Duplicate</button>
          <button data-act="ver" data-id="${t.id}">Versions</button>
          ${t.status === 'archived'
            ? `<button data-act="restore" data-id="${t.id}">Restore</button>`
            : `<button data-act="archive" data-id="${t.id}">Archive</button>`}
          <button data-act="del" data-id="${t.id}" class="cf-danger">Delete</button>
        </td>
      </tr>`).join('')
    }</tbody></table>`;
    box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => templateAction(b.dataset.act, Number(b.dataset.id))));
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
  }
}

function populateCategorySelects() {
  const opts = TEMPLATE_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#tCategory').innerHTML = '<option value="">All</option>' + opts;
  $('#eCategory').innerHTML = opts;
}

function openEditor(t) {
  $('#tplEditorTitle').textContent = t ? `Edit: ${t.name}` : 'New template';
  $('#eId').value = t ? t.id : '';
  $('#eName').value = t ? t.name : '';
  $('#eCategory').value = t ? t.category : 'Custom';
  $('#eDescription').value = t ? t.description : '';
  $('#eTags').value = t ? (t.tags || []).join(', ') : '';
  $('#eBody').value = t ? t.body : '';
  $('#eChangeNote').value = '';
  $('#eApproved').checked = t ? !!t.approved : false;
  updateCharCount();
  $('#tplEditor').hidden = false;
  $('#tplVersions').hidden = true;
  $('#tplEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function updateCharCount() { $('#eCharCount').textContent = `${$('#eBody').value.length} chars`; }

async function saveTemplate() {
  const id = $('#eId').value;
  const payload = {
    name: $('#eName').value,
    category: $('#eCategory').value,
    description: $('#eDescription').value,
    tags: $('#eTags').value,
    body: $('#eBody').value,
    approved: $('#eApproved').checked,
    change_note: $('#eChangeNote').value,
  };
  try {
    const url = id ? `/api/chat-foundry/templates/${id}` : '/api/chat-foundry/templates';
    const r = await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    $('#tplEditor').hidden = true;
    flash(id ? 'Template saved.' : 'Template created.', 'ok');
    loadTemplates();
  } catch (e) { flash(`Save failed: ${e.message}`, 'err'); }
}

async function templateAction(act, id) {
  try {
    if (act === 'edit') { openEditor(await getJson(`/api/chat-foundry/templates/${id}`)); return; }
    if (act === 'dup') { await postAction(`/api/chat-foundry/templates/${id}/duplicate`); flash('Duplicated.', 'ok'); return loadTemplates(); }
    if (act === 'archive') { await postAction(`/api/chat-foundry/templates/${id}/archive`); flash('Archived.', 'ok'); return loadTemplates(); }
    if (act === 'restore') { await postAction(`/api/chat-foundry/templates/${id}/restore`); flash('Restored.', 'ok'); return loadTemplates(); }
    if (act === 'del') {
      if (!confirm('Delete this template and its version history? This cannot be undone.')) return;
      const r = await fetch(`/api/chat-foundry/templates/${id}?confirm=true`, { method: 'DELETE' });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      flash('Deleted.', 'ok'); return loadTemplates();
    }
    if (act === 'ver') return showVersions(id);
  } catch (e) { flash(e.message, 'err'); }
}
async function postAction(url) {
  const r = await fetch(url, { method: 'POST' });
  const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d;
}

async function showVersions(id) {
  const box = $('#tplVersions');
  box.hidden = false; box.textContent = 'Loading versions…';
  try {
    const { versions } = await getJson(`/api/chat-foundry/templates/${id}/versions`);
    box.innerHTML = `<h3>Version history</h3>${
      versions.map((v) => `<div class="cf-version">
        <div class="cf-version-head"><strong>v${esc(v.version_number)}</strong> · ${esc((v.created_at || '').slice(0, 16).replace('T', ' '))} · ${esc(v.created_by || '')} · ${esc(v.change_note || '')}
          <button data-restore="${v.id}" data-tpl="${id}">Restore</button></div>
        <pre class="cf-version-body">${esc(v.body)}</pre>
      </div>`).join('')
    }`;
    box.querySelectorAll('button[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      try { await postAction(`/api/chat-foundry/templates/${b.dataset.tpl}/versions/${b.dataset.restore}/restore`); flash('Version restored as a new version.', 'ok'); box.hidden = true; loadTemplates(); }
      catch (e) { flash(e.message, 'err'); }
    }));
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

$('#btnNewTemplate').addEventListener('click', () => openEditor(null));
$('#btnCancelTemplate').addEventListener('click', () => { $('#tplEditor').hidden = true; });
$('#btnSaveTemplate').addEventListener('click', saveTemplate);
$('#eBody').addEventListener('input', updateCharCount);
$('#btnReloadTemplates').addEventListener('click', loadTemplates);
$('#tSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTemplates(); });
$('#tCategory').addEventListener('change', loadTemplates);
$('#tArchived').addEventListener('change', loadTemplates);

// ---- Compose: placeholders + AI rewrite (preview only, never sends) ----
let composeTemplates = [];
let lastRewriteId = null;

async function loadComposeFields() {
  try {
    const { fields } = await getJson('/api/chat-foundry/compose/fields');
    $('#cFieldChips').innerHTML = fields.map((f) =>
      `<button type="button" class="cf-chip" data-field="${esc(f.key)}" title="${esc(f.label)} — e.g. ${esc(f.example)}">{{${esc(f.key)}}}</button>`).join(' ');
    $('#cFieldChips').querySelectorAll('button[data-field]').forEach((b) =>
      b.addEventListener('click', () => insertField(b.dataset.field)));
  } catch (e) { $('#cFieldChips').innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

async function loadComposeTemplates() {
  try {
    const { templates } = await getJson('/api/chat-foundry/templates');
    composeTemplates = templates || [];
    $('#cTemplate').innerHTML = '<option value="">— blank —</option>' +
      composeTemplates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  } catch (_) { /* library may be empty */ }
}

function insertField(key) {
  const ta = $('#cBody');
  const token = `{{${key}}}`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length;
  updateComposeMeta();
}

function updateComposeMeta() {
  const body = $('#cBody').value;
  $('#cCharCount').textContent = `${body.length} chars`;
  const used = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  const uniq = [...new Set(used)];
  $('#cAnalysis').innerHTML = uniq.length
    ? `fields: ${uniq.map((k) => `<span class="cf-tag">${esc(k)}</span>`).join(' ')}`
    : '<span class="cf-muted">no merge fields</span>';
}

async function composePreview() {
  const box = $('#composePreviewBox');
  const body = $('#cBody').value;
  if (!body.trim()) { flash('Enter a message body first.', 'err'); return; }
  box.textContent = 'Rendering samples…';
  try {
    const data = await postJson('/api/chat-foundry/compose/preview', {
      body,
      status: $('#cStatus').value,
      inboxId: $('#cInbox').value || null,
      sampleSize: Number($('#cSampleSize').value || 5),
    });
    const a = data.analysis || {};
    const s = data.summary || {};
    let head = '';
    if (a.hasUnknown) head += `<div class="cf-warn">⚠ Unsupported field(s): ${a.unknown.map(esc).join(', ')} — every recipient will be blocked.</div>`;
    if (!data.chatwootConfigured) head += '<div class="cf-warn">Chatwoot is not configured — showing static analysis only (no sample recipients).</div>';
    head += `<div class="cf-count"><strong>${s.renderable || 0}</strong> renderable of <strong>${s.total || 0}</strong> sample${s.total === 1 ? '' : 's'}${s.blocked ? ` · <span class="cf-bad">${s.blocked} blocked</span>` : ''}</div>`;
    const rows = (data.samples || []).map((r) => `<tr class="${r.blocked ? 'cf-row-skip' : ''}">
      <td>${esc(r.contact_name || '(no name)')}</td>
      <td><pre class="cf-sample">${esc(r.text)}</pre></td>
      <td>${r.blocked ? `<span class="cf-badge cf-badge-skip" title="${esc(r.block_reason || '')}">blocked</span>` : '<span class="cf-badge cf-badge-ok">ok</span>'}</td>
    </tr>`).join('');
    box.innerHTML = head + (rows
      ? `<div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Recipient</th><th>Rendered message</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<em>No sample recipients matched — adjust status/inbox above.</em>');
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
  }
}

async function postJson(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function suggestRewrite() {
  const body = $('#cBody').value;
  if (!body.trim()) { flash('Enter a message body first.', 'err'); return; }
  const btn = $('#btnRewrite');
  btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const data = await postJson('/api/chat-foundry/rewrite', {
      body,
      tone: $('#rTone').value,
      instruction: $('#rInstruction').value,
      templateId: $('#cTemplate').value || null,
    });
    lastRewriteId = data.id;
    $('#rOriginal').textContent = data.original;
    $('#rSuggested').textContent = data.rewritten;
    const warn = $('#rWarning');
    if (data.placeholder_warning) { warn.textContent = `⚠ ${data.placeholder_warning}`; warn.hidden = false; }
    else warn.hidden = true;
    $('#rewriteBox').hidden = false;
    flash(`Rewrite suggested with ${esc(data.model)} — review, then accept or reject.`, 'ok');
  } catch (e) {
    flash(`Rewrite failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Suggest rewrite';
  }
}

async function decideRewrite(accepted) {
  if (accepted) { $('#cBody').value = $('#rSuggested').textContent; updateComposeMeta(); }
  $('#rewriteBox').hidden = true;
  if (lastRewriteId != null) {
    try { await postJson(`/api/chat-foundry/rewrite/${lastRewriteId}/decision`, { accepted }); } catch (_) { /* audit best-effort */ }
  }
  flash(accepted ? 'Rewrite applied to the editor.' : 'Rewrite rejected.', accepted ? 'ok' : '');
  lastRewriteId = null;
}

$('#cTemplate').addEventListener('change', () => {
  const t = composeTemplates.find((x) => String(x.id) === $('#cTemplate').value);
  $('#cBody').value = t ? t.body : '';
  updateComposeMeta();
});
$('#cBody').addEventListener('input', updateComposeMeta);
$('#btnComposePreview').addEventListener('click', composePreview);
$('#btnRewrite').addEventListener('click', suggestRewrite);
$('#btnAcceptRewrite').addEventListener('click', () => decideRewrite(true));
$('#btnRejectRewrite').addEventListener('click', () => decideRewrite(false));

// Mirror the audience inbox list into the compose inbox picker once inboxes load.
function syncComposeInboxes() {
  const src = $('#fInbox');
  const dst = $('#cInbox');
  if (src && dst && src.options.length > 1) dst.innerHTML = src.innerHTML;
  const kd = $('#kInbox');
  if (src && kd && src.options.length > 1) kd.innerHTML = src.innerHTML;
}

// ---- Campaigns + gated TEST-mode single send ----
let currentCampaign = null;

function renderSendState(sendEnabled) {
  const el = $('#sendState');
  if (!el) return;
  if (sendEnabled) { el.textContent = '🟢 sending enabled'; el.className = 'cf-badge cf-badge-ok'; }
  else { el.textContent = '🔒 sending disabled'; el.className = 'cf-badge cf-badge-skip'; }
}

async function createCampaign() {
  const body = ($('#kBody').value.trim() || $('#cBody').value.trim());
  if (!body) { flash('Add a message body (here or in Compose) first.', 'err'); return; }
  const box = $('#campaignBox');
  box.textContent = 'Creating…';
  try {
    const c = await postJson('/api/chat-foundry/campaigns', {
      name: $('#kName').value,
      body,
      status: $('#kStatus').value,
      inboxId: $('#kInbox').value || null,
      tags: selectedCampaignTags(),
      maxRecipients: Number($('#kMax').value || 0),
      templateId: $('#cTemplate') && $('#cTemplate').value ? $('#cTemplate').value : null,
    });
    box.innerHTML = `<span class="cf-badge cf-badge-ok">campaign #${c.id} created</span>`;
    await loadCampaign(c.id);
    flash(`Campaign #${c.id} created. Now build the recipient list.`, 'ok');
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

// Tags ticked in the Campaign section (AND filter, mirrors the Audience picker).
function selectedCampaignTags() {
  return [...document.querySelectorAll('#kTags input:checked')].map((i) => i.value);
}

// Copy the Audience section's filters (status, inbox, max, tags) into the Campaign form so the
// campaign targets exactly what you previewed.
function useAudienceFilters() {
  $('#kStatus').value = $('#fStatus').value;
  $('#kInbox').value = $('#fInbox').value;
  $('#kMax').value = $('#fMax').value;
  const picked = new Set(selectedTags());
  document.querySelectorAll('#kTags input[type="checkbox"]').forEach((cb) => { cb.checked = picked.has(cb.value); });
  flash('Copied Audience filters (status, inbox, max, tags) into the campaign.', 'ok');
}

async function loadCampaign(id) {
  const c = await getJson(`/api/chat-foundry/campaigns/${id}`);
  currentCampaign = c;
  renderSendState(c.sendEnabled);
  $('#campaignDetail').hidden = false;
  const counts = c.recipient_counts || {};
  const f = c.filters || {};
  const tagBits = (f.tags && f.tags.length) ? `tags: ${f.tags.map((t) => `<span class="cf-tag">${esc(t)}</span>`).join(' ')}` : '<span class="cf-muted">no tag filter (everyone matching status)</span>';
  $('#campaignSummary').innerHTML = `Campaign <strong>#${c.id}</strong> · status <strong>${esc(c.status)}</strong> · `
    + `${c.eligible_count || 0} eligible / ${c.total_recipients || 0} total`
    + `${counts.sent ? ` · <span class="cf-badge cf-badge-ok">${counts.sent} sent</span>` : ''}`
    + `${c.test_sent_count ? ` · ${c.test_sent_count} test-sent` : ''}`
    + `<div class="cf-count-sub">Targeting → status <strong>${esc(f.status || 'open')}</strong> · ${tagBits}</div>`;
  renderRecipients(c);
  // Show the test-send panel only once recipients exist.
  const panel = $('#testSendPanel');
  panel.hidden = !(c.total_recipients > 0);
  $('#kPhraseHint').textContent = c.testConfirmPhrase || 'SEND 1 MESSAGE';
  updateTestSendState();
  syncBulkPanel(c);
  loadRecipients(c.id);
  loadEvents(c.id);
}

function renderRecipients(c) {
  const rows = c.sample_recipients || [];
  if (!rows.length) {
    $('#recipientBox').innerHTML = c.materialized_at
      ? '<em>No recipients matched the filters.</em>'
      : '<em>No recipient list yet — click “Build / refresh recipient list”.</em>';
    return;
  }
  $('#recipientBox').innerHTML = `<div class="cf-table-wrap"><table class="cf-table"><thead><tr>
    <th>Conv</th><th>Contact</th><th>Phone</th><th>Inbox</th><th>Status</th><th>Reason</th></tr></thead><tbody>${
    rows.map((r) => `<tr class="${r.eligible ? '' : 'cf-row-skip'}">
      <td>#${esc(r.conversation_id)}</td>
      <td>${esc(r.contact_name || '')}</td>
      <td>${esc(r.phone_masked || '')}</td>
      <td>${esc(r.inbox_id)}</td>
      <td>${r.status === 'sent' ? '<span class="cf-badge cf-badge-ok">sent</span>' : (r.eligible ? '<span class="cf-badge cf-badge-ok">pending</span>' : `<span class="cf-badge cf-badge-skip">${esc(r.status)}</span>`)}${r.is_test ? ' <span class="cf-tag">test</span>' : ''}</td>
      <td class="cf-reason">${esc(r.skip_reason || '')}</td>
    </tr>`).join('')
  }</tbody></table></div><p class="field-hint">Showing up to 25 recipients.</p>`;
}

async function materializeCampaign() {
  if (!currentCampaign) return;
  const box = $('#recipientBox');
  box.textContent = 'Building recipient list from Chatwoot…';
  try {
    await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/materialize`, {});
    await loadCampaign(currentCampaign.id);
    flash('Recipient list built. Nothing was sent.', 'ok');
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

function updateTestSendState() {
  const btn = $('#btnTestSend');
  if (!btn || !currentCampaign) return;
  const phraseOk = $('#kPhrase').value.trim() === ($('#kPhraseHint').textContent || '');
  const checked = $('#kConfirm').checked;
  const sendEnabled = currentCampaign.sendEnabled;
  const box = $('#kSendState');
  const problems = [];
  if (!sendEnabled) problems.push('sending is disabled (CHAT_FOUNDRY_SEND_ENABLED=false)');
  if (!checked) problems.push('check the confirmation box');
  if (!phraseOk) problems.push('type the exact phrase');
  btn.disabled = problems.length > 0;
  if (problems.length) { box.textContent = `⚠ ${problems.join(' · ')}`; box.hidden = false; }
  else box.hidden = true;
}

async function testSend() {
  if (!currentCampaign) return;
  const btn = $('#btnTestSend');
  btn.disabled = true; btn.textContent = 'Sending…';
  const box = $('#testSendResult');
  box.textContent = 'Sending one test message…';
  try {
    const r = await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/test-send`, {
      conversationId: $('#kTestConv').value || null,
      confirmPhrase: $('#kPhrase').value,
      confirmChecked: $('#kConfirm').checked,
    });
    box.innerHTML = `<span class="cf-badge cf-badge-ok">✓ sent</span> to ${esc(r.recipient.contact_name || 'conversation #' + r.recipient.conversation_id)} (${esc(r.recipient.phone_masked || '')}) · Chatwoot message #${esc(r.chatwoot_message_id)}`;
    $('#kPhrase').value = ''; $('#kConfirm').checked = false;
    await loadCampaign(currentCampaign.id);
    flash('Test message sent.', 'ok');
  } catch (e) {
    box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`;
    flash(`Test send blocked: ${e.message}`, 'err');
  } finally {
    btn.textContent = 'Send 1 test message';
    updateTestSendState();
  }
}

$('#btnCreateCampaign').addEventListener('click', createCampaign);
$('#btnMaterialize').addEventListener('click', materializeCampaign);
$('#btnUseAudience').addEventListener('click', useAudienceFilters);
$('#btnTestSend').addEventListener('click', testSend);
$('#kPhrase').addEventListener('input', updateTestSendState);$('#kConfirm').addEventListener('change', updateTestSendState);

// ---- Bulk send (durable): start / pause / resume / cancel + live progress ----
let progressTimer = null;

function syncBulkPanel(c) {
  const panel = $('#bulkSendPanel');
  const pending = c.pendingEligible || (c.recipient_counts && c.recipient_counts.pending) || 0;
  panel.hidden = !(c.total_recipients > 0);
  $('#bulkCount').textContent = pending;
  $('#bPhraseHint').textContent = c.sendConfirmPhrase || `SEND ${pending} MESSAGES`;

  const status = c.status;
  const running = c.running || status === 'sending';
  // Button visibility by campaign state.
  $('#btnBulkSend').hidden = !(status === 'ready' || status === 'testing');
  $('#btnBulkResume').hidden = status !== 'paused';
  $('#btnBulkPause').hidden = !running;
  $('#btnBulkCancel').hidden = !(running || status === 'paused');
  updateBulkState();

  if (running || status === 'paused' || status === 'sending') startProgressPolling(c.id);
  else stopProgressPolling();

  if (['sending', 'paused', 'completed', 'canceled'].includes(status)) refreshProgress(c.id);
}

function updateBulkState() {
  const btn = $('#btnBulkSend');
  if (!btn || !currentCampaign) return;
  const phraseOk = $('#bPhrase').value.trim() === ($('#bPhraseHint').textContent || '');
  const checked = $('#bConfirm').checked;
  const box = $('#bSendState');
  const problems = [];
  if (!currentCampaign.sendEnabled) problems.push('sending is disabled (CHAT_FOUNDRY_SEND_ENABLED=false)');
  if (!checked) problems.push('check the confirmation box');
  if (!phraseOk) problems.push('type the exact phrase');
  btn.disabled = problems.length > 0;
  $('#btnBulkResume').disabled = !(currentCampaign.sendEnabled && checked);
  if (problems.length && !$('#btnBulkSend').hidden) { box.textContent = `⚠ ${problems.join(' · ')}`; box.hidden = false; }
  else box.hidden = true;
}

async function bulkSend() {
  if (!currentCampaign) return;
  try {
    const r = await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/send`, {
      confirmPhrase: $('#bPhrase').value, confirmChecked: $('#bConfirm').checked,
    });
    $('#bPhrase').value = ''; $('#bConfirm').checked = false;
    flash(`Bulk send started for ${r.eligible} recipient(s).`, 'ok');
    await loadCampaign(currentCampaign.id);
  } catch (e) { flash(`Send blocked: ${e.message}`, 'err'); }
}

async function bulkResume() {
  if (!currentCampaign) return;
  try {
    await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/resume`, {
      confirmPhrase: $('#bPhraseHint').textContent, confirmChecked: $('#bConfirm').checked,
    });
    flash('Resumed.', 'ok');
    await loadCampaign(currentCampaign.id);
  } catch (e) { flash(`Resume blocked: ${e.message}`, 'err'); }
}

async function bulkPause() {
  if (!currentCampaign) return;
  try { await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/pause`, {}); flash('Pausing…', 'ok'); }
  catch (e) { flash(e.message, 'err'); }
}

async function bulkCancel() {
  if (!currentCampaign) return;
  if (!confirm('Cancel this campaign? Unsent recipients will be stopped.')) return;
  try { await postJson(`/api/chat-foundry/campaigns/${currentCampaign.id}/cancel`, {}); flash('Canceling…', 'ok'); }
  catch (e) { flash(e.message, 'err'); }
}

function startProgressPolling(id) {
  if (progressTimer) return;
  progressTimer = setInterval(() => refreshProgress(id), 2000);
}
function stopProgressPolling() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

async function refreshProgress(id) {
  try {
    const p = await getJson(`/api/chat-foundry/campaigns/${id}/progress`);
    $('#bulkProgress').hidden = false;
    $('#bulkBar').style.width = `${p.percent}%`;
    $('#bulkStats').innerHTML = `status <strong>${esc(p.status)}</strong> · ${p.percent}% · `
      + `<span class="cf-badge cf-badge-ok">${p.sent} sent</span> `
      + `${p.failed ? `<span class="cf-badge cf-badge-skip">${p.failed} failed</span> ` : ''}`
      + `${p.skipped ? `${p.skipped} skipped · ` : ''}`
      + `${p.remaining} remaining`;
    // When the run settles, stop polling and refresh the recipient table + buttons once.
    if (!p.active && ['completed', 'canceled', 'paused', 'ready'].includes(p.status)) {
      stopProgressPolling();
      if (currentCampaign && currentCampaign.status !== p.status) loadCampaign(id);
    }
  } catch (_) { /* transient */ }
}

$('#btnBulkSend').addEventListener('click', bulkSend);
$('#btnBulkResume').addEventListener('click', bulkResume);
$('#btnBulkPause').addEventListener('click', bulkPause);
$('#btnBulkCancel').addEventListener('click', bulkCancel);
$('#bPhrase').addEventListener('input', updateBulkState);
$('#bConfirm').addEventListener('change', updateBulkState);

// ---- Campaign history + recipient drill-down + audit log + CSV export ----
let drillPage = 1;

async function loadCampaignHistory() {
  const box = $('#campaignHistory');
  try {
    const { campaigns } = await getJson('/api/chat-foundry/campaigns');
    if (!campaigns.length) { box.innerHTML = '<em>No campaigns yet.</em>'; return; }
    box.innerHTML = `<div class="cf-table-wrap"><table class="cf-table"><thead><tr>
      <th>#</th><th>Name</th><th>Status</th><th>Eligible</th><th>Sent</th><th>Failed</th><th>Created</th><th></th></tr></thead><tbody>${
      campaigns.map((c) => `<tr>
        <td>${esc(c.id)}</td>
        <td>${esc(c.name)}</td>
        <td><span class="cf-badge ${c.status === 'completed' ? 'cf-badge-ok' : (c.status === 'canceled' || c.status === 'paused' ? 'cf-badge-skip' : '')}">${esc(c.status)}</span></td>
        <td>${esc(c.eligible_count)}</td>
        <td>${esc(c.sent_count)}</td>
        <td>${esc(c.failed_count)}</td>
        <td>${esc((c.created_at || '').slice(0, 10))}</td>
        <td><button data-open="${c.id}">Open</button></td>
      </tr>`).join('')
    }</tbody></table></div>`;
    box.querySelectorAll('button[data-open]').forEach((b) => b.addEventListener('click', () => loadCampaign(Number(b.dataset.open))));
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

async function loadRecipients(id, resetPage = true) {
  if (resetPage) drillPage = 1;
  const box = $('#drillBox');
  box.textContent = 'Loading…';
  try {
    const data = await getJson(`/api/chat-foundry/campaigns/${id}/recipients?status=${encodeURIComponent($('#dStatus').value)}&page=${drillPage}&perPage=50`);
    if (!data.rows.length) { box.innerHTML = '<em>No recipients for this filter.</em>'; $('#drillPager').textContent = ''; $('#btnDrillPrev').hidden = true; $('#btnDrillNext').hidden = true; return; }
    box.innerHTML = `<div class="cf-table-wrap"><table class="cf-table"><thead><tr>
      <th>Conv</th><th>Contact</th><th>Phone</th><th>Inbox</th><th>Status</th><th>Msg ID</th><th>Sent</th><th>Reason / error</th></tr></thead><tbody>${
      data.rows.map((r) => `<tr class="${r.eligible ? '' : 'cf-row-skip'}">
        <td>#${esc(r.conversation_id)}</td>
        <td>${esc(r.contact_name || '')}</td>
        <td>${esc(r.phone_masked || '')}</td>
        <td>${esc(r.inbox_id)}</td>
        <td>${statusBadge(r.status)}${r.is_test ? ' <span class="cf-tag">test</span>' : ''}</td>
        <td>${esc(r.chatwoot_message_id || '')}</td>
        <td>${esc((r.sent_at || '').slice(0, 16).replace('T', ' '))}</td>
        <td class="cf-reason">${esc(r.skip_reason || r.error || '')}</td>
      </tr>`).join('')
    }</tbody></table></div>`;
    const pages = Math.ceil(data.total / data.perPage);
    $('#drillPager').textContent = `Page ${data.page} of ${pages} · ${data.total} recipient${data.total === 1 ? '' : 's'}`;
    $('#btnDrillPrev').hidden = data.page <= 1;
    $('#btnDrillNext').hidden = data.page >= pages;
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

function statusBadge(s) {
  if (s === 'sent') return '<span class="cf-badge cf-badge-ok">sent</span>';
  if (s === 'failed') return '<span class="cf-badge cf-badge-skip">failed</span>';
  if (s === 'skipped') return '<span class="cf-badge cf-badge-skip">skipped</span>';
  return `<span class="cf-badge">${esc(s)}</span>`;
}

async function loadEvents(id) {
  const box = $('#auditBox');
  box.textContent = 'Loading…';
  try {
    const { events } = await getJson(`/api/chat-foundry/campaigns/${id}/events`);
    if (!events.length) { box.innerHTML = '<em>No events yet.</em>'; return; }
    box.innerHTML = `<div class="cf-table-wrap"><table class="cf-table"><thead><tr>
      <th>When</th><th>Event</th><th>Actor</th><th>Detail</th></tr></thead><tbody>${
      events.map((e) => `<tr>
        <td>${esc((e.created_at || '').slice(0, 19).replace('T', ' '))}</td>
        <td><span class="cf-tag">${esc(e.event_type)}</span></td>
        <td>${esc(e.actor || '')}</td>
        <td class="cf-reason">${esc(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail || {}))}</td>
      </tr>`).join('')
    }</tbody></table></div>`;
  } catch (e) { box.innerHTML = `<span class="cf-bad">${esc(e.message)}</span>`; }
}

function exportRecipientsCsv() {
  if (!currentCampaign) return;
  const url = `/api/chat-foundry/campaigns/${currentCampaign.id}/recipients.csv?status=${encodeURIComponent($('#dStatus').value)}`;
  window.open(url, '_blank');
}

$('#btnReloadCampaigns').addEventListener('click', loadCampaignHistory);
$('#dStatus').addEventListener('change', () => currentCampaign && loadRecipients(currentCampaign.id));
$('#btnDrillPrev').addEventListener('click', () => { if (drillPage > 1) { drillPage -= 1; loadRecipients(currentCampaign.id, false); } });
$('#btnDrillNext').addEventListener('click', () => { drillPage += 1; loadRecipients(currentCampaign.id, false); });
$('#btnExportRecipients').addEventListener('click', exportRecipientsCsv);
$('#btnReloadEvents').addEventListener('click', () => currentCampaign && loadEvents(currentCampaign.id));

async function loadSendState() {
  try { const c = await getJson('/api/chat-foundry/config'); renderSendState(c.sendEnabled); } catch (_) { /* ignore */ }
}

loadConfig();
loadLinks();
loadInboxes().then(syncComposeInboxes);
loadTags();
loadTemplates();
loadComposeFields();
loadComposeTemplates();
updateComposeMeta();
loadSendState();
loadCampaignHistory();
initGuideToggle();
loadSettingsUI();
initSendControls();
