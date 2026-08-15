// Follow-up drip dashboard — read-only front-end.
// Renders the live drip config (sequences -> steps -> messages), taxonomy, and enrollment status.
// No writes; editing is a later sprint.

const $ = (id) => document.getElementById(id);

function showMsg(text, kind = 'error') {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = false;
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `${path} failed (${res.status})`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Humanize an offset in minutes relative to T0 (the successful initial send).
function offsetLabel(min) {
  const m = Number(min);
  if (m === 0) return { text: 'initial send', t0: true };
  if (m < 60) return { text: `+${m} min`, t0: false };
  if (m < 1440) {
    const h = m / 60;
    return { text: `+${Number.isInteger(h) ? h : h.toFixed(1)} hr`, t0: false };
  }
  const d = m / 1440;
  return { text: `+${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`, t0: false };
}

function fmtDue(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
}

function renderStatus(cfg) {
  const chip = (label, on, offText) => {
    const state = on ? 'on' : 'off';
    return `<span class="fu-chip ${state}"><span class="dot"></span>${esc(label)}: ${on ? 'on' : (offText || 'off')}</span>`;
  };
  $('statusChips').innerHTML = [
    chip('Feature', cfg.enabled),
    chip('Enrollment writes', cfg.writeEnabled),
    chip('Sending', cfg.sendEnabled),
  ].join('');
}

function renderStats(report) {
  const badges = (rows, keyField, countField) => {
    if (!rows || rows.length === 0) return '<span class="hint">none</span>';
    return rows.map((r) => `<span class="fu-badge"><b>${esc(r[countField])}</b> ${esc(r[keyField] || '—')}</span>`).join('');
  };
  $('byStatus').innerHTML = badges(report.byStatus, 'status', 'n');
  $('byExit').innerHTML = badges(report.byExit, 'exit_reason', 'n');
}

function renderSequences(sequences) {
  if (!sequences || sequences.length === 0) {
    $('sequences').innerHTML = '<p class="hint">No sequences configured.</p>';
    return;
  }
  $('sequences').innerHTML = sequences.map((seq) => {
    const activePill = seq.is_active
      ? '<span class="fu-pill on">active</span>'
      : '<span class="fu-pill off">inactive</span>';
    const meta = [
      `source: ${esc(seq.source)}`,
      `vertical: ${esc(seq.vertical || 'any')}`,
      `channel: ${esc(seq.channel)}`,
      `max: ${esc(seq.max_messages)}`,
      `expires: ${esc(Math.round(seq.expires_after_hours / 24))}d`,
      `hours: ${esc(String(seq.quiet_start_local).slice(0, 5))}\u2013${esc(String(seq.quiet_end_local).slice(0, 5))} ${esc(seq.tz_default)}`,
      `variants: ${esc(seq.variant_strategy)}`,
    ].map((m) => `<span>${m}</span>`).join('');

    const steps = (seq.steps || []).map((st) => {
      const when = offsetLabel(st.offset_minutes);
      const msgs = (st.messages || []).map((m) => {
        const isCat = m.category_key != null;
        const label = isCat
          ? `Category: ${esc(m.category_key)}${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`
          : `Default${m.variant && m.variant !== 'A' ? ` · variant ${esc(m.variant)}` : ''}`;
        const optout = m.include_optout ? '<span class="fu-optout">✓ opt-out</span>' : '';
        const inactive = m.is_active === false ? ' <span class="fu-pill off">off</span>' : '';
        return `<div class="fu-msg ${isCat ? 'cat' : ''}"><div class="fu-msg-label">${label}${optout}${inactive}</div>${esc(m.body)}</div>`;
      }).join('');
      return `
        <div class="fu-step">
          <div class="fu-step-head">
            <span class="fu-step-idx">${esc(st.step_index)}</span>
            <span class="fu-step-when ${when.t0 ? '' : ''}">${when.t0 ? '<span class="fu-t0">' + when.text + '</span>' : when.text}</span>
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
        </div>
        <div class="fu-seq-head fu-seq-meta">${meta}</div>
        <div class="fu-steps">${steps}</div>
      </div>`;
  }).join('');
}

function renderActive(enrollments) {
  const body = $('activeBody');
  if (!enrollments || enrollments.length === 0) {
    body.innerHTML = '';
    $('activeEmpty').hidden = false;
    return;
  }
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
    <tr>
      <td><code>${esc(t.category_key)}</code></td>
      <td>${esc(t.source)}</td>
      <td>${esc(t.raw_value)}</td>
    </tr>`).join('');
}

async function load() {
  try {
    $('msg').hidden = true;
    const [cfg, detail, report, active] = await Promise.all([
      api('/api/drip/config'),
      api('/api/drip/sequences'),
      api('/api/drip/report'),
      api('/api/drip/enrollments?status=active'),
    ]);
    renderStatus(cfg);
    renderStats(report);
    renderSequences(detail.sequences);
    renderTaxonomy(detail.taxonomy);
    renderActive(active.enrollments || []);
  } catch (e) {
    showMsg(e.message);
  }
}

$('btnRefresh').addEventListener('click', load);
load();
