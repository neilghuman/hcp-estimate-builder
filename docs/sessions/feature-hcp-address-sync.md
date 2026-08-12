# feature/hcp-address-sync

Stacked on `feature/s7-submit-flow-fix` (PR #2).

## Request

1. "Fix Updated Address Sync to Housecall Pro" — an address edited in the intake form never
   reached HCP, and the failure was silent.
2. Make the save step unambiguous: rename "Save draft", track whether the form has unsaved
   changes, and block submit while it does.

## Part 1 — Address sync

### Symptom

Intake #40 (Sarah Kelly, estimate 1321) was submitted with
`8101 197th Avenue Northeast, Granite Falls, WA 98252`. The estimate in HCP showed no address.

### First diagnosis (wrong)

The server log said the sync had worked:

```
[INTAKE_ADDRESS_CHANGED]  ... reason: 'Address differs between intake form and HCP record'
[HCP_UPDATE_ADDRESS]      ... to: { street: '8101 197th Avenue Northeast', ... }
[HCP_CUSTOMER_UPDATE_REQUEST] ... payload: { addresses: [ [Object] ] }
[HCP_CUSTOMER_UPDATE_SUCCESS] ... updated_fields: [ 'addresses' ]
[INTAKE_ADDRESS_SYNCED]   ... result: 'Address updated in Housecall Pro'
```

Because the customer had no prior address, the guess was that the new address object was missing
a required `type` field. `type: 'service'` was added. It changed nothing.

### Actual root cause

Re-fetching the customer from the API — rather than trusting our own log line — showed the truth:

```
{ "id": "cus_2150...", "first": "Sarah", "last": "Kelly", "addresses": [] }
```

`PUT /customers/:id` **accepts an `addresses` array, returns 200, and silently discards it.**
Our "SUCCESS" log was only reporting that the HTTP call returned 200, so every submission looked
healthy while nothing was written.

### API shape (probed live)

| Request | Result |
| --- | --- |
| `GET /customers/:id/addresses` | 200, paged `{ addresses: [...] }` |
| `POST /customers/:id/addresses` | 201 — the only write path |
| `POST` without `country` | 422 `"Country is required"` |
| `PUT /customers/:id/addresses/:aid` | 404 |
| `PUT /addresses/:aid` | 404 |
| `PATCH /addresses/:aid` | 404 |
| `PUT /customer_addresses/:aid` | 404 |

So HCP addresses are effectively **append-only**: there is no update and no delete.

### Fix

- `src/hcp.js`
  - `updateCustomer` is now scalar-fields-only. The dead `addresses` branch and the misleading
    `[HCP_CUSTOMER_UPDATE_SUCCESS]` logging are removed rather than left to mislead the next reader.
  - Added `listCustomerAddresses(customerId)`.
  - Added `ensureCustomerAddress(customerId, addr)` — normalises and compares
    street/unit/city/state/zip against the existing addresses, reuses an exact match, otherwise
    POSTs a new one with `country: 'US'`. Idempotent, so re-submitting does not duplicate.
- `src/intake.js`
  - New `syncIntakeAddress(row, hcpId)` wrapper.
  - `ensureCustomer` calls it for every path (link-existing, reuse-found, create), so a
    pre-existing customer still gets the intake's address.
  - `ensureEstimate` calls it too and binds the estimate to *that* address id instead of
    `customer.addresses[0]`, which can now be a stale entry given addresses only accumulate.
    Falls back to the old behaviour if the sync fails.
  - `buildCustomerCreatePayload` includes `country` and `type` on the address it sends.

### Verification

- `ensureCustomerAddress` run against the live customer logged `[HCP_ADDRESS_REUSED]` with
  `TOTAL ADDRESSES 1` — the existing address was reused, not duplicated.
- `node --test`: 129 pass, 0 fail (one assertion updated for the new `country`/`type` fields).

### Known limitations

- **Estimate 1321 is not retroactively fixed.** It was created bound to no address. The customer
  record is now correct, but that estimate needs its address set in the HCP UI, or a new estimate.
- A customer who genuinely moves will accumulate addresses in HCP, since the API offers no update
  or delete. The sync always binds the estimate to the correct one, but pruning is a manual UI job.

## Part 2 — Save / submit UX

- `public/intake.html` — "Save draft" is now "Save & Continue", with a hint stating that saving is
  required before submitting.
- `public/intake.js` — a `formDirty` flag, set by input/change listeners on the customer fields and
  discovery controls, cleared only after a save round-trips successfully. `submitIntake` refuses to
  run while the form is dirty; it scrolls to the save button, pulses it, and focuses it.
- `public/intake.css` — badge states (`✓ Saved` / `● Unsaved changes`) and the pulse animation.

## Lesson

A log line that reports "success" from an HTTP 200 is not evidence the write landed. The bug
survived a first round of investigation purely because the logging was trusted over the API. Any
future sync work here should assert against a re-read of the remote record.
