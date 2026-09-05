export class EspoCrmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function config() {
  return {
    baseUrl: String(process.env.ENGAGEMENT_ESPOCRM_BASE_URL || '').replace(/\/$/, ''),
    apiKey: String(process.env.ENGAGEMENT_ESPOCRM_API_KEY || ''),
    writerApiKey: String(process.env.ENGAGEMENT_ESPOCRM_WRITER_API_KEY || ''),
    addressWriterApiKey: String(process.env.ENGAGEMENT_ESPOCRM_ADDRESS_WRITER_API_KEY || ''),
  };
}

export function espocrmConfigured() {
  const cfg = config();
  return Boolean(cfg.baseUrl && cfg.apiKey);
}

// EspoCRM datetime fields require "YYYY-MM-DD HH:MM:SS" (UTC), not ISO 8601.
function toEspoDateTime(value) {
  if (value === null || value === undefined || value === '') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 19).replace('T', ' ');
}

async function get(pathname) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.apiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_BASE_URL or ENGAGEMENT_ESPOCRM_API_KEY is not configured.', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const response = await fetch(`${cfg.baseUrl}/api/v1${pathname}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Api-Key': cfg.apiKey, 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctrl.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) throw new EspoCrmError(`EspoCRM GET ${pathname} failed with HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? 502 : 504);
    return body;
  } catch (error) {
    if (error instanceof EspoCrmError) throw error;
    throw new EspoCrmError(error.name === 'AbortError' ? 'EspoCRM request timed out.' : `EspoCRM is unreachable: ${error.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
}

export async function listContactsForReconciliation({ pageSize = 200, maxPages = 100 } = {}) {
  const contacts = [];
  for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
    const data = await get(`/Contact?maxSize=${pageSize}&offset=${offset}`);
    const batch = Array.isArray(data?.list) ? data.list : [];
    contacts.push(...batch.map((contact) => ({
      id: String(contact.id),
      firstName: contact.firstName || null,
      lastName: contact.lastName || null,
      phoneNumber: contact.phoneNumber || null,
      emailAddress: contact.emailAddress || null,
    })));
    if (batch.length < pageSize) break;
  }
  return contacts;
}

export async function getEspoCrmInventory() {
  const [metadata, contacts, legacyLinks, reviews] = await Promise.all([
    get('/Metadata'),
    get('/Contact?maxSize=1'),
    get('/HcpCustomerLink?maxSize=1'),
    get('/IdentityReview?maxSize=1'),
  ]);
  const entityDefs = metadata?.entityDefs || metadata?.entityDefinitions || {};
  return {
    connected: true,
    apiUser: 'engagement-identity-reader',
    contactCount: Number(contacts?.total || 0),
    legacyHcpCustomerLinkCount: Number(legacyLinks?.total || 0),
    identityReviewCount: Number(reviews?.total || 0),
    entitiesPresent: ['Contact', 'HcpCustomerLink', 'IdentityReview'].filter((name) => Boolean(entityDefs[name])),
  };
}

export function espocrmWriterConfigured() {
  const cfg = config();
  return Boolean(cfg.baseUrl && cfg.writerApiKey);
}

async function post(pathname, body, { skipDuplicateCheck = false } = {}) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.writerApiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_WRITER_API_KEY is not configured.', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': cfg.writerApiKey, 'X-Requested-With': 'XMLHttpRequest' };
    if (skipDuplicateCheck) headers['X-Skip-Duplicate-Check'] = 'true';
    const response = await fetch(`${cfg.baseUrl}/api/v1${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new EspoCrmError(`EspoCRM POST ${pathname} failed with HTTP ${response.status}.`, response.status === 400 || response.status === 409 ? response.status : 502);
    return data;
  } catch (error) {
    if (error instanceof EspoCrmError) throw error;
    throw new EspoCrmError(error.name === 'AbortError' ? 'EspoCRM request timed out.' : `EspoCRM is unreachable: ${error.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
}

export async function createCanaryContactAndLink({ contact, link, skipDuplicateCheck = false }) {
  const createdContact = await post('/Contact', contact, { skipDuplicateCheck });
  if (!createdContact?.id) throw new EspoCrmError('EspoCRM Contact create response did not include an ID.', 502);
  try {
    const createdLink = await post('/ExternalIdentityLink', { ...link, contactId: createdContact.id });
    if (!createdLink?.id) throw new EspoCrmError('EspoCRM ExternalIdentityLink create response did not include an ID.', 502);
    return { contactId: createdContact.id, linkId: createdLink.id };
  } catch (error) {
    error.contactId = createdContact.id;
    throw error;
  }
}

export async function getContactForAddressAudit(contactId) {
  return get(`/Contact/${encodeURIComponent(contactId)}`);
}

export async function listProvisionalHcpIdentityLinks({ pageSize = 200, maxPages = 100 } = {}) {
  const links = [];
  for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
    const data = await get(`/ExternalIdentityLink?maxSize=${pageSize}&offset=${offset}`);
    const batch = Array.isArray(data?.list) ? data.list : [];
    links.push(...batch.filter((link) => link.sourceSystem === 'HousecallPro' && link.linkStatus === 'Provisional'));
    if (batch.length < pageSize) break;
  }
  return links;
}

