# Customer Engagement Platform: Sprint 1 Callback Operational Model

## Status

- Sprint: 1 - callback-only operational model
- Status: complete
- Release date: 2026-09-05
- Scope: Contact + Callback + Call relationship only; no Leads, Opportunities, Jobs, Chatwoot ingestion, reminders, or 3CX call control.

## Callback Contract

The gateway now enforces a Contact, owner, reason, valid due timestamp, and IANA timezone for every
callback. Each callback receives an immutable human-readable callback number. Completion requires an
outcome and records completion timestamp and actor. Rescheduling marks the original record as
`rescheduled` and creates a linked replacement record rather than changing the original promise.

The manager-facing endpoint `GET /api/callbacks/command-center` returns upcoming, due-soon, overdue,
and exception queues. Callback records persist their EspoCRM callback ID so lifecycle changes continue
to synchronize after a gateway restart.

## EspoCRM Configuration

The custom `Callback` entity is deployed in the existing `HcpSync` module. It has required
`callbackNumber`, Contact, owner, reason, due date/time, and timezone fields, plus status, outcome,
reminder, completion-audit, and reschedule-history fields. It includes Contact and Call relationships,
list/search/detail layouts, and the standard REST record controller.

The existing `Customer Engagement Platform - Canary Writer` role was granted create/read/edit access
to Callback only, alongside its existing IdentityReview and ExternalIdentityLink access. No delete or
broader entity permissions were added.

## Production Evidence

Before deployment, backups were created and verified with checksums and `pg_restore --list`:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/callback-entity-prerun-20260905T060000Z/espocrm.dump`
  - SHA-256: `54fc36cc8cd8db58bc2f35916ce292e203ad4d26edeb0be0340cdd04279cccd6`
- Gateway source/config and database: `/home/neilghuman/backups/customer-engagement-platform/callback-gateway-prerun-20260905T061000Z/`
  - application/config SHA-256: `2488fe8f027c16dda06cb0f099f5eddc196b9699060b6392b15e1413b6d48dec`
  - database SHA-256: `eac5c6646edf484f66fa93c2912265e44d42af9d7bf45ee38c520848dee6aea3`

Deployment rebuilt only `/opt/hcp-estimate-builder`'s `estimate-builder` service. Startup applied
`036_callback_records.sql`, `037_callback_records_crm_link.sql`, and
`038_callback_records_operational_fields.sql`. The live authenticated
`GET /api/callbacks` response was `{"queue":[]}`.

Live EspoCRM metadata confirms `Callback -> Contact`, `Callback -> Call`, and `Call -> Callback`.
`GET /api/v1/Callback?maxSize=1` returns HTTP 200 with an empty list. An intentionally incomplete
Callback POST returned HTTP 400 for the required `callbackNumber` field and created no data.

## Verification

- Focused callback suite: 13 passed, 0 failed.
- Full project suite: 270 passed, 0 failed.
- JavaScript syntax checks passed for the changed gateway files.
- EspoCRM Callback controller passed `php -l`; metadata rebuild and cache clear both completed.

## Deferred Work

- Sprint 2: Chatwoot identity and context integration.
- Sprint 3: Chatwoot Schedule Callback sidebar, server-side context validation, idempotency, and label synchronization.
- Sprint 4: employee/customer reminders, consent/quiet-hours policy, and escalation.
- Sprint 5: 3CX click-to-call, CDR correlation, recording references, and Call activity writes.