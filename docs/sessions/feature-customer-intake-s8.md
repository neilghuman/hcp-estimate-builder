# Customer Intake System — Sprint 8 (submit orchestration)

Branch: `feature/customer-intake-s8` (stacked on `feature/customer-intake-s7`; PR base = the S7 branch).

## Objective
One gated action that runs the whole intake to HCP in order — customer (create/reuse) -> tag ->
estimate placeholder -> private notes -> SMS — with idempotency, double-submit prevention, and
partial-failure handling. Marks the intake `completed` / `failed`.

## Design
- **Shared service steps** (extracted, each idempotent): `ensureCustomer`, `ensureEstimate`,
  `ensureNotes`, `runNotify`. The existing per-step routes (`/apply-customer`, `/apply-estimate`,
  `/notify`) were refactored to call these, removing duplication (one code path).
- **Idempotency**: steps reuse an already-set `hcp_customer_id` / `hcp_estimate_id` / note marker, so a
  re-submit after a partial failure skips completed steps instead of duplicating.
- **Double-submit guard**: a conditional `UPDATE ... WHERE status <> 'submitting'` claims the row;
  concurrent submits get 409. A `completed` intake short-circuits (returns alreadyCompleted).
- **Partial failure**: a failed required step -> `status = 'failed'` + `error`, returns per-step
  progress (safe to re-submit). SMS is non-fatal — a failed text never fails a completed intake.
- On success: `status = 'completed'`, `submitted_at = NOW()`.
- Route `POST /api/intake/drafts/:id/submit` (dryRun plan / gate / confirm). Requires customer +
  discovery complete.

## Deliverables
- `src/intake.js`: `ensureCustomer` / `ensureEstimate` / `ensureNotes` / `runNotify` + the submit
  route; three existing routes refactored onto the shared services.
- Intake tab: a "Submit intake" card — dry-run plan (what it will do) -> gated "Confirm & submit" with a
  double-click guard, then a completed/failed status badge.

## Testing performed
- `node --test`: 115/115 pass (2 new: `ensureEstimate` no-op when estimate exists; `ensureCustomer`
  link-existing without tag does no HCP write).
- Dev container rebuilt; live vs `http://192.168.1.8:8123` (writes OFF, nothing written): incomplete
  draft -> 400 with combined customer+discovery reasons; complete draft dry-run -> plan
  (customer=link-existing, estimate=create, sms not ready); confirm -> **403 writes-disabled**; the
  refactored `/apply-customer` dry-run still returns its plan (no regression).
- The full write path + idempotency/double-submit need one live verification when `INTAKE_WRITE_ENABLED`
  is first turned on (would create a real customer/estimate/notes + text Neil).

## Known follow-up
No boot-time recovery for an intake stuck in `submitting` if the process dies mid-submit (Chat Foundry
has an analogous `recoverInterrupted`). Candidate for S9 polish if desired.

## Not in scope
Polish + reporting foundation (S9).
