# feature/drip-s3-dashboard

## Context
S3 of the lead follow-up drip: a **read-only** "Follow-up" dashboard in the Scope Foundry portal,
so staff can see the live sequences, their cadence + copy, the category taxonomy, and enrollment
status. Editing is deliberately deferred to S4.

## What it adds
- `GET /api/drip/sequences` — full config tree (sequences -> steps -> messages) + taxonomy, assembled
  by the pure helper `nestSequences` in `src/drip.js` (unit tested). Reader `getSequencesDetailed`
  in `src/drip_runtime.js`.
- `public/followup.{html,css,js}` — a standalone page (same pattern as Intake/Chat Foundry) showing:
  - System status chips (feature / enrollment writes / sending) from `/api/drip/config`.
  - Enrollments by status + exits by reason from `/api/drip/report`.
  - Sequences & cadence: each sequence's meta + every step with a humanized offset
    (initial send, +30 min, +2 hr, +5 hr, +1 day, +3 days, +6 days), default + category-override copy,
    opt-out markers, and inactive flags.
  - Active enrollments table from `/api/drip/enrollments?status=active`.
  - Category taxonomy table.
- Toolbar link "📣 Follow-up" added to Home + Intake.

## Read-only
No write endpoints. The page states editing is a later sprint.

## Tests / verification
- `node --test` -> 197/197 (added `nestSequences` nesting/sort test).
- Deployed to dev; `/api/drip/sequences` returns both sequences (7 steps each), page renders the full
  cadence + copy (verified via browser snapshot).

## Next (S4)
Gated editing: sequence/message editor with category-override tabs, live preview, SMS-segment count,
opt-out validation, versioning; taxonomy manager; global pause. All staff can edit (guardrails, not approval).
