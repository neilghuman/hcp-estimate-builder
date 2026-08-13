# Discovery Redesign — Sprint Plan

**Goal**: Transform Discovery from a checklist into a conversational, service-aware questionnaire that collects better qualifying data and provides estimators with a clean, organized summary.

**Scope**: 5 sprints, stacked PRs (each branch bases on previous), with validation at each step.

---

## Sprint 1: Discovery Config + Universal Questions + Rendering Foundation

**Timeframe**: ~1 week  
**Branch**: `feature/discovery-s1-universal-questions`  
**PR Base**: `main`

### What Gets Built

1. **Universal Discovery Questions Schema** (`src/intake.js`)
   - Define `DISCOVERY_QUESTIONS` array with 11 universal questions:
     1. Project Description (textarea, required)
     2. Service/Project Type (context-aware, optional if known)
     3. Timeline (select, required)
     4. Buying Priority (select, required)
     5. Buying Stage (select, required)
     6. Are you getting other estimates? (select, required)
     7. Project Success (textarea, optional)
     8. Budget / Price Range (select, optional, service-aware)
     9. Photos (select, optional)
     10. Contact Method (select, required)
     11. Best Contact Time (select, required)
     12. Final Notes (textarea, optional)
   - Each question: `{ id, question, type, required, placeholder, options: [], showWhen?, serviceAware? }`

2. **Discovery Rendering Functions** (`public/intake.js`)
   - `fillDiscovery(row)`: Populate form from persisted draft
   - `collectDiscovery()`: Harvest form values into patch object
   - `renderDiscoveryField(question, value)`: Generate HTML for one question
   - `validateDiscovery()`: Client-side validation mirroring server
   - `refreshDiscoveryStatus()`: Show step completion badge

3. **Basic HTML Structure** (`public/intake.html`)
   - Replace empty `<div id="discoveryForm">` with fieldset structure
   - Each question gets a `.discovery-field` wrapper
   - Labels, hints, error messages ready (but no service-specific logic yet)

4. **Database Awareness**
   - Confirm existing columns in `customer_intakes` table support all questions
   - Add migration if needed (unlikely; existing schema has `problem`, `timeframe`, `decision_factor`, `budget`, `additional_notes` already)
   - No new columns — all universal questions map to existing or `data` JSONB

5. **Styling** (`public/intake.css`)
   - `.discovery-field` container with consistent padding/gaps
   - `.discovery-label` for question text
   - `.discovery-hint` for help text (smaller, muted)
   - `.discovery-input` for text/textarea
   - `.discovery-select` for dropdowns
   - `.discovery-options` for pill groups (radio/checkbox)
   - `.discovery-required` indicator
   - Error state: `.is-error` red border + message

### Testing Checklist

- [ ] **Unit**: All 11 questions render without errors
- [ ] **Unit**: `collectDiscovery()` returns correct shape for each question type
- [ ] **Unit**: `fillDiscovery(row)` restores saved values accurately
- [ ] **Unit**: `validateDiscovery()` catches missing required fields
- [ ] **E2E Dev**: Load fresh draft → fill all universal questions → save → reload → values persist
- [ ] **E2E Dev**: Required field validation triggers on save attempt with blanks
- [ ] **E2E Dev**: Optional fields accept empty (no validation error)
- [ ] **Regression**: Existing customer info (name/phone/email/address) still works
- [ ] **Regression**: Existing customer tag selection unaffected
- [ ] **Regression**: Submit flow still launches (though Discovery submit logic deferred to S2)

### Acceptance Criteria

- ✅ All 11 universal questions render and persist
- ✅ Required vs optional properly enforced
- ✅ Form dirty tracking includes Discovery changes
- ✅ No service-specific questions yet (non-blocking)
- ✅ All existing features (customer info, address, tag) still functional
- ✅ No HCP changes (Discovery data not yet synced to HCP)
- ✅ Conditional logic stub in place (showWhen parsed but not yet acted upon)

