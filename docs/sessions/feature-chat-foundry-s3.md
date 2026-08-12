# Chat Foundry — Sprint 3: Message Library

Branch: `feature/chat-foundry-s3-message-library`

## Request
"merge 12 and proceed with sprint 3." Sprint 3 = the message library: reusable message
templates with categories, tags, and immutable version history (CRUD + restore), wired into the
existing Chat Foundry console.

## Scope (this PR)
- **Templates model + version history.** Prior bodies are never overwritten — every body change
  appends a row to a versions table, and "restore" re-appends the old body as a *new* version.
- **CRUD**: create, edit, duplicate, archive/restore (soft), hard delete (guarded by `?confirm=true`).
- **Console UI**: a Message Library card with search / category / show-archived filters, an inline
  editor (name, category, description, tags, body + live char count, change note, approved flag),
  and a version-history panel with per-version restore.

Send/campaign features remain out of scope (Sprints 5–7). This sprint is content authoring only —
nothing here can message a customer.

## Decisions carried forward
- Auth = Option B (RBAC deferred). Template routes are plain authoring endpoints behind the app's
  existing optional Basic Auth; the send-side confirmation/flag/audit gating lands with sends in S5+.
  `actor(req)` records the Basic Auth username (or `operator`) on `created_by` / `updated_by` so an
  audit trail exists from day one and RBAC can attach later without a schema change.
- Raw SQL over the shared `pg` pool (matches `pricebook.js`); no ORM. Auto-applied migration.
- Pure helpers (`validateTemplateInput`, `sanitizeTags`) kept side-effect free for unit testing.

## Files
- `migrations/012_chat_foundry_templates.sql` — `chat_message_templates` +
  `chat_message_template_versions` (FK CASCADE, `UNIQUE(template_id, version_number)`) + indexes.
- `src/cf_templates.js` — categories, pure validators, and the CRUD/version data layer.
- `src/chatfoundry.js` — `actor()` helper; `registerChatFoundryRoutes(app, pool)` now takes the
  pool and exposes the template routes (list/create/get/update/duplicate/archive/restore/delete,
  versions list + restore).
- `public/chatfoundry.html` / `.js` / `.css` — Message Library section, editor, and version panel.
- `test/chatfoundry.test.js` — added S3 pure-logic tests.

## API
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/chat-foundry/templates` | `?search=&category=&tag=&includeArchived=` |
| POST | `/api/chat-foundry/templates` | create |
| GET | `/api/chat-foundry/templates/:id` | includes `versions` |
| PUT | `/api/chat-foundry/templates/:id` | bumps version only when body changes |
| POST | `/api/chat-foundry/templates/:id/duplicate` | |
| POST | `/api/chat-foundry/templates/:id/archive` \| `/restore` | soft archive |
| DELETE | `/api/chat-foundry/templates/:id?confirm=true` | hard delete (confirm required) |
| GET | `/api/chat-foundry/templates/:id/versions` | |
| POST | `/api/chat-foundry/templates/:id/versions/:versionId/restore` | appends restored body as a new version |

## Validation
- `npm test` — 15/15 pass (S1 + S2 + new S3 pure tests: `sanitizeTags`, `validateTemplateInput`).
- Migration 012 applied cleanly against the live Postgres (`scopefoundry`) on server boot.
- Live DB smoke check (throwaway script, not committed) exercised the full data layer end to end:
  create→v1, body edit→v2, name-only edit stays v2, restore v1 appends v3 with the old body,
  duplicate, archive hides by default / shows with `includeArchived`, unarchive, and
  category+search filtering. All passed; test rows cleaned up afterward.

## Next
- S4: editor placeholders + LLM rewrite (preview-only, never sends).
- S5: campaign model + typed confirmation + test send (first send-enabled path).
