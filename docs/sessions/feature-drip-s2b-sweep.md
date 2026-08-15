# feature/drip-s2b-sweep

## Context
S2b of the lead follow-up drip: the **sweep + send path**, on top of the S2 runtime. Sends remain
gated — nothing goes out unless `DRIP_SEND_ENABLED` (per-send) and, for the background loop,
`DRIP_SWEEP_ENABLED`. Both default OFF; seeded sequences are still inactive.

## What S2b adds
- `src/drip.js` unchanged; new orchestration in `src/drip_sweep.js`:
  - Pure planners: `planStep` (hard stops -> quiet-hours defer -> send) and `planAfterSend`
    (advance to next active step, or complete on max/expiry/sequence-end).
  - `sweepOnce(pool, { chatwoot, now, dryRun })`: for each due enrollment — read the conversation
    snapshot, re-check stop conditions + suppression + quiet hours **immediately before send**,
    resolve + render the message, claim the step (idempotent), send (tagged
    `content_attributes.automation='drip'`), log delivery, advance/complete. **Safety: never sends
    if the conversation snapshot can't be read** (can't verify stops).
  - `realDripChatwoot(cw)` adapter + `startDripSweep` background loop.
- `src/drip_runtime.js`: sweep DB helpers (`getDue`, `getSequence`, `getSteps`, `claimStep`,
  `markDelivery`, `exitEnrollment`, `deferEnrollment`, `applyAfterSend`).
- `src/chatwoot.js`: `getConversationMessages`, `setConversationLabels`, `postDripMessage`
  (tagged send). Existing `sendMessage` untouched.
- `src/drip_routes.js`: `POST /api/drip/sweep` (dry-run by default; real run needs
  `?dryRun=false` + `DRIP_SEND_ENABLED`).
- `server.js`: starts the sweep loop only when `DRIP_SWEEP_ENABLED=true`.
- Tests: `test/drip_sweep.test.js` (13) — planners + sweepOnce (dry-run, send, human-reply exit,
  no-snapshot skip).

## Validation
- `node --test` -> 188/188.
- Dev live: `POST /api/drip/sweep` (dry) -> `{count:0}`; `POST /api/drip/sweep?dryRun=false` -> 403.

## Not yet
- n8n enroll webhook (call `POST /api/drip/enroll` after the initial send) + label-apply on enroll.
- Message render enrichment ({name} needs the contact's first name captured at enroll).
- First live send behind flags; then S3 dashboard.