### Code Artifacts

- `src/intake.js`: `DISCOVERY_QUESTIONS` constant, discovery-aware `updateDraft` changes
- `public/intake.js`: `fillDiscovery()`, `collectDiscovery()`, `renderDiscoveryField()`, `validateDiscovery()`, `refreshDiscoveryStatus()`
- `public/intake.html`: Discovery fieldset with template placeholders
- `public/intake.css`: Discovery field styling
- `docs/sessions/feature-discovery-s1-universal-questions.md`: Session notes

### PR Checklist

- [ ] Branch created from `main`
- [ ] All tests pass (129 baseline + any new tests)
- [ ] Dev validated: fresh draft, fill questions, submit (expect no-op, still in draft)
- [ ] Session notes committed with decisions + edge cases
- [ ] Ready for review/merge to main

---

## Sprint 2: Conditional Logic + "Are You Getting Other Estimates?" Flow

**Timeframe**: ~1 week  
**Branch**: `feature/discovery-s2-conditionals`  
**PR Base**: `main` (or cherry-pick S1 if not merged yet; rebase if merged)

### What Gets Built

1. **Conditional Rendering Engine** (`public/intake.js`)
   - `evaluateShowWhen(showWhen, currentAnswers)`: Evaluate condition like `{ question: "getting_estimates", equals: "yes" }`
   - `renderDiscoveryDynamically()`: Loop through all questions, show only those whose `showWhen` is satisfied (or no `showWhen`)
   - On any discovery field change: recalculate visibility + re-render affected fields

2. **Competitor Estimate Questions** (Update `src/intake.js` DISCOVERY_QUESTIONS)
   - Q6: "Are you currently getting estimates from other contractors?"
     - Options: Yes / No / Planning to
     - Required: Yes
   - Q6a (conditional on Q6="Yes" OR "Planning to"): "Have you already scheduled your other estimates?"
     - Options: Not yet / Some of them / Yes, they're already scheduled / I've already received them
     - Required: Yes (only if Q6a shown)
   - Q6b (conditional on Q6a in ["Some of them", "Yes, they're already scheduled", "I've already received them"]): "When would you like us to come out?"
     - Placeholder: "For example: after all other estimates, next weekend, ASAP"
     - Type: textarea
     - Required: No
     - Help text: "This helps us schedule strategically."

3. **Data Model Updates** (Backend `src/intake.js`)
   - Add to `DRAFT_COLUMNS`: `getting_estimates`, `other_estimates_status`, `scheduling_preference` (if not already present)
   - Verify migration handles new fields (add migration if needed)

4. **Competitor-Aware Summary** (Template for S4)
   - Tag the competitor estimate logic in the HCP summary section so S4 can format it correctly
   - Comments only; no rendering yet

### Testing Checklist

- [ ] **Unit**: `evaluateShowWhen()` correctly evaluates simple conditions
- [ ] **Unit**: `renderDiscoveryDynamically()` shows/hides fields based on conditions
- [ ] **E2E Dev**: Q6 "No" → Q6a/Q6b hidden (no validation error)
- [ ] **E2E Dev**: Q6 "Yes" → Q6a shown, required
- [ ] **E2E Dev**: Q6a "Not yet" → Q6b hidden
- [ ] **E2E Dev**: Q6a "Some of them" → Q6b shown
- [ ] **E2E Dev**: Q6a "Yes, already scheduled" → Q6b shown
- [ ] **E2E Dev**: Fill Q6a + Q6b → save → reload → values persist, visibility correct
- [ ] **E2E Dev**: Change Q6 "Yes" → "No" → Q6a/Q6b hidden, no validation error on save
- [ ] **Regression**: Non-conditional questions still work
- [ ] **Regression**: Customer info + address + tag unaffected

### Acceptance Criteria

