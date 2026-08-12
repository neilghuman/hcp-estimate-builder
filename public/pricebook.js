// Pricebook admin — full CRUD frontend.

let allItems = [];
let editingId = null;
let aiFieldSelectionId = null;
let flashTimer = null;

const $ = (s) => document.querySelector(s);
const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AI_FIELD_LABELS = {
  description: 'description',
  estimator_notes: 'estimator notes',
  exclusions: 'exclusions',
  ai_scope_notes: 'AI scope notes',
};
const AI_FIELD_VALUE_KEYS = {
  description: 'description',
  estimator_notes: 'estimator_notes',
  exclusions: 'exclusions',
  ai_scope_notes: 'ai_scope_notes',
};

// --- Bootstrap ---------------------------------------------------------------

async function boot() {
  await loadItems();
  bindFilters();
  bindModal();
  bindAiFieldModal();
  bindImport();
  bindBackups();
  bindCategories();
  bindGenerateAll();
  openDeepLinkedItem();
}

// Open an item's edit modal when arrived via ?item=<id> (e.g. from a Studio duplicate flag).
function openDeepLinkedItem() {
  const id = new URLSearchParams(location.search).get('item');
  if (!id) return;
  const item = allItems.find((i) => String(i.id) === String(id));
  if (item) {
    openEdit(id);
  } else {
    showPricebookFlash(`Item #${esc(id)} was not found (it may be inactive or deleted).`, 'warn');
  }
}

// --- Data --------------------------------------------------------------------

async function loadItems() {
  const includeInactive = $('#filterInactive').checked;
  try {
    const res = await fetch(`/api/pricebook?includeInactive=${includeInactive}`);
    const data = await res.json();
    allItems = data.items || [];
    populateCategoryFilter(allItems);
    renderTable();
  } catch (e) {
    $('#pbBody').innerHTML = `<tr><td colspan="9" class="loading err">Failed to load: ${esc(e.message)}</td></tr>`;
  }
}

function populateCategoryFilter(items) {
  const cats = [...new Set(items.map((i) => i.category))].sort();
  const sel = $('#filterCategory');
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
  // Also populate the datalist in the modal
  $('#categoryList').innerHTML = cats.map((c) => `<option value="${esc(c)}" />`).join('');
}

// --- Table -------------------------------------------------------------------

function renderTable() {
  const q = ($('#filterSearch').value || '').toLowerCase();
  const cat = $('#filterCategory').value;
  const showInactive = $('#filterInactive').checked;

  const filtered = allItems.filter((item) => {
    if (!showInactive && !item.active) return false;
    if (cat && item.category !== cat) return false;
    if (q && !item.name.toLowerCase().includes(q) && !(item.description || '').toLowerCase().includes(q)) return false;
    return true;
  });

  $('#pbCount').textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    $('#pbBody').innerHTML = '<tr><td colspan="10" class="loading">No items match.</td></tr>';
    return;
  }

  $('#pbBody').innerHTML = filtered.map((item) => `
    <tr class="${item.active ? '' : 'row-inactive'}" data-id="${item.id}">
      <td><span class="badge-cat">${esc(item.category)}</span></td>
      <td class="cell-name">${esc(item.name)}</td>
      <td class="cell-desc">${esc(item.description || '')}</td>
      <td class="cell-price">${money(item.unit_price)}</td>
      <td>${esc(item.unit_of_measure || '')}</td>
      <td><span class="badge-kind ${item.kind}">${esc(item.kind)}</span></td>
      <td>${item.taxable ? '✓' : ''}</td>
      <td>${item.active ? '<span class="dot-green">●</span>' : '<span class="dot-gray">●</span>'}</td>
      <td><span class="ai-pill ${esc(item.ai_status || 'pending')}">${esc(item.ai_status || 'pending')}</span></td>
      <td class="cell-actions">
        <button class="btn-ai" data-id="${item.id}" title="Generate AI">AI</button>
        <button class="btn-edit" data-id="${item.id}" title="Edit">✎</button>
        <button class="btn-delete" data-id="${item.id}" title="Delete">✕</button>
      </td>
    </tr>`).join('');

  $('#pbBody').querySelectorAll('.btn-ai').forEach((b) =>
    b.addEventListener('click', () => generateAi(b.dataset.id)));
  $('#pbBody').querySelectorAll('.btn-edit').forEach((b) =>
    b.addEventListener('click', () => openEdit(b.dataset.id)));
  $('#pbBody').querySelectorAll('.btn-delete').forEach((b) =>
    b.addEventListener('click', () => deleteItem(b.dataset.id)));
}

