// Customer Intake — backend unit tests (node:test, zero-dep).
// Pure helpers are tested directly; DB functions run against a recording mock pool
// that asserts SQL/behaviour without a live Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_COLUMNS, INTAKE_STATUSES, intakeEnabled, splitPatch, staffName,
  createDraft, getIntake, updateDraft, listIntakes,
  buildLookupAttempts, lookupCustomer, customerToDraftPatch,
  normalizePhone, isValidEmail, validateCustomer, customerStepStatus,
  intakeWriteEnabled, buildCustomerCreatePayload,
  DISCOVERY_QUESTIONS, isQuestionVisible, validateDiscovery, discoveryStepStatus,
  intakeNoteMarker, buildIntakeNote, buildEstimateSummary,
  notifyRecipients, buildNotificationSms,
  ensureCustomer, ensureEstimate, recoverInterruptedIntakes,
} from '../src/intake.js';
import { unionTags } from '../src/hcp.js';

// --- mock pool -------------------------------------------------------------
function makePool(responder) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    const r = responder(sql, params) || {};
    return { rows: r.rows || [], rowCount: r.rowCount != null ? r.rowCount : (r.rows ? r.rows.length : 0) };
  };
  return { query: run, calls };
}

// --- pure helpers ----------------------------------------------------------
test('INTAKE_STATUSES lifecycle order', () => {
  assert.deepEqual(INTAKE_STATUSES, ['draft', 'submitting', 'completed', 'failed']);
});

test('intakeEnabled defaults on, off only when explicitly false', () => {
  delete process.env.INTAKE_ENABLED;
  assert.equal(intakeEnabled(), true);
  process.env.INTAKE_ENABLED = 'false';
  assert.equal(intakeEnabled(), false);
  process.env.INTAKE_ENABLED = 'true';
  assert.equal(intakeEnabled(), true);
  delete process.env.INTAKE_ENABLED;
});

test('splitPatch routes whitelisted columns and stashes unknowns in data', () => {
  const { columns, data } = splitPatch({
    first_name: 'Jane',
    phone: '2065551234',
    data: { referral_detail: 'neighbor Bob' },
    bogus_key: 'x',
  });
  assert.equal(columns.first_name, 'Jane');
  assert.equal(columns.phone, '2065551234');
  assert.equal(data.referral_detail, 'neighbor Bob');
  assert.equal(data.bogus_key, 'x');       // unknown key preserved in JSONB, not dropped
  assert.equal('bogus_key' in columns, false);
});

test('DRAFT_COLUMNS never includes protected fields', () => {
  for (const c of ['id', 'public_id', 'created_at', 'updated_at']) {
    assert.equal(DRAFT_COLUMNS.includes(c), false, `${c} must not be client-settable`);
  }
});

test('staffName prefers body, falls back to basic-auth user, else null', () => {
  assert.equal(staffName({}, '  Roman '), 'Roman');
  const auth = { headers: { authorization: 'Basic ' + Buffer.from('neil:pw').toString('base64') } };
  assert.equal(staffName(auth, ''), 'neil');
  assert.equal(staffName({}, ''), null);
});

// --- DB functions ----------------------------------------------------------
test('createDraft inserts created_by + hcp id and returns the row', async () => {
  const pool = makePool((sql) => {
    assert.match(sql, /INSERT INTO customer_intakes \(created_by, created_by_hcp_id\)/);
    return { rows: [{ id: 1, public_id: 'uuid-1', status: 'draft', created_by: 'neil' }] };
  });
  const row = await createDraft(pool, { createdBy: 'neil', createdById: 'pro_123' });
  assert.equal(row.created_by, 'neil');
  assert.deepEqual(pool.calls[0].params, ['neil', 'pro_123']);
});

test('createDraft defaults created_by + hcp id to null', async () => {
  const pool = makePool(() => ({ rows: [{ id: 2 }] }));
  await createDraft(pool);
  assert.deepEqual(pool.calls[0].params, [null, null]);
});

test('getIntake selects by id for numeric, by public_id otherwise', async () => {
  const pool = makePool(() => ({ rows: [{ id: 5 }] }));
  await getIntake(pool, 5);
  assert.match(pool.calls[0].sql, /WHERE id = \$1/);
  await getIntake(pool, 'a1b2c3');
  assert.match(pool.calls[1].sql, /WHERE public_id = \$1/);
});

