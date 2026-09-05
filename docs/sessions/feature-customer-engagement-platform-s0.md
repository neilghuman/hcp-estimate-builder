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

## Disabled Production Release

Deployed to `10.0.10.102` on 2026-09-04 from release commit `c14ae654` after the backup set
above had been verified. The direct-copy deployment had source drift from the repository, so only
the validated Sprint 0 patch and new files were applied before rebuilding `hcp-estimate-builder`.

- Migration registry confirms `033_engagement_identity_foundation.sql` and
	`034_engagement_reconciliation_runs.sql` applied successfully.
- Verified tables: `integration_events`, `identity_resolution_audits`, `integration_outbox`, and
	`identity_reconciliation_runs`.
- `GET /api/integrations/identity/config` reports `configured=true`,
	`identityWritesEnabled=false`, `reconciliationEnabled=false`, and
	`espocrmConfigured=false`.
- A dedicated 64-hex-character integration API key was generated directly into the server-side
	production `.env`; it was not displayed or committed.
- No EspoCRM credential is configured in the gateway yet, and the HCP reconciliation endpoint
	remains unavailable until `ENGAGEMENT_RECONCILIATION_ENABLED=true` is explicitly set.

## EspoCRM Read-Only Credential and Inventory

Created and validated on 2026-09-04 after the disabled gateway release:

- Role: `Customer Engagement Platform - Read Only` (`5f28008277306e396`).
- API user: `engagement-identity-reader` (`dc2bb3d133b86b3d4`), active, API-key auth.
- Role permissions are read-only (`create=no`, `read=all`, `edit=no`, `delete=no`, `stream=no`)
	for `Contact`, `HcpCustomerLink`, and `IdentityReview` only.
- The API key was generated on the EspoCRM database host and transferred through protected,
	short-lived files directly into the gateway's production `.env`; its value was not displayed
	or committed.
- A direct API check confirms the reader can GET each required entity and `/Metadata` while
	`/App/user` remains forbidden, as intended. The gateway adapter was narrowed accordingly.
- Authenticated inventory result: 0 Contacts, 1,416 legacy `HcpCustomerLink` stubs, 0
	`IdentityReview` rows; `Contact`, `HcpCustomerLink`, and `IdentityReview` metadata are present.

The gateway still reports `identityWritesEnabled=false` and `reconciliationEnabled=false`.

## HCP Read-Only Reconciliation Run

Owner-approved on 2026-09-04. A fresh, checksum-verified ScopeFoundry database backup was made
immediately before the run at:

`/home/neilghuman/backups/customer-engagement-platform/reconciliation-prerun-20260904T231533Z`

`ENGAGEMENT_RECONCILIATION_ENABLED` was enabled only for this single authenticated run and was
returned to `false` immediately afterward. HCP and EspoCRM were accessed with GET requests only.

- Run ID: `15e2fb93-90f1-422a-bd44-c6c4655cdff0`
- Status: `complete`; 1,416 local ledger events and 1,416 identity audit rows recorded.
- Results: 1,404 `net_new`; 12 `malformed_or_no_key`; 0 `auto_confirmed`; 0 `provisional`; 0
	`identity_review`; 0 `field_conflict`.
- The zero Contact baseline explains the all-net-new outcome. This report is a connectivity,
	pagination, canonicalization, and audit-path validation, not evidence that live Contact creation
	is approved.
- The report response and persisted ledger contain only hashes for external IDs and normalized
	identity keys; raw HCP contact data was not logged into the gateway tables.

Final gateway state after the run: `identityWritesEnabled=false`,
`reconciliationEnabled=false`, `espocrmConfigured=true`.

## Bounded HCP Contact Canary

