// Chat Foundry — Sprint 1 unit tests (node:test, zero-dep).
// Covers the inbox-ID allowlist capability logic (the outbound safety gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedInboxIds, inboxCapability, sendEnabled, maxCampaignSize, buildAudience, maskPhone } from '../src/chatfoundry.js';

test('allowedInboxIds parses a comma-separated ID list', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '2, 4 ,5,6';
  assert.deepEqual(allowedInboxIds(), [2, 4, 5, 6]);
});

test('allowedInboxIds is empty when unset', () => {
  delete process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS;
  assert.deepEqual(allowedInboxIds(), []);
});

test('inboxCapability hard-skips when no allowlist is set', () => {
  delete process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS;
  const cap = inboxCapability({ id: 4, name: 'Thumbtack - Landscaping' });
  assert.equal(cap.outbound_allowed, false);
  assert.equal(cap.eligibility, 'inbox not allowlisted');
  assert.match(cap.skip_reason, /allowlisted/i);
});

test('inboxCapability allows an inbox in the allowlist', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4,5,6';
  const cap = inboxCapability({ id: 5, name: 'Thumbtack - Roofing' });
  assert.equal(cap.outbound_allowed, true);
  assert.equal(cap.eligibility, 'eligible');
  assert.equal(cap.skip_reason, null);
});

test('inboxCapability hard-skips an inbox not in the allowlist (by ID, not name)', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4,5,6';
  const cap = inboxCapability({ id: 3, name: 'Thumbtack Staging (Landscaping)' });
  assert.equal(cap.outbound_allowed, false);
  assert.equal(cap.eligibility, 'inbox not allowlisted');
});

test('sendEnabled defaults to false and only true on explicit "true"', () => {
  delete process.env.CHAT_FOUNDRY_SEND_ENABLED;
  assert.equal(sendEnabled(), false);
  process.env.CHAT_FOUNDRY_SEND_ENABLED = 'TRUE';
  assert.equal(sendEnabled(), true);
  process.env.CHAT_FOUNDRY_SEND_ENABLED = 'yes';
  assert.equal(sendEnabled(), false);
});

test('maxCampaignSize reads env with a safe default', () => {
  delete process.env.CHAT_FOUNDRY_MAX_CAMPAIGN_SIZE;
  assert.equal(maxCampaignSize(), 500);
  process.env.CHAT_FOUNDRY_MAX_CAMPAIGN_SIZE = '250';
  assert.equal(maxCampaignSize(), 250);
});

// ---- Sprint 2: audience preview logic ----
function conv(over = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(over, k);
  return {
    conversation_id: over.id || 1,
    inbox_id: over.inbox_id ?? 4,
    status: 'open',
    contact_name: over.name || 'Jane Doe',
    contact_identifier: has('identifier') ? over.identifier : 'thumbtack:123',
    phone: has('phone') ? over.phone : '+14255551234',
    email: null,
    labels: over.labels || ['hot-lead'],
    assignee: null,
    last_activity_at: over.last || '2026-07-28T00:00:00Z',
  };
}

test('maskPhone keeps only the last 4 digits', () => {
  assert.equal(maskPhone('+14255551234'), '••• ••• 1234');
  assert.equal(maskPhone(''), '');
});

test('buildAudience requires ALL selected tags (AND)', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4';
  const rows = [
    conv({ id: 1, labels: ['hot-lead', 'landscaping'] }),
    conv({ id: 2, labels: ['hot-lead'] }),
  ];
  const { summary } = buildAudience(rows, { tags: ['hot-lead', 'landscaping'] });
  assert.equal(summary.matched, 1); // only conv 1 has both tags
});

test('buildAudience marks non-allowlisted inboxes as skipped', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4';
  const { summary } = buildAudience([conv({ id: 1, inbox_id: 99 })], { tags: ['hot-lead'] });
  assert.equal(summary.eligible, 0);
  assert.equal(summary.byReason['inbox not allowlisted'], 1);
});

test('buildAudience skips contacts with no channel when excludeNoChannel is on', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4';
  const { summary } = buildAudience([conv({ id: 1, phone: null, identifier: null })], { tags: ['hot-lead'], excludeNoChannel: true });
  assert.equal(summary.eligible, 0);
  assert.equal(summary.byReason['no valid contact channel'], 1);
});

