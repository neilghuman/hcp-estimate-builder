# Customer Intake System — Sprint 1 (foundation)

Branch: `feature/customer-intake-s1`

## Request
Build a production-quality Customer Intake System for office staff, integrated with Housecall Pro,
so every customer goes through the same ~2-minute intake before being assigned to an estimator.
Explicit instruction: **do not build everything at once** — work in small, tested, approved sprints.

## Architecture decision
Build **inside the existing ScopeFoundry app** (`hcp-estimate-builder`: Node/Express + vanilla JS +
Postgres) rather than a new FastAPI + React stack. Reasoning: the HCP client (`src/hcp.js`), Postgres
+ auto-migrations, Basic-Auth gate, Docker dev env (`scopefoundry.test`), theming, and an outbound
SMS path already exist. A separate stack would duplicate all of it and fragment the "central intake
system" goal. Approved by owner.

### Owner decisions
1. Platform: build inside ScopeFoundry (recommended).
2. Staff attribution: **dropdown of real HCP employees** (not free-form text), so "Created By" always
   matches Housecall Pro. Store the HCP employee id alongside the name for per-staff reporting.
3. Notifications: via **Chatwoot API**, to Neil at **2064581885** (Roman's number omitted for now).
4. Private Notes target: probe the live HCP API during Sprint 6.

## Sprint plan (each stops for approval)
1. **Foundation & data store** ← this PR
2. Customer lookup & dedupe (phone → email → name)
3. Customer info + validation
4. HCP customer create + tags
5. Discovery questions (config-driven)
6. Estimate placeholder + Private Notes append
7. SMS notification via Chatwoot
8. Submit orchestration + idempotency + error handling
9. Polish + reporting foundation

## Sprint 1 deliverables
- `migrations/017_customer_intakes.sql` — one wide `customer_intakes` table (reporting dimensions as
  first-class columns + a `data` JSONB snapshot) designed so later sprints/reports need no schema
  rewrites. Lifecycle: `draft → submitting → completed | failed`.
- `src/intake.js` — durable draft store (create/get/update/list) + `/api/intake/config`, feature-flag
  (`INTAKE_ENABLED`, default on), whitelisted column patching with JSONB merge, simple staff
  attribution. No HCP calls, no notifications yet.
- **Staff dropdown**: `hcp.js` `listEmployees()` (paged, office-staff-first) exposed via
  `/api/intake/staff`; migration 018 adds `created_by_hcp_id`. The Intake tab's "Office staff" field
  is an HCP-populated `<select>` (not free text).
- Wired into `server.js` via `registerIntakeRoutes(app, pool)`.
- New **📝 Intake** tab: `public/intake.html` + `intake.css` + `intake.js` (start/edit/save/resume a
  draft). Toolbar link added to index, chatfoundry, estimator-lab, pricebook.
- `test/intake.test.js` — 10 unit tests (pure helpers + DB functions via mock pool).

## Testing performed
- `node --test`: full suite 80/80 pass (10 new).
- `node --check` on `server.js` and `src/intake.js`: clean.
- Live dev container rebuilt (`docker-compose.dev.yml`): migration 017 applied on boot.
- Live smoke test vs `http://192.168.1.8:8123`: `GET /config`, `POST /drafts`, `PATCH /drafts/:id`
  (JSONB merge preserved), `GET /drafts` list — all pass.

## Not in scope (later sprints)
Customer lookup/dedupe, validation, discovery questions, HCP customer/tag/estimate writes, Private
Notes, and SMS. Nothing is sent to Housecall Pro in this sprint.