- ✅ Competitor logic fully functional without hard-coded wording
- ✅ No "awkward commitment" language (no "final estimate" pressure)
- ✅ Conditional show/hide working for all Q6 paths
- ✅ "Scheduling preference" captured for estimator intelligence
- ✅ Summary section ready for S4 formatting

### Code Artifacts

- `src/intake.js`: `DISCOVERY_QUESTIONS` + `getting_estimates`, `other_estimates_status`, `scheduling_preference` columns
- `public/intake.js`: `evaluateShowWhen()`, `renderDiscoveryDynamically()`, event listeners for visibility re-calc
- Migration (if needed): Add new columns
- `docs/sessions/feature-discovery-s2-conditionals.md`

### PR Checklist

- [ ] All tests pass
- [ ] Dev: "No other estimates" path works cleanly
- [ ] Dev: "Getting estimates" path + scheduling preference saved
- [ ] Conditional logic is extensible (easy to add more showWhen rules in future)

---

## Sprint 3: Service-Specific Questions + Budget Ranges (Roofing, Tree Service, Landscaping, Construction)

**Timeframe**: ~1.5 weeks  
**Branch**: `feature/discovery-s3-service-questions`  
**PR Base**: `main` (or rebase from S2)

### What Gets Built

1. **Service-Specific Question Configs** (`src/intake.js`)
   - Add `SERVICE_QUESTIONS` object with Roofing / Tree Service / Landscaping / Construction service definitions
   - Each service gets 2–4 short questions (NOT a full inspection form)

   **Roofing Questions**:
   - "What best describes what you need?" → Full replacement / Repair / Active leak / Storm damage / Skylight work / Roof inspection / Not sure
   - "Approximately how old is the roof?" → <10 yrs / 10–20 / 20–30 / >30 / Don't know
   - "Are you experiencing an active leak?" → Yes / No / Not sure
   - If "Yes": "Where are you noticing the leak?" → textarea

   **Tree Service Questions**:
   - "What type of tree work are you looking for?" → Removal / Trimming/pruning / Dead/hazardous / Storm damage / Stump grinding / Health/assessment / Multiple trees / Not sure (multi-select OK)
   - "Approximately how many trees?" → 1 / 2–3 / 4–10 / >10 / Not sure
   - "Is anything making the tree concerning?" → Dead/dying / Leaning / Near house / Near power lines / Storm damaged / Broken limbs / No concern / Not sure (multi-select)

   **Landscaping Questions**:
   - "What type of project?" → Cleanup / New landscaping / Lawn install / Planting / Mulch/bark / Hardscape / Drainage / Irrigation / Ongoing maintenance / Other
   - "Is this one-time or ongoing?" → One-time / Ongoing / Not sure
   - Conditional: If "Ongoing", show "How often?" → Weekly / Biweekly / Monthly / Quarterly / As-needed

   **Construction Questions**:
   - "What type of project?" → Repair / Remodel / Addition / Exterior / Structural / Deck/outdoor / Other / Not sure
   - "Do you have plans/drawings?" → Yes / No / In progress / N/A
   - "Has permitting started?" → Yes / No / Not sure / N/A

2. **Service Detection** (`public/intake.js`)
   - Detect selected service from:
     1. Customer tag (if set)
     2. Prior service selection (persist across resume)
     3. Lead source metadata (if available)
   - If service known → prepopulate read-only; hide "What service is this?"
   - If service unknown → require selection in Q2

3. **Service-Aware Budget Ranges** (Update `src/intake.js` DISCOVERY_QUESTIONS)
   - Q8 (Budget): Make options dynamic per service
   - **Roofing**: No set budget / <$5k / $5–$10k / $10–$20k / $20–$30k / $30k+ / Not sure
   - **Tree Service**: No set budget / <$1k / $1–$3k / $3–$5k / $5–$10k / $10k+ / Not sure
   - **Landscaping**: No set budget / <$500 / $500–$1.5k / $1.5–$3k / $3–$5k / $5k+ / Not sure
   - **Construction**: No set budget / <$10k / $10–$25k / $25–$50k / $50–$100k / $100k+ / Not sure

