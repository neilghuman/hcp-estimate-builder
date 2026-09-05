import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhone(value, { defaultCountry = 'US' } = {}) {
  const input = String(value ?? '').trim();
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  return parsed && parsed.isValid() ? parsed.number : null;
}

function isValidDate(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function normalizeTimeZone(value) {
  const timezone = String(value ?? '').trim();
  if (!timezone) return null;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

export function scheduleCallback({
  contactId = null,
  phone = null,
  dueAt,
  owner = null,
  reason = null,
  timezone = null,
  source = null,
  idempotencyKey = null,
  status = 'scheduled',
} = {}) {
  const hasContact = typeof contactId === 'string' && contactId.trim().length > 0;
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const normalizedOwner = String(owner ?? '').trim();
  const normalizedReason = String(reason ?? '').trim();
  const normalizedTimezone = normalizeTimeZone(timezone);
  const normalizedIdempotencyKey = idempotencyKey == null ? null : String(idempotencyKey).trim();

  if (!hasContact) {
    throw new Error('A valid contactId is required to schedule a callback.');
  }

  if (phone && !normalizedPhone) {
    throw new Error('A valid phone number is required to schedule a callback.');
  }

  if (!dueAt || !isValidDate(dueAt)) {
    throw new Error('A valid dueAt timestamp is required to schedule a callback.');
  }

  if (!normalizedOwner) throw new Error('An owner is required to schedule a callback.');
  if (!normalizedReason) throw new Error('A reason is required to schedule a callback.');
  if (!normalizedTimezone) throw new Error('A valid IANA timezone is required to schedule a callback.');

  const id = ['cb', Date.now().toString(36), Math.random().toString(36).slice(2, 8)].join('_');

  return {
    id,
    callbackNumber: `CB-${id.slice(3).toUpperCase()}`,
    contactId: hasContact ? contactId : null,
    phone: normalizedPhone ?? null,
    dueAt: new Date(dueAt).toISOString(),
    timezone: normalizedTimezone,
    owner: normalizedOwner,
    reason: normalizedReason,
    source: source ?? null,
    idempotencyKey: normalizedIdempotencyKey || null,
    status,
    createdAt: new Date().toISOString(),
  };
}

export function buildCallbackQueue(callbacks = []) {
  return callbacks
    .filter((callback) => callback && callback.status === 'scheduled')
    .sort((left, right) => new Date(left.dueAt) - new Date(right.dueAt));
}

export function updateCallbackStatus(callback, nextStatus) {
  if (!callback || !callback.id) {
    throw new Error('A valid callback is required to update status.');
  }

  const allowed = new Set(['scheduled', 'due_soon', 'in_progress', 'completed', 'rescheduled', 'cancelled', 'overdue', 'escalated']);
  if (!allowed.has(nextStatus)) {
    throw new Error(`Unsupported callback status: ${nextStatus}`);
  }
  if (nextStatus === 'completed' && !String(callback.outcome ?? '').trim()) {
    throw new Error('A completed callback requires an outcome.');
  }

  return {
    ...callback,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
}

export function rescheduleCallback(callback, input = {}) {
  if (!callback?.id) throw new Error('A valid callback is required to reschedule.');
  if (!['scheduled', 'due_soon', 'in_progress', 'overdue', 'escalated'].includes(callback.status)) {
    throw new Error(`Callback ${callback.id} cannot be rescheduled from ${callback.status}.`);
  }
  const replacement = scheduleCallback({
    contactId: callback.contactId,
    phone: callback.phone,
    dueAt: input.dueAt,
    owner: input.owner ?? callback.owner,
    reason: input.reason ?? callback.reason,
    timezone: input.timezone ?? callback.timezone,
    source: input.source ?? callback.source,
  });
  return {
    previous: updateCallbackStatus({ ...callback, rescheduledToCallbackId: replacement.id }, 'rescheduled'),
    replacement: { ...replacement, rescheduledFromCallbackId: callback.id },
  };
}

export function buildCallbackCommandCenter(callbacks = [], now = new Date()) {
  const current = new Date(now);
  const endOfDay = new Date(current);
  endOfDay.setUTCHours(23, 59, 59, 999);
  const dueSoonAt = new Date(current.getTime() + 15 * 60 * 1000);
  const open = callbacks.filter((callback) => callback && !['completed', 'rescheduled', 'cancelled'].includes(callback.status));
  return {
    upcoming: open.filter((callback) => new Date(callback.dueAt) >= current && new Date(callback.dueAt) <= endOfDay),
    dueSoon: open.filter((callback) => new Date(callback.dueAt) >= current && new Date(callback.dueAt) <= dueSoonAt),
    overdue: open.filter((callback) => new Date(callback.dueAt) < current),
    exceptions: open.filter((callback) => !callback.owner || ['escalated', 'overdue'].includes(callback.status)),
  };
}

export function findDueCallbacks(callbacks = [], now = new Date()) {
  const current = new Date(now);
  return callbacks.filter((callback) => callback && callback.status === 'scheduled' && new Date(callback.dueAt) <= current);
}

export function sendReminderForCallback(callback) {
  if (!callback || !callback.id) {
    throw new Error('A valid callback is required to send a reminder.');
  }

  if (callback.reminderSentAt) {
    return {
      callbackId: callback.id,
      status: 'already_reminded',
      channel: 'sms',
      reminderSentAt: callback.reminderSentAt,
    };
  }

  const sentAt = new Date().toISOString();
  return {
    callbackId: callback.id,
    status: 'reminder_sent',
    channel: 'sms',
    reminderSentAt: sentAt,
    to: callback.phone || null,
    owner: callback.owner || null,
  };
}

export function createCallbackStore() {
  const callbacks = new Map();
  const byIdempotencyKey = new Map();

  return {
    create(input) {
      const callback = scheduleCallback(input);
      callbacks.set(callback.id, callback);
      return callback;
    },
    createOnce(input) {
      const key = String(input?.idempotencyKey || '').trim();
      if (key && byIdempotencyKey.has(key)) return { callback: callbacks.get(byIdempotencyKey.get(key)), replayed: true };
      const callback = this.create(input);
      if (key) byIdempotencyKey.set(key, callback.id);
      return { callback, replayed: false };
    },
    get(id) {
      return callbacks.get(id) || null;
    },
    list() {
      return [...callbacks.values()];
    },
    listScheduled() {
      return buildCallbackQueue([...callbacks.values()]);
    },
    listDue(now = new Date()) {
      return findDueCallbacks([...callbacks.values()], now);
    },
    listByOwner(owner) {
      const ownerKey = String(owner || '').trim();
      return [...callbacks.values()].filter((callback) => callback.owner === ownerKey);
    },
    assign(id, owner) {
      const callback = callbacks.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const updated = { ...callback, owner: owner ?? callback.owner, updatedAt: new Date().toISOString() };
      callbacks.set(id, updated);
      return updated;
    },
    sendReminder(id) {
      const callback = callbacks.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const reminder = sendReminderForCallback(callback);
      if (reminder.status === 'reminder_sent') {
        const updated = { ...callback, reminderSentAt: reminder.reminderSentAt, updatedAt: new Date().toISOString() };
        callbacks.set(id, updated);
        return { ...reminder, callback: updated };
      }
      return { ...reminder, callback };
    },
    complete(id, outcome) {
      const callback = callbacks.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const normalizedOutcome = String(outcome ?? '').trim();
      const updated = updateCallbackStatus({ ...callback, outcome: normalizedOutcome, completedAt: new Date().toISOString(), completedBy: callback.owner }, 'completed');
      callbacks.set(id, updated);
      return updated;
    },
    reschedule(id, input) {
      const callback = callbacks.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const result = rescheduleCallback(callback, input);
      callbacks.set(result.previous.id, result.previous);
      callbacks.set(result.replacement.id, result.replacement);
      return result;
    },
    updateStatus(id, nextStatus) {
      const callback = callbacks.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const updated = updateCallbackStatus(callback, nextStatus);
      callbacks.set(id, updated);
      return updated;
    },
  };
}

export function createPersistedCallbackStore({ pool, table = 'callback_records' } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A pg-like pool is required to create a persisted callback store.');
  }

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        phone TEXT,
        due_at TIMESTAMPTZ NOT NULL,
        owner TEXT,
        reason TEXT,
        source TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        reminder_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  }

  return {
    async create(input) {
      await migrate();
      const callback = scheduleCallback(input);
      await pool.query(
        `INSERT INTO ${table} (id, callback_number, contact_id, phone, due_at, timezone, owner, reason, source, status, outcome, reminder_sent_at, rescheduled_to_callback_id, rescheduled_from_callback_id, completed_at, completed_by, created_at, updated_at, payload, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          callback.id,
          callback.callbackNumber,
          callback.contactId,
          callback.phone,
          callback.dueAt,
          callback.timezone,
          callback.owner,
          callback.reason,
          callback.source,
          callback.status,
          callback.outcome ?? null,
          callback.reminderSentAt ?? null,
          callback.rescheduledToCallbackId ?? null,
          callback.rescheduledFromCallbackId ?? null,
          callback.completedAt ?? null,
          callback.completedBy ?? null,
          callback.createdAt,
          callback.updatedAt ?? callback.createdAt,
          JSON.stringify({ ...callback }),
          callback.idempotencyKey,
        ]
      );
      return callback;
    },
    async createOnce(input) {
      const key = String(input?.idempotencyKey || '').trim();
      if (key) {
        const found = await pool.query(`SELECT id FROM ${table} WHERE idempotency_key = $1`, [key]);
        if (found.rows[0]?.id) return { callback: await this.get(found.rows[0].id), replayed: true };
      }
      try {
        return { callback: await this.create(input), replayed: false };
      } catch (error) {
        if (!key || error?.code !== '23505') throw error;
        const found = await pool.query(`SELECT id FROM ${table} WHERE idempotency_key = $1`, [key]);
        if (!found.rows[0]?.id) throw error;
        return { callback: await this.get(found.rows[0].id), replayed: true };
      }
    },
    async get(id) {
      await migrate();
      const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        callbackNumber: row.callback_number,
        contactId: row.contact_id,
        phone: row.phone,
        dueAt: row.due_at,
        timezone: row.timezone,
        owner: row.owner,
        reason: row.reason,
        source: row.source,
        status: row.status,
        outcome: row.outcome,
        reminderSentAt: row.reminder_sent_at,
        rescheduledToCallbackId: row.rescheduled_to_callback_id || null,
        rescheduledFromCallbackId: row.rescheduled_from_callback_id || null,
        completedAt: row.completed_at || null,
        completedBy: row.completed_by || null,
        crmId: row.crm_id || null,
        crmMeetingId: row.crm_meeting_id || null,
        idempotencyKey: row.idempotency_key || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    async list() {
      await migrate();
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY due_at ASC`);
      return result.rows.map((row) => ({
        id: row.id,
        callbackNumber: row.callback_number,
        contactId: row.contact_id,
        phone: row.phone,
        dueAt: row.due_at,
        timezone: row.timezone,
        owner: row.owner,
        reason: row.reason,
        source: row.source,
        status: row.status,
        outcome: row.outcome,
        reminderSentAt: row.reminder_sent_at,
        rescheduledToCallbackId: row.rescheduled_to_callback_id || null,
        rescheduledFromCallbackId: row.rescheduled_from_callback_id || null,
        completedAt: row.completed_at || null,
        completedBy: row.completed_by || null,
        crmId: row.crm_id || null,
        crmMeetingId: row.crm_meeting_id || null,
        idempotencyKey: row.idempotency_key || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    async listByOwner(owner) {
      await migrate();
      const value = String(owner || '').trim();
      const result = await pool.query(`SELECT * FROM ${table} WHERE owner = $1 ORDER BY due_at ASC`, [value]);
      return result.rows.map((row) => ({
        id: row.id,
        callbackNumber: row.callback_number,
        contactId: row.contact_id,
        phone: row.phone,
        dueAt: row.due_at,
        timezone: row.timezone,
        owner: row.owner,
        reason: row.reason,
        source: row.source,
        status: row.status,
        outcome: row.outcome,
        reminderSentAt: row.reminder_sent_at,
        rescheduledToCallbackId: row.rescheduled_to_callback_id || null,
        rescheduledFromCallbackId: row.rescheduled_from_callback_id || null,
        completedAt: row.completed_at || null,
        completedBy: row.completed_by || null,
        crmId: row.crm_id || null,
        crmMeetingId: row.crm_meeting_id || null,
        idempotencyKey: row.idempotency_key || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    async listScheduled() {
      const rows = await this.list();
      return buildCallbackQueue(rows);
    },
    async listDue(now = new Date()) {
      const rows = await this.list();
      return findDueCallbacks(rows, now);
    },
    async assign(id, owner) {
      await migrate();
      const existing = await this.get(id);
      if (!existing) throw new Error(`Callback ${id} was not found.`);
      const updated = { ...existing, owner: owner ?? existing.owner, updatedAt: new Date().toISOString() };
      await pool.query(
        `UPDATE ${table} SET owner = $2, updated_at = $3 WHERE id = $1`,
        [id, updated.owner, updated.updatedAt]
      );
      return updated;
    },
    async setCrmId(id, crmId) {
      await migrate();
      const existing = await this.get(id);
      if (!existing) throw new Error(`Callback ${id} was not found.`);
      const value = String(crmId || '').trim();
      if (!value) throw new Error('A CRM callback ID is required.');
      const updated = { ...existing, crmId: value, updatedAt: new Date().toISOString() };
      await pool.query(
        `UPDATE ${table} SET crm_id = $2, updated_at = $3 WHERE id = $1`,
        [id, updated.crmId, updated.updatedAt]
      );
      return updated;
    },
    async setMeetingId(id, meetingId) {
      await migrate();
      const existing = await this.get(id);
      if (!existing) throw new Error(`Callback ${id} was not found.`);
      const value = String(meetingId || '').trim();
      if (!value) throw new Error('A CRM meeting ID is required.');
      const updated = { ...existing, crmMeetingId: value, updatedAt: new Date().toISOString() };
      await pool.query(
        `UPDATE ${table} SET crm_meeting_id = $2, updated_at = $3 WHERE id = $1`,
        [id, updated.crmMeetingId, updated.updatedAt]
      );
      return updated;
    },
    async sendReminder(id) {
      await migrate();
      const callback = await this.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const reminder = sendReminderForCallback(callback);
      if (reminder.status === 'reminder_sent') {
        const updated = { ...callback, reminderSentAt: reminder.reminderSentAt, updatedAt: new Date().toISOString() };
        await pool.query(
          `UPDATE ${table} SET reminder_sent_at = $2, updated_at = $3 WHERE id = $1`,
          [id, updated.reminderSentAt, updated.updatedAt]
        );
        return { ...reminder, callback: updated };
      }
      return { ...reminder, callback };
    },
    async complete(id, outcome) {
      await migrate();
      const callback = await this.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const normalizedOutcome = String(outcome ?? '').trim();
      const updated = updateCallbackStatus({ ...callback, outcome: normalizedOutcome, completedAt: new Date().toISOString(), completedBy: callback.owner }, 'completed');
      await pool.query(
        `UPDATE ${table} SET status = $2, outcome = $3, completed_at = $4, completed_by = $5, updated_at = $6 WHERE id = $1`,
        [id, updated.status, updated.outcome, updated.completedAt, updated.completedBy, updated.updatedAt]
      );
      return updated;
    },
    async reschedule(id, input) {
      await migrate();
      const callback = await this.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const result = rescheduleCallback(callback, input);
      await pool.query(
        `UPDATE ${table} SET status = $2, rescheduled_to_callback_id = $3, updated_at = $4 WHERE id = $1`,
        [id, result.previous.status, result.previous.rescheduledToCallbackId, result.previous.updatedAt]
      );
      const replacement = result.replacement;
      await pool.query(
        `INSERT INTO ${table} (id, callback_number, contact_id, phone, due_at, timezone, owner, reason, source, status, rescheduled_from_callback_id, created_at, updated_at, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [replacement.id, replacement.callbackNumber, replacement.contactId, replacement.phone, replacement.dueAt, replacement.timezone, replacement.owner, replacement.reason, replacement.source, replacement.status, replacement.rescheduledFromCallbackId, replacement.createdAt, replacement.updatedAt ?? replacement.createdAt, JSON.stringify(replacement)]
      );
      return result;
    },
    async updateStatus(id, nextStatus) {
      await migrate();
      const callback = await this.get(id);
      if (!callback) throw new Error(`Callback ${id} was not found.`);
      const updated = updateCallbackStatus(callback, nextStatus);
      await pool.query(
        `UPDATE ${table} SET status = $2, updated_at = $3 WHERE id = $1`,
        [id, updated.status, updated.updatedAt]
      );
      return updated;
    },
  };
}
