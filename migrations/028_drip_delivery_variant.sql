-- Drip S8: record which message (variant) was sent so A/B variants are measurable.
-- Nullable + idempotent; historical rows stay NULL and are excluded from per-variant stats.

ALTER TABLE drip_delivery_log ADD COLUMN IF NOT EXISTS message_id BIGINT;
ALTER TABLE drip_delivery_log ADD COLUMN IF NOT EXISTS variant TEXT;
