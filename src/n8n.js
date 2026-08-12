// n8n bridge client for estimate creation.

function getWebhookUrl() {
  return String(process.env.N8N_ESTIMATE_WEBHOOK_URL || '').trim();
}

export function isN8nConfigured() {
  return Boolean(getWebhookUrl());
}

export async function createEstimateViaN8n(payload) {
  const url = getWebhookUrl();
  if (!url) {
    throw new Error('N8N_ESTIMATE_WEBHOOK_URL is not set.');
  }

  const secret = String(process.env.N8N_ESTIMATE_WEBHOOK_SECRET || '').trim();
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (secret) headers['x-portal-secret'] = secret;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText;
    const err = new Error(`n8n webhook -> ${res.status} ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}
