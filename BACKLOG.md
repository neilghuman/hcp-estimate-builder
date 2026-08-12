# ScopeFoundry Studio — Backlog

Design-exploration backlog for the estimate builder. **Frontend prototype today; everything below is sequenced so it survives the move to a real Postgres backend.** No item here changes the current HCP export contract (the 11 known line-item fields) unless explicitly noted.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Shipped (Batch A + B)
- [x] Service Library as a first-class, reusable definition (shared-field propagation)
- [x] Package inheritance (Good → Better → Best) with override-in-package
- [x] Templates, separate from estimates
- [x] Package diff / compare view
- [x] Measurement inputs (turf/concrete/roof sq ft, fence/gutter lf) + formula pricing `Base + (value × multiplier)`
- [x] Template versioning (v1/v2/v3, never overwrite)
- [x] Customer preview pane (HCP-facing proposal)
- [x] Division as a core field (estimate-level + per-service override)

---

## Tier 1 — Quick wins (low risk, high demo value)
- [x] **Undo toast** for destructive actions (delete package/service). Snapshot-based undo stack + toast with Undo button.
- [x] **Unsaved-packages guard** — `beforeunload` warns while working packages exist (they aren't persisted, only library/templates are).
- [x] **Pre-flight export validation panel** — flags no customer, no address, empty packages, $0 lines, measurement lines with no value/type, and per-line issues; Create/Dry-run are blocked while blockers exist.
- [x] **Missing customer-copy rollup badge** on the Build view ("N services need customer copy") — click to jump to the first offender's General tab.

## Tier 2 — Foundation (do right before backend wiring)
- [x] **localStorage schema versioning** — `schemaVersion` (`LS_SCHEMA = 2`) now stored in key `scopefoundry-studio-v1`; `migrateStore()` upgrades legacy v1 data on load (backfills template `baseName`/`version`, library measurement defaults, missing service fields). Never throws.
- [x] **Stable IDs over names** — every working service is guaranteed a `libraryId` via `ensureLibraryIds()` (runs after template load / starters); `svcKey()` prefers `libraryId` and only falls back to name as a last resort. Inheritance/overrides now key on stable definition ids.
- [ ] **Sparse override diffs** — store only changed fields per package instance (maps to an `estimate_line_overrides` table), not a full service copy. _Deferred to the backend-wiring pass: benefit is mostly backend mapping (shared fields already propagate by `libraryId`); refactoring the in-memory override copies now adds regression risk for little prototype gain._
- [ ] **Cents end-to-end** — standardize on integer cents (pricebook already returns cents); convert only at display. _Deferred to the backend-wiring pass: touches all money math + display = high regression risk; do as one focused conversion right before wiring._
- [ ] **Measurements as typed records** — model toward a `property_measurements` table: `property_id`, `measure_type`, `value`, `unit`, `source` (manual/aerial), `captured_at`; supports re-measures over time. _Deferred to the backend-wiring pass: ripples through `measurementValue`/drawer/template snapshots; low value until persistence exists._

## Tier 3 — Bigger bets (new capability)
- [ ] **Per-division defaults** — each division pre-biases the workspace (default measurement types, tax behavior, starter service set).
- [ ] **Internal cost → live margin %** — internal-only cost field per line, live margin per package. Never sent to HCP.
- [ ] **Template merge** — compose an estimate from multiple templates ("merge this package in") instead of full-replace load.

## Later / nice-to-have
- [ ] **Module split** — break `public/estimator-studio.js` into model / render / events once this direction is committed.
- [ ] **Re-measure history & source tracking** (depends on typed measurement records).
- [ ] **Aerial measurement import** (Roofr/EagleView-style) feeding the measurements drawer.

---

## Backend mapping notes (future Postgres)
| Frontend concept | Future schema |
| --- | --- |
| Measurements object | `property_measurements` table (typed, time-stamped, sourced) |
| Measurement pricing | `services.measure_type` / `base_price_cents` / `multiplier` |
| Template versions | `template_versions` keyed by `base_name` + `version` |
| Division | `division` column on estimates + services |
| Customer copy | existing `customer_description` field |
| Package inheritance overrides | `estimate_line_overrides` (sparse diff) |
| Internal cost / margin | `services.cost_cents` (internal-only; excluded from HCP payload) |

**Hard constraint:** measurement-priced lines resolve to a `flat` amount before POST; extended fields (division, measureType, basePrice, multiplier, cost, etc.) stay in app state and are never sent except via the known HCP line-item fields.