// --- Filters -----------------------------------------------------------------

function bindFilters() {
  $('#filterSearch').addEventListener('input', renderTable);
  $('#filterCategory').addEventListener('change', renderTable);
  $('#filterInactive').addEventListener('change', () => loadItems());
}

// --- Modal -------------------------------------------------------------------

function bindModal() {
  $('#btnAdd').addEventListener('click', openAdd);
  $('#btnModalClose').addEventListener('click', closeModal);
  $('#btnCancel').addEventListener('click', closeModal);
  $('#btnGenerateAi').addEventListener('click', generateAiFromModal);
  $('#btnAuditCategory').addEventListener('click', auditCategoryFromModal);
  $('#btnReviewItem').addEventListener('click', reviewItemFromModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
  $('#itemForm').addEventListener('submit', saveItem);
}

function bindAiFieldModal() {
  $('#btnAiFieldsClose').addEventListener('click', closeAiFieldModal);
  $('#btnAiFieldsCancel').addEventListener('click', closeAiFieldModal);
  $('#btnAiFieldsConfirm').addEventListener('click', confirmAiFieldSelection);
  $('#btnAiFieldsSelectAll').addEventListener('click', () => setAllAiFieldSelections(true));
  $('#btnAiFieldsClearAll').addEventListener('click', () => setAllAiFieldSelections(false));
  document.querySelectorAll('#aiFieldsModal input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', updateAiFieldSelectionUi);
  });
  $('#aiFieldsModal').addEventListener('click', (e) => {
    if (e.target === $('#aiFieldsModal')) closeAiFieldModal();
  });
}

function openAdd() {
  editingId = null;
  $('#modalTitle').textContent = 'Add Item';
  $('#itemForm').reset();
  $('#fActive').checked = true;
  $('#formMsg').textContent = '';
  $('#btnSave').textContent = 'Save';
  resetCategoryAudit();
  resetItemReview();
  $('#modal').classList.remove('hidden');
  $('#fCategory').focus();
}

function openEdit(id) {
  const item = allItems.find((i) => String(i.id) === String(id));
  if (!item) return;
  editingId = String(id);
  $('#modalTitle').textContent = 'Edit Item';
  $('#fId').value = String(id);
  $('#fCategory').value = item.category || '';
  $('#fName').value = item.name || '';
  $('#fDescription').value = item.description || '';
  $('#fInternalScope').value = item.estimator_notes || '';
  $('#fExclusions').value = item.exclusions || '';
  $('#fRecommendedNotes').value = item.ai_scope_notes || '';
  $('#fUnitPrice').value = (item.unit_price / 100).toFixed(2);
  $('#fUom').value = item.unit_of_measure || '';
  $('#fKind').value = item.kind || 'labor';
  $('#fTaxable').checked = Boolean(item.taxable);
  $('#fActive').checked = Boolean(item.active);
  $('#fSortOrder').value = item.sort_order || 0;
  $('#fNotes').value = item.internal_notes || '';
  $('#formMsg').textContent = '';
  $('#btnSave').textContent = 'Update';
  resetCategoryAudit();
  resetItemReview();
  $('#modal').classList.remove('hidden');
  $('#fName').focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
}

