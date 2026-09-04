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
  };
}

export function espocrmConfigured() {
  const cfg = config();
  return Boolean(cfg.baseUrl && cfg.apiKey);
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

async function post(pathname, body) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.writerApiKey) throw new EspoCrmError('ENGAGEMENT_ESPOCRM_WRITER_API_KEY is not configured.', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const response = await fetch(`${cfg.baseUrl}/api/v1${pathname}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': cfg.writerApiKey, 'X-Requested-With': 'XMLHttpRequest' },
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

export async function createCanaryContactAndLink({ contact, link }) {
  const createdContact = await post('/Contact', contact);
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

export async function listProvisionalHcpIdentityLinks() {
  const data = await get('/ExternalIdentityLink?maxSize=200');
  return (data?.list || []).filter((link) => link.sourceSystem === 'HousecallPro' && link.linkStatus === 'Provisional');
}