// Drip helpers — unit tests (pure, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCategoryKey, resolveMessage, renderBody,
  computeNextDueAt, buildIdemKey, parseHHMM, quietHoursDelayMinutes, applyQuietHours, evaluateStop, nestSequences,
  smsSegments, validateMessage, validateCategoryMap, validateVariant, validateSequenceSettings, validateSequenceCreate,
  validateTemplateBody,
  validateTemplateCreate,
  autoreplySource,
  pickAutoreplyTemplate,
} from '../src/drip.js';
const MAP = [
  { category_key: 'stump_grinding', source: 'thumbtack', raw_value: 'Tree Stump Grinding and Removal' },
  { category_key: 'grading', source: 'thumbtack', raw_value: 'Land Leveling and Grading' },
  { category_key: 'grading', source: 'google_lsa', raw_value: 'grading_resloping' },
  { category_key: 'land_clearing', source: 'google_lsa', raw_value: 'yard_cleanup' },
];

test('resolveCategoryKey maps Thumbtack names and Google slugs (case-insensitive)', () => {
  assert.equal(resolveCategoryKey(MAP, 'thumbtack', 'Tree Stump Grinding and Removal'), 'stump_grinding');
  assert.equal(resolveCategoryKey(MAP, 'google_lsa', 'grading_resloping'), 'grading');
  assert.equal(resolveCategoryKey(MAP, 'google_lsa', 'YARD_CLEANUP'), 'land_clearing');
});

test('resolveCategoryKey returns null for unknown / missing', () => {
  assert.equal(resolveCategoryKey(MAP, 'thumbtack', 'Nonexistent Service'), null);
  assert.equal(resolveCategoryKey(MAP, 'google_lsa', ''), null);
  assert.equal(resolveCategoryKey(MAP, 'thumbtack', 'grading_resloping'), null); // wrong source
});

const CANDIDATES = [
  { category_key: null, variant: 'A', body: 'default A', weight: 1, is_active: true },
  { category_key: null, variant: 'B', body: 'default B', weight: 1, is_active: true },
  { category_key: 'stump_grinding', variant: 'A', body: 'stump copy', weight: 1, is_active: true },
];

test('resolveMessage prefers category-specific over default', () => {
  const m = resolveMessage(CANDIDATES, { categoryKey: 'stump_grinding' });
  assert.equal(m.body, 'stump copy');
});

test('resolveMessage falls back to vertical default when no category match', () => {
  const m = resolveMessage(CANDIDATES, { categoryKey: 'artificial_turf' });
  assert.equal(m.category_key, null);
  assert.ok(m.body.startsWith('default'));
});

test('resolveMessage returns null when nothing usable', () => {
  assert.equal(resolveMessage([], { categoryKey: 'x' }), null);
  assert.equal(resolveMessage([{ category_key: null, body: 'x', is_active: false }], {}), null);
});

test('resolveMessage round_robin is deterministic by index', () => {
  const a = resolveMessage(CANDIDATES, { strategy: 'round_robin', index: 0 });
  const b = resolveMessage(CANDIDATES, { strategy: 'round_robin', index: 1 });
  const a2 = resolveMessage(CANDIDATES, { strategy: 'round_robin', index: 2 });
  assert.equal(a.variant, 'A');
  assert.equal(b.variant, 'B');
  assert.equal(a2.variant, 'A'); // wraps
});

test('resolveMessage weighted pick honors the rng and only-active pool', () => {
  const rows = [
    { category_key: null, variant: 'A', body: 'A', weight: 1, is_active: true },
    { category_key: null, variant: 'B', body: 'B', weight: 3, is_active: true },
  ];
  assert.equal(resolveMessage(rows, { strategy: 'weighted_ab', rng: () => 0.0 }).variant, 'A');
  assert.equal(resolveMessage(rows, { strategy: 'weighted_ab', rng: () => 0.99 }).variant, 'B');
});

test('renderBody substitutes known placeholders and leaves unknown intact', () => {
  assert.equal(
    renderBody('Hi {name}, about {service}. {unknown}', { name: 'Sam', service: 'lawn care' }),
    'Hi Sam, about lawn care. {unknown}',
  );
});

test('computeNextDueAt adds offset minutes to T0', () => {
  const t0 = new Date('2026-08-14T10:00:00Z');
  assert.equal(computeNextDueAt(t0, 30).toISOString(), '2026-08-14T10:30:00.000Z');
  assert.equal(computeNextDueAt(t0, 1440).toISOString(), '2026-08-15T10:00:00.000Z');
});