test('updateDraft builds a whitelisted SET with JSONB merge and updated_at', async () => {
  let step = 0;
  const pool = makePool((sql) => {
    step += 1;
    if (step === 1) return { rows: [{ id: 9, public_id: 'uuid-9' }] };   // getIntake
    // update
    assert.match(sql, /first_name = \$1/);
    assert.match(sql, /data = data \|\| \$\d+::jsonb/);
    assert.match(sql, /updated_at = NOW\(\)/);
    assert.match(sql, /WHERE id = \$\d+/);
    return { rows: [{ id: 9, first_name: 'Jane' }] };
  });
  const row = await updateDraft(pool, 'uuid-9', { first_name: 'Jane', extra: 'note' });
  assert.equal(row.first_name, 'Jane');
});

test('updateDraft throws 404 when draft is missing', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await assert.rejects(() => updateDraft(pool, 'nope', { first_name: 'X' }), /not found/);
});

test('listIntakes clamps limit and filters by status when given', async () => {
  const pool = makePool(() => ({ rows: [] }));
  await listIntakes(pool, { limit: 9999 });
  assert.deepEqual(pool.calls[0].params, [200]);      // clamped to max 200
  await listIntakes(pool, { status: 'draft', limit: 5 });
  assert.match(pool.calls[1].sql, /WHERE status = \$1/);
  assert.deepEqual(pool.calls[1].params, ['draft', 5]);
});

// --- Sprint 2: lookup + dedupe --------------------------------------------
test('buildLookupAttempts orders phone > email > name and skips weak inputs', () => {
  const a = buildLookupAttempts({ phone: '(206) 458-1885', email: 'x@y.com', first_name: 'Jane', last_name: 'Doe' });
  assert.deepEqual(a.map((x) => x.by), ['phone', 'email', 'name']);
  assert.equal(a[0].term, '2064581885');            // normalised to digits
  assert.equal(a[2].term, 'Jane Doe');

  assert.deepEqual(buildLookupAttempts({ phone: '123' }).map((x) => x.by), []); // too short
  assert.deepEqual(buildLookupAttempts({ email: 'notanemail' }).map((x) => x.by), []);
  assert.deepEqual(buildLookupAttempts({ first_name: 'Al' }).map((x) => x.by), []); // <3 chars
});

test('lookupCustomer returns first key that yields matches (priority order)', async () => {
  const calls = [];
  const searchFn = async (term) => {
    calls.push(term);
    return term === 'x@y.com' ? [{ id: 'c1', name: 'Jane Doe' }] : [];
  };
  const res = await lookupCustomer({ phone: '2064581885', email: 'x@y.com', first_name: 'Jane', last_name: 'Doe' }, searchFn);
  assert.equal(res.matchedBy, 'email');
  assert.equal(res.customers[0].id, 'c1');
  assert.deepEqual(calls, ['2064581885', 'x@y.com']); // stopped after email hit; name not tried
});

test('lookupCustomer returns empty result when nothing matches', async () => {
  const res = await lookupCustomer({ phone: '2064581885' }, async () => []);
  assert.deepEqual(res, { matchedBy: null, term: null, customers: [] });
});

test('customerToDraftPatch links id, blocks dup, and maps fields', () => {
  const patch = customerToDraftPatch({
    id: 'cus_9', first_name: 'Jane', last_name: 'Doe', mobile: '2065551234',
    email: 'jane@x.com', company: 'Acme',
    addresses: [{
      line: '1 Fir St, Everett WA', street: '1 Fir St', unit: null,
      city: 'Everett', state: 'WA', zip: '98201',
    }],
  });
  assert.equal(patch.hcp_customer_id, 'cus_9');
  assert.equal(patch.customer_is_new, false);
  assert.equal(patch.phone, '2065551234');
  assert.equal(patch.address_street, '1 Fir St');
  assert.equal(patch.address_city, 'Everett');
  assert.equal(patch.address_state, 'WA');
  assert.equal(patch.address_zip, '98201');
});