async function saveItem(e) {
  e.preventDefault();
  const btn = $('#btnSave');
  btn.disabled = true;
  const msg = $('#formMsg');
  msg.className = 'msg';
  msg.textContent = '';

  const dollars = parseFloat($('#fUnitPrice').value);
  const payload = {
    category: $('#fCategory').value.trim(),
    name: $('#fName').value.trim(),
    description: $('#fDescription').value.trim() || null,
    customer_description: $('#fDescription').value.trim() || null,
    estimator_notes: $('#fInternalScope').value.trim() || null,
    exclusions: $('#fExclusions').value.trim() || null,
    ai_scope_notes: $('#fRecommendedNotes').value.trim() || null,
    unit_price: Math.round(dollars * 100),
    unit_of_measure: $('#fUom').value.trim() || null,
    kind: $('#fKind').value,
    taxable: $('#fTaxable').checked,
    active: $('#fActive').checked,
    sort_order: parseInt($('#fSortOrder').value) || 0,
    internal_notes: $('#fNotes').value.trim() || null,
    ai_status: 'pending',
  };

  try {
    const url = editingId ? `/api/pricebook/${editingId}` : '/api/pricebook';
    const method = editingId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    closeModal();
    await loadItems();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function generateAi(id) {
  const item = allItems.find((entry) => String(entry.id) === String(id));
  if (item && String(item.ai_status || '').toLowerCase() === 'complete') {
    openAiFieldModal(id);
    return;
  }
  await runAiGeneration(id);
}

async function runAiGeneration(id, fields) {
  const rowBtn = document.querySelector(`.btn-ai[data-id="${id}"]`);
  const item = allItems.find((entry) => String(entry.id) === String(id));
  if (rowBtn) { rowBtn.textContent = '⏳'; rowBtn.disabled = true; }

  try {
    const options = { method: 'POST' };
    if (Array.isArray(fields) && fields.length) {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify({ fields });
    }
    const res = await fetch(`/api/pricebook/${id}/generate-ai`, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI generation failed');
    const summary = buildAiRefreshSummary(item, fields, data.item);
    await loadItems();
    showPricebookFlash(summary, 'ok');
    if (editingId && String(editingId) === String(id)) {
      openEdit(String(id));
      $('#formMsg').className = 'msg ok';
      $('#formMsg').textContent = summary;
    }
  } catch (e) {
    if (rowBtn) { rowBtn.textContent = 'AI'; rowBtn.disabled = false; }
    alert('AI generation failed: ' + e.message);
  }
}

async function generateAiFromModal() {
  if (!editingId) {
    $('#formMsg').className = 'msg warn';
    $('#formMsg').textContent = 'Save the item first, then run AI generation.';
    return;
  }

  const item = allItems.find((entry) => String(entry.id) === String(editingId));
  if (item && String(item.ai_status || '').toLowerCase() === 'complete') {
    $('#formMsg').className = 'msg';
    $('#formMsg').textContent = '';
    openAiFieldModal(editingId);
    return;
  }

  const btn = $('#btnGenerateAi');
  btn.disabled = true;
  btn.textContent = '⏳ Generating…';
  $('#formMsg').className = 'msg';
  $('#formMsg').textContent = 'Calling AI — this may take 15–30 seconds…';
  try {
    await generateAi(editingId);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate AI';
  }
}

function resetCategoryAudit() {
  const box = $('#categoryAudit');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

async function auditCategoryFromModal() {
  const name = $('#fName').value.trim();
  const box = $('#categoryAudit');
  if (!name) {
    $('#formMsg').className = 'msg warn';
    $('#formMsg').textContent = 'Enter a service name before auditing the category.';
    return;
  }
  const btn = $('#btnAuditCategory');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '⚖ Auditing…';
  box.classList.remove('hidden');
  box.innerHTML = '<span style="color:#667085">Checking the category…</span>';
  try {
    const res = await fetch('/api/pricebook/audit-category', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category: $('#fCategory').value.trim(),
        description: $('#fDescription').value.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.audit) throw new Error(data.error || `Audit failed (${res.status})`);
    renderCategoryAudit(data.audit);
  } catch (e) {
    box.innerHTML = `<span style="color:#b42318">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderCategoryAudit(a) {
  const box = $('#categoryAudit');
  if (a.correct) {
    box.innerHTML = `<span style="color:#067647">✓ Category looks correct${a.reasoning ? ` — ${esc(a.reasoning)}` : ''}</span>`;
    return;
  }
  const path = (a.suggested_parent && a.suggested_parent.toLowerCase() !== (a.suggested_category || '').toLowerCase())
    ? `${a.suggested_parent} / ${a.suggested_category}` : a.suggested_category;
  box.innerHTML = `<div style="color:#b9791a">Suggests <strong>${esc(path)}</strong>${a.is_new ? ' (new category)' : ''}`
    + ` <button type="button" id="btnApplyCategory" style="margin-left:6px;padding:2px 8px;border:1px solid #6938ef;border-radius:6px;background:#fff;color:#6938ef;cursor:pointer">Use this</button></div>`
    + (a.reasoning ? `<div style="color:#667085;margin-top:2px">${esc(a.reasoning)}</div>` : '');
  const apply = $('#btnApplyCategory');
  if (apply) apply.addEventListener('click', () => {
    $('#fCategory').value = a.suggested_category || '';
    box.innerHTML = `<span style="color:#067647">✓ Applied “${esc(a.suggested_category || '')}”</span>`;
  });
}

function resetItemReview() {
  const box = $('#itemReview');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

async function reviewItemFromModal() {
  const name = $('#fName').value.trim();
  const box = $('#itemReview');
  if (!name) {
    $('#formMsg').className = 'msg warn';
    $('#formMsg').textContent = 'Enter a service name before running the AI review.';
    return;
  }
  const btn = $('#btnReviewItem');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '🔎 Reviewing…';
  box.classList.remove('hidden');
  box.innerHTML = '<div class="item-review-loading">Running pricing, compliance &amp; duplicate checks…</div>';
  try {
    const res = await fetch('/api/pricebook/review-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: $('#fId').value || null,
        name,
        category: $('#fCategory').value.trim(),
        description: $('#fDescription').value.trim(),
        customer_description: $('#fDescription').value.trim(),
        exclusions: $('#fExclusions').value.trim(),
        recommendations: $('#fRecommendedNotes').value.trim(),
        unitPrice: parseFloat($('#fUnitPrice').value) || 0,
        unitOfMeasure: $('#fUom').value.trim(),
        kind: $('#fKind').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.reviews) throw new Error(data.error || `Review failed (${res.status})`);
    renderItemReview(data.reviews);
  } catch (e) {
    box.innerHTML = `<div class="item-review-loading err">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function reviewRow(label, assessment, items, notes) {
  const cls = assessment === 'concern' ? 'concern' : (assessment === 'review' ? 'warn' : 'ok');
  const mark = assessment === 'ok' ? '✓ looks good' : esc(assessment);
  let html = `<div class="rev-row rev-${cls}"><span class="rev-k">${esc(label)}</span><span class="rev-v">${mark}</span></div>`;
  const list = (items || []).filter(Boolean);
  if (list.length) html += `<ul class="rev-list">${list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  else if (notes) html += `<div class="rev-note">${esc(notes)}</div>`;
  return html;
}

function renderItemReview(reviews) {
  const box = $('#itemReview');
  let html = '';
  const pr = reviews.pricing_review;
  if (pr && pr.assessment) html += reviewRow('Pricing', pr.assessment, pr.issues, pr.notes);
  const cr = reviews.compliance_review;
  if (cr && cr.assessment) {
    const items = [...(cr.issues || []), ...(cr.required_disclaimers || []).map((d) => `Disclaimer: ${d}`)];
    html += reviewRow('Compliance', cr.assessment, items, cr.notes);
  }
  const df = reviews.duplicate_finder;
  if (df && Array.isArray(df.matches) && df.matches.length) {
    const items = df.matches.map((m) => `${m.name}${m.category ? ` (${m.category})` : ''}${m.similarity != null ? ` — ${Math.round(m.similarity * 100)}% match` : ''}`);
    html += reviewRow('Possible duplicate', 'review', items, df.notes);
  } else {
    html += reviewRow('Possible duplicate', 'ok', [], 'No near-duplicate services found.');
  }
  box.innerHTML = html || '<div class="item-review-loading">No review results.</div>';
}

function openAiFieldModal(id) {
  const item = allItems.find((entry) => String(entry.id) === String(id));
  if (!item) return;
  aiFieldSelectionId = String(id);
  $('#aiFieldsHelp').textContent = `Choose which AI-generated fields to refresh for ${item.name}.`;
  $('#aiFieldsMsg').className = 'msg';
  $('#aiFieldsMsg').textContent = '';
  setAllAiFieldSelections(true);
  updateAiFieldStateLabels(item);
  updateAiFieldSelectionUi();
  $('#aiFieldsModal').classList.remove('hidden');
}

function closeAiFieldModal() {
  $('#aiFieldsModal').classList.add('hidden');
  aiFieldSelectionId = null;
}

async function confirmAiFieldSelection() {
  if (!aiFieldSelectionId) return;
  const fields = [...document.querySelectorAll('#aiFieldsModal input[type="checkbox"]:checked')]
    .map((input) => input.value);
  const msg = $('#aiFieldsMsg');
  if (!fields.length) {
    msg.className = 'msg warn';
    msg.textContent = 'Select at least one field to update.';
    return;
  }

  const btn = $('#btnAiFieldsConfirm');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  msg.className = 'msg';
  msg.textContent = 'Calling AI with your selected fields…';

  try {
    const id = aiFieldSelectionId;
    closeAiFieldModal();
    await runAiGeneration(id, fields);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Selected Fields';
  }
}

async function deleteItem(id) {
  const item = allItems.find((i) => String(i.id) === String(id));
  if (!item) return;
  if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/pricebook/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
    await loadItems();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

// --- Import ------------------------------------------------------------------

function bindImport() {
  $('#btnImport').addEventListener('click', () => $('#importModal').classList.remove('hidden'));
  $('#btnImportClose').addEventListener('click', () => $('#importModal').classList.add('hidden'));
  $('#btnImportCancel').addEventListener('click', () => $('#importModal').classList.add('hidden'));
  $('#importModal').addEventListener('click', (e) => { if (e.target === $('#importModal')) $('#importModal').classList.add('hidden'); });
  $('#btnImportRun').addEventListener('click', runImport);
}

// --- Backups -----------------------------------------------------------------

function bindBackups() {
  $('#btnBackups').addEventListener('click', openBackups);
  $('#btnBackupClose').addEventListener('click', closeBackups);
  $('#btnBackupDone').addEventListener('click', closeBackups);
  $('#btnBackupRefresh').addEventListener('click', loadBackups);
  $('#btnBackupCreate').addEventListener('click', createBackup);
  $('#backupModal').addEventListener('click', (e) => { if (e.target === $('#backupModal')) closeBackups(); });
}

function openBackups() {
  $('#backupModal').classList.remove('hidden');
  $('#backupMsg').className = 'msg';
  $('#backupMsg').textContent = '';
  loadBackups();
}

function closeBackups() {
  $('#backupModal').classList.add('hidden');
}

async function loadBackups() {
  const list = $('#backupList');
  list.className = 'backup-list loading';
  list.textContent = 'Loading backups…';
  try {
    const res = await fetch('/api/pricebook/backups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load backups');
    renderBackups(data.backups || []);
  } catch (e) {
    list.className = 'backup-list loading err';
    list.textContent = e.message;
  }
}

function renderBackups(backups) {
  const list = $('#backupList');
  list.className = 'backup-list';
  if (!backups.length) {
    list.innerHTML = '<div class="loading">No server backups saved yet.</div>';
    return;
  }

  list.innerHTML = backups.map((backup) => `
    <div class="backup-row">
      <div>
        <div class="backup-name">${esc(backup.filename)}</div>
        <div class="backup-meta">Saved ${esc(formatDateTime(backup.createdAt))} · ${esc(formatBytes(backup.size))}</div>
      </div>
      <div class="backup-row-actions">
        <a class="btn-backup-row" href="/api/pricebook/backups/${encodeURIComponent(backup.filename)}/download" download>Download</a>
        <button type="button" class="btn-backup-row danger" data-restore="${esc(backup.filename)}">Restore</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => restoreBackup(btn.dataset.restore));
  });
}

async function createBackup() {
  const btn = $('#btnBackupCreate');
  const msg = $('#backupMsg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Creating backup on server…';
  try {
    const res = await fetch('/api/pricebook/backups/create', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Backup failed');
    msg.className = 'msg ok';
    msg.textContent = `✓ Backup saved: ${data.backup.filename}`;
    await loadBackups();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function restoreBackup(filename) {
  if (!confirm(`Restore backup "${filename}"? This will replace the current pricebook table.`)) return;
  const msg = $('#backupMsg');
  msg.className = 'msg';
  msg.textContent = `Restoring ${filename}…`;
  try {
    const res = await fetch(`/api/pricebook/backups/${encodeURIComponent(filename)}/restore`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Restore failed');
    msg.className = 'msg ok';
    msg.textContent = `✓ Restored ${data.restoredFrom} (${data.count} rows)`;
    await loadItems();
    await loadBackups();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
}

function formatBytes(size) {
  const n = Number(size || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleString();
}

function formatAiFieldList(fields) {
  return fields.map((field) => AI_FIELD_LABELS[field] || field).join(', ');
}

function setAllAiFieldSelections(checked) {
  document.querySelectorAll('#aiFieldsModal input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
  });
  updateAiFieldSelectionUi();
}

function updateAiFieldSelectionUi() {
  const fields = getSelectedAiFields();
  const btn = $('#btnAiFieldsConfirm');
  btn.disabled = !fields.length;
  btn.textContent = fields.length
    ? `Update ${fields.length} Selected Field${fields.length === 1 ? '' : 's'}`
    : 'Select at Least One Field';
}

function getSelectedAiFields() {
  return [...document.querySelectorAll('#aiFieldsModal input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function updateAiFieldStateLabels(item) {
  Object.entries(AI_FIELD_VALUE_KEYS).forEach(([field, valueKey]) => {
    const node = document.querySelector(`[data-field-state="${field}"]`);
    if (!node) return;
    const hasContent = !isBlank(item?.[valueKey]);
    node.textContent = hasContent ? 'Has content now' : 'Currently empty';
    node.classList.toggle('empty', !hasContent);
  });
}

function isBlank(value) {
  return String(value ?? '').trim() === '';
}

function buildAiRefreshSummary(beforeItem, fields, afterItem) {
  const itemName = afterItem?.name || beforeItem?.name || 'item';
  if (!Array.isArray(fields) || !fields.length) {
    return `AI generated all fields for ${itemName}.`;
  }

  const refreshed = fields.filter((field) => {
    const key = AI_FIELD_VALUE_KEYS[field];
    return key && String(beforeItem?.[key] ?? '') !== String(afterItem?.[key] ?? '');
  });
  const unchanged = fields.filter((field) => !refreshed.includes(field));

  let summary = `AI refreshed ${formatAiFieldList(fields)} for ${itemName}.`;
  if (refreshed.length) {
    summary += ` Changed: ${formatAiFieldList(refreshed)}.`;
  }
  if (unchanged.length) {
    summary += ` Unchanged: ${formatAiFieldList(unchanged)}.`;
  }
  return summary;
}

function showPricebookFlash(message, kind = 'ok') {
  const flash = $('#pbFlashMsg');
  clearTimeout(flashTimer);
  flash.className = `msg pb-flash ${kind}`;
  flash.textContent = message;
  flash.classList.remove('hidden');
  flashTimer = setTimeout(() => {
    flash.classList.add('hidden');
    flash.textContent = '';
    flash.className = 'msg pb-flash hidden';
  }, 7000);
}

async function runImport() {
  const file = $('#importFile').files[0];
  if (!file) { alert('Choose a file first.'); return; }
  const btn = $('#btnImportRun');
  const msg = $('#importMsg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Importing…';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('replace', $('#importReplace').checked ? 'true' : 'false');

  try {
    const res = await fetch('/api/pricebook/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.className = 'msg ok';
    msg.textContent = `✓ Imported ${data.imported} rows (${data.updated || 0} updated, ${data.inserted} new, ${data.skipped} skipped).`;
    await loadItems();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

boot();

// --- Generate All ------------------------------------------------------------

let bulkPollTimer = null;
let bulkStopped = false;

function bindGenerateAll() {
  $('#btnGenerateAll').addEventListener('click', startGenerateAll);
  $('#btnBulkStop').addEventListener('click', () => { bulkStopped = true; });
}

async function startGenerateAll() {
  bulkStopped = false;
  $('#btnGenerateAll').disabled = true;
  try {
    const res = await fetch('/api/pricebook/generate-ai-all', { method: 'POST' });
    const data = await res.json();
    if (!data.started) {
      alert(data.reason === 'no pending items' ? 'No pending items to generate.' : 'Already running.');
      $('#btnGenerateAll').disabled = false;
      return;
    }
    showBulkProgress(0, data.total);
    pollBulkStatus();
  } catch (e) {
    alert('Failed to start: ' + e.message);
    $('#btnGenerateAll').disabled = false;
  }
}

function showBulkProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('#bulkProgress').classList.remove('hidden');
  $('#bulkMsg').textContent = `${done} / ${total} generated`;
  $('#bulkBar').style.width = pct + '%';
}

async function pollBulkStatus() {
  if (bulkStopped) {
    endBulkProgress('Stopped.');
    return;
  }
  try {
    const res = await fetch('/api/pricebook/generate-ai-all/status');
    const s = await res.json();
    showBulkProgress(s.completed + s.failed, s.total);
    if (s.running) {
      bulkPollTimer = setTimeout(pollBulkStatus, 2000);
      // Refresh table every 10s while running so completed rows update
      if ((s.completed + s.failed) % 5 === 0) await loadItems();
    } else {
      await loadItems();
      const msg = s.failed > 0
        ? `Done — ${s.completed} generated, ${s.failed} failed.`
        : `Done — ${s.completed} generated.`;
      endBulkProgress(msg);
    }
  } catch {
    bulkPollTimer = setTimeout(pollBulkStatus, 3000);
  }
}

function endBulkProgress(msg) {
  clearTimeout(bulkPollTimer);
  $('#btnGenerateAll').disabled = false;
  $('#bulkMsg').textContent = msg;
  $('#bulkBar').style.width = '100%';
  setTimeout(() => $('#bulkProgress').classList.add('hidden'), 4000);
}

// --- Category taxonomy management --------------------------------------------

let catTree = [];

function bindCategories() {
  $('#btnCategories').addEventListener('click', openCategories);
  $('#btnCategoryClose').addEventListener('click', closeCategories);
  $('#btnCategoryDone').addEventListener('click', closeCategories);
  $('#btnCategoryAdd').addEventListener('click', () => addCategory(null, $('#newCategoryName')));
  $('#newCategoryName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCategory(null, $('#newCategoryName')); }
  });
  $('#categoryModal').addEventListener('click', (e) => { if (e.target === $('#categoryModal')) closeCategories(); });
  $('#categoryTree').addEventListener('click', onCategoryTreeClick);
  $('#categoryTree').addEventListener('change', onCategoryTreeChange);
}

function openCategories() {
  $('#categoryModal').classList.remove('hidden');
  $('#categoryMsg').className = 'msg';
  $('#categoryMsg').textContent = '';
  $('#newCategoryName').value = '';
  loadCategoryTree();
}

function closeCategories() {
  $('#categoryModal').classList.add('hidden');
  // Refresh datalist/filter so renamed/added categories show up in the item modal.
  loadItems();
}

function setCategoryMsg(text, kind = '') {
  const msg = $('#categoryMsg');
  msg.className = `msg ${kind}`.trim();
  msg.textContent = text || '';
}

async function loadCategoryTree() {
  const box = $('#categoryTree');
  box.className = 'cat-tree loading';
  box.textContent = 'Loading…';
  try {
    const res = await fetch('/api/categories/tree');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load categories');
    catTree = data.tree || [];
    renderCategoryTree();
  } catch (e) {
    box.className = 'cat-tree loading err';
    box.textContent = e.message;
  }
}

function renderCategoryTree() {
  const box = $('#categoryTree');
  box.className = 'cat-tree';
  if (!catTree.length) {
    box.innerHTML = '<div class="loading">No categories yet. Add one above.</div>';
    return;
  }
  const parentOpts = catTree.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  box.innerHTML = catTree.map((parent, pi) => {
    const children = parent.children || [];
    const childRows = children.map((child, ci) => `
      <div class="cat-row cat-child" data-id="${child.id}">
        <span class="cat-name">${esc(child.name)}</span>
        <div class="cat-actions">
          <select class="cat-reparent" data-act="reparent" title="Move to another group">
            <option value="">(top level)</option>
            ${parentOpts.replace(`value="${parent.id}"`, `value="${parent.id}" selected`)}
          </select>
          <button type="button" data-act="up" title="Move up" ${ci === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" title="Move down" ${ci === children.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="rename" title="Rename">✎</button>
          <button type="button" data-act="delete" class="danger" title="Delete">×</button>
        </div>
      </div>`).join('');
    return `
      <div class="cat-parent" data-id="${parent.id}">
        <div class="cat-row cat-parent-row" data-id="${parent.id}">
          <span class="cat-name">${esc(parent.name)}</span>
          <div class="cat-actions">
            <button type="button" data-act="addchild" title="Add subcategory">+ Sub</button>
            <button type="button" data-act="up" title="Move up" ${pi === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" data-act="down" title="Move down" ${pi === catTree.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" data-act="rename" title="Rename">✎</button>
            <button type="button" data-act="delete" class="danger" title="Delete">×</button>
          </div>
        </div>
        ${children.length ? `<div class="cat-children">${childRows}</div>` : ''}
      </div>`;
  }).join('');
}

function findCategoryContext(id) {
  const sid = String(id);
  for (let pi = 0; pi < catTree.length; pi++) {
    const parent = catTree[pi];
    if (String(parent.id) === sid) return { node: parent, siblings: catTree, index: pi, isChild: false, parent: null };
    const children = parent.children || [];
    for (let ci = 0; ci < children.length; ci++) {
      if (String(children[ci].id) === sid) {
        return { node: children[ci], siblings: children, index: ci, isChild: true, parent };
      }
    }
  }
  return null;
}

function onCategoryTreeChange(e) {
  const select = e.target.closest('select[data-act="reparent"]');
  if (!select) return;
  const row = select.closest('[data-id]');
  reparentCategory(row.dataset.id, select.value);
}

function onCategoryTreeClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('[data-id]');
  const id = row.dataset.id;
  const act = btn.dataset.act;
  if (act === 'addchild') return addCategory(id);
  if (act === 'rename') return renameCategory(id);
  if (act === 'delete') return deleteCategoryRow(id);
  if (act === 'up') return moveCategory(id, -1);
  if (act === 'down') return moveCategory(id, 1);
}

async function addCategory(parentId, inputEl = null) {
  let name;
  if (inputEl) {
    name = inputEl.value.trim();
    if (!name) { inputEl.focus(); return; }
  } else {
    name = (window.prompt('New subcategory name:') || '').trim();
    if (!name) return;
  }
  const siblings = parentId == null ? catTree : (findCategoryContext(parentId)?.node.children || []);
  try {
    await apiCategory('POST', '', { name, parentId: parentId == null ? null : Number(parentId), sortOrder: siblings.length });
    if (inputEl) inputEl.value = '';
    setCategoryMsg(`Added “${name}”.`, 'ok');
    await loadCategoryTree();
  } catch (e) {
    setCategoryMsg(e.message, 'err');
  }
}

async function renameCategory(id) {
  const ctx = findCategoryContext(id);
  if (!ctx) return;
  const name = (window.prompt('Rename category:', ctx.node.name) || '').trim();
  if (!name || name === ctx.node.name) return;
  try {
    await apiCategory('PATCH', `/${id}`, { name });
    setCategoryMsg(`Renamed to “${name}”.`, 'ok');
    await loadCategoryTree();
  } catch (e) {
    setCategoryMsg(e.message, 'err');
  }
}

async function reparentCategory(id, parentValue) {
  try {
    await apiCategory('PATCH', `/${id}`, { parentId: parentValue === '' ? null : Number(parentValue) });
    setCategoryMsg('Moved category.', 'ok');
    await loadCategoryTree();
  } catch (e) {
    setCategoryMsg(e.message, 'err');
  }
}

async function deleteCategoryRow(id) {
  const ctx = findCategoryContext(id);
  if (!ctx) return;
  const childCount = (ctx.node.children || []).length;
  const warn = childCount
    ? ` Its ${childCount} subcategor${childCount === 1 ? 'y' : 'ies'} will move to the top level.`
    : '';
  if (!window.confirm(`Delete category “${ctx.node.name}”?${warn}`)) return;
  try {
    await apiCategory('DELETE', `/${id}`);
    setCategoryMsg('Category deleted.', 'ok');
    await loadCategoryTree();
  } catch (e) {
    setCategoryMsg(e.message, 'err');
  }
}

async function moveCategory(id, delta) {
  const ctx = findCategoryContext(id);
  if (!ctx) return;
  const target = ctx.index + delta;
  if (target < 0 || target >= ctx.siblings.length) return;
  const ordered = ctx.siblings.slice();
  const [moved] = ordered.splice(ctx.index, 1);
  ordered.splice(target, 0, moved);
  try {
    // Persist explicit sort order for every sibling so ties resolve deterministically.
    await Promise.all(ordered.map((node, i) => apiCategory('PATCH', `/${node.id}`, { sortOrder: i })));
    await loadCategoryTree();
  } catch (e) {
    setCategoryMsg(e.message, 'err');
  }
}

async function apiCategory(method, path, body) {
  const res = await fetch(`/api/categories${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
