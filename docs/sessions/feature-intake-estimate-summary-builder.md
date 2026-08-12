# feature/intake-estimate-summary-builder — Sprint 2

The pure formatter that turns an intake row into the estimate's Summary of Work text.
**Not wired into the HCP flow yet** — that is Sprint 3. Nothing in this PR changes behaviour.

## Requirements addressed
- *"Store both the question and the answer"* — every field renders as a `Question:` /
  `Answer:` pair.
- *"Make the Summary of Work human-readable"* — sectioned headings, blank-line separation, no
  raw form fields, JSON, IDs, database keys or API values.

## Design
`buildEstimateSummary(row, { now })` is pure, with the clock injected so output is deterministic
under test.

**Question wording comes from `DISCOVERY_QUESTIONS`**, so the existing schema stays the single
source of truth — adding or reordering a discovery question automatically flows into the
summary. `SUMMARY_QUESTION_TEXT` overrides only the handful of labels that read as form captions
rather than as something you would actually say to a customer (`"Budget"` ->
`"What budget range do you have in mind?"`).

Sections, in print order:

| Heading | Contents |
|---|---|
| `CUSTOMER INTAKE SUMMARY` | Date taken, and who took it |
| `CUSTOMER` | Name, company, phones, email, service line |
| `SERVICE ADDRESS` | Address, access notes |
| `CUSTOMER REQUEST` | Problem, timeframe |
| `COMPETING BIDS & DECISION` | Other bids, final-estimate response, decision factor, budget |
| `SCHEDULING & FOLLOW-UP` | Callback time (+ detail), photos |
| `ADDITIONAL NOTES` | Free-text notes |

### Rules
- **Conditional questions that never applied are omitted**, reusing `isQuestionVisible`. If the
  customer said they are not getting other bids, the final-estimate question does not appear at
  all rather than showing as empty.
- **Unanswered *required* questions print `Answer: Not provided`** so an estimator can tell the
  question was asked and missed, rather than never asked.
- **Blank *optional* answers are dropped**, and a section whose pairs are all dropped is removed
  entirely — no empty headings.
- Phones render as `(206) 458-1885`; the address renders as a two-line street/city block.

## Changes
- `src/intake.js` — `buildEstimateSummary` plus its private helpers.
- `test/intake.test.js` — 7 new tests.

## Verification
`npm test` — **125 passing**, 0 failing (118 -> 125).

Tests cover: Q&A pairing, headings present, human phone/address formatting, a leak assertion
that no key/id/JSON brace reaches the output, conditional omission, required-vs-optional blank
handling, and determinism for identical input.

## Sample output
```
CUSTOMER INTAKE SUMMARY
Taken August 5, 2026 at 10:00 AM by Roman Seipert


CUSTOMER
--------

Question: Who is the customer?
Answer: Jane Doe

Question: What is the best phone number?
Answer: (206) 458-1885


SERVICE ADDRESS
---------------

Question: Where is the work located?
Answer: 1200 5th Avenue Apt 4B
Seattle, WA 98101


CUSTOMER REQUEST
----------------

Question: What problem are you trying to solve?
Answer: Lawn is overgrown and needs regular service
```

## Next
**S3** — write this into the estimate create payload (per the S1 finding that HCP has no
post-create update path), and confirm against a live test estimate which option field renders
under the *"Summary of Work"* heading in the HCP UI.
