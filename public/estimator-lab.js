// HCP Estimate Builder — frontend logic.

const state = {
  options: null,     // parsed options from the spreadsheet
  source: null,      // 'template' | 'siterecon' | 'blank' | 'lawncare' | 'pressurewash' | 'windowcleaning'
  sitereconDraft: null,
  customer: null,    // chosen customer
  serviceAddressId: null,
  billingAddressId: null,
  testMode: false,   // when true, prefix option/line names with [TEST]
  activeOptionIndex: 0,
};

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function getActiveOptionIndex() {
  const count = Array.isArray(state.options) ? state.options.length : 0;
  if (!count) return 0;
  if (!Number.isInteger(state.activeOptionIndex)) state.activeOptionIndex = 0;
  state.activeOptionIndex = Math.max(0, Math.min(state.activeOptionIndex, count - 1));
  return state.activeOptionIndex;
}
const SOURCE_CONFIG = {
  siterecon: {
    label: 'SiteRecon starter estimate',
    title: 'Upload SiteRecon Workbook',
    hint: 'Upload a SiteRecon workbook to seed a starter estimate draft from property measurements.',
  },
  template: {
    label: 'Full estimate spreadsheet',
    title: 'Upload Full Estimate Spreadsheet',
    hint: 'One row per line item. An option column groups rows into options (Good / Better / Best).',
  },
  blank: {
    label: 'Blank estimate',
    title: 'Build Your Estimate',
    hint: 'A blank Good / Better / Best estimate. Remove any options you do not need, add rows, and fill in your lines.',
    instant: true,
    starter: 'blank',
  },
  lawncare: {
    label: 'Lawn care starter',
    title: 'Lawn Care Starter Estimate',
    hint: 'A pre-filled lawn care estimate (mowing, edging, fertilization, and more). Edit pricing and remove anything you do not need.',
    instant: true,
    starter: 'lawncare',
  },
  pressurewash: {
    label: 'Pressure washing starter',
    title: 'Pressure Washing Starter Estimate',
    hint: 'A pre-filled exterior cleaning estimate (house wash, driveway, roof). Edit pricing and remove anything you do not need.',
    instant: true,
    starter: 'pressurewash',
  },
  windowcleaning: {
    label: 'Window cleaning starter',
    title: 'Window Cleaning Starter Estimate',
    hint: 'A pre-filled window cleaning estimate (exterior, interior, screens, tracks). Edit pricing and remove anything you do not need.',
    instant: true,
    starter: 'windowcleaning',
  },
  quickquote: {
    label: 'Quick quote (one-liner)',
    title: 'One-Line Quick Quote',
    hint: 'A single option with one empty line item. Perfect for fast, simple service quotes.',
    instant: true,
    starter: 'quickquote',
  },
  duplicate: {
    label: 'Duplicate last estimate',
    title: 'Clone a Recent Estimate',
    hint: 'Pick one of this customer\'s recent estimates to clone as your starting point.',
    instant: false,
  },
};

// Build a single starter line item; callers override only what they need.
function starterLine(overrides) {
  return {
    name: '',
    description: '',
    unitOfMeasure: '',
    quantity: 1,
    frequency: 'single',
    unitPrice: 0,
    pricingMode: 'calculated',
    flatAmount: 0,
    kind: 'service',
    taxable: true,
    notes: '',
    ...overrides,
  };
}

// Each builder returns a FRESH options array (Good / Better / Best) every call.
const STARTER_TEMPLATES = {
  blank: () => ([
    { name: 'Good', message: '', lineItems: [starterLine({ name: 'New line item' })] },
    { name: 'Better', message: '', lineItems: [starterLine({ name: 'New line item' })] },
    { name: 'Best', message: '', lineItems: [starterLine({ name: 'New line item' })] },
  ]),
  lawncare: () => ([
    { name: 'Good', message: 'Essential lawn maintenance', lineItems: [
      starterLine({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45 }),
      starterLine({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15 }),
    ] },
    { name: 'Better', message: 'Complete lawn care', lineItems: [
      starterLine({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45 }),
      starterLine({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15 }),
      starterLine({ name: 'Fertilization', description: 'Seasonal granular fertilizer application', unitOfMeasure: 'application', frequency: 'quarterly', unitPrice: 75, kind: 'material' }),
      starterLine({ name: 'Weed Control', description: 'Targeted broadleaf weed treatment', unitOfMeasure: 'application', frequency: 'monthly', unitPrice: 40 }),
    ] },
    { name: 'Best', message: 'Premium lawn & turf program', lineItems: [
      starterLine({ name: 'Lawn Mowing', description: 'Mow, string-trim, and blow clippings', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 45 }),
      starterLine({ name: 'Edging & Trimming', description: 'Edge walkways and driveway', unitOfMeasure: 'visit', frequency: 'weekly', unitPrice: 15 }),
      starterLine({ name: 'Fertilization', description: 'Seasonal granular fertilizer application', unitOfMeasure: 'application', frequency: 'quarterly', unitPrice: 75, kind: 'material' }),
      starterLine({ name: 'Weed Control', description: 'Targeted broadleaf weed treatment', unitOfMeasure: 'application', frequency: 'monthly', unitPrice: 40 }),
      starterLine({ name: 'Aeration', description: 'Core aeration to relieve soil compaction', unitOfMeasure: 'job', frequency: 'annually', unitPrice: 150 }),
      starterLine({ name: 'Overseeding', description: 'Premium seed blend overseed', unitOfMeasure: 'job', frequency: 'annually', unitPrice: 120, kind: 'material' }),
      starterLine({ name: 'Seasonal Cleanup', description: 'Leaf and debris cleanup', unitOfMeasure: 'visit', frequency: 'quarterly', unitPrice: 200 }),
    ] },
  ]),
  pressurewash: () => ([
    { name: 'Good', message: 'Essential exterior cleaning', lineItems: [
      starterLine({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350 }),
      starterLine({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150 }),
    ] },
    { name: 'Better', message: 'Complete exterior cleaning', lineItems: [
      starterLine({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350 }),
      starterLine({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150 }),
      starterLine({ name: 'Walkway Cleaning', description: 'Clean walkways and front porch', unitOfMeasure: 'job', frequency: 'single', unitPrice: 100 }),
      starterLine({ name: 'Patio Cleaning', description: 'Clean rear patio surface', unitOfMeasure: 'job', frequency: 'single', unitPrice: 125 }),
    ] },
    { name: 'Best', message: 'Full property wash', lineItems: [
      starterLine({ name: 'House Soft Wash', description: 'Low-pressure soft wash of siding', unitOfMeasure: 'job', frequency: 'single', unitPrice: 350 }),
      starterLine({ name: 'Driveway Cleaning', description: 'Surface-clean concrete driveway', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150 }),
      starterLine({ name: 'Walkway Cleaning', description: 'Clean walkways and front porch', unitOfMeasure: 'job', frequency: 'single', unitPrice: 100 }),
      starterLine({ name: 'Patio Cleaning', description: 'Clean rear patio surface', unitOfMeasure: 'job', frequency: 'single', unitPrice: 125 }),
      starterLine({ name: 'Roof Soft Wash', description: 'Low-pressure roof treatment', unitOfMeasure: 'job', frequency: 'single', unitPrice: 450 }),
      starterLine({ name: 'Gutter Brightening', description: 'Exterior gutter cleaning and brightening', unitOfMeasure: 'job', frequency: 'single', unitPrice: 175 }),
    ] },
  ]),
  windowcleaning: () => ([
    { name: 'Good', message: 'Exterior windows', lineItems: [
      starterLine({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180 }),
    ] },
    { name: 'Better', message: 'Interior + exterior windows', lineItems: [
      starterLine({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180 }),
      starterLine({ name: 'Interior Window Cleaning', description: 'Clean all interior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150 }),
    ] },
    { name: 'Best', message: 'Full window detail', lineItems: [
      starterLine({ name: 'Exterior Window Cleaning', description: 'Clean all exterior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 180 }),
      starterLine({ name: 'Interior Window Cleaning', description: 'Clean all interior windows', unitOfMeasure: 'job', frequency: 'single', unitPrice: 150 }),
      starterLine({ name: 'Screens & Tracks', description: 'Wipe screens and clean window tracks', unitOfMeasure: 'job', frequency: 'single', unitPrice: 90 }),
      starterLine({ name: 'Skylight Cleaning', description: 'Clean interior and exterior skylights', unitOfMeasure: 'job', frequency: 'single', unitPrice: 120 }),
    ] },
  ]),
  quickquote: () => ([
    { name: 'Quick Quote', message: null, lineItems: [starterLine({ name: 'Service' })] },
  ]),
};

document.querySelectorAll('[data-source]').forEach((button) => {
  button.addEventListener('click', () => setEstimateSource(button.dataset.source));
});
$('#btnClearCustomer').addEventListener('click', resetWorkflow);

// --- Step 1: parse file ------------------------------------------------------
$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $('#parseMsg');
  msg.className = 'msg';

  if (state.source === 'siterecon') {
    msg.textContent = 'Parsing SiteRecon workbook…';

    const fd = new FormData();
    fd.append('file', file);
    let data;
    try {
      const res = await fetch('/api/parse-siterecon', { method: 'POST', body: fd });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'SiteRecon parse failed');
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
      return;
    }

    if (data.errors && data.errors.length) {
      state.options = null;
      state.sitereconDraft = null;
      $('#preview').innerHTML = '';
      msg.className = 'msg err';
      msg.textContent = 'Cannot use this SiteRecon file:\n• ' + data.errors.join('\n• ');
      refreshSteps();
      return;
    }

    state.sitereconDraft = initializeSiteReconDraft(data.siterecon);
    rebuildSiteReconOptions();
    renderSiteReconReview();
    msg.className = data.warnings && data.warnings.length ? 'msg warn' : 'msg ok';
    msg.textContent = (data.warnings && data.warnings.length)
      ? 'SiteRecon starter estimate loaded with notes:\n• ' + data.warnings.join('\n• ')
      : `SiteRecon starter estimate loaded with ${state.options.length} option(s).`;
    refreshSteps();
    return;
  }

  msg.textContent = 'Parsing…';

  const fd = new FormData();
  fd.append('file', file);
  let data;
  try {
    const res = await fetch('/api/parse', { method: 'POST', body: fd });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Parse failed');
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    return;
  }

  if (data.errors && data.errors.length) {
    msg.className = 'msg err';
    msg.textContent = 'Cannot use this file:\n• ' + data.errors.join('\n• ');
    state.options = null;
    $('#preview').innerHTML = '';
    refreshSteps();
    return;
  }

  state.options = normalizeOptionsForEditor(data.options, { lockTaxable: false });
  state.sitereconDraft = null;
  state.activeOptionIndex = 0;
  renderPreview();
  msg.className = data.warnings && data.warnings.length ? 'msg warn' : 'msg ok';
  msg.textContent = (data.warnings && data.warnings.length)
    ? 'Loaded with notes:\n• ' + data.warnings.join('\n• ')
    : `Loaded ${data.options.length} option(s).`;
  refreshSteps();
});

// --- Step 3: estimate selector for duplicate source ---------------------------
$('#estimateSelect').addEventListener('change', async (e) => {
  const estimateId = e.target.value;
  if (!estimateId) return;
  await loadDuplicateEstimate(estimateId);
});

// --- Step 3: service search and add rows ------
let serviceSearchTimer = null;
$('#serviceSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(serviceSearchTimer);
  $('#serviceSearchResults').classList.add('hidden');
  if (q.length < 2) return;
  serviceSearchTimer = setTimeout(() => performServiceSearch(q), 300);
});

