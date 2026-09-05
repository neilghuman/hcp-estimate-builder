import { resolveIdentity } from './engagement_identity.js';

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

export function normalizeChatwootConversationContext(conversation) {
  const record = conversation?.data || conversation || {};
  const sender = record.meta?.sender || record.sender || {};
  const contactId = sender.id ?? record.contact_id ?? record.contact?.id ?? null;
  if (!contactId) throw Object.assign(new Error('The Chatwoot conversation has no customer contact.'), { status: 422 });

  return {
    conversationId: String(record.id || ''),
    inboxId: record.inbox_id == null ? null : String(record.inbox_id),
    status: text(record.status),
    contact: {
      id: String(contactId),
      sourceSystem: 'chatwoot',
      name: text(sender.name ?? record.contact?.name),
      phone: text(sender.phone_number ?? record.contact?.phone_number),
      email: text(sender.email ?? record.contact?.email),
      identifier: text(sender.identifier ?? record.contact?.identifier),
    },
  };
}

export function resolveChatwootConversationContext(conversation, { contacts = [], existingLink = null, defaultCountry = 'US' } = {}) {
  const context = normalizeChatwootConversationContext(conversation);
  const identity = resolveIdentity(context.contact, { contacts, existingLink, defaultCountry });
  return {
    ...context,
    identity: {
      outcome: identity.outcome,
      contactId: identity.contactId || null,
      linkStatus: identity.linkStatus || null,
      match: identity.match || null,
      reason: identity.reason || null,
      candidateContactIds: identity.candidateContactIds || [],
      conflicts: identity.conflicts || {},
    },
  };
}

export function buildChatwootWebhookDecision(payload) {
  const event = String(payload?.event || '').trim();
  const message = payload?.message || {};
  const conversation = payload?.conversation || {};
  const conversationId = message.conversation_id ?? conversation.id ?? null;
  const sourceEventId = message.id ?? payload?.id ?? null;
  if (!event) throw Object.assign(new Error('Chatwoot webhook event is required.'), { status: 422 });
  if (!sourceEventId) throw Object.assign(new Error('Chatwoot webhook message ID is required.'), { status: 422 });
  if (!conversationId) throw Object.assign(new Error('Chatwoot webhook conversation ID is required.'), { status: 422 });
  return {
    event,
    sourceEventId: `message:${sourceEventId}`,
    conversationId: String(conversationId),
    isIncoming: message.message_type === 0 || String(message.message_type || '').toLowerCase() === 'incoming',
  };
}

export function buildConfirmedChatwootLinkPlan(context, { sourceAccountId } = {}) {
  const accountId = String(sourceAccountId || '').trim();
  if (!accountId) throw Object.assign(new Error('CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID is not configured.'), { status: 503 });
  if (!context?.contact?.id || !context?.identity) throw Object.assign(new Error('A resolved Chatwoot context is required.'), { status: 422 });
  if (context.identity.outcome !== 'auto_confirmed' || !context.identity.contactId) {
    throw Object.assign(new Error(`Chatwoot identity must be confirmed before linking (current outcome: ${context.identity.outcome || 'unknown'}).`), { status: 409 });
  }
  return {
    contactId: String(context.identity.contactId),
    sourceAccountId: accountId,
    externalId: String(context.contact.id),
    link: {
      name: `Chatwoot:${accountId}:${context.contact.id}`,
      sourceSystem: 'Chatwoot',
      sourceAccountId: accountId,
      externalId: String(context.contact.id),
      linkStatus: 'Confirmed',
      matchingEvidence: {
        source: 'chatwoot-context-link',
        conversationId: context.conversationId,
        match: context.identity.match || null,
      },
    },
    contactContext: {
      chatwootAccountId: accountId,
      chatwootContactId: String(context.contact.id),
      chatwootUrl: null,
    },
  };
}

export function buildChatwootIdentityReview(context, { sourceAccountId, sourceUrl = null } = {}) {
  const accountId = String(sourceAccountId || '').trim();
  if (!accountId) throw Object.assign(new Error('CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID is not configured.'), { status: 503 });
  if (!context?.contact?.id || !context?.identity) throw Object.assign(new Error('A resolved Chatwoot context is required.'), { status: 422 });
  const outcome = context.identity.outcome;
  if (!['provisional', 'identity_review', 'field_conflict', 'net_new'].includes(outcome)) {
    throw Object.assign(new Error(`Chatwoot identity outcome ${outcome || 'unknown'} does not require review.`), { status: 409 });
  }
  return {
    name: `Chatwoot identity review: ${accountId}:${context.contact.id}`,
    sourceSystem: 'Chatwoot',
    sourceAccountId: accountId,
    externalId: String(context.contact.id),
    sourceUrl,
    reviewStatus: 'Open',
    candidateContactId: context.identity.contactId || null,
    conflictSummary: outcome,
    matchingEvidence: {
      outcome,
      reason: context.identity.reason || null,
      candidateContactIds: context.identity.candidateContactIds || [],
      conflicts: context.identity.conflicts || {},
      conversationId: context.conversationId,
    },
  };
}