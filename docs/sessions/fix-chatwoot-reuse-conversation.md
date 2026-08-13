# fix/chatwoot-reuse-conversation

## Request
> In our Chatwoot conversations, under the Telnyx (landscaping) inbox, conversations to
> the phone number are starting as new conversations. Investigate.

## Investigation
- Symptom reproduced live in Chatwoot inbox 7 (landscaping): the same contact had multiple
  conversations created minutes apart, each with a single message — e.g. contact `+12064581885`
  → convs 110/259/260/261, contact `+13603480543` → convs 257/258.
- Inspected the messages inside the duplicates: every duplicate conversation contained only
  **outgoing** messages (the branded customer auto-reply "Hello {name}, thank you for choosing
  Washington Landscaping…" plus manual SMS-formatting test sends).
- Ruled out the inbound path: the n8n workflow *Telnyx SMS: Inbound (Landscaping)*
  (`WqiIMnewUvtDGrKY`) correctly resolves and reuses the contact's existing conversation
  (verified via execution history — e.g. exec 232034 appended an incoming reply to conv 257
  rather than creating a new one).
- Ruled out the n8n outbound relay (`ZzyNLGwWenvKqNeJ`) and the LSA auto-reply
  (`0miWpOB8TfgtGbdS`): neither creates conversations.
- Traced the outgoing messages to the customer-intake system in `hcp-estimate-builder`:
  `src/intake.js` `runCustomerSms` / office-notify both call
  `chatwoot.ensureConversationForPhone`.

## Root cause
`ensureConversationForPhone` in `src/chatwoot.js` finds-or-creates the **contact**, but step 3
**unconditionally POSTed `/conversations`** — it never looked up the contact's existing
conversation. So every outbound notification/auto-reply to a phone number spawned a brand-new
Chatwoot conversation, fragmenting the SMS thread. (The function's own doc comment claimed it
"reused/created" a conversation, but reuse was never implemented.)

## Fix
- `ensureConversationForPhone` now `GET /contacts/{id}/conversations`, and if a conversation in
  the target inbox already exists it reuses the most recent one; it only creates a new
  conversation when none exists. This mirrors the inbound Telnyx→Chatwoot relay's threading
  behavior, so inbound and outbound land in the same conversation. Lookup failure is non-fatal
  (falls back to creating a new conversation).
- Tests (`test/chatwoot_notify.test.js`): updated existing cases to mock the new conversations
  lookup and added a case asserting an existing inbox conversation is reused with **no** new
  conversation created.

## Validation
- `node --test test/chatwoot_notify.test.js` → 4/4 pass.
- Full suite `node --test` → 139/139 pass.

## Not done (needs owner action)
- Deploy: rebuild the dev container (and prod) to pick up the change — not performed (production
  change, left for review/deploy).
- Existing duplicate conversations in Chatwoot were not merged/cleaned up.

## Follow-up request: reopen resolved conversations on new message (phone only)
> If the previous conversation was resolved and a new message is added, unresolve it. Phone
> numbers only — leave Thumbtack alone.

- Added `reopenConversation(conversationId)` (`POST /conversations/{id}/toggle_status`
  `{status:'open'}`, non-fatal). Inside `ensureConversationForPhone`, when a reused conversation
  has status `resolved`, it is reopened before the new message is posted. This lives only in the
  phone/SMS path; Thumbtack is handled by separate n8n workflows and is untouched.
- Tests: reopen-on-resolved case added; open-conversation case asserts no `toggle_status` call.
  Suite: 140/140 pass.

