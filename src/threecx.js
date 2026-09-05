// Minimal 3CX Call Control client for click-to-call. Initiates an outbound call
// from a configured DN (a route point) to a destination number.

let _token = { value: null, exp: 0 };

function cfg() {
  return {
    base: String(process.env.THREE_CX_BASE_URL || '').replace(/\/$/, ''),
    tokenUrl: String(process.env.THREE_CX_TOKEN_URL || ''),
    clientId: String(process.env.THREE_CX_CLIENT_ID || ''),
    clientSecret: String(process.env.THREE_CX_CLIENT_SECRET || ''),
    dn: String(process.env.THREE_CX_CALL_DN || ''),
  };
}

export function threecxConfigured() {
  const c = cfg();
  return Boolean(c.base && c.tokenUrl && c.clientId && c.clientSecret && c.dn);
}

export function clickToCallEnabled() {
  return String(process.env.ENGAGEMENT_CALLBACK_CLICK_TO_CALL_ENABLED || 'false').toLowerCase() === 'true'
    && threecxConfigured();
}

async function getToken() {
  const c = cfg();
  if (_token.value && Date.now() < _token.exp - 30_000) return _token.value;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret });
  const r = await fetch(c.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`3CX token request failed (HTTP ${r.status}).`);
  const j = await r.json();
  if (!j?.access_token) throw new Error('3CX token response missing access_token.');
  _token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) * 1000) };
  return _token.value;
}

// Initiate a call from a DN (default: the configured route point) to `destination`.
// Resolves with the 3CX result object; throws on transport failure or Failed status.
export async function makeCall(destination, { dn } = {}) {
  const c = cfg();
  const fromDn = String(dn || c.dn || '').trim();
  const dest = String(destination || '').trim();
  if (!fromDn) throw new Error('A 3CX DN to originate the call is required.');
  if (!dest) throw new Error('A destination number is required.');
  const token = await getToken();
  const r = await fetch(`${c.base}/callcontrol/${encodeURIComponent(fromDn)}/makecall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: dest }),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok || (data && data.finalstatus === 'Failed')) {
    throw new Error(`3CX makecall failed: ${(data && (data.reason || data.reasontext)) || `HTTP ${r.status}`}`);
  }
  return data || { finalstatus: 'Unknown' };
}