Owner-approved and completed on 2026-09-04. Fresh pre-canary backups were created and verified:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/contact-canary-prerun-20260904T232020Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/contact-canary-prerun-20260904T232025Z`

Both database archives passed checksum verification and `pg_restore --list` validation.

- Added a separate `engagement-identity-canary-writer` EspoCRM API user with create/read only
	access to `Contact`, `ExternalIdentityLink`, and `IdentityReview`; it has no edit or delete
	permission. Its API key is server-side only.
- The canary route accepts one HCP customer only when the resolver says `net_new`, a fixed HCP
	source account is configured, and `ENGAGEMENT_IDENTITY_WRITES_ENABLED=true`.
- One designated HCP test customer created one Contact (`6a9b52995711cc7a5`) and one linked
	`ExternalIdentityLink` (`6a9b52997ff7622e0`) in `Provisional` status. The link points to the
	Contact and has the fixed `hcp-production-shared` source account.
- The local integration event stores only a fingerprinted HCP event key and normalized key hashes;
	it was corrected to retain the newly created Contact ID after successful creation.
- The canary route returned `403` both before and after the controlled enablement. Final gateway
	state: `identityWritesEnabled=false`, `reconciliationEnabled=false`.

Post-canary totals: 1 Contact, 1 ExternalIdentityLink, 1,416 legacy HcpCustomerLink rows.
No broad HCP import, legacy-projector change, Contact update, or HCP write was performed.

## Ten-Record HCP Contact Batch Canary

Owner-approved and completed on 2026-09-04 after the single-record canary. The batch endpoint is
hard-capped at 10 creates, selects only `net_new` HCP customers, processes them sequentially, and
adds each successful Contact to the in-memory candidate set to prevent same-run duplicates.

Fresh, verified backups immediately before the batch:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/contact-batch-canary-prerun-20260904T232440Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/contact-batch-canary-prerun-20260904T232444Z`

Results: 10 Contacts and 10 `ExternalIdentityLink` records created; no candidates were skipped.
Together with the first canary, current totals are 11 Contacts, 11 links, 11 distinct linked
Contacts, and 0 duplicate `(source_system, source_account_id, external_id)` tuples. All 11 links
are `HousecallPro` / `hcp-production-shared` / `Provisional`. The legacy HcpCustomerLink count
remains 1,416. All 11 fingerprint-only local canary audit events have a target Contact ID.

The write gate was returned to `false` by cleanup, confirmed by the config endpoint; a post-cleanup
batch request returned `403`. `ENGAGEMENT_RECONCILIATION_ENABLED` remains `false`.

This is still a canary. Review the ten newly created Contacts before authorizing an expanded batch
or any broad HCP import.

## Independent Canary Review

After the operator reviewed the records in EspoCRM, the gateway performed a second, read-only
comparison of all 11 provisional links against live HCP and EspoCRM data. The check compared
normalized names, phone values, and email values but emitted only truncated source hashes and CRM
record IDs.

- 11 of 11 links passed: name matched and at least one normalized identity key matched.
- All 11 phone values matched their HCP source.
- 10 email values matched. The remaining record has a matching name and phone but no matching
	email value; it is correctly retained as `Provisional` rather than auto-confirmed.
- No CRM, HCP, Chatwoot, or gateway data was written by this review.

## Read-Only HCP Address Audit

EspoCRM Contacts have one native structured address. The address audit therefore applies a strict
selection rule: one service address wins; if no service address exists, one billing address may be
used; multiple service or multiple candidate addresses are ambiguous and cannot be written.

The audit ran on the 11 provisional HCP links with only the temporary reconciliation flag enabled.
It made no updates and restored the flag to `false` afterward.

- 10 Contacts are `crm_blank` with exactly one unambiguous complete HCP address available.
	Nine are billing fallbacks and one is a service address.
- 1 Contact has multiple complete service addresses and is
	`ambiguous_multiple_service_addresses`; it is excluded from automatic address projection.
- 0 exact CRM/HCP address matches and 0 address conflicts, because all native CRM address fields
	remain blank.

The next address-write canary, if approved, must update only those ten blank, unambiguous Contact
addresses and leave the multi-service-address record untouched for human selection.

## Bounded HCP Address-Write Canary

Owner-approved and completed on 2026-09-04. A dedicated `engagement-identity-address-writer`
EspoCRM API user was created with Contact read/edit only; it cannot create or delete Contacts and
cannot access identity-link entities. The address route is hard-capped at 10 updates and performs
an EspoCRM read-back after each update before recording a fingerprint-only local audit event.