// --- Sprint 3: validation --------------------------------------------------
test('normalizePhone handles country code and rejects short numbers', () => {
  assert.deepEqual(normalizePhone('(206) 458-1885'), { digits: '2064581885', valid: true, e164: '+12064581885' });
  assert.deepEqual(normalizePhone('1-206-458-1885').digits, '2064581885');
  assert.equal(normalizePhone('12345').valid, false);
});

test('isValidEmail accepts normal and rejects malformed', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('nope'), false);
  assert.equal(isValidEmail('a@b'), false);
});

test('validateCustomer flags each missing/invalid required field', () => {
  const { valid, errors } = validateCustomer({});
  assert.equal(valid, false);
  for (const k of ['first_name', 'last_name', 'phone', 'email', 'address_street', 'address_city', 'address_state', 'address_zip']) {
    assert.ok(errors[k], `expected error for ${k}`);
  }
  const ok = validateCustomer({
    first_name: 'Jane', last_name: 'Doe', phone: '2064581885', email: 'j@x.com',
    address_street: '1 Fir St', address_city: 'Everett', address_state: 'WA', address_zip: '98201',
  });
  assert.equal(ok.valid, true);
});

test('validateCustomer rejects a malformed ZIP', () => {
  const r = validateCustomer({
    first_name: 'Jane', last_name: 'Doe', phone: '2064581885', email: 'j@x.com',
    address_street: '1 Fir St', address_city: 'Everett', address_state: 'WA', address_zip: '982',
  });
  assert.match(r.errors.address_zip, /5-digit/);
});

test('validateCustomer rejects bad phone/email and bad optional secondary phone', () => {
  const r = validateCustomer({
    first_name: 'A', last_name: 'B',
    address_street: 'C', address_city: 'D', address_state: 'WA', address_zip: '98201',
    phone: '123', email: 'bad', secondary_phone: '55',
  });
  assert.match(r.errors.phone, /valid 10-digit/);
  assert.match(r.errors.email, /valid email/);
  assert.match(r.errors.secondary_phone, /valid 10-digit/);
});

test('customerStepStatus requires valid fields AND a create-vs-reuse decision', () => {
  const base = {
    first_name: 'Jane', last_name: 'Doe', phone: '2064581885', email: 'j@x.com',
    address_street: '1 Fir St', address_city: 'Everett', address_state: 'WA', address_zip: '98201',
  };
  // valid fields but no decision -> incomplete
  const noDecision = customerStepStatus(base);
  assert.equal(noDecision.valid, true);
  assert.equal(noDecision.complete, false);
  assert.match(noDecision.reasons.join(' '), /existing customer or mark/);
  // linked to existing -> complete
  assert.equal(customerStepStatus({ ...base, hcp_customer_id: 'cus_1' }).complete, true);
  // marked new -> complete
  assert.equal(customerStepStatus({ ...base, customer_is_new: true }).complete, true);
  // decision made but fields invalid -> incomplete
  assert.equal(customerStepStatus({ customer_is_new: true }).complete, false);
});

// --- Sprint 4: HCP create + tags -------------------------------------------
test('intakeWriteEnabled defaults OFF and only true when explicitly true', () => {
  delete process.env.INTAKE_WRITE_ENABLED;
  assert.equal(intakeWriteEnabled(), false);
  process.env.INTAKE_WRITE_ENABLED = 'true';
  assert.equal(intakeWriteEnabled(), true);
  process.env.INTAKE_WRITE_ENABLED = 'false';
  assert.equal(intakeWriteEnabled(), false);
  delete process.env.INTAKE_WRITE_ENABLED;
});

test('buildCustomerCreatePayload maps fields, normalises phones, sets tag + address', () => {
  const p = buildCustomerCreatePayload({
    first_name: 'Jane', last_name: 'Doe', email: 'j@x.com', phone: '(206) 458-1885',
    secondary_phone: '425-333-9444', company: 'Acme', customer_tag: 'Tree',
    address_street: '1 Fir St', address_unit: 'Apt 2', address_city: 'Everett',
    address_state: 'WA', address_zip: '98201',
  });
  assert.equal(p.mobile_number, '2064581885');
  assert.equal(p.home_number, '4253339444');
  assert.equal(p.notifications_enabled, false);
  assert.deepEqual(p.tags, ['Tree']);
  assert.deepEqual(p.addresses, [{
    street: '1 Fir St', street_line_2: 'Apt 2', city: 'Everett', state: 'WA', zip: '98201',
    country: 'US', type: 'service',
  }]);
});

