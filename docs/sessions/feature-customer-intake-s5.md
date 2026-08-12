# Customer Intake System — Sprint 5 (discovery questions)

Branch: `feature/customer-intake-s5` (stacked on `feature/customer-intake-s4`; PR base = the S4 branch).

## Objective
Capture the full discovery script in a single config-driven schema so questions are easy to add or
reorder, with all conditional logic. Answers persist to the draft. No HCP writes.

## Config-driven design
`DISCOVERY_QUESTIONS` (in `src/intake.js`) is one array that drives BOTH server validation and the UI
(served via `GET /api/intake/discovery-schema`). Each entry has `key`, `label`, `type`
(select/textarea/number/text/info), `options`, `required`, optional `showIf` (conditional), `script`
(the office final-estimate script), and `hint`. Adding/reordering a question = editing this array.

## Questions + conditionals
Problem, Desired timeframe, Getting other bids (Yes → office final-estimate script + Agreed/Declined/
Unsure/Not-Applicable response), Anyone visited (Yes → how many companies + written estimates?),
Biggest decision factor, Budget, Pictures (Yes → send-photos instructions, modular for future
auto-upload), Lead source, Best callback time (Specific Time → manual entry), Additional notes
(optional). All non-conditional questions are required; conditional ones are required only when shown.

## Deliverables
- `src/intake.js`: `DISCOVERY_QUESTIONS`, `OFFICE_FINAL_ESTIMATE_SCRIPT`, pure `isQuestionVisible()`,
  `validateDiscovery()` (honours conditional required + integer check on companies_visited),
  `discoveryStepStatus()`. Routes `GET /api/intake/discovery-schema`,
  `GET /api/intake/drafts/:id/discovery-status`.
- Intake tab: a Discovery card rendered entirely from the schema — selects/textareas/number/text,
  the italic office script, dashed pictures instructions, conditional show/hide, debounced autosave,
  inline per-question errors, and a live "Discovery complete / reasons" status.

## Testing performed
- `node --test`: 100/100 pass (4 new: visibility gating, base-required set, revealed conditionals,
  non-integer rejection + full valid set).
- Dev container rebuilt; live vs `http://192.168.1.8:8123`: schema returns 15 questions incl. script;
  empty draft -> incomplete (9 base required); other bids = Yes -> requires final_estimate_response;
  providing it -> complete.

## Not in scope (later sprints)
Estimate placeholder + Private Notes (S6), SMS via Chatwoot (S7), submit orchestration + idempotency
+ error handling (S8), polish + reporting foundation (S9).
