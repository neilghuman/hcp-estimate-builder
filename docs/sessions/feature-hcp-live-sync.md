# Customer Engagement Platform — HCP live sync (incremental)

## Status

- Branch: `feature/hcp-live-sync` (off `origin/main` @ e20fefad).
- Production writes: **NOT run.** Feature ships gated OFF; no prod deploy in this pass.
- Tests: `node --test` → 313/313 pass (added `test/engagement_livesync.test.js`, 11 cases).

## Goal

Turn the one-time bounded HCP→EspoCRM Contact import (the manual `/imports/hcp/batch`
canary) into an ongoing, scheduled catch-up of **new/changed** Housecall Pro customers, while
inheriting every identity guardrail already in place. Clean `net_new` customers become EspoCRM
Contacts; `provisional` / ambiguous / `field_conflict` customers are queued to `IdentityReview`.
It **never auto-merges** anything.

## Design

- **Cursor model.** A single-row `hcp_live_sync_state` holds the HCP `updated_at` high-water mark
  that has been fully processed. The **first tick only initializes the cursor and imports nothing**,
  so enabling the poller cannot mass-create the ~1,400-customer back catalogue. Existing customers
  are still backfilled deliberately via the owner-driven `/imports/hcp/batch` endpoint.
- **Monotonic, no-skip batching.** `selectLiveSyncWork` (pure) sorts changed customers ascending by
  effective timestamp and processes them under a single combined write budget (`batchLimit`, 1–50).
  When the budget is spent it stops *before* touching the next customer, so the cursor only advances
  past customers the tick fully handled — nothing is ever skipped when a tick caps out.
- **Idempotent + retry-safe.** Already-imported customers are skipped via the existing external-link
  set; already-queued ones via the open-review set. If any write in a tick fails (e.g. a transient
  EspoCRM 5xx), the cursor is **held** (not advanced) so the window retries next tick; the successful
  writes from that tick are deduped on retry.
- **Reuses the gated write path.** Imports go through `createCanaryContactAndLink` + a recorded
  `buildDryRunDecision`; reviews through `buildIdentityReview` → `findOpenIdentityReview` →
  `createIdentityReview` — identical to the existing canary/import routes.

## Changes

- `migrations/043_hcp_live_sync.sql` — `hcp_live_sync_state` (single-row cursor) + `hcp_live_sync_runs`
  (per-tick audit: examined/created/queued/failed/skipped counts, cursor before/after).
- `src/engagement_livesync.js` — pure `selectLiveSyncWork` / `effectiveTimestamp` / `highWater` +
  thin state/audit DB helpers (`getLiveSyncState`, `saveLiveSyncCursor`, `createLiveSyncRun`,
  `completeLiveSyncRun`, `failLiveSyncRun`).
- `src/engagement_routes.js` — exported `sweepHcpLiveSync(pool)` + `hcpLiveSyncEnabled()`; on-demand
  `POST /api/integrations/identity/live-sync/sweep` (integration-auth, double-gated);
  `hcpLiveSyncEnabled` surfaced on `GET /api/integrations/identity/config`.
- `src/engagement_runtime.js` — `hcpLiveSyncEnabled` added to `engagementConfig`.
- `server.js` — gated background poller (default hourly, non-overlapping single tick, `.unref()`),
  mirroring the reminders/call-correlation pollers.
- `.env.example` — `ENGAGEMENT_HCP_LIVE_SYNC_ENABLED` (default false), `_BATCH` (25), `_POLL_MS` (3600000).
- `test/engagement_livesync.test.js` — 11 cases (cursor init, incremental import, review routing,
  auto-confirm no-op, link/review dedup, budget cap + cursor hold, same-tick duplicate collapse).

## Gates (all OFF by default)

`ENGAGEMENT_HCP_LIVE_SYNC_ENABLED=true` **and** `ENGAGEMENT_IDENTITY_WRITES_ENABLED=true` **and** a
configured EspoCRM writer key are all required before a single write occurs. Absent any of these the
sweep returns `{ skipped: true, reason }` and the poller does not start.

## Go-live checklist (deferred — needs owner + fresh backups)

1. Fresh, checksum-verified EspoCRM + ScopeFoundry DB backups.
2. Enable the gate on a short window; confirm the **first tick only initializes the cursor** (creates
   nothing) in `hcp_live_sync_runs` (`first_run=true`, `created_count=0`).
3. Watch the next few ticks: verify created Contacts + queued reviews match expectations and
   `failed_count=0`; confirm the cursor advances.
4. Leave enabled at hourly cadence, or return the gate to `false`.