test('buildIdemKey composes lead_ref:step', () => {
  assert.equal(buildIdemKey('conv-9', 3), 'conv-9:3');
});

test('parseHHMM parses to minutes', () => {
  assert.equal(parseHHMM('08:00'), 480);
  assert.equal(parseHHMM('20:30'), 1230);
});

test('quietHoursDelayMinutes: inside window = 0', () => {
  assert.equal(quietHoursDelayMinutes(600, 480, 1200), 0); // 10:00 within 08:00-20:00
});

test('quietHoursDelayMinutes: before window defers to start (same day)', () => {
  assert.equal(quietHoursDelayMinutes(400, 480, 1200), 80); // 06:40 -> 08:00
});

test('quietHoursDelayMinutes: after window defers to next-day start', () => {
  assert.equal(quietHoursDelayMinutes(1300, 480, 1200), (1440 - 1300) + 480); // 21:40 -> next 08:00
});

test('applyQuietHours returns same instant when inside window', () => {
  // Noon Pacific is inside 08:00-20:00.
  const d = new Date('2026-08-14T19:00:00Z'); // 12:00 PDT
  assert.equal(applyQuietHours(d, { tz: 'America/Los_Angeles' }).getTime(), d.getTime());
});

test('applyQuietHours defers a late-night instant to the next morning', () => {
  const d = new Date('2026-08-14T08:00:00Z'); // 01:00 PDT (before 08:00) -> should defer
  const out = applyQuietHours(d, { tz: 'America/Los_Angeles' });
  assert.ok(out.getTime() > d.getTime());
});

test('evaluateStop: resolved conversation stops', () => {
  assert.equal(evaluateStop({ status: 'resolved', labels: ['A_pending_callback'], messages: [] }), 'resolved');
});

test('evaluateStop: missing pending label stops', () => {
  assert.equal(evaluateStop({ status: 'open', labels: [], messages: [] }), 'label_removed');
});

test('evaluateStop: incoming (customer) message stops', () => {
  const conv = { status: 'open', labels: ['A_pending_callback'], messages: [{ message_type: 0 }] };
  assert.equal(evaluateStop(conv), 'human_response');
});

test('evaluateStop: our own tagged drip send does NOT stop', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [{ message_type: 1, private: false, content_attributes: { automation: 'drip' } }],
  };
  assert.equal(evaluateStop(conv), null);
});

test('evaluateStop: an untagged agent outgoing message stops', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [{ message_type: 1, private: false, content_attributes: {} }],
  };
  assert.equal(evaluateStop(conv), 'human_response');
});

test('evaluateStop: private note is ignored (continues)', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [{ message_type: 1, private: true }],
  };
  assert.equal(evaluateStop(conv), null);
});

const T0 = '2026-08-14T18:00:00Z';
const T0_SEC = Math.floor(new Date(T0).getTime() / 1000);

test('evaluateStop: pre-enrollment lead + welcome are ignored with since (continues)', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [
      { message_type: 0, created_at: T0_SEC - 120 },                      // inbound lead
      { message_type: 1, private: false, content_attributes: {}, created_at: T0_SEC - 60 }, // welcome (untagged)
    ],
  };
  assert.equal(evaluateStop(conv, { since: T0 }), null);
});

test('evaluateStop: a customer reply after since stops', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [
      { message_type: 0, created_at: T0_SEC - 120 },   // pre-enrollment lead, ignored
      { message_type: 0, created_at: T0_SEC + 300 },   // real reply after T0
    ],
  };
  assert.equal(evaluateStop(conv, { since: T0 }), 'human_response');
});

test('evaluateStop: an agent (untagged) reply after since stops; our tagged drip send does not', () => {
  const conv = {
    status: 'open', labels: ['A_pending_callback'],
    messages: [
      { message_type: 1, private: false, content_attributes: { automation: 'drip' }, created_at: T0_SEC + 60 },
      { message_type: 1, private: false, content_attributes: {}, created_at: T0_SEC + 120 },
    ],
  };
  assert.equal(evaluateStop(conv, { since: T0 }), 'human_response');
  const convDripOnly = { ...conv, messages: [conv.messages[0]] };
  assert.equal(evaluateStop(convDripOnly, { since: T0 }), null);
});

