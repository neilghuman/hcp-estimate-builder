# feature/drip-s6-variants-analytics

## Context
S6 of the lead follow-up drip: message A/B variants, sequence-level settings edits, and outcome
analytics on the Follow-up dashboard. Editing stays gated behind `DRIP_CONFIG_EDIT_ENABLED`.

## Adds
- **Message variants + weights**: add a variant to a step/category group and set its weight
  (feeds `variant_strategy` random | round_robin | weighted_ab).
  - `addMessage` (enforces (step, category, variant) uniqueness → 409 on dupe), `deleteMessage`
    (refuses the last message in a group → 409), `updateMessage` now also edits `weight`.
  - Pure `validateVariant` (1–20 [A-Za-z0-9_-]).
  - Routes (gated): `POST /api/drip/message` (422 invalid / 409 dupe), `DELETE /api/drip/message/:id`.
- **Sequence settings**: edit max_messages, quiet hours, expiry, variant strategy.
  - Pure `validateSequenceSettings` (ranges, HH:MM, start<end, strategy enum). `updateSequence`
    (partial). `PUT /api/drip/sequence/:id` now handles both the active toggle and settings.
- **Outcome analytics**: `dripOutcomes` (enrolled / replied + reply-rate / completed / active /
  handled / dropped / avg touches→reply) folded into `GET /api/drip/report`.

## Frontend (`public/followup.*`)
- New "Outcomes" panel of tiles.
- Each message shows its weight and gains ＋ Variant / 🗑 delete; the editor gains a weight field
  and a shared markup path for edit + add (variant field on add).
- Each sequence gains a ⚙ Settings editor (max / quiet hours / expiry / strategy).

## Tests / verification
- `node --test` -> 209 (added validateVariant + validateSequenceSettings cases).
- Dev: add-variant / 409 dupe / weight edit (no version bump) / delete / last-in-group 409;
  sequence settings update + 422 order guard + active-toggle coexistence; UI controls + editors verified.

## Notes
Weight edits don't bump the message version (only body changes are versioned). The active toggle and
settings share `PUT /api/drip/sequence/:id` (isActive-only → toggle; otherwise validated settings).
