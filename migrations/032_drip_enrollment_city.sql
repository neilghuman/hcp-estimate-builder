-- Capture the lead's city (e.g. Google LSA "Location:") on the enrollment so drip copy can use {city}.
ALTER TABLE drip_enrollment ADD COLUMN IF NOT EXISTS city TEXT;
