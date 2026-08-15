# feature/drip-s4-editing

## Context
S4 of the lead follow-up drip: **gated editing** on the Follow-up dashboard. Staff can edit message
copy, toggle sequence activation, and pause all sends — with validation, versioning, and a runtime
kill switch. Read-only behaviour is unchanged when editing is off.

## Gating
- New env flag `DRIP_CONFIG_EDIT_ENABLED` (default **false**) — exposed as `config.editEnabled`.
- All write routes require it (403 otherwise). Enabled in `docker-compose.dev.yml` for testing;
  left OFF on prod until deliberately turned on. (Design: all staff can edit — guardrails, not approval.)

## Backend
- Migration `027_drip_setting.sql` — `drip_setting(key,value,...)` seeded `paused=false` (runtime kill switch).
- Pure helpers in `src/drip.js` (unit tested): `smsSegments` (GSM-7/UCS-2 segment estimate) and
  `validateMessage` (empty=error, opt-out flag without "STOP"=error, STOP-without-flag/long/unknown-placeholder=warn).
- `src/drip_runtime.js`: `updateMessage` (body change is versioned — prior body copied to
  `drip_message_history`, `version` bumped; flag-only edits don't bump), `getMessageHistory`,
  `setSequenceActive`, `isDripPaused`/`setDripPaused`. `nestSequences`/`getSequencesDetailed` now
  include message `id` + `version`.
- Routes (`src/drip_routes.js`, gated): `PUT /api/drip/message/:id` (server-side validation blocks
  hard errors → 422), `GET /api/drip/message/:id/history`, `PUT /api/drip/sequence/:id`,
  `GET/PUT /api/drip/pause`.
- `sweepOnce` no-ops (`{action:'paused'}`) on a real run while globally paused.

## Frontend (`public/followup.*`)
- Status chips gain Editing + Sends(running/PAUSED). Edit toolbar: "Editing as" (persisted) + Pause/Resume.
- Per message: version badge + Edit → inline editor with body textarea, opt-out/active toggles, live
  SMS-segment counter, live validation (Save disabled on errors), and sample-value preview (uses the
  message's own category for `{service}`).
- Per sequence: Activate/Deactivate button.
- CSS uses portal theme tokens (light/dark safe).

## Tests / verification
- `node --test` -> 204 (added smsSegments, validateMessage, and paused-sweep tests).
- Dev: migration 027 applied; edit/version/history/422, sequence toggle, and pause verified via API;
  editor + live preview/segments/validation verified in the browser.

## Next (S5)
Taxonomy manager (add/remove category maps), variants add/weights, step timing edits, per-step
delivery analytics.
