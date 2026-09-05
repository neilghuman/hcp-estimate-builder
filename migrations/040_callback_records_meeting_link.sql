-- Link a callback to the EspoCRM Meeting created for the owner's calendar (Outlook sync).
ALTER TABLE callback_records ADD COLUMN IF NOT EXISTS crm_meeting_id TEXT;
