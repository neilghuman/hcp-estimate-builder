# Customer Engagement Platform — fuzzy duplicate contact sweep

## Status

- Branch: `feature/fuzzy-dedup-sweep` (stacked on `feature/hcp-live-sync`).
- Production writes: **NOT run.** Ships gated OFF; no prod deploy in this pass.
- Tests: `node --test` → 324/324 pass (added `test/engagement_fuzzy.test.js`, 11 cases).

## Goal

Find existing EspoCRM Contacts that are probably the **same person split across records** and route
each suspected cluster to `IdentityReview` for a human decision. It **never merges** — merges stay
human-decided per the platform's hard guardrail. This complements exact-match identity resolution
(which only catches identical normalized phone/email) by catching *near* matches.

## How a duplicate is decided

Pairwise, two contacts are a suspected duplicate when **both**:

1. They share a strong identifier — the **same normalized phone or email**, and
2. Their names agree — they **share a name token** (nickname/typo tolerant, e.g. "Robert Lee" /
   "Bob Lee"), *or* the whole names are a very close match (`ENGAGEMENT_FUZZY_NAME_STRONG`, default 0.85).

So two people who merely share a household phone with unrelated names are **not** flagged. Suspected
pairs are unioned (union-find) into clusters, transitively across phone and email links. Candidate
pairs are only formed inside phone/email buckets, so the scan stays near-linear over the whole base.

Being slightly over-inclusive (e.g. spouses sharing a phone + surname) is acceptable: everything is
review-only and a reviewer can dismiss — nothing is ever merged automatically.

## Changes

- `migrations/044_fuzzy_dedup.sql` — `fuzzy_dedup_runs` audit (contacts scanned, clusters found,
  reviews created/existing, failures).
- `src/engagement_fuzzy.js` — pure `nameSimilarity` / `scoreContactPair` / `findDuplicateClusters` /
  `buildDuplicateReview` + audit DB helpers. Cluster idempotency key = SHA-1 of the sorted contact ids.
- `src/engagement_routes.js` — `sweepFuzzyDuplicates(pool)` + `fuzzyDedupEnabled()`; on-demand
  `POST /api/integrations/identity/fuzzy-dedup/sweep` (integration-auth, double-gated); `fuzzyDedupEnabled`
  on `GET /api/integrations/identity/config`.
- `src/engagement_runtime.js` — `fuzzyDedupEnabled` added to `engagementConfig`.
- `server.js` — gated background poller (default daily, non-overlapping, `.unref()`).
- `.env.example` — `ENGAGEMENT_FUZZY_DEDUP_ENABLED` (default false), `_NAME_STRONG` (0.85),
  `_MAX_REVIEWS` (25), `_POLL_MS` (86400000), `_REVIEW_SOURCE_SYSTEM` (EspoCRM), `_REVIEW_ACCOUNT_ID`.
- `test/engagement_fuzzy.test.js` — 11 cases (similarity, pair rule incl. household-phone rejection,
  clustering, transitive union, stable keys, review payload).

## IdentityReview payload

Each cluster becomes one `IdentityReview`: `sourceSystem=EspoCRM`, `sourceAccountId=espocrm-fuzzy-dedup`,
`externalId=<clusterKey>` (idempotent — re-runs find the open review and skip), `conflictSummary=fuzzy_duplicate`,
`candidateContactId=<lowest contact id>`, and `matchingEvidence={type,contactIds,pairs,contacts}`. The
evidence references contact ids + names that already live in EspoCRM (no new PII surface).

## Gates (all OFF by default)

`ENGAGEMENT_FUZZY_DEDUP_ENABLED=true` **and** `ENGAGEMENT_IDENTITY_WRITES_ENABLED=true` **and** a
configured EspoCRM writer key are all required. Otherwise the sweep returns `{ skipped: true, reason }`.

## Go-live checklist (deferred — needs owner + prep)

1. **EspoCRM prep:** the `IdentityReview.sourceSystem` field may be an enum — add an `EspoCRM` option
   (admin step, like the prior ACL grants) or set `ENGAGEMENT_FUZZY_REVIEW_SOURCE_SYSTEM` to an accepted
   value, else `createIdentityReview` will 4xx. Verify the writer role can create `IdentityReview`.
2. Fresh, checksum-verified EspoCRM + ScopeFoundry DB backups.
3. First run via `POST /api/integrations/identity/fuzzy-dedup/sweep` on a small `ENGAGEMENT_FUZZY_MAX_REVIEWS`;
   review the queued clusters for precision before widening or enabling the daily poller.