test('nestSequences nests steps + messages, sorts, and keeps category overrides', () => {
  const seqRows = [{ id: 5, key: 'lsa_landscaping', name: 'LSA (Landscaping)' }];
  const stepRows = [
    { id: 20, sequence_id: 5, step_index: 1, offset_minutes: 30, label: null, is_active: true },
    { id: 10, sequence_id: 5, step_index: 0, offset_minutes: 0, label: 'welcome', is_active: true },
  ];
  const msgRows = [
    { id: 1, step_id: 10, category_key: null, variant: 'A', body: 'welcome', include_optout: true, weight: 1, is_active: true },
    { id: 2, step_id: 20, category_key: 'stump_grinding', variant: 'A', body: 'stump', include_optout: false, weight: 1, is_active: true },
    { id: 3, step_id: 20, category_key: null, variant: 'A', body: 'default', include_optout: false, weight: 1, is_active: true },
  ];
  const out = nestSequences(seqRows, stepRows, msgRows);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].steps.map((s) => s.step_index), [0, 1]); // sorted by step_index
  const step1 = out[0].steps.find((s) => s.step_index === 1);
  assert.equal(step1.messages.length, 2);
  assert.equal(step1.messages[0].category_key, null);          // default sorts before category
  assert.equal(step1.messages[1].category_key, 'stump_grinding');
});

test('smsSegments: GSM-7 single vs multi segment', () => {
  assert.deepEqual(smsSegments(''), { encoding: 'GSM-7', units: 0, segments: 0, perSegment: 160, remaining: 160 });
  const short = smsSegments('Hi there, quick follow-up.');
  assert.equal(short.encoding, 'GSM-7');
  assert.equal(short.segments, 1);
  const long = smsSegments('a'.repeat(200));
  assert.equal(long.segments, 2);
  assert.equal(long.perSegment, 153);
});

test('smsSegments: non-GSM char forces UCS-2', () => {
  const r = smsSegments('Hi 🌳 tree'); // emoji is not GSM-7
  assert.equal(r.encoding, 'UCS-2');
  assert.equal(r.segments, 1);
});

test('validateMessage: empty is an error', () => {
  const issues = validateMessage('   ', { includeOptout: false });
  assert.equal(issues[0].code, 'empty');
  assert.equal(issues[0].level, 'error');
});

test('validateMessage: opt-out flag without STOP is an error', () => {
  const issues = validateMessage('Hi {name}, want a call?', { includeOptout: true });
  assert.ok(issues.some((i) => i.code === 'optout_missing' && i.level === 'error'));
});

test('validateMessage: STOP without flag warns; unknown placeholder warns', () => {
  const issues = validateMessage('Hi {name}, reply STOP to opt out. {foo}', { includeOptout: false });
  assert.ok(issues.some((i) => i.code === 'optout_mismatch' && i.level === 'warn'));
  assert.ok(issues.some((i) => i.code === 'placeholder' && i.level === 'warn'));
});

test('validateMessage: clean opt-out message has no errors', () => {
  const issues = validateMessage('Hi {name}, reply STOP to opt out.', { includeOptout: true });
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
});

