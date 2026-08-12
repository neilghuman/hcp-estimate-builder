# Customer Intake System — Sprint 3 (customer info & validation)

Branch: `feature/customer-intake-s3` (stacked on `feature/customer-intake-s2`; PR base = the S2 branch).

## Objective
Enforce complete, valid customer information before the intake can move past the customer step:
required fields, phone/email format validation, clear inline errors, and the create-vs-reuse decision
gate. Validation lives on the server (authoritative) and is mirrored client-side for instant feedback.

## Why before the next sprint
Sprint 4 creates the customer in HCP. We must guarantee the data is complete and valid — and that a
create-vs-reuse decision was made — before any write happens.

## Deliverables
- `src/intake.js` (pure, unit-tested):
  - `normalizePhone()` (US 10-digit, tolerates leading country code), `isValidEmail()`.
  - `validateCustomer()` — required: first/last/phone/email/property address; optional secondary phone
    validated when present. Returns per-field messages.
  - `customerStepStatus()` — combines field validity with the decision (`hcp_customer_id` set OR
    `customer_is_new=true`); `complete` only when both hold.
  - Route `GET /api/intake/drafts/:id/customer-status` (read-only, authoritative).
- Intake tab UI: required markers, inline per-field error messages, invalid-field highlighting, blur
  validation, and a live "Customer step complete / reasons" status after save/link/unlink.

## Testing performed
- `node --test`: 92/92 pass (5 new: phone normalisation, email, required-field errors, bad
  phone/email/secondary, step-status gate).
- `node --check` on `src/intake.js` + `public/intake.js`: clean.
- Dev container rebuilt; live smoke test vs `http://192.168.1.8:8123`: empty draft -> incomplete (both
  reasons); bad email -> email error; fixed email + marked new -> complete. No HCP writes.

## Not in scope (later sprints)
HCP customer create + tags (S4), discovery questions (S5), estimate + private notes (S6), SMS (S7),
submit orchestration + idempotency (S8).