4. **Rendering Logic** (`public/intake.js`)
   - After universal Q1–Q6 shown, dynamically insert service-specific questions
   - Service-specific questions follow natural flow (e.g., after "How urgent?" but before "What would make it successful?")
   - Show/hide entire service block based on service selection

5. **Database** (`src/intake.js`)
   - Add `DRAFT_COLUMNS` for all service-specific answer fields (roofing_*, tree_*, landscaping_*, construction_*)
   - OR store in `data` JSONB with keys like `service_answers: { roofing_work_type, roofing_age, ... }`
   - Keep flat columns for service-specific info that feeds HCP summary

### Testing Checklist

- [ ] **Unit**: Service detection works from tag, prior selection, lead source
- [ ] **E2E Roofing**: Select Roofing → roofing questions appear → fill all → save → reload → values correct
- [ ] **E2E Roofing**: Roofing budget options loaded correctly (no landscaping ranges showing)
- [ ] **E2E Roofing**: "Active leak: Yes" → leak location shown
- [ ] **E2E Tree Service**: Tree questions appear → multi-select hazards work → save/reload
- [ ] **E2E Tree Service**: Tree budget ranges differ from Roofing
- [ ] **E2E Landscaping**: "Ongoing" → frequency shown; "One-time" → frequency hidden
- [ ] **E2E Construction**: Plans + permitting logic independent
- [ ] **E2E**: Unknown service → must select in Q2 before proceeding
- [ ] **E2E**: Change service mid-form → service-specific questions update
- [ ] **Regression**: Universal questions still work
- [ ] **Regression**: Conditional (competitor) logic unaffected

### Acceptance Criteria

- ✅ All 4 service types render correct questions
- ✅ Service detection from tag/prior selection works
- ✅ Budget ranges are service-specific (not hard-coded universal)
- ✅ Multi-select options (tree hazards, etc.) work
- ✅ Conditional logic within service questions (e.g., leak location) works
- ✅ Service change mid-form re-renders questions
- ✅ Budget options easily configurable (data-driven, not hard-coded in HTML)

### Code Artifacts

- `src/intake.js`: `SERVICE_QUESTIONS` constant, `BUDGET_RANGES` per service, `DRAFT_COLUMNS` extensions
- `public/intake.js`: Service detection, dynamic service-question rendering, budget-range swapping
- `public/intake.html`: Service question field templates
- Migration (if needed): New columns for service-specific answers
- `docs/sessions/feature-discovery-s3-service-questions.md`

### PR Checklist

- [ ] All tests pass
- [ ] Dev: Roofing full E2E works
- [ ] Dev: Tree Service full E2E works
- [ ] Dev: Landscaping full E2E works
- [ ] Dev: Construction full E2E works
- [ ] Budget ranges verified to match spec (no client typos)

---

## Sprint 4: HCP Summary Formatting + Estimate Integration

**Timeframe**: ~1.5 weeks  
**Branch**: `feature/discovery-s4-hcp-summary`  
**PR Base**: `main` (or rebase from S3)

### What Gets Built

1. **Discovery Summary Formatter** (`src/intake.js`)
   - New function: `buildDiscoverySummary(row, serviceType)` → formatted markdown/text
   - Organize into 6 sections:
     - **PROJECT**: description, timeline, project-type (if applicable)
     - **CUSTOMER PRIORITIES**: buying priority, buying stage, project success (if provided)
     - **ESTIMATE STATUS**: getting other estimates, status, scheduling preference (if applicable)
     - **[SERVICE] DETAILS**: service-specific answers (roofing/tree/landscaping/construction section with appropriate heading)
     - **BUDGET & EXPECTATIONS**: budget, photos (yes/no), contact preference, contact time
     - **ADDITIONAL INFO**: final notes, anything else