test('buildAudience enforces maxRecipients (freshest kept)', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4';
  const rows = [
    conv({ id: 1, last: '2026-07-20T00:00:00Z' }),
    conv({ id: 2, last: '2026-07-28T00:00:00Z' }),
    conv({ id: 3, last: '2026-07-25T00:00:00Z' }),
  ];
  const { rows: out, summary } = buildAudience(rows, { tags: ['hot-lead'], maxRecipients: 2 });
  assert.equal(summary.eligible, 2);
  assert.equal(summary.byReason['exceeds max recipients'], 1);
  // the two eligible are the freshest (ids 2 then 3); the oldest (id 1) is over the cap
  const overCap = out.find((r) => !r.eligible);
  assert.equal(overCap.conversation_id, 1);
});

// ---- Sprint 3: template validation helpers (pure) ----
import { validateTemplateInput, sanitizeTags, TEMPLATE_CATEGORIES } from '../src/cf_templates.js';

test('sanitizeTags trims, lowercases, de-dupes (array or CSV)', () => {
  assert.deepEqual(sanitizeTags(['Hot', ' hot ', 'Lead', '']), ['hot', 'lead']);
  assert.deepEqual(sanitizeTags('Hot, Lead ,hot'), ['hot', 'lead']);
});

test('validateTemplateInput requires name and body', () => {
  const a = validateTemplateInput({ name: '', body: 'hi' });
  assert.equal(a.ok, false);
  assert.match(a.errors.join(' '), /name/i);
  const b = validateTemplateInput({ name: 'X', body: '   ' });
  assert.equal(b.ok, false);
  assert.match(b.errors.join(' '), /body/i);
});

test('validateTemplateInput normalizes category and tags', () => {
  const r = validateTemplateInput({ name: 'Follow up', body: 'Hello', category: 'Nonsense', tags: 'A, a, B' });
  assert.equal(r.ok, true);
  assert.equal(r.value.category, 'Custom'); // unknown category falls back to Custom
  assert.deepEqual(r.value.tags, ['a', 'b']);
  assert.ok(TEMPLATE_CATEGORIES.includes('Review request'));
});

// ---- Sprint 4: compose placeholder engine (pure) ----
import { extractPlaceholders, analyzeTemplate, buildRecipientContext, resolvePlaceholders, renderForRecipient, composePreview } from '../src/cf_compose.js';

const sampleConv = { conversation_id: 9, contact_name: 'Sam Rivera', phone: '+1 (555) 867-5309', email: 'sam@example.com', assignee: 'Jordan Lee' };

test('extractPlaceholders returns unique tokens in order', () => {
  assert.deepEqual(extractPlaceholders('Hi {{first_name}}, {{first_name}} — from {{agent}}'), ['first_name', 'agent']);
});

test('analyzeTemplate flags unsupported fields', () => {
  const a = analyzeTemplate('Hi {{first_name}}, your {{unicorn}} is ready');
  assert.deepEqual(a.known, ['first_name']);
  assert.deepEqual(a.unknown, ['unicorn']);
  assert.equal(a.hasUnknown, true);
});

test('buildRecipientContext derives first_name, phone_last4, agent', () => {
  const ctx = buildRecipientContext(sampleConv);
  assert.equal(ctx.first_name, 'Sam');
  assert.equal(ctx.full_name, 'Sam Rivera');
  assert.equal(ctx.phone_last4, '5309');
  assert.equal(ctx.email, 'sam@example.com');
  assert.equal(ctx.agent, 'Jordan');
});

test('resolvePlaceholders substitutes known, keeps unresolved + unknown', () => {
  const ctx = buildRecipientContext({ contact_name: 'Sam Rivera' }); // no phone/agent
  const r = resolvePlaceholders('Hi {{first_name}}, call {{phone_last4}} — {{unicorn}}', ctx);
  assert.equal(r.text, 'Hi Sam, call {{phone_last4}} — {{unicorn}}');
  assert.deepEqual(r.resolved, { first_name: 'Sam' });
  assert.deepEqual(r.unresolved, ['phone_last4']);
  assert.deepEqual(r.unknown, ['unicorn']);
});

test('renderForRecipient blocks when a value is missing', () => {
  const ok = renderForRecipient('Hi {{first_name}}', sampleConv);
  assert.equal(ok.blocked, false);
  assert.equal(ok.text, 'Hi Sam');
  const missing = renderForRecipient('Hi {{first_name}}, agent {{agent}}', { contact_name: 'Sam' });
  assert.equal(missing.blocked, true);
  assert.match(missing.block_reason, /agent/);
});

test('renderForRecipient blocks on unsupported field for everyone', () => {
  const r = renderForRecipient('Your {{unicorn}} is ready', sampleConv);
  assert.equal(r.blocked, true);
  assert.match(r.block_reason, /Unsupported/i);
});

