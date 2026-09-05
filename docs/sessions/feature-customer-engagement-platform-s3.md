# Customer Engagement Platform: Sprint 3 Callback Panel

## Status

- Sprint: 3 - Schedule Callback panel and queue
- Status: panel deployed; callback creation gate off pending a real-work canary
- Release date: 2026-09-05

## Delivered Workflow

The native Chatwoot Dashboard App receives the selected conversation/contact and the logged-in
Chatwoot agent through Chatwoot 4.17's `appContext` message. It re-fetches Chatwoot context on the
server, requires an auto-confirmed CRM identity, shows the CRM Contact deep link and existing open
callbacks, and uses the logged-in Chatwoot agent as owner. Timezone is fixed to Pacific time.

Callback creation requires `ENGAGEMENT_CALLBACK_WRITES_ENABLED=true`. The panel submits a generated
idempotency key; migration `039_callback_idempotency.sql` makes that key unique, and a repeated
submission returns the original callback rather than creating another one. The gateway creates the
CRM Callback, persists its CRM ID, and applies the existing `A_pending_callback` Chatwoot label
without replacing other labels.

## Production Evidence

Fresh source/config and Postgres backups were created before deployment at:

`/home/neilghuman/backups/customer-engagement-platform/sprint3-panel-prerun-20260905T100000Z/`

- application/config SHA-256: `d3098f265ae18d4f9f76893cc7b832ce22e0ceb7ea7e020ff2c959bae126f3b8`
- database SHA-256: `edbb2e13d716553230024e06c2418b839a8a7b370d8de0c73329d9dd65a56bc9`

The gateway rebuilt successfully. Migration `039_callback_idempotency.sql` is recorded in the
production registry. The live read-only panel check for conversation `60` returned HTTP 200 with an
`auto_confirmed` identity, CRM Contact URL, no open callbacks, and `callbackWritesEnabled=false`.
The panel asset itself returns HTTP 200.

## Validation

- Focused callback suite: 14 passed, 0 failed.
- Full project suite: 285 passed, 0 failed.
- Server, callback store, and panel JavaScript syntax checks passed.
- Git diff whitespace check passed.

## First Create Canary

Do not invent a customer callback merely to test the UI. When staff has a real callback promise,
temporarily enable `ENGAGEMENT_CALLBACK_WRITES_ENABLED`, schedule that one callback from the panel,
double-submit the exact same request only if a retry is needed, verify one local and one CRM Callback
record plus `A_pending_callback`, then return the gate to `false`.

## Dashboard App Delivery

Nginx Proxy Manager host `26` on `10.0.50.10` is the public ingress for Chatwoot. Its same-domain
HTTPS `/callback-panel/` route proxies to the gateway with a server-only shared header. Chatwoot
Dashboard App `2`, titled `Schedule Callback`, is registered for account `1` using that route.

The public panel route returns HTTP 200. A simulated official Chatwoot `appContext` for conversation
`60` and agent `Test Agent` returned the confirmed Contact, CRM deep link, owner `Test Agent`, and
fixed `America/Los_Angeles` timezone. Callback creation remains disabled.