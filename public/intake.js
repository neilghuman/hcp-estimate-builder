// Customer Intake — Sprint 1 front-end.
//
// Proves the foundation end-to-end: start a draft, edit the Step-2 customer fields, save (PATCH),
// and resume a recent draft. No validation, no HCP lookup, no submit yet — those come in later
// sprints. All state is the server-side draft row; this file is deliberately thin.

const CUSTOMER_FIELDS = [
  'first_name', 'last_name', 'phone', 'email',
  'address_street', 'address_unit', 'address_city', 'address_state', 'address_zip', 'address_place_id',
  'company', 'secondary_phone', 'address_notes',
];

let currentId = null; // public_id of the active draft
let draftPending = null; // in-flight ensureDraft(), so a burst of edits creates only one row
let writeEnabled = false; // HCP write gate (from /config)
let currentHcpLinked = false;
let formDirty = false; // Track whether current form state has unsaved changes

const $ = (id) => document.getElementById(id);

function showMsg(text, kind = 'info') {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = false;
  if (kind === 'success') setTimeout(() => { el.hidden = true; }, 2500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
  return data;
}

function setFormEnabled(on) {
  $('intakeForm').disabled = !on;
  $('btnSave').disabled = !on;
  $('hcpForm').disabled = !on;
  $('discoveryFieldset').disabled = !on;
  $('submitForm').disabled = !on;
}

// Mark the form as having unsaved changes
function markFormDirty() {
  ensureDraft().catch((e) => showMsg(e.message, 'error'));
  if (formDirty) return; // already dirty
  formDirty = true;
  const badge = $('draftBadge');
  if (badge) {
    badge.textContent = '● Unsaved changes';
    badge.className = 'badge warn';
    badge.hidden = false;
  }
}

// Mark the form as clean (all changes saved)
function markFormClean() {
  if (!formDirty) return; // already clean
  formDirty = false;
  const badge = $('draftBadge');
  if (badge) {
    badge.textContent = '✓ Saved';
    badge.className = 'badge ok';
    badge.hidden = false;
    setTimeout(() => { badge.hidden = true; }, 2000);
  }
}


// --- Address autocomplete (Google Places), ported from the public landscaping wizard ---
// Same idea as the wizard's useGooglePlaces hook, but plain JS/DOM since this page has no build
// step: fetch predictions for the street-address input and render our own dropdown under it
// (Google's PlaceAutocompleteElement uses a closed shadow-DOM list we can't style/position here).
let placesLoaded = null;
function loadGoogleMaps(apiKey) {
  if (placesLoaded) return placesLoaded;
  placesLoaded = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.places) return resolve();
    const id = 'google-maps-places';
    if (document.getElementById(id)) {
      const poll = setInterval(() => {
        if (window.google && window.google.maps && window.google.maps.places) { clearInterval(poll); resolve(); }
      }, 50);
      return;
    }
    const s = document.createElement('script');
    s.id = id;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return placesLoaded;
}

function parsePlaceComponents(place) {
  let streetNumber = '', route = '', city = '', state = '', zip = '';
  for (const c of (place.addressComponents || [])) {
    const t = c.types || [];
    if (t.includes('street_number')) streetNumber = c.longText || '';
    else if (t.includes('route')) route = c.longText || '';
    else if (t.includes('locality')) city = c.longText || '';
    else if (t.includes('sublocality_level_1') && !city) city = c.longText || '';
    else if (t.includes('administrative_area_level_1')) state = c.shortText || '';
    else if (t.includes('postal_code')) zip = c.longText || '';
  }
  return { street: [streetNumber, route].filter(Boolean).join(' '), city, state, zip };
}

