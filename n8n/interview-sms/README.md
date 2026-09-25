# Interview SMS workflow snapshots

These sanitized snapshots record the production configuration deployed on September 25, 2026. They are review artifacts, not a deployment job. Merging this PR does not change WordPress, n8n, Chatwoot, or Telnyx.

| File | Production resource |
| --- | --- |
| `fluentcrm-automation-7.config.json` | Relevant trigger and step settings for FluentCRM automation 7; not a complete import/export |
| `fluentcrm-interview-notification.workflow.json` | `xqhebYkB9RAkM3QV` — immediate interview message and after-hours queueing |
| `interview-sms-queue-drainer.workflow.json` | `MeXAMbO5QBDdOAf1` — processes due queue records every 15 minutes |
| `send-via-chatwoot.workflow.json` | `NqlHzbo0Sj5Bqq9S` — shared conversation lookup, labeling, and outgoing message creation |

Credential bindings and secret header values have been replaced with `REDACTED_*` placeholders. The existing fixed test-recipient override is represented as `<TEST_RECIPIENT_E164>`. These files must not be imported unchanged: restore approved credential bindings and resolve the recipient override first. No credential material, contact records, or execution payloads are included.

The shared route adds `interview` by reading the current conversation labels and writing their union with the new label. This preserves labels observed by that read; the Chatwoot labels API is a replacement operation, so concurrent label edits are not an atomic merge.

See [the deployment and verification record](../../docs/sessions/feature-interview-sms-chatwoot-routing.md) for behavior, evidence, remaining limitations, and rollback guidance.

Run the offline checks from the repository root:

```sh
node --test test/interview_sms_routing.test.js
```

The checks use mocked Chatwoot responses. They do not call any service or send messages.