async function performServiceSearch(query) {
  try {
    const res = await fetch(`/api/pricebook/search?q=${encodeURIComponent(query)}&limit=10`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    renderServiceSearchResults(data.results || []);
  } catch (err) {
    $('#serviceSearchResults').innerHTML = `<div style="padding: 12px; color: var(--err);">Search error: ${err.message}</div>`;
    $('#serviceSearchResults').classList.remove('hidden');
  }
}

function renderServiceSearchResults(results) {
  const container = $('#serviceSearchResults');
  
  if (!results.length) {
    container.innerHTML = '<div style="padding: 12px; color: var(--muted);">No matching services found.</div>';
    container.classList.remove('hidden');
    return;
  }
  
  container.innerHTML = results.map((item) => `
    <div class="service-search-result-item" data-item-id="${esc(item.id)}" data-item-name="${esc(item.name)}" data-item-desc="${esc(item.description || '')}" data-item-price="${item.unit_price || 0}" data-item-unit="${esc(item.unit_of_measure || '')}" data-item-kind="${esc(item.kind || 'labor')}" data-item-taxable="${item.taxable ? '1' : '0'}">
      <div class="service-search-result-name">${esc(item.name)}</div>
      ${item.description ? `<div class="service-search-result-desc">${esc(item.description)}</div>` : ''}
      <div class="service-search-result-meta">
        $${(item.unit_price / 100).toFixed(2)} / ${esc(item.unit_of_measure || 'unit')}
        ${item.category ? ` • ${esc(item.category)}` : ''}
      </div>
    </div>
  `).join('');
  
  container.classList.remove('hidden');
  
  // Add click handlers to all results
  container.querySelectorAll('.service-search-result-item').forEach((el) => {
    el.addEventListener('click', () => addServiceRowFromSearch(el));
  });
}

function addServiceRowFromSearch(el) {
  if (!state.options || !state.options.length) {
    alert('No options available. Create an estimate first.');
    return;
  }

  const optionIndex = getActiveOptionIndex();

  const newLine = {
    name: el.dataset.itemName,
    description: el.dataset.itemDesc,
    quantity: 1,
    unitOfMeasure: el.dataset.itemUnit,
    frequency: 'single',
    unitPrice: Number(el.dataset.itemPrice) / 100,
    pricingMode: 'calculated',
    flatAmount: 0,
    kind: el.dataset.itemKind,
    taxable: el.dataset.itemTaxable === '1',
    notes: '',
  };

  state.options[optionIndex].lineItems.push(newLine);
  renderPreview();

  $('#serviceSearchResults').classList.add('hidden');
  $('#serviceSearch').value = '';

  const msg = $('#parseMsg');
  msg.className = 'msg ok';
  msg.textContent = `Added "${newLine.name}" to ${state.options[optionIndex].name} option.`;
  setTimeout(() => { msg.textContent = ''; }, 3000);
}

function renderPreview() {
  const el = $('#preview');
  recalcOptionTotals(state.options || [], { lockTaxable: false });
  el.innerHTML = renderEstimateSpreadsheetEditor(state.options || [], {
    lockTaxable: false,
    allowOptionNameEdit: true,
  });
  // Show the service search box now that the spreadsheet is loaded
  $('#serviceSearchBox').classList.remove('hidden');
}

// --- Step 2: customer search -------------------------------------------------
let searchTimer = null;
$('#custSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { $('#custResults').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 250);
});

