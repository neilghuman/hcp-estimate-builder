import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const IDENTITY_OUTCOMES = [
  'auto_confirmed',
  'provisional',
  'identity_review',
  'net_new',
  'malformed_or_no_key',
  'field_conflict',
];

export function normalizePhone(value, { defaultCountry = 'US' } = {}) {
  const input = String(value || '').trim();
  if (!input) return null;
  const phone = parsePhoneNumberFromString(input, defaultCountry);
  return phone && phone.isValid() ? phone.number : null;
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function valueList(contact, keys, normalize) {
  const values = [];
  for (const key of keys) {
    const raw = contact[key];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const normalized = normalize(value);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
  }
  return values;
}

function contactName(contact) {
  return String(contact.name || `${contact.firstName || contact.first_name || ''} ${contact.lastName || contact.last_name || ''}`).trim();
}

function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

export function namesMateriallyDifferent(left, right) {
  const leftParts = normalizedName(left);
  const rightParts = normalizedName(right);
  if (!leftParts.length || !rightParts.length) return false;
  return leftParts[0] !== rightParts[0] || leftParts.at(-1) !== rightParts.at(-1);
}

function sourceName(record) {
  return String(record.name || `${record.firstName || record.first_name || ''} ${record.lastName || record.last_name || ''}`).trim();
}

function buildCandidate(contact, phone, email) {
  const phones = valueList(contact, ['phones', 'phoneNumbers', 'phoneNumber', 'phone'], normalizePhone);
  const emails = valueList(contact, ['emails', 'emailAddresses', 'emailAddress', 'email'], normalizeEmail);
  return {
    contact,
    phoneMatch: Boolean(phone && phones.includes(phone)),
    emailMatch: Boolean(email && emails.includes(email)),
    phoneConflict: Boolean(phone && phones.length && !phones.includes(phone)),
    emailConflict: Boolean(email && emails.length && !emails.includes(email)),
  };
}

export function resolveIdentity(record, { contacts = [], existingLink = null, defaultCountry = 'US' } = {}) {
  if (existingLink && existingLink.contactId) {
    return { outcome: 'auto_confirmed', contactId: existingLink.contactId, linkStatus: 'confirmed', match: 'external_link' };
  }

  const sourcePhones = valueList(record, ['phones', 'phoneNumbers', 'phoneNumber', 'phone', 'mobile_number', 'mobile', 'home_number', 'home', 'work_number', 'work'], (value) => normalizePhone(value, { defaultCountry }));
  const sourceEmails = valueList(record, ['emails', 'emailAddresses', 'emailAddress', 'email'], normalizeEmail);
  const phone = sourcePhones[0] || null;
  const email = sourceEmails[0] || null;
  if (!sourcePhones.length && !sourceEmails.length) {
    return { outcome: 'malformed_or_no_key', contactId: null, linkStatus: null, phone, email };
  }

  const candidates = contacts.map((contact) => {
    const candidate = buildCandidate(contact, phone, email);
    const phones = valueList(contact, ['phones', 'phoneNumbers', 'phoneNumber', 'phone'], normalizePhone);
    const emails = valueList(contact, ['emails', 'emailAddresses', 'emailAddress', 'email'], normalizeEmail);
    candidate.phoneMatch = sourcePhones.some((value) => phones.includes(value));
    candidate.emailMatch = sourceEmails.some((value) => emails.includes(value));
    candidate.phoneConflict = Boolean(sourcePhones.length && phones.length && !candidate.phoneMatch);
    candidate.emailConflict = Boolean(sourceEmails.length && emails.length && !candidate.emailMatch);
    return candidate;
  }).filter((candidate) => candidate.phoneMatch || candidate.emailMatch);
  const uniqueContactIds = [...new Set(candidates.map((candidate) => String(candidate.contact.id)))];
  if (!candidates.length) {
    return { outcome: 'net_new', contactId: null, linkStatus: 'provisional', phone, email };
  }
  if (uniqueContactIds.length !== 1) {
    return { outcome: 'identity_review', contactId: null, linkStatus: null, phone, email, candidateContactIds: uniqueContactIds, reason: 'identifiers_match_multiple_contacts' };
  }

  const candidate = candidates[0];
  const contactId = candidate.contact.id;
  const bothMatch = Boolean(sourcePhones.length && sourceEmails.length && candidate.phoneMatch && candidate.emailMatch);
  if (bothMatch) {
    if (record.sourceSystem === 'housecall_pro' && namesMateriallyDifferent(sourceName(record), contactName(candidate.contact))) {
      return { outcome: 'identity_review', contactId: null, linkStatus: null, phone, email, candidateContactIds: [String(contactId)], reason: 'hcp_name_mismatch' };
    }
    return { outcome: 'auto_confirmed', contactId, linkStatus: 'confirmed', phone, email, match: 'phone_and_email' };
  }

  if (candidate.phoneConflict || candidate.emailConflict) {
    return { outcome: 'field_conflict', contactId, linkStatus: null, phone, email, conflicts: { phone: candidate.phoneConflict, email: candidate.emailConflict } };
  }
  return { outcome: 'provisional', contactId, linkStatus: 'provisional', phone, email, match: candidate.phoneMatch ? 'phone' : 'email' };
}