test('composePreview summarizes renderable vs blocked', () => {
  const recips = [sampleConv, { conversation_id: 2, contact_name: 'Pat' }]; // Pat has no phone
  const out = composePreview('Hi {{first_name}}, ref {{phone_last4}}', recips);
  assert.equal(out.summary.total, 2);
  assert.equal(out.summary.renderable, 1);
  assert.equal(out.summary.blocked, 1);
});

// ---- Sprint 4: rewrite helpers (pure) ----
import { normalizeTone, placeholderTokens } from '../src/cf_rewrite.js';

test('normalizeTone falls back to professional for unknown tones', () => {
  assert.equal(normalizeTone('friendly'), 'friendly');
  assert.equal(normalizeTone('SHOUTY'), 'professional');
  assert.equal(normalizeTone(''), 'professional');
});

test('placeholderTokens lists tokens for drift detection', () => {
  assert.deepEqual(placeholderTokens('Hi {{first_name}} — {{agent}}'), ['first_name', 'agent']);
});

// ---- Sprint 5: campaign send gates (pure) ----
import { confirmationPhrase, sendPreflight, recheckRecipient } from '../src/cf_campaigns.js';

test('confirmationPhrase pluralizes correctly', () => {
  assert.equal(confirmationPhrase(1), 'SEND 1 MESSAGE');
  assert.equal(confirmationPhrase(42), 'SEND 42 MESSAGES');
  assert.equal(confirmationPhrase(0), 'SEND 0 MESSAGES');
});

test('sendPreflight passes only when every gate is satisfied', () => {
  const ok = sendPreflight({ typedPhrase: 'SEND 1 MESSAGE', expectedPhrase: 'SEND 1 MESSAGE', confirmChecked: true, eligibleCount: 1, maxSize: 500, enabled: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test('sendPreflight blocks when sending is disabled', () => {
  const r = sendPreflight({ typedPhrase: 'SEND 1 MESSAGE', expectedPhrase: 'SEND 1 MESSAGE', confirmChecked: true, eligibleCount: 1, maxSize: 500, enabled: false });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /disabled/i);
});

test('sendPreflight blocks on wrong phrase or unchecked box', () => {
  const wrong = sendPreflight({ typedPhrase: 'send 1 message', expectedPhrase: 'SEND 1 MESSAGE', confirmChecked: true, eligibleCount: 1, maxSize: 500, enabled: true });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join(' '), /exact confirmation phrase/i);
  const nobox = sendPreflight({ typedPhrase: 'SEND 1 MESSAGE', expectedPhrase: 'SEND 1 MESSAGE', confirmChecked: false, eligibleCount: 1, maxSize: 500, enabled: true });
  assert.equal(nobox.ok, false);
  assert.match(nobox.errors.join(' '), /checkbox/i);
});

test('sendPreflight blocks when count is zero or over the max', () => {
  const zero = sendPreflight({ typedPhrase: 'SEND 0 MESSAGES', expectedPhrase: 'SEND 0 MESSAGES', confirmChecked: true, eligibleCount: 0, maxSize: 500, enabled: true });
  assert.equal(zero.ok, false);
  assert.match(zero.errors.join(' '), /no eligible/i);
  const over = sendPreflight({ typedPhrase: 'SEND 600 MESSAGES', expectedPhrase: 'SEND 600 MESSAGES', confirmChecked: true, eligibleCount: 600, maxSize: 500, enabled: true });
  assert.equal(over.ok, false);
  assert.match(over.errors.join(' '), /exceeds the max/i);
});

test('recheckRecipient enforces idempotency and eligibility', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '4';
  assert.equal(recheckRecipient(null).ok, false);
  assert.match(recheckRecipient({ inbox_id: 4, phone: '555', chatwoot_message_id: 99 }).reason, /already sent/i);
  assert.match(recheckRecipient({ inbox_id: 4, phone: '555', status: 'sent' }).reason, /already sent/i);
  assert.match(recheckRecipient({ inbox_id: 4, phone: '555', eligible: false, skip_reason: 'nope' }).reason, /nope/);
  assert.match(recheckRecipient({ inbox_id: 999, phone: '555', eligible: true }).reason, /allowlist/i);
  assert.match(recheckRecipient({ inbox_id: 4, phone: '', eligible: true }).reason, /channel/i);
  assert.equal(recheckRecipient({ inbox_id: 4, phone: '5551234', eligible: true }).ok, true);
});

// ---- Sprint 6: durable bulk sender helpers (pure) ----
import { sendConfig, perMessageDelayMs, computeProgress, isRunning } from '../src/cf_sender.js';

test('sendConfig reads env with conservative defaults', () => {
  delete process.env.CHAT_FOUNDRY_BATCH_SIZE;
  delete process.env.CHAT_FOUNDRY_MESSAGES_PER_MINUTE;
  const d = sendConfig();
  assert.equal(d.batchSize, 25);
  assert.equal(d.perMinute, 30);
  assert.ok(d.maxRetries >= 1);
  process.env.CHAT_FOUNDRY_BATCH_SIZE = '10';
  process.env.CHAT_FOUNDRY_MESSAGES_PER_MINUTE = '60';
  const c = sendConfig();
  assert.equal(c.batchSize, 10);
  assert.equal(c.perMinute, 60);
  delete process.env.CHAT_FOUNDRY_BATCH_SIZE;
  delete process.env.CHAT_FOUNDRY_MESSAGES_PER_MINUTE;
});

test('perMessageDelayMs maps rate to spacing', () => {
  assert.equal(perMessageDelayMs(60), 1000);
  assert.equal(perMessageDelayMs(30), 2000);
  assert.equal(perMessageDelayMs(0), 60000); // guards against divide-by-zero
});

test('computeProgress summarizes counts and percent', () => {
  const p = computeProgress({ sent: 3, failed: 1, skipped: 1, pending: 5 }, 'sending');
  assert.equal(p.total, 10);
  assert.equal(p.processed, 5);
  assert.equal(p.remaining, 5);
  assert.equal(p.percent, 50);
  assert.equal(p.status, 'sending');
  const empty = computeProgress({}, 'ready');
  assert.equal(empty.total, 0);
  assert.equal(empty.percent, 0);
});

test('isRunning is false for an idle campaign', () => {
  assert.equal(isRunning(999999), false);
});

// ---- Sprint 7: CSV export helpers (pure) ----
import { csvCell, recipientsToCsv } from '../src/cf_history.js';

test('csvCell quotes only when needed and escapes quotes', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('has,comma'), '"has,comma"');
  assert.equal(csvCell('has "quote"'), '"has ""quote"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
});

