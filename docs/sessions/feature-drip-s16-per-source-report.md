# feature/drip-s16-per-source-report

## Request (design step 1 of 3)
Split the long Follow-up Drip page into per-source pages. S16 is the additive backend groundwork:
exact per-source numbers + source filtering, no UI change yet.

## Change
- **src/drip_runtime.js**: `dripBySource(pool)` — per-source rollup (total/active/completed/replied/
  handled/dropped/response_rate); included in `dripReport` as `bySource`. `getEnrollments` accepts a
  `source` filter.
- **src/drip_routes.js**: `GET /api/drip/enrollments?source=` passes the filter through.
- Additive only; no migrations; existing responses unchanged (new `bySource` key added). 215 tests pass.

## Next
- S17: extract `followup-core.js` (shared render module) with zero behavior change + shared nav.
- S18: per-source pages (LSA/Thumbtack) + Global + Overview hub.
