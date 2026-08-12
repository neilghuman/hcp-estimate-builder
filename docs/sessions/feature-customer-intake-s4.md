# Customer Intake System — Sprint 4 (HCP customer create + tags)

Branch: `feature/customer-intake-s4` (stacked on `feature/customer-intake-s3`; PR base = the S3 branch).

## Objective
First sprint that WRITES to Housecall Pro. When the customer is marked new, create them in HCP;
otherwise reuse/link an existing record. Load HCP tags and apply the selected tag. Every write is
gated so testing can never mutate real records by accident.

## Safety model (writes)
- `INTAKE_WRITE_ENABLED` env, **default false**. When off, the apply endpoint returns the plan but
  refuses to write (HTTP 403, `gate: writes-disabled`).
- Even when enabled, a real write requires an explicit `confirm: true`.
- `dryRun` returns the exact plan (action + payload) without writing — used by the UI to preview.
- Idempotency: for a "new" customer, the endpoint re-checks HCP (phone→email→name) right before
  creating; if a late match is found it reuses that customer instead of creating a duplicate.

## Deliverables
- `src/hcp.js`: `listTags()`, `createCustomer()`, `applyCustomerTag()` (read tags → union → PUT), and
  the pure `unionTags()`.
- `src/intake.js`: `intakeWriteEnabled()`, pure `buildCustomerCreatePayload()`, `writeEnabled` in
  `/config`, `GET /api/intake/tags`, and `POST /api/intake/drafts/:id/apply-customer`
  (dryRun / gated / confirmed; actions: create | reuse-found | link-existing).
- Intake tab: HCP-loaded tag dropdown, a write-gate badge, and a "Create / link in Housecall Pro"
  button that shows a dry-run plan then a gated "Confirm & write" step (disabled while writes are off).

## Testing performed
- `node --test`: 96/96 pass (4 new: write flag, payload mapping, payload omissions, unionTags).
- Dev container rebuilt; live vs `http://192.168.1.8:8123` (writes OFF, nothing created):
  - `/config` -> `writeEnabled:false`; `/tags` -> 24 tags.
  - New draft (valid, marked new, tag=Tree): dry-run plan -> `action:create` with correct payload
    (mobile normalised, tag, address).
  - Confirm -> **403 writes-disabled** with the plan echoed. No customer created.
- Real create path (enabling the flag) intentionally not exercised against production HCP; covered by
  unit tests + the gated dry-run. Flip `INTAKE_WRITE_ENABLED=true` to do a live create when ready.

## Note
Some entries returned by HCP `/tags` are freeform/junk tag names that already exist in the account;
the dropdown shows them verbatim (HCP data, not a bug here).

## Not in scope (later sprints)
Discovery questions (S5), estimate placeholder + Private Notes (S6), SMS via Chatwoot (S7), full
submit orchestration + idempotency (S8).