2. **HCP Integration** (`src/intake.js`)
   - During `ensureEstimate()` or `submitIntake()`: Generate summary via `buildDiscoverySummary()`
   - Append summary to HCP estimate's "Summary of Work" or private notes field
   - If HCP supports structured metadata, store service-specific answers there too
   - Fallback: Plain text summary with clear section breaks

3. **Summary Rendering** (`public/intake.js`)
   - Optional: Show a "Review your answers" preview before final submit
   - Display formatted summary so customer can verify correctness
   - No changes to data; just read-only display

4. **Testing Data**
   - Create test intakes for each service type + competitor path
   - Verify HCP receives correctly formatted summary
   - Verify service-specific questions appear in right section

### Testing Checklist

- [ ] **Unit**: `buildDiscoverySummary()` produces correct section order
- [ ] **Unit**: Service-specific section title correct (e.g., "ROOFING DETAILS")
- [ ] **E2E Roofing**: Submit roofing intake → HCP estimate shows roofing summary
- [ ] **E2E Tree Service**: Submit tree intake → HCP estimate shows tree summary
- [ ] **E2E Landscaping**: Submit landscaping intake → HCP estimate shows landscaping summary
- [ ] **E2E Construction**: Submit construction intake → HCP estimate shows construction summary
- [ ] **E2E**: Competitor estimate path included in HCP summary correctly
- [ ] **E2E**: Optional fields (project success, photos) handled gracefully in summary
- [ ] **E2E**: Blank optional fields don't create "Question: (blank)" lines
- [ ] **Regression**: Address sync, customer create, SMS notification still work

### Acceptance Criteria

- ✅ HCP estimate displays human-readable, well-organized summary
- ✅ Estimator can immediately understand customer priorities + project scope
- ✅ Section order matches spec (PROJECT → PRIORITIES → STATUS → DETAILS → BUDGET → NOTES)
- ✅ Service-specific section only appears for that service
- ✅ No internal field names (e.g., `roofing_work_type`) shown to estimator
- ✅ Summary text uses friendly question wording, not raw keys

### Code Artifacts

- `src/intake.js`: `buildDiscoverySummary()` function, summary-generation logic
- `src/intake.js`: Integrate summary into `submitIntake()` or `ensureEstimate()` workflow
- `public/intake.js`: Optional preview panel before submit (low priority if time-constrained)
- Test fixtures: Sample intakes per service type
- `docs/sessions/feature-discovery-s4-hcp-summary.md`

### PR Checklist

- [ ] All tests pass
- [ ] Dev: Roofing intake → HCP summary readable + complete
- [ ] Dev: Competitor path summary reads well (no awkward phrasing)
- [ ] Session notes document HCP field choice (Summary of Work vs. notes vs. metadata)

---

## Sprint 5: Testing + Polish + Edge Cases

**Timeframe**: ~1.5 weeks  
**Branch**: `feature/discovery-s5-testing-polish`  
**PR Base**: `main` (or rebase from S4)

### What Gets Built

1. **Comprehensive E2E Test Matrix**
   - Run all 10 conditional paths from spec:
     1. Roofing + getting multiple estimates
     2. Roofing + no other estimates
     3. Tree Service + has estimates + already scheduled
     4. Tree Service + planning to get estimates
     5. Landscaping + one-time + no budget
     6. Landscaping + ongoing + has budget
     7. Construction + has plans + permitting started
     8. Construction + no plans + permitting not started
     9. Generic service (unknown) + must select in Q2
     10. Existing customer (linked) + discovery questions still render

