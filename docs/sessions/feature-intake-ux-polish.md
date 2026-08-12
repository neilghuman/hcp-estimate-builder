# feature/intake-ux-polish — Customer Intake UX cleanup

## Request
Simplify the Customer Intake screen so it is a single-pass workflow, and fix the property
address so it maps correctly onto Housecall Pro's address structure.

## Decisions
1. **Remove the "Office staff" dropdown.** Attribution is no longer collected in the UI.
   `created_by` / `created_by_hcp_id` remain as columns for historical rows.
2. **Split the single "Property address" field** into Street / Unit / City / State / ZIP.
   HCP stores customer addresses as discrete `street` / `street_line_2` / `city` / `state` /
   `zip` fields. The old single text box dumped the whole string into `street`, leaving
   city/state/zip blank in HCP. `address_line` is kept for back-compat but is no longer written.
3. **Port Google Places autocomplete** from the public landscaping wizard
   (`WebintakeformLandScaping/frontend/src/hooks/useGooglePlaces.ts`). This page has no build
   step, so the React hook was reimplemented in plain JS/DOM: the new Places
   `AutocompleteSuggestion` API supplies predictions, and we render our own dropdown
   (Google's `PlaceAutocompleteElement` uses a closed shadow DOM we cannot style/position).
   Selecting a prediction fills Street/City/State/ZIP and stores the Place ID.
4. **Restrict the tag picker** to four single-select radio buttons matching real HCP tag names:
   Construction, Landscaping, Tree, Roofing. This screen may not create new tags, so the
   dynamic `/api/intake/tags` fetch was dropped from the UI.
5. **Collapse the multi-step action cards into one pass.** Removed the "Create / link in
   Housecall Pro", "Estimate & Private Notes", and "Notify office (SMS)" cards. **Submit
   intake** already orchestrates the same steps (customer -> tag -> estimate -> notes -> SMS)
   idempotently, so the intermediate buttons were redundant. The Chatwoot readiness badge moved
   onto the Submit card.

## Changes
- `migrations/020_intake_address_fields.sql` — adds `address_street`, `address_unit`,
  `address_city`, `address_state`, `address_zip`, `address_place_id`.
- `src/hcp.js` — `simplifyCustomer` now exposes the discrete address components so a linked
  customer can populate the split fields.
- `src/intake.js` — new address columns in `DRAFT_COLUMNS`; `customerToDraftPatch`,
  `REQUIRED_CUSTOMER_FIELDS`, `validateCustomer` and `buildCustomerCreatePayload` updated to the
  split shape; `/api/intake/config` now returns `googleMapsKey`.
- `public/intake.html` / `.css` / `.js` — split address inputs + autocomplete dropdown, tag
  radios, removed cards and their client flows.
- `.env.example` — documents `GOOGLE_MAPS_KEY`.

## Notes / follow-ups
- `GOOGLE_MAPS_KEY` currently reuses the landscaping wizard's key. If autocomplete stops
  working, add `scopefoundry.test` to that key's allowed referrers in Google Cloud Console, or
  issue a separate key for this internal tool. Missing/invalid key degrades silently to manual entry.
- The server routes `/apply-customer`, `/apply-estimate` and `/notify` are no longer called by
  the UI. Left in place; scheduled for cleanup in the estimate-summary sprints.
- The "Sprint 1 — foundation" banner at the top of the page is stale and should be removed.

## Verification
- `node --check public/intake.js` clean.
- Migration 020 applied on container boot (`Migration applied: 020_intake_address_fields.sql`).
- Live browser test: typing "1200 5th Ave Seattle" returned real Places predictions; selecting
  the first filled Street "1200 5th Avenue", City "Seattle", State "WA", ZIP "98101".
- Tag radios verified single-select.