async function runSearch(q) {
  const ul = $('#custResults');
  ul.innerHTML = '<li>Searching…</li>';
  try {
    const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    if (!data.customers.length) { ul.innerHTML = '<li>No matches.</li>'; return; }
    ul.innerHTML = '';
    data.customers.forEach((c) => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${esc(c.name)}</strong> <span class="email">${esc(c.email || '')} ${esc(c.mobile || '')}</span>`;
      li.addEventListener('click', () => chooseCustomer(c));
      ul.appendChild(li);
    });
  } catch (err) {
    ul.innerHTML = `<li>${esc(err.message)}</li>`;
  }
}

function chooseCustomer(c) {
  state.customer = c;
  state.serviceAddressId = null;
  state.billingAddressId = null;
  $('#custResults').innerHTML = '';
  $('#custSearch').value = '';
  const chosen = $('#custChosen');
  chosen.className = 'chosen set';
  chosen.innerHTML = `<strong>${esc(c.name)}</strong> — ${esc(c.email || 'no email')}<br><a href="#" id="clearCust">change</a>`;
  $('#clearCust').addEventListener('click', (e) => { e.preventDefault(); resetWorkflow(); });
  $('#btnClearCustomer').classList.remove('hidden');
  renderAddresses(c);
  refreshSteps();
}

function resetWorkflow() {
  state.customer = null;
  state.serviceAddressId = null;
  state.billingAddressId = null;
  $('#custChosen').className = 'chosen'; $('#custChosen').innerHTML = '';
  $('#custSearch').value = '';
  $('#custResults').innerHTML = '';
  $('#addrChoice').innerHTML = '';
  $('#btnClearCustomer').classList.add('hidden');
  clearEstimateDraftState();
  $('#sourceMsg').className = 'msg';
  $('#sourceMsg').textContent = '';
  updateSourceSelectionUi();
  updateUploadCopy();
  refreshSteps();
}

function renderAddresses(c) {
  const box = $('#addrChoice');
  const addrs = c.addresses || [];
  if (!addrs.length) {
    box.innerHTML = '<div class="msg err">This customer has no address in HCP. Add one in Housecall Pro first.</div>';
    return;
  }
  const service = addrs.filter((a) => String(a.type || '').toLowerCase() === 'service');
  const billing = addrs.filter((a) => String(a.type || '').toLowerCase() === 'billing');

  if (!service.length && !billing.length) {
    box.innerHTML = '<div class="hint">No typed billing/service addresses found. Choose one address for this estimate:</div>' +
      addrs.map((a, i) => `
      <label class="addr-opt"><input type="radio" name="serviceAddr" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}/> ${esc(a.line)} <em>(${esc(a.type || 'unknown')})</em></label>`).join('');
    state.serviceAddressId = addrs[0].id;
    state.billingAddressId = null;
    box.querySelectorAll('input[name=serviceAddr]').forEach((r) =>
      r.addEventListener('change', (e) => { state.serviceAddressId = e.target.value; refreshSteps(); }));
    return;
  }

  if (service.length) state.serviceAddressId = service[0].id;
  if (billing.length) state.billingAddressId = billing[0].id;

  box.innerHTML = `
    <div class="addr-group">
      <div class="hint"><strong>Service address</strong> (used on estimate)</div>
      ${service.length
        ? service.map((a, i) => `
          <label class="addr-opt"><input type="radio" name="serviceAddr" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}/> ${esc(a.line)} <em>(${esc(a.type || '')})</em></label>`).join('')
        : '<div class="hint">No service address on this customer. Billing will be used as fallback.</div>'}
    </div>
    <div class="addr-group">
      <div class="hint"><strong>Billing address</strong> (tracked for payload/context)</div>
      ${billing.length
        ? billing.map((a, i) => `
          <label class="addr-opt"><input type="radio" name="billingAddr" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}/> ${esc(a.line)} <em>(${esc(a.type || '')})</em></label>`).join('')
        : '<div class="hint">No billing address on this customer.</div>'}
    </div>`;

  box.querySelectorAll('input[name=serviceAddr]').forEach((r) =>
    r.addEventListener('change', (e) => { state.serviceAddressId = e.target.value; refreshSteps(); }));
  box.querySelectorAll('input[name=billingAddr]').forEach((r) =>
    r.addEventListener('change', (e) => { state.billingAddressId = e.target.value; refreshSteps(); }));
}

// --- Step 3: create ----------------------------------------------------------
$('#testMode').addEventListener('change', (e) => {
  state.testMode = Boolean(e.target.checked);
  if (state.options && state.customer && getEffectiveAddressId()) renderSummary();
});

$('#btnDry').addEventListener('click', () => submit(true));
$('#btnCreate').addEventListener('click', () => submit(false));

async function setEstimateSource(source) {
  const config = SOURCE_CONFIG[source];
  if (!config) return;
  if (state.source === source) return;

  if (!confirmSourceChange()) return;

  state.source = source;
  clearEstimateDraftState({ keepSource: true });
  updateSourceSelectionUi();
  updateUploadCopy();

  if (config.instant) {
    seedStarterEstimate(config.starter || 'blank');
    $('#sourceMsg').className = 'msg ok';
    $('#sourceMsg').textContent = `${config.label} ready — edit the lines below, then review & create.`;
  } else if (source === 'duplicate') {
    // Fetch customer's recent estimates
    if (!state.customer) {
      $('#sourceMsg').className = 'msg err';
      $('#sourceMsg').textContent = 'Select a customer first.';
      refreshSteps();
      return;
    }
    try {
      $('#sourceMsg').className = 'msg';
      $('#sourceMsg').textContent = 'Loading recent estimates…';
      const res = await fetch(`/api/customers/${encodeURIComponent(state.customer.id)}/estimates`);
      
      // Handle 404 by showing "no estimates" instead of error
      if (res.status === 404) {
        const select = $('#estimateSelect');
        select.innerHTML = '<option value="">No previous estimates found for this customer</option>';
        $('#sourceMsg').className = 'msg ok';
        $('#sourceMsg').textContent = `${config.label}: This customer has no previous estimates to clone.`;
        refreshSteps();
        return;
      }
      
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      const estimates = data.estimates || [];
      const select = $('#estimateSelect');
      select.innerHTML = estimates.length > 0
        ? estimates.map((e) => `<option value="${esc(e.id)}">${esc(e.estimate_number || 'Est #?')} — ${esc(e.address)} ($${(e.total / 100).toFixed(2)})`).join('')
        : '<option value="">No previous estimates found</option>';
      if (estimates.length > 0) {
        select.value = estimates[0].id;
        await loadDuplicateEstimate(estimates[0].id);
      }
      $('#sourceMsg').className = 'msg ok';
      $('#sourceMsg').textContent = `${config.label}: pick an estimate to clone.`;
    } catch (err) {
      $('#sourceMsg').className = 'msg err';
      $('#sourceMsg').textContent = `Error loading estimates: ${err.message}`;
    }
  } else {
    $('#sourceMsg').className = 'msg ok';
    $('#sourceMsg').textContent = `Selected: ${config.label}.`;
  }
  refreshSteps();
}

function seedStarterEstimate(starterKey) {
  const builder = STARTER_TEMPLATES[starterKey] || STARTER_TEMPLATES.blank;
  state.options = normalizeOptionsForEditor(builder(), { lockTaxable: false });
  state.sitereconDraft = null;
  state.activeOptionIndex = 0;
  renderPreview();
}

async function loadDuplicateEstimate(estimateId) {
  try {
    const res = await fetch(`/api/estimates/${encodeURIComponent(estimateId)}/duplicate`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    state.options = normalizeOptionsForEditor(data.options || [], { lockTaxable: false });
    state.sitereconDraft = null;
    state.activeOptionIndex = 0;
    renderPreview();
  } catch (err) {
    $('#sourceMsg').className = 'msg err';
    $('#sourceMsg').textContent = `Error loading estimate: ${err.message}`;
  }
}

async function submit(dryRun) {
  const result = $('#result');
  const validation = getValidationReport(state.options || []);
  const hasValidationIssues = validation.totalIssues > 0;
  result.className = hasValidationIssues ? 'msg warn' : 'msg';
  result.textContent = hasValidationIssues
    ? `Proceeding with ${validation.totalIssues} validation issue(s) across ${validation.rowsWithIssues} row(s)…`
    : (dryRun ? 'Building dry-run…' : 'Creating in Housecall Pro…');
  try {
    const res = await fetch('/api/estimates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: state.customer.id,
        addressId: getEffectiveAddressId(),
        serviceAddressId: state.serviceAddressId,
        billingAddressId: state.billingAddressId,
        options: state.options,
        testMode: state.testMode,
        dryRun,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    const validationNotice = hasValidationIssues
      ? `<div class="msg warn">Validation warning: proceeded with ${validation.totalIssues} issue(s) across ${validation.rowsWithIssues} row(s).</div>`
      : '';
    if (data.dryRun) {
      result.className = 'msg ok';
      result.innerHTML = `${validationNotice}Dry run — ${data.plan.length} API call(s) would be made:<pre>${esc(JSON.stringify(data.plan, null, 2))}</pre>`;
    } else {
      result.className = 'msg ok';
      result.innerHTML = `${validationNotice}Created estimate #${esc(String(data.result.estimate_number))} (${esc(data.result.id)}) with ${data.result.options.length} option(s).`;
    }
  } catch (err) {
    result.className = 'msg err';
    result.textContent = err.message;
  }
}

// --- step gating -------------------------------------------------------------
function refreshSteps() {
  // Step 1 (customer) always open.
  const hasCustomer = state.customer && getEffectiveAddressId();
  $('#step-source').classList.toggle('disabled', !hasCustomer);
  const hasSource = Boolean(state.source);
  // Step 3 (file) unlocks once a customer + address + source is chosen.
  $('#step-file').classList.toggle('disabled', !hasCustomer);
  $('#step-file').classList.toggle('disabled', !(hasCustomer && hasSource));
  // Step 4 (confirm) unlocks once both customer and a parsed estimate are ready.
  const ready = hasCustomer && hasSource && state.options;
  $('#step-confirm').classList.toggle('disabled', !ready);
  if (ready) renderSummary();
}

function renderSummary() {
  const total = state.options.reduce((s, o) => s + o.total, 0);
  const validation = getValidationReport(state.options || []);
  const validationWarning = validation.totalIssues > 0
    ? `<div class="summary-warn">Validation warning: ${validation.totalIssues} issue(s) across ${validation.rowsWithIssues} row(s). Dry run/create is still allowed.</div>`
    : '';
  const serviceLine = getAddressLine(state.serviceAddressId) || '(none selected)';
  const billingLine = getAddressLine(state.billingAddressId) || '(none selected)';
  const sourceLabel = SOURCE_CONFIG[state.source]?.label || 'Estimate';
  $('#summary').innerHTML = `
    <div>Customer: <strong>${esc(state.customer.name)}</strong></div>
    <div>Service address: <strong>${esc(serviceLine)}</strong></div>
    <div>Billing address: <strong>${esc(billingLine)}</strong></div>
    <div>Estimate source: <strong>${esc(sourceLabel)}</strong></div>
    <div>Options: <strong>${state.options.length}</strong> · Combined total: <strong>${money(total)}</strong></div>
    <div>TEST labels: <strong>${state.testMode ? 'ON ([TEST] prefix)' : 'OFF'}</strong></div>
    ${validationWarning}
    <div class="hint">Tip: run a dry run first to see exactly what will be sent.</div>`;
}

function updateSourceSelectionUi() {
  document.querySelectorAll('[data-source]').forEach((button) => {
    button.classList.toggle('active', button.dataset.source === state.source);
  });
}