2. **Edge Case Handling**
   - **Service Change Mid-Form**: Fill Roofing Q → change tag to Tree Service → verify roofing answers cleared, tree questions shown
   - **Resume Draft**: Submit roofing intake → open new draft → navigate back to roofing draft → all discovery answers preserved exactly
   - **Browser Back Button**: Fill discovery → back to customer info → forward → discovery values intact (or graceful re-populate)
   - **Form Validation Cascade**: Miss required field in middle of discovery → save attempt → error highlights only invalid field
   - **Multi-Select Persistence**: Select multiple tree hazards → save → reload → all checkmarks restored
   - **Textarea Newlines**: Enter multi-line text in project description → save/reload → formatting preserved
   - **Optional Field Skipping**: Leave all optional fields blank → save succeeds → HCP summary omits those sections cleanly
   - **Extremely Long Answers**: Paste 5000 chars into project description → save → load → truncation or display handled gracefully

3. **UX Polish**
   - Spinner/loading state during save (especially during `collectDiscovery()` validation)
   - Error messages clear + actionable (e.g., "Please select a timeline" not "timeframe required")
   - Focus management: After filling Q → tab to next Q (no jumps)
   - Mobile: Discovery fieldset readable on <600px (stacked, no overflow)
   - Accessibility: All questions have `<label>`, radio/checkbox groups have `role="radiogroup"`, error messages linked via `aria-describedby`

4. **HCP Integration Validation**
   - Estimate created in HCP after submit
   - Summary section present and formatted
   - Service-specific section correct for each service
   - No duplicate sections (e.g., BUDGET appearing twice)
   - Competitor path wording natural ("Comparing options" not "YES")

5. **Performance**
   - Discovery validation does not block UI (no long-running loops)
   - Dynamic visibility updates respond within 100ms (no noticeable lag)
   - Fetching remote config (if applicable) doesn't cause re-renders

6. **Documentation + Runbook**
   - Session notes document all test paths + results
   - Known limitations documented (e.g., "service-specific Q answers not queryable yet" if deferred)
   - Future polish ideas (e.g., "estimated time display", "progress %") noted separately

### Testing Checklist

All 10 paths:
- [ ] **Path 1 (Roofing + competing)**: Fill all fields → save → submit → HCP summary has roofing + competitor section → no errors
- [ ] **Path 2 (Roofing + no competing)**: Competitor questions hidden → save → submit → HCP summary has roofing, NO competitor section → no errors
- [ ] **Path 3 (Tree + has estimates + scheduled)**: Tree questions + Q6 path filled → save/submit → HCP summary correct
- [ ] **Path 4 (Tree + planning)**: Q6="Planning to" → Q6a shown/filled → save/submit → summary correct
- [ ] **Path 5 (Landscaping + one-time + no budget)**: Q8 empty → summary omits budget line → no "blank" lines in HCP
- [ ] **Path 6 (Landscaping + ongoing)**: Frequency shown → filled → save/submit → HCP shows frequency
- [ ] **Path 7 (Construction + has plans + permitting)**: Both Q shown, filled → save/submit → summary correct
- [ ] **Path 8 (Construction + no plans + no permitting)**: Both filled with "No/N/A" → summary clean
- [ ] **Path 9 (Unknown service)**: No customer tag → Q2 "Service type" shown required → can't proceed without selection → select Tree → tree Qs appear
- [ ] **Path 10 (Linked customer)**: Existing customer linked → discovery still renders → submit works → new HCP estimate created (or linked to existing)

Edge cases:
- [ ] **Service change mid-form**: Roofing → Tree → roofing answers cleared, tree Qs appear
- [ ] **Resume draft**: Roofing intake saved → new draft → view old intake → all discovery Qs populated
- [ ] **Browser back/forward**: Fill discovery → back → forward → values intact
- [ ] **Validation cascade**: Missing required field in middle → only that field errors
- [ ] **Multi-select**: Tree hazards multi-select → save/reload → all selected
- [ ] **Textarea newlines**: Project description with `\n` → saved/loaded cleanly
- [ ] **Optional skipped**: All optional blank → save succeeds → HCP summary clean
- [ ] **Long answers**: 5000 chars in project description → no truncation, load succeeds

