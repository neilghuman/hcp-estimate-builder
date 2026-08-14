// Drip helpers — unit tests (pure, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCategoryKey, resolveMessage, renderBody,
  computeNextDueAt, buildIdemKey, parseHHMM, quietHoursDelayMinutes, applyQuietHours, evaluateStop,
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