test('buildCustomerCreatePayload omits tag/address/home when absent', () => {
  const p = buildCustomerCreatePayload({ first_name: 'A', last_name: 'B', email: 'a@b.com', phone: '2064581885' });
  assert.equal('tags' in p, false);
  assert.equal('addresses' in p, false);
  assert.equal('home_number' in p, false);
});

test('unionTags adds a new tag once and is idempotent', () => {
  assert.deepEqual(unionTags(['Tree'], 'Roofing'), ['Tree', 'Roofing']);
  assert.deepEqual(unionTags(['Tree'], 'Tree'), ['Tree']);
  assert.deepEqual(unionTags(null, 'Tree'), ['Tree']);
  assert.deepEqual(unionTags(['Tree'], null), ['Tree']);
});

// --- Discovery questions (Sprint 1 revised schema) -------------------------
test('isQuestionVisible returns true for unconditional questions', () => {
  const q = DISCOVERY_QUESTIONS.find((x) => x.id === 'project_description');
  assert.equal(isQuestionVisible(q, {}), true);
  // Synthetic conditional question exercises the showIf gate.
  const cond = { id: 'x', showIf: { key: 'buying_stage', equals: 'ready' } };
  assert.equal(isQuestionVisible(cond, { buying_stage: 'ready' }), true);
  assert.equal(isQuestionVisible(cond, { buying_stage: 'researching' }), false);
});

test('validateDiscovery requires all required questions', () => {
  const empty = validateDiscovery({});
  assert.equal(empty.valid, false);
  for (const k of ['project_description', 'buying_priority', 'buying_stage', 'getting_estimates', 'contact_time']) {
    assert.ok(empty.errors[k], `expected required error for ${k}`);
  }
  // Optional questions must never be errors.
  assert.equal('budget' in empty.errors, false);
  assert.equal('photos_provided' in empty.errors, false);
  assert.equal('additional_notes' in empty.errors, false);
});

test('validateDiscovery flags only the missing required answers', () => {
  const r = validateDiscovery({ project_description: 'x', buying_priority: 'quality' });
  assert.equal(r.valid, false);
  assert.ok(!r.errors.project_description);
  assert.ok(!r.errors.buying_priority);
  assert.ok(r.errors.buying_stage);
  assert.ok(r.errors.getting_estimates);
  assert.ok(r.errors.contact_time);
});

test('validateDiscovery passes a full valid set', () => {
  const good = validateDiscovery({
    project_description: 'Trim trees', buying_priority: 'quality', buying_stage: 'ready',
    getting_estimates: 'no', contact_time: 'anytime',
  });
  assert.equal(good.valid, true);

  const status = discoveryStepStatus({
    project_description: 'Trim trees', buying_priority: 'quality', buying_stage: 'ready',
    getting_estimates: 'no', contact_time: 'anytime',
  });
  assert.equal(status.complete, true);
  assert.deepEqual(status.reasons, []);
});

// --- Sprint 6: private notes + estimate ------------------------------------
test('intakeNoteMarker embeds the public id for idempotency', () => {
  assert.equal(intakeNoteMarker({ public_id: 'abc-123' }), '[intake:abc-123]');
});

test('buildIntakeNote renders all fields, marker, and a fixed date', () => {
  const now = new Date('2026-08-05T17:00:00.000Z');
  const note = buildIntakeNote({
    public_id: 'p1',
    project_description: 'Leaning fir, want it down this month',
    buying_priority: 'Quality', buying_stage: 'Ready to move forward',
    getting_estimates: 'Yes', budget: '$1,000 - $5,000',
    photos_provided: 'No', contact_time: 'Anytime',
    additional_notes: 'dog in yard', created_by: 'Roman Seipert',
  }, { now });
  assert.match(note, /Customer Intake \[intake:p1\]/);
  assert.match(note, /Project & Timeline: Leaning fir, want it down this month/);
  assert.match(note, /What Matters Most: Quality/);
  assert.match(note, /Best Contact Time: Anytime/);
  assert.match(note, /Created By: Roman Seipert/);
  assert.match(note, /Date: 2026-08-05T17:00:00.000Z/);
});

