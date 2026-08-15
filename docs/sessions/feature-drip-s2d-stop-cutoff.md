# feature/drip-s2d-stop-cutoff

## Context
Discovered during the first controlled go-live self-test (deploying the drip to prod).

## Problem
`evaluateStop` treated **any** incoming message or untagged outgoing message as a "human response"
and exited the enrollment. But a real LSA/Thumbtack lead conversation already contains, at
enrollment time:
- the **inbound lead** itself (an incoming message), and
- the **initial welcome** auto-reply (an untagged outgoing message).

So every real enrollment would immediately exit with `human_response` and the drip would never send.
(Fails safe — it stops rather than spams — but the feature would be dead on arrival.)

## Fix
`evaluateStop(conv, { since })` now ignores messages at/before `since` (the enrollment's T0). The
sweep passes `since = enrollment.t0_at`. Only human/agent activity **after** the drip started counts:
- pre-T0 inbound lead + welcome -> ignored,
- a customer reply after T0 -> `human_response`,
- an agent's untagged outgoing after T0 -> `human_response`,
- our own tagged drip sends -> always ignored,
- `resolved` / label-removed -> still stop immediately regardless of time.

Chatwoot `created_at` is unix seconds; `msgTimeMs` tolerates seconds/ms/ISO.

## Tests
- drip.test.js: pre-enrollment lead+welcome ignored; reply-after-T0 stops; agent-after-T0 stops while tagged drip send does not.
- drip_sweep.test.js: sweep sends past a pre-enrollment lead+welcome.
- `node --test` -> 196/196.

## Note on T0 semantics (for n8n wiring)
n8n must pass `t0` = the moment of the successful initial send (i.e. enroll right after the welcome),
so the welcome is <= T0 and excluded.
