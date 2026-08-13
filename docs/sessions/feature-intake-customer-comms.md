# Feature: Branded customer communications after intake submit

## Request
After an employee submits the Customer Intake Form, automatically:
1. Resolve the brand from the selected tag.
2. Text the customer from the correct brand's Chatwoot inbox/phone.
3. Email the customer a branded confirmation.
4. Let the customer reply to the SMS with photos (lands in the right Chatwoot conversation).
Only after a successful intake; idempotent; non-fatal; record per-channel status.

## How the existing flow works (inspected first)
- Submit pipeline: `POST /api/intake/drafts/:id/submit` in `src/intake.js` runs gated, idempotent,
  ordered steps: `ensureCustomer` -> `ensureEstimate` -> `ensureNotes` -> `runNotify` (office SMS)
  -> mark `completed`. Double-submit guarded by a `status='submitting'` claim; each step reuses
  stored ids so re-runs never duplicate.
- Tag is stored in the `customer_tag` column (radio on the form).
- Chatwoot client `src/chatwoot.js` already provides `ensureConversationForPhone(phone,{inboxId,name})`
  (find-or-create contact + conversation, reuses existing) and `sendMessage(conversationId, content)`.
  Delivery rides the existing Telnyx relay, so customer replies (incl. photos) return to that same
  inbox/conversation automatically — no upload link needed.
- Config via `CHAT_FOUNDRY_CHATWOOT_*` + `INTAKE_NOTIFY_INBOX_ID`. Real brand inboxes discovered via
  `GET /api/chat-foundry/inboxes` (Landscaping=7, Trees=13, Roofing=14, Construction=17; no
  Pressure Washing / Firewood inbox yet).
- No email system existed in this app — added one.

## Implementation
- `src/brands.js` — the single centralized brand/inbox config. Maps intake tag -> company name +
  Chatwoot inbox id + email from/reply-to. Case-insensitive, alias-aware (Tree/Trees). Inbox ids and
  email identity are env-overridable per deploy (`INTAKE_BRAND_<KEY>_INBOX_ID/_EMAIL_FROM/_REPLY_TO`,
  global `INTAKE_EMAIL_FROM/_REPLY_TO`). Adding/changing a brand = edit this file only.
- `src/email.js` — SMTP sender (nodemailer, lazy-imported), `emailConfigured()` gate; skips (never
  fails) when SMTP is not configured.
- `migrations/023_intake_customer_comms.sql` — columns: `resolved_brand`, `chatwoot_inbox_id`,
  `chatwoot_contact_id`, `chatwoot_conversation_id`, `customer_sms_status/_at/_error`,
  `customer_email_status/_at/_error`. Added to `DRAFT_COLUMNS`.
- `src/intake.js`:
  - `buildCustomerSms(row, brand)` — the approved copy, first name + company, invites photo replies,
    no specific-time promise.
  - `buildConfirmationEmail(row, brand)` — subject "We've received your request — {company}", a simple
    responsive HTML template + plain-text fallback, HTML-escaped dynamic values.
  - `runCustomerSms(pool, row)` — resolves brand, reuses/creates the Chatwoot contact+conversation in
    the brand inbox, sends the SMS; idempotent (skips if already sent), non-fatal, records brand +
    Chatwoot ids + status/timestamp.
  - `runCustomerEmail(pool, row)` — sends the branded email; idempotent, non-fatal, records status.
  - Wired both into the submit pipeline after the office SMS (non-fatal steps `customer_sms` /
    `customer_email`), so they only run on a real, successful submit and never fail/duplicate the intake.
  - `/api/intake/config` now reports `comms` readiness; the submit dry-run plan reports `customerComms`.
- Frontend `public/intake.js` — two new steps in the submit progress list ("Texting the customer a
  confirmation" / "Emailing the customer a confirmation"); no new employee steps. `intake.html` adds
  Pressure Washing + Firewood tag options.
- `.env.example` documents the new SMTP + per-brand override vars.

## Idempotency & safety
- Comms run only inside the gated real submit (write-enabled + confirm), after customer/estimate/notes
  succeed — i.e. only after the intake is created.
- Each channel skips when its status is already `sent`; the double-submit claim + reused Chatwoot
  contact/conversation prevent duplicates on refresh/double-click/retry.
- SMS/email failures are logged (`[INTAKE_ERROR]`) and recorded per-channel; they never fail or
  duplicate the created intake.
- Secrets stay server-side (Chatwoot token, SMTP creds); the browser only sees non-secret readiness.

## Verification
- `node --test`: 136/136 pass (11 new: brand routing, SMS/email builders, idempotency/skip paths).
- Dev rebuilt; migration 023 applied; nodemailer installed in the container.
- Live: `/api/intake/config` shows chatwoot=true and smsReady for trees/landscaping/roofing/construction;
  a Landscaping dry-run submit resolves `brand: Washington Landscaping, sms: true, email: false`.
- Email is `email: false` until SMTP env is set (INTAKE_SMTP_HOST + INTAKE_EMAIL_FROM); it then sends
  automatically with no code change. Pressure Washing / Firewood SMS activates once their inbox IDs are set.

## Follow-ups to enable in production (config only)
- Set SMTP (`INTAKE_SMTP_*`) + `INTAKE_EMAIL_FROM` (and optional per-brand from/reply-to) to turn on email.
- Confirm/adjust the per-brand inbox IDs in `src/brands.js` (or env) — especially Pressure Washing / Firewood.
- A first controlled live send is recommended to a number/email the team controls before going wide.
