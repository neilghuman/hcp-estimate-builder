// Chat Foundry — LLM rewrite client (Sprint 4). Node → Ollama, server-side only.
//
// The rewrite step is a SEPARATE operator action from preview and from send. It NEVER sends a
// message: it only returns a suggested rewrite for side-by-side accept/reject. Placeholder tokens
// ({{first_name}} …) must be preserved verbatim so per-recipient merge still works downstream.

export class RewriteError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'RewriteError';
    this.status = status;
  }
}

function cfg() {
  return {
    base: String(process.env.CHAT_FOUNDRY_OLLAMA_BASE || process.env.OLLAMA_API_BASE || 'http://10.0.10.102:11434').replace(/\/$/, ''),
    model: String(process.env.CHAT_FOUNDRY_REWRITE_MODEL || process.env.OLLAMA_MODEL || 'llama3.1:latest'),
    timeoutMs: Number(process.env.CHAT_FOUNDRY_REWRITE_TIMEOUT_MS || 45_000),
  };
}

export function rewriteStatus() {
  const c = cfg();
  return { base: c.base, model: c.model, configured: Boolean(c.base) };
}

const TONES = ['professional', 'friendly', 'concise', 'warm', 'urgent', 'apologetic'];
export function normalizeTone(t) {
  const v = String(t || '').trim().toLowerCase();
  return TONES.includes(v) ? v : 'professional';
}
export { TONES };

// PURE: which {{placeholders}} are present in a string (used to detect drift after a rewrite).
export function placeholderTokens(text) {
  return [...String(text || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
}

function buildMessages(body, instruction, tone) {
  const system = [
    'You rewrite short outbound customer messages (SMS / chat) for a home-services company.',
    'Rules:',
    '- Preserve every {{placeholder}} token EXACTLY as written (same spelling, keep the double braces). Do not add or remove placeholders.',
    '- Keep it concise and suitable for SMS. Plain text only — no markdown, no subject line, no signature unless the original had one.',
    '- Do not invent facts, prices, names, dates, or links that are not in the original.',
    '- Return ONLY the rewritten message text, with no preamble, quotes, or explanation.',
  ].join('\n');
  const user = [
    `Tone: ${tone}.`,
    instruction ? `Instruction: ${instruction}` : 'Instruction: improve clarity and readability without changing the meaning.',
    '',
    'Original message:',
    body,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Call Ollama's /api/chat and return the rewritten text plus a placeholder-drift check.
// Throws RewriteError (with .status) on config/timeout/HTTP errors. NEVER sends anything.
export async function rewriteMessage({ body, instruction = '', tone = 'professional' } = {}) {
  const text = String(body || '').trim();
  if (!text) throw new RewriteError('Message body is required for a rewrite.', 400);
  const c = cfg();
  if (!c.base) throw new RewriteError('Rewrite is not configured (no Ollama base URL).', 503);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let resp;
  try {
    resp = await fetch(`${c.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        stream: false,
        options: { temperature: 0.4 },
        messages: buildMessages(text, instruction, normalizeTone(tone)),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new RewriteError(e.name === 'AbortError' ? 'Rewrite timed out.' : `LLM unreachable: ${e.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new RewriteError(`LLM error ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`, 502);
  }
  const data = await resp.json().catch(() => null);
  const out = data && data.message && typeof data.message.content === 'string' ? data.message.content.trim() : '';
  if (!out) throw new RewriteError('LLM returned an empty rewrite.', 502);

  const before = placeholderTokens(text).sort();
  const after = placeholderTokens(out).sort();
  const dropped = before.filter((k) => !after.includes(k));
  const added = after.filter((k) => !before.includes(k));
  const placeholder_warning = (dropped.length || added.length)
    ? `Placeholders changed — ${dropped.length ? 'dropped: ' + [...new Set(dropped)].join(', ') : ''}${dropped.length && added.length ? '; ' : ''}${added.length ? 'added: ' + [...new Set(added)].join(', ') : ''}. Review before use.`
    : null;

  return { model: c.model, rewritten: out, placeholder_warning };
}
