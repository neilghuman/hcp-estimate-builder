# feature/drip-s7-history-suppression

## Context
S7 of the lead follow-up drip: message **version history + revert**, and a **suppression
(opt-out / do-not-contact) manager** on the Follow-up dashboard. Editing stays gated behind
`DRIP_CONFIG_EDIT_ENABLED`.

## Adds
- **Message history + revert**: `revertMessage(id, version)` sets the body back to a historical
  version — itself a versioned edit (current body archived, version bumps), so revert is undoable.
  Route `POST /api/drip/message/:id/revert` (gated; 404 on unknown version). UI: a "🕘 Versions"
  button (shown when a message has >1 version) opens an inline history list with per-version Revert.
- **Suppression manager**: `getSuppressions`, `removeSuppression` (+ existing `addSuppression`).
  Routes: `GET /api/drip/suppressions` (open read), `DELETE /api/drip/suppress` (gated, phone in
  body/query). Also moved `POST /api/drip/suppress` from the `DRIP_WRITE_ENABLED` gate to the
  config-edit gate so the dashboard manager is consistent (both flags are on in prod). UI: a
  Suppression-list card with add form + per-row remove.

## Verification
- `node --test` -> 209 (no new pure logic; revert/suppression are DB glue, integration-tested).
- Dev: suppress add(edit-gated)/list/delete; revert flow (edit → v2, revert v1 → v3 restoring the
  original body); UI (suppression card + add form, versions buttons, inline history + revert) verified.

## Notes
`POST /api/drip/suppress` gate changed from `DRIP_WRITE_ENABLED` to `DRIP_CONFIG_EDIT_ENABLED`
(no prod behaviour change — both are enabled).