function updateUploadCopy() {
  const config = SOURCE_CONFIG[state.source];
  $('#uploadStepTitle').textContent = config ? config.title : 'Upload your selected file';
  $('#uploadStepHint').innerHTML = config
    ? esc(config.hint)
    : 'Choose an estimate source first.';
  const fileInput = $('#file');
  const duplicateSelector = $('#duplicateEstimateSelector');
  if (fileInput) fileInput.classList.toggle('hidden', Boolean(config && (config.instant || state.source === 'duplicate')));
  if (duplicateSelector) duplicateSelector.classList.toggle('hidden', state.source !== 'duplicate');
}

function clearEstimateDraftState({ keepSource = false } = {}) {
  state.options = null;
  state.sitereconDraft = null;
  state.activeOptionIndex = 0;
  if (!keepSource) state.source = null;
  state.testMode = false;
  $('#testMode').checked = false;
  $('#file').value = '';
  $('#preview').innerHTML = '';
  $('#parseMsg').className = 'msg';
  $('#parseMsg').textContent = '';
  $('#result').className = 'msg';
  $('#result').textContent = '';
  $('#summary').innerHTML = '';
  $('#serviceSearchBox').classList.add('hidden');
  $('#serviceSearch').value = '';
  $('#serviceSearchResults').classList.add('hidden');
}

function confirmSourceChange() {
  const hasDraftState = state.options || state.sitereconDraft || $('#file').value || $('#preview').innerHTML || $('#parseMsg').textContent;
  if (!hasDraftState) return true;
  return confirm('Switch estimate source? This will clear the current upload and preview state.');
}

function initializeSiteReconDraft(payload) {
  if (!payload) return null;
  return {
    rulesVersion: payload.rulesVersion || 1,
    tierOrder: Array.isArray(payload.tierOrder) ? payload.tierOrder : ['best', 'better', 'good'],
    tierRules: payload.tierRules || {},
    optionNames: { ...(payload.optionNames || {}) },
    measurements: Array.isArray(payload.measurements) ? payload.measurements : [],
    baseLines: Array.isArray(payload.baseLines) ? payload.baseLines : [],
    removedLineIds: new Set(),
  };
}

function rebuildSiteReconOptions() {
  if (!state.sitereconDraft) return;

  const draft = state.sitereconDraft;
  const removed = draft.removedLineIds;
  const previousOptions = Array.isArray(state.options) ? state.options : [];
  const previousByTier = new Map(previousOptions.map((opt) => [opt.key, opt]));

  state.options = draft.tierOrder.map((tierKey, idx) => {
    const excludes = new Set(draft.tierRules[tierKey]?.excludeCategories || []);
    const previousOption = previousByTier.get(tierKey);
    const previousGeneratedBySourceId = new Map(
      ((previousOption && previousOption.lineItems) || [])
        .filter((li) => li.sourceLineId)
        .map((li) => [li.sourceLineId, li])
    );

    const generatedLineItems = draft.baseLines
      .filter((line) => !removed.has(line.id))
      .filter((line) => !excludes.has(line.category))
      .map((line) => {
        const previous = previousGeneratedBySourceId.get(line.id);
        const normalized = normalizeLineItem({
          ...line.lineItem,
          ...(previous || {}),
          sourceLineId: line.id,
        }, { lockTaxable: true });
        normalized.taxable = true;
        return normalized;
      });

    const customLineItems = ((previousOption && previousOption.lineItems) || [])
      .filter((li) => !li.sourceLineId)
      .map((li) => normalizeLineItem(li, { lockTaxable: true }));

    const lineItems = [...generatedLineItems, ...customLineItems];

    return {
      key: tierKey,
      name: draft.optionNames[tierKey] || `Option ${idx + 1}`,
      message: null,
      lineItems,
      total: 0,
    };
  });

  recalcOptionTotals(state.options, { lockTaxable: true });
  getActiveOptionIndex();
}

function renderSiteReconReview() {
  if (!state.sitereconDraft) return;

  const draft = state.sitereconDraft;
  const optionsByKey = new Map((state.options || []).map((opt) => [opt.key, opt]));

  const measurementsRows = draft.measurements.map((m) => {
    const status = formatMeasurementStatus(m);
    return `
      <tr>
        <td>${esc(m.layerLabel)}</td>
        <td>${Number(m.quantity || 0)}</td>
        <td>${esc(m.unit || '')}</td>
        <td>${esc(status)}</td>
      </tr>`;
  }).join('');

  const lineRows = draft.baseLines.map((line) => {
    const isIncluded = !draft.removedLineIds.has(line.id);
    const quantity = toNumber(line.lineItem.quantity, 0);
    const unitPrice = toNumber(line.lineItem.unitPrice, 0);
    const amount = quantity * unitPrice;
    const tiers = draft.tierOrder
      .filter((tierKey) => {
        const excludes = new Set(draft.tierRules[tierKey]?.excludeCategories || []);
        return !excludes.has(line.category);
      })
      .map((tierKey) => draft.optionNames[tierKey] || tierKey);

    return `
      <tr>
        <td><input type="checkbox" data-sr-line-toggle="${esc(line.id)}" ${isIncluded ? 'checked' : ''}></td>
        <td>${esc(line.lineItem.name)}</td>
        <td>${esc(line.category)}</td>
        <td>${quantity}</td>
        <td>${money(unitPrice)}</td>
        <td>
          <span class="sr-tax-pill">yes</span>
        </td>
        <td>${money(amount)}</td>
        <td>${esc(tiers.join(', '))}</td>
      </tr>`;
  }).join('');

  const tierSummary = draft.tierOrder.map((tierKey) => {
    const opt = optionsByKey.get(tierKey);
    const total = opt ? opt.total : 0;
    const count = opt ? opt.lineItems.length : 0;
    return `
      <div class="sr-tier-card">
        <label>
          <span>${esc(tierKey)}</span>
          <input type="text" value="${esc(draft.optionNames[tierKey] || '')}" data-option-name="${esc(tierKey)}" />
        </label>
        <div class="hint"><span data-tier-line-count="${esc(tierKey)}">${count}</span> line(s) · <span data-tier-total="${esc(tierKey)}">${money(total)}</span></div>
      </div>`;
  }).join('');

  $('#preview').innerHTML = `
    <div class="sr-review">
      <div class="sr-section">
        <div class="opt-title">A. Measurements received from SiteRecon</div>
        <table>
          <thead><tr><th>Layer</th><th>Quantity</th><th>Unit</th><th>Status</th></tr></thead>
          <tbody>${measurementsRows || '<tr><td colspan="4">No measurements detected.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="sr-section">
        <div class="opt-title">B. Editable estimate lines</div>
        <div class="hint">Use toggles to include or remove generated lines. Detailed edits happen in the spreadsheet editor below. Tax is always yes.</div>
        <table>
          <thead><tr><th>Use</th><th>Line Item</th><th>Category</th><th>Qty</th><th>Unit Price</th><th>Tax</th><th>Amount</th><th>In Options</th></tr></thead>
          <tbody>${lineRows || '<tr><td colspan="8">No generated lines available.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="sr-section">
        <div class="opt-title">Option names and totals</div>
        <div class="sr-tier-grid">${tierSummary}</div>
      </div>
      <div class="sr-section">
        <div class="opt-title">D. Estimate spreadsheet preview</div>
        <div class="hint">Edit rows directly below before dry run/create. This is the structure that will be sent to HCP.</div>
        ${renderEstimateSpreadsheetEditor(state.options || [], { lockTaxable: true, allowOptionNameEdit: false })}
      </div>
    </div>`;

  document.querySelectorAll('[data-sr-line-toggle]').forEach((el) => {
    el.addEventListener('change', (evt) => {
      const lineId = evt.target.getAttribute('data-sr-line-toggle');
      if (!lineId) return;
      if (evt.target.checked) {
        draft.removedLineIds.delete(lineId);
      } else {
        draft.removedLineIds.add(lineId);
      }
      rebuildSiteReconOptions();
      renderSiteReconReview();
      refreshSteps();
    });
  });

  document.querySelectorAll('[data-option-name]').forEach((el) => {
    el.addEventListener('input', (evt) => {
      const key = evt.target.getAttribute('data-option-name');
      if (!key) return;
      draft.optionNames[key] = evt.target.value.trim() || key;
      rebuildSiteReconOptions();
      renderSiteReconReview();
      refreshSteps();
    });
  });
}