test('buildIntakeNote shows an em dash for missing values', () => {
  const note = buildIntakeNote({ public_id: 'p2' }, { now: new Date('2026-08-05T00:00:00.000Z') });
  assert.match(note, /Project & Timeline: —/);
});

// --- Estimate "Summary of Work" ---------------------------------------------
const SUMMARY_NOW = new Date('2026-08-05T17:00:00.000Z');

function fullIntakeRow(over = {}) {
  return {
    public_id: 'p1',
    first_name: 'Jane', last_name: 'Doe', company: 'Acme',
    phone: '2064581885', secondary_phone: '4253339444', email: 'jane@example.com',
    customer_tag: 'Landscaping',
    address_street: '1200 5th Avenue', address_unit: 'Apt 4B',
    address_city: 'Seattle', address_state: 'WA', address_zip: '98101',
    address_notes: 'Gate code 1234',
    project_description: 'Lawn is overgrown and needs regular service',
    buying_priority: 'Quality',
    buying_stage: 'Ready to move forward',
    getting_estimates: 'Yes',
    budget: '$500-1,000',
    photos_provided: 'Yes',
    contact_time: 'Evening (5pm - 8pm)',
    additional_notes: 'Dog in the backyard',
    created_by: 'Roman Seipert',
    ...over,
  };
}

test('buildEstimateSummary renders every answer as a Question/Answer pair', () => {
  const s = buildEstimateSummary(fullIntakeRow(), { now: SUMMARY_NOW });
  assert.match(s, /Question: What is the project and ideal timeline\?\nAnswer: Lawn is overgrown and needs regular service/);
  assert.match(s, /Question: What matters most when choosing a contractor\?\nAnswer: Quality/);
  assert.match(s, /Question: What budget range do they have in mind\?\nAnswer: \$500-1,000/);
  assert.match(s, /Question: Anything else we should know\?\nAnswer: Dog in the backyard/);
});

test('buildEstimateSummary groups content under readable headings', () => {
  const s = buildEstimateSummary(fullIntakeRow(), { now: SUMMARY_NOW });
  for (const h of ['CUSTOMER INTAKE SUMMARY', 'CUSTOMER', 'SERVICE ADDRESS', 'CUSTOMER REQUEST',
    'DECISION & BUDGET', 'SCHEDULING & FOLLOW-UP', 'ADDITIONAL NOTES']) {
    assert.ok(s.includes(h), `expected heading ${h}`);
  }
  assert.match(s, /Taken August 5, 2026 at 10:00 AM by Roman Seipert/);
});

test('buildEstimateSummary formats phone and address for humans', () => {
  const s = buildEstimateSummary(fullIntakeRow(), { now: SUMMARY_NOW });
  assert.match(s, /Answer: \(206\) 458-1885/);
  assert.match(s, /Answer: 1200 5th Avenue Apt 4B\nSeattle, WA 98101/);
});

test('buildEstimateSummary never leaks keys, ids or JSON', () => {
  const s = buildEstimateSummary(fullIntakeRow({ id: 7, hcp_customer_id: 'cus_abc' }), { now: SUMMARY_NOW });
  for (const leak of ['public_id', 'hcp_customer_id', 'cus_abc', 'address_street', 'customer_tag', '{', '}']) {
    assert.ok(!s.includes(leak), `summary leaked ${leak}`);
  }
});

test('buildEstimateSummary omits blank optional discovery answers', () => {
  const s = buildEstimateSummary(fullIntakeRow({
    photos_provided: null, budget: null,
  }), { now: SUMMARY_NOW });
  assert.ok(!s.includes('Will they be sending photos of the project?'));
  assert.ok(!s.includes('What budget range do they have in mind?'));
  assert.match(s, /Question: What is the project and ideal timeline\?/);
});

test('buildEstimateSummary marks unanswered required questions but drops blank optional ones', () => {
  const s = buildEstimateSummary(fullIntakeRow({
    project_description: '', additional_notes: '', company: '', address_notes: '',
  }), { now: SUMMARY_NOW });
  assert.match(s, /Question: What is the project and ideal timeline\?\nAnswer: Not provided/);
  assert.ok(!s.includes('Anything else we should know?'));
  assert.ok(!s.includes('What company do they represent?'));
  assert.ok(!s.includes('ADDITIONAL NOTES'), 'empty section should be dropped entirely');
});

