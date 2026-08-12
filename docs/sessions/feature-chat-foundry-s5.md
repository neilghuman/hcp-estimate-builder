# Chat Foundry — Sprint 5: Campaigns + gated TEST-mode single send

Branch: `feature/chat-foundry-s5-campaign-test-send`

## Request
"merge 14 and proceed to sprint 5." PR #14 (Sprint 4) merged; Sprint 5 introduces the **first
send-enabled path**: a campaign model, recipient materialization, a typed confirmation screen, and
a TEST-mode **single** send that verifies the outbound relay. The durable bulk sender is S6.

## Safety model (all gates must hold before any customer message goes out)
1. `CHAT_FOUNDRY_SEND_ENABLED=true` (env kill-switch, default **false**)
2. a typed confirmation phrase matching exactly — `SEND 1 MESSAGE` for a test send
3. an explicit confirmation checkbox
4. eligible count within `CHAT_FOUNDRY_MAX_CAMPAIGN_SIZE`
5. per-recipient eligibility re-check at send time (allowlisted inbox + contact channel)
6. idempotency — a recipient with a `chatwoot_message_id` is never re-sent
Every attempt, including blocked ones, is written to `chat_campaign_events`.

Create and materialize **never send**. Preview and rewrite remain entirely separate, non-sending
actions. This sprint sends at most one message per click.

## Files
- `migrations/014_chat_foundry_campaigns.sql` — `chat_campaigns`, `chat_campaign_recipients`
  (`UNIQUE(campaign_id, conversation_id)` = idempotency guard), `chat_campaign_events` (audit).
- `src/chatwoot.js` — `getConversation()` (pre-send recheck) and `sendMessage()` (the only call
  that produces a customer-facing message; posts `message_type: 'outgoing'`, returns the message id).
- `src/cf_campaigns.js` — pure gates (`confirmationPhrase`, `sendPreflight`, `recheckRecipient`) +
  data layer (`createCampaign`, `materializeRecipients`, `getCampaign`, `listCampaigns`) +
  `testSend()` (row-locked, gated, idempotent single send).
- `src/chatfoundry.js` — routes: `GET/POST /campaigns`, `GET /campaigns/:id`,
  `POST /campaigns/:id/materialize`, `POST /campaigns/:id/test-send`.
- `public/chatfoundry.{html,js,css}` — Campaign card: create, build recipient list, send-state
  badge, and a highlighted test-send panel (typed phrase + checkbox, button disabled until valid).
- `test/chatfoundry.test.js` — S5 pure gate tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/chat-foundry/campaigns` | list + send flag |
| POST | `/api/chat-foundry/campaigns` | create from body + filters (never sends) |
| GET | `/api/chat-foundry/campaigns/:id` | detail + recipient counts + sample + `testConfirmPhrase` |
| POST | `/api/chat-foundry/campaigns/:id/materialize` | build recipient list from Chatwoot (read-only) |
| POST | `/api/chat-foundry/campaigns/:id/test-send` | `{ conversationId?, confirmPhrase, confirmChecked }` — gated single send |

## Validation
- `npm test` → **30/30 pass** (S1–S4 + new S5: `confirmationPhrase`, `sendPreflight` across every
  gate combination, `recheckRecipient` idempotency/eligibility).
- Live check vs real Postgres + real Chatwoot (throwaway script, not committed) with sending
  disabled and the inbox allowlist empty: migration 014 applied; a campaign materialized **35 real
  conversations, all correctly skipped** ("inbox not allowlisted"); the test send was blocked at
  every gate (disabled flag, wrong phrase, no eligible recipient); audit recorded
  `created=1, materialized=1, send_blocked=3`. **Zero messages were sent.**
- Full live delivery (one real message) is intentionally deferred to an operator run once an inbox
  is added to `CHAT_FOUNDRY_ALLOWED_INBOX_IDS` and `CHAT_FOUNDRY_SEND_ENABLED=true`.

## Next
- S6: durable bulk sender — DB-backed queue over `recipients.status`, batching + rate limit +
  retry/backoff, pause/resume/cancel, restart recovery, live progress.
