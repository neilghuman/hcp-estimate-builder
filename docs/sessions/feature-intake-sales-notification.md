# Feature: Internal sales-team notification after intake submit

## Request
After a successful intake submit (and after the customer SMS + email), also email the brand's
sales team so an estimator picks up the lead. Recipient/sender are brand-routed:
- **To** `sales@<brand-domain>`
- **From** `estimaterequest@<brand-domain>`
Must include a direct link to the specific Housecall Pro estimate (required), the estimate number,
customer details, and (if available) a link to the customer record. Idempotent, non-fatal, only
after records are created.

## Implementation (uses the existing architecture)
- `src/brands.js`: refactored to a single `domain` per brand; `resolveBrand()` now derives
  `emailFrom` (customer From = sales@<domain>), `salesEmail` (To = sales@<domain>), and `salesFrom`
  (From = estimaterequest@<domain>). All env-overridable
  (`INTAKE_BRAND_<KEY>_SALES_EMAIL/_SALES_FROM`, global `INTAKE_SALES_EMAIL/_SALES_FROM`).
- `migrations/024_intake_sales_notification.sql`: `sales_notify_status/_at/_error` (+ DRAFT_COLUMNS).
- `src/intake.js`:
  - `buildCustomerUrl(customerId)` — direct HCP customer deep-link.
  - `buildSalesNotificationEmail(row, brand)` — subject
    `New Estimate Request – {first} {last} – {company}`; responsive HTML + text with customer
    details, `Estimate #`, a prominent **View Estimate in Housecall Pro** button (direct estimate
    deep-link via the option id), and a customer-record link. Reply-To = customer email.
  - `runSalesNotification(pool, row)` — sends To `brand.salesEmail`, From `brand.salesFrom`.
    Idempotent (skips when `sales_notify_status === 'sent'`), non-fatal (records status, never throws),
    and **requires the estimate link** — if `hcp_estimate_url`/option id isn't available yet it skips
    with a retryable reason rather than sending a linkless email.
  - Wired as the `sales_email` step in the submit pipeline, after the customer email (so the estimate
    URL/number from `ensureEstimate` are already persisted). Dry-run plan reports
    `customerComms.salesEmail`.
- Frontend: added the `sales_email` progress step ("Emailing the sales team the estimate").

## Idempotency & safety
- Runs only in the gated real submit, after customer/estimate/notes succeed.
- `sales_notify_status='sent'` guard + the double-submit claim prevent duplicates on refresh/retry.
- A send failure is logged (`[INTAKE_ERROR] sales_notify`) and recorded; it never fails or
  duplicates the created customer/estimate.

## Verification
- `node --test`: 144/144 (8 new: sales To/From derivation + env overrides, email content incl. the
  direct estimate link + estimate #, idempotency, estimate-link-required skip, not-configured skip).
- Dev rebuilt; migration 024 applied.
- Live sample sent to neil@neilghuman.com: From `estimaterequest@washingtonlandscaping.com`,
  sales To `sales@washingtonlandscaping.com`, subject correct, direct estimate link present.

## Deliverability note
Same relay -> Amazon SES path as the customer email; SES Easy DKIM (d=<brand-domain>) satisfies the
brands' DMARC `p=reject`. The four domains without `include:amazonses.com` in SPF pass on DKIM
alignment — confirm each brand domain is a DKIM-verified SES identity.
