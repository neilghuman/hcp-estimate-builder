// Drip helpers — unit tests (pure, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCategoryKey, resolveMessage, renderBody } from '../src/drip.js';

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
