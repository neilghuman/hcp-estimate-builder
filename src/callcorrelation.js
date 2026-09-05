// Pure logic for correlating a 3CX call event to a callback and shaping the
// EspoCRM Call activity. No side effects.

const DIRECTION_MAP = { inbound: 'Inbound', outbound: 'Outbound' };

// EspoCRM Call.status: a finished call is Held; a missed/no-answer/failed is Not Held.
export function callStatusToEspo(callStatus) {
  return ['answered', 'voicemail'].includes(String(callStatus || '').toLowerCase()) ? 'Held' : 'Not Held';
}

export function callDirectionToEspo(direction) {
  return DIRECTION_MAP[String(direction || '').toLowerCase()] || 'Outbound';
}

// Build the EspoCRM Call payload for a call event correlated to a callback.
export function buildCallActivity(callEvent, callback, { assignedUserId = null } = {}) {
  const name = `Callback call: ${callback.owner || 'agent'} \u2194 ${callback.phone || callEvent.normalized_phone || 'customer'}`;
  const description = [
    callback.callbackNumber ? `Callback ${callback.callbackNumber}` : null,
    callEvent.call_status ? `3CX status: ${callEvent.call_status}` : null,
    callEvent.recording_url ? `Recording: ${callEvent.recording_url}` : null,
    callEvent.voicemail_url ? `Voicemail: ${callEvent.voicemail_url}` : null,
    callEvent.transcription ? `Transcript: ${String(callEvent.transcription).slice(0, 900)}` : null,
  ].filter(Boolean).join('\n');
  return {
    name,
    status: callStatusToEspo(callEvent.call_status),
    direction: callDirectionToEspo(callEvent.direction),
    dateStart: callEvent.call_started_at,
    dateEnd: callEvent.ended_at,
    duration: Number(callEvent.talk_duration || callEvent.total_duration || 0) || 0,
    parentType: callback.contactId ? 'Contact' : null,
    parentId: callback.contactId || null,
    callbackId: callback.crmId || null,
    assignedUserId,
    description,
  };
}

// Given open/recent callbacks and the call events for each phone, produce the
// (callback, callEvent) pairs eligible to become Call activities. A call is
// eligible when it started at/after the callback was scheduled.
export function selectCallLinks(callback, callEvents = []) {
  const created = new Date(callback.createdAt || callback.dueAt).getTime();
  return callEvents
    .filter((ev) => ev && ev.threecx_call_id && !Number.isNaN(new Date(ev.call_started_at).getTime())
      && new Date(ev.call_started_at).getTime() >= created)
    .map((ev) => ({ callback, callEvent: ev }));
}
