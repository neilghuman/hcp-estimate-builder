# Chat Foundry — onboarding UX

Branch: `feature/chat-foundry-ux-onboarding`

## Request
Operator found the console complex on first open. Three UX improvements, no behavior change:

1. **"Start here" guide panel** at the top — a 5-step walkthrough (Setup → Audience → Compose →
   Campaign → Review) plus a live safety banner that reads the real send flag + inbox allowlist
   (green "Safe mode" when sending is disabled / no allowlist; orange "Live sending is ON" otherwise).
   Collapsible, remembered via localStorage.
2. **Collapsible "Setup & connection" area** — Connection / Accounts / Inboxes / Tags are now inside
   a `<details>` (closed by default) so the page opens straight onto the day-to-day flow. The
   selects those cards populate still auto-load on page init.
3. Verified the guidance against live data (read-only walkthrough — see below).

## Files
- `public/chatfoundry.html` — added the Start-here `<section>`; wrapped the four setup cards in
  `<details class="cf-setup">`.
- `public/chatfoundry.js` — `updateGuideSafety(config)` (live banner) called from `loadConfig`;
  `initGuideToggle()` (collapse/remember) wired in init.
- `public/chatfoundry.css` — styles for the guide panel and the collapsible setup area.

No API, migration, or logic changes. `npm test` → 66/66 pass.

## Live read-only walkthrough (for reference — nothing sent)
- Connection: `chat.unitedservicesnorthwest.com`, account 1, token present.
- Allowlist: empty → sending fully locked (safe mode).
- 12 inboxes: #1 Twilio SMS; #2–6 Thumbtack (Tree/Landscaping-staging/Landscaping/Roofing/
  Construction); #7–12 Telnyx brand numbers. All currently "not allowlisted".
- 15 labels incl. hot-lead, warm-lead, cold-lead, quote-request, roofing, landscaping, tree, etc.
- Audience sample (open, 3 pages): 35 conversations scanned, 0 eligible (all skipped: inbox not
  allowlisted) — exactly as expected until an inbox is added to the allowlist.
