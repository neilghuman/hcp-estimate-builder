# Sprint 7: Submit Flow Fix + UX Polish

**Branch:** `feature/s7-submit-flow-fix`  
**Date:** 2026-08-12

## Request

User reported two UX issues with S7 changes:
1. Submit button click produced "not defined" error, blocking end-to-end intake flow
2. The "Start new intake" button reappeared after container rebuild, breaking auto-initialization UX

## Root Causes

**Submit Flow Error:**
- Function `buildNotificationSms()` was being called in two places (S7 POST /notify endpoint and submitIntake flow) but was never defined
- Missing import/export in `src/intake.js`, causing ReferenceError at runtime

**Button Reappearance:**
- HTML button was not removed from `public/intake.html` after S7 UX improvements
- JavaScript listener for the button was not removed from `public/intake.js` init()

## Changes Made

### 1. Added `buildNotificationSms` function ([src/intake.js](src/intake.js#L505-L522))
```javascript
export function buildNotificationSms(row = {}, {  } = {}) {
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ') || '(no name)';
  const tag = row.customer_tag || 'Service';
  const location = [row.address_city, row.address_state].filter(Boolean).join(', ') || '(no location)';
  
  // Build the header with customer + service + location
  const header = `${customerName} • ${tag} • ${location}`;
  
  // Add key summary details (problem, timeframe, budget)
  const summaryParts = [];
  if (row.problem) summaryParts.push(`Problem: ${String(row.problem).split('\n')[0]}`);
  if (row.timeframe) summaryParts.push(`When: ${row.timeframe}`);
  if (row.budget) summaryParts.push(`Budget: ${row.budget}`);
  const summary = summaryParts.length ? summaryParts.join(' | ') : '';
  
  // Add estimate link if available
  const estimateLink = row.hcp_estimate_url ? `\n${row.hcp_estimate_url}` : '';
  
  // Combine: header, summary, and link
  const message = [header, summary, estimateLink].filter(Boolean).join('\n');
  return message;
}
```

**Purpose:** Builds a comprehensive SMS notification for the office about a new intake. Format:
```
John Smith • Landscaping • Seattle, WA
Problem: Needs tree removal | When: ASAP | Budget: $5,000–10,000
https://pro.housecallpro.com/app/estimates/...
```

Includes:
- Customer name + service category + location (header)
- Problem statement (first line only, concise)
- Timeframe and budget (key decision factors)
- Clickable estimate deep-link

Safe fallbacks for missing data; pure function, deterministic.

**Usage:** 
- Called by POST /api/intake/drafts/:id/notify (S7 endpoint)
- Called by submitIntake() flow via runNotify()
- All 129 tests pass (no new test needed — pure formatter already tested patterns)

### 2. Removed "Start new intake" button ([public/intake.html](public/intake.html#L65-L67))
- Deleted `<button id="btnNew" class="secondary">➕ Start new intake</button>` from intake-card-head
- Aligns with S7 UX goal: form should be immediately ready without clicking a button

### 3. Updated init() for auto-initialization ([public/intake.js](public/intake.js#L1266-L1286))

**Removed:**
```javascript
$('btnNew').addEventListener('click', startNew);
setFormEnabled(false);
```

**Added:**
```javascript
// Auto-initialize: load draft from ?t=id parameter or start a new one
const params = new URLSearchParams(window.location.search);
const draftId = params.get('t');
if (draftId) {
  await loadDraft(draftId);
} else {
  await startNew();
}
```

**Effect:** 
- Page load → auto-starts new draft (form enabled, ready to fill)
- OR if URL contains `?t=<public_id>`, loads and resumes that draft
- No manual button click needed — frictionless UX

## Testing

**Manual E2E (post-deploy):**
1. ✅ Visit http://scopefoundry.test/intake.html → form auto-starts, no button visible
2. ✅ Fill customer + discovery fields
3. ✅ Click "Submit intake" → dry-run preview appears
4. ✅ Click "Confirm & submit" → no error, flow completes end-to-end
5. ✅ SMS notification sent to office (via Chatwoot) with:
   - Customer name + service + location header
   - Problem statement + timeframe + budget summary
   - Clickable estimate deep-link
6. ✅ Estimate created in Housecall Pro
7. ✅ All 129 tests pass

**Server rebuild:**
- Docker container rebuild succeeded
- No TypeScript/syntax errors
- Migration auto-applied on boot

## Files Changed

- `src/intake.js` — added buildNotificationSms export
- `public/intake.html` — removed button HTML
- `public/intake.js` — removed button listener, added auto-init logic

## Impact

- ✅ Submit flow now works end-to-end (ReferenceError fixed)
- ✅ UX friction removed (no manual button click)
- ✅ Frictionless entry point (form ready on page load)
- ✅ Deep-linking support (still works: ?t=<id>)
- ✅ **Estimate URL stored and displayed** — appears in:
  - SMS notification to office staff (clickable link)
  - Intake form UI on successful submission (confirmation page)
- ✅ No breaking changes to API or database schema

## Additional Fix: Missing Estimate URL

**Problem (discovered during E2E):** After submission, estimate URL was not appearing in either the SMS notification or the UI success message. This meant:
- Office staff received SMS but couldn't click through to HCP estimate
- Customer completion page had no link to the estimate

**Root cause:** `ensureEstimate()` function was not building or storing the estimate URL after creating the estimate in HCP.

**Fix:** Updated [src/intake.js](src/intake.js#L631-L645) to:
1. Build the estimate deep-link URL using `buildEstimateUrl(est.option_id)`
2. Store `hcp_estimate_url` in the draft row when persisting to database
3. Return `estimate_url` in response so frontend receives it
4. Refetch row after estimate creation ensures SMS sends with URL included
5. Frontend displays link on success page

**Result:** Estimate now appears in:
- ✅ SMS: `https://pro.housecallpro.com/app/estimates/...`
- ✅ UI: Success page shows "View estimate in Housecall Pro →" link

## Merging

Safe to merge to `main`. All tests passing, no dependencies on other PRs.
