-- Drip S4: runtime-togglable global pause (kill switch) for the follow-up sweep.
-- Separate from the env flags (DRIP_SEND/SWEEP_ENABLED) so staff can pause sends from the
-- dashboard without a redeploy. Idempotent.

CREATE TABLE IF NOT EXISTS drip_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO drip_setting (key, value) VALUES ('paused', 'false')
ON CONFLICT (key) DO NOTHING;
