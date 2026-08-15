# feature/drip-s8-variant-analytics

## Context
S8 of the lead follow-up drip: make A/B variants measurable and let staff add category-specific
copy groups to a step. Editing stays gated behind `DRIP_CONFIG_EDIT_ENABLED`.

## Adds
- **Per-variant send analytics**: migration `028_drip_delivery_variant.sql` adds `message_id` +
  `variant` to `drip_delivery_log` (nullable/idempotent). `claimStep` now records the chosen
  message id + variant; `resolveMessageFor` selects `m.id`. New `dripVariantStats` (sent counts per
  sequence/step/variant) folded into `GET /api/drip/report` as `variantStats`. UI shows a per-message
  "sent N" badge so weighted A/B is observable.
- **Add category-specific copy**: a "＋ Category copy" button per step opens an editor with a
  category input (datalist of known taxonomy keys), variant (default A), body, opt-out, and weight.
  Reuses `POST /api/drip/message` with a `categoryKey`.
- **Delete guard refined**: `deleteMessage` now only protects a step's last **default** (category-less)
  message. Category-specific overrides can be fully removed (falls back to default copy).

## Tests / verification
- `node --test` -> 209 (sweep test now asserts the variant is recorded on the delivery-log claim).
- Dev: migration 028 applied; `variantStats` present; category-copy add; category override now
  deletable while the last default is still 409; UI (14 add-category buttons, category editor with
  datalist + default variant) verified.

## Notes
Historical delivery-log rows have NULL variant and are excluded from `variantStats`. Per-variant
counts populate as new sends happen in prod.
