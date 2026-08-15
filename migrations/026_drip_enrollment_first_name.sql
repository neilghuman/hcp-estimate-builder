-- Drip enrollment: capture the contact's first name for message personalization ({name}).
-- Idempotent: safe to re-run.
ALTER TABLE drip_enrollment ADD COLUMN IF NOT EXISTS first_name TEXT;
