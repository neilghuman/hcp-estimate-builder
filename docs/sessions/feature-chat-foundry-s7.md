# Chat Foundry — Sprint 7: History, drill-down, audit, CSV export

Branch: `feature/chat-foundry-s7-history-export`

## Request
"yes and yes" — merge #16 (Sprint 6) and proceed to Sprint 7, the final sprint: campaign history,
recipient drill-down, an audit view, and CSV export. All read-only — nothing here sends.

## Scope
- **Campaign history** — a list of all campaigns (status, eligible/sent/failed counts, created date)
  with an Open action to load any past campaign into the detail view.
- **Recipient drill-down** — the full recipient list per campaign, status-filtered and paginated
  (50/page), showing conversation, contact, masked phone, inbox, status, Chatwoot message id, sent
  time, and skip reason / error.
- **Audit log** — the append-only `chat_campaign_events` trail per campaign (create, materialize,
  send_started, test_send, send_blocked, error, paused, resumed, canceled, completed, recovered).
- **CSV export** — download the recipients of a campaign (optionally status-filtered) as CSV, with
  real phone numbers for reconciliation (operator tool behind Basic Auth).

## Files
- `src/cf_history.js` — read-only data layer + pure CSV helpers: `csvCell`, `recipientsToCsv`,
  `listRecipients` (paged/filtered, masked phone), `recipientsForExport` (real phone), `listEvents`.
- `src/chatfoundry.js` — routes: `GET /campaigns/:id/recipients`, `GET /campaigns/:id/events`,
  `GET /campaigns/:id/recipients.csv`.
- `public/chatfoundry.{html,js,css}` — history table, recipient drill-down (filter + pager + export),
  and an audit-log table; the roadmap card now reads as a "What's here" summary.
- `test/chatfoundry.test.js` — S7 pure CSV tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/chat-foundry/campaigns/:id/recipients` | `?status=&page=&perPage=` (masked phone) |
| GET | `/api/chat-foundry/campaigns/:id/events` | `?limit=` audit log |
| GET | `/api/chat-foundry/campaigns/:id/recipients.csv` | `?status=` CSV download (real phone) |

## Validation
- `npm test` → **37/37 pass** (S1–S6 + new S7 pure tests: `csvCell` quoting/escaping, `recipientsToCsv`
  header + escaped rows + empty case).
- Live check vs real Postgres (throwaway, not committed): seeded a campaign with 2 sent / 1 failed /
  2 skipped recipients; `listRecipients` paged (total 5, 3/page, phone masked) and status-filtered
  (sent → 2); `listEvents` returned the `created` event; CSV export produced 1 header + 5 rows and
  correctly quoted a comma inside a contact name. Read-only, zero messages sent.

## Sprint plan complete
S1 discovery · S2 audience preview · S3 message library · S4 compose + rewrite · S5 gated test send
· S6 durable bulk sender · **S7 history + export**. The full non-negotiable safety model holds
throughout: preview / rewrite / send are separate, explicitly-confirmed actions; sends are gated and
idempotent; nothing is ever sent on preview or rewrite.
