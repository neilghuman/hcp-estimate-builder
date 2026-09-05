import test from 'node:test';
import assert from 'node:assert/strict';

import { makeCall, threecxConfigured } from '../src/threecx.js';

const ENV = ['THREE_CX_BASE_URL', 'THREE_CX_TOKEN_URL', 'THREE_CX_CLIENT_ID', 'THREE_CX_CLIENT_SECRET', 'THREE_CX_CALL_DN'];

function setEnv() {
  process.env.THREE_CX_BASE_URL = 'http://3cx.test';
  process.env.THREE_CX_TOKEN_URL = 'http://3cx.test/connect/token';
  process.env.THREE_CX_CLIENT_ID = 'cid';
  process.env.THREE_CX_CLIENT_SECRET = 'csec';
  process.env.THREE_CX_CALL_DN = 'routepoint';
}
function clearEnv() { for (const k of ENV) delete process.env[k]; }

test('threecxConfigured requires all 3CX settings', () => {
  clearEnv();
  assert.equal(threecxConfigured(), false);
  setEnv();
  assert.equal(threecxConfigured(), true);
  clearEnv();
});

test('makeCall gets a token then posts destination to the DN makecall endpoint', async () => {
  setEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    try { body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; }
    calls.push({ url: String(url), method: init.method || 'GET', body });
    if (String(url).endsWith('/connect/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, text: async () => JSON.stringify({ finalstatus: 'Connected', reason: null }) };
  };
  try {
    const r = await makeCall('+12065551212');
    assert.equal(r.finalstatus, 'Connected');
    const call = calls.find((c) => c.url.includes('/makecall'));
    assert.match(call.url, /\/callcontrol\/routepoint\/makecall$/);
    assert.equal(call.method, 'POST');
    assert.equal(call.body.destination, '+12065551212');
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv();
  }
});

test('makeCall throws on a Failed finalstatus', async () => {
  setEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('/connect/token')
    ? { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    : { ok: false, text: async () => JSON.stringify({ finalstatus: 'Failed', reason: 'DestinationIsNotReachable' }) });
  try {
    await assert.rejects(() => makeCall('+1'), /DestinationIsNotReachable/);
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv();
  }
});
