# feature/drip-s2-runtime

## Context
S2 of the lead follow-up drip. Builds the in-app runtime **engine + gated service + API** on top
of the S1 schema. Stacked on `feature/drip-s1-schema` (S1, PR #12).

## Architecture decision (documented, reversible)
The plan originally said "n8n sweep." Changed to an **in-app runtime** in hcp-estimate-builder
because this app already owns the ScopeFoundry Postgres and already has a Chatwoot client:
no cross-host DB credential/secret, one testable codebase, durable DB state, gated like the
intake writes, and it avoids the n8n Wait/concurrency questions. n8n's only future role is a
webhook that calls `POST /api/drip/enroll` after the initial send.

## What S2 adds (no sends; gated)
- `src/drip.js` (engine, pure): `computeNextDueAt`, `buildIdemKey`, `parseHHMM`,
  `quietHoursDelayMinutes`, `localMinutesInTz`, `applyQuietHours`, `evaluateStop`
  (Chatwoot-anchored: resolved / label removed / human response; ignores the drip's own
  `content_attributes.automation='drip'` sends and private notes).
- `src/drip_runtime.js` (DB glue, gated): `dripConfig`, `enrollLead` (idempotent on lead_ref,
  suppression guard, category mapping, quiet-hours-aware next_due, expiry), `resolveNextMessage`,
  `getEnrollments`, `dripReport`, `addSuppression`.
- `src/drip_routes.js` + server wiring: `GET /api/drip/config|report|enrollments`,
  `POST /api/drip/enroll|suppress` (writes gated behind `DRIP_WRITE_ENABLED`).
- Flags (all safe by default): `DRIP_ENABLED=true`, `DRIP_WRITE_ENABLED=false`, `DRIP_SEND_ENABLED=false`.
- Tests: `test/drip.test.js` (engine, 22) + `test/drip_runtime.test.js` (service, 7).

## Validation
- `node --test` → 175/175.
- Dev container rebuilt; live: `GET /api/drip/config` = {enabled:true, writeEnabled:false,
  sendEnabled:false}; `GET /api/drip/report` lists the 2 seeded (inactive) sequences;
  `POST /api/drip/enroll` → 403 (write gate).

## Not in S2 (next)
- S2b: the sweep loop (cron) + actual send path (post to Chatwoot tagged `automation:'drip'`),
  stop re-check before each send, delivery logging — all behind `DRIP_SEND_ENABLED`, plus the
  n8n enroll webhook.
- S3: dashboard (read-only, then editing).
- Nothing sends until S2b is built and the flags are deliberately enabled.
