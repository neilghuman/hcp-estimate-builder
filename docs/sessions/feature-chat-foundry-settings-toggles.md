# Chat Foundry — operator settings toggles

Branch: `feature/chat-foundry-settings-toggles`

## Request
Operator wanted to stop hand-editing `.env` + rebuilding to go live. Two controls, in the UI:
1. A **Live sending** switch (turn on/off) with a **confirmation modal** when arming.
2. **Per-inbox allowlist toggles** instead of editing `CHAT_FOUNDRY_ALLOWED_INBOX_IDS`.
Chosen model (confirmed): one combined switch (safe mode = sending off), DB-persisted.

## Design
- `CHAT_FOUNDRY_SEND_ENABLED` and `CHAT_FOUNDRY_ALLOWED_INBOX_IDS` remain the **defaults**. An
  operator toggle writes an **override** row to `chat_foundry_settings` (DB) which wins.
- A synchronous in-memory cache (`cf_settings.js`) is hydrated from the DB at startup, so the rest
  of the code (`inboxCapability`, `buildAudience`, the sender) keeps reading these values
  synchronously — no async ripple, no restart needed to apply a change.
- **Arming** live sending (ON) requires the exact phrase `ENABLE SENDING`, enforced **server-side**
  (defense in depth) and surfaced as a modal client-side. **Disabling** (OFF) is instant and never
  needs confirmation — moving toward "safer" is always allowed.
- Per-send safety is unchanged: even with sending armed, each send still needs an allowlisted inbox
  and the per-send typed confirmation. This switch only lifts the global Safe-mode lock.

## Files
- `migrations/016_chat_foundry_settings.sql` — `chat_foundry_settings (key, value jsonb, updated_by,
  updated_at)`.
- `src/cf_settings.js` — cache + pure helpers (`effectiveSendEnabled`, `effectiveAllowedInboxIds`,
  `nextInboxList`, `settingsView`, `SEND_CONFIRM_PHRASE`) + `loadSettings`, `setSendEnabled`,
  `setInboxAllowed`.
- `src/chatfoundry.js` — `sendEnabled()` / `allowedInboxIds()` now delegate to the cache; new routes
  `GET /settings`, `POST /settings/sending`, `POST /settings/inbox`.
- `server.js` — `loadSettings(pool)` on startup (logs the effective state).
- `public/chatfoundry.{html,js,css}` — Live-sending switch + confirm modal in the guide card;
  per-inbox "allow" checkboxes in the Inboxes table.
- `test/chatfoundry.test.js` — settings pure tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/chat-foundry/settings` | effective values + source (env/db) + confirm phrase |
| POST | `/api/chat-foundry/settings/sending` | `{ enabled, confirm }` — arming needs `ENABLE SENDING` |
| POST | `/api/chat-foundry/settings/inbox` | `{ inboxId, allowed }` — add/remove one inbox |

## Validation
- `npm test` → **70/70 pass** (incl. new: env fallback, `nextInboxList` math, arm-phrase rejection).
- Live check vs real Postgres (throwaway, not committed): migration 016 applied; arming rejected
  without the phrase (no state change); armed with the phrase (override persisted, source=db); inbox
  toggles add/remove correctly ([7] after add 4+7, remove 4); a fresh `loadSettings` reflected the
  overrides (persistence); then reset to Safe mode. Nothing was sent.
