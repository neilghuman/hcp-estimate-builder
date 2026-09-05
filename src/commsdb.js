import pg from 'pg';

// Read-only connection to the shared `comms` Postgres (call-sync's call_events).
// Lazily created; returns null when COMMS_DATABASE_URL is not configured.
let _pool = null;

export function commsConfigured() {
  return Boolean(process.env.COMMS_DATABASE_URL);
}

export function getCommsPool() {
  if (!commsConfigured()) return null;
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.COMMS_DATABASE_URL, max: 3, idleTimeoutMillis: 30_000 });
  }
  return _pool;
}

// Finalized 3CX calls to/from a phone at or after `sinceIso`. Only rows with an
// end time are returned so an in-progress call is never correlated prematurely.
export async function findCallEventsForPhone(phone, sinceIso, { limit = 25 } = {}) {
  const pool = getCommsPool();
  if (!pool) return [];
  const normalized = String(phone || '').trim();
  if (!normalized) return [];
  const { rows } = await pool.query(
    `SELECT threecx_call_id, normalized_phone, direction, call_status, extension, agent_name,
            call_started_at, answered_at, ended_at, talk_duration, total_duration,
            recording_url, voicemail_url, transcription
       FROM comms.call_events
      WHERE normalized_phone = $1 AND ended_at IS NOT NULL AND call_started_at >= $2
      ORDER BY call_started_at ASC
      LIMIT $3`,
    [normalized, sinceIso, limit]
  );
  return rows;
}
