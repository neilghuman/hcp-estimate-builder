# feature/drip-s9-sequence-builder

## Context
Gap reported: the dashboard could edit the two seeded LSA sequences but had no way to **create a new
sequence** (e.g. a Thumbtack drip) or add steps to it. S9 adds sequence + step creation. Gated behind
`DRIP_CONFIG_EDIT_ENABLED`.

## Adds
- **Create sequence**: `validateSequenceCreate` (key snake-case + unique, name, source ∈
  {thumbtack, google_lsa, any}, optional vertical) + `createSequence` (seeded **inactive**; optional
  settings via `validateSequenceSettings`; time columns cast `::time`). Route `POST /api/drip/sequence`
  (422 invalid / 409 duplicate key).
- **Add step**: `addStep` (unique (sequence_id, step_index); optionally seeds a default variant-A
  message so the step is immediately sendable). Route `POST /api/drip/step` (422 invalid / 404 no seq
  / 409 duplicate step).
- **Delete step**: `deleteStep` (cascades its messages). Route `DELETE /api/drip/step/:id`.

## Frontend (`public/followup.*`)
- "＋ New sequence" button + inline form (key / name / source / vertical / max / quiet hours / expiry /
  strategy) — creates the sequence inactive with a note that it needs steps + an n8n enroll hook.
- Per-sequence "＋ Step" button → inline form (step #, offset, default body, opt-out).
- Per-step 🗑 delete.

## Tests / verification
- `node --test` -> 210 (added `validateSequenceCreate`).
- Dev: created a `thumbtack` sequence (inactive) + steps 0 and 1 with default copy, duplicate-step 409,
  then cleaned up; UI (new-sequence + add-step forms, add/delete buttons) verified.

## Note
New sequences start inactive and empty. To actually enroll leads into a new source (e.g. Thumbtack),
n8n needs an enroll hook for that source — same pattern as the LSA wiring.
