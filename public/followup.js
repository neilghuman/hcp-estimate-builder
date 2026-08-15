// Follow-up drip dashboard.
// Read-only by default; when DRIP_CONFIG_EDIT_ENABLED is on, staff can edit message copy, toggle
// sequences, and pause sends. The server validates + versions every write; the client mirrors the
// SMS-segment / validation logic only for live feedback while typing.

const $ = (id) => document.getElementById(id);
const state = { cfg: {}, sequences: [], paused: false, stepStats: [], variantStats: [], taxonomy: [], suppressions: [] };
const getEditor = () => localStorage.getItem('fu-editor') || '';

function showMsg(text, kind = 'error') {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = false;
  if (kind === 'success') setTimeout(() => { el.hidden = true; }, 2200);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error((data && data.error) || `${path} failed (${res.status})`); e.data = data; throw e; }
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function offsetLabel(min) {
  const m = Number(min);
  if (m === 0) return { text: 'initial send', t0: true };
  if (m < 60) return { text: `+${m} min`, t0: false };
  if (m < 1440) { const h = m / 60; return { text: `+${Number.isInteger(h) ? h : h.toFixed(1)} hr`, t0: false }; }
  const d = m / 1440;
  return { text: `+${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`, t0: false };
}

function fmtDue(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
}

// ---- client-side SMS + validation (mirror of server src/drip.js) ----
const GSM_BASIC = new Set(('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà').split(''));
const GSM_EXT = new Set('^{}\\[~]|€'.split(''));
function smsSegments(text) {
  const chars = Array.from(String(text || ''));
  let gsm = true; let septets = 0;
  for (const c of chars) { if (GSM_BASIC.has(c)) septets += 1; else if (GSM_EXT.has(c)) septets += 2; else { gsm = false; break; } }
  if (gsm) {
    const units = septets; const segments = units === 0 ? 0 : (units <= 160 ? 1 : Math.ceil(units / 153));
    return { encoding: 'GSM-7', units, segments };
  }
  const units = chars.length; const segments = units === 0 ? 0 : (units <= 70 ? 1 : Math.ceil(units / 67));
  return { encoding: 'UCS-2', units, segments };
}
function validateMessage(body, includeOptout) {
  const issues = []; const text = String(body || ''); const trimmed = text.trim();
  if (!trimmed) { issues.push({ level: 'error', message: 'Message body cannot be empty.' }); return issues; }
  const hasStop = /\bstop\b/i.test(text);
  if (includeOptout && !hasStop) issues.push({ level: 'error', message: 'Marked as carrying an opt-out, but the body has no "STOP" instruction.' });
  if (!includeOptout && hasStop) issues.push({ level: 'warn', message: 'Body mentions "STOP" but the opt-out flag is off — turn the flag on.' });
  const { segments } = smsSegments(text);
  if (segments >= 3) issues.push({ level: 'warn', message: `This is ${segments} SMS segments — consider shortening to 1–2.` });
  const unknown = (text.match(/\{(\w+)\}/g) || []).filter((p) => !['{name}', '{service}', '{Business}'].includes(p));
  if (unknown.length) issues.push({ level: 'warn', message: `Unknown placeholder(s): ${[...new Set(unknown)].join(', ')}.` });
  return issues;
}
function renderBody(body, vars) { return String(body || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)); }
function sampleVars(vertical, category) {
  const service = category ? String(category).replace(/_/g, ' ') : 'grading';
  return { name: 'Sarah', service, Business: vertical === 'tree' ? 'Washington Tree Services' : vertical === 'landscaping' ? 'Washington Landscaping' : 'our team' };
}
function findMessage(id) {
  for (const s of state.sequences) for (const st of s.steps || []) for (const m of st.messages || []) if (String(m.id) === String(id)) return { seq: s, step: st, msg: m };
  return null;
}
function findStep(id) {
  for (const s of state.sequences) for (const st of s.steps || []) if (String(st.id) === String(id)) return { seq: s, step: st };
  return null;
}
function sentFor(seqKey, step) {
  const row = (state.stepStats || []).find((s) => s.sequence_key === seqKey && Number(s.step) === Number(step));
  return row ? row.sent : 0;
}