test('validateCategoryMap: normalizes and accepts a valid row', () => {
  const v = validateCategoryMap({ categoryKey: '  Stump_Grinding ', source: 'Thumbtack', rawValue: '  Tree Stump Grinding ' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { categoryKey: 'stump_grinding', source: 'thumbtack', rawValue: 'Tree Stump Grinding' });
});

test('validateCategoryMap: rejects bad key, source, and empties', () => {
  assert.equal(validateCategoryMap({ categoryKey: 'Bad Key!', source: 'thumbtack', rawValue: 'x' }).ok, false);
  assert.equal(validateCategoryMap({ categoryKey: 'ok', source: 'facebook', rawValue: 'x' }).ok, false);
  assert.equal(validateCategoryMap({ categoryKey: 'ok', source: 'thumbtack', rawValue: '' }).ok, false);
  assert.equal(validateCategoryMap({ categoryKey: '', source: 'thumbtack', rawValue: 'x' }).ok, false);
});

test('validateVariant: accepts short tokens, rejects bad', () => {
  assert.equal(validateVariant('B').ok, true);
  assert.equal(validateVariant('promo_1').ok, true);
  assert.equal(validateVariant('').ok, false);
  assert.equal(validateVariant('has space').ok, false);
  assert.equal(validateVariant('x'.repeat(21)).ok, false);
});

test('validateSequenceSettings: validates and normalizes provided fields', () => {
  const ok = validateSequenceSettings({ maxMessages: 6, quietStart: '09:00', quietEnd: '19:30', variantStrategy: 'weighted_ab' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { maxMessages: 6, quietStart: '09:00', quietEnd: '19:30', variantStrategy: 'weighted_ab' });
});

test('validateSequenceSettings: rejects bad ranges/format/order and empty patch', () => {
  assert.equal(validateSequenceSettings({ maxMessages: 0 }).ok, false);
  assert.equal(validateSequenceSettings({ maxMessages: 25 }).ok, false);
  assert.equal(validateSequenceSettings({ expiresAfterHours: 0 }).ok, false);
  assert.equal(validateSequenceSettings({ quietStart: '9:00' }).ok, false);
  assert.equal(validateSequenceSettings({ quietStart: '20:00', quietEnd: '08:00' }).ok, false);
  assert.equal(validateSequenceSettings({ variantStrategy: 'nope' }).ok, false);
  assert.equal(validateSequenceSettings({}).ok, false);
});

test('validateSequenceCreate: normalizes and accepts; rejects bad key/name/source', () => {
  const ok = validateSequenceCreate({ key: '  Thumbtack_Landscaping ', name: '  Thumbtack (Landscaping) ', source: 'Thumbtack', vertical: 'Landscaping' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { key: 'thumbtack_landscaping', name: 'Thumbtack (Landscaping)', source: 'thumbtack', vertical: 'landscaping' });
  assert.equal(validateSequenceCreate({ key: 'bad key', name: 'x', source: 'thumbtack' }).ok, false);
  assert.equal(validateSequenceCreate({ key: 'ok', name: '', source: 'thumbtack' }).ok, false);
  assert.equal(validateSequenceCreate({ key: 'ok', name: 'x', source: 'facebook' }).ok, false);
});

test('validateTemplateBody: rejects empty, accepts content (incl emoji)', () => {
  assert.equal(validateTemplateBody('   ').ok, false);
  const ok = validateTemplateBody('Hi! 🌳 pricing…');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'Hi! 🌳 pricing…');
});

test('autoreplySource: maps group prefix to lead source', () => {
  assert.equal(autoreplySource('autoreply_tt_tree'), 'thumbtack');
  assert.equal(autoreplySource('autoreply_tt_landscaping'), 'thumbtack');
  assert.equal(autoreplySource('autoreply_lsa_landscaping'), 'google_lsa');
  assert.equal(autoreplySource('something_else'), null);
});

test('validateTemplateCreate: normalizes keys and requires body', () => {
  const ok = validateTemplateCreate({ group: 'Autoreply_TT_Tree', sub: 'Tree_Removal', label: ' Tree removal ', body: 'Hi 🌳', categoryKey: ' tree_removal ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { groupKey: 'autoreply_tt_tree', subKey: 'tree_removal', label: 'Tree removal', body: 'Hi 🌳', categoryKey: 'tree_removal', isActive: true });
  assert.equal(validateTemplateCreate({ group: 'g', sub: 's', body: 'x', isActive: false }).value.isActive, false); // draft
  assert.equal(validateTemplateCreate({ group: 'g', sub: 's', body: '  ' }).ok, false); // empty body
  assert.equal(validateTemplateCreate({ group: 'bad group', sub: 's', body: 'x' }).ok, false); // space in group
  assert.equal(validateTemplateCreate({ group: 'g', sub: '', body: 'x' }).ok, false); // empty sub
  assert.equal(validateTemplateCreate({ group: 'g', sub: 's', body: 'x' }).value.categoryKey, null); // no category
});

test('pickAutoreplyTemplate: category match wins, else generic fallback', () => {
  const rows = [
    { sub_key: 'stump', category_key: 'stump_grinding', body: 'PRICED' },
    { sub_key: 'generic', category_key: null, body: 'GENERIC' },
    { sub_key: 'neutral', category_key: null, body: 'NEUTRAL' },
  ];
  assert.deepEqual(pickAutoreplyTemplate(rows, 'stump_grinding'), { row: rows[0], matched: true });
  // resolved-but-no-template category -> generic
  assert.deepEqual(pickAutoreplyTemplate(rows, 'tree_trimming'), { row: rows[1], matched: false });
  // no category -> generic
  assert.deepEqual(pickAutoreplyTemplate(rows, null), { row: rows[1], matched: false });
  // missing generic -> null row
  assert.deepEqual(pickAutoreplyTemplate([{ sub_key: 'neutral', category_key: null }], 'x'), { row: null, matched: false });
});