test('buildEstimateSummary is stable for the same input', () => {
  const row = fullIntakeRow();
  assert.equal(buildEstimateSummary(row, { now: SUMMARY_NOW }), buildEstimateSummary(row, { now: SUMMARY_NOW }));
});

// --- Sprint 7: SMS notification --------------------------------------------
test('notifyRecipients defaults to Neil and normalises to E.164', () => {
  delete process.env.INTAKE_NOTIFY_NUMBERS;
  assert.deepEqual(notifyRecipients(), ['+12064581885']);
  process.env.INTAKE_NOTIFY_NUMBERS = '206-458-1885, 4253339444';
  assert.deepEqual(notifyRecipients(), ['+12064581885', '+14253339444']);
  delete process.env.INTAKE_NOTIFY_NUMBERS;
});

test('buildNotificationSms formats the office alert with key details and estimate link', () => {
  const sms = buildNotificationSms({
    first_name: 'Jane', last_name: 'Doe', customer_tag: 'Tree',
    address_city: 'Seattle', address_state: 'WA',
    project_description: 'leaning fir\nsecond line', budget: '$1,000 - $5,000',
    hcp_estimate_url: 'https://pro.housecallpro.com/app/estimates/best_1',
  });
  assert.match(sms, /Jane Doe/);
  assert.match(sms, /Tree/);
  assert.match(sms, /Seattle, WA/);
  assert.match(sms, /Project: leaning fir/);
  assert.ok(!sms.includes('second line'), 'only the first line of the project is included');
  assert.match(sms, /Budget: \$1,000 - \$5,000/);
  assert.match(sms, /pro\.housecallpro\.com\/app\/estimates\/best_1/);
});

// --- Sprint 8: submit orchestration (idempotent service steps) --------------
test('ensureEstimate is a no-op when an estimate already exists (no writes)', async () => {
  const pool = makePool(() => { throw new Error('pool should not be queried'); });
  const res = await ensureEstimate(pool, { id: 1, hcp_estimate_id: 'est_9' });
  assert.deepEqual(res, { estimate_id: 'est_9', estimate_option_id: null, estimate_number: null, created: false });
  assert.equal(pool.calls.length, 0);
});

test('ensureEstimate replays the stored option id and number without writing', async () => {
  const pool = makePool(() => { throw new Error('pool should not be queried'); });
  const res = await ensureEstimate(pool, {
    id: 1, hcp_estimate_id: 'est_9', hcp_estimate_option_id: 'best_7', hcp_estimate_number: '1042',
  });
  assert.deepEqual(res, {
    estimate_id: 'est_9', estimate_option_id: 'best_7', estimate_number: '1042', created: false,
  });
  assert.equal(pool.calls.length, 0);
});

test('ensureCustomer link-existing without a tag only stamps the draft', async () => {
  const pool = makePool(() => ({ rows: [{ id: 1, hcp_customer_id: 'cus_1' }] }));
  const res = await ensureCustomer(pool, { id: 1, hcp_customer_id: 'cus_1' }, { tag: null });
  assert.equal(res.action, 'link-existing');
  assert.equal(res.hcp_customer_id, 'cus_1');
  assert.equal(res.tags, null);
  // updateDraft internally does a SELECT then an UPDATE; no HCP tag write happened.
  assert.ok(pool.calls.some((c) => /UPDATE customer_intakes/.test(c.sql)));
  assert.equal(pool.calls.some((c) => /INSERT/.test(c.sql)), false);
});

// --- Sprint 9: recovery -----------------------------------------------------
test('recoverInterruptedIntakes marks submitting rows failed (resumable)', async () => {
  const pool = makePool((sql) => {
    assert.match(sql, /UPDATE customer_intakes/);
    assert.match(sql, /WHERE status = 'submitting'/);
    return { rowCount: 2, rows: [] };
  });
  const res = await recoverInterruptedIntakes(pool);
  assert.deepEqual(res, { recovered: 2 });
});