function renderStatus() {
  const cfg = state.cfg;
  const chip = (label, on) => `<span class="fu-chip ${on ? 'on' : 'off'}"><span class="dot"></span>${esc(label)}: ${on ? 'on' : 'off'}</span>`;
  const pauseChip = `<span class="fu-chip ${state.paused ? 'warn' : 'on'}"><span class="dot"></span>Sends: ${state.paused ? 'PAUSED' : 'running'}</span>`;
  $('statusChips').innerHTML = [
    chip('Feature', cfg.enabled),
    chip('Enrollment writes', cfg.writeEnabled),
    chip('Sending', cfg.sendEnabled),
    chip('Editing', cfg.editEnabled),
    pauseChip,
  ].join('');

  const bar = $('editBar');
  if (!cfg.editEnabled) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <label>Editing as <input type="text" id="editorName" placeholder="your name" value="${esc(getEditor())}" /></label>
    <button class="fu-btn ${state.paused ? 'ok' : 'danger'}" id="btnPause">${state.paused ? '▶ Resume sends' : '⏸ Pause all sends'}</button>`;
  $('editorName').addEventListener('change', (e) => localStorage.setItem('fu-editor', e.target.value.trim()));
  $('btnPause').addEventListener('click', togglePause);
}

function renderStats(report) {
  const badges = (rows, keyField, countField) => (!rows || rows.length === 0)
    ? '<span class="hint">none</span>'
    : rows.map((r) => `<span class="fu-badge"><b>${esc(r[countField])}</b> ${esc(r[keyField] || '—')}</span>`).join('');
  $('byStatus').innerHTML = badges(report.byStatus, 'status', 'n');
  $('byExit').innerHTML = badges(report.byExit, 'exit_reason', 'n');
}

function renderOutcomes(o) {
  o = o || {};
  const total = Number(o.total) || 0;
  const rate = total ? Math.round(((Number(o.replied) || 0) / total) * 100) : 0;
  if (total === 0) { $('outcomes').innerHTML = '<span class="hint">No enrollments yet — metrics appear once leads are enrolled.</span>'; return; }
  const tile = (label, val) => `<div class="fu-tile"><div class="fu-tile-n">${esc(val)}</div><div class="fu-tile-l">${esc(label)}</div></div>`;
  $('outcomes').innerHTML = [
    tile('enrolled', total),
    tile('replied', `${o.replied || 0} (${rate}%)`),
    tile('completed', o.completed || 0),
    tile('active', o.active || 0),
    tile('handled', o.handled || 0),
    tile('dropped', o.dropped || 0),
    tile('avg touches → reply', o.avg_touches_to_reply ?? '—'),
  ].join('');
}

function msgInnerHTML(m) {
  const isCat = m.category_key != null;
  const label = isCat
    ? `Category: ${esc(m.category_key)}${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`
    : `Default${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`;
  const optout = m.include_optout ? '<span class="fu-optout">✓ opt-out</span>' : '';
  const inactive = m.is_active === false ? ' <span class="fu-pill off">off</span>' : '';
  const ver = m.version ? `<span class="fu-ver">v${esc(m.version)}</span>` : '';
  const wt = Number(m.weight) > 1 ? `<span class="fu-ver">weight ${esc(m.weight)}</span>` : '';
  const versionsBtn = (state.cfg.editEnabled && Number(m.version) > 1)
    ? `<button class="fu-btn fu-versions" data-versions="${esc(m.id)}">🕘 Versions</button>` : '';
  const actions = state.cfg.editEnabled ? `<div class="fu-msg-actions">
    <button class="fu-btn fu-edit" data-edit="${esc(m.id)}">✎ Edit</button>
    <button class="fu-btn fu-add-variant" data-add-variant="${esc(m.id)}">＋ Variant</button>
    ${versionsBtn}
    <button class="fu-btn danger fu-msg-del" data-del="${esc(m.id)}" title="Delete this message">🗑</button>
  </div>` : '';
  return `<div class="fu-msg-label">${label}${optout}${inactive}${ver}${wt}</div><div class="fu-msg-text">${esc(m.body)}</div>${actions}`;
}

function renderSequences() {
  const sequences = state.sequences;
  if (!sequences || sequences.length === 0) { $('sequences').innerHTML = '<p class="hint">No sequences configured.</p>'; return; }
  $('sequences').innerHTML = sequences.map((seq) => {
    const toggle = state.cfg.editEnabled
      ? `<button class="fu-btn fu-seq-toggle ${seq.is_active ? 'danger' : 'ok'}" data-seq="${esc(seq.id)}" data-active="${seq.is_active ? '1' : '0'}">${seq.is_active ? 'Deactivate' : 'Activate'}</button>`
      : '';
    const activePill = seq.is_active ? '<span class="fu-pill on">active</span>' : '<span class="fu-pill off">inactive</span>';
    const meta = [
      `source: ${esc(seq.source)}`, `vertical: ${esc(seq.vertical || 'any')}`, `channel: ${esc(seq.channel)}`,
      `max: ${esc(seq.max_messages)}`, `expires: ${esc(Math.round(seq.expires_after_hours / 24))}d`,
      `hours: ${esc(String(seq.quiet_start_local).slice(0, 5))}\u2013${esc(String(seq.quiet_end_local).slice(0, 5))} ${esc(seq.tz_default)}`,
      `variants: ${esc(seq.variant_strategy)}`,
    ].map((m) => `<span>${m}</span>`).join('');

    const steps = (seq.steps || []).map((st) => {
      const when = offsetLabel(st.offset_minutes);
      const sent = sentFor(seq.key, st.step_index);
      const sentBadge = sent ? `<span class="fu-sent">sent ${esc(sent)}</span>` : '';
      const stepEdit = state.cfg.editEnabled ? `<button class="fu-btn fu-step-edit" data-step="${esc(st.id)}">⏱ Timing</button>` : '';
      const addCat = state.cfg.editEnabled ? `<button class="fu-btn fu-add-cat" data-add-cat="${esc(st.id)}">＋ Category copy</button>` : '';
      const delStep = state.cfg.editEnabled ? `<button class="fu-btn danger fu-step-del" data-step-del="${esc(st.id)}" title="Delete this step">🗑</button>` : '';
      const msgs = (st.messages || []).map((m) => `<div class="fu-msg ${m.category_key != null ? 'cat' : ''}" data-msg="${esc(m.id)}">${msgInnerHTML(m, seq.key, st.step_index)}</div>`).join('');
      return `
        <div class="fu-step">
          <div class="fu-step-head" data-step-head="${esc(st.id)}">
            <span class="fu-step-idx">${esc(st.step_index)}</span>
            <span class="fu-step-when">${when.t0 ? '<span class="fu-t0">' + when.text + '</span>' : when.text}</span>
            ${st.is_active === false ? '<span class="fu-pill off">step off</span>' : ''}
            ${sentBadge}
            ${stepEdit}
            ${addCat}
            ${delStep}
          </div>
          ${msgs || '<p class="hint">No message for this step.</p>'}
        </div>`;
    }).join('');

    const settingsBtn = state.cfg.editEnabled ? `<button class="fu-btn fu-seq-settings" data-seq-settings="${esc(seq.id)}">⚙ Settings</button>` : '';
    const addStepBtn = state.cfg.editEnabled ? `<button class="fu-btn fu-seq-add-step" data-seq-add-step="${esc(seq.id)}">＋ Step</button>` : '';
    return `
      <div class="fu-seq">
        <div class="fu-seq-head">
          <h3>${esc(seq.name)}</h3>
          ${activePill}
          <code>${esc(seq.key)}</code>
          ${toggle}
          ${settingsBtn}
          ${addStepBtn}
        </div>
        <div class="fu-seq-head fu-seq-meta" data-seq-meta="${esc(seq.id)}">${meta}</div>
        <div class="fu-steps" data-seq-steps="${esc(seq.id)}">${steps}</div>
      </div>`;
  }).join('');
}

// ---- Message editor (shared by edit + add-variant + add-category) ----
function editorMarkup(o) {
  const catList = [...new Set((state.taxonomy || []).map((t) => t.category_key))].map((k) => `<option value="${esc(k)}"></option>`).join('');
  const categoryField = o.showCategory
    ? `<label class="fu-ed-inline">Category <input type="text" class="fu-ed-cat" list="fu-cat-list" placeholder="stump_grinding" value="${esc(o.category || '')}" /></label><datalist id="fu-cat-list">${catList}</datalist>`
    : '';
  const variantField = o.showVariant ? `<label class="fu-ed-inline">Variant <input type="text" class="fu-ed-variant" placeholder="B" value="${esc(o.variantDefault || '')}" /></label>` : '';
  const activeField = o.showActive ? `<label><input type="checkbox" class="fu-ed-active" ${o.active ? 'checked' : ''}/> Active</label>` : '';
  const editingAttr = o.editingId != null ? ` data-editing="${esc(o.editingId)}"` : '';
  return `
    <div class="fu-editor" data-vertical="${esc(o.vertical || '')}" data-category="${esc(o.category || '')}"${editingAttr}>
      <textarea class="fu-ed-body">${esc(o.body || '')}</textarea>
      <div class="fu-ed-row">
        ${categoryField}
        ${variantField}
        <label><input type="checkbox" class="fu-ed-optout" ${o.optout ? 'checked' : ''}/> Carries opt-out (STOP)</label>
        ${activeField}
        <label class="fu-ed-inline">Weight <input type="number" min="1" step="1" class="fu-ed-weight" value="${esc(o.weight || 1)}" /></label>
      </div>
      <div class="fu-ed-meta"><span class="fu-ed-seg"></span></div>
      <ul class="fu-issues"></ul>
      <div class="fu-preview"><div class="fu-preview-label">Preview (sample values)</div><div class="fu-preview-body"></div></div>
      <div class="fu-msg-actions">
        <button class="fu-btn primary ${o.saveClass}" ${o.saveAttr}>${o.saveLabel}</button>
        <button class="fu-btn fu-cancel">Cancel</button>
      </div>
    </div>`;
}

function openEditor(id) {
  const found = findMessage(id); if (!found) return;
  const { msg, seq } = found;
  const node = document.querySelector(`[data-msg="${id}"]`);
  node.innerHTML = editorMarkup({
    editingId: id, vertical: seq.vertical, category: msg.category_key,
    body: msg.body, optout: msg.include_optout, active: msg.is_active !== false, weight: msg.weight,
    showActive: true, showVariant: false, saveClass: 'fu-save', saveAttr: `data-save="${esc(id)}"`, saveLabel: 'Save',
  });
  updateEditorFeedback(node);
  node.querySelector('.fu-ed-body').focus();
}

function openAddVariant(msgId) {
  const found = findMessage(msgId); if (!found) return;
  const { msg, step, seq } = found;
  const host = document.querySelector(`[data-msg="${msgId}"]`);
  const wrap = document.createElement('div');
  wrap.className = 'fu-msg fu-add-host';
  wrap.innerHTML = editorMarkup({
    vertical: seq.vertical, category: msg.category_key, body: '', optout: false, weight: 1,
    showActive: false, showVariant: true, saveClass: 'fu-add-save',
    saveAttr: `data-add-step="${esc(step.id)}" data-add-cat="${esc(msg.category_key || '')}"`, saveLabel: 'Add variant',
  });
  host.after(wrap);
  updateEditorFeedback(wrap);
  wrap.querySelector('.fu-ed-variant').focus();
}

function openAddCategory(stepId) {
  const found = findStep(stepId); if (!found) return;
  const stepDiv = document.querySelector(`[data-step-head="${stepId}"]`).closest('.fu-step');
  const wrap = document.createElement('div');
  wrap.className = 'fu-msg fu-add-host';
  wrap.innerHTML = editorMarkup({
    vertical: found.seq.vertical, category: '', body: '', optout: false, weight: 1, variantDefault: 'A',
    showActive: false, showVariant: true, showCategory: true, saveClass: 'fu-cat-save',
    saveAttr: `data-cat-step="${esc(stepId)}"`, saveLabel: 'Add category copy',
  });
  stepDiv.appendChild(wrap);
  updateEditorFeedback(wrap);
  wrap.querySelector('.fu-ed-cat').focus();
}

async function saveAddCategory(btn, node) {
  const stepId = Number(btn.dataset.catStep);
  const categoryKey = node.querySelector('.fu-ed-cat').value.trim();
  const variant = node.querySelector('.fu-ed-variant').value.trim() || 'A';
  const body = node.querySelector('.fu-ed-body').value;
  const includeOptout = node.querySelector('.fu-ed-optout').checked;
  const weight = Number(node.querySelector('.fu-ed-weight').value) || 1;
  if (!categoryKey) { showMsg('Enter a category key.'); return; }
  try {
    await api('/api/drip/message', { method: 'POST', body: { stepId, categoryKey, variant, body, includeOptout, weight, changedBy: getEditor() || undefined } });
    await reloadSequences();
    showMsg(`Category copy for "${categoryKey}" added.`, 'success');
  } catch (e) { showMsg(e.message); }
}

function updateEditorFeedback(node) {
  const ed = node.querySelector('.fu-editor');
  const vertical = ed?.dataset.vertical || null;
  const category = ed?.dataset.category || null;
  const body = node.querySelector('.fu-ed-body').value;
  const optout = node.querySelector('.fu-ed-optout').checked;
  const seg = smsSegments(body);
  node.querySelector('.fu-ed-seg').innerHTML = `<b>${seg.segments}</b> SMS segment${seg.segments === 1 ? '' : 's'} · ${seg.units} chars · ${seg.encoding}`;
  const issues = validateMessage(body, optout);
  node.querySelector('.fu-issues').innerHTML = issues.map((i) => `<li class="fu-issue ${i.level}">${i.level === 'error' ? '✕' : '⚠'} ${esc(i.message)}</li>`).join('');
  node.querySelector('.fu-preview-body').textContent = renderBody(body, sampleVars(vertical, category));
  const hasError = issues.some((i) => i.level === 'error');
  const saveBtn = node.querySelector('.fu-save, .fu-add-save');
  if (saveBtn) saveBtn.disabled = hasError;
}

async function reloadSequences() {
  const detail = await api('/api/drip/sequences');
  state.sequences = detail.sequences || [];
  renderSequences();
}

// ---- Sequence + step builder ----
function renderSeqNew() {
  const el = $('seqNew');
  if (!state.cfg.editEnabled) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<button class="fu-btn primary" id="btnNewSeq">＋ New sequence</button>';
  $('btnNewSeq').addEventListener('click', openNewSequence);
}

function openNewSequence() {
  const strat = ['random', 'round_robin', 'weighted_ab'].map((s) => `<option value="${s}">${s}</option>`).join('');
  $('seqNew').innerHTML = `
    <div class="fu-seq-settings fu-newseq">
      <label>Key <input type="text" class="ns-key" placeholder="thumbtack_landscaping" /></label>
      <label>Name <input type="text" class="ns-name" placeholder="Thumbtack (Landscaping)" /></label>
      <label>Source <select class="ns-source"><option value="thumbtack">thumbtack</option><option value="google_lsa">google_lsa</option><option value="any">any</option></select></label>
      <label>Vertical <input type="text" class="ns-vertical" placeholder="landscaping" /></label>
      <label>Max msgs <input type="number" min="1" max="20" class="ns-max" value="7" /></label>
      <label>Quiet start <input type="time" class="ns-qs" value="08:00" /></label>
      <label>Quiet end <input type="time" class="ns-qe" value="20:00" /></label>
      <label>Expiry hrs <input type="number" min="1" max="720" class="ns-exp" value="168" /></label>
      <label>Variants <select class="ns-strat">${strat}</select></label>
      <button class="fu-btn primary" id="btnCreateSeq">Create (inactive)</button>
      <button class="fu-btn" id="btnCancelSeq">Cancel</button>
    </div>
    <p class="hint">New sequences start <strong>inactive</strong> and empty — add steps, then activate. Enrolling leads into it also needs an n8n hook for that source.</p>`;
  $('btnCreateSeq').addEventListener('click', saveNewSequence);
  $('btnCancelSeq').addEventListener('click', renderSeqNew);
}

async function saveNewSequence() {
  const el = $('seqNew');
  const g = (c) => el.querySelector(c).value.trim();
  const body = {
    key: g('.ns-key'), name: g('.ns-name'), source: el.querySelector('.ns-source').value, vertical: g('.ns-vertical') || undefined,
    maxMessages: Number(el.querySelector('.ns-max').value), quietStart: el.querySelector('.ns-qs').value,
    quietEnd: el.querySelector('.ns-qe').value, expiresAfterHours: Number(el.querySelector('.ns-exp').value),
    variantStrategy: el.querySelector('.ns-strat').value, changedBy: getEditor() || undefined,
  };
  try {
    await api('/api/drip/sequence', { method: 'POST', body });
    await load();
    showMsg(`Sequence "${body.key}" created (inactive).`, 'success');
  } catch (e) { showMsg(e.message); }
}

function openAddStep(seqId) {
  const seq = state.sequences.find((s) => String(s.id) === String(seqId)); if (!seq) return;
  const nextIdx = (seq.steps || []).reduce((mx, s) => Math.max(mx, Number(s.step_index)), -1) + 1;
  const stepsDiv = document.querySelector(`[data-seq-steps="${seqId}"]`);
  const wrap = document.createElement('div');
  wrap.className = 'fu-step fu-addstep-host';
  wrap.innerHTML = `
    <div class="fu-step-editor">
      <label class="fu-step-ed">Step # <input type="number" min="0" class="as-idx" value="${esc(nextIdx)}" /></label>
      <label class="fu-step-ed">offset (min from T0) <input type="number" min="0" class="as-offset" value="0" /></label>
      <label class="fu-step-ed"><input type="checkbox" class="as-optout" /> opt-out</label>
      <textarea class="fu-ed-body as-body" placeholder="Default message body (uses {name}, {service}, {Business})"></textarea>
      <div class="fu-msg-actions">
        <button class="fu-btn primary fu-addstep-save" data-addstep-seq="${esc(seqId)}">Add step</button>
        <button class="fu-btn fu-step-cancel">Cancel</button>
      </div>
    </div>`;
  stepsDiv.appendChild(wrap);
  wrap.querySelector('.as-body').focus();
}

async function saveAddStep(btn, node) {
  const sequenceId = Number(btn.dataset.addstepSeq);
  const stepIndex = Number(node.querySelector('.as-idx').value);
  const offsetMinutes = Number(node.querySelector('.as-offset').value);
  const includeOptout = node.querySelector('.as-optout').checked;
  const body = node.querySelector('.as-body').value.trim();
  if (!body) { showMsg('Enter the default message body for the step.'); return; }
  try {
    await api('/api/drip/step', { method: 'POST', body: { sequenceId, stepIndex, offsetMinutes, body, includeOptout, changedBy: getEditor() || undefined } });
    await reloadSequences();
    showMsg(`Step ${stepIndex} added.`, 'success');
  } catch (e) { showMsg(e.message); }
}

async function deleteStepUI(id) {
  try {
    await api(`/api/drip/step/${id}`, { method: 'DELETE' });
    await reloadSequences();
    showMsg('Step removed.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function saveMessage(id, node) {
  const body = node.querySelector('.fu-ed-body').value;
  const includeOptout = node.querySelector('.fu-ed-optout').checked;
  const isActive = node.querySelector('.fu-ed-active').checked;
  const weight = Number(node.querySelector('.fu-ed-weight').value) || undefined;
  try {
    const out = await api(`/api/drip/message/${id}`, { method: 'PUT', body: { body, includeOptout, isActive, weight, changedBy: getEditor() || undefined } });
    const found = findMessage(id);
    if (found && out.message) Object.assign(found.msg, out.message);
    renderSequences();
    showMsg(out.versioned ? `Saved — now v${out.message.version}.` : 'Saved.', 'success');
  } catch (e) {
    showMsg(e.message);
  }
}

async function saveNewMessage(btn, node) {
  const stepId = Number(btn.dataset.addStep);
  const categoryKey = btn.dataset.addCat || null;
  const variant = node.querySelector('.fu-ed-variant').value.trim();
  const body = node.querySelector('.fu-ed-body').value;
  const includeOptout = node.querySelector('.fu-ed-optout').checked;
  const weight = Number(node.querySelector('.fu-ed-weight').value) || 1;
  try {
    await api('/api/drip/message', { method: 'POST', body: { stepId, categoryKey, variant, body, includeOptout, weight, changedBy: getEditor() || undefined } });
    await reloadSequences();
    showMsg(`Variant "${variant}" added.`, 'success');
  } catch (e) { showMsg(e.message); }
}

async function deleteMessageUI(id) {
  try {
    await api(`/api/drip/message/${id}`, { method: 'DELETE' });
    await reloadSequences();
    showMsg('Message removed.', 'success');
  } catch (e) { showMsg(e.message); }
}

// ---- Message version history + revert ----
async function openHistory(id) {
  const node = document.querySelector(`[data-msg="${id}"]`);
  try {
    const { history } = await api(`/api/drip/message/${id}/history`);
    const rows = (history || []).map((h) => `
      <div class="fu-hist-row">
        <div class="fu-hist-meta">v${esc(h.version)} · ${esc(h.changed_by || 'unknown')} · ${fmtDue(h.changed_at)}</div>
        <div class="fu-hist-body">${esc(h.body)}</div>
        <button class="fu-btn fu-revert" data-revert="${esc(id)}" data-version="${esc(h.version)}">↩ Revert to v${esc(h.version)}</button>
      </div>`).join('');
    node.innerHTML = `
      <div class="fu-history">
        <div class="fu-msg-label">Version history</div>
        ${rows || '<p class="hint">No prior versions.</p>'}
        <div class="fu-msg-actions"><button class="fu-btn fu-cancel">Close</button></div>
      </div>`;
  } catch (e) { showMsg(e.message); }
}

async function revertMessageUI(id, version) {
  try {
    const out = await api(`/api/drip/message/${id}/revert`, { method: 'POST', body: { version: Number(version), changedBy: getEditor() || undefined } });
    await reloadSequences();
    showMsg(`Reverted to v${version} (now v${out.message.version}).`, 'success');
  } catch (e) { showMsg(e.message); }
}

async function toggleSequence(id, makeActive) {
  try {
    const out = await api(`/api/drip/sequence/${id}`, { method: 'PUT', body: { isActive: makeActive } });
    const seq = state.sequences.find((s) => String(s.id) === String(id));
    if (seq && out.sequence) seq.is_active = out.sequence.is_active;
    renderSequences();
    showMsg(`Sequence ${makeActive ? 'activated' : 'deactivated'}.`, 'success');
  } catch (e) { showMsg(e.message); }
}

// ---- Sequence settings editor ----
function openSeqSettings(id) {
  const seq = state.sequences.find((s) => String(s.id) === String(id)); if (!seq) return;
  const meta = document.querySelector(`[data-seq-meta="${id}"]`);
  const strat = ['random', 'round_robin', 'weighted_ab']
    .map((s) => `<option value="${s}" ${seq.variant_strategy === s ? 'selected' : ''}>${s}</option>`).join('');
  meta.innerHTML = `
    <div class="fu-seq-settings">
      <label>Max msgs <input type="number" min="1" max="20" class="fs-max" value="${esc(seq.max_messages)}" /></label>
      <label>Quiet start <input type="time" class="fs-qs" value="${esc(String(seq.quiet_start_local).slice(0, 5))}" /></label>
      <label>Quiet end <input type="time" class="fs-qe" value="${esc(String(seq.quiet_end_local).slice(0, 5))}" /></label>
      <label>Expiry hrs <input type="number" min="1" max="720" class="fs-exp" value="${esc(seq.expires_after_hours)}" /></label>
      <label>Variants <select class="fs-strat">${strat}</select></label>
      <button class="fu-btn primary fu-seq-set-save" data-seq-set-save="${esc(id)}">Save</button>
      <button class="fu-btn fu-seq-set-cancel">Cancel</button>
    </div>`;
}
async function saveSeqSettings(id, meta) {
  const body = {
    maxMessages: Number(meta.querySelector('.fs-max').value),
    quietStart: meta.querySelector('.fs-qs').value,
    quietEnd: meta.querySelector('.fs-qe').value,
    expiresAfterHours: Number(meta.querySelector('.fs-exp').value),
    variantStrategy: meta.querySelector('.fs-strat').value,
  };
  try {
    const out = await api(`/api/drip/sequence/${id}`, { method: 'PUT', body });
    const seq = state.sequences.find((s) => String(s.id) === String(id));
    if (seq && out.sequence) {
      seq.max_messages = out.sequence.max_messages;
      seq.expires_after_hours = out.sequence.expires_after_hours;
      seq.quiet_start_local = out.sequence.quiet_start_local;
      seq.quiet_end_local = out.sequence.quiet_end_local;
      seq.variant_strategy = out.sequence.variant_strategy;
    }
    renderSequences();
    showMsg('Sequence settings saved.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function togglePause() {
  try {
    const out = await api('/api/drip/pause', { method: 'PUT', body: { paused: !state.paused, changedBy: getEditor() || undefined } });
    state.paused = out.paused;
    renderStatus();
    showMsg(state.paused ? 'All drip sends are paused.' : 'Drip sends resumed.', 'success');
  } catch (e) { showMsg(e.message); }
}

// ---- Step timing editor ----
function openStepEditor(id) {
  const found = findStep(id); if (!found) return;
  const { step } = found;
  const head = document.querySelector(`[data-step-head="${id}"]`);
  head.innerHTML = `
    <span class="fu-step-idx">${esc(step.step_index)}</span>
    <label class="fu-step-ed">offset (min from T0) <input type="number" min="0" step="1" class="fu-step-offset" value="${esc(step.offset_minutes)}" /></label>
    <label class="fu-step-ed"><input type="checkbox" class="fu-step-active" ${step.is_active !== false ? 'checked' : ''}/> active</label>
    <button class="fu-btn primary fu-step-save" data-step-save="${esc(id)}">Save</button>
    <button class="fu-btn fu-step-cancel">Cancel</button>`;
}
async function saveStep(id, head) {
  const offsetMinutes = Number(head.querySelector('.fu-step-offset').value);
  const isActive = head.querySelector('.fu-step-active').checked;
  if (!Number.isFinite(offsetMinutes) || offsetMinutes < 0) { showMsg('Offset must be 0 or more minutes.'); return; }
  try {
    const out = await api(`/api/drip/step/${id}`, { method: 'PUT', body: { offsetMinutes, isActive } });
    const found = findStep(id);
    if (found && out.step) { found.step.offset_minutes = out.step.offset_minutes; found.step.is_active = out.step.is_active; }
    renderSequences();
    showMsg('Step timing saved.', 'success');
  } catch (e) { showMsg(e.message); }
}

// Delegated events for the sequences panel.
$('sequences').addEventListener('click', (e) => {
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t('.fu-edit'))) return openEditor(el.dataset.edit);
  if ((el = t('.fu-add-variant'))) return openAddVariant(el.dataset.addVariant);
  if ((el = t('.fu-add-cat'))) return openAddCategory(el.dataset.addCat);
  if ((el = t('.fu-versions'))) return openHistory(el.dataset.versions);
  if ((el = t('.fu-revert'))) return revertMessageUI(el.dataset.revert, el.dataset.version);
  if ((el = t('.fu-msg-del'))) return deleteMessageUI(el.dataset.del);
  if ((el = t('.fu-save'))) return saveMessage(el.dataset.save, el.closest('.fu-msg'));
  if ((el = t('.fu-add-save'))) return saveNewMessage(el, el.closest('.fu-msg'));
  if ((el = t('.fu-cat-save'))) return saveAddCategory(el, el.closest('.fu-msg'));
  if (t('.fu-cancel')) return renderSequences();
  if ((el = t('.fu-seq-toggle'))) return toggleSequence(el.dataset.seq, el.dataset.active !== '1');
  if ((el = t('.fu-seq-settings'))) return openSeqSettings(el.dataset.seqSettings);
  if ((el = t('.fu-seq-add-step'))) return openAddStep(el.dataset.seqAddStep);
  if ((el = t('.fu-addstep-save'))) return saveAddStep(el, el.closest('.fu-step'));
  if ((el = t('.fu-step-del'))) return deleteStepUI(el.dataset.stepDel);
  if ((el = t('.fu-seq-set-save'))) return saveSeqSettings(el.dataset.seqSetSave, el.closest('[data-seq-meta]'));
  if (t('.fu-seq-set-cancel')) return renderSequences();
  if ((el = t('.fu-step-edit'))) return openStepEditor(el.dataset.step);
  if ((el = t('.fu-step-save'))) return saveStep(el.dataset.stepSave, el.closest('[data-step-head]'));
  if (t('.fu-step-cancel')) return renderSequences();
});
$('sequences').addEventListener('input', (e) => {
  const ed = e.target.closest('.fu-editor'); if (!ed) return;
  if (e.target.classList.contains('fu-ed-cat')) ed.dataset.category = e.target.value.trim();
  updateEditorFeedback(ed.closest('.fu-msg'));
});

function renderActive(enrollments) {
  const body = $('activeBody');
  if (!enrollments || enrollments.length === 0) { body.innerHTML = ''; $('activeEmpty').hidden = false; return; }
  $('activeEmpty').hidden = true;
  body.innerHTML = enrollments.map((e) => `
    <tr>
      <td><code>${esc(e.lead_ref)}</code></td>
      <td>${esc(e.vertical || '—')}</td>
      <td>${esc(e.category_key || '—')}</td>
      <td>${esc(e.step)}</td>
      <td>${fmtDue(e.next_due_at)}</td>
    </tr>`).join('');
}

function renderTaxonomy(taxonomy) {
  state.taxonomy = taxonomy || [];
  const canEdit = state.cfg.editEnabled;
  $('taxBody').innerHTML = state.taxonomy.map((t) => `
    <tr data-cat="${esc(t.category_key)}">
      <td><button type="button" class="fu-linkkey fu-tax-key" data-cat="${esc(t.category_key)}" title="Jump to templates using this category"><code>${esc(t.category_key)}</code></button></td><td>${esc(t.source)}</td><td>${esc(t.raw_value)}</td>
      <td>${canEdit ? `<button class="fu-btn danger fu-tax-del" data-tax="${esc(t.id)}" title="Delete">✕</button>` : ''}</td>
    </tr>`).join('');

  const add = $('taxAdd');
  if (!canEdit) { add.hidden = true; return; }
  add.hidden = false;
  add.innerHTML = `
    <input type="text" id="taxKey" placeholder="category_key" />
    <select id="taxSource"><option value="thumbtack">thumbtack</option><option value="google_lsa">google_lsa</option><option value="any">any</option></select>
    <input type="text" id="taxRaw" placeholder="raw value (e.g. Tree Stump Grinding)" />
    <button class="fu-btn primary" id="taxAddBtn">+ Add mapping</button>`;
  $('taxAddBtn').addEventListener('click', addTaxonomy);
}

$('taxBody').addEventListener('click', (e) => {
  const del = e.target.closest('.fu-tax-del');
  if (del) return deleteTaxonomy(del.dataset.tax);
  const key = e.target.closest('.fu-tax-key');
  if (key) return revealTemplatesForCategory(key.dataset.cat);
});

// Flash + scroll a set of elements into view (used by the category jump-links).
function revealElements(els) {
  const list = els.filter(Boolean);
  if (!list.length) return false;
  list[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  list.forEach((el) => { el.classList.add('fu-flash'); setTimeout(() => el.classList.remove('fu-flash'), 1800); });
  return true;
}

function revealTaxonomyForCategory(cat) {
  const rows = [...document.querySelectorAll('#taxBody tr')].filter((tr) => tr.dataset.cat === cat);
  if (!revealElements(rows)) showMsg(`No taxonomy mapping for “${cat}” yet — add one under Category taxonomy.`, 'success');
}

function revealTemplatesForCategory(cat) {
  const nodes = (state.templates || []).filter((t) => t.category_key === cat)
    .map((t) => document.querySelector(`[data-tpl="${window.CSS ? CSS.escape(t.template_key) : t.template_key}"]`));
  if (!revealElements(nodes)) showMsg(`No template is linked to “${cat}” yet.`, 'success');
}

async function addTaxonomy() {
  const categoryKey = $('taxKey').value;
  const source = $('taxSource').value;
  const rawValue = $('taxRaw').value;
  try {
    await api('/api/drip/taxonomy', { method: 'POST', body: { categoryKey, source, rawValue } });
    const detail = await api('/api/drip/sequences');
    renderTaxonomy(detail.taxonomy);
    showMsg('Mapping saved.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function deleteTaxonomy(id) {
  try {
    await api(`/api/drip/taxonomy/${id}`, { method: 'DELETE' });
    state.taxonomy = state.taxonomy.filter((t) => String(t.id) !== String(id));
    renderTaxonomy(state.taxonomy);
    showMsg('Mapping removed.', 'success');
  } catch (e) { showMsg(e.message); }
}

// ---- Suppression manager ----
function renderSuppressions(list) {
  state.suppressions = list || [];
  const canEdit = state.cfg.editEnabled;
  const body = $('supBody');
  $('supEmpty').hidden = state.suppressions.length > 0;
  body.innerHTML = state.suppressions.map((s) => `
    <tr>
      <td><code>${esc(s.phone_e164)}</code></td>
      <td>${esc(s.reason || '—')}</td>
      <td>${esc(s.source || '—')}</td>
      <td>${fmtDue(s.created_at)}</td>
      <td>${canEdit ? `<button class="fu-btn danger fu-sup-del" data-phone="${esc(s.phone_e164)}" title="Remove">✕</button>` : ''}</td>
    </tr>`).join('');

  const add = $('supAdd');
  if (!canEdit) { add.hidden = true; return; }
  add.hidden = false;
  add.innerHTML = `
    <input type="text" id="supPhone" placeholder="+1XXXXXXXXXX" />
    <input type="text" id="supReason" placeholder="reason (optional)" />
    <button class="fu-btn primary" id="supAddBtn">+ Suppress number</button>`;
  $('supAddBtn').addEventListener('click', addSuppressionUI);
}

$('supBody').addEventListener('click', (e) => {
  const del = e.target.closest('.fu-sup-del');
  if (del) return deleteSuppressionUI(del.dataset.phone);
});

async function addSuppressionUI() {
  const phone = $('supPhone').value.trim();
  const reason = $('supReason').value.trim();
  if (!phone) { showMsg('Enter a phone number.'); return; }
  try {
    await api('/api/drip/suppress', { method: 'POST', body: { phone, reason: reason || undefined, source: 'dashboard' } });
    await reloadSuppressions();
    showMsg('Number suppressed.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function deleteSuppressionUI(phone) {
  try {
    await api('/api/drip/suppress', { method: 'DELETE', body: { phone } });
    await reloadSuppressions();
    showMsg('Number removed from suppression.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function reloadSuppressions() {
  const { suppressions } = await api('/api/drip/suppressions');
  renderSuppressions(suppressions);
}

// ---- Auto-reply templates ----
function categoryKeyOptions(selected) {
  const keys = [...new Set([
    ...(state.taxonomy || []).map((t) => t.category_key),
    ...(state.templates || []).map((t) => t.category_key),
  ].filter(Boolean))].sort();
  const opts = keys.map((k) => `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(k)}</option>`).join('');
  return `<option value="">(no category)</option>${opts}`;
}

function renderTemplates(list) {
  state.templates = list || [];
  const canEdit = state.cfg.editEnabled;
  const groups = {};
  for (const t of state.templates) { (groups[t.group_key] = groups[t.group_key] || []).push(t); }
  const keys = Object.keys(groups).sort();
  const groupsHtml = keys.map((g) => {
    const rows = groups[g].map((t) => {
      const seg = smsSegments(t.body);
      const ver = t.version ? `<span class="fu-ver">v${esc(t.version)}</span>` : '';
      const cat = t.category_key ? ` <button type="button" class="fu-cat fu-linkkey fu-cat-link" data-cat="${esc(t.category_key)}" title="Jump to its taxonomy mapping">🏷️ ${esc(t.category_key)}</button>` : '';
      const draft = t.is_active === false ? ' <span class="fu-draft" title="Draft — not sent until activated">draft</span>' : '';
      const actions = canEdit ? `
        <div class="fu-msg-actions">
          <button class="fu-btn fu-tpl-edit" data-key="${esc(t.template_key)}">✎ Edit</button>
          ${Number(t.version) > 1 ? `<button class="fu-btn fu-tpl-versions" data-key="${esc(t.template_key)}">🕘 Versions</button>` : ''}
          <label class="fu-tpl-catsel" title="Link this template to a category taxonomy">🏷️ <select class="fu-tpl-cat" data-key="${esc(t.template_key)}">${categoryKeyOptions(t.category_key || '')}</select></label>
          <button class="fu-btn ${t.is_active === false ? 'ok' : ''} fu-tpl-active" data-key="${esc(t.template_key)}" data-active="${t.is_active === false ? 'false' : 'true'}">${t.is_active === false ? '▶ Activate' : '⏸ Deactivate'}</button>
          <button class="fu-btn danger fu-tpl-del" data-key="${esc(t.template_key)}">🗑 Delete</button>
        </div>` : '';
      return `
        <div class="fu-msg${t.is_active === false ? ' fu-msg-draft' : ''}" data-tpl="${esc(t.template_key)}">
          <div class="fu-msg-label">${esc(t.label || t.sub_key)} <code>${esc(t.sub_key)}</code>${cat}${draft}${ver} <span class="fu-ver">${seg.segments} seg</span></div>
          <div class="fu-msg-text">${esc(t.body)}</div>
          ${actions}
        </div>`;
    }).join('');
    return `<div class="fu-seq"><div class="fu-seq-head"><h3>${esc(g)}</h3></div><div class="fu-steps"><div class="fu-step">${rows}</div></div></div>`;
  }).join('');

  const empty = keys.length === 0 ? '<p class="hint">No auto-reply templates yet.</p>' : '';
  const grpList = [...new Set((state.templates || []).map((t) => t.group_key))].sort();
  const addForm = canEdit ? `
    <div class="fu-seq fu-tpl-new">
      <div class="fu-seq-head"><h3>➕ New template</h3></div>
      <div class="fu-tpl-newform">
        <div class="fu-tpl-newrow">
          <input list="fu-grp-list" class="fu-nt-group" placeholder="group (e.g. autoreply_tt_tree)" />
          <datalist id="fu-grp-list">${grpList.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
          <input type="text" class="fu-nt-sub" placeholder="sub key (e.g. tree_removal)" />
          <input type="text" class="fu-nt-label" placeholder="label (optional)" />
          <label class="fu-tpl-catsel" title="Link to a category taxonomy (optional)">🏷️ <select class="fu-nt-cat">${categoryKeyOptions('')}</select></label>
        </div>
        <textarea class="fu-nt-body" placeholder="message body…"></textarea>
        <div class="fu-msg-actions"><button class="fu-btn primary fu-tpl-create">➕ Add template</button></div>
      </div>
    </div>` : '';

  $('templates').innerHTML = groupsHtml + empty + addForm;
}

function findTemplate(key) { return (state.templates || []).find((t) => t.template_key === key); }

function openTemplateEditor(key) {
  const t = findTemplate(key); if (!t) return;
  const node = document.querySelector(`[data-tpl="${key}"]`);
  node.innerHTML = `
    <div class="fu-editor" data-tpl-edit="${esc(key)}">
      <textarea class="fu-ed-body fu-tpl-body">${esc(t.body)}</textarea>
      <div class="fu-ed-meta"><span class="fu-ed-seg"></span></div>
      <div class="fu-msg-actions">
        <button class="fu-btn primary fu-tpl-save" data-key="${esc(key)}">Save</button>
        <button class="fu-btn fu-tpl-cancel">Cancel</button>
      </div>
    </div>`;
  updateTemplateSeg(node);
  node.querySelector('.fu-tpl-body').focus();
}

function updateTemplateSeg(node) {
  const seg = smsSegments(node.querySelector('.fu-tpl-body').value);
  node.querySelector('.fu-ed-seg').innerHTML = `<b>${seg.segments}</b> SMS segment${seg.segments === 1 ? '' : 's'} · ${seg.units} chars · ${seg.encoding}`;
}

async function saveTemplate(key, node) {
  const body = node.querySelector('.fu-tpl-body').value;
  if (!body.trim()) { showMsg('Template body cannot be empty.'); return; }
  try {
    const out = await api(`/api/drip/template/${encodeURIComponent(key)}`, { method: 'PUT', body: { body, changedBy: getEditor() || undefined } });
    const t = findTemplate(key); if (t && out.template) Object.assign(t, out.template);
    renderTemplates(state.templates);
    showMsg(out.versioned ? `Saved — now v${out.template.version}.` : 'Saved.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function openTemplateHistory(key) {
  const node = document.querySelector(`[data-tpl="${key}"]`);
  try {
    const { history } = await api(`/api/drip/template/${encodeURIComponent(key)}/history`);
    const rows = (history || []).map((h) => `
      <div class="fu-hist-row">
        <div class="fu-hist-meta">v${esc(h.version)} · ${esc(h.changed_by || 'unknown')} · ${fmtDue(h.changed_at)}</div>
        <div class="fu-hist-body">${esc(h.body)}</div>
        <button class="fu-btn fu-tpl-revert" data-key="${esc(key)}" data-version="${esc(h.version)}">↩ Revert to v${esc(h.version)}</button>
      </div>`).join('');
    node.innerHTML = `<div class="fu-history"><div class="fu-msg-label">Version history</div>${rows || '<p class="hint">No prior versions.</p>'}<div class="fu-msg-actions"><button class="fu-btn fu-tpl-cancel">Close</button></div></div>`;
  } catch (e) { showMsg(e.message); }
}

async function revertTemplateUI(key, version) {
  try {
    await api(`/api/drip/template/${encodeURIComponent(key)}/revert`, { method: 'POST', body: { version: Number(version), changedBy: getEditor() || undefined } });
    const detail = await api('/api/drip/templates');
    renderTemplates(detail.templates);
    showMsg(`Reverted to v${version}.`, 'success');
  } catch (e) { showMsg(e.message); }
}

async function setTemplateCategoryUI(key, categoryKey) {
  try {
    const out = await api(`/api/drip/template/${encodeURIComponent(key)}/category`, { method: 'PUT', body: { categoryKey: categoryKey || null } });
    const t = findTemplate(key); if (t) t.category_key = out.template.category_key;
    renderTemplates(state.templates);
    showMsg(categoryKey ? `Linked to category “${categoryKey}”.` : 'Category link removed.', 'success');
  } catch (e) { showMsg(e.message); renderTemplates(state.templates); }
}

async function setTemplateActiveUI(key, active) {
  try {
    const out = await api(`/api/drip/template/${encodeURIComponent(key)}/active`, { method: 'PUT', body: { isActive: active } });
    const t = findTemplate(key); if (t) t.is_active = out.template.is_active;
    renderTemplates(state.templates);
    showMsg(active ? 'Activated — this template can now be sent.' : 'Deactivated — saved as a draft (won’t be sent).', 'success');
  } catch (e) { showMsg(e.message); }
}

async function deleteTemplateUI(key) {
  if (!window.confirm(`Delete template “${key}”? This cannot be undone.`)) return;
  try {
    await api(`/api/drip/template/${encodeURIComponent(key)}`, { method: 'DELETE' });
    state.templates = (state.templates || []).filter((t) => t.template_key !== key);
    renderTemplates(state.templates);
    showMsg('Template deleted.', 'success');
  } catch (e) { showMsg(e.message); }
}

async function createTemplateUI(scope) {
  const val = (sel) => (scope.querySelector(sel)?.value || '').trim();
  const body = scope.querySelector('.fu-nt-body')?.value || '';
  try {
    const out = await api('/api/drip/template', {
      method: 'POST',
      body: { group: val('.fu-nt-group'), sub: val('.fu-nt-sub'), label: val('.fu-nt-label'), categoryKey: val('.fu-nt-cat'), body },
    });
    state.templates.push(out.template);
    renderTemplates(state.templates);
    showMsg(`Added ${out.template.template_key}.`, 'success');
  } catch (e) { showMsg(e.message); }
}

$('templates').addEventListener('click', (e) => {
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t('.fu-tpl-edit'))) return openTemplateEditor(el.dataset.key);
  if ((el = t('.fu-tpl-versions'))) return openTemplateHistory(el.dataset.key);
  if ((el = t('.fu-tpl-save'))) return saveTemplate(el.dataset.key, el.closest('[data-tpl]'));
  if ((el = t('.fu-tpl-revert'))) return revertTemplateUI(el.dataset.key, el.dataset.version);
  if ((el = t('.fu-tpl-del'))) return deleteTemplateUI(el.dataset.key);
  if ((el = t('.fu-tpl-active'))) return setTemplateActiveUI(el.dataset.key, el.dataset.active !== 'true');
  if ((el = t('.fu-cat-link'))) return revealTaxonomyForCategory(el.dataset.cat);
  if (t('.fu-tpl-create')) return createTemplateUI(document.querySelector('.fu-tpl-newform'));
  if (t('.fu-tpl-cancel')) return renderTemplates(state.templates);
});
$('templates').addEventListener('change', (e) => {
  const el = e.target.closest('.fu-tpl-cat');
  if (el) setTemplateCategoryUI(el.dataset.key, el.value);
});
$('templates').addEventListener('input', (e) => {
  if (e.target.classList.contains('fu-tpl-body')) updateTemplateSeg(e.target.closest('[data-tpl]'));
});

function renderModeNote() {
  const el = $('modeNote');
  if (state.cfg.editEnabled) {
    el.innerHTML = '<strong>Editing enabled.</strong> Message copy, sequence activation, and the send pause can be changed here. Every save is validated and version-tracked.';
  } else {
    el.innerHTML = '<strong>Read-only view.</strong> Editing is turned off (set <code>DRIP_CONFIG_EDIT_ENABLED=true</code> to enable). Sequences, copy, and status are shown live.';
  }
}

async function load() {
  try {
    $('msg').hidden = true;
    const [cfg, detail, report, active, pause] = await Promise.all([
      api('/api/drip/config'),
      api('/api/drip/sequences'),
      api('/api/drip/report'),
      api('/api/drip/enrollments?status=active'),
      api('/api/drip/pause'),
    ]);
    state.cfg = cfg;
    state.sequences = detail.sequences || [];
    state.stepStats = report.stepStats || [];
    state.variantStats = report.variantStats || [];
    state.paused = Boolean(pause.paused);
    renderModeNote();
    renderStatus();
    renderStats(report);
    renderOutcomes(report.outcomes);
    renderSeqNew();
    renderSequences();
    renderTaxonomy(detail.taxonomy);
    renderTemplates((await api('/api/drip/templates')).templates);
    renderActive(active.enrollments || []);
    renderSuppressions((await api('/api/drip/suppressions')).suppressions);
  } catch (e) {
    showMsg(e.message);
  }
}

$('btnRefresh').addEventListener('click', load);
load();
