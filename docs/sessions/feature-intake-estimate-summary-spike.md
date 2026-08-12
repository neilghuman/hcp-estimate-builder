# feature/intake-estimate-summary-spike — Sprint 1

Groundwork + API spike for putting the full intake Q&A into the Housecall Pro estimate's
Summary of Work and returning a direct link to that exact estimate.

## Goal of this sprint
Answer the one question that determines the whole architecture:

> Can an HCP estimate be **updated** after it is created, or must the summary be written in the
> **create** call?

...and land the no-risk groundwork needed either way. **No behaviour change in this PR.**

## Findings

### 1. Estimate and option IDs use different prefixes
A live estimate returns:

```
estimate id : csr_3adb33f7253a416e92aec0f8b16cebe9
option id   : est_040871e734a443e4bb05ea5dc041e9b9
```

This confirms the comment already in `public/estimator-studio.js`: the HCP **web app deep-links
by OPTION id, not estimate id**. `createEmptyEstimate` was discarding the option id entirely, so
a working link was impossible to build. Fixed here.

### 2. There is no public API to update an estimate after creation
Probes against the live API (no records mutated — a deliberately non-existent id was used for the
write probes, and only GETs were issued against the real estimate):

| Request | Result |
|---|---|
| `GET /estimates/{real}` | 200 |
| `PUT /estimates/{fake}` | 404 |
| `PATCH /estimates/{fake}` | 404 |
| `DELETE /estimates/{fake}` | 404 |
| `GET /estimates/{real}/options` | 404 |
| `GET /estimates/{real}/options/{real}` | 404 |
| `GET /estimate_options/{real}` | 404 |

The write-verb 404s are individually ambiguous (a `GET` on a fake id also 404s), but the
**absence of any option subresource** is not: there is no addressable endpoint for the object
that carries the summary text. Combined with the existing note in the Studio code — *"HCP can't
update an estimate in place"* — the conclusion is that a post-create update path does not exist.

### 3. Therefore: write the summary in the CREATE call
The estimate option exposes two text fields:

- `message_from_pro` — customer-facing; currently carries the company T&C boilerplate.
- `notes` — currently empty on sampled estimates.

Both are accepted in the create payload. Sprint 3 will set the summary during creation rather
than making a second call. This is **better** than the update approach for the stated requirements:

- It is atomic. The "estimate created but Summary of Work update failed" failure mode from the
  requirements becomes structurally impossible.
- No extra API round-trip, so no n8n orchestration layer is needed. `ESTIMATE_CREATE_PROVIDER`
  stays `direct`.

**Still open (needs a live test estimate):** which of `message_from_pro` / `notes` actually
renders under the heading *"Summary of Work"* in the HCP UI. This is a visual confirmation that
cannot be made from the API alone, and is the first task of Sprint 3.

## Changes in this PR
- `migrations/021_intake_estimate_identity.sql` — adds `hcp_estimate_option_id` and
  `hcp_estimate_number`.
- `src/hcp.js` — `createEmptyEstimate` now returns `option_id` (previously discarded).
- `src/intake.js` — `ensureEstimate` persists the estimate id, option id and number, and replays
  all three on the idempotent no-op path; new columns added to `DRAFT_COLUMNS`.
- `test/intake.test.js` — updated `ensureEstimate` assertions; added a replay test. Also repaired
  four tests left failing by the previous PR's address split (`address_line` ->
  `address_street`/`city`/`state`/`zip`), plus a new ZIP-format test.

## Verification
- `npm test` — 118 passing, 0 failing.
- Migration 021 applied on container boot.

## Next
- **S2** — `buildEstimateSummary(row)` pure formatter + unit tests (not yet wired).
- **S3** — write the summary into the create payload; confirm which field renders as
  "Summary of Work" against a test estimate.
- **S4** — persist + return the direct estimate URL (`.../app/estimates/{option_id}`).
- **S5** — per-stage error handling and structured logging.
- **S6** — end-to-end test submission + remove routes the UI no longer calls.
