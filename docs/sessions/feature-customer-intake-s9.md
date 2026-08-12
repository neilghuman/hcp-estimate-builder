# Customer Intake System — Sprint 9 (polish + reporting foundation)

Branch: `feature/customer-intake-s9` (stacked on `feature/customer-intake-s8`; PR base = the S8 branch).
Final sprint.

## Objective
UX polish, a reporting data foundation (no report UI yet), and boot-time recovery for interrupted
submits.

## Deliverables
- **Boot recovery**: `recoverInterruptedIntakes(pool)` marks any intake left in `submitting` (e.g. a
  restart mid-submit) as `failed` with a resumable message — never auto-resumes, so a customer is never
  double-created/-texted. Called on server startup.
- **Reporting foundation**: migration 019 adds a `submitted_at` index and an `intake_report` view
  (exposes `minutes_to_submit` and the reporting dimensions). Read-only `GET /api/intake/report`
  returns aggregates: counts by status, by lead source, final-estimate outcome (when getting other
  bids), and avg minutes-to-submit for completed intakes. Supports the target reports (close rate by
  lead source, time-to-estimate, final-estimate outcome, etc.) without a UI.
- **Polish**: focus management (staff select on load, first name on new intake) for a faster,
  keyboard-friendly ~2-minute flow; the form grid already collapses to one column on mobile.

## Testing performed
- `node --test`: 116/116 pass (1 new: recovery marks submitting -> failed).
- `node --check` on `server.js` / `src/intake.js` / `public/intake.js`: clean.
- Dev container rebuilt; migration 019 applied on boot. Live vs `http://192.168.1.8:8123`:
  `GET /api/intake/report` returned aggregates (byStatus/byLeadSource/timing). Boot recovery verified:
  set an intake to `submitting` in the DB, restarted -> log "recovered 1 interrupted submit(s)" and the
  row became `failed` with the resumable message.

## Project status — all 9 sprints complete
S1 foundation, S2 lookup/dedupe, S3 validation, S4 customer create + tags, S5 discovery, S6 estimate +
private notes, S7 SMS via Chatwoot, S8 submit orchestration, S9 polish + reporting.

All HCP/SMS writes remain behind `INTAKE_WRITE_ENABLED` (default off). To run the first real end-to-end
intake: set `INTAKE_WRITE_ENABLED=true` and `INTAKE_NOTIFY_INBOX_ID` (SMS inbox), rebuild the dev
container, and submit one intake to verify the live create/tag/estimate/notes/SMS path.