test('recipientsToCsv emits a header and escaped rows', () => {
  const csv = recipientsToCsv([
    { conversation_id: 12, contact_name: 'Sam, Jr.', phone: '5551234', inbox_id: 4, status: 'sent', eligible: true, skip_reason: '', is_test: false, chatwoot_message_id: 99, sent_at: '2026-07-28', error: '' },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'conversation_id,contact_name,phone,inbox_id,status,eligible,skip_reason,is_test,chatwoot_message_id,sent_at,error');
  assert.match(lines[1], /^12,"Sam, Jr\.",5551234,4,sent,true,,false,99,2026-07-28,$/);
});

test('recipientsToCsv on empty input is just the header', () => {
  assert.equal(recipientsToCsv([]).split('\r\n').length, 1);
});

// ---- Settings toggles: DB-backed live-sending switch + inbox allowlist (pure) ----
import { effectiveSendEnabled, effectiveAllowedInboxIds, nextInboxList, setSendEnabled, SEND_CONFIRM_PHRASE } from '../src/cf_settings.js';

test('effectiveSendEnabled falls back to the env default when no override', () => {
  process.env.CHAT_FOUNDRY_SEND_ENABLED = 'true';
  assert.equal(effectiveSendEnabled(), true);
  process.env.CHAT_FOUNDRY_SEND_ENABLED = 'false';
  assert.equal(effectiveSendEnabled(), false);
});

test('effectiveAllowedInboxIds parses the env default', () => {
  process.env.CHAT_FOUNDRY_ALLOWED_INBOX_IDS = '2, 4 ,6';
  assert.deepEqual(effectiveAllowedInboxIds(), [2, 4, 6]);
});

test('nextInboxList adds/removes/dedupes/sorts', () => {
  assert.deepEqual(nextInboxList([4, 2], 5, true), [2, 4, 5]);
  assert.deepEqual(nextInboxList([2, 4, 5], 4, false), [2, 5]);
  assert.deepEqual(nextInboxList([2, 2], 2, true), [2]);
  assert.deepEqual(nextInboxList([], 7, false), []);
});

test('setSendEnabled rejects arming without the exact confirmation phrase (before any DB write)', async () => {
  await assert.rejects(
    () => setSendEnabled(null, true, 'nope', 'tester'),
    (e) => { assert.match(e.message, /confirmation phrase/i); assert.equal(e.status, 400); return true; },
  );
  assert.equal(SEND_CONFIRM_PHRASE, 'ENABLE SENDING');
});