async function initAddressAutocomplete(apiKey) {
  if (!apiKey) return; // no key configured — plain manual entry, no autocomplete.
  const input = $('address_street');
  const wrapper = input.parentElement;
  let menu = null;
  let sessionToken = null;
  let debounceTimer = null;

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('ul');
    menu.className = 'intake-ac-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    wrapper.appendChild(menu);
    return menu;
  }
  function hideMenu() { if (menu) { menu.innerHTML = ''; menu.hidden = true; } }

  try {
    await loadGoogleMaps(apiKey);
  } catch {
    return; // fail silent — manual entry still works.
  }
  const places = window.google.maps.places;
  const { AutocompleteSuggestion, AutocompleteSessionToken } = places;
  if (!AutocompleteSuggestion || !AutocompleteSessionToken) return;

  async function runSearch(value) {
    if (!value || value.trim().length < 3) { hideMenu(); return; }
    if (!sessionToken) sessionToken = new AutocompleteSessionToken();
    let res;
    try {
      res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: value, sessionToken, includedRegionCodes: ['us'],
      });
    } catch { hideMenu(); return; }
    const suggestions = (res && res.suggestions) || [];
    if (!suggestions.length) { hideMenu(); return; }
    const list = ensureMenu();
    list.innerHTML = '';
    for (const s of suggestions.slice(0, 6)) {
      const pred = s.placePrediction;
      const li = document.createElement('li');
      li.textContent = pred.text ? pred.text.text : '';
      li.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        hideMenu();
        const place = pred.toPlace();
        await place.fetchFields({ fields: ['addressComponents', 'id'] });
        const parsed = parsePlaceComponents(place);
        input.value = parsed.street;
        $('address_city').value = parsed.city;
        $('address_state').value = parsed.state;
        $('address_zip').value = parsed.zip;
        $('address_place_id').value = place.id || '';
        sessionToken = null; // spent
        renderFieldErrors(clientValidate());
      });
      list.appendChild(li);
    }
    list.hidden = false;
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 250);
  });
  input.addEventListener('blur', () => setTimeout(hideMenu, 150));
}


function selectedTag() {
  const checked = document.querySelector('input[name="customer_tag"]:checked');
  return checked ? checked.value : null;
}

function setSelectedTag(value) {
  const radios = document.querySelectorAll('input[name="customer_tag"]');
  for (const r of radios) r.checked = r.value === value;
}

function fillForm(row) {
  for (const f of CUSTOMER_FIELDS) {
    if ($(f)) $(f).value = row[f] == null ? '' : row[f];
  }
  setSelectedTag(row.customer_tag || '');
  if (discoverySchema.length) fillDiscovery(row);
}

function collectForm() {
  const patch = {};
  for (const f of CUSTOMER_FIELDS) patch[f] = $(f).value.trim() || null;
  patch.customer_tag = selectedTag();
  return patch;
}

function markActive(row) {
  currentId = row.public_id;
  formDirty = false; // Fresh load = clean state
  const badge = $('draftBadge');
  badge.hidden = false;
  badge.textContent = `Draft ${row.public_id.slice(0, 8)} · ${row.status}`;
  setFormEnabled(true);
  renderLinkState(row);
  refreshStepStatus();
  refreshDiscoveryStatus();
}

// Set up event listeners on customer fields to mark form as dirty
function setupFormDirtyTracking() {
  for (const f of CUSTOMER_FIELDS) {
    const el = $(f);
    if (el) {
      el.addEventListener('input', markFormDirty);
      el.addEventListener('change', markFormDirty);
    }
  }
  // Also track customer tag changes
  const tagInputs = document.querySelectorAll('input[name="customer_tag"]');
  for (const inp of tagInputs) {
    inp.addEventListener('change', markFormDirty);
  }
}

// --- Sprint 2: customer lookup + dedupe ---
let lookupTimer = null;

function renderLinkState(row) {
  currentHcpLinked = !!row.hcp_customer_id;
  const linked = $('custLinked');
  if (row.hcp_customer_id) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || '(existing customer)';
    $('custLinkedText').textContent = `✓ Linked to existing HCP customer: ${name} (${row.hcp_customer_id})`;
    linked.hidden = false;
    $('custMatches').innerHTML = ''; // hide suggestions once linked
  } else {
    linked.hidden = true;
  }
}

function lookupFields() {
  return {
    phone: $('phone').value.trim(),
    email: $('email').value.trim(),
    first_name: $('first_name').value.trim(),
    last_name: $('last_name').value.trim(),
  };
}

async function runLookup() {
  if (!currentId) return;
  // Don't suggest matches while already linked to a customer.
  if (!$('custLinked').hidden) return;
  const f = lookupFields();
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const box = $('custMatches');
  if (!qs) { box.innerHTML = ''; return; }
  try {
    const result = await api(`/api/intake/lookup?${qs}`);
    renderMatches(result);
  } catch (e) { box.innerHTML = `<div class="match-head">Lookup unavailable: ${escapeHtml(e.message)}</div>`; }
}

