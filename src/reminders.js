// Pure logic for employee-facing callback reminders. Delivery + persistence are
// wired in server.js; these helpers are side-effect free so they are easy to test.

const OPEN_STATUSES = new Set(['scheduled', 'due_soon', 'overdue', 'escalated']);

// Parse the Chatwoot conversation id from a callback source like
// "chatwoot:conversation:60". Returns null when the source is not a conversation.
export function conversationIdFromSource(source) {
  const match = /^chatwoot:conversation:(\d+)$/.exec(String(source || '').trim());
  return match ? match[1] : null;
}

// Select callbacks that are due within the lead time, still open, not yet reminded,
// and tied to a Chatwoot conversation we can notify on. Sorted by soonest due.
export function selectDueReminders(callbacks = [], now = new Date(), leadTimeMs = 15 * 60 * 1000) {
  const current = new Date(now).getTime();
  const threshold = current + Math.max(0, Number(leadTimeMs) || 0);
  return callbacks
    .filter((callback) => callback
      && OPEN_STATUSES.has(callback.status)
      && !callback.reminderSentAt
      && conversationIdFromSource(callback.source)
      && !Number.isNaN(new Date(callback.dueAt).getTime())
      && new Date(callback.dueAt).getTime() <= threshold)
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

// Build the internal note text for a due callback.
export function buildReminderNote(callback, { timeZone = 'America/Los_Angeles' } = {}) {
  const customer = String(callback.customerName || callback.phone || 'the customer').trim();
  let dueLabel = String(callback.dueAt || '');
  try {
    dueLabel = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(callback.dueAt));
  } catch { /* keep raw dueAt */ }
  const parts = [
    `\u23F0 Callback due ${dueLabel} (Pacific) for ${customer}.`,
    callback.owner ? `Owner: ${callback.owner}.` : null,
    callback.reason ? `Reason: ${callback.reason}.` : null,
    callback.callbackNumber ? `[${callback.callbackNumber}]` : null,
  ];
  return parts.filter(Boolean).join(' ');
}
