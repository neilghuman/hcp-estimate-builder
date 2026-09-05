# Customer Engagement Platform: Sprint 2 Chatwoot Context Foundation

## Status

- Sprint: 2 - Chatwoot identity and context integration
- Status: foundation deployed; private inbound webhook receiver active
- Release date: 2026-09-05
- Scope: server-fetched Chatwoot context, source-scoped identity resolution, safe review routing,
  CRM deep links, and guarded future link/webhook operations.

## Delivered Behavior

- `GET /api/integrations/chatwoot/conversations/:conversationId/context` is authenticated and
  re-fetches the selected conversation from Chatwoot. It does not trust iframe/client context.
- Resolution prefers a `(Chatwoot, account ID, contact ID)` External Identity Link and otherwise
  uses the existing normalized phone/email resolver.
- The response includes a direct EspoCRM Contact URL for an unambiguous existing Contact.
- `POST .../review` is write-gated and creates a redacted IdentityReview only for provisional,
  collision, conflict, or net-new outcomes. Replays reuse the existing Open review.
- `POST .../link` is write-gated and accepts confirmed identities only. It uses the link-writer
  credential for External Identity Links and the separate least-privilege Contact-edit credential
  for Chatwoot account/contact/deep-link fields. It rejects all non-confirmed outcomes before a
  write can occur.
- The webhook receiver has an unguessable server-only 256-bit URL secret, processes inbound
  `message_created` events only, and uses the immutable Chatwoot message ID in the existing
  unique event ledger. Chatwoot webhook `26` subscribes to this private LAN receiver.
- Chatwoot IdentityReview execution is source-specific. A human `LinkExisting`, `CreateNew`,
  `Separate`, or `Defer` decision cannot fall through the HCP executor or create an HCP link.

## CRM Metadata

Contact metadata now includes writable `chatwootAccountId`, `chatwootContactId`, and `chatwootUrl`
fields. The overlay was rebuilt and cache-cleared in EspoCRM. Live metadata confirms all three
fields are present.

## Bounded Production Canary

The server-fetched read-only context check for Chatwoot conversation `60` returned
`identity_review` with no Contact selected. A one-record review canary then created EspoCRM
IdentityReview `6a9bb9da0c55daa73`; a direct replay returned the same review without a duplicate.
The persisted review is `Open`, has `sourceSystem=Chatwoot`, `sourceAccountId=1`, outcome
`identity_review`, and two candidate Contacts.

No Contact, External Identity Link, Callback, Chatwoot label, Chatwoot custom attribute, or
customer message was created by this canary. `ENGAGEMENT_IDENTITY_WRITES_ENABLED` was restored to
`false` immediately after the test and remains off.

## Webhook Delivery Canary

The receiver was enabled with a generated server-only URL secret and registered as Chatwoot
webhook `26` for `message_created`. An outbound-shaped event was correctly ignored. A synthetic
inbound-shaped event for the already reviewed conversation was accepted once (`202`) and its
immediate replay returned `200` with `replayed=true`. The event resolved to `identity_review` and
created only one sanitized local event/audit ledger entry; it created no CRM Contact, identity
link, Callback, Chatwoot label, custom attribute, or customer message.

## Production Safety Evidence

- EspoCRM pre-metadata backup:
  `/home/neilghuman/espocrm/prod/backups/customer-engagement-platform/sprint2-context-prerun-20260905T063000Z/espocrm.dump`
  - SHA-256: `6546541815ebe63edc211cd8815e3c704f64a18fe61f40429795f6176dd0a2b7`
- Gateway pre-deployment archives:
  `/home/neilghuman/backups/customer-engagement-platform/sprint2-context-prerun-20260905T063000Z/`,
  `sprint2-review-path-prerun-20260905T064500Z/`, and
  `sprint2-inbound-guard-prerun-20260905T073000Z/`.

## Validation

- Focused Chatwoot context suite: 12 passed, 0 failed.
- Focused Chatwoot plus identity suite: 41 passed, 0 failed.
- Full gateway suite: 282 passed, 0 failed.
- JavaScript syntax and Git diff whitespace checks passed.

## Remaining Sprint 2 Work

The private receiver is intentionally LAN-only at `10.0.10.102:8123`; no public ingress was
introduced. Non-interactive SSH access to the Chatwoot host is unavailable, so direct host-side
network inspection remains unavailable. Monitor webhook `26`'s next real inbound execution before
enabling any automatic CRM identity write; the explicit authenticated context and review routes
remain the safe operational path today.