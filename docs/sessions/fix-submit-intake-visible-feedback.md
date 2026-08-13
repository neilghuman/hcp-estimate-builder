# Fix: Submit intake gives no visible feedback

## Request
"When I hit submit intake, nothing happens."

## Diagnosis
Submit was actually working. `submitIntake()` runs a dry-run against
`POST /api/intake/drafts/:id/submit` and, when the intake is incomplete, the server
returns `400` with a reason list (e.g. "Intake incomplete. Choose an existing customer
or mark this as a new customer. Answer the required discovery questions.").

That error was rendered only into the top-of-page `#msg` banner. The Submit button lives
at the bottom of a long form, so when the user clicks Submit while scrolled down, the
feedback appears off-screen — it looks like nothing happened.

Reproduced via the browser: filled + saved a customer with no discovery answers, clicked
Submit → network showed `POST .../submit 400`, message text landed in the top banner while
`#submitPlan` (right below the button) stayed hidden.

## Fix
- `public/intake.js`: added `renderSubmitNotice(text)` that writes submit problems into
  `#submitPlan` (the panel directly under the Submit button), unhides it, and scrolls it
  into view. Called from the `submitIntake()` catch block and the unsaved-changes guard.
  The top `#msg` banner is still updated too.
- `public/intake.css`: added `.intake-plan .plan-error` (uses `--err`) and fixed the
  `.intake-plan` border to the real theme var (`--border`, was the non-existent
  `--card-border`).

## Verification
- `node --check public/intake.js` clean.
- Rebuilt dev container (`docker-compose.dev.yml`).
- Reproduced the incomplete-submit flow: the reason now renders in red directly beneath
  the Submit button (`#submitPlan`, `.plan-error`), confirmed in dark mode.
- The happy path is unchanged — a valid dry-run still renders the plan in `#submitPlan`.

## Notes
- No backend/schema changes; the submit validation itself was already correct.


## Follow-up: "will not let me submit" (two-save-button trap)

### Root cause
The form has TWO separate save buttons: "Save & Continue" (customer) and "Save Discovery"
(discovery). Discovery answers only persist when "Save Discovery" is clicked. When a user
filled discovery on screen and hit Submit, the old dirty-guard scrolled them to the CUSTOMER
"Save & Continue" button — which saves the customer but NOT discovery. Submit then rejected
with "Answer the required discovery questions" even though every answer was visibly filled,
creating an inescapable loop. Confirmed by reproducing in the browser and reading back the
draft row (discovery columns null despite on-screen values).

### Fix
`submitIntake()` now auto-persists everything on screen before validating: when the form is
dirty it PATCHes `{ ...collectForm(), ...collectDiscovery() }` in one request, then runs the
submit dry-run. No more juggling two save buttons — clicking Submit saves customer + discovery
and shows the plan (or the specific remaining reason) right at the button.

### Verification
- Reproduced the trap (fill customer + discovery, click Submit with nothing manually saved):
  before = "Intake incomplete. Answer the required discovery questions"; after the fix the
  same flow renders the submit plan ("Customer: create-or-reuse ... Confirm & submit").
- `node --check` clean; dev container rebuilt.
- `collectForm()` does not include `customer_is_new`, so the merged patch never clobbers the
  new-vs-existing customer decision.
