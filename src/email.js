// Backend-only transactional email sender for the Customer Intake confirmation.
// NEVER import from frontend code. SMTP credentials stay server-side and are never logged.
//
// Config (env):
//   INTAKE_SMTP_HOST     SMTP server host (required to enable email)
//   INTAKE_SMTP_PORT     default 587
//   INTAKE_SMTP_SECURE   "true" for implicit TLS (port 465); default false (STARTTLS)
//   INTAKE_SMTP_USER     SMTP auth user (optional for open relays)
//   INTAKE_SMTP_PASS     SMTP auth password (optional)
// The From/Reply-To identity is per-brand and passed in by the caller (see src/brands.js).

export class EmailError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
  }
}

function cfg() {
  return {
    host: String(process.env.INTAKE_SMTP_HOST || '').trim(),
    port: Number(process.env.INTAKE_SMTP_PORT || 587),
    secure: String(process.env.INTAKE_SMTP_SECURE || 'false').toLowerCase() === 'true',
    user: process.env.INTAKE_SMTP_USER || '',
    pass: process.env.INTAKE_SMTP_PASS || '',
  };
}

// Email is only attempted when an SMTP host is configured; otherwise sends are skipped (not failed).
export function emailConfigured() {
  return Boolean(cfg().host);
}

// Non-secret status for the config endpoint. Never returns credentials.
export function emailStatus() {
  const c = cfg();
  return { host: c.host || null, port: c.port, secure: c.secure, authConfigured: Boolean(c.user), configured: Boolean(c.host) };
}

// Send one email. nodemailer is imported lazily so the module (and its pure builders) never
// hard-depend on the package until an actual send is attempted.
export async function sendEmail({ from, to, replyTo, subject, html, text }) {
  const c = cfg();
  if (!c.host) throw new EmailError('Email is not configured (INTAKE_SMTP_HOST missing).', 503);
  if (!from) throw new EmailError('A From identity is required.', 400);
  if (!to) throw new EmailError('A recipient address is required.', 400);

  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    throw new EmailError('nodemailer is not installed on the server.', 500);
  }

  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });

  const info = await transport.sendMail({ from, to, replyTo: replyTo || undefined, subject, html, text });
  return { messageId: info && info.messageId ? info.messageId : null };
}
