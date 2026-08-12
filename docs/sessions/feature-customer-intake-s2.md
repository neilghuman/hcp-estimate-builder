# Customer Intake System — Sprint 2 (customer lookup & dedupe)

Branch: `feature/customer-intake-s2` (stacked on `feature/customer-intake-s1`; PR base = the S1 branch).

## Objective
As office staff type, search Housecall Pro and surface existing customers so they can link the intake
to an existing record instead of creating a duplicate. Priority order: **phone → email → name**.
Read-only against HCP — actual customer creation stays in Sprint 4.

## Why before the next sprint
Dedupe has to exist before we ever create a customer (Sprint 4); otherwise the first write could
create duplicates. Linking also front-loads the customer's real details onto the draft.

## Deliverables
- `hcp.js`: `simplifyCustomer` now also returns `first_name` / `last_name` (non-breaking).
- `src/intake.js`:
  - `buildLookupAttempts()` — pure, ordered phone/email/name keys (normalises phone to digits,
    validates email, requires a 3+ char name).
  - `lookupCustomer(fields, searchFn)` — tries keys in priority order, returns the first with matches
    (searcher injected for testability).
  - `customerToDraftPatch()` — maps a linked HCP customer onto draft columns and sets
    `hcp_customer_id` + `customer_is_new=false` (the dedupe guarantee).
  - Routes: `GET /api/intake/lookup`, `POST /drafts/:id/link-customer`, `POST /drafts/:id/new-customer`.
- Intake tab UI: debounced live lookup (400 ms) as staff type, a matches panel ("Use this customer"),
  a green "Linked to existing HCP customer" banner, and a "Not this customer — new" unlink control.
  Suggestions are suppressed while a customer is linked.

## Testing performed
- `node --test`: 87/87 pass (4 new: attempt ordering, priority lookup, empty result, patch mapping).
- `node --check` on `src/intake.js` + `public/intake.js`: clean.
- Dev container rebuilt; live smoke test vs `http://192.168.1.8:8123` with a real customer
  (Linda Courter): lookup by phone matched, link populated name/phone and set
  `hcp_customer_id` + `customer_is_new=false`, unlink reset to `customer_is_new=true`. No HCP writes.

## Not in scope (later sprints)
Customer info validation (S3), HCP customer create + tags (S4), discovery questions (S5), estimate +
private notes (S6), SMS (S7), submit orchestration (S8).
