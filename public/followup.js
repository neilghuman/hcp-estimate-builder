// Follow-up drip dashboard.
// Read-only by default; when DRIP_CONFIG_EDIT_ENABLED is on, staff can edit message copy, toggle
// sequences, and pause sends. The server validates + versions every write; the client mirrors the
// SMS-segment / validation logic only for live feedback while typing.

const $ = (id) => document.getElementById(id);
const state = { cfg: {}, sequences: [], paused: false };
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

function msgInnerHTML(m) {
  const isCat = m.category_key != null;
  const label = isCat
    ? `Category: ${esc(m.category_key)}${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`
    : `Default${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`;
  const optout = m.include_optout ? '<span class="fu-optout">✓ opt-out</span>' : '';
  const inactive = m.is_active === false ? ' <span class="fu-pill off">off</span>' : '';
  const ver = m.version ? `<span class="fu-ver">v${esc(m.version)}</span>` : '';
  const actions = state.cfg.editEnabled ? `<div class="fu-msg-actions"><button class="fu-btn fu-edit" data-edit="${esc(m.id)}">✎ Edit</button></div>` : '';
  return `<div class="fu-msg-label">${label}${optout}${inactive}${ver}</div><div class="fu-msg-text">${esc(m.body)}</div>${actions}`;
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
      const msgs = (st.messages || []).map((m) => `<div class="fu-msg ${m.category_key != null ? 'cat' : ''}" data-msg="${esc(m.id)}">${msgInnerHTML(m)}</div>`).join('');
      return `
        <div class="fu-step">
          <div class="fu-step-head">
            <span class="fu-step-idx">${esc(st.step_index)}</span>
            <span class="fu-step-when">${when.t0 ? '<span class="fu-t0">' + when.text + '</span>' : when.text}</span>
            ${st.is_active === false ? '<span class="fu-pill off">step off</span>' : ''}
          </div>
          ${msgs || '<p class="hint">No message for this step.</p>'}
        </div>`;
    }).join('');

    return `
      <div class="fu-seq">
        <div class="fu-seq-head">
          <h3>${esc(seq.name)}</h3>
          ${activePill}
          <code>${esc(seq.key)}</code>
          ${toggle}
        </div>
        <div class="fu-seq-head fu-seq-meta">${meta}</div>
        <div class="fu-steps">${steps}</div>
      </div>`;
  }).join('');
}

// ---- Message editor ----
function openEditor(id) {
  const found = findMessage(id); if (!found) return;
  const { msg, seq } = found;
  const node = document.querySelector(`[data-msg="${id}"]`);
  node.innerHTML = `
    <div class="fu-editor" data-editing="${esc(id)}">
      <textarea class="fu-ed-body">${esc(msg.body)}</textarea>
      <div class="fu-ed-row">
        <label><input type="checkbox" class="fu-ed-optout" ${msg.include_optout ? 'checked' : ''}/> Carries opt-out (STOP)</label>
        <label><input type="checkbox" class="fu-ed-active" ${msg.is_active !== false ? 'checked' : ''}/> Active</label>
      </div>
      <div class="fu-ed-meta"><span class="fu-ed-seg"></span></div>
      <ul class="fu-issues"></ul>
      <div class="fu-preview"><div class="fu-preview-label">Preview (sample values)</div><div class="fu-preview-body"></div></div>
      <div class="fu-msg-actions">
        <button class="fu-btn primary fu-save" data-save="${esc(id)}">Save</button>
        <button class="fu-btn fu-cancel">Cancel</button>
      </div>
    </div>`;
  updateEditorFeedback(node);
  node.querySelector('.fu-ed-body').focus();
}

function updateEditorFeedback(node) {
  const ed = node.querySelector('.fu-editor');
  const found = ed ? findMessage(ed.dataset.editing) : null;
  const vertical = found ? found.seq.vertical : null;
  const category = found ? found.msg.category_key : null;
  const body = node.querySelector('.fu-ed-body').value;
  const optout = node.querySelector('.fu-ed-optout').checked;
  const seg = smsSegments(body);
  node.querySelector('.fu-ed-seg').innerHTML = `<b>${seg.segments}</b> SMS segment${seg.segments === 1 ? '' : 's'} · ${seg.units} chars · ${seg.encoding}`;
  const issues = validateMessage(body, optout);
  node.querySelector('.fu-issues').innerHTML = issues.map((i) => `<li class="fu-issue ${i.level}">${i.level === 'error' ? '✕' : '⚠'} ${esc(i.message)}</li>`).join('');
  node.querySelector('.fu-preview-body').textContent = renderBody(body, sampleVars(vertical, category));
  const hasError = issues.some((i) => i.level === 'error');
  const saveBtn = node.querySelector('.fu-save');
  if (saveBtn) saveBtn.disabled = hasError;
}

async function saveMessage(id, node) {
  const body = node.querySelector('.fu-ed-body').value;
  const includeOptout = node.querySelector('.fu-ed-optout').checked;
  const isActive = node.querySelector('.fu-ed-active').checked;
  try {
    const out = await api(`/api/drip/message/${id}`, { method: 'PUT', body: { body, includeOptout, isActive, changedBy: getEditor() || undefined } });
    const found = findMessage(id);
    if (found && out.message) Object.assign(found.msg, out.message);
    renderSequences();
    showMsg(out.versioned ? `Saved — now v${out.message.version}.` : 'Saved.', 'success');
  } catch (e) {
    showMsg(e.message);
  }
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

async function togglePause() {
  try {
    const out = await api('/api/drip/pause', { method: 'PUT', body: { paused: !state.paused, changedBy: getEditor() || undefined } });
    state.paused = out.paused;
    renderStatus();
    showMsg(state.paused ? 'All drip sends are paused.' : 'Drip sends resumed.', 'success');
  } catch (e) { showMsg(e.message); }
}

// Delegated events for the sequences panel.
$('sequences').addEventListener('click', (e) => {
  const edit = e.target.closest('.fu-edit');
  if (edit) return openEditor(edit.dataset.edit);
  const cancel = e.target.closest('.fu-cancel');
  if (cancel) return renderSequences();
  const save = e.target.closest('.fu-save');
  if (save) return saveMessage(save.dataset.save, save.closest('[data-msg]'));
  const toggle = e.target.closest('.fu-seq-toggle');
  if (toggle) return toggleSequence(toggle.dataset.seq, toggle.dataset.active !== '1');
});
$('sequences').addEventListener('input', (e) => {
  const ed = e.target.closest('.fu-editor'); if (!ed) return;
  updateEditorFeedback(ed.closest('[data-msg]'));
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
  $('taxBody').innerHTML = (taxonomy || []).map((t) => `
    <tr><td><code>${esc(t.category_key)}</code></td><td>${esc(t.source)}</td><td>${esc(t.raw_value)}</td></tr>`).join('');
}

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
    state.paused = Boolean(pause.paused);
    renderModeNote();
    renderStatus();
    renderStats(report);
    renderSequences();
    renderTaxonomy(detail.taxonomy);
    renderActive(active.enrollments || []);
  } catch (e) {
    showMsg(e.message);
  }
}

$('btnRefresh').addEventListener('click', load);
load();