Accessibility & Mobile:
- [ ] **Mobile <600px**: Discovery fields stack, no horizontal scroll
- [ ] **Accessibility**: Tab through questions, reach all controls, error messages announced
- [ ] **Color blind**: Error states use more than just color (icon + text)

HCP Integration:
- [ ] **Estimate created**: Submit → HCP shows new estimate
- [ ] **Summary present**: Estimate notes show formatted discovery summary
- [ ] **Service-specific**: Roofing estimate has "ROOFING DETAILS", Tree has "TREE SERVICE DETAILS"
- [ ] **No duplication**: Section headers appear once
- [ ] **Competitor path**: Natural wording ("Comparing with other contractors" not raw "YES")

Performance:
- [ ] **Validation responsive**: No freezes during large form validation
- [ ] **Dynamic visibility**: Show/hide service Qs within 100ms
- [ ] **No regress**: Page load time unchanged

### Acceptance Criteria

- ✅ All 10 test paths pass end-to-end
- ✅ All 8 edge cases handled gracefully
- ✅ Mobile + accessibility standards met
- ✅ HCP integration produces clean, readable summaries
- ✅ No regressions to existing features (customer info, address, tag, SMS, estimates)
- ✅ Performance acceptable (<100ms for visibility changes)

### Code Artifacts

- `tests/test_discovery_e2e.js` (new): E2E test matrix for all 10 paths
- `tests/test_discovery_edge_cases.js` (new): Edge case test suite
- `docs/sessions/feature-discovery-s5-testing-polish.md`: Test results + runbook
- Bug fixes + polish commits as needed during testing

### PR Checklist

- [ ] All new tests pass + no regressions on existing 129 tests
- [ ] All 10 paths manually tested on dev
- [ ] Prod deploy candidate: verified with prod config/data
- [ ] Mobile tested on iOS/Android simulators + actual devices
- [ ] Accessibility tested with screen reader + keyboard nav
- [ ] Performance profile acceptable
- [ ] Session notes comprehensive + reviewed

---

## Summary Table

| Sprint | Focus | Key Deliverable | Duration | Status |
|--------|-------|-----------------|----------|--------|
| S1 | Universal Questions + Rendering | 11 universal discovery questions, conditional engine stub | 1w | Ready to start |
| S2 | Conditional Logic + Competitors | "Are you getting estimates?" flow, no-pressure language | 1w | Depends on S1 |
| S3 | Service-Specific Questions | Roofing/Tree/Landscaping/Construction Q sets, service-aware budget | 1.5w | Depends on S2 |
| S4 | HCP Summary Formatting | Clean, organized summary in HCP estimate | 1.5w | Depends on S3 |
| S5 | Testing + Polish | All paths tested, edge cases handled, ready for production | 1.5w | Depends on S4 |

**Total**: ~7 weeks (with some overlap possible). Stacked PRs allow for parallel feedback while keeping main stable.

---

## Principles Across All Sprints

1. **Preserve Everything**: Customer info, address sync, tag selection, HCP integration, SMS notifications all remain untouched until S4 (summary only).
2. **Config-Driven**: Questions defined in data structures, not hard-coded in HTML/JS loops.
3. **Progressive Disclosure**: Show only relevant questions based on service + answers (no 20-question wall).
4. **No Pressure**: Competitor logic removed "awkward commitment" language; scheduling treated as logistics, not objection handling.
5. **Estimator-Centric**: Summary organized for quick scanning + actionable insight, not form field dump.
6. **Testable at Each Stage**: S1 validates basic rendering, S2 validates conditionals, S3 validates service logic, S4 validates HCP output, S5 validates everything together.

---

## Next Steps

1. Confirm sprint plan with user
2. Create `feature/discovery-s1-universal-questions` branch
3. Begin S1 implementation
4. Open PR when S1 renders + persists all 11 questions
5. Iterate through S2–S5 with review/feedback gates

