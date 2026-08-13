-- Customer Intake — brand-routed customer communications (SMS + email).
-- After a successful submit the customer receives a branded SMS (via the correct Chatwoot inbox)
-- and a branded confirmation email. These columns record the resolved brand, the Chatwoot
-- contact/conversation reused or created, and per-channel send status/timestamps for idempotency
-- and auditing. Idempotent: safe to re-run.
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS resolved_brand          TEXT;      -- company/brand name resolved from the tag
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS chatwoot_inbox_id       INTEGER;   -- inbox the customer SMS was sent from
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS chatwoot_contact_id     TEXT;      -- reused/created Chatwoot contact
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS chatwoot_conversation_id TEXT;     -- reused/created Chatwoot conversation
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_sms_status     TEXT;      -- pending | sent | failed | skipped
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_sms_at         TIMESTAMPTZ;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_sms_error      TEXT;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_email_status   TEXT;      -- pending | sent | failed | skipped
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_email_at       TIMESTAMPTZ;
ALTER TABLE customer_intakes ADD COLUMN IF NOT EXISTS customer_email_error    TEXT;
