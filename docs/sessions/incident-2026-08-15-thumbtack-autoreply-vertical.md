# incident/2026-08-15-thumbtack-autoreply-vertical

Operational incident + fixes (n8n-side; no app code change). Recorded per the PR-history convention.

## Symptom
A brand-new Thumbtack lead appeared to get **no proper instant auto-reply**.

## Investigation
- Lead: **Chris Williams · Artificial Turf Installation · Bothell, WA** — n8n exec `243470`,
  workflow `xDFf8jXdBw6PRx1L` (Thumbtack Auto-Reply Landscaping) on the `10.0.10.25` n8n.
- The workflow ran end-to-end and **did post** an auto-reply (Chatwoot msg `2950`) — but it sent the
  generic **neutral** message, not the Washington Landscaping welcome nor the resolved artificial-turf
  message.
- `Resolve Category` had correctly matched `artificial_turf` (`matched:true`, branded body), but the
  message was discarded.

## Root cause
A Chatwoot **AI classifier** sets `conversation.custom_attributes.vertical`. For this lead the LLM
returned `vertical = "unknown"`. The `Pick Message` node evaluated:
```js
outOfVertical = !!vertical && vertical !== INBOX_VERTICAL;  // "unknown" !== "landscaping" → TRUE
if (outOfVertical) content = neutral;   // short-circuited before the resolved category message
```

## Fix 1 — auto-reply hardening (both Thumbtack Pick Message nodes)
`xDFf8jXdBw6PRx1L` (landscaping) + `blv0vfr8G2JNP8ng` (tree):
```js
const outOfVertical = !!vertical && vertical !== INBOX_VERTICAL && vertical !== 'unknown';
```
Now an `unknown`-vertical lead flows to the resolved category message (or the proper time-based
welcome); a genuinely cross-vertical lead still gets neutral. Backup `~/n8n-wf-backups/20260815-tt-vertical-fix/`.
Both active, webhooks 200.

## One-off remediation
Sent Chris the correct **artificial-turf welcome** (Chatwoot msg `2952`), tagged
`content_attributes.automation:'drip'` so it doesn't trip the drip stop-check (his follow-ups continue).

## Classifier assessment ("is the AI classification adding value?")
Producer located: **"Chatwoot: AI Classify (Labels + Lead Score)"** (`JwXK64dyJcyx4Ju4`) on a **second
n8n instance** at `10.0.10.102:5678`, triggered by Chatwoot webhook #1
(`/webhook/chatwoot-ai-classify-…`, `message_created`). Ollama `qwen2.5:7b`. Guard runs it once per
conversation (first inbound message).
- `custom_attributes.vertical` — **redundant** (the Thumbtack mirror already routes vertical by
  businessID) and **harmful** (clobbered the good value → this bug).
- `intent` / `lead_score` — **write-only**; no automation consumes them (agent triage labels/note only).

## Fix 2 — scope the classifier
In `Parse & Map`:
```js
// before: const custom_attributes = { lead_score: score, vertical, intent };
const custom_attributes = { lead_score: score, intent };   // vertical no longer written
```
Keeps the triage labels (incl. vertical label) + lead-score + note, but never writes
`custom_attributes.vertical` again. Backup `~/n8n-wf-backups/20260815-ai-classify-scope/`. Active.

## Environment note
Two n8n instances: `10.0.10.25` (drip / auto-reply / SMS / Thumbtack mirror) and `10.0.10.102`
(AI classify / draft-reply / Jobber / HCP). Separate API keys.

## Outcome
Defense-in-depth: the auto-reply ignores `unknown` **and** the classifier no longer writes vertical.
Future `unknown`-vertical leads get the correct message the first time.
