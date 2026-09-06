import { normalizeEmail, normalizePhone, resolveIdentity } from './engagement_identity.js';

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
  if (!['provisional', 'identity_review', 'field_conflict', 'net_new', 'malformed_or_no_key'].includes(outcome)) {
    throw Object.assign(new Error(`Chatwoot identity outcome ${outcome || 'unknown'} does not require review.`), { status: 409 });
  }
  const displayName = text(context.contact.name) || `${accountId}:${context.contact.id}`;
  return {
    name: `Chatwoot identity review: ${displayName}`,
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

export function buildChatwootReviewExecutionPlan(review, context, { sourceAccountId, sourceUrl = null, defaultCountry = 'US' } = {}) {
  const accountId = String(sourceAccountId || '').trim();
  const decision = String(review?.decision || '').trim();
  const reviewStatus = String(review?.reviewStatus || '').trim();
  if (!accountId) throw Object.assign(new Error('CHAT_FOUNDRY_CHATWOOT_ACCOUNT_ID is not configured.'), { status: 503 });
  if (review?.sourceSystem !== 'Chatwoot' || String(review.sourceAccountId || '') !== accountId) throw Object.assign(new Error('Review is not a Chatwoot review for this account.'), { status: 409 });
  if (!decision) throw Object.assign(new Error('Review has no decision to execute.'), { status: 422 });
  if (!['Open', 'InReview'].includes(reviewStatus)) throw Object.assign(new Error(`Review is not actionable (status ${reviewStatus || 'unknown'}).`), { status: 409 });
  if (decision === 'Defer') return { action: 'defer', reviewUpdate: { reviewStatus: 'Deferred' } };
  if (!context?.contact?.id || String(context.contact.id) !== String(review.externalId)) {
    throw Object.assign(new Error('The current Chatwoot conversation does not match the review contact.'), { status: 409 });
  }
  const contactContext = {
    chatwootAccountId: accountId,
    chatwootContactId: String(context.contact.id),
    chatwootUrl: sourceUrl,
  };
  const link = {
    name: `Chatwoot:${accountId}:${context.contact.id}`,
    sourceSystem: 'Chatwoot',
    sourceAccountId: accountId,
    externalId: String(context.contact.id),
    linkStatus: 'Confirmed',
    matchingEvidence: { source: 'identity_review', reviewId: review.id || null, decision, conversationId: context.conversationId },
  };
  if (decision === 'LinkExisting') {
    const contactId = String(review.candidateContactId || '').trim();
    if (!contactId) throw Object.assign(new Error('LinkExisting requires a candidateContactId on the review.'), { status: 422 });
    return { action: 'link', contactId, link: { ...link, contactId }, contactContext, reviewUpdate: { reviewStatus: 'Linked' } };
  }
  if (decision === 'CreateNew' || decision === 'Separate') {
    const nameParts = String(context.contact.name || '').trim().split(/\s+/).filter(Boolean);
    const phone = normalizePhone(context.contact.phone, { defaultCountry });
    const email = normalizeEmail(context.contact.email);
    if (!nameParts.length) throw Object.assign(new Error('A Chatwoot contact name is required to create a CRM Contact.'), { status: 422 });
    if (!phone && !email) throw Object.assign(new Error('A valid Chatwoot contact phone number or email is required to create a CRM Contact.'), { status: 422 });
    return {
      action: 'create',
      contact: { firstName: nameParts[0], lastName: nameParts.slice(1).join(' ') || 'Customer', phoneNumber: phone, emailAddress: email },
      link,
      contactContext,
      reviewUpdate: { reviewStatus: decision === 'Separate' ? 'Separate' : 'Created' },
    };
  }
  throw Object.assign(new Error(`Unknown review decision: ${decision}.`), { status: 422 });
}