export async function listContactsWithAddresses({ pageSize = 200, maxPages = 100 } = {}) {
  const select = 'id,addressStreet,addressCity,addressState,addressPostalCode,addressCountry';
  const contacts = [];
  for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
    const data = await get(`/Contact?select=${encodeURIComponent(select)}&maxSize=${pageSize}&offset=${offset}`);
    const batch = Array.isArray(data?.list) ? data.list : [];
    contacts.push(...batch);
    if (batch.length < pageSize) break;
  }
  return contacts;
}

export async function listHcpIdentityLinks({ pageSize = 200, maxPages = 100 } = {}) {
  const links = [];
  for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
    const data = await get(`/ExternalIdentityLink?maxSize=${pageSize}&offset=${offset}`);
    const batch = Array.isArray(data?.list) ? data.list : [];
    links.push(...batch.filter((link) => link.sourceSystem === 'HousecallPro'));
    if (batch.length < pageSize) break;
  }
  return links;
}

export function espocrmAddressWriterConfigured() {
  const cfg = config();
  return Boolean(cfg.baseUrl && cfg.addressWriterApiKey);
}

async function putAddress(contactId, body) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.addressWriterApiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_ADDRESS_WRITER_API_KEY is not configured.', 503);
  const response = await fetch(`${cfg.baseUrl}/api/v1/Contact/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': cfg.addressWriterApiKey, 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new EspoCrmError(`EspoCRM address update failed with HTTP ${response.status}.`, response.status === 400 ? 400 : 502);
  // EspoCRM returns an empty success body for this Contact PUT endpoint.
  await response.text();
  return null;
}

export async function updateCanaryContactAddress(contactId, address) {
  const body = {
    addressStreet: address.street,
    addressCity: address.city,
    addressState: address.state,
    addressPostalCode: address.postalCode,
    addressCountry: address.country,
  };
  await putAddress(contactId, body);
  return getContactForAddressAudit(contactId);
}

export async function listContactsWithBrands({ pageSize = 200, maxPages = 100 } = {}) {
  const select = 'id,brandRelationships,primaryBrand';
  const contacts = [];
  for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
    const data = await get(`/Contact?select=${encodeURIComponent(select)}&maxSize=${pageSize}&offset=${offset}`);
    const batch = Array.isArray(data?.list) ? data.list : [];
    contacts.push(...batch);
    if (batch.length < pageSize) break;
  }
  return contacts;
}

export async function updateCanaryContactBrands(contactId, { brandRelationships, primaryBrand }) {
  const body = {};
  if (Array.isArray(brandRelationships)) body.brandRelationships = brandRelationships;
  if (primaryBrand) body.primaryBrand = primaryBrand;
  await putAddress(contactId, body);
  return getContactForAddressAudit(contactId);
}

export async function getIdentityQualitySnapshot() {
  const [reviews, links, contacts] = await Promise.all([
    get('/IdentityReview?maxSize=200'),
    get('/ExternalIdentityLink?maxSize=1'),
    get('/Contact?maxSize=1'),
  ]);
  const list = Array.isArray(reviews?.list) ? reviews.list : [];
  const byStatus = {};
  let resolvedAsDuplicate = 0;
  for (const review of list) {
    byStatus[review.reviewStatus] = (byStatus[review.reviewStatus] || 0) + 1;
    if (review.decision === 'LinkExisting') resolvedAsDuplicate += 1;
  }
  return {
    contactCount: Number(contacts?.total || 0),
    externalIdentityLinkCount: Number(links?.total || 0),
    reviews: { total: Number(reviews?.total || 0), byStatus, resolvedAsDuplicate },
  };
}

export async function findOpenIdentityReview({ sourceSystem, sourceAccountId, externalId }) {
  const data = await get('/IdentityReview?maxSize=200');
  return (data?.list || []).find((review) => review.sourceSystem === sourceSystem
    && review.sourceAccountId === sourceAccountId
    && review.externalId === externalId
    && review.reviewStatus === 'Open') || null;
}

export async function createIdentityReview(review) {
  const created = await post('/IdentityReview', review);
  if (!created?.id) throw new EspoCrmError('EspoCRM IdentityReview create response did not include an ID.', 502);
  return created;
}

export async function listOpenIdentityReviews() {
  const data = await get('/IdentityReview?maxSize=200');
  return (data?.list || []).filter((review) => review.reviewStatus === 'Open');
}

export async function listDecidedIdentityReviews() {
  const data = await get('/IdentityReview?maxSize=200');
  return (data?.list || []).filter((review) => ['Open', 'InReview'].includes(review.reviewStatus) && Boolean(review.decision));
}

export async function createExternalIdentityLink(link) {
  const created = await post('/ExternalIdentityLink', link);
  if (!created?.id) throw new EspoCrmError('EspoCRM ExternalIdentityLink create response did not include an ID.', 502);
  return created;
}

export async function findExternalIdentityLinkByExternalId({ sourceSystem, sourceAccountId = null, externalId }) {
  const params = new URLSearchParams();
  params.set('where[0][type]', 'equals');
  params.set('where[0][attribute]', 'externalId');
  params.set('where[0][value]', String(externalId));
  const data = await get(`/ExternalIdentityLink?${params.toString()}`);
  return (data?.list || []).find((link) => link.sourceSystem === sourceSystem
    && (!sourceAccountId || link.sourceAccountId === sourceAccountId)) || null;
}

export async function updateExternalIdentityLink(id, patch) {
  return put(`/ExternalIdentityLink/${encodeURIComponent(id)}`, patch);
}

export async function updateContactChatwootContext(contactId, context) {
  const body = {
    chatwootAccountId: String(context.chatwootAccountId || '').trim() || null,
    chatwootContactId: String(context.chatwootContactId || '').trim() || null,
    chatwootUrl: String(context.chatwootUrl || '').trim() || null,
  };
  await putAddress(contactId, body);
  return getContactForAddressAudit(contactId);
}

async function put(pathname, body) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.writerApiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_WRITER_API_KEY is not configured.', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const response = await fetch(`${cfg.baseUrl}/api/v1${pathname}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': cfg.writerApiKey, 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new EspoCrmError(`EspoCRM PUT ${pathname} failed with HTTP ${response.status}.`, response.status === 400 || response.status === 409 ? response.status : 502);
    return data;
  } catch (error) {
    if (error instanceof EspoCrmError) throw error;
    throw new EspoCrmError(error.name === 'AbortError' ? 'EspoCRM request timed out.' : `EspoCRM is unreachable: ${error.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
}

export async function updateIdentityReview(id, patch) {
  return put(`/IdentityReview/${encodeURIComponent(id)}`, patch);
}

async function del(pathname) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.writerApiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_WRITER_API_KEY is not configured.', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const response = await fetch(`${cfg.baseUrl}/api/v1${pathname}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-Api-Key': cfg.writerApiKey, 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctrl.signal,
    });
    if (!response.ok && response.status !== 404) throw new EspoCrmError(`EspoCRM DELETE ${pathname} failed with HTTP ${response.status}.`, 502);
    return true;
  } catch (error) {
    if (error instanceof EspoCrmError) throw error;
    throw new EspoCrmError(error.name === 'AbortError' ? 'EspoCRM request timed out.' : `EspoCRM is unreachable: ${error.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
}

export async function createCallbackRecord(callback) {
  const body = {
    name: callback.callbackNumber,
    contactId: callback.contactId || null,
    phone: callback.phone || null,
    dueAt: toEspoDateTime(callback.dueAt),
    timezone: callback.timezone || null,
    callbackNumber: callback.callbackNumber || null,
    owner: callback.owner || null,
    reason: callback.reason || null,
    source: callback.source || null,
    status: callback.status || 'scheduled',
    outcome: callback.outcome || null,
    reminderSentAt: toEspoDateTime(callback.reminderSentAt) || null,
    completedAt: toEspoDateTime(callback.completedAt) || null,
    completedBy: callback.completedBy || null,
  };
  const created = await post('/Callback', body);
  if (!created?.id) throw new EspoCrmError('EspoCRM Callback create response did not include an ID.', 502);
  return {
    id: created.id,
    contactId: created.contactId || body.contactId,
    phone: created.phone || body.phone,
    dueAt: created.dueAt || body.dueAt,
    timezone: created.timezone || body.timezone,
    callbackNumber: created.callbackNumber || body.callbackNumber,
    owner: created.owner || body.owner,
    reason: created.reason || body.reason,
    source: created.source || body.source,
    status: created.status || body.status,
    outcome: created.outcome || body.outcome,
    reminderSentAt: created.reminderSentAt || body.reminderSentAt,
    rescheduledToCallbackId: created.rescheduledToCallbackId || body.rescheduledToCallbackId,
    rescheduledFromCallbackId: created.rescheduledFromCallbackId || body.rescheduledFromCallbackId,
    completedAt: created.completedAt || body.completedAt,
    completedBy: created.completedBy || body.completedBy,
  };
}

export async function createMeetingRecord(meeting) {
  const start = meeting.dateStart;
  const end = meeting.dateEnd || new Date(new Date(start).getTime() + 30 * 60 * 1000).toISOString();
  const assignedUserId = meeting.assignedUserId || null;
  const body = {
    name: meeting.name,
    status: meeting.status || 'Planned',
    dateStart: toEspoDateTime(start),
    dateEnd: toEspoDateTime(end),
    assignedUserId,
    usersIds: meeting.usersIds || (assignedUserId ? [assignedUserId] : []),
    parentType: meeting.parentType || null,
    parentId: meeting.parentId || null,
    description: meeting.description || null,
  };
  const created = await post('/Meeting', body);
  if (!created?.id) throw new EspoCrmError('EspoCRM Meeting create response did not include an ID.', 502);
  return { id: created.id, ...body };
}

export async function createCallRecord(call) {
  const body = {
    name: call.name,
    status: call.status || 'Held',
    direction: call.direction || 'Outbound',
    dateStart: toEspoDateTime(call.dateStart),
    dateEnd: toEspoDateTime(call.dateEnd) || null,
    duration: Number.isFinite(call.duration) ? call.duration : 0,
    parentType: call.parentType || null,
    parentId: call.parentId || null,
    callbackId: call.callbackId || null,
    assignedUserId: call.assignedUserId || null,
    description: call.description || null,
  };
  const created = await post('/Call', body);
  if (!created?.id) throw new EspoCrmError('EspoCRM Call create response did not include an ID.', 502);
  return { id: created.id, ...body };
}

export async function updateMeetingRecord(id, patch) {
  const body = {
    ...(patch?.status !== undefined ? { status: patch.status } : {}),
    ...(patch?.dateStart !== undefined ? { dateStart: toEspoDateTime(patch.dateStart) } : {}),
    ...(patch?.dateEnd !== undefined ? { dateEnd: toEspoDateTime(patch.dateEnd) } : {}),
    ...(patch?.description !== undefined ? { description: patch.description } : {}),
  };
  const updated = await put(`/Meeting/${encodeURIComponent(id)}`, body);
  return { id, ...body, ...(updated || {}) };
}

export async function deleteMeetingRecord(id) {
  return del(`/Meeting/${encodeURIComponent(id)}`);
}

// Resolve an active EspoCRM user id by email address (used to assign a callback
// meeting to the owner's calendar). Returns null when no active user matches.
export async function findUserIdByEmail(email) {
  const value = String(email || '').trim();
  if (!value) return null;
  const params = new URLSearchParams();
  params.set('where[0][type]', 'equals');
  params.set('where[0][attribute]', 'emailAddress');
  params.set('where[0][value]', value);
  params.set('select', 'id,isActive');
  const data = await get(`/User?${params.toString()}`);
  const match = (data?.list || []).find((user) => user.isActive !== false);
  return match ? match.id : null;
}

export async function updateCallbackRecord(id, patch) {
  const body = {
    ...(patch?.owner !== undefined ? { owner: patch.owner } : {}),
    ...(patch?.status !== undefined ? { status: patch.status } : {}),
    ...(patch?.outcome !== undefined ? { outcome: patch.outcome } : {}),
    ...(patch?.dueAt !== undefined ? { dueAt: toEspoDateTime(patch.dueAt) } : {}),
    ...(patch?.reason !== undefined ? { reason: patch.reason } : {}),
    ...(patch?.phone !== undefined ? { phone: patch.phone } : {}),
    ...(patch?.rescheduledToCallbackId !== undefined ? { rescheduledToCallbackId: patch.rescheduledToCallbackId } : {}),
    ...(patch?.rescheduledFromCallbackId !== undefined ? { rescheduledFromCallbackId: patch.rescheduledFromCallbackId } : {}),
    ...(patch?.completedAt !== undefined ? { completedAt: toEspoDateTime(patch.completedAt) } : {}),
    ...(patch?.completedBy !== undefined ? { completedBy: patch.completedBy } : {}),
  };
  const updated = await put(`/Callback/${encodeURIComponent(id)}`, body);
  return {
    id,
    ...body,
    ...(updated || {}),
  };
}

export async function listCallbackRecords() {
  const data = await get('/Callback?maxSize=200');
  return (data?.list || []).map((row) => ({
    id: row.id,
    contactId: row.contactId || null,
    phone: row.phone || null,
    dueAt: row.dueAt || null,
    owner: row.owner || null,
    reason: row.reason || null,
    source: row.source || null,
    status: row.status || 'scheduled',
    outcome: row.outcome || null,
    reminderSentAt: row.reminderSentAt || null,
  }));
}