# Chat Foundry — Sprint 4: Compose (placeholders) + AI rewrite

Branch: `feature/chat-foundry-s4-editor-rewrite`

## Request
"merge 13 and proceed with 14." PR #13 (Sprint 3, message library) merged; Sprint 4 = the compose
step: merge-field placeholders with per-recipient preview, and a local-LLM rewrite with
side-by-side accept/reject. Both are **preview-only** — nothing here can message a customer.

## Scope (this PR)
- **Placeholders / merge fields.** Supported fields (`{{first_name}}`, `{{full_name}}`,
  `{{phone_last4}}`, `{{email}}`, `{{agent}}`) derived from a normalized Chatwoot conversation. The
  compose preview renders a draft against a few real sample recipients and **blocks** any recipient
  whose placeholder can't be resolved, or the whole draft if it uses an unsupported field.
- **AI rewrite (Node → Ollama).** A separate operator action that suggests a rewrite in a chosen
  tone with an optional instruction. Side-by-side Current vs Suggested with Accept & replace /
  Reject. Placeholder tokens must be preserved; drift is detected and surfaced as a warning. Every
  suggestion is written to an audit table, and the accept/reject decision is written back.

## Non-negotiables honored
- **Preview, rewrite, and send are three separate actions/endpoints.** This sprint adds preview +
  rewrite only; neither posts anything to Chatwoot. Send lands in S5.
- Rewrite never mutates the draft on its own — the operator must click Accept.
- Audit-first: rewrite suggestions + decisions are logged (`chat_message_rewrites`).

## Files
- `migrations/013_chat_foundry_rewrites.sql` — `chat_message_rewrites` audit table (template_id is
  intentionally **not** a FK so rewrite history survives template deletion).
- `src/cf_compose.js` — pure placeholder engine: `PLACEHOLDER_FIELDS`, `extractPlaceholders`,
  `analyzeTemplate`, `buildRecipientContext`, `resolvePlaceholders`, `renderForRecipient`,
  `composePreview`.
- `src/cf_rewrite.js` — Ollama `/api/chat` client: `rewriteMessage`, `rewriteStatus`,
  `normalizeTone`, `placeholderTokens`; typed `RewriteError`, AbortController timeout.
- `src/chatfoundry.js` — routes: `GET /compose/fields`, `POST /compose/preview`, `POST /rewrite`,
  `POST /rewrite/:id/decision`.
- `public/chatfoundry.{html,js,css}` — Compose card: template picker, insert-field chips, body +
  live analysis, sample preview table, and the rewrite panel.
- `.env.example` — `CHAT_FOUNDRY_OLLAMA_BASE`, `CHAT_FOUNDRY_REWRITE_MODEL`,
  `CHAT_FOUNDRY_REWRITE_TIMEOUT_MS` (falls back to `OLLAMA_API_BASE`/`OLLAMA_MODEL`).
- `test/chatfoundry.test.js` — S4 pure tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/chat-foundry/compose/fields` | supported merge fields |
| POST | `/api/chat-foundry/compose/preview` | `{ body, status, inboxId, tags, sampleSize }` → static analysis + per-sample render + blocked counts. READ-ONLY. |
| POST | `/api/chat-foundry/rewrite` | `{ body, instruction, tone, templateId? }` → suggestion (logged, accepted=NULL). Never sends. |
| POST | `/api/chat-foundry/rewrite/:id/decision` | `{ accepted }` → records the operator decision |

## Validation
- `npm test` → **24/24 pass** (S1 + S2 + S3 + new S4 pure tests: placeholder extract/analyze,
  context derivation, resolve, render/block, composePreview, tone normalization, token drift).
- Live check against the real Postgres + local Ollama (throwaway script, not committed):
  migration 013 applied idempotently; rewrite audit insert + accept/reject decision verified;
  live `llama3.1:latest` rewrite returned a shortened message with `{{first_name}}` preserved.
- Note: the first rewrite after the model goes idle can be slow (cold load) and may exceed the
  default 45s timeout — retry once, or set `CHAT_FOUNDRY_REWRITE_TIMEOUT_MS` higher. Warm latency
  observed ~1s.

## Next
- S5: campaign model + typed confirmation ("SEND N MESSAGES") + TEST-mode single send (first
  send-enabled path), with a final per-recipient eligibility recheck.