function renderEstimateSpreadsheetEditor(options, { lockTaxable = false, allowOptionNameEdit = true } = {}) {
  if (!options.length) {
    return '<div class="hint">No lines in this estimate yet.</div>';
  }

  const combinedTotal = options.reduce((sum, opt) => sum + Number(opt.total || 0), 0);
  const validationReport = getValidationReport(options);
  const availableUnits = getAvailableUnits(options);
  const canRemoveOption = allowOptionNameEdit && options.length > 1;
  const activeOptionIndex = getActiveOptionIndex();
  const activeOption = options[activeOptionIndex];

  const optionTabs = options.map((opt, optionIndex) => {
    const isActive = optionIndex === activeOptionIndex;
    return `
      <button
        type="button"
        class="sheet-option-tab${isActive ? ' active' : ''}"
        data-ed-action="set-active-option"
        data-ed-option="${optionIndex}"
      >
        <span class="sheet-option-tab-name">${esc(opt.name || `Option ${optionIndex + 1}`)}</span>
        <span class="sheet-option-tab-meta">${money(opt.total || 0)} · ${(opt.lineItems || []).length} line(s)</span>
      </button>`;
  }).join('');

  const rows = (activeOption.lineItems || []).map((li, lineIndex) => {
    const qty = toNumber(li.quantity, 0);
    const unitPrice = toNumber(li.unitPrice, 0);
    const amount = getLineAmount(li);
    const taxAttr = lockTaxable ? ' checked disabled' : (li.taxable ? ' checked' : '');
    const issues = getLineValidationIssues(li);
    const qtyInvalid = issues.some((msg) => msg.startsWith('Qty'));
    const priceInvalid = issues.some((msg) => msg.startsWith('Unit price'));
    const flatInvalid = issues.some((msg) => msg.startsWith('Flat amount'));
    const kindInvalid = issues.some((msg) => msg.startsWith('Kind'));
    const pricingMode = String(li.pricingMode || 'calculated').trim() || 'calculated';
    const isFlat = pricingMode === 'flat';
    const recurringClass = String(li.frequency || 'single').trim() === 'single' ? '' : 'sheet-recurring-row';
    return `
      <tr class="${recurringClass}" data-ed-row="${activeOptionIndex}:${lineIndex}">
        <td><input type="text" class="sr-input" data-ed-field="name" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${esc(li.name || '')}" /></td>
        <td><input type="text" class="sr-input" data-ed-field="description" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${esc(li.description || '')}" /></td>
        <td>
          <div class="sheet-unit-group">
            <select class="sr-input" data-ed-field="unitOfMeasure" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}">
              ${renderUnitOptions(li.unitOfMeasure || '', availableUnits)}
            </select>
            <div class="sheet-unit-qty-label" data-ed-qty-label="${activeOptionIndex}:${lineIndex}">${esc(formatQtyContextLabel(li.unitOfMeasure))}</div>
            <input type="number" step="any" class="sr-input sr-number ${qtyInvalid ? 'sheet-invalid' : ''}" data-ed-field="quantity" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${qty}" />
          </div>
        </td>
        <td>
          <select class="sr-input" data-ed-field="frequency" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}">
            ${renderFrequencyOptions(li.frequency)}
          </select>
        </td>
        <td><input type="number" step="0.01" class="sr-input sr-number ${priceInvalid ? 'sheet-invalid' : ''}" data-ed-field="unitPrice" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${unitPrice}" /></td>
        <td>
          <div class="sheet-pricing-group">
            <select class="sr-input" data-ed-field="pricingMode" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}">
              ${renderPricingModeOptions(pricingMode)}
            </select>
            <input type="number" step="0.01" class="sr-input sr-number ${flatInvalid ? 'sheet-invalid' : ''}" data-ed-field="flatAmount" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${toNumber(li.flatAmount, 0)}"${isFlat ? '' : ' disabled'} />
            <div class="sheet-pricing-hint" data-ed-pricing-hint="${activeOptionIndex}:${lineIndex}">${isFlat ? 'Flat amount override' : 'Auto: Qty x Unit Price'}</div>
          </div>
        </td>
        <td><input type="text" class="sr-input ${kindInvalid ? 'sheet-invalid' : ''}" data-ed-field="kind" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${esc(li.kind || 'labor')}" /></td>
        <td><input type="checkbox" data-ed-field="taxable" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}"${taxAttr}></td>
        <td><input type="text" class="sr-input" data-ed-field="notes" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}" value="${esc(li.notes || '')}" /></td>
        <td data-ed-amount="${activeOptionIndex}:${lineIndex}">${money(amount)}${isFlat ? '<span class="sheet-badge flat">Flat</span>' : ''}</td>
        <td class="sheet-actions-col">
          <div class="sheet-badges" data-ed-badges="${activeOptionIndex}:${lineIndex}">${renderFrequencyBadge(li.frequency)}${renderLineValidationBadges(issues)}</div>
          <button type="button" class="sheet-mini-btn" data-ed-action="duplicate-row" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}">Duplicate</button>
          <button type="button" class="sheet-mini-btn danger" data-ed-action="delete-row" data-ed-option="${activeOptionIndex}" data-ed-line="${lineIndex}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  const optionLabel = allowOptionNameEdit
    ? `<input type="text" class="sr-input sheet-opt-name" data-ed-option-name="${activeOptionIndex}" value="${esc(activeOption.name || `Option ${activeOptionIndex + 1}`)}" />`
    : `<strong>${esc(activeOption.name || `Option ${activeOptionIndex + 1}`)}</strong>`;

  return `
    <div class="sheet-rail">
      <div class="sheet-rail-metrics">
        <div class="hint">Editing: <strong>${esc(activeOption.name || `Option ${activeOptionIndex + 1}`)}</strong></div>
        <div class="sheet-validation-summary" data-ed-validation-summary>${renderValidationSummary(validationReport)}</div>
        <div class="sheet-grand-total">Combined total: <strong data-ed-grand-total>${money(combinedTotal)}</strong></div>
      </div>
      <div class="sheet-rail-actions">
        <button type="button" class="sheet-mini-btn" data-ed-action="quick-dry">Dry run</button>
        <button type="button" class="sheet-mini-btn sheet-mini-btn-primary" data-ed-action="quick-create">Create estimate</button>
      </div>
    </div>

    <div class="sheet-toolbar">
      <div class="hint">Pick an option tab and focus one estimate tier at a time.</div>
      ${allowOptionNameEdit ? '<div class="sheet-add-option-row"><button type="button" class="sheet-mini-btn" data-ed-action="add-option">+ Add Option</button></div>' : ''}
    </div>

    <div class="sheet-option-tabs" role="tablist" aria-label="Estimate options">
      ${optionTabs}
    </div>

    <div class="sheet-option-block">
      <div class="sheet-option-header">
        <div class="sheet-option-title">${optionLabel}</div>
        <div class="sheet-option-tools">
          <button type="button" class="sheet-mini-btn" data-ed-action="add-row" data-ed-option="${activeOptionIndex}">+ Add Row</button>
          ${canRemoveOption ? `<button type="button" class="sheet-mini-btn danger" data-ed-action="remove-option" data-ed-option="${activeOptionIndex}">Remove Option</button>` : ''}
          <span class="hint">Subtotal: <strong data-ed-option-total="${activeOptionIndex}">${money(activeOption.total || 0)}</strong></span>
        </div>
      </div>
      <div class="sheet-scroll">
        <table class="sheet-table">
          <thead><tr><th>Service</th><th>Description</th><th>Unit of Measure</th><th>Frequency</th><th>Unit Price</th><th>Pricing</th><th>Kind</th><th>Tax</th><th>Notes</th><th>Amount</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="11">No lines in this option yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}
const VALID_LINE_KINDS = new Set(['labor', 'material', 'service', 'discount', 'tax']);
const COMMON_UNITS = ['ea', 'ft', 'sq ft', 'hr', 'day', 'yd', 'cu yd'];

function getAvailableUnits(options) {
  const seen = new Set();
  (options || []).forEach((opt) => {
    (opt.lineItems || []).forEach((li) => {
      const unit = String(li?.unitOfMeasure || li?.unit_of_measure || '').trim();
      if (unit) seen.add(unit);
    });
  });

  if (!seen.size) {
    COMMON_UNITS.forEach((u) => seen.add(u));
  }

  return Array.from(seen);
}

function renderUnitOptions(currentUnit, units) {
  const current = String(currentUnit || '').trim();
  const normalized = Array.isArray(units) ? [...units] : [];
  if (current && !normalized.includes(current)) normalized.unshift(current);
  if (!current && !normalized.includes('')) normalized.unshift('');
  return normalized
    .map((unit) => `<option value="${esc(unit)}" ${unit === current ? 'selected' : ''}>${esc(unit || '(none)')}</option>`)
    .join('');
}

const FREQUENCY_OPTIONS = [
  { value: 'single', label: 'Single (one-time)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'bi-weekly', label: 'Bi-weekly' },
  { value: 'twice-monthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'every-6-months', label: 'Every 6 months' },
  { value: 'annually', label: 'Annually' },
];

const PRICING_MODE_OPTIONS = [
  { value: 'calculated', label: 'Calculated' },
  { value: 'flat', label: 'Flat rate' },
];

function renderFrequencyOptions(currentFrequency) {
  const current = String(currentFrequency || 'single').trim() || 'single';
  const normalized = [...FREQUENCY_OPTIONS];
  if (!normalized.some((f) => f.value === current)) {
    normalized.unshift({ value: current, label: current });
  }
  return normalized
    .map((f) => `<option value="${esc(f.value)}" ${f.value === current ? 'selected' : ''}>${esc(f.label)}</option>`)
    .join('');
}

function renderPricingModeOptions(currentMode) {
  const current = String(currentMode || 'calculated').trim() || 'calculated';
  return PRICING_MODE_OPTIONS
    .map((mode) => `<option value="${esc(mode.value)}" ${mode.value === current ? 'selected' : ''}>${esc(mode.label)}</option>`)
    .join('');
}

function getFrequencyLabel(frequencyValue) {
  const value = String(frequencyValue || 'single').trim() || 'single';
  const found = FREQUENCY_OPTIONS.find((f) => f.value === value);
  return found ? found.label : value;
}

function renderFrequencyBadge(frequencyValue) {
  const value = String(frequencyValue || 'single').trim() || 'single';
  if (value === 'single') return '';
  return `<span class="sheet-badge info">Recurring: ${esc(getFrequencyLabel(value))}</span>`;
}

function formatQtyContextLabel(unitOfMeasure) {
  const unit = String(unitOfMeasure || '').trim();
  return unit ? `Qty of ${unit}` : 'Qty for selected unit';
}

function getLineValidationIssues(line) {
  const issues = [];
  if (toNumber(line?.quantity, 0) <= 0) issues.push('Qty must be > 0');
  if (toNumber(line?.unitPrice, 0) < 0) issues.push('Unit price must be >= 0');
  if (String(line?.pricingMode || 'calculated').trim() === 'flat' && toNumber(line?.flatAmount, 0) < 0) {
    issues.push('Flat amount must be >= 0');
  }
  const kind = String(line?.kind || '').trim().toLowerCase();
  if (!kind || !VALID_LINE_KINDS.has(kind)) issues.push('Kind is not recognized');
  return issues;
}

function getLineAmount(line) {
  const pricingMode = String(line?.pricingMode || 'calculated').trim() || 'calculated';
  if (pricingMode === 'flat') return toNumber(line?.flatAmount, 0);
  return toNumber(line?.quantity, 0) * toNumber(line?.unitPrice, 0);
}

function getValidationReport(options) {
  let totalIssues = 0;
  let rowsWithIssues = 0;
  (options || []).forEach((opt) => {
    (opt.lineItems || []).forEach((line) => {
      const issues = getLineValidationIssues(line);
      if (issues.length) {
        rowsWithIssues += 1;
        totalIssues += issues.length;
      }
    });
  });
  return { totalIssues, rowsWithIssues };
}

function renderValidationSummary(report) {
  if (!report || !report.totalIssues) {
    return '<span class="sheet-badge ok">No validation issues</span>';
  }
  return `<span class="sheet-badge err">${report.totalIssues} issue(s) across ${report.rowsWithIssues} row(s)</span>`;
}

function renderLineValidationBadges(issues) {
  if (!issues || !issues.length) {
    return '<span class="sheet-badge ok">ok</span>';
  }
  return issues.map((issue) => `<span class="sheet-badge err">${esc(issue)}</span>`).join('');
}

function updateLineValidationUi(optionIndex, lineIndex, line) {
  const issues = getLineValidationIssues(line);
  const badgesEl = document.querySelector(`[data-ed-badges="${optionIndex}:${lineIndex}"]`);
  if (badgesEl) badgesEl.innerHTML = `${renderFrequencyBadge(line?.frequency)}${renderLineValidationBadges(issues)}`;

  const rowEl = document.querySelector(`[data-ed-row="${optionIndex}:${lineIndex}"]`);
  if (rowEl) {
    const frequency = String(line?.frequency || 'single').trim() || 'single';
    rowEl.classList.toggle('sheet-recurring-row', frequency !== 'single');
  }

  const qtyLabel = document.querySelector(`[data-ed-qty-label="${optionIndex}:${lineIndex}"]`);
  if (qtyLabel) qtyLabel.textContent = formatQtyContextLabel(line?.unitOfMeasure);

  const quantityInput = document.querySelector(`[data-ed-field="quantity"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);
  const priceInput = document.querySelector(`[data-ed-field="unitPrice"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);
  const pricingModeInput = document.querySelector(`[data-ed-field="pricingMode"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);
  const flatAmountInput = document.querySelector(`[data-ed-field="flatAmount"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);
  const pricingHint = document.querySelector(`[data-ed-pricing-hint="${optionIndex}:${lineIndex}"]`);
  const kindInput = document.querySelector(`[data-ed-field="kind"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);

  const isFlat = String(line?.pricingMode || 'calculated').trim() === 'flat';
  if (flatAmountInput) {
    flatAmountInput.disabled = !isFlat;
    flatAmountInput.classList.toggle('sheet-invalid', isFlat && issues.some((msg) => msg.startsWith('Flat amount')));
  }
  if (pricingHint) pricingHint.textContent = isFlat ? 'Flat amount override' : 'Auto: Qty x Unit Price';
  if (pricingModeInput) pricingModeInput.value = isFlat ? 'flat' : 'calculated';

  if (quantityInput) quantityInput.classList.toggle('sheet-invalid', issues.some((msg) => msg.startsWith('Qty')));
  if (priceInput) priceInput.classList.toggle('sheet-invalid', issues.some((msg) => msg.startsWith('Unit price')));
  if (kindInput) kindInput.classList.toggle('sheet-invalid', issues.some((msg) => msg.startsWith('Kind')));
}

function normalizeLineItem(lineItem, { lockTaxable = false } = {}) {
  const normalized = {
    ...lineItem,
    name: String(lineItem?.name || '').trim(),
    description: String(lineItem?.description || '').trim(),
    quantity: toNumber(lineItem?.quantity, 0),
    unitOfMeasure: String(lineItem?.unitOfMeasure || lineItem?.unit_of_measure || '').trim(),
    frequency: String(lineItem?.frequency || 'single').trim() || 'single',
    pricingMode: String(lineItem?.pricingMode || 'calculated').trim() || 'calculated',
    flatAmount: toNumber(lineItem?.flatAmount, 0),
    unitPrice: toNumber(lineItem?.unitPrice, 0),
    kind: String(lineItem?.kind || 'labor').trim() || 'labor',
    taxable: lockTaxable ? true : Boolean(lineItem?.taxable),
    notes: String(lineItem?.notes || '').trim(),
  };
  if (lockTaxable) normalized.taxable = true;
  return normalized;
}

function normalizeOptionsForEditor(options, { lockTaxable = false } = {}) {
  const normalized = (Array.isArray(options) ? options : []).map((opt, idx) => ({
    ...opt,
    name: String(opt?.name || `Option ${idx + 1}`).trim() || `Option ${idx + 1}`,
    message: opt?.message || null,
    lineItems: (Array.isArray(opt?.lineItems) ? opt.lineItems : []).map((li) => normalizeLineItem(li, { lockTaxable })),
    total: 0,
  }));
  recalcOptionTotals(normalized, { lockTaxable });
  return normalized;
}

function recalcOptionTotals(options, { lockTaxable = false } = {}) {
  (options || []).forEach((opt) => {
    let subtotal = 0;
    (opt.lineItems || []).forEach((li) => {
      li.quantity = toNumber(li.quantity, 0);
      li.unitPrice = toNumber(li.unitPrice, 0);
      li.flatAmount = toNumber(li.flatAmount, 0);
      li.pricingMode = String(li.pricingMode || 'calculated').trim() || 'calculated';
      if (lockTaxable) li.taxable = true;
      subtotal += getLineAmount(li);
    });
    opt.total = subtotal;
  });
}

function addOption() {
  state.options = state.options || [];
  const used = new Set(state.options.map((o) => o.name));
  const name = ['Good', 'Better', 'Best'].find((n) => !used.has(n)) || `Option ${state.options.length + 1}`;
  state.options.push({
    name,
    message: null,
    lineItems: [normalizeLineItem(starterLine({ name: 'New line item' }), { lockTaxable: false })],
    total: 0,
  });
  state.activeOptionIndex = state.options.length - 1;
  recalcOptionTotals(state.options, { lockTaxable: false });
}

function removeOption(optionIndex) {
  if (!Array.isArray(state.options) || state.options.length <= 1) return;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= state.options.length) return;
  state.options.splice(optionIndex, 1);
  if (state.activeOptionIndex >= state.options.length) {
    state.activeOptionIndex = state.options.length - 1;
  }
  state.activeOptionIndex = Math.max(0, state.activeOptionIndex);
  recalcOptionTotals(state.options, { lockTaxable: false });
}

function addBlankRow(optionIndex) {
  const option = (state.options || [])[optionIndex];
  if (!option) return;
  option.lineItems = option.lineItems || [];
  option.lineItems.push(normalizeLineItem({
    name: 'Custom line item',
    description: '',
    quantity: 1,
    unitOfMeasure: '',
    frequency: 'single',
    pricingMode: 'calculated',
    flatAmount: 0,
    unitPrice: 0,
    kind: 'labor',
    taxable: state.source !== 'siterecon',
    notes: '',
  }, { lockTaxable: state.source === 'siterecon' }));
}

function duplicateRow(optionIndex, lineIndex) {
  const option = (state.options || [])[optionIndex];
  if (!option || !option.lineItems || !option.lineItems[lineIndex]) return;
  const source = option.lineItems[lineIndex];
  const clone = normalizeLineItem({
    ...source,
    sourceLineId: null,
  }, { lockTaxable: state.source === 'siterecon' });
  option.lineItems.splice(lineIndex + 1, 0, clone);
}

function deleteRow(optionIndex, lineIndex) {
  const option = (state.options || [])[optionIndex];
  if (!option || !option.lineItems) return;
  const line = option.lineItems[lineIndex];
  if (state.source === 'siterecon' && line && line.sourceLineId) {
    state.sitereconDraft?.removedLineIds?.add(line.sourceLineId);
    rebuildSiteReconOptions();
    return;
  }
  option.lineItems.splice(lineIndex, 1);
}

function applyGeneratedLineAcrossOptions(sourceLineId, updater) {
  (state.options || []).forEach((opt) => {
    (opt.lineItems || []).forEach((li) => {
      if (li.sourceLineId === sourceLineId) {
        updater(li);
        li.taxable = true;
      }
    });
  });
  updateSiteReconLine(sourceLineId, (lineItem) => {
    updater(lineItem);
    lineItem.taxable = true;
  });
}

function updateLineFromEditor(optionIndex, lineIndex, field, rawValue) {
  const option = (state.options || [])[optionIndex];
  const line = option && option.lineItems && option.lineItems[lineIndex];
  if (!line) return;

  const update = (target) => {
    if (field === 'quantity') target.quantity = toNumber(rawValue, 0);
    else if (field === 'unitPrice') target.unitPrice = toNumber(rawValue, 0);
    else if (field === 'flatAmount') target.flatAmount = toNumber(rawValue, 0);
    else if (field === 'pricingMode') target.pricingMode = String(rawValue || 'calculated').trim() || 'calculated';
    else if (field === 'taxable') target.taxable = state.source === 'siterecon' ? true : Boolean(rawValue);
    else if (field === 'unitOfMeasure') target.unitOfMeasure = String(rawValue || '').trim();
    else if (field === 'frequency') target.frequency = String(rawValue || 'single').trim() || 'single';
    else if (field === 'kind') target.kind = String(rawValue || '').trim() || 'labor';
    else if (field === 'description') target.description = String(rawValue || '').trim();
    else if (field === 'name') target.name = String(rawValue || '').trim();
    else if (field === 'notes') target.notes = String(rawValue || '').trim();
  };

  if (state.source === 'siterecon' && line.sourceLineId && field !== 'taxable') {
    applyGeneratedLineAcrossOptions(line.sourceLineId, update);
  } else {
    update(line);
    if (state.source === 'siterecon') line.taxable = true;
  }
}

function syncOptionNameFromEditor(optionIndex, rawName) {
  const option = (state.options || [])[optionIndex];
  if (!option) return;
  const nextName = String(rawName || '').trim() || `Option ${optionIndex + 1}`;
  option.name = nextName;
  if (state.sitereconDraft && option.key) {
    state.sitereconDraft.optionNames[option.key] = nextName;
  }
}

function updateSpreadsheetComputedUi() {
  const lockTaxable = state.source === 'siterecon';
  recalcOptionTotals(state.options || [], { lockTaxable });

  (state.options || []).forEach((opt, optionIndex) => {
    const optionTotalEl = document.querySelector(`[data-ed-option-total="${optionIndex}"]`);
    if (optionTotalEl) optionTotalEl.textContent = money(opt.total);

    if (opt.key) {
      const tierTotalEl = document.querySelector(`[data-tier-total="${opt.key}"]`);
      if (tierTotalEl) tierTotalEl.textContent = money(opt.total);
      const tierCountEl = document.querySelector(`[data-tier-line-count="${opt.key}"]`);
      if (tierCountEl) tierCountEl.textContent = String((opt.lineItems || []).length);
    }

    (opt.lineItems || []).forEach((li, lineIndex) => {
      const amountEl = document.querySelector(`[data-ed-amount="${optionIndex}:${lineIndex}"]`);
      if (amountEl) {
        const isFlat = String(li.pricingMode || 'calculated').trim() === 'flat';
        amountEl.innerHTML = `${money(getLineAmount(li))}${isFlat ? '<span class="sheet-badge flat">Flat</span>' : ''}`;
      }
      updateLineValidationUi(optionIndex, lineIndex, li);
    });
  });

  const summaryEl = document.querySelector('[data-ed-validation-summary]');
  if (summaryEl) summaryEl.innerHTML = renderValidationSummary(getValidationReport(state.options || []));

  const combinedTotal = (state.options || []).reduce((sum, opt) => sum + Number(opt.total || 0), 0);
  const grandTotalEl = document.querySelector('[data-ed-grand-total]');
  if (grandTotalEl) grandTotalEl.textContent = money(combinedTotal);

  if (state.customer && getEffectiveAddressId()) renderSummary();
}

function renderCurrentEstimateView() {
  if (state.source === 'siterecon' && state.sitereconDraft) {
    renderSiteReconReview();
    return;
  }
  renderPreview();
}

function setupEstimateEditorEvents() {
  const preview = $('#preview');
  if (!preview) return;

  preview.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-ed-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-ed-action');

    if (action === 'add-option') {
      addOption();
      renderCurrentEstimateView();
      refreshSteps();
      return;
    }

    if (action === 'quick-dry') {
      submit(true);
      return;
    }

    if (action === 'quick-create') {
      submit(false);
      return;
    }

    const optionIndex = Number(btn.getAttribute('data-ed-option'));
    const lineIndex = Number(btn.getAttribute('data-ed-line'));

    if (action === 'set-active-option') {
      if (!Number.isFinite(optionIndex)) return;
      state.activeOptionIndex = optionIndex;
      renderCurrentEstimateView();
      refreshSteps();
      return;
    }

    if (!Number.isFinite(optionIndex)) return;

    if (action === 'add-row') {
      addBlankRow(optionIndex);
      renderCurrentEstimateView();
      refreshSteps();
      return;
    }

    if (action === 'remove-option') {
      removeOption(optionIndex);
      renderCurrentEstimateView();
      refreshSteps();
      return;
    }

    if (!Number.isFinite(lineIndex)) return;
    if (action === 'duplicate-row') duplicateRow(optionIndex, lineIndex);
    if (action === 'delete-row') deleteRow(optionIndex, lineIndex);

    renderCurrentEstimateView();
    refreshSteps();
  });

  preview.addEventListener('input', (evt) => {
    const optionNameIndex = evt.target.getAttribute('data-ed-option-name');
    if (optionNameIndex !== null) {
      syncOptionNameFromEditor(Number(optionNameIndex), evt.target.value);
      updateSpreadsheetComputedUi();
      return;
    }

    const field = evt.target.getAttribute('data-ed-field');
    if (!field) return;
    const optionIndex = Number(evt.target.getAttribute('data-ed-option'));
    const lineIndex = Number(evt.target.getAttribute('data-ed-line'));
    if (!Number.isFinite(optionIndex) || !Number.isFinite(lineIndex)) return;

    const rawValue = field === 'taxable' ? evt.target.checked : evt.target.value;
    updateLineFromEditor(optionIndex, lineIndex, field, rawValue);
    updateSpreadsheetComputedUi();
  });

  preview.addEventListener('change', (evt) => {
    const target = evt.target;
    if (!target || !target.matches || !target.matches('[data-ed-field]')) return;
    const field = target.getAttribute('data-ed-field');
    if (field !== 'unitOfMeasure') return;

    const optionIndex = Number(target.getAttribute('data-ed-option'));
    const lineIndex = Number(target.getAttribute('data-ed-line'));
    if (!Number.isFinite(optionIndex) || !Number.isFinite(lineIndex)) return;

    const qtyInput = document.querySelector(`[data-ed-field="quantity"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`);
    if (!qtyInput || qtyInput.disabled || typeof qtyInput.focus !== 'function') return;
    qtyInput.focus();
    if (typeof qtyInput.select === 'function') qtyInput.select();
  });

  preview.addEventListener('keydown', (evt) => {
    const target = evt.target;
    if (!target || !target.matches || !target.matches('[data-ed-field], [data-ed-option-name]')) return;

    if (evt.key === 'Tab') {
      const moved = focusTabWithinSheet(target, evt.shiftKey ? -1 : 1);
      if (moved) evt.preventDefault();
      return;
    }

    const arrowMoved = focusArrowWithinSheet(target, evt.key);
    if (arrowMoved) {
      evt.preventDefault();
      return;
    }

    if (evt.key !== 'Enter') return;

    // Spreadsheet-style navigation: Enter moves forward, Shift+Enter moves backward.
    evt.preventDefault();
    focusAdjacentEditorField(target, evt.shiftKey ? -1 : 1);
  });
}

const ROW_FIELD_ORDER = ['name', 'description', 'unitOfMeasure', 'quantity', 'frequency', 'unitPrice', 'pricingMode', 'flatAmount', 'kind', 'taxable', 'notes'];

function getOptionLineCount(optionIndex) {
  const option = (state.options || [])[optionIndex];
  return option && Array.isArray(option.lineItems) ? option.lineItems.length : 0;
}

function getRowFocusableFields(optionIndex, lineIndex) {
  return ROW_FIELD_ORDER
    .map((field) => document.querySelector(`[data-ed-field="${field}"][data-ed-option="${optionIndex}"][data-ed-line="${lineIndex}"]`))
    .filter((el) => el && !el.disabled);
}

function focusRowField(optionIndex, lineIndex, edge = 'first') {
  const fields = getRowFocusableFields(optionIndex, lineIndex);
  if (!fields.length) return false;
  const target = edge === 'last' ? fields[fields.length - 1] : fields[0];
  target.focus();
  if (typeof target.select === 'function' && target.tagName === 'INPUT' && target.type !== 'checkbox') {
    target.select();
  }
  return true;
}

function focusOptionName(optionIndex) {
  const el = document.querySelector(`[data-ed-option-name="${optionIndex}"]`);
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function') el.select();
  return true;
}

function focusTabWithinSheet(currentEl, delta) {
  const options = state.options || [];
  if (!options.length) return false;

  const optionNameIndexRaw = currentEl.getAttribute('data-ed-option-name');
  if (optionNameIndexRaw !== null) {
    const optionIndex = Number(optionNameIndexRaw);
    if (!Number.isFinite(optionIndex)) return false;

    if (delta > 0) {
      if (focusRowField(optionIndex, 0, 'first')) return true;
      for (let oi = optionIndex + 1; oi < options.length; oi += 1) {
        if (focusOptionName(oi)) return true;
        if (focusRowField(oi, 0, 'first')) return true;
      }
      return focusOptionName(0) || focusRowField(0, 0, 'first');
    }

    for (let oi = optionIndex - 1; oi >= 0; oi -= 1) {
      const lines = getOptionLineCount(oi);
      if (lines > 0 && focusRowField(oi, lines - 1, 'last')) return true;
      if (focusOptionName(oi)) return true;
    }
    const lastOptionIndex = options.length - 1;
    const lastLines = getOptionLineCount(lastOptionIndex);
    if (lastLines > 0) return focusRowField(lastOptionIndex, lastLines - 1, 'last');
    return focusOptionName(lastOptionIndex);
  }

  const field = currentEl.getAttribute('data-ed-field');
  const optionIndex = Number(currentEl.getAttribute('data-ed-option'));
  const lineIndex = Number(currentEl.getAttribute('data-ed-line'));
  if (!field || !Number.isFinite(optionIndex) || !Number.isFinite(lineIndex)) return false;

  const rowFields = getRowFocusableFields(optionIndex, lineIndex);
  const currentPos = rowFields.indexOf(currentEl);
  if (currentPos >= 0) {
    const nextPos = currentPos + delta;
    if (nextPos >= 0 && nextPos < rowFields.length) {
      const next = rowFields[nextPos];
      next.focus();
      if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'checkbox') {
        next.select();
      }
      return true;
    }
  }

  if (delta > 0) {
    const optionLineCount = getOptionLineCount(optionIndex);
    if (lineIndex + 1 < optionLineCount) return focusRowField(optionIndex, lineIndex + 1, 'first');

    for (let oi = optionIndex + 1; oi < options.length; oi += 1) {
      if (focusOptionName(oi)) return true;
      if (focusRowField(oi, 0, 'first')) return true;
    }

    return focusOptionName(0) || focusRowField(0, 0, 'first');
  }

  if (lineIndex - 1 >= 0) return focusRowField(optionIndex, lineIndex - 1, 'last');
  if (focusOptionName(optionIndex)) return true;

  for (let oi = optionIndex - 1; oi >= 0; oi -= 1) {
    const lines = getOptionLineCount(oi);
    if (lines > 0 && focusRowField(oi, lines - 1, 'last')) return true;
    if (focusOptionName(oi)) return true;
  }

  const lastOptionIndex = options.length - 1;
  const lastLines = getOptionLineCount(lastOptionIndex);
  if (lastLines > 0) return focusRowField(lastOptionIndex, lastLines - 1, 'last');
  return focusOptionName(lastOptionIndex);
}

function focusArrowWithinSheet(currentEl, key) {
  if (!currentEl || currentEl.tagName === 'SELECT') return false;
  const field = currentEl.getAttribute('data-ed-field');
  const optionIndex = Number(currentEl.getAttribute('data-ed-option'));
  const lineIndex = Number(currentEl.getAttribute('data-ed-line'));
  if (!field || !Number.isFinite(optionIndex) || !Number.isFinite(lineIndex)) return false;

  if ((key === 'ArrowLeft' || key === 'ArrowRight') && !shouldUseHorizontalArrowNavigation(currentEl, key)) {
    return false;
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const delta = key === 'ArrowLeft' ? -1 : 1;
    const rowFields = getRowFocusableFields(optionIndex, lineIndex);
    const pos = rowFields.indexOf(currentEl);
    if (pos < 0) return false;
    const nextPos = pos + delta;
    if (nextPos < 0 || nextPos >= rowFields.length) return false;
    const next = rowFields[nextPos];
    next.focus();
    if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'checkbox') next.select();
    return true;
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const nextLine = key === 'ArrowUp' ? lineIndex - 1 : lineIndex + 1;
    const optionLineCount = getOptionLineCount(optionIndex);

    if (nextLine >= 0 && nextLine < optionLineCount) {
      const next = document.querySelector(`[data-ed-field="${field}"][data-ed-option="${optionIndex}"][data-ed-line="${nextLine}"]`);
      if (!next || next.disabled) return false;
      next.focus();
      if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'checkbox') next.select();
      return true;
    }

    const options = state.options || [];
    const step = key === 'ArrowUp' ? -1 : 1;
    let oi = optionIndex + step;
    while (oi >= 0 && oi < options.length) {
      const count = getOptionLineCount(oi);
      if (count > 0) {
        const li = key === 'ArrowUp' ? count - 1 : 0;
        const next = document.querySelector(`[data-ed-field="${field}"][data-ed-option="${oi}"][data-ed-line="${li}"]`);
        if (next && !next.disabled) {
          next.focus();
          if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'checkbox') next.select();
          return true;
        }
      }
      oi += step;
    }
  }

  return false;
}

function shouldUseHorizontalArrowNavigation(el, key) {
  if (!el || el.tagName !== 'INPUT') return true;
  const type = String(el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'number') return true;
  if (type !== 'text' && type !== 'search' && type !== 'url' && type !== 'email' && type !== 'tel') return true;
  if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return true;

  // Keep native caret movement unless the caret is at the edge.
  if (el.selectionStart !== el.selectionEnd) return false;
  if (key === 'ArrowLeft') return el.selectionStart === 0;
  if (key === 'ArrowRight') return el.selectionStart === el.value.length;
  return true;
}

function focusAdjacentEditorField(currentEl, delta) {
  const preview = $('#preview');
  if (!preview) return;

  const fields = Array.from(preview.querySelectorAll('[data-ed-field], [data-ed-option-name]'))
    .filter((el) => !el.disabled && el.offsetParent !== null);

  const index = fields.indexOf(currentEl);
  if (index < 0) return;

  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= fields.length) return;

  const next = fields[nextIndex];
  if (!next || typeof next.focus !== 'function') return;
  next.focus();
  if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'checkbox') {
    next.select();
  }
}

function updateSiteReconLine(lineId, updater) {
  if (!state.sitereconDraft || !Array.isArray(state.sitereconDraft.baseLines)) return;
  const line = state.sitereconDraft.baseLines.find((item) => item.id === lineId);
  if (!line) return;
  updater(line.lineItem);
  line.lineItem.taxable = true;
}

function toNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function formatMeasurementStatus(measurement) {
  if (measurement.status === 'suppressed') {
    return `suppressed by ${measurement.suppressedBy || 'overlap rule'}`;
  }
  if (measurement.status === 'reference-only') return 'reference only';
  if (measurement.status === 'missing-pricebook-item') return 'missing pricebook item';
  if (measurement.status === 'inactive') return 'inactive mapping';
  return measurement.status || 'mapped';
}

function getEffectiveAddressId() {
  return state.serviceAddressId || state.billingAddressId || null;
}

function getAddressLine(id) {
  if (!id || !state.customer || !Array.isArray(state.customer.addresses)) return null;
  const found = state.customer.addresses.find((a) => a.id === id);
  return found ? found.line : null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

updateSourceSelectionUi();
updateUploadCopy();
refreshSteps();
setupEstimateEditorEvents();
