# Customer Intake System — Sprint 7 (SMS notification via Chatwoot)

Branch: `feature/customer-intake-s7` (stacked on `feature/customer-intake-s6`; PR base = the S6 branch).

## Objective
Text the office (Neil) a summary of a new intake via the Chatwoot API (delivered by the existing n8n
Telnyx relay). Reuses the Chat Foundry Chatwoot config (owner-approved). Gated by the write flag.

## Config
- Reuses `CHAT_FOUNDRY_CHATWOOT_BASE_URL` / `_API_TOKEN` / `_ACCOUNT_ID`.
- `INTAKE_NOTIFY_NUMBERS` (default `2064581885` = Neil; Roman omitted for now), normalised to E.164.
- `INTAKE_NOTIFY_INBOX_ID` — the SMS-capable Chatwoot inbox to send from (required to actually send).

## Deliverables
- `src/chatwoot.js`: `ensureConversationForPhone(phone, {inboxId, name})` — find-or-create a contact +
  conversation, returning its id (reuses the existing `sendMessage`).
- `src/intake.js`: pure `notifyRecipients()` + `buildNotificationSms()`; gated
  `POST /api/intake/drafts/:id/notify` (dryRun preview / gate / confirm). Per-recipient results,
  partial-failure tolerant, records `notify_status` (sent|partial|failed) + `notify_error`.
  Also added `hcp_estimate_id` / `notify_status` / `notify_error` (and hcp URL columns) to
  `DRAFT_COLUMNS` so server-managed writes hit their real columns (fixes an S6 latent misroute).
- Intake tab: "Notify office (SMS)" card with a Chatwoot-ready badge, dry-run recipients + message
  preview, and a gated "Confirm & send SMS" (disabled unless writes on + Chatwoot + inbox configured).

## Testing performed
- `node --test`: 113/113 pass (5 new: recipients/E.164, SMS formatting; ensureConversationForPhone
  create-path, reuse-path, inbox-required).
- Dev container rebuilt; live vs `http://192.168.1.8:8123` (writes OFF, nothing sent): `/config` notify
  configured=true, recipients=1; notify dry-run returned the formatted SMS + recipient `+12064581885`;
  confirm -> **403 writes-disabled**.
- Real send not exercised (would create a Chatwoot contact/conversation + text Neil). To send: set
  `INTAKE_NOTIFY_INBOX_ID` to an SMS inbox and `INTAKE_WRITE_ENABLED=true`. The create-conversation
  path is covered by mocked unit tests and should get one live verification when first enabled.

## Not in scope (later sprints)
Submit orchestration + idempotency + error handling (S8), polish + reporting foundation (S9).
