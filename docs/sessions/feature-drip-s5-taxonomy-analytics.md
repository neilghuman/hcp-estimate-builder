# feature/drip-s5-taxonomy-analytics

## Context
S5 of the lead follow-up drip: taxonomy management, step-timing edits, and per-step delivery
analytics on the Follow-up dashboard. Editing remains gated behind `DRIP_CONFIG_EDIT_ENABLED`.

## Adds
- **Taxonomy manager**: add / remove `drip_category_map` rows (raw platform value → canonical
  category_key), so category-specific copy fires for new lead categories.
  - Pure `validateCategoryMap` in `src/drip.js` (normalizes case/whitespace; enforces snake-case key
    and source ∈ {thumbtack, google_lsa, any}).
  - `addCategoryMap` (upsert on (source, raw_value)), `deleteCategoryMap`.
  - Routes (gated): `POST /api/drip/taxonomy` (422 on invalid), `DELETE /api/drip/taxonomy/:id`.
  - `getSequencesDetailed` taxonomy now includes `id`.
- **Step timing edits**: `updateStep` (offset_minutes clamped ≥0, is_active); route
  `PUT /api/drip/step/:id` (gated, 422 on negative offset). Inline "⏱ Timing" editor per step.
- **Per-step analytics**: `dripStepStats` (sent counts per sequence/step from `drip_delivery_log`
  joined to enrollments); folded into `GET /api/drip/report` as `stepStats`. Shown as a "sent N"
  badge on each step header.

## Frontend (`public/followup.*`)
- Taxonomy table gains delete buttons + an add-mapping form (key / source / raw value).
- Each step header shows the sent count and (when editing) a Timing editor (offset + active).

## Tests / verification
- `node --test` -> 206 (added `validateCategoryMap` cases).
- Dev: taxonomy add(normalized)/422/delete, step edit(+restore), and UI controls
  (14 timing buttons, 12 delete buttons, add form, step editor) all verified.

## Next (S6, optional)
Message variant add + weights (A/B), sequence field edits (max/quiet-hours), richer analytics
(response/opt-out rates, time-to-reply).