Fresh verified backups were taken before the initial run and each resume. The final current-state
restore points are:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/address-canary-seven-prerun-20260904T234437Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/address-canary-seven-prerun-20260904T234442Z`

Result after controlled resumes: 10 Contact addresses now exactly match their selected HCP source
address; 0 conflicts; 0 blank eligible Contacts. Nine selected addresses are billing fallbacks and
one is a service address. The remaining Contact with multiple service addresses was never written.
All 10 successful address updates have a sanitized `address-canary` ledger event linked to their
Contact; the three early successful writes were backfilled after verification.

Two rollout defects were found and corrected before the final successful resume:

1. EspoCRM returns an empty successful body for Contact address PUT requests. The adapter now
	accepts that response and requires the subsequent GET read-back to verify the value.
2. The address route initially omitted the `compareContactAddress` import. Stage-aware error
	reporting identified the failure; the corrected route verified and completed the remaining
	updates.

The final read-only audit reports 10 `match`, 1 `ambiguous_multiple_service_addresses`, and no
other outcome. Final gateway state: `identityWritesEnabled=false` and
`reconciliationEnabled=false`.

## Billing-First Address Policy

Owner decision: the EspoCRM Contact's one native address is the HCP billing address when exactly
one billing address exists. Additional HCP service addresses are deliberately omitted from Contact
projection and remain HCP-owned until a dedicated Service Location model exists. If no billing
address exists, a sole service address is the fallback. Multiple billing addresses remain an
address-review exception; service-address count does not override a sole billing address.

The policy was implemented and validated locally (237/237 full tests), then deployed with write
gates disabled. A read-only audit changed the one previously ambiguous multi-service record into
one blank, unambiguous billing candidate. Fresh verified backups preceded its single update:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/billing-first-address-prerun-20260905T001349Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/billing-first-address-prerun-20260905T001354Z`

The final controlled address update created one billing-address match and skipped the ten existing
matches. Final read-only verification: 11 total, 11 `match`, 0 blank, 0 conflicts, and 0 address
ambiguities. All 11 Contacts now have one verified native EspoCRM address; no additional HCP
service address was projected. Both feature gates are disabled.

## Expanded 25-Record HCP Contact Import

Owner-approved and completed on 2026-09-05. This is a distinct endpoint with a hard cap of 25;
the prior 10-record canary remains capped at 10. It reuses the same sequential create-only Contact
and ExternalIdentityLink path. Address projection is deliberately not part of this import.

Fresh verified backups preceded the run:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/hcp-import-25-prerun-20260905T001839Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/hcp-import-25-prerun-20260905T001844Z`

The batch created 25 `net_new` Contacts and 25 provisional ExternalIdentityLinks. It safely skipped
9 existing external-link matches and 1 provisional match. Totals after the run: 36 Contacts, 36
ExternalIdentityLinks, 36 distinct linked Contacts, and 0 duplicate source identity tuples. The
legacy HcpCustomerLink projection remains unchanged at 1,416 rows. The global write gate was
returned to `false` automatically after the run.

An independent read-only comparison of all 36 provisional links against live HCP source records
passed 36/36: normalized name matched and at least one normalized identity key matched for every
link. No HCP, Chatwoot, or additional EspoCRM data was written by the review.

## Expanded 100-Record HCP Contact Import

Owner-approved and completed on 2026-09-05. A dedicated hard-capped endpoint processed candidates
sequentially using the same create-only Contact and ExternalIdentityLink path; addresses remain out
of scope for this import tier.

Fresh verified backups preceded the run:

- EspoCRM: `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/hcp-import-100-prerun-20260905T002127Z`
- ScopeFoundry: `/home/neilghuman/backups/customer-engagement-platform/hcp-import-100-prerun-20260905T002132Z`

The batch created 100 new Contacts and 100 provisional ExternalIdentityLinks. It safely skipped 37
existing external-link matches, 2 provisional matches, and 1 field conflict. Post-run totals: 136
Contacts, 136 links, 136 distinct linked Contacts, 136 Contact-linked local canary audit events, and
0 duplicate source identity tuples. The legacy HcpCustomerLink projector remains unchanged at 1,416
rows. The write gate was restored to `false` by cleanup.

Independent redacted verification passed 136/136 provisional links against live HCP source records.
The skipped field-conflict source remains untouched and should feed the next IdentityReview-creation
hardening slice before any full import is approved.

## Deferred work

- Chatwoot event ingestion and sidebar UI: Sprint 2 and Sprint 3.
- Callback entity and operational dashboards: Sprint 1.
- Reminder delivery, customer SMS, and n8n workflow changes: Sprint 4.
- 3CX call control and recording correlation: Sprint 5.

## Compatibility note

The prior EspoCRM-HCP model proposed that newer accepted HCP source data overwrites HCP-managed Contact fields. That behavior is not compatible with this platform's identity policy and must not be carried into the new resolver.