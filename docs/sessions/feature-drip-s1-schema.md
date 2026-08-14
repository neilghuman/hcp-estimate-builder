# feature/drip-s1-schema

## Context
S1 of the lead follow-up drip campaign (Google LSA + Thumbtack). This is the **schema + seed**
foundation only — no runtime behavior, no dashboard yet. Full plan lives in the session notes.

Confirmed design decisions this drives:
- Message store = **ScopeFoundry Postgres** (this app's DB), single source of truth for drip +
  (later) the existing auto-replies.
- Cadence: 4 touches day 1 then taper — T0, +30m, +2h, +5h, +1d, +3d, +6d final. Max 7 messages / ~7 days.
- Stop conditions (runtime, later sprints): human response / label `A_pending_callback` removed /
  conversation resolved / delivery failure / max+expiry. Opt-out handled by the platform.
- Category-specific copy with vertical-default fallback; canonical taxonomy maps Thumbtack names
  and Google slugs to one `category_key`.
- Variants per (step, category) + selection strategy (random | round_robin | weighted_ab).

## What S1 adds
- `migrations/025_drip_campaign.sql` (idempotent):
  - Config tables: `drip_sequence`, `drip_step`, `drip_message`, `drip_message_history`, `drip_category_map`.
  - Runtime tables: `drip_enrollment` (UNIQUE lead_ref dup-guard + due index), `drip_suppression`, `drip_delivery_log`.
  - Seed: 2 Google-LSA sequences (landscaping, tree) `is_active=FALSE`, 14 steps, 14 default
    messages + 1 `stump_grinding` category override, 12 taxonomy rows.
- `src/drip.js` — pure helpers reused by the future dashboard preview and runtime:
  `resolveCategoryKey`, `resolveMessage` (category-specific-over-default + variant strategy),
  `renderBody`.
- `test/drip.test.js` — 8 unit tests.

## Validation
- `node --test test/drip.test.js` → 8/8; full suite → 154/154.
- Dev container rebuilt: `✓ Migration applied: 025_drip_campaign.sql` (no warning).
- Seed counts in dev: sequences 2, steps 14, messages 15, category_map 12, enrollments 0.

## Not in S1 (next sprints)
- S2: n8n sweep reads copy from these tables (replace hardcoded), enrollment + stop-check + quiet hours.
- S3: dashboard read-only. S4: dashboard editing (validation + versioning). S5: taxonomy + analytics.
- Sequences seeded OFF; nothing sends until the runtime is built and enabled.
