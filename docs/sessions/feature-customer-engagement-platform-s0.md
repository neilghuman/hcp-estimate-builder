# Customer Engagement Platform: Sprint 0 Baseline

## Status

- Sprint: 0 - identity foundation and policy
- Status: started
- Production Contact writes: disabled
- Chatwoot webhook handling: disabled
- Customer messaging: disabled
- Existing HCP projection: unchanged and active

## Production Backup Evidence

Created before any production deployment, migration, provider configuration, or remote data write.
All checksum manifests were verified successfully after creation. PostgreSQL archives were additionally
validated with `pg_restore --list` inside their owning database containers.

| Host | Backup path | Contents |
| --- | --- | --- |
| `10.0.10.102` | `/home/neilghuman/backups/customer-engagement-platform/20260904T215939Z` | ScopeFoundry PostgreSQL custom dump, application/config archive, n8n workflow export, n8n data archive, container inventory/inspect data, checksums. |
| `10.0.30.26` | `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/20260904T220004Z` | EspoCRM PostgreSQL custom dump, globals export, restore contents, container inventory/inspect data, checksums. |
| `10.0.10.46` | `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/20260904T220009Z` | EspoCRM custom/data archive, host configuration archive, archive contents, container inventory/inspect data, checksums. |

## Decisions locked for Sprint 0

1. The customer engagement gateway will be an isolated Express module in this application. It will own request validation, idempotency, identity resolution, audit records, and provider adapters. It will not reuse n8n as the synchronous identity authority.
2. EspoCRM remains the authoritative store for canonical Contacts, External Identity Links, Identity Reviews, and callback records. The gateway database stores delivery/idempotency/audit state only; it is not a second CRM.
3. The existing production `HcpCustomerLink` projection remains active but is treated as a read-only legacy evidence ledger during this sprint. It must not be extended to create Contacts or repurposed as the new generalized identity model.
4. The new resolver supersedes the earlier proposal that HCP-owned fields overwrite CRM fields. It adds missing values and records conflicts for human review; it never silently overwrites a non-empty EspoCRM identity value.
5. Housecall Pro uses one fixed `source_account_id` for the shared production HCP account. Brand remains a customer relationship signal, not an account discriminator.
6. No source record creates an automatic Contact match from a single phone number or email address. HCP alone may auto-confirm only a two-identifier match whose name passes the configured similarity check.

## Required read-only baseline

Before production writes are enabled, capture and retain:

- EspoCRM entity metadata, custom fields, roles, API user scopes, and current HcpSync counts.
- HCP customer total, the current paging shape, and a representative redacted field sample.
- Active HCP and EspoCRM n8n workflow exports and static cursor state.
- Personal-email account auto-create and sharing settings.
- Chatwoot account, inbox, contact-attribute, and webhook capability inventory.

The gateway must emit a dry-run reconciliation report with these mutually exclusive outcomes:

- `auto_confirmed`
- `provisional`
- `identity_review`
- `net_new`
- `malformed_or_no_key`
- `field_conflict`

## Write gates

The first resolver release is dry-run only. It may read HCP and EspoCRM and persist sanitized local ledger/audit entries, but it must not create or update EspoCRM Contacts or links.

Production Contact and External Identity Link writes require all of the following:

1. A reviewed dry-run report with acceptable provisional, review, and net-new rates.
2. An EspoCRM metadata and permissions check showing least-privilege access to the new entities only.
3. Replay/idempotency tests for duplicate and out-of-order records.
4. Owner approval for a bounded canary and its rollback procedure.

## Initial Local Implementation

`src/engagement_identity.js` is a pure, provider-independent, dry-run-only matching module. It has
no network or database dependencies and cannot write to HCP, Chatwoot, EspoCRM, or n8n. Its focused
test suite passed 8/8 on 2026-09-04, covering canonicalization, external-link idempotency, confirmed
and provisional matching, conflicts, ambiguous identifiers, HCP name mismatch, and malformed inputs.

## Read-Only Reconciliation Slice

- `src/engagement_espocrm.js` uses GET-only requests for EspoCRM user/metadata/count inventory
	and paginated Contact reads. It has no mutation methods.
- `src/hcp.js` exposes a GET-only paginated HCP customer export for reconciliation. It does not
	reuse any HCP write functions.
- `GET /api/integrations/espocrm/inventory` reports sanitized EspoCRM readiness data.
- `POST /api/integrations/identity/reconcile/hcp` is disabled unless
	`ENGAGEMENT_RECONCILIATION_ENABLED=true`, requires the dedicated integration API key, returns
	aggregate outcomes plus redacted examples, and cannot write to HCP or EspoCRM. Each operator
	run creates a local `identity_reconciliation_runs` summary plus fingerprint-only decision and
	audit records in the integration ledger.
- The focused identity suite passed 11/11 after this slice was added.

## Deferred work

- Chatwoot event ingestion and sidebar UI: Sprint 2 and Sprint 3.
- Callback entity and operational dashboards: Sprint 1.
- Reminder delivery, customer SMS, and n8n workflow changes: Sprint 4.
- 3CX call control and recording correlation: Sprint 5.

## Compatibility note

The prior EspoCRM-HCP model proposed that newer accepted HCP source data overwrites HCP-managed Contact fields. That behavior is not compatible with this platform's identity policy and must not be carried into the new resolver.