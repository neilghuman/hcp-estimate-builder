# Customer Intake System — Sprint 6 (estimate placeholder + Private Notes)

Branch: `feature/customer-intake-s6` (stacked on `feature/customer-intake-s5`; PR base = the S5 branch).

## Objective
Create an empty estimate placeholder for the estimator and append the intake summary to the customer's
Housecall Pro Private Notes — never overwriting existing notes. Gated by the same write flag.

## HCP probe findings
- "Private Notes" = the customer `notes` string field (no `/customers/:id/notes` sub-endpoint — 404).
  We read → concat → PUT `{notes}`; an idempotency marker prevents double-appends.
- Estimates nest `customer` / `address` / `options`. An empty placeholder = one option, no line items.

## Deliverables
- `src/hcp.js`: `appendCustomerNote()` (append-only, marker-idempotent), `createEmptyEstimate()`
  (single option, no line items, optional address).
- `src/intake.js`: pure `intakeNoteMarker()` + `buildIntakeNote()` (spec-formatted block, injectable
  date), and gated `POST /api/intake/drafts/:id/apply-estimate` (dryRun preview / gate / confirm).
  Requires the customer to be applied (hcp_customer_id) and discovery complete first.
- Intake tab: "Estimate & Private Notes" card with a dry-run note preview then a gated
  "Confirm & write" step (disabled while writes are off). Stores `hcp_estimate_id` on the draft.

## Testing performed
- `node --test`: 108/108 pass (8 new: marker, note rendering incl. specific-callback + missing-value
  em dash; appendCustomerNote append/idempotent/empty; createEmptyEstimate body with/without address).
- Dev container rebuilt; live vs `http://192.168.1.8:8123` (writes OFF, nothing written): linked an
  existing customer (read-only), completed discovery, apply-estimate dry-run returned the formatted
  note preview + `willCreateEstimate:true`; confirm -> **403 writes-disabled**.
- Real estimate/notes write (enabling the flag) intentionally not run against production HCP; covered
  by unit tests + gated dry-run.

## Fix note
An editing slip inlined the estimate functions into `init()` and duplicated `refreshDiscoveryStatus`;
repaired so each function is defined once and `init()` wires all buttons (verified `node --check`).

## Not in scope (later sprints)
SMS via Chatwoot (S7), submit orchestration + idempotency + error handling (S8), polish + reporting
foundation (S9).
