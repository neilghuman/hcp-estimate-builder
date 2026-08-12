# Chat Foundry — Sprint 6: Durable bulk sender

Branch: `feature/chat-foundry-s6-bulk-sender`

## Request
"yes and yes" — merge #15 (Sprint 5) and proceed to Sprint 6: the durable bulk sender. Batching,
rate limiting, retry/backoff, pause/resume/cancel, restart recovery, and a live progress dashboard.

## Design
A DB-backed queue over `chat_campaign_recipients.status`:
`pending → sending → sent | failed | skipped`.
- **Atomic claiming**: batches are claimed with `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)`
  so concurrent/duplicate runners can never grab the same recipient.
- **Rate limiting**: one message at a time, spaced by `60000 / CHAT_FOUNDRY_MESSAGES_PER_MINUTE`.
- **Retry/backoff**: up to `CHAT_FOUNDRY_MAX_RETRIES` with linear backoff on `CHAT_FOUNDRY_RETRY_DELAY`.
- **Idempotency**: a row with a `chatwoot_message_id` is never re-sent; successful sends stamp the id.
- **Per-recipient recheck** at send time (allowlisted inbox + contact channel) — anything ineligible
  is skipped, not sent.
- **Pause / resume / cancel** honored between messages; claimed-but-unsent rows are returned to
  `pending` so resume continues cleanly.
- **Restart recovery**: on boot, any recipient stuck in `sending` is **quarantined** (`failed` with
  a "verify before resending" note) so a customer is never double-texted after a crash, and the
  interrupted campaign is moved to `paused` for operator review.

The runner is fire-and-forget (single-instance app); the database is the source of truth. Starting
or resuming re-runs the full send gate (`CHAT_FOUNDRY_SEND_ENABLED` + typed `SEND N MESSAGES` +
checkbox + max size).

## Files
- `src/cf_sender.js` — the runner + control registry. Pure helpers `sendConfig`,
  `perMessageDelayMs`, `computeProgress`, `isRunning`; operations `startCampaign` (start/resume),
  `pauseCampaign`, `cancelCampaign`, `progress`, `recoverInterrupted`.
- `src/chatfoundry.js` — routes `POST /campaigns/:id/{send,resume,pause,cancel}` and
  `GET /campaigns/:id/progress`; campaign detail now returns `sendConfirmPhrase`, `pendingEligible`,
  and `running`.
- `server.js` — calls `recoverInterrupted(pool)` on startup.
- `public/chatfoundry.{html,js,css}` — bulk-send panel (typed phrase + checkbox), start/resume/
  pause/cancel controls, and a live progress bar that polls every 2s.
- `test/chatfoundry.test.js` — S6 pure tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/chat-foundry/campaigns/:id/send` | start bulk send (full gate) |
| POST | `/api/chat-foundry/campaigns/:id/resume` | resume a paused campaign |
| POST | `/api/chat-foundry/campaigns/:id/pause` | pause between messages |
| POST | `/api/chat-foundry/campaigns/:id/cancel` | stop unsent recipients |
| GET | `/api/chat-foundry/campaigns/:id/progress` | live counts + percent |

Rate/retry knobs (already in `.env.example` from S5): `CHAT_FOUNDRY_BATCH_SIZE`,
`CHAT_FOUNDRY_MESSAGES_PER_MINUTE`, `CHAT_FOUNDRY_MAX_RETRIES`, `CHAT_FOUNDRY_RETRY_DELAY`.

## Validation
- `npm test` → **34/34 pass** (S1–S5 + new S6: `sendConfig` defaults/overrides, `perMessageDelayMs`
  rate mapping incl. divide-by-zero guard, `computeProgress`, `isRunning`).
- Live check vs real Postgres (throwaway script, not committed) that exercised the **entire runner
  with zero real messages** by seeding recipients whose inbox is not allowlisted (so the send-time
  recheck skips every one before any Chatwoot call):
  - bulk send blocked while disabled and on a wrong phrase;
  - runner claimed all 3, skipped all 3, completed at 100%, **0 sent**;
  - restart recovery quarantined a simulated mid-send recipient (→ `failed`, never resent) and moved
    the campaign to `paused`.
- A real multi-recipient delivery is intentionally left to an operator run once an inbox is
  allowlisted and `CHAT_FOUNDRY_SEND_ENABLED=true`.

## Next
- S7: campaign history, recipient drill-down, CSV export, and an audit view.
