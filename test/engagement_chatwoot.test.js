import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatwootIdentityReview, buildConfirmedChatwootLinkPlan, buildChatwootWebhookDecision, normalizeChatwootConversationContext, resolveChatwootConversationContext } from '../src/engagement_chatwoot.js';

const conversation = {
  id: 42,
  inbox_id: 7,
  status: 'open',
  meta: {
    sender: {
      id: 99,
      name: 'Jane Doe',
      phone_number: '(206) 555-1212',
      email: 'Jane.Doe@example.com',
      identifier: 'telnyx:+12065551212',
    },
  },
};

test('normalizes server-fetched Chatwoot conversation context', () => {
  const context = normalizeChatwootConversationContext(conversation);
  assert.equal(context.conversationId, '42');
  assert.equal(context.inboxId, '7');
  assert.equal(context.contact.id, '99');
  assert.equal(context.contact.sourceSystem, 'chatwoot');
  assert.equal(context.contact.phone, '(206) 555-1212');
});

test('rejects a Chatwoot conversation with no customer contact', () => {
  assert.throws(() => normalizeChatwootConversationContext({ id: 42, meta: {} }), /no customer contact/i);
});

test('existing Chatwoot external identity links resolve a CRM Contact', () => {
  const context = resolveChatwootConversationContext(conversation, { existingLink: { contactId: 'crm-1' } });
  assert.equal(context.identity.outcome, 'auto_confirmed');
  assert.equal(context.identity.contactId, 'crm-1');
  assert.equal(context.identity.match, 'external_link');
});

test('a single Chatwoot identifier match remains provisional', () => {
  const context = resolveChatwootConversationContext(conversation, {
    contacts: [{ id: 'crm-1', phoneNumber: '+12065551212' }],
  });
  assert.equal(context.identity.outcome, 'provisional');
  assert.equal(context.identity.contactId, 'crm-1');
});

test('conflicting Chatwoot identifiers are returned for identity review', () => {
  const context = resolveChatwootConversationContext(conversation, {
    contacts: [
      { id: 'crm-1', phoneNumber: '+12065551212' },
      { id: 'crm-2', emailAddress: 'jane.doe@example.com' },
    ],
  });
  assert.equal(context.identity.outcome, 'identity_review');
  assert.deepEqual(context.identity.candidateContactIds.sort(), ['crm-1', 'crm-2']);
});

test('webhook decisions use immutable message IDs for idempotency', () => {
  const decision = buildChatwootWebhookDecision({ event: 'message_created', message: { id: 123, conversation_id: 42, message_type: 0 } });
  assert.deepEqual(decision, { event: 'message_created', sourceEventId: 'message:123', conversationId: '42', isIncoming: true });
});

test('webhook decisions distinguish incoming messages from staff messages', () => {
  assert.equal(buildChatwootWebhookDecision({ event: 'message_created', message: { id: 1, conversation_id: 42, message_type: 'incoming' } }).isIncoming, true);
  assert.equal(buildChatwootWebhookDecision({ event: 'message_created', message: { id: 2, conversation_id: 42, message_type: 1 } }).isIncoming, false);
});

test('webhook decisions require an event, message ID, and conversation ID', () => {
  assert.throws(() => buildChatwootWebhookDecision({}), /event is required/i);
  assert.throws(() => buildChatwootWebhookDecision({ event: 'message_created' }), /message ID/i);
  assert.throws(() => buildChatwootWebhookDecision({ event: 'message_created', message: { id: 1 } }), /conversation ID/i);
});

test('only a confirmed Chatwoot context produces a CRM identity-link plan', () => {
  const context = resolveChatwootConversationContext(conversation, { existingLink: { contactId: 'crm-1' } });
  const plan = buildConfirmedChatwootLinkPlan(context, { sourceAccountId: '1' });
  assert.equal(plan.contactId, 'crm-1');
  assert.equal(plan.link.sourceSystem, 'Chatwoot');
  assert.equal(plan.link.externalId, '99');
  assert.equal(plan.link.linkStatus, 'Confirmed');
});

test('provisional Chatwoot identities cannot produce a CRM link plan', () => {
  const context = resolveChatwootConversationContext(conversation, { contacts: [{ id: 'crm-1', phoneNumber: '+12065551212' }] });
  assert.throws(() => buildConfirmedChatwootLinkPlan(context, { sourceAccountId: '1' }), /must be confirmed/i);
});

test('non-confirmed Chatwoot contexts create a redacted identity review plan', () => {
  const context = resolveChatwootConversationContext(conversation, {
    contacts: [{ id: 'crm-1', phoneNumber: '+12065551212' }],
  });
  const review = buildChatwootIdentityReview(context, { sourceAccountId: '1', sourceUrl: 'https://chat.test/app/accounts/1/conversations/42' });
  assert.equal(review.sourceSystem, 'Chatwoot');
  assert.equal(review.externalId, '99');
  assert.equal(review.conflictSummary, 'provisional');
  assert.equal(JSON.stringify(review).includes('206-555'), false);
});

test('confirmed Chatwoot identities cannot create an unnecessary review', () => {
  const context = resolveChatwootConversationContext(conversation, { existingLink: { contactId: 'crm-1' } });
  assert.throws(() => buildChatwootIdentityReview(context, { sourceAccountId: '1' }), /does not require review/i);
});