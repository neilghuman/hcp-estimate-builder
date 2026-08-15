# feature/drip-s2c-enroll-webhook

## Context
S2c hardens the drip enrollment/send path so it's production-ready (still gated; nothing sends).
Follows S2b (#14).

## What S2c adds
- **Send-failure handling fix** (`src/drip_sweep.js`): a failed send now exits the enrollment as
  `undeliverable` (+ removes the label) instead of leaving a claimed step that would `skip_claimed`
  forever. Matches the documented "permanent delivery failure stops" rule. (Retry-with-backoff is
  a future enhancement.)
- **Label-on-enroll**: `ensurePendingLabel(cw, convId)` (idempotent union) applied by
  `POST /api/drip/enroll` after a successful enrollment (non-fatal, best-effort).
- **First-name personalization**: `migrations/026_drip_enrollment_first_name.sql` adds
  `drip_enrollment.first_name`; `enrollLead` captures `firstName`; `getDue` selects it; the sweep
  renders `{name}` from it (falls back to "there").
- Tests: send-failure → undeliverable, first-name render, `ensurePendingLabel` add + no-op,
  enroll first_name capture.

## Validation
- `node --test` -> 192/192.
- Dev: migration `026_drip_enrollment_first_name.sql` applied; `first_name` column present.

## Remaining before go-live (next milestone, needs approval — touches prod + real sends)
1. Deploy the app to prod (10.0.10.102) so the drip tables/endpoints exist there.
2. n8n: after the LSA initial auto-reply succeeds, call `POST /api/drip/enroll`
   `{ leadRef, source, vertical, phone, conversationId, categoryRaw, firstName, t0 }`.
3. Flip flags deliberately: `DRIP_WRITE_ENABLED`, then a controlled first send with
   `DRIP_SEND_ENABLED` + `DRIP_SWEEP_ENABLED`, and activate a sequence.
4. Then S3: the dashboard.