function renderMatches(result) {
  const box = $('custMatches');
  box.innerHTML = '';
  const list = (result.customers || []).slice(0, 6);
  if (!list.length) {
    box.innerHTML = '<div class="intake-match is-new">No existing customer found — a new one will be created on submit.</div>';
    return;
  }
  const head = document.createElement('div');
  head.className = 'match-head';
  head.textContent = `Possible existing customers (matched by ${result.matchedBy}) — link to avoid duplicates:`;
  box.appendChild(head);
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'intake-match';
    const addr = (c.addresses && c.addresses[0] && c.addresses[0].line) || '';
    row.innerHTML =
      `<span class="m-main"><span class="m-name">${escapeHtml(c.name)}</span>` +
      `<span class="m-meta">${escapeHtml([c.mobile, c.email, addr].filter(Boolean).join(' · '))}</span></span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Use this customer';
    btn.addEventListener('click', () => linkCustomer(c.id));
    row.appendChild(btn);
    box.appendChild(row);
  }
}

async function linkCustomer(hcpId) {
  if (!currentId) return;
  try {
    const row = await api(`/api/intake/drafts/${currentId}/link-customer`, {
      method: 'POST', body: { hcp_customer_id: hcpId },
    });
    fillForm(row);
    renderLinkState(row);
    showMsg('Linked to existing customer. Duplicate creation prevented.', 'success');
    loadRecent();
    refreshStepStatus();
  } catch (e) { showMsg(e.message, 'error'); }
}

async function unlinkCustomer() {
  if (!currentId) return;
  try {
    const row = await api(`/api/intake/drafts/${currentId}/new-customer`, { method: 'POST' });
    renderLinkState(row);
    showMsg('Marked as a new customer.', 'success');
    runLookup();
    loadRecent();
    refreshStepStatus();
  } catch (e) { showMsg(e.message, 'error'); }
}

// --- Sprint 3: client-side validation (mirrors the server for instant feedback) ---
function normPhoneValid(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return t.length === 10;
}
function emailValid(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

function customerFieldValues() {
  const o = {};
  for (const f of CUSTOMER_FIELDS) o[f] = $(f).value.trim();
  return o;
}

function clientValidate() {
  const f = customerFieldValues();
  const errors = {};
  if (!f.first_name) errors.first_name = 'First name is required.';
  if (!f.last_name) errors.last_name = 'Last name is required.';
  if (!f.address_street) errors.address_street = 'Street address is required.';
  if (!f.address_city) errors.address_city = 'City is required.';
  if (!f.address_state) errors.address_state = 'State is required.';
  if (!f.address_zip) errors.address_zip = 'ZIP code is required.';
  else if (!/^\d{5}$/.test(f.address_zip)) errors.address_zip = 'Enter a valid 5-digit ZIP code.';
  if (!f.phone) errors.phone = 'Phone is required.';
  else if (!normPhoneValid(f.phone)) errors.phone = 'Enter a valid 10-digit US phone.';
  if (!f.email) errors.email = 'Email is required.';
  else if (!emailValid(f.email)) errors.email = 'Enter a valid email address.';
  if (f.secondary_phone && !normPhoneValid(f.secondary_phone)) errors.secondary_phone = 'Enter a valid 10-digit US phone.';
  return errors;
}

const ERR_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address_street', 'address_city', 'address_state', 'address_zip', 'secondary_phone'];
function renderFieldErrors(errors) {
  for (const f of ERR_FIELDS) {
    const el = $(`err_${f}`);
    const inp = $(f);
    if (errors[f]) { el.textContent = errors[f]; el.hidden = false; inp.classList.add('invalid'); }
    else { el.textContent = ''; el.hidden = true; inp.classList.remove('invalid'); }
  }
}

// Authoritative step status from the server (fields + create-vs-reuse decision).
async function refreshStepStatus() {
  if (!currentId) return;
  try {
    const st = await api(`/api/intake/drafts/${currentId}/customer-status`);
    renderFieldErrors(st.errors || {});
    const el = $('stepStatus');
    if (st.complete) { el.textContent = '✓ Customer step complete'; el.className = 'intake-step ok'; }
    else { el.textContent = `• ${(st.reasons || []).join(' ')}`; el.className = 'intake-step warn'; }
  } catch { /* non-fatal */ }
}

// --- Sprint 5: discovery questions (schema-driven) ---
let discoverySchema = [];
let discoveryTimer = null;

function dqVisible(q, values) {
  if (!q.showIf) return true;
  return String(values[q.showIf.key] ?? '') === q.showIf.equals;
}

function buildDiscovery() {
  const form = $('discoveryForm');
  form.innerHTML = '';
  for (const q of discoverySchema) {
    const wrap = document.createElement('div');
    wrap.dataset.key = q.key;

    if (q.type === 'info') {
      wrap.className = 'dq-info';
      wrap.dataset.info = '1';
      wrap.textContent = q.text || '';
      form.appendChild(wrap);
      continue;
    }

    wrap.className = 'dq-field';
    if (q.script) {
      const s = document.createElement('div');
      s.className = 'dq-script';
      s.textContent = q.script;
      wrap.appendChild(s);
    }
    const label = document.createElement('label');
    label.setAttribute('for', `dq_${q.key}`);
    label.innerHTML = `${escapeHtml(q.label)}${q.required ? ' <span class="req">*</span>' : ''}`;
    wrap.appendChild(label);

    let control;
    if (q.type === 'select') {
      control = document.createElement('select');
      control.innerHTML = '<option value="">Select…</option>';
      for (const o of q.options) {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        control.appendChild(opt);
      }
    } else if (q.type === 'textarea') {
      control = document.createElement('textarea');
    } else {
      control = document.createElement('input');
      control.type = q.type === 'number' ? 'number' : 'text';
      if (q.type === 'number') control.min = '0';
    }
    control.id = `dq_${q.key}`;
    control.name = q.key;
    if (q.hint) control.placeholder = q.hint;

    const evt = q.type === 'select' ? 'change' : 'input';
    control.addEventListener(evt, () => {
      markFormDirty(); // Mark form as dirty when discovery answers change
      applyDiscoveryVisibility();
      clearTimeout(discoveryTimer);
      discoveryTimer = setTimeout(saveDiscovery, 400);
    });
    wrap.appendChild(control);

    const err = document.createElement('small');
    err.className = 'field-err';
    err.id = `dqerr_${q.key}`;
    err.hidden = true;
    wrap.appendChild(err);

    form.appendChild(wrap);
  }
}

function collectDiscovery() {
  const out = {};
  for (const q of discoverySchema) {
    if (q.type === 'info') continue;
    const el = $(`dq_${q.key}`);
    if (!el) continue;
    out[q.key] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}

function applyDiscoveryVisibility() {
  const values = collectDiscovery();
  for (const q of discoverySchema) {
    const wrap = $('discoveryForm').querySelector(`[data-key="${q.key}"]`);
    if (!wrap) continue;
    wrap.hidden = !dqVisible(q, values);
  }
}

function fillDiscovery(row) {
  for (const q of discoverySchema) {
    if (q.type === 'info') continue;
    const el = $(`dq_${q.key}`);
    if (el) el.value = row[q.key] == null ? '' : row[q.key];
  }
  applyDiscoveryVisibility();
}

async function saveDiscovery() {
  try {
    await ensureDraft();
    await api(`/api/intake/drafts/${currentId}`, { method: 'PATCH', body: collectDiscovery() });
    refreshDiscoveryStatus();
    loadRecent();
  } catch (e) { showMsg(e.message, 'error'); }
}

async function refreshDiscoveryStatus() {
  if (!currentId) return;
  try {
    const st = await api(`/api/intake/drafts/${currentId}/discovery-status`);
    for (const q of discoverySchema) {
      if (q.type === 'info') continue;
      const err = $(`dqerr_${q.key}`);
      const wrap = $('discoveryForm').querySelector(`[data-key="${q.key}"]`);
      if (!err || !wrap) continue;
      if (st.errors && st.errors[q.key]) { err.textContent = st.errors[q.key]; err.hidden = false; wrap.classList.add('dq-invalid'); }
      else { err.textContent = ''; err.hidden = true; wrap.classList.remove('dq-invalid'); }
    }
    const el = $('discoveryStatus');
    if (st.complete) { el.textContent = '✓ Discovery complete'; el.className = 'intake-step ok'; }
    else { el.textContent = `• ${(st.reasons || []).join(' ')}`; el.className = 'intake-step warn'; }
  } catch { /* non-fatal */ }
}

// The draft row is created on the first real edit, not on page load — otherwise merely opening
// or refreshing the page litters customer_intakes with empty rows.
async function ensureDraft() {
  if (currentId) return currentId;
  if (draftPending) return draftPending;
  draftPending = (async () => {
    const row = await api('/api/intake/drafts', { method: 'POST' });
    currentId = row.public_id;
    const badge = $('draftBadge');
    badge.hidden = false;
    badge.textContent = `Draft ${row.public_id.slice(0, 8)} · ${row.status}`;
    renderLinkState(row);
    loadRecent();
    return currentId;
  })();
  try {
    return await draftPending;
  } finally {
    draftPending = null;
  }
}

async function save() {
  renderFieldErrors(clientValidate());
  try {
    await ensureDraft();
    const row = await api(`/api/intake/drafts/${currentId}`, { method: 'PATCH', body: collectForm() });
    $('savedAt').textContent = `Saved ${new Date(row.updated_at).toLocaleTimeString()}`;
    markFormClean(); // Mark form as clean after successful save
    showMsg('✓ Your changes are saved. Ready to submit the intake.', 'success');
    loadRecent();
    refreshStepStatus();
  } catch (e) { showMsg(e.message, 'error'); }
}

async function loadDraft(idOrPublic) {
  try {
    const row = await api(`/api/intake/drafts/${idOrPublic}`);
    fillForm(row);
    markActive(row);
    showMsg('Draft loaded.', 'success');
  } catch (e) { showMsg(e.message, 'error'); }
}

async function loadRecent() {
  try {
    const { intakes } = await api('/api/intake/drafts?limit=15');
    const ul = $('recentList');
    ul.innerHTML = '';
    if (!intakes.length) {
      ul.innerHTML = '<li class="r-meta">No drafts yet.</li>';
      return;
    }
    for (const row of intakes) {
      const li = document.createElement('li');
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || '(no name)';
      const when = new Date(row.created_at).toLocaleString();
      li.innerHTML = `<span>${escapeHtml(name)}</span>` +
        `<span class="r-meta">${row.status} · ${escapeHtml(row.created_by || '—')} · ${when}</span>`;
      li.addEventListener('click', () => loadDraft(row.public_id));
      ul.appendChild(li);
    }
  } catch (e) { showMsg(e.message, 'error'); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Sprint 8: submit orchestration ---
// Visually highlight the Save & Continue button and show inline help text
function highlightSaveButton() {
  const btn = $('btnSave');
  // Remove highlight if it exists
  btn.classList.remove('highlight-pulse');
  // Trigger reflow to restart animation
  void btn.offsetWidth;
  // Add highlight class for pulse animation
  btn.classList.add('highlight-pulse');
  // Show inline help text
  const helpEl = document.createElement('div');
  helpEl.id = 'saveHelpInline';
  helpEl.className = 'intake-help-inline';
  helpEl.textContent = '↑ Please save your changes before submitting.';
  // Remove old help text if it exists
  const old = $('saveHelpInline');
  if (old) old.remove();
  // Insert after the button area
  btn.parentElement.insertAdjacentElement('afterend', helpEl);
  // Auto-remove help text after 5 seconds
  setTimeout(() => { if ($('saveHelpInline')) $('saveHelpInline').remove(); }, 5000);
}

async function submitIntake() {
  if (!currentId) { showMsg('Start an intake first.', 'error'); return; }
  
  // Check if form has unsaved changes
  if (formDirty) {
    showMsg('⚠ Please save your changes before submitting the intake.', 'error');
    // Scroll to Save & Continue button
    $('btnSave').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Highlight the button to draw attention
    highlightSaveButton();
    // Set keyboard focus for accessibility
    $('btnSave').focus();
    return;
  }
  
  try {
    const res = await api(`/api/intake/drafts/${currentId}/submit`, { method: 'POST', body: { dryRun: true } });
    renderSubmitPlan(res.plan, res.status);
  } catch (e) {
    if (e.reasons) showMsg(`${e.message} ${e.reasons.join(' ')}`, 'error');
    else showMsg(e.message, 'error');
  }
}

function renderSubmitPlan(plan, status) {
  const box = $('submitPlan');
  const sms = plan.sms || {};
  box.innerHTML =
    `<p class="plan-line"><strong>This will:</strong></p>` +
    `<ul>` +
    `<li>Customer: ${escapeHtml(plan.customer)}${plan.tag ? ` (tag: ${escapeHtml(plan.tag)})` : ''}</li>` +
    `<li>Estimate: ${escapeHtml(plan.estimate)}</li>` +
    `<li>Private notes: ${escapeHtml(plan.notes)}</li>` +
    `<li>SMS: ${sms.ready ? `to ${escapeHtml((sms.recipients || []).join(', '))}` : 'skipped (Chatwoot/inbox not configured)'}</li>` +
    `</ul>`;
  const note = document.createElement('p');
  note.className = 'plan-line';
  note.innerHTML = writeEnabled
    ? 'Writing to Housecall Pro is <strong>enabled</strong>. Confirm to submit.'
    : 'Writing is <strong>disabled</strong> (INTAKE_WRITE_ENABLED). Preview only.';
  box.appendChild(note);
  const actions = document.createElement('div');
  actions.className = 'plan-actions';
  const confirm = document.createElement('button');
  confirm.className = 'primary';
  confirm.textContent = 'Confirm & submit';
  confirm.disabled = !writeEnabled;
  confirm.addEventListener('click', confirmSubmit);
  const cancel = document.createElement('button');
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { box.hidden = true; });
  actions.appendChild(confirm);
  actions.appendChild(cancel);
  box.appendChild(actions);
  box.hidden = false;
}

async function confirmSubmit() {
  const btn = $('btnSubmit');
  btn.disabled = true; // prevent double-click double-submit
  try {
    const res = await api(`/api/intake/drafts/${currentId}/submit`, { method: 'POST', body: { confirm: true } });
    $('submitPlan').hidden = true;
    const el = $('submitStatus');
    el.textContent = res.status === 'completed' ? '✓ Submitted' : `• ${res.status}`;
    el.className = `intake-step ${res.status === 'completed' ? 'ok' : 'warn'}`;
    showMsg(res.alreadyCompleted ? 'Already submitted.' : `Intake ${res.status}.`, res.status === 'completed' ? 'success' : 'error');
    const row = await api(`/api/intake/drafts/${currentId}`);
    fillForm(row);
    renderLinkState(row);
    const linkBox = $('estimateLink');
    if (row.hcp_estimate_url) {
      linkBox.innerHTML = `<a href="${escapeHtml(row.hcp_estimate_url)}" target="_blank" rel="noopener" class="estimate-link">View estimate in Housecall Pro →</a>`;
      linkBox.hidden = false;
    } else {
      linkBox.hidden = true;
    }
    loadRecent();
  } catch (e) {
    // Show per-step failure detail when present.
    showMsg(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  try {
    const cfg = await api('/api/intake/config');
    if (!cfg.enabled) { showMsg('Customer Intake is currently disabled.', 'error'); return; }
    writeEnabled = cfg.writeEnabled === true;
    $('writeGate').textContent = writeEnabled ? 'HCP writes: ON' : 'HCP writes: OFF (preview)';
    const n = cfg.notify || {};
    $('notifyGate').textContent = n.configured ? (n.inbox ? 'Chatwoot: ready' : 'Chatwoot: no inbox') : 'Chatwoot: off';
    initAddressAutocomplete(cfg.googleMapsKey);
  } catch (e) { showMsg(e.message, 'error'); return; }

  $('btnSave').addEventListener('click', save);
  $('btnRefresh').addEventListener('click', loadRecent);
  $('btnUnlink').addEventListener('click', unlinkCustomer);
  $('btnSubmit').addEventListener('click', submitIntake);
  for (const f of ['phone', 'email', 'first_name', 'last_name']) {
    $(f).addEventListener('input', () => {
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(runLookup, 400);
    });
  }
  for (const f of ERR_FIELDS) {
    $(f).addEventListener('blur', () => renderFieldErrors(clientValidate()));
  }
  await loadDiscoverySchema();
  loadRecent();
  setupFormDirtyTracking();

  const params = new URLSearchParams(window.location.search);
  const draftId = params.get('t');
  if (draftId) {
    await loadDraft(draftId);
  } else {
    setFormEnabled(true);
    $('first_name').focus();
  }
}

async function loadDiscoverySchema() {
  try {
    const { questions } = await api('/api/intake/discovery-schema');
    discoverySchema = questions || [];
    buildDiscovery();
  } catch (e) { showMsg(e.message, 'error'); }
}

init